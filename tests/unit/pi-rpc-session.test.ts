/**
 * Pi RPC session owner: one child, many turns.
 *
 * These tests drive `PiRpcSession` over a fake wire rather than a fake session
 * object, so what is asserted is the path a real turn takes: a prompt is written
 * as one record, the child's frames are translated into durable events, and the
 * turn settles exactly once. Every failure mode asserted here is a case where
 * the runtime must refuse to report success — a turn that ran past its deadline,
 * a child whose stdout ended mid-turn, a dialog nobody can answer — because each
 * of them, if it went the other way, would let a dead engine look healthy.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import type { SessionEvent } from '@/types/session.js';
import {
  PiRpcDialogUnsupportedError,
  PiRpcGateLostError,
  PiRpcGateUnavailableError,
  PiRpcSession,
  PiRpcSessionClosedError,
} from '@/strategy/pi/rpc-session.js';
import { PiTimeoutError, PiCleanupPendingError } from '@/strategy/pi-launcher.js';
import {
  fingerprintPiToolInput,
  PiInteractionStore,
} from '@/strategy/pi/interaction-store.js';
import type { PiApprovalMode, PiPreauthorizedRule } from '@/strategy/pi/approval-mode.js';
import { createPiRpcWire, settleAsync, waitFor, type PiRpcWire } from './pi-rpc-test-helpers.js';

const SESSION_ID = 'sess_rpc_owner';

/**
 * A scripted Pi child: answers the commands the runtime writes and lets a test
 * emit exactly the frames it wants, in the order it wants.
 */
class FakePi {
  /** Command names the child received, in order. */
  readonly commands: string[] = [];
  /** Commands deliberately left unanswered, to model a lost outcome. */
  silentCommands = new Set<string>();

  constructor(private readonly wire: PiRpcWire) {
    let buffer = '';
    wire.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.handle(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  say(frame: unknown): void {
    this.wire.say(frame);
  }

  private handle(frame: Record<string, unknown>): void {
    const type = String(frame.type);
    this.commands.push(type);
    if (this.silentCommands.has(type)) return;
    this.wire.say({ type: 'response', id: frame.id, command: type, success: true });
  }
}

interface Harness {
  wire: PiRpcWire;
  fake: FakePi;
  events: SessionEvent[];
  broadcasts: SessionEvent[];
  usage: number[][];
  interrupts: number;
  session: PiRpcSession;
}

function harness(options: {
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
  stderrTail?: () => string;
  gateTools?: readonly string[];
  interactions?: PiInteractionStore;
  approvalMode?: () => PiApprovalMode;
  preauthorizedRule?: PiPreauthorizedRule;
} = {}): Harness {
  const wire = createPiRpcWire();
  const fake = new FakePi(wire);
  const events: SessionEvent[] = [];
  const broadcasts: SessionEvent[] = [];
  const usage: number[][] = [];
  let sequence = 0;

  const state = {
    wire,
    fake,
    events,
    broadcasts,
    usage,
    interrupts: 0,
  } as Harness;

  const session = new PiRpcSession({
    sessionId: SESSION_ID,
    workDir: '/sandbox/work',
    model: 'fixture-model',
    sessionFile: `/data/pi-sessions/${SESSION_ID}.jsonl`,
    stdin: wire.stdin,
    stdout: wire.stdout,
    stderrTail: options.stderrTail ?? (() => ''),
    // The launcher's abort ladder ends the child, which is what ends its stdout.
    requestInterrupt: async () => {
      state.interrupts += 1;
      wire.end();
    },
    sink: {
      append(_sessionId: string, event: { type: string }) {
        const persisted = {
          id: `sevt_${++sequence}`,
          sessionId: SESSION_ID,
          seq: sequence,
          type: event.type,
          content: (event as { content?: unknown }).content,
          metadata: (event as { metadata?: unknown }).metadata,
          createdAt: new Date(),
        } as unknown as SessionEvent;
        events.push(persisted);
        return persisted;
      },
      getLatestSeq: () => sequence,
      recordUsage: (_sessionId: string, tokensIn: number, tokensOut: number) => usage.push([tokensIn, tokensOut]),
      recordAuxiliaryModelUsage: (_sessionId, _usage, _options) =>
        ({ id: `sevt_${++sequence}`, sessionId: SESSION_ID, seq: sequence, type: 'span.model_request_end', createdAt: new Date() } as unknown as SessionEvent),
      broadcast: (event: SessionEvent) => broadcasts.push(event),
      spillToolOutput: async (output: string) => output,
    },
    ...(options.gateTools ? { gateTools: options.gateTools } : {}),
    ...(options.interactions ? { interactions: options.interactions } : {}),
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    ...(options.preauthorizedRule ? { preauthorizedRule: options.preauthorizedRule } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  state.session = session;
  session.start();
  return state;
}

/** The frames Pi emits for one text turn that consumes a model request. */
function textTurnFrames(): unknown[] {
  return [
    { type: 'turn_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply' } },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], usage: { input: 2, output: 1 } },
    },
    { type: 'turn_end', message: { role: 'assistant', usage: { input: 2, output: 1 }, stopReason: 'stop' } },
  ];
}

describe('Pi RPC session turns', () => {
  it('writes one prompt as one record and settles the turn on agent_settled', async () => {
    const h = harness();
    await h.session.prompt('run the tests');

    // One frame, one LF-delimited record: nothing else can share the channel.
    expect(h.wire.written).toEqual([
      { id: 'sb-1', type: 'prompt', message: 'run the tests' },
    ]);
    expect(h.session.phase).toBe('busy');
    expect(h.session.turnId).toBe('piturn_1');

    for (const frame of textTurnFrames()) h.fake.say(frame);
    h.fake.say({ type: 'agent_settled' });

    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
    expect(h.session.phase).toBe('idle');
    expect(h.session.alive).toBe(true);
  });

  it('translates the turn into durable events, appending each before broadcasting it', async () => {
    const h = harness();
    await h.session.prompt('run');

    for (const frame of textTurnFrames()) h.fake.say(frame);
    h.fake.say({ type: 'agent_settled' });
    await h.session.awaitTurnOutcome();

    expect(h.events.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'agent.message',
      'span.model_request_end',
    ]);
    // The session owner never publishes the terminal marker: the strategy does,
    // after it has decided the turn actually settled.
    expect(h.events.map((event) => event.type)).not.toContain('turn_complete');
    // Persist before broadcast: a live subscriber must never see an event the
    // log does not already hold.
    const durableBroadcasts = h.broadcasts.filter((event) => event.seq > 0).map((event) => event.id);
    expect(durableBroadcasts).toEqual(h.events.map((event) => event.id));
    // Text deltas stay live-only: they are broadcast as `seq: 0` stream frames
    // and are not replay authority.
    expect(h.broadcasts.filter((event) => event.seq === 0).map((event) => event.type)).toEqual([
      'agent.message_stream_start', 'agent.message_chunk', 'agent.message_stream_end',
    ]);
    // Exactly one usage record for the one model request of this turn.
    expect(h.usage).toEqual([[2, 1]]);
  });

  it('refuses a second turn while one is in flight instead of interleaving two prompts', async () => {
    const h = harness();
    await h.session.prompt('first');

    await expect(h.session.prompt('second')).rejects.toMatchObject({
      name: 'PiRpcSessionClosedError',
      code: 'pi_rpc_session_closed',
    });
    expect(h.wire.written).toHaveLength(1);
    expect(h.fake.commands).toEqual(['prompt']);
  });

  it('reports a turn Pi failed with the error Pi produced', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'error', message: 'model not found: sandbase/nope' });
    h.fake.say({ type: 'agent_settled' });

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error.message).toContain('model not found: sandbase/nope');
  });

  it('settles a turn once, and a repeated end-of-turn frame settles no later turn', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });

    // A duplicate frame arrives while no turn is armed. It must not be buffered
    // and reported as the outcome of the turn that starts afterwards.
    h.fake.say({ type: 'agent_settled' });
    await settleAsync();
    await h.session.prompt('again');
    expect(h.session.turnId).toBe('piturn_2');
    expect(h.session.phase).toBe('busy');

    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
  });

  it('refuses to await a turn that was never armed', async () => {
    const h = harness();

    await expect(h.session.awaitTurnOutcome()).rejects.toBeInstanceOf(PiRpcSessionClosedError);
  });

  it('fails a turn that outlives its deadline and cancels the wedged child', async () => {
    const h = harness({ turnTimeoutMs: 30 });
    await h.session.prompt('run');
    // Pi never settles the turn, so only the deadline can end it.
    const outcome = await h.session.awaitTurnOutcome();

    // Acceptance: the deadline publishes the outcome the runtime already has
    // for a Pi turn past its deadline, rather than leaving the caller waiting.
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(PiTimeoutError);
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiTimeoutError',
      code: 'pi_timed_out',
    });
    // The child is asked to stop and then released, so the next turn cannot
    // inherit an engine that is still inside the turn the runtime gave up on.
    await waitFor(() => h.interrupts === 1, 'the wedged child to be released');
    expect(h.fake.commands).toContain('abort');
    expect(h.session.phase).toBe('closed');
    expect(h.session.alive).toBe(false);
    expect(h.session.failureError?.message).toContain('timed out after 30ms');
    await expect(h.session.prompt('again')).rejects.toThrow(/timed out after 30ms/);
  });

  it('fails the turn that was in flight when the child exits, and carries the reason', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.wire.end();

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiRpcSessionClosedError',
      code: 'pi_rpc_session_closed',
    });
    expect(h.session.alive).toBe(false);
    // Acceptance: no later turn reports success, and the refusal names why.
    await expect(h.session.prompt('again')).rejects.toThrow(/stdout ended/);
    expect(h.wire.written).toHaveLength(1);
  });

  it('reports a resume Pi refused as a continuity failure, not as a crash', async () => {
    const h = harness({
      stderrTail: () => 'Stored session working directory does not exist: /gone/workspace',
    });
    await h.session.prompt('run');
    h.wire.end();

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    // "stdout ended" would leave the operator unable to tell a refused resume
    // from a crash, and the two call for opposite responses.
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiContinuityError',
      code: 'pi_resume_refused',
    });
  });

  it('fails a blocking dialog this runtime cannot answer instead of leaving Pi waiting', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', message: 'Proceed?' });

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(PiRpcDialogUnsupportedError);
    // The session is no longer usable, so the strategy releases the child rather
    // than waiting on a decision nobody can produce.
    expect(h.session.alive).toBe(false);
    expect(h.session.phase).toBe('closed');
    // Nothing is ever written on the dialog channel: inventing a reply would be
    // a decision this runtime has no basis for.
    expect(h.wire.written.map((frame) => frame.type)).not.toContain('extension_ui_response');
    await expect(h.session.prompt('again')).rejects.toThrow(/dialog/);
  });

  it('ignores a fire-and-forget extension notification', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'extension_ui_request', id: 'ui-1', method: 'notify', message: 'working' });
    await settleAsync();

    // The turn is still running: a notification is not a decision to answer and
    // not an end-of-turn marker.
    expect(h.session.phase).toBe('busy');
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
  });
});

describe('Pi RPC session release', () => {
  it('closes the child and releases its work directory, once', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'agent_settled' });
    await h.session.awaitTurnOutcome();

    await h.session.close();
    expect(h.interrupts).toBe(1);
    expect(h.session.alive).toBe(false);
    expect(h.session.phase).toBe('closed');

    // Idempotent: stop, delete and close can each ask for the same release.
    await h.session.close();
    expect(h.interrupts).toBe(1);
  });

  it('releases the child when the session is closed mid-turn', async () => {
    const h = harness();
    await h.session.prompt('run');

    await h.session.close();

    // The turn that was in flight settles as failed rather than hanging: the
    // caller is waiting on an outcome that must exist.
    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(h.interrupts).toBe(1);
  });

  it('reports a retained workspace instead of claiming the child was released', async () => {
    const wire = createPiRpcWire();
    const fake = new FakePi(wire);
    const cleanup = new PiCleanupPendingError('Pi process tree cleanup is pending; the workspace remains retained');
    const session = new PiRpcSession({
      sessionId: SESSION_ID,
      workDir: '/sandbox/work',
      model: 'fixture-model',
      stdin: wire.stdin,
      stdout: wire.stdout,
      stderrTail: () => '',
      requestInterrupt: async () => { throw cleanup; },
      sink: {
        append: (_sessionId, event) => ({ id: 'sevt_1', sessionId: SESSION_ID, seq: 1, type: event.type, createdAt: new Date() } as unknown as SessionEvent),
        getLatestSeq: () => 0,
        recordUsage: () => {},
        recordAuxiliaryModelUsage: (_sessionId, _usage, _options) =>
          ({ id: 'sevt_1', sessionId: SESSION_ID, seq: 1, type: 'span.model_request_end', createdAt: new Date() } as unknown as SessionEvent),
        broadcast: () => {},
        spillToolOutput: async (output) => output,
      },
    });
    session.start();
    await session.prompt('run');

    // A cleanup failure is an ownership failure, so it is thrown rather than
    // reported as a clean stop: the runtime must not release a workspace a
    // child may still hold.
    await expect(session.close()).rejects.toBeInstanceOf(PiCleanupPendingError);
    expect(fake.commands).toEqual(['prompt']);
  });
});

describe('Pi RPC tool gate', () => {
  const directories: string[] = [];
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** A durable store, because the gate's one-shot guarantee lives in its rows. */
  function gateStore(): PiInteractionStore {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-rpc-gate-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    databases.push(db);
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
    db.exec(`
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine)
      VALUES ('${SESSION_ID}', 'agent_pi', 'pi-agent', 'env_default', 'running', '[]', '[]', 'pi')
    `);
    return new PiInteractionStore(db);
  }

  /** The payload the managed extension puts in the dialog's prefill. */
  function gatePayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      kind: 'sandbase_tool_gate',
      version: 1,
      tool_call_id: 'toolu_1',
      tool_name: 'bash',
      input: { command: 'rm -rf /tmp/x' },
      ...overrides,
    });
  }

  /** One gate question, as the managed extension asks it. */
  function askGate(h: Harness, requestId = 'ui-gate-1', payload = gatePayload()): void {
    h.fake.say({
      type: 'extension_ui_request',
      id: requestId,
      method: 'editor',
      title: 'SandBase tool approval',
      prefill: payload,
      blocking: true,
    });
  }

  /** Replies the runtime wrote back on the dialog channel, decoded. */
  function decisions(h: Harness): Array<{ id: unknown; decision?: string; input?: unknown }> {
    return h.wire.written
      .filter((frame) => frame.type === 'extension_ui_response')
      .map((frame) => {
        const parsed = JSON.parse(String(frame.value)) as Record<string, unknown>;
        return {
          id: frame.id,
          ...(typeof parsed.decision === 'string' ? { decision: parsed.decision } : {}),
          ...(parsed.input !== undefined ? { input: parsed.input } : {}),
        };
      });
  }

  it('stops the call before it executes, records it durably, and reports it needs a decision', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('gate');
    const interaction = outcome.kind === 'gate' ? outcome.interaction : undefined;
    expect(interaction).toMatchObject({
      requestId: 'ui-gate-1',
      toolUseId: 'toolu_1',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/x' },
      turnId: 'piturn_1',
    });

    // The durable record is what a decision will be consumed against, written
    // before the caller is told anything: the tool name, the input, the call
    // identity, and the fingerprint of the input the decision is made against.
    const record = store.findByToolUse(SESSION_ID, 'toolu_1');
    expect(record).toMatchObject({
      state: 'pending',
      toolName: 'bash',
      turnId: 'piturn_1',
      piRequestId: 'ui-gate-1',
      originalInput: { command: 'rm -rf /tmp/x' },
    });
    expect(record?.inputFingerprint).toBe(fingerprintPiToolInput({ command: 'rm -rf /tmp/x' }));

    // The session publishes the call as approvable, which is what a client renders
    // as the approval card, and it must not look idle while Pi is blocked.
    const toolUse = h.events.find((event) => event.type === 'agent.tool_use');
    expect(toolUse?.content?.[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'bash',
      requires_confirmation: true,
      confirmation_group_id: 'toolu_1',
    });
    expect(toolUse?.metadata).toMatchObject({ confirmation_source: 'user' });
    expect(h.session.pendingGateRequestId).toBe('ui-gate-1');
    expect(h.session.phase).toBe('busy');
    // Nothing has been answered yet, so Pi is still waiting inside its hook.
    expect(decisions(h)).toEqual([]);
    // A suspended turn still owns the child: a new prompt would race it.
    await expect(h.session.prompt('second')).rejects.toBeInstanceOf(PiRpcSessionClosedError);
  });

  it('consumes an approval exactly once, writes it back, and resumes the same turn', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);
    await h.session.awaitTurnOutcome();

    await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(true);
    expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'allow' }]);
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
      state: 'allowed',
      decisionSource: 'user',
    });

    // A second decision for the same call finds no pending record: the call it
    // names has already been decided, so this one is reported as not applied.
    await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(false);
    expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'allow' }]);

    // The same turn continues — it is not a new prompt — and settles normally.
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
    expect(h.session.turnId).toBe('piturn_1');
    expect(h.session.phase).toBe('idle');
  });

  it('refuses a malformed replacement input instead of handing it to the engine', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);
    await h.session.awaitTurnOutcome();

    // Pi re-validates nothing after an extension mutates `event.input`, so the
    // runtime is the last place a replacement can be refused.
    await expect(h.session.respondToInteraction('ui-gate-1', {
      decision: 'allow',
      input: 'rm -rf /',
    })).resolves.toBe(false);
    expect(decisions(h).at(-1)).toEqual({ id: 'ui-gate-1', decision: 'deny' });
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
      state: 'denied',
      decisionSource: 'user',
      denyMessage: 'the approval response was not a usable decision',
    });

    // The refused decision is spent: a replay cannot execute the call either.
    await expect(h.session.respondToInteraction('ui-gate-1', { decision: 'allow' })).resolves.toBe(false);
  });

  it('re-validates a replacement input and records what was decided against', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);
    await h.session.awaitTurnOutcome();

    // The replacement travels back with the approval because the gate applies it
    // in place, and the durable record keeps what was actually approved.
    await expect(h.session.respondToInteraction('ui-gate-1', {
      decision: 'allow',
      input: { command: 'echo safe' },
    })).resolves.toBe(true);
    expect(decisions(h).at(-1)).toEqual({ id: 'ui-gate-1', decision: 'allow', input: { command: 'echo safe' } });
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
      state: 'allowed',
      decidedInput: { command: 'echo safe' },
    });
  });

  it('denies a decision for a call this session is not waiting on', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);
    await h.session.awaitTurnOutcome();

    // A different call id names no pending record, so nothing may execute — and
    // the gate that is genuinely pending is left alone.
    await expect(h.session.respondToInteraction('toolu_other', { decision: 'allow' })).resolves.toBe(false);
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({ state: 'pending' });
    expect(decisions(h)).toEqual([]);
    expect(h.session.pendingGateRequestId).toBe('ui-gate-1');
  });

  it('denies a gate for a tool this session does not gate, and a payload it cannot read', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');

    // A tool the compiled plan does not gate is not this gate's business, and a
    // payload this gate cannot read is a request it cannot answer. Both are
    // denied: leaving Pi blocked would stop the engine.
    askGate(h, 'ui-gate-1', gatePayload({ tool_call_id: 'toolu_2', tool_name: 'write' }));
    askGate(h, 'ui-gate-2', 'not json at all');
    await waitFor(() => decisions(h).length === 2);

    expect(decisions(h)).toEqual([
      { id: 'ui-gate-1', decision: 'deny' },
      { id: 'ui-gate-2', decision: 'deny' },
    ]);
    expect(store.listForSession(SESSION_ID)).toEqual([]);
    expect(h.events.map((event) => event.type)).not.toContain('agent.tool_use');
    expect(h.session.pendingGateRequestId).toBeUndefined();
  });

  it('denies a gate opened while another decision is still pending', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h, 'ui-gate-1');
    await h.session.awaitTurnOutcome();

    // One runtime relays one decision per session, so a second gate would be a
    // question no caller can address. It is denied rather than overwriting the
    // pending gate, which would leave Pi suspended on an unaddressable dialog.
    askGate(h, 'ui-gate-2', gatePayload({ tool_call_id: 'toolu_2' }));
    await waitFor(() => decisions(h).length === 1);

    expect(decisions(h)).toEqual([{ id: 'ui-gate-2', decision: 'deny' }]);
    expect(h.session.pendingGateRequestId).toBe('ui-gate-1');
    expect(store.findByToolUse(SESSION_ID, 'toolu_2')).toBeUndefined();
  });

  it('fails closed when the transport dies while a decision is pending', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');
    askGate(h);
    await h.session.awaitTurnOutcome();

    h.wire.end();
    await settleAsync();

    // The record is retired as a denial, so no later decision can run the call
    // through a gate whose engine is gone, and the session is not alive.
    expect(h.session.alive).toBe(false);
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
      state: 'denied',
      decisionSource: 'system',
      denyMessage: 'the transport closed while the gate was pending',
    });
    await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(false);
  });

  it('denies a decision that arrives after the turn deadline has already elapsed', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store, turnTimeoutMs: 20 });
    await h.session.prompt('run');
    askGate(h);
    await waitFor(() => h.session.failureError !== undefined);

    expect(h.session.failureError).toBeInstanceOf(PiTimeoutError);
    expect(h.session.alive).toBe(false);

    // An answer that never arrived in time is not an approval. The record is
    // retired as a denial and the late decision is refused.
    expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
      state: 'denied',
      decisionSource: 'system',
      denyMessage: 'the turn deadline elapsed while the gate was pending',
    });
    await expect(h.session.respondToInteraction('ui-gate-1', { decision: 'allow' })).resolves.toBe(false);
  });

  it('fails the turn when a gated call executes with no gate decision attached', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    await h.session.prompt('run');

    // The extension's hook is the only thing that asks, so a gated call Pi
    // announces and finishes is one that ran unguarded. Reporting the turn as
    // settled would claim a decision happened that never did.
    h.fake.say({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'toolu_1' });
    h.fake.say({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'toolu_1', isError: false });

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(PiRpcGateLostError);
    expect(outcome.kind === 'failed' && outcome.error.message).toContain('without a SandBase gate decision');
    expect(h.session.alive).toBe(false);
  });

  it('proves the gate extension loaded, and fails closed when the marker is absent', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    h.fake.silentCommands.add('get_commands');

    const probe = h.session.verifyGateExtension();
    await waitFor(() => h.wire.written.some((frame) => frame.type === 'get_commands'));
    const requestId = String(h.wire.written.find((frame) => frame.type === 'get_commands')?.id);

    // A command list without the per-session marker is the runtime's only evidence
    // that the managed extension did not load, and a gated tool must not be
    // exposed without it.
    h.fake.say({
      type: 'response',
      id: requestId,
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'help' }] },
    });
    await expect(probe).rejects.toBeInstanceOf(PiRpcGateUnavailableError);
    await expect(probe).rejects.toMatchObject({ code: 'pi_rpc_gate_unavailable' });
  });

  it('accepts the marker command of the extension it launched', async () => {
    const store = gateStore();
    const h = harness({ gateTools: ['bash'], interactions: store });
    h.fake.silentCommands.add('get_commands');

    const probe = h.session.verifyGateExtension();
    await waitFor(() => h.wire.written.some((frame) => frame.type === 'get_commands'));
    const requestId = String(h.wire.written.find((frame) => frame.type === 'get_commands')?.id);
    h.fake.say({
      type: 'response',
      id: requestId,
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'help' }, { name: `sandbase-gate-${SESSION_ID}` }] },
    });

    await expect(probe).resolves.toBeUndefined();
  });

  it('probes nothing when the session gates nothing', async () => {
    const store = gateStore();
    const h = harness({ interactions: store });

    // An extra round trip on every start would be a claim about a tool set this
    // session does not have, so a session with no gated tool asks for nothing.
    await expect(h.session.verifyGateExtension()).resolves.toBeUndefined();
    expect(h.wire.written).toEqual([]);
  });

  it('denies a gated call when no durable store can record the decision', async () => {
    const h = harness({ gateTools: ['bash'] });
    await h.session.prompt('run');
    askGate(h);
    await waitFor(() => decisions(h).length === 1);

    // Without the store a decision cannot be proven to be consumed once, so the
    // call is denied rather than opened.
    expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'deny' }]);
    expect(h.session.pendingGateRequestId).toBeUndefined();
  });

  /**
   * The unattended mode: a second way for one gated call to be answered, under a
   * platform-owned rule instead of a person. These assertions are the ones that
   * keep it from becoming more than that — off unless selected, one call per
   * decision, never recorded as human, and never a standing permission.
   */
  describe('preauthorized_once mode', () => {
    /** A platform rule that answers `allow` and counts how often it was asked. */
    function allowingRule(): { rule: PiPreauthorizedRule; calls: () => number } {
      let calls = 0;
      return {
        rule: () => {
          calls += 1;
          return { allow: true };
        },
        calls: () => calls,
      };
    }

    it('waits for a person when no approval mode was selected, even with a rule available', async () => {
      const store = gateStore();
      const allowing = allowingRule();
      // The mode is the authority, not the rule's presence: a runtime that was
      // never switched to the unattended mode must not consult it at all.
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        preauthorizedRule: allowing.rule,
      });
      await h.session.prompt('run');
      askGate(h);

      const outcome = await h.session.awaitTurnOutcome();
      expect(outcome.kind).toBe('gate');
      expect(allowing.calls()).toBe(0);
      expect(decisions(h)).toEqual([]);
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({ state: 'pending' });
      const toolUse = h.events.find((event) => event.type === 'agent.tool_use');
      expect(toolUse?.content?.[0]).toMatchObject({ requires_confirmation: true });
      expect(toolUse?.metadata).toMatchObject({ confirmation_source: 'user' });
      expect(h.session.pendingGateRequestId).toBe('ui-gate-1');
    });

    it('answers a gated call itself and records it as a platform decision', async () => {
      const store = gateStore();
      const allowing = allowingRule();
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => 'preauthorized_once',
        preauthorizedRule: allowing.rule,
      });
      await h.session.prompt('run');
      askGate(h);
      await waitFor(() => decisions(h).length === 1);

      // Answered without a client: the rule named the call, so there is no gate
      // outcome, no approval card, and the same turn keeps running.
      expect(allowing.calls()).toBe(1);
      expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'allow' }]);
      expect(h.session.pendingGateRequestId).toBeUndefined();
      expect(h.session.phase).toBe('busy');
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
        state: 'allowed',
        decisionSource: 'platform',
      });

      // Nothing a client can read says a person decided: the published tool use
      // carries the platform as its source and is not an approval request.
      const toolUse = h.events.find((event) => event.type === 'agent.tool_use');
      expect(toolUse?.content?.[0]).toMatchObject({ id: 'toolu_1', requires_confirmation: false });
      expect(toolUse?.metadata).toMatchObject({
        confirmation_source: 'platform',
        confirmation_decision: 'allow',
      });

      // A person's answer for the call the platform already decided is refused,
      // and no second response is written for it.
      await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(false);
      expect(decisions(h)).toHaveLength(1);

      // The call the platform allowed is expected to execute, so its own frames
      // are not an unguarded gated call: the turn settles normally.
      h.fake.say({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'toolu_1' });
      h.fake.say({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'toolu_1', isError: false });
      h.fake.say({ type: 'agent_settled' });
      await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
      expect(h.session.turnId).toBe('piturn_1');
    });

    it('spends the platform decision on one call, so a replay of it is denied', async () => {
      const store = gateStore();
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => 'preauthorized_once',
        preauthorizedRule: () => ({ allow: true }),
      });
      await h.session.prompt('run');
      askGate(h, 'ui-gate-1');
      await waitFor(() => decisions(h).length === 1);

      // The same call announced again is a second gate for a call that already
      // has a decision. The conditional consume finds no pending row for the new
      // request, so nothing executes a second time and the replay is denied.
      askGate(h, 'ui-gate-2');
      await waitFor(() => decisions(h).length === 2);

      expect(decisions(h)).toEqual([
        { id: 'ui-gate-1', decision: 'allow' },
        { id: 'ui-gate-2', decision: 'deny' },
      ]);
      expect(store.listForSession(SESSION_ID)).toHaveLength(1);
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
        state: 'allowed',
        decisionSource: 'platform',
      });
    });

    it('decides the next gated call again instead of becoming a standing permission', async () => {
      const store = gateStore();
      const allowing = allowingRule();
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => 'preauthorized_once',
        preauthorizedRule: allowing.rule,
      });
      await h.session.prompt('run');
      askGate(h, 'ui-gate-1');
      await waitFor(() => decisions(h).length === 1);
      askGate(h, 'ui-gate-2', gatePayload({ tool_call_id: 'toolu_2' }));
      await waitFor(() => decisions(h).length === 2);

      // Two calls, two records, two decisions: the first decision authorized the
      // call it consumed and nothing after it.
      expect(allowing.calls()).toBe(2);
      expect(store.listForSession(SESSION_ID).map((record) => [
        record.toolUseId,
        record.state,
        record.decisionSource,
      ])).toEqual([
        ['toolu_1', 'allowed', 'platform'],
        ['toolu_2', 'allowed', 'platform'],
      ]);
    });

    it('waits for a person at the next decision once the mode is turned off', async () => {
      const store = gateStore();
      let mode: PiApprovalMode = 'preauthorized_once';
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => mode,
        preauthorizedRule: () => ({ allow: true }),
      });
      await h.session.prompt('run');
      askGate(h, 'ui-gate-1');
      await waitFor(() => decisions(h).length === 1);

      // The mode is read per gate, not latched on the session: turning it off is
      // honored by the very next call rather than by the next session.
      mode = 'interactive';
      askGate(h, 'ui-gate-2', gatePayload({ tool_call_id: 'toolu_2' }));

      const outcome = await h.session.awaitTurnOutcome();
      expect(outcome.kind).toBe('gate');
      expect(outcome.kind === 'gate' && outcome.interaction.toolUseId).toBe('toolu_2');
      expect(store.findByToolUse(SESSION_ID, 'toolu_2')).toMatchObject({ state: 'pending' });
      // A recorded decision keeps the source it was recorded with.
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
        state: 'allowed',
        decisionSource: 'platform',
      });
      // The call the rule no longer covers can still be approved by a person.
      await expect(h.session.respondToInteraction('toolu_2', { decision: 'allow' })).resolves.toBe(true);
      expect(store.findByToolUse(SESSION_ID, 'toolu_2')).toMatchObject({
        state: 'allowed',
        decisionSource: 'user',
      });
    });

    it('keeps waiting for a person when the rule does not name the call', async () => {
      const store = gateStore();
      const consulted: string[] = [];
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => 'preauthorized_once',
        preauthorizedRule: (record) => {
          consulted.push(record.toolName);
          return undefined;
        },
      });
      await h.session.prompt('run');
      askGate(h);

      // Abstaining is not a denial: the mode neither approves what the rule does
      // not name nor refuses what a person could still approve.
      const outcome = await h.session.awaitTurnOutcome();
      expect(outcome.kind).toBe('gate');
      expect(consulted).toEqual(['bash']);
      expect(decisions(h)).toEqual([]);
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({ state: 'pending' });

      await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(true);
      expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'allow' }]);
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
        state: 'allowed',
        decisionSource: 'user',
      });
    });

    it('records a platform refusal as a platform decision and spends the call', async () => {
      const store = gateStore();
      const h = harness({
        gateTools: ['bash'],
        interactions: store,
        approvalMode: () => 'preauthorized_once',
        preauthorizedRule: () => ({ allow: false, reason: 'outside the preauthorized set' }),
      });
      await h.session.prompt('run');
      askGate(h);
      await waitFor(() => decisions(h).length === 1);

      expect(decisions(h)).toEqual([{ id: 'ui-gate-1', decision: 'deny' }]);
      expect(store.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({
        state: 'denied',
        decisionSource: 'platform',
        denyMessage: 'outside the preauthorized set',
      });
      // A refusal is not a click by a person either, and the call is decided: a
      // later approval cannot revive it.
      const toolUse = h.events.find((event) => event.type === 'agent.tool_use');
      expect(toolUse?.metadata).toMatchObject({
        confirmation_source: 'platform',
        confirmation_decision: 'deny',
      });
      expect(h.session.pendingGateRequestId).toBeUndefined();
      await expect(h.session.respondToInteraction('toolu_1', { decision: 'allow' })).resolves.toBe(false);
    });
  });
});

describe('Pi RPC steering', () => {
  it('delivers one steer per turn and treats a repeated input as idempotent', async () => {
    const h = harness();
    await h.session.prompt('go');

    await expect(h.session.steer({ inputId: 'steer_1', text: 'be brief' }))
      .resolves.toMatchObject({ inputId: 'steer_1', state: 'delivered', turnId: 'piturn_1' });
    // Same input id, same text: the engine already has it, so this is answered as
    // a duplicate rather than sent as a second instruction.
    await expect(h.session.steer({ inputId: 'steer_1', text: 'be brief' }))
      .resolves.toMatchObject({ inputId: 'steer_1', state: 'duplicate' });
    expect(h.fake.commands.filter((command) => command === 'steer')).toHaveLength(1);
    // The steer reached the child as one record carrying only the text, so it
    // cannot have started work or exposed a tool.
    expect(h.wire.written.filter((frame) => frame.type === 'steer')).toEqual([
      { id: 'sb-2', type: 'steer', message: 'be brief' },
    ]);
  });

  it('refuses the same input id carrying different text instead of merging it', async () => {
    const h = harness();
    await h.session.prompt('go');
    await h.session.steer({ inputId: 'steer_1', text: 'be brief' });

    await expect(h.session.steer({ inputId: 'steer_1', text: 'ignore the tests' }))
      .resolves.toMatchObject({ inputId: 'steer_1', state: 'conflict' });
    expect(h.fake.commands.filter((command) => command === 'steer')).toHaveLength(1);
  });

  it('refuses a second steer while one is still in flight', async () => {
    const h = harness({ requestTimeoutMs: 60 });
    await h.session.prompt('go');
    // Pi never answers the steer, so the first write stays in flight.
    h.fake.silentCommands = new Set(['steer']);

    const inFlight = h.session.steer({ inputId: 'steer_1', text: 'first' });
    await waitFor(() => h.fake.commands.includes('steer'), 'the first steer write');

    await expect(h.session.steer({ inputId: 'steer_2', text: 'second' }))
      .resolves.toMatchObject({
        inputId: 'steer_2',
        state: 'rejected',
        detail: 'a steer is already in flight for this turn',
      });
    // The refused steer is not queued behind the first: it never reached the child.
    expect(h.fake.commands.filter((command) => command === 'steer')).toHaveLength(1);
    await expect(inFlight).resolves.toMatchObject({ state: 'outcome_unknown' });
  });

  it('binds a steer to the active turn when one was named', async () => {
    const h = harness();
    await h.session.prompt('go');

    await expect(h.session.steer({ inputId: 'steer_1', text: 'x', expectedTurnId: 'piturn_9' }))
      .resolves.toMatchObject({ state: 'rejected' });
    await expect(h.session.steer({ inputId: 'steer_1', text: 'x', expectedTurnId: 'piturn_1' }))
      .resolves.toMatchObject({ state: 'delivered' });
  });

  it('refuses steering before a turn starts, once admission closes, and after it ends', async () => {
    const h = harness();
    // Nothing is running yet, so there is no turn to steer and nothing is buffered
    // for the turn that has not started.
    await expect(h.session.steer({ inputId: 'steer_0', text: 'early' }))
      .resolves.toMatchObject({ state: 'rejected', detail: 'no turn is accepting steering' });

    await h.session.prompt('go');
    h.session.closeSteerAdmission();
    await expect(h.session.steer({ inputId: 'steer_1', text: 'late' }))
      .resolves.toMatchObject({ state: 'rejected' });

    // The turn's own end-of-turn frame closes admission before it settles, so a
    // steer arriving with the turn already over is refused rather than applied.
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
    await expect(h.session.steer({ inputId: 'steer_2', text: 'later' }))
      .resolves.toMatchObject({ state: 'rejected' });
    expect(h.fake.commands.filter((command) => command === 'steer')).toHaveLength(0);
  });

  it('retires a steer whose outcome is unknown instead of leaving it replayable', async () => {
    const h = harness({ requestTimeoutMs: 40 });
    await h.session.prompt('go');

    // Pi never answers the steer, so the write may or may not have been applied.
    h.fake.silentCommands = new Set(['steer']);
    await expect(h.session.steer({ inputId: 'steer_unknown', text: 'stop' }))
      .resolves.toMatchObject({ state: 'outcome_unknown' });

    // A retry of the same id must not be re-sent: the engine may already have
    // acted on the first write, and replaying it would double the instruction.
    await expect(h.session.steer({ inputId: 'steer_unknown', text: 'stop' }))
      .resolves.toMatchObject({ state: 'duplicate' });
    expect(h.fake.commands.filter((command) => command === 'steer')).toHaveLength(1);
  });

  it('reports a steer written to a closed session as refused', async () => {
    const h = harness();
    await h.session.prompt('go');
    await h.session.close();

    await expect(h.session.steer({ inputId: 'steer_1', text: 'stop' }))
      .resolves.toMatchObject({ state: 'rejected', detail: 'the session is closed' });
  });

  it('settles an in-flight steer receipt before the caller is told the turn finished', async () => {
    const h = harness();
    await h.session.prompt('go');
    // Nothing in flight: settling is a no-op rather than a hang.
    await expect(h.session.settleSteerReceipts()).resolves.toBeUndefined();

    h.fake.silentCommands = new Set(['steer']);
    const inFlight = h.session.steer({ inputId: 'steer_1', text: 'stop' });
    await waitFor(() => h.fake.commands.includes('steer'), 'the steer write');
    let settled = false;
    const settling = h.session.settleSteerReceipts().then(() => { settled = true; });
    await settleAsync();
    // The receipt is still owed, so the turn may not be reported as finished yet.
    expect(settled).toBe(false);

    h.fake.silentCommands = new Set();
    h.fake.say({ type: 'response', id: 'sb-2', command: 'steer', success: true });
    await expect(inFlight).resolves.toMatchObject({ state: 'delivered' });
    await settling;
    expect(settled).toBe(true);
  });
});
