import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { UserEvent } from '@/types/cma-protocol.js';
import { Database } from '@/core/db/database.js';
import {
  assertPiAgentCanExecute,
  PI_MESSAGE_CONTENT_UNSUPPORTED_CODE,
  PI_SANDBOX_UNSUPPORTED_CODE,
  PI_SANDBOX_UNSUPPORTED_MESSAGE,
  PI_TOOL_POLICY_UNSUPPORTED_CODE,
  PiToolPolicyUnsupportedError,
  PI_USER_EVENT_UNSUPPORTED_CODE,
} from '@/core/session/pi-policy.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { validateRuntimeSettings, type RuntimeSettings } from '@/core/settings/schema.js';
import { testRuntimeSettingsArea } from '@/core/settings/test.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';
import type { AgentDefinition } from '@/types/agent.js';

const directories: string[] = [];

const piSettings: RuntimeSettings = {
  schema_version: 1,
  model: { vendor: 'openai', api_key: 'test-key', options: {} },
  loop_engine: { provider: 'pi', options: { default_max_steps: 25 } },
  storage: {
    metadata: { provider: 'sqlite', options: {} },
    artifacts: { provider: 'local', options: { base_path: 'files' } },
  },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Timed out waiting for session lifecycle transition');
}

type WindowsPiTerminationHarness = {
  db: Database;
  cleanupCalls: string[];
  manager: SessionManager;
  parentClosed: Promise<void>;
  sessionId: string;
  spawned: Promise<void>;
};

function createWindowsPiTerminationHarness(treeTermination: Promise<void>): WindowsPiTerminationHarness {
  const directory = mkdtempSync(join(tmpdir(), 'ma-pi-windows-manager-'));
  directories.push(directory);
  const workDir = join(directory, 'work');
  mkdirSync(workDir);
  const db = new Database(join(directory, 'data.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);

  let notifySpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolvePromise) => { notifySpawned = resolvePromise; });
  let notifyParentClosed: (() => void) | undefined;
  const parentClosed = new Promise<void>((resolvePromise) => { notifyParentClosed = resolvePromise; });
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    }),
    kill: () => true,
  }) as unknown as ChildProcess;
  const launcher = new PiLauncher({
    dataDir: directory,
    command: 'controlled-pi',
    platform: 'win32',
    environment: {},
    spawnImpl: (() => {
      notifySpawned?.();
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
    terminateProcess: (piChild) => {
      piChild.once('close', () => notifyParentClosed?.());
      queueMicrotask(() => piChild.emit('close', 0));
      return treeTermination;
    },
    cleanupTimeoutMs: 25,
  });
  const manager = new SessionManager(db, undefined, 'pi');
  const cleanupCalls: string[] = [];
  manager.setExecutor({
    async *execute(session, _event, options) {
      await launcher.launch({
        sessionId: session.id,
        workDir,
        prompt: 'run',
        systemPrompt: 'system',
        model: { provider: 'openai', model: 'test-model', api_key: 'test-key' },
        abortSignal: options?.abortSignal,
      });
    },
    async cleanupSession(sessionId) { cleanupCalls.push(sessionId); },
  });
  const session = manager.create({ agent: 'agent_test' });

  return { db, cleanupCalls, manager, parentClosed, sessionId: session.id, spawned };
}

describe('Pi Windows termination cleanup', () => {
  it('does not release a Pi session workspace until Windows tree termination completes after parent close', async () => {
    let completeTreeTermination: (() => void) | undefined;
    const treeTermination = new Promise<void>((resolvePromise) => {
      completeTreeTermination = resolvePromise;
    });
    const { db, cleanupCalls, manager, parentClosed, sessionId, spawned } = createWindowsPiTerminationHarness(treeTermination);

    await manager.sendEvent(sessionId, {
      type: 'user.message', content: [{ type: 'text', text: 'run' }],
    });
    await spawned;
    const stop = manager.stop(sessionId);
    let stopSettled = false;
    void stop.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    await parentClosed;
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(cleanupCalls).toEqual([]);

    completeTreeTermination?.();
    await stop;
    expect(manager.get(sessionId)?.status).toBe('paused');
    expect(cleanupCalls).toEqual([]);
    db.close();
  });

  it('fails closed when Windows tree termination rejects after the Pi parent closes', async () => {
    let rejectTreeTermination: ((error: Error) => void) | undefined;
    const treeTermination = new Promise<void>((_resolvePromise, rejectPromise) => {
      rejectTreeTermination = rejectPromise;
    });
    const { db, cleanupCalls, manager, parentClosed, sessionId, spawned } = createWindowsPiTerminationHarness(treeTermination);

    await manager.sendEvent(sessionId, {
      type: 'user.message', content: [{ type: 'text', text: 'run' }],
    });
    await spawned;
    const stop = manager.stop(sessionId);
    let stopSettled = false;
    void stop.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    await parentClosed;
    rejectTreeTermination?.(new Error('taskkill failed'));
    await waitFor(() => stopSettled);
    expect(stopSettled).toBe(true);
    expect(manager.get(sessionId)?.status).toBe('cleanup_pending');
    expect(cleanupCalls).toEqual([]);
    db.close();
  });
});

describe('session loop engine persistence', () => {
  it('freezes the selected Pi engine while later sessions use the changed global engine', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-session-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);

    const piManager = new SessionManager(db, undefined, 'pi');
    const piSession = piManager.create({ agent: 'agent_test' });
    const builtinManagerAfterSettingsChange = new SessionManager(db, undefined, 'builtin');
    const builtinSession = builtinManagerAfterSettingsChange.create({ agent: 'agent_test' });

    expect(piSession.loopEngine).toBe('pi');
    expect(builtinManagerAfterSettingsChange.get(piSession.id)?.loopEngine).toBe('pi');
    expect(builtinSession.loopEngine).toBe('builtin');
    db.close();
  });

  it('registers Pi settings and reports the injected CLI probe result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-settings-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();

    expect(validateRuntimeSettings(piSettings).valid).toBe(true);
    const result = await testRuntimeSettingsArea({
      db,
      dataDir: directory,
      area: 'loop_engine',
      config: piSettings,
      piProbe: async () => ({ available: true, message: 'controlled Pi CLI is available.' }),
    });

    expect(result).toMatchObject({ ok: true, status: 'ok' });
    expect(result.checks).toContainEqual({
      name: 'pi_cli',
      status: 'ok',
      message: 'controlled Pi CLI is available.',
    });
    db.close();
  });

  it('drains aborted Pi turns before interrupt, stop, delete, and shutdown cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lifecycle-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');
    const cleanupCalls: string[] = [];
    let notifyTurnStarted: (() => void) | undefined;
    piManager.setExecutor({
      async *execute(_session, _event, options) {
        notifyTurnStarted?.();
        await new Promise<void>((resolvePromise) => {
          const signal = options?.abortSignal;
          if (!signal || signal.aborted) {
            resolvePromise();
            return;
          }
          signal.addEventListener('abort', () => resolvePromise(), { once: true });
        });
      },
      async cleanupSession(sessionId) { cleanupCalls.push(sessionId); },
    });

    const startTurn = async () => {
      const started = new Promise<void>((resolvePromise) => { notifyTurnStarted = resolvePromise; });
      const session = piManager.create({ agent: 'agent_test' });
      await piManager.sendEvent(session.id, {
        type: 'user.message', content: [{ type: 'text', text: 'run' }],
      });
      await started;
      notifyTurnStarted = undefined;
      return session;
    };

    const interrupted = await startTurn();
    await piManager.sendEvent(interrupted.id, { type: 'user.interrupt' });
    await waitFor(() => piManager.get(interrupted.id)?.status === 'paused');
    expect(cleanupCalls).not.toContain(interrupted.id);

    const stopped = await startTurn();
    await piManager.stop(stopped.id);
    expect(piManager.get(stopped.id)?.status).toBe('paused');
    expect(cleanupCalls).not.toContain(stopped.id);

    await piManager.delete(interrupted.id);
    expect(piManager.get(interrupted.id)).toBeNull();
    expect(cleanupCalls).toContain(interrupted.id);
    expect(piManager.getEventLogger().getEvents(interrupted.id)).toEqual([]);

    const shuttingDown = await startTurn();
    await piManager.shutdown();
    expect(piManager.get(shuttingDown.id)?.status).toBe('paused');
    expect(cleanupCalls).toContain(shuttingDown.id);
    db.close();
  });

  it('admits an always_ask agent and compiles the gate the launch must load', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-policy-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_ask',
      'ask-agent',
      JSON.stringify({
        name: 'ask-agent',
        model: 'gpt-4o',
        system: 'Ask before tools.',
        tools: [{
          type: 'agent_toolset_20260401',
          configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
        }],
      }),
    );
    const piManager = new SessionManager(db, undefined, 'pi');

    // Admission used to refuse this agent with `pi_always_ask_not_supported`,
    // because a launch without a gate would have run the tool with nobody asked.
    // The managed gate replaces that refusal: the session is created, and the
    // compiled plan names the tool whose calls must be decided before they run.
    const created = piManager.create({ agent: 'agent_ask' });
    expect(created.loopEngine).toBe('pi');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?').get('agent_ask'))
      .toEqual({ count: 1 });
    const definition = created.agentDefinition ?? JSON.parse(
      (db.prepare('SELECT definition FROM agents WHERE id = ?').get('agent_ask') as { definition: string }).definition,
    ) as AgentDefinition;
    expect(assertPiAgentCanExecute(definition).gate).toEqual(['bash']);

    // A persisted PI row created before the gate existed runs the same way: the
    // decision is asked for per call rather than refused when the event arrives.
    const legacy = new SessionManager(db).create({ agent: 'agent_ask' });
    db.prepare('UPDATE sessions SET loop_engine = ? WHERE id = ?').run('pi', legacy.id);
    let executorCalled = false;
    piManager.setExecutor({
      async *execute() { executorCalled = true; },
    });

    await piManager.sendEvent(legacy.id, {
      type: 'user.message', content: [{ type: 'text', text: 'run' }],
    });
    // The turn is queued on the session's execution chain, so the executor is
    // reached just after `sendEvent` acknowledges the event.
    await waitFor(() => executorCalled);
    expect(executorCalled).toBe(true);
    db.close();
  });

  it('enforces a denied or disabled native tool by exclusion, and admits a toolset that expects nothing to run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-tool-policy-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');

    // A denied native tool is enforced by exclusion now that the launch sends the
    // compiled flags, so the agent runs with that tool genuinely unavailable
    // instead of being refused outright.
    const enforcedByExclusion = [
      {
        label: 'named-never-allow',
        toolset: {
          type: 'agent_toolset_20260401',
          configs: [{ name: 'bash', permission_policy: { type: 'never_allow' } }],
        },
      },
      {
        label: 'named-disabled',
        toolset: {
          type: 'agent_toolset_20260401',
          configs: [{ name: 'bash', enabled: false }],
        },
      },
    ];

    for (const [index, restriction] of enforcedByExclusion.entries()) {
      const agentId = `agent_pi_restricted_${index}`;
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        agentId,
        restriction.label,
        JSON.stringify({
          name: restriction.label,
          model: 'gpt-4o',
          system: 'Do not bypass declared policies.',
          tools: [restriction.toolset],
        }),
      );

      expect(() => piManager.create({ agent: agentId })).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?').get(agentId))
        .toEqual({ count: 1 });
    }

    // A fully disabled MCP toolset is a different case: nothing is expected to run
    // through it and Pi has no MCP transport, so there is nothing to enforce and
    // the agent runs. The earlier blanket refusal of any `enabled: false` entry
    // was the over-broad rule this compiler replaced.
    const admitted = [
      {
        label: 'mcp-default-never-allow',
        toolset: {
          type: 'mcp_toolset',
          mcp_server_name: 'filesystem',
          default_config: { permission_policy: { type: 'never_allow' } },
        },
      },
      {
        label: 'mcp-default-disabled',
        toolset: {
          type: 'mcp_toolset',
          mcp_server_name: 'filesystem',
          default_config: { enabled: false },
        },
      },
    ];

    for (const [index, declaration] of admitted.entries()) {
      const agentId = `agent_pi_admitted_${index}`;
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        agentId,
        declaration.label,
        JSON.stringify({
          name: declaration.label,
          model: 'gpt-4o',
          system: 'Nothing runs through this toolset.',
          tools: [declaration.toolset],
        }),
      );

      expect(() => piManager.create({ agent: agentId })).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?').get(agentId))
        .toEqual({ count: 1 });
    }

    // An MCP toolset the agent could actually use is a different matter: Pi has no
    // MCP transport, so accepting it would promise a capability the engine lacks.
    // The code is the stable contract; the message names which declaration caused
    // the refusal, which is the part an operator needs.
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_pi_mcp_enabled',
      'mcp-enabled',
      JSON.stringify({
        name: 'mcp-enabled',
        model: 'gpt-4o',
        system: 'Use MCP.',
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'filesystem' }],
      }),
    );
    let refused: unknown;
    try {
      piManager.create({ agent: 'agent_pi_mcp_enabled' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PiToolPolicyUnsupportedError);
    expect((refused as PiToolPolicyUnsupportedError).code).toBe(PI_TOOL_POLICY_UNSUPPORTED_CODE);
    expect((refused as Error).message).toMatch(/no MCP transport/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?').get('agent_pi_mcp_enabled'))
      .toEqual({ count: 0 });
    db.close();
  });

  it('rejects unsupported Pi user events before persistence or executor scheduling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-event-policy-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');
    let executorCalled = false;
    piManager.setExecutor({
      async *execute() { executorCalled = true; },
    });

    const unsupportedEvents: Array<{ event: UserEvent; code: string }> = [
      // `user.tool_confirmation` used to be refused here. It now settles the gate
      // a Pi session raised, so a custom-tool result is the remaining inbound
      // event with no Pi transport behind it.
      {
        event: {
          type: 'user.custom_tool_result',
          custom_tool_use_id: 'tool_1',
          content: [{ type: 'text', text: 'result' }],
        },
        code: PI_USER_EVENT_UNSUPPORTED_CODE,
      },
      {
        event: {
          type: 'user.message',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }],
        },
        code: PI_MESSAGE_CONTENT_UNSUPPORTED_CODE,
      },
    ];

    for (const { event, code } of unsupportedEvents) {
      const session = piManager.create({ agent: 'agent_test' });
      await expect(piManager.sendEvent(session.id, event)).rejects.toMatchObject({ code });
      expect(piManager.getEventLogger().getEvents(session.id)).toEqual([]);
    }

    const session = piManager.create({ agent: 'agent_test' });
    await expect(piManager.sendEvent(session.id, { type: 'user.interrupt' })).resolves.toEqual({ accepted: true });
    expect(piManager.getEventLogger().getEvents(session.id).map((event) => event.type)).toEqual(['user.interrupt']);
    expect(executorCalled).toBe(false);
    db.close();
  });

  it('records a steer that never reached a live engine as refused, not delivered', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-steer-policy-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');
    let executorCalled = false;
    piManager.setExecutor({
      // No `steer`: this executor owns no live engine session.
      async *execute() { executorCalled = true; },
    });
    const session = piManager.create({ agent: 'agent_test' });

    // A steer is not a turn, so it never reaches `execute`. With nothing to deliver
    // to, the answer must say so — and the durable record must agree, because a
    // client that read back `delivered` would believe the engine was told
    // something it never heard. Nothing is buffered for a later turn either.
    await expect(piManager.sendEvent(session.id, {
      type: 'user.steer', input_id: 'steer_1', text: 'be brief',
    })).resolves.toMatchObject({
      accepted: false,
      steer: { inputId: 'steer_1', state: 'rejected' },
    });

    const events = piManager.getEventLogger().getEvents(session.id);
    expect(events.map((event) => event.type)).toEqual(['user.steer']);
    expect(events[0].metadata).toMatchObject({ input_id: 'steer_1', steer_state: 'rejected' });
    expect(executorCalled).toBe(false);
    db.close();
  });

  it('refuses a malformed steer instead of recording one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-steer-invalid-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');
    piManager.setExecutor({ async *execute() {} });
    const session = piManager.create({ agent: 'agent_test' });

    await expect(piManager.sendEvent(session.id, {
      type: 'user.steer', input_id: '', text: 'be brief',
    } as UserEvent)).rejects.toThrow('input_id must be a non-empty string');
    await expect(piManager.sendEvent(session.id, {
      type: 'user.steer', input_id: 'steer_1', text: '',
    } as UserEvent)).rejects.toThrow('text must be a non-empty string');
    await expect(piManager.sendEvent(session.id, {
      type: 'user.steer', input_id: 'steer_1', text: 'x', expected_turn_id: 7,
    } as unknown as UserEvent)).rejects.toThrow('expected_turn_id must be a string');

    // A steer the runtime cannot account for leaves nothing behind: no event, and
    // no turn queued for later.
    expect(piManager.getEventLogger().getEvents(session.id)).toEqual([]);
    db.close();
  });

  it('rejects Pi named non-local Environments before session or event persistence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-environment-policy-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    const piManager = new SessionManager(db, undefined, 'pi');

    for (const provider of ['docker', 'kubernetes', 'self_hosted']) {
      const environmentId = `env_pi_${provider}`;
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        environmentId,
        provider,
        JSON.stringify({ sandbox_provider: provider }),
      );

      let error: unknown;
      try {
        piManager.create({ agent: 'agent_test', environmentId });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: 'PiSandboxProviderUnsupportedError',
        code: PI_SANDBOX_UNSUPPORTED_CODE,
        message: PI_SANDBOX_UNSUPPORTED_MESSAGE,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE environment_id = ?').get(environmentId))
        .toEqual({ count: 0 });
    }

    // Persisted rows created before admission is enforced must also reject
    // before orphan repair, event append, or executor scheduling.
    const legacy = new SessionManager(db).create({ agent: 'agent_test', environmentId: 'env_pi_docker' });
    db.prepare('UPDATE sessions SET loop_engine = ? WHERE id = ?').run('pi', legacy.id);
    let executorCalled = false;
    piManager.setExecutor({
      async *execute() { executorCalled = true; },
    });

    await expect(piManager.sendEvent(legacy.id, {
      type: 'user.message', content: [{ type: 'text', text: 'run' }],
    })).rejects.toMatchObject({
      code: PI_SANDBOX_UNSUPPORTED_CODE,
      message: PI_SANDBOX_UNSUPPORTED_MESSAGE,
    });
    expect(executorCalled).toBe(false);
    expect(piManager.getEventLogger().getEvents(legacy.id)).toEqual([]);
    db.close();
  });

  it('rejects Pi settings and probe checks for sandboxes without a host work directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-sandbox-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const incompatible: RuntimeSettings = {
      ...piSettings,
      sandbox: { provider: 'docker', options: { timeout_seconds: 300 } },
    };
    let probed = false;

    const validation = validateRuntimeSettings(incompatible);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      path: 'sandbox.provider',
      code: 'incompatible_adapter',
    }));
    const result = await testRuntimeSettingsArea({
      db,
      dataDir: directory,
      area: 'loop_engine',
      config: incompatible,
      piProbe: async () => {
        probed = true;
        return { available: true, message: 'should not run' };
      },
    });

    expect(probed).toBe(false);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'pi_host_workdir',
      status: 'failed',
    }));
    db.close();
  });
});
