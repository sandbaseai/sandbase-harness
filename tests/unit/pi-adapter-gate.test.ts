/**
 * Pi adapter gate boundary.
 *
 * The adapter is where a gated launch is either proven or refused, so these
 * assertions are about the two ways an `always_ask` tool could be exposed with no
 * gate behind it: a session composed without the durable store that makes a
 * decision one-shot, and a child that did not load the managed extension. Both
 * must fail the start, because a session the caller believes is gated is worse
 * than one that never started.
 */

import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { PiAdapter } from '@/strategy/pi/pi-adapter.js';
import { PiRpcSessionClosedError } from '@/strategy/pi/rpc-session.js';
import { PiInteractionStore } from '@/strategy/pi/interaction-store.js';
import { PI_PREAUTHORIZED_ONCE_RULE } from '@/strategy/pi/approval-mode.js';
import type { PiRpcLauncher, PiRpcLaunchRequest, PiRpcProcessHandle } from '@/strategy/pi-launcher.js';
import type { LoopEngineEventSink, LoopEngineSession } from '@/strategy/loop-engine/adapter.js';
import type { SessionEvent } from '@/types/session.js';
import { settleAsync, waitFor } from './pi-rpc-test-helpers.js';

const SESSION_ID = 'sess_adapter_gate';
const directories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(): PiInteractionStore {
  const directory = mkdtempSync(join(tmpdir(), 'ma-pi-adapter-gate-'));
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

const sink: LoopEngineEventSink = {
  append: (_sessionId, event) => ({ id: 'sevt_1', sessionId: SESSION_ID, seq: 1, type: event.type, createdAt: new Date() } as unknown as SessionEvent),
  getLatestSeq: () => 0,
  recordUsage: () => {},
  recordAuxiliaryModelUsage: (_sessionId, _usage, _options) =>
    ({ id: 'sevt_1', sessionId: SESSION_ID, seq: 1, type: 'span.model_request_end', createdAt: new Date() } as unknown as SessionEvent),
  broadcast: () => {},
  spillToolOutput: async (output) => output,
};

/**
 * A child that answers `get_commands` with whatever the test says, so the marker
 * check can be driven in both directions without a real Pi process.
 */
function fakeLauncher(commands: string[]): {
  launcher: PiRpcLauncher;
  interrupts: () => number;
  starts: PiRpcLaunchRequest[];
  /** Frames the session wrote on the child's stdin, decoded, in order. */
  frames: () => Record<string, unknown>[];
  /** Emit one frame as if the child had produced it. */
  emit: (frame: unknown) => void;
} {
  const starts: PiRpcLaunchRequest[] = [];
  const frames: Record<string, unknown>[] = [];
  let interrupts = 0;
  let childStdout: PassThrough | undefined;
  const launcher: PiRpcLauncher = {
    async startRpc(request): Promise<PiRpcProcessHandle> {
      starts.push(request);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      childStdout = stdout;
      let buffer = '';
      stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) return;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as Record<string, unknown>;
          frames.push(frame);
          stdout.write(`${JSON.stringify({
            type: 'response',
            id: frame.id,
            command: frame.type,
            success: true,
            data: { commands: commands.map((name) => ({ name })) },
          })}\n`);
        }
      });
      return {
        stdin,
        stdout,
        stderr,
        child: { pid: 1, kill: () => true } as unknown as PiRpcProcessHandle['child'],
        wait: async () => ({ code: 0, signal: null }),
        terminate: async () => {},
        interrupt: async () => {
          interrupts += 1;
        },
      };
    },
  };
  return {
    launcher,
    interrupts: () => interrupts,
    starts,
    frames: () => frames,
    emit: (frame) => childStdout?.write(`${JSON.stringify(frame)}\n`),
  };
}

const startRequest = {
  sessionId: SESSION_ID,
  workDir: '/sandbox/work',
  systemPrompt: '# System',
  model: { provider: 'openai', model: 'gpt-pi-selected', api_key: 'fixture-key' },
  toolPlan: { flags: ['--tools', 'read,bash'], gate: ['bash'] },
  // The contract the session runs under, which the launch has to be able to prove
  // before it spawns a child.
  binding: { workDir: '/sandbox/work', policyFingerprint: 'fixture-policy-fingerprint' },
  sink,
};

/** One gate question, as the managed extension asks it. */
function gateDialog(id: string, toolCallId = 'toolu_1'): Record<string, unknown> {
  return {
    type: 'extension_ui_request',
    id,
    method: 'editor',
    title: 'SandBase tool approval',
    prefill: JSON.stringify({
      kind: 'sandbase_tool_gate',
      version: 1,
      tool_call_id: toolCallId,
      tool_name: 'bash',
      input: { command: 'rm -rf /tmp/x' },
    }),
    blocking: true,
  };
}

describe('Pi adapter gate boundary', () => {
  it('refuses a gated launch with no durable pending-interaction store', async () => {
    const launcher = fakeLauncher([]);
    const adapter = new PiAdapter({ launcher: launcher.launcher });

    // Without the store the gate's one-shot guarantee has nowhere to live, so the
    // launch is refused before a child exists rather than opened ungated.
    await expect(adapter.startSession(startRequest)).rejects.toBeInstanceOf(PiRpcSessionClosedError);
    expect(launcher.starts).toEqual([]);
  });

  it('closes the child and fails the start when the gate extension did not load', async () => {
    const launcher = fakeLauncher(['help']);
    const adapter = new PiAdapter({ launcher: launcher.launcher, interactions: store() });

    await expect(adapter.startSession(startRequest)).rejects.toMatchObject({
      code: 'pi_rpc_gate_unavailable',
    });
    // The child is released rather than handed back: the tool it would run
    // unguarded is the one the caller declared as always_ask.
    expect(launcher.interrupts()).toBe(1);
  });

  it('returns a session whose gate extension proved it loaded', async () => {
    const launcher = fakeLauncher(['help', `sandbase-gate-${SESSION_ID}`]);
    const adapter = new PiAdapter({ launcher: launcher.launcher, interactions: store() });

    const session: LoopEngineSession = await adapter.startSession(startRequest);
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.alive).toBe(true);
    expect(launcher.interrupts()).toBe(0);
    await session.close();
    expect(launcher.interrupts()).toBe(1);
  });

  it('answers a gated call itself only when the operator selected the preauthorized mode', async () => {
    const commands = ['help', `sandbase-gate-${SESSION_ID}`];
    const interactions = store();
    const interactive = fakeLauncher(commands);
    const interactiveSession = await new PiAdapter({
      launcher: interactive.launcher,
      interactions,
    }).startSession(startRequest);
    await interactiveSession.prompt('run');
    interactive.emit(gateDialog('ui-gate-1'));
    await waitFor(() => interactions.findByToolUse(SESSION_ID, 'toolu_1') !== undefined);
    await settleAsync();

    // An interactive adapter relays nothing on its own: the call is recorded and
    // left waiting, and no decision is written for it.
    expect(interactive.frames().filter((frame) => frame.type === 'extension_ui_response')).toEqual([]);
    expect(interactions.findByToolUse(SESSION_ID, 'toolu_1')).toMatchObject({ state: 'pending' });
    await interactiveSession.close();

    const preauthorized = fakeLauncher(commands);
    const preauthorizedSession = await new PiAdapter({
      launcher: preauthorized.launcher,
      interactions,
      approvalMode: () => 'preauthorized_once',
      preauthorizedRule: PI_PREAUTHORIZED_ONCE_RULE,
    }).startSession(startRequest);
    await preauthorizedSession.prompt('run');
    preauthorized.emit(gateDialog('ui-gate-2', 'toolu_2'));
    await waitFor(() => preauthorized.frames().some((frame) => frame.type === 'extension_ui_response'));

    // The same wiring, with the mode selected: the adapter's rule answers the
    // call and the durable decision is the platform's, not a person's.
    expect(JSON.parse(String(preauthorized.frames().find((frame) => frame.type === 'extension_ui_response')?.value)))
      .toEqual({ decision: 'allow' });
    expect(interactions.findByToolUse(SESSION_ID, 'toolu_2')).toMatchObject({
      state: 'allowed',
      decisionSource: 'platform',
    });

    // The mode changes who answers a gate, never the policy the child runs: both
    // launches carry the same compiled flags and the same gated names.
    expect(preauthorized.starts[0].toolArgs).toEqual(startRequest.toolPlan.flags);
    expect(preauthorized.starts[0].gateTools).toEqual(startRequest.toolPlan.gate);
    expect(interactive.starts[0].toolArgs).toEqual(preauthorized.starts[0].toolArgs);
    expect(interactive.starts[0].gateTools).toEqual(preauthorized.starts[0].gateTools);
    // And the contract the caller admitted travels with them, so the launch can
    // refuse a resume the recorded state does not agree with.
    expect(preauthorized.starts[0].policyFingerprint).toBe(startRequest.binding.policyFingerprint);
    await preauthorizedSession.close();
  });
});
