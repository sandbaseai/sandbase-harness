/**
 * Pi strategy turn loop.
 *
 * The strategy is the Harness half of the Pi boundary: it owns the live engine
 * session, decides what a turn outcome means, and publishes the terminal
 * marker. These assertions drive it with a scripted session so the loop can be
 * exercised without a child process, and they are written about *order and
 * ownership* rather than about plumbing — a second turn that started a second
 * child, a `turn_complete` published for a turn that failed, or a child left
 * running after a terminal state would each be a correctness bug that a "did it
 * call the adapter" test would happily pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import { getPiSessionState } from '@/strategy/pi/session-continuity.js';
import type {
  LoopEngineSession,
  LoopEngineStartRequest,
  LoopEngineSteerInput,
  LoopEngineSteerReceipt,
  LoopEngineTurnOutcome,
} from '@/strategy/loop-engine/adapter.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SessionEvent } from '@/types/session.js';
import type { StrategyContext } from '@/types/strategy.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The frozen session definition the launch's tool flags are compiled from. */
const PI_AGENT = {
  name: 'pi-agent',
  model: 'gpt-pi-selected',
  system: '# System',
  tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'read' }, { name: 'grep' }] }],
} as unknown as AgentDefinition;

/**
 * A scripted engine session.
 *
 * Records the *sequence* of calls as well as their arguments, because two of
 * the behaviours under test are orderings: the terminal marker comes after the
 * turn's events, and a failed turn releases the child before it propagates.
 */
class ScriptedSession implements LoopEngineSession {
  readonly calls: string[] = [];
  readonly promptTexts: string[] = [];
  /** Decisions handed to the gate, in order. */
  readonly interactions: Array<{ reference: string; response: unknown }> = [];
  /** What `respondToInteraction` answers; `false` is a decision nothing consumed. */
  consumed = true;
  /** Prompts handed out in order; a promise here is a turn that has not settled. */
  readonly outcomes: Array<LoopEngineTurnOutcome | Promise<LoopEngineTurnOutcome>> = [];
  defaultOutcome: LoopEngineTurnOutcome | Promise<LoopEngineTurnOutcome> = { kind: 'settled' };
  alive = true;
  phase: 'idle' | 'busy' | 'closed' = 'idle';
  turnId: string | undefined = 'piturn_1';
  stderrTail = '';
  engineSessionFile: string | undefined;
  failureError: Error | undefined;
  /** Set to make `close()` reject, as a retained workspace does. */
  closeError: Error | undefined;
  /** Steers offered to this session, in order. */
  readonly steers: LoopEngineSteerInput[] = [];
  /** What `steer` answers. */
  steerReceipt: LoopEngineSteerReceipt = { inputId: 'unset', state: 'delivered' };
  /**
   * Run the moment steer receipts settle, so a test can observe the log as it was
   * before `turn_complete` — the ordering this session participates in.
   */
  onSettleSteerReceipts: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async prompt(text: string): Promise<void> {
    this.calls.push('prompt');
    this.promptTexts.push(text);
    this.phase = 'busy';
  }

  async steer(input: LoopEngineSteerInput): Promise<LoopEngineSteerReceipt> {
    this.calls.push('steer');
    this.steers.push(input);
    return { ...this.steerReceipt, inputId: input.inputId };
  }

  closeSteerAdmission(): void {
    this.calls.push('closeSteerAdmission');
  }

  async settleSteerReceipts(): Promise<void> {
    this.calls.push('settleSteerReceipts');
    this.onSettleSteerReceipts?.();
  }

  async respondToInteraction(reference: string, response: unknown): Promise<boolean> {
    this.calls.push('respondToInteraction');
    this.interactions.push({ reference, response });
    return this.consumed;
  }

  async awaitTurnOutcome(): Promise<LoopEngineTurnOutcome> {
    this.calls.push('awaitTurnOutcome');
    return this.outcomes.shift() ?? this.defaultOutcome;
  }

  async interrupt(): Promise<void> {
    this.calls.push('interrupt');
    this.alive = false;
    this.phase = 'closed';
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.alive = false;
    this.phase = 'closed';
    if (this.closeError) throw this.closeError;
  }
}

function contextFor(
  events: SessionEvent[],
  overrides: {
    workDir?: string | null;
    agentDefinition?: unknown;
    event?: unknown;
    abortSignal?: AbortSignal;
    requiresAction?: () => void;
  } = {},
  broadcasts: SessionEvent[] = [],
): StrategyContext {
  let sequence = 0;
  return {
    session: {
      id: 'sess_pi_turn',
      loopEngine: 'pi',
      agentId: 'agent_pi',
      agentName: 'pi-agent',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
      agentDefinition: overrides.agentDefinition === undefined ? PI_AGENT : overrides.agentDefinition,
    },
    userEvent: overrides.event ?? { type: 'user.message', content: [{ type: 'text', text: 'Implement this.' }] },
    systemPrompt: '# System',
    messages: [],
    modelConfig: { name: 'selected', provider: 'openai', model: 'gpt-pi-selected', api_key: 'fixture-key' },
    tools: {},
    sandbox: {
      sessionId: 'sess_pi_turn',
      hostWorkDir: overrides.workDir === undefined ? '/sandbox/work' : overrides.workDir,
    },
    eventLog: {
      append(_sessionId: string, event: { type: string }) {
        const persisted = {
          id: `sevt_${++sequence}`,
          sessionId: 'sess_pi_turn',
          seq: sequence,
          type: event.type,
          createdAt: new Date(),
        } as unknown as SessionEvent;
        events.push(persisted);
        return persisted;
      },
      getLatestSeq: () => sequence,
      recordUsage: () => {},
    },
    broadcast: (event: SessionEvent) => broadcasts.push(event),
    ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
    config: { ...(overrides.requiresAction ? { onRequiresAction: overrides.requiresAction } : {}) },
  } as unknown as StrategyContext;
}

function strategyFor(
  sessions: LoopEngineSession[],
  starts: LoopEngineStartRequest[],
  database?: Database,
): PiStrategy {
  let index = 0;
  return new PiStrategy({
    adapter: {
      async startSession(request: LoopEngineStartRequest) {
        starts.push(request);
        const session = sessions[Math.min(index, sessions.length - 1)];
        index += 1;
        return session;
      },
    },
    ...(database ? { database } : {}),
  });
}

/** Run one turn to completion, or to its thrown failure. */
async function run(strategy: PiStrategy, context: StrategyContext): Promise<SessionEvent[]> {
  const yielded: SessionEvent[] = [];
  for await (const event of strategy.execute(context)) yielded.push(event);
  return yielded;
}

/**
 * A database with the session row continuity state references.
 *
 * `pi_session_state.session_id` is a foreign key, so continuity cannot be
 * recorded for a session the runtime does not have — which is the point of the
 * constraint, and means a test has to create the session it writes about.
 */
function continuityDatabase(prefix: string): { database: Database; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const database = new Database(join(directory, 'data.db'));
  database.runMigrations();
  database.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  database.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
  database.exec(`
    INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine)
    VALUES ('sess_pi_turn', 'agent_pi', 'pi-agent', 'env_default', 'running', '[]', '[]', 'pi')
  `);
  return { database, directory };
}

describe('PiStrategy turn loop over a session-owned child', () => {
  it('compiles the frozen definition into the flags the launch receives', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const starts: LoopEngineStartRequest[] = [];
    const strategy = strategyFor([session], starts);
    const events: SessionEvent[] = [];

    await run(strategy, contextFor(events));

    // The declared policy reaches the adapter as Pi's own flags, so the plan
    // admission checked is the plan the child is launched with.
    expect(starts).toHaveLength(1);
    expect(starts[0].toolPlan.flags).toEqual(['--tools', 'read,grep']);
    expect(starts[0]).toMatchObject({
      sessionId: 'sess_pi_turn',
      workDir: '/sandbox/work',
      systemPrompt: '# System',
      model: { provider: 'openai', model: 'gpt-pi-selected', api_key: 'fixture-key' },
    });
    expect(session.promptTexts).toEqual(['Implement this.']);
  });

  it('starts one child for the session and writes later turns to the same one', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const starts: LoopEngineStartRequest[] = [];
    const strategy = strategyFor([session], starts);

    await run(strategy, contextFor([]));
    await run(strategy, contextFor([]));
    await run(strategy, contextFor([]));

    // Acceptance: one child per session, not one per turn.
    expect(starts).toHaveLength(1);
    expect(session.promptTexts).toEqual(['Implement this.', 'Implement this.', 'Implement this.']);
    expect(strategy.liveSessionIds()).toEqual(['sess_pi_turn']);
  });

  it('publishes the terminal marker after the turn settles, and yields no durable event', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const strategy = strategyFor([session], []);
    const events: SessionEvent[] = [];
    const broadcasts: SessionEvent[] = [];

    const yielded = await run(strategy, contextFor(events, {}, broadcasts));

    // A yielded durable event would be broadcast a second time by the executor.
    expect(yielded).toEqual([]);
    expect(session.calls).toEqual([
      'prompt',
      'awaitTurnOutcome',
      'closeSteerAdmission',
      'settleSteerReceipts',
    ]);
    expect(events.map((event) => event.type)).toEqual(['turn_complete']);
    // Appended first, then broadcast: a subscriber never sees an event the log
    // does not already hold.
    expect(broadcasts.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it('closes steer admission and settles its receipts before turn_complete', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const strategy = strategyFor([session], []);
    const events: SessionEvent[] = [];
    // A turn is not finished while it still owes an answer to a steer, so the log
    // is observed at the exact moment receipts settle: nothing may be published
    // before them, and a client that reads `turn_complete` must never afterwards
    // watch a steer land in the turn it just saw finish.
    let publishedAtSettle = -1;
    session.onSettleSteerReceipts = () => { publishedAtSettle = events.length; };
    const closeIndex = () => session.calls.indexOf('closeSteerAdmission');
    const settleIndex = () => session.calls.indexOf('settleSteerReceipts');

    await run(strategy, contextFor(events));

    expect(publishedAtSettle).toBe(0);
    expect(closeIndex()).toBeLessThan(settleIndex());
    expect(events.map((event) => event.type)).toEqual(['turn_complete']);
  });

  it('delivers a steer on the side channel and reports a missing session as absent', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    session.steerReceipt = { inputId: 'steer_1', state: 'delivered', turnId: 'piturn_1' };
    const strategy = strategyFor([session], []);

    // No live session: `undefined` means the request never reached an engine, so
    // the caller reports a refusal rather than a delivery.
    await expect(strategy.steerSession('sess_pi_turn', { inputId: 'steer_1', text: 'stop' }))
      .resolves.toBeUndefined();

    await run(strategy, contextFor([]));
    await expect(strategy.steerSession('sess_pi_turn', { inputId: 'steer_1', text: 'stop' }))
      .resolves.toEqual({ inputId: 'steer_1', state: 'delivered', turnId: 'piturn_1' });
    expect(session.steers).toEqual([{ inputId: 'steer_1', text: 'stop' }]);
  });

  it('propagates a failed turn with the engine reason and releases the child', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    session.defaultOutcome = { kind: 'failed', error: new Error('Pi RPC stdout ended') };
    session.stderrTail = 'model not found: sandbase/nope';
    const strategy = strategyFor([session], []);

    await expect(run(strategy, contextFor([]))).rejects.toThrow(
      'Pi RPC stdout ended; Pi stderr: model not found: sandbase/nope',
    );
    expect(session.calls).toContain('close');
    // The child may be wedged, so the dead session is not reused: the next turn
    // starts a fresh one rather than writing into a transport nobody reads.
    expect(strategy.liveSessionIds()).toEqual([]);
  });

  it('keeps a cleanup failure visible instead of reporting the engine error', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    session.defaultOutcome = { kind: 'failed', error: new Error('Pi RPC reader failed') };
    const cleanup = new Error('Pi process tree cleanup is pending; the workspace remains retained');
    cleanup.name = 'PiCleanupPendingError';
    (cleanup as Error & { code: string }).code = 'pi_cleanup_pending';
    session.closeError = cleanup;
    const strategy = strategyFor([session], []);

    await expect(run(strategy, contextFor([]))).rejects.toMatchObject({
      code: 'pi_cleanup_pending',
      name: 'PiCleanupPendingError',
    });
    // The session stays registered: its workspace was not released, so the
    // runtime still owns a child it must finish cleaning up.
    expect(strategy.liveSessionIds()).toEqual(['sess_pi_turn']);
  });

  it('stops the interrupted child and launches another for a continuation', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    // A turn that never settles: only the abort can end it.
    session.defaultOutcome = new Promise<LoopEngineTurnOutcome>(() => {});
    const continued = new ScriptedSession('sess_pi_turn');
    const starts: LoopEngineStartRequest[] = [];
    const strategy = strategyFor([session, continued], starts);
    const controller = new AbortController();

    const turn = run(strategy, contextFor([], { abortSignal: controller.signal }));
    controller.abort();

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.calls).toContain('interrupt');
    expect(strategy.liveSessionIds()).toEqual([]);
    await run(strategy, contextFor([]));
    expect(starts).toHaveLength(2);
    expect(starts[1]?.sessionId).toBe('sess_pi_turn');
    expect(continued.calls).toContain('prompt');
    expect(strategy.liveSessionIds()).toEqual(['sess_pi_turn']);
  });

  it('releases the child when the session reaches a terminal state', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const strategy = strategyFor([session], []);

    await run(strategy, contextFor([]));
    await strategy.disposeSession('sess_pi_turn');

    expect(session.calls).toContain('close');
    expect(strategy.liveSessionIds()).toEqual([]);

    // Idempotent: stop, delete and close can each ask, and a second ask does not
    // close a child twice.
    const closes = session.calls.filter((call) => call === 'close').length;
    await strategy.disposeSession('sess_pi_turn');
    expect(session.calls.filter((call) => call === 'close')).toHaveLength(closes);
  });

  it('records the engine session identity and the contract it ran under after a settled turn', async () => {
    const { database, directory } = continuityDatabase('ma-pi-strategy-continuity-');
    const sessionFile = join(directory, 'pi-sessions', 'sess_pi_turn.jsonl');
    mkdirSync(join(directory, 'pi-sessions'), { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'pi-session-1', version: 1 })}\n`);

    const session = new ScriptedSession('sess_pi_turn');
    session.engineSessionFile = sessionFile;
    const starts: LoopEngineStartRequest[] = [];
    const strategy = strategyFor([session], starts, database);

    await run(strategy, contextFor([]));

    // Continuity is recorded before the terminal marker, so a later turn can
    // prove it is continuing the same Pi conversation under the same contract.
    const state = getPiSessionState(database, 'sess_pi_turn');
    expect(state).toMatchObject({
      sessionFile,
      piSessionId: 'pi-session-1',
      status: 'active',
    });
    // The binding the launch proved is the binding the settled turn records:
    // one computation, so the two cannot disagree about what this session is.
    expect(state?.workDir).toBe(starts[0]?.binding.workDir);
    expect(state?.policyFingerprint).toBe(starts[0]?.binding.policyFingerprint);
    expect(state?.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    database.close();
  });

  it('fingerprints the approval mode as part of the contract a session is bound to', async () => {
    const interactiveStarts: LoopEngineStartRequest[] = [];
    const interactive = new ScriptedSession('sess_pi_turn');
    await run(new PiStrategy({
      adapter: {
        async startSession(request: LoopEngineStartRequest) {
          interactiveStarts.push(request);
          return interactive;
        },
      },
    }), contextFor([]));

    const preauthorizedStarts: LoopEngineStartRequest[] = [];
    const preauthorized = new ScriptedSession('sess_pi_turn');
    await run(new PiStrategy({
      adapter: {
        async startSession(request: LoopEngineStartRequest) {
          preauthorizedStarts.push(request);
          return preauthorized;
        },
      },
      approvalMode: () => 'preauthorized_once',
    }), contextFor([]));

    // Who answers a gated call changes the contract even when nothing else does,
    // so a runtime that switched mode is not resuming the session its earlier
    // turns described — while the work directory it runs in is unchanged.
    expect(interactiveStarts[0]?.binding.workDir).toBe(preauthorizedStarts[0]?.binding.workDir);
    expect(interactiveStarts[0]?.binding.policyFingerprint)
      .not.toBe(preauthorizedStarts[0]?.binding.policyFingerprint);
  });

  it('refuses a turn whose engine session changed identity underneath it', async () => {
    const { database, directory } = continuityDatabase('ma-pi-strategy-drift-');
    const sessionFile = join(directory, 'pi-sessions', 'sess_pi_turn.jsonl');
    mkdirSync(join(directory, 'pi-sessions'), { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'pi-session-1', version: 1 })}\n`);
    database.prepare(`
      INSERT INTO pi_session_state (session_id, session_file, pi_session_id, schema_version, status)
      VALUES ('sess_pi_turn', ?, 'pi-session-other', '1', 'active')
    `).run(sessionFile);

    const session = new ScriptedSession('sess_pi_turn');
    session.engineSessionFile = sessionFile;
    const strategy = strategyFor([session], [], database);

    await expect(run(strategy, contextFor([]))).rejects.toMatchObject({
      name: 'PiContinuityError',
      code: 'pi_session_discontinuous',
    });
    database.close();
  });

  it('refuses a turn with no host work directory or no frozen agent definition', async () => {
    const strategy = strategyFor([new ScriptedSession('sess_pi_turn')], []);

    await expect(run(strategy, contextFor([], { workDir: null })))
      .rejects.toThrow(/host-accessible work directory/);
    await expect(run(strategy, contextFor([], { agentDefinition: null })))
      .rejects.toThrow(/agent definition/);
  });

  it('refuses a non-text user message rather than dropping the unsupported blocks', async () => {
    const strategy = strategyFor([new ScriptedSession('sess_pi_turn')], []);
    const context = contextFor([], {
      event: {
        type: 'user.message',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/i.png' } }],
      },
    });

    await expect(run(strategy, context)).rejects.toThrow(/text user messages only/);
  });
});

describe('PiStrategy tool gate', () => {
  /** The plan the launch must load a gate extensions for, compiled from the agent. */
  const GATED_AGENT = {
    name: 'pi-agent',
    model: 'gpt-pi-selected',
    system: '# System',
    tools: [{
      type: 'agent_toolset_20260401',
      configs: [{ name: 'read' }, { name: 'bash', permission_policy: { type: 'always_ask' } }],
    }],
  } as unknown as AgentDefinition;

  const GATE_INTERACTION = {
    requestId: 'ui-gate-1',
    toolUseId: 'toolu_1',
    toolName: 'bash',
    input: { command: 'rm -rf /tmp/x' },
    inputFingerprint: 'fixture-fingerprint',
    turnId: 'piturn_1',
  };

  it('sends the gated tool names with the flags the launch is admitted with', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const starts: LoopEngineStartRequest[] = [];
    const strategy = strategyFor([session], starts);

    await run(strategy, contextFor([], { agentDefinition: GATED_AGENT }));

    // The gates travel with the flags because they are the same compiled policy:
    // a name that is allowed but not gated would execute with nobody asked.
    expect(starts[0].toolPlan.flags).toEqual(['--tools', 'read,bash']);
    expect(starts[0].toolPlan.gate).toEqual(['bash']);
  });

  it('suspends on a gate without publishing a terminal marker, and reports it needs an action', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    session.outcomes.push({ kind: 'gate', interaction: GATE_INTERACTION });
    const events: SessionEvent[] = [];
    let requiresAction = false;
    const strategy = strategyFor([session], []);

    await run(strategy, contextFor(events, { requiresAction: () => { requiresAction = true; } }));

    // Pi is blocked inside its tool hook, so the turn is not finished: publishing
    // `turn_complete` would tell a client the turn ended while it is still open,
    // and the session has to say it is waiting for a decision.
    expect(requiresAction).toBe(true);
    expect(events.map((event) => event.type)).not.toContain('turn_complete');
    // The session is not released: the same turn continues when a decision lands.
    expect(session.calls).not.toContain('close');
  });

  it('writes a decision back to the session that raised the gate, then continues that turn', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    const events: SessionEvent[] = [];
    const strategy = strategyFor([session], []);

    await run(strategy, contextFor(events, {
      event: { type: 'user.tool_confirmation', tool_use_id: 'toolu_1', result: 'allow', deny_message: 'because' },
    }));

    // A confirmation is not a prompt: the child is already in the turn the gate
    // suspended, and sending a second prompt would race it.
    expect(session.promptTexts).toEqual([]);
    expect(session.interactions).toEqual([{
      reference: 'toolu_1',
      response: { decision: 'allow', denyMessage: 'because' },
    }]);
    expect(events.map((event) => event.type)).toEqual(['turn_complete']);
  });

  it('refuses a decision no pending record consumed instead of reporting it applied', async () => {
    const session = new ScriptedSession('sess_pi_turn');
    session.consumed = false;
    const strategy = strategyFor([session], []);

    await expect(run(strategy, contextFor([], {
      event: { type: 'user.tool_confirmation', tool_use_id: 'toolu_1', result: 'allow' },
    }))).rejects.toMatchObject({ code: 'pi_rpc_approval_not_pending' });
    // The child is released: the caller cannot be told the decision took effect,
    // and leaving a session blocked on a gate nobody is waiting for is worse.
    expect(session.calls).toContain('close');
  });
});
