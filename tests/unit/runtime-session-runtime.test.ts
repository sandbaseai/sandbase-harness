import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { importAgentSeeds } from '@/core/agent/store.js';
import { ensureDefaultEnvironment } from '@/core/runtime/config-bootstrap.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { bootstrapRuntimeSandboxes } from '@/core/runtime/sandbox-bootstrap.js';
import { createRuntimeSessionServices } from '@/core/runtime/session-runtime.js';
import { getOrSeedRuntimeSettings, saveRuntimeSettings } from '@/core/settings/store.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { ModelRegistry } from '@/model/registry.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { EventLogger } from '@/core/session/event-logger.js';
import {
  PI_SANDBOX_UNSUPPORTED_CODE,
  PI_SANDBOX_UNSUPPORTED_MESSAGE,
} from '@/core/session/pi-policy.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { Session } from '@/types/session.js';

describe('runtime session services', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function makeRuntime(agentOverrides: Record<string, unknown> = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'ma-session-runtime-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    ensureDefaultEnvironment(db);
    const agents = [{
      name: 'assistant',
      model: 'gpt-4o',
      system: 'You are helpful.',
      ...agentOverrides,
    }];
    importAgentSeeds(db, agents);
    const sandboxes = bootstrapRuntimeSandboxes({
      db,
      dataDir: directory,
      dockerAvailable: () => false,
    });
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({
      name: 'default',
      provider: 'openai',
      model: 'gpt-4o',
      is_default: true,
    });
    return { db, directory, agents, sandboxes, modelRegistry };
  }

  it('wires the session manager, executor, snapshots, and crash recovery', () => {
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('sess_running', 'agent_assistant', 'assistant', 'env_default', 'running', '{}');

    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          timeout: 300,
        }),
      },
      strategy: new DefaultStrategy(),
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });

    expect(services.reconciled).toBe(1);
    expect(services.executor).toBeDefined();
    expect(services.snapshots).toBeDefined();
    expect(services.sessionManager.get('sess_running')?.status).toBe('paused');
    db.close();
  });

  it('stores snapshots underneath the configured artifact store', () => {
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    const artifactRoot = join(directory, 'configured-artifacts');
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          timeout: 300,
        }),
      },
      strategy: new DefaultStrategy(),
      skills: [],
      artifactStore: new LocalArtifactStore(artifactRoot),
      defaultMaxSteps: 25,
    });
    db.prepare(`
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('sess_snapshot_root', 'agent_assistant', 'assistant', 'env_default', 'running', '{}');
    const workDir = join(directory, 'workdir');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'hello.txt'), 'hello snapshot');

    const snapshot = services.snapshots.create('sess_snapshot_root', workDir);

    expect(snapshot.path.startsWith(join(artifactRoot, 'snapshots'))).toBe(true);
    expect(existsSync(snapshot.path)).toBe(true);
    db.close();
  });

  it('passes agent max_turns before workspace default max steps', async () => {
    const captured: number[] = [];
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime({ max_turns: 7 });
    const strategy: AgentStrategy = {
      name: 'capture',
      async *execute(context: StrategyContext) {
        captured.push(context.config.maxSteps ?? 0);
      },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          timeout: 300,
        }),
      },
      strategy,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 42,
    });
    const session: Session = {
      id: 'sess_max_turns',
      agentId: 'agent_assistant',
      agentName: 'assistant',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    for await (const _event of services.executor.execute(session, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hello' }],
    })) {
      // no-op
    }

    expect(captured).toEqual([7]);
    db.close();
  });

  it('uses workspace default max steps when agent max_turns is absent', async () => {
    const captured: number[] = [];
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    const strategy: AgentStrategy = {
      name: 'capture',
      async *execute(context: StrategyContext) {
        captured.push(context.config.maxSteps ?? 0);
      },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          timeout: 300,
        }),
      },
      strategy,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 42,
    });
    const session: Session = {
      id: 'sess_default_steps',
      agentId: 'agent_assistant',
      agentName: 'assistant',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    for await (const _event of services.executor.execute(session, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hello' }],
    })) {
      // no-op
    }

    expect(captured).toEqual([42]);
    db.close();
  });

  it('resolves a strategy from each session engine without changing builtin routing', async () => {
    const calls: string[] = [];
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    const builtin: AgentStrategy = {
      name: 'builtin-capture',
      async *execute() { calls.push('builtin'); },
    };
    const pi: AgentStrategy = {
      name: 'pi-capture',
      async *execute() { calls.push('pi'); },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300 }),
      },
      strategy: builtin,
      resolveStrategy: (engine) => engine === 'pi' ? pi : builtin,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });
    const turn = { type: 'user.message' as const, content: [{ type: 'text' as const, text: 'hello' }] };

    for await (const _event of services.executor.execute({
      id: 'sess_frozen_pi', agentId: 'agent_assistant', agentName: 'assistant', environmentId: 'env_default',
      loopEngine: 'pi', status: 'running', createdAt: new Date(), updatedAt: new Date(),
    }, turn)) {
      // no-op
    }
    for await (const _event of services.executor.execute({
      id: 'sess_builtin', agentId: 'agent_assistant', agentName: 'assistant', environmentId: 'env_default',
      loopEngine: 'builtin', status: 'running', createdAt: new Date(), updatedAt: new Date(),
    }, turn)) {
      // no-op
    }

    expect(calls).toEqual(['pi', 'builtin']);
    db.close();
  });

  it('passes selected PI model config without constructing an AI SDK model', async () => {
    const captured: Array<{ model?: unknown; modelConfig?: unknown }> = [];
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime({ model: 'openai/gpt-pi-selected' });
    const builtin = new DefaultStrategy();
    const pi: AgentStrategy = {
      name: 'pi-capture',
      requiresModel: false,
      async *execute(context: StrategyContext) {
        captured.push({ model: context.model, modelConfig: context.modelConfig });
      },
    };
    const createModel = vi.spyOn(modelRegistry, 'createModel').mockImplementation(() => {
      throw new Error('Pi must not construct an AI SDK model');
    });
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300 }),
      },
      strategy: builtin,
      resolveStrategy: (engine) => engine === 'pi' ? pi : builtin,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });

    for await (const _event of services.executor.execute({
      id: 'sess_pi_model', agentId: 'agent_assistant', agentName: 'assistant', environmentId: 'env_default',
      loopEngine: 'pi', status: 'running', createdAt: new Date(), updatedAt: new Date(),
    }, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] })) {
      // no-op
    }

    expect(createModel).not.toHaveBeenCalled();
    expect(captured).toEqual([{
      model: undefined,
      modelConfig: expect.objectContaining({ provider: 'openai', model: 'gpt-pi-selected' }),
    }]);
    db.close();
  });

  it('hands a Pi tool confirmation to the Pi strategy instead of the builtin ToolResolver', async () => {
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    const builtin = new DefaultStrategy();
    const received: unknown[] = [];
    const pi: AgentStrategy = {
      name: 'pi-capture',
      requiresModel: false,
      async *execute(context: StrategyContext) {
        received.push(context.userEvent);
      },
    };
    const resolveModelConfig = vi.spyOn(modelRegistry, 'resolveModelConfig');
    const createModel = vi.spyOn(modelRegistry, 'createModel');
    const provision = vi.spyOn(sandboxes.sandboxProvider, 'provision');
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300 }),
      },
      strategy: builtin,
      resolveStrategy: (engine) => engine === 'pi' ? pi : builtin,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });
    const session: Session = {
      id: 'sess_pi_direct_confirmation',
      agentId: 'agent_assistant',
      agentName: 'assistant',
      environmentId: 'env_default',
      loopEngine: 'pi',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    for await (const _event of services.executor.execute(session, {
      type: 'user.tool_confirmation', tool_use_id: 'call_1', result: 'allow',
    })) {
      // no-op
    }

    // `user.tool_confirmation` used to be refused for Pi at admission, because the
    // runtime had no bridge to answer a Pi gate. The Pi session resolves its own
    // gate now, so the event reaches the Pi strategy and never the builtin
    // `ToolResolver`, which would run the call in the Harness sandbox while Pi
    // stayed blocked on a decision it never received.
    expect(createModel).not.toHaveBeenCalled();
    expect(resolveModelConfig).toHaveBeenCalled();
    expect(provision).toHaveBeenCalled();
    expect(received).toEqual([{ type: 'user.tool_confirmation', tool_use_id: 'call_1', result: 'allow' }]);
    db.close();
  });

  it('rejects a Pi-pinned default session before event persistence after a settings restart selects Docker', async () => {
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime();
    const localRuntimeComposition = {
      resolveEnvironmentConfig: () => ({ name: 'default', sandbox_provider: 'local', timeout: 300 }),
    };
    const initialServices = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: localRuntimeComposition,
      strategy: new DefaultStrategy(),
      loopEngine: 'pi',
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });
    const existingPiSession = initialServices.sessionManager.create({ agent: 'agent_assistant' });

    // A runtime restart after Settings V2 changes the effective env_default
    // sandbox. The persisted session stays Pi-pinned even though new sessions
    // would use the newly selected default engine.
    const servicesAfterSettingsRestart = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'default', sandbox_provider: 'docker', timeout: 300 }),
      },
      strategy: new DefaultStrategy(),
      loopEngine: 'builtin',
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });

    await expect(servicesAfterSettingsRestart.sessionManager.sendEvent(existingPiSession.id, {
      type: 'user.message', content: [{ type: 'text', text: 'run' }],
    })).rejects.toMatchObject({
      code: PI_SANDBOX_UNSUPPORTED_CODE,
      message: PI_SANDBOX_UNSUPPORTED_MESSAGE,
    });
    expect(servicesAfterSettingsRestart.sessionManager.getEventLogger().getEvents(existingPiSession.id)).toEqual([]);
    db.close();
  });

  it('rejects direct Pi execution for non-local Environments before provisioning or child launch', async () => {
    const { db, agents, modelRegistry } = makeRuntime();
    let provisioned = false;
    let launched = false;
    const dockerProvider: SandboxProvider = {
      type: 'docker',
      capabilities: sandboxCapabilities({ isolatedExecution: true }),
      async provision() {
        provisioned = true;
        throw new Error('sandbox provisioning must not run');
      },
    };
    const pi: AgentStrategy = {
      name: 'pi-capture',
      requiresModel: false,
      async *execute() { launched = true; },
    };
    const executor = new DefaultSessionExecutor({
      agents,
      modelRegistry,
      sandboxProvider: dockerProvider,
      resolveEnvironmentConfig: () => ({
        name: 'named-docker',
        sandbox_provider: 'docker',
        timeout: 300,
      }),
      strategy: new DefaultStrategy(),
      resolveStrategy: (engine) => engine === 'pi' ? pi : new DefaultStrategy(),
      eventLogger: new EventLogger(db),
    });

    const execute = async () => {
      for await (const _event of executor.execute({
        id: 'sess_pi_docker', agentId: 'agent_assistant', agentName: 'assistant', environmentId: 'env_pi_docker',
        loopEngine: 'pi', status: 'running', createdAt: new Date(), updatedAt: new Date(),
      }, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] })) {
        // no-op
      }
    };

    await expect(execute()).rejects.toMatchObject({
      code: PI_SANDBOX_UNSUPPORTED_CODE,
      message: PI_SANDBOX_UNSUPPORTED_MESSAGE,
    });
    expect(provisioned).toBe(false);
    expect(launched).toBe(false);
    db.close();
  });

  it('runs an always_ask Pi turn instead of refusing it before strategy execution', async () => {
    const { db, directory, agents, sandboxes, modelRegistry } = makeRuntime({
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
      }],
    });
    let launched = false;
    const pi: AgentStrategy = {
      name: 'pi-capture',
      requiresModel: false,
      async *execute() { launched = true; },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300 }),
      },
      strategy: new DefaultStrategy(),
      resolveStrategy: (engine) => engine === 'pi' ? pi : new DefaultStrategy(),
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
    });

    for await (const _event of services.executor.execute({
      id: 'sess_pi_always_ask', agentId: 'agent_assistant', agentName: 'assistant', environmentId: 'env_default',
      loopEngine: 'pi', status: 'running', createdAt: new Date(), updatedAt: new Date(),
    }, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] })) {
      // no-op
    }

    // This turn used to be refused with `pi_always_ask_not_supported` before the
    // strategy ran. The managed gate replaces the refusal: the turn executes, and
    // the gated tool is decided when it is called rather than never exposed.
    expect(launched).toBe(true);
    db.close();
  });

  it('injects Settings V2 sqlite memory through runtime session services', async () => {
    const capturedPrompts: string[] = [];
    const { db, directory, agents, sandboxes } = makeRuntime();
    const initial = getOrSeedRuntimeSettings(db, {}, directory);
    const saved = saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      memory: { enabled: true, provider: 'sqlite', options: {} },
    }, initial.revision, directory);
    expect(saved.ok).toBe(true);
    const modelRegistry = new ModelRegistry();
    const runtime = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry,
      settingsSeed: { memoryEnabled: false },
    });
    expect(runtime.memory?.name).toBe('sqlite');
    await runtime.memory!.add('ctx_settings_memory', 'I prefer Rust for systems work', { source: 'test' });
    const strategy: AgentStrategy = {
      name: 'capture-memory',
      async *execute(context: StrategyContext) {
        capturedPrompts.push(context.systemPrompt);
      },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: sandboxes.sandboxProvider,
      sandboxRegistry: sandboxes.sandboxRegistry,
      runtimeComposition: runtime,
      strategy,
      skills: [],
      memory: runtime.memory,
      artifactStore: runtime.artifactStore,
      defaultMaxSteps: 25,
    });
    const session: Session = {
      id: 'sess_settings_memory',
      agentId: 'agent_assistant',
      agentName: 'assistant',
      environmentId: 'env_default',
      contextId: 'ctx_settings_memory',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    for await (const _event of services.executor.execute(session, {
      type: 'user.message',
      content: [{ type: 'text', text: 'What should I use for Rust systems work?' }],
    })) {
      // no-op
    }

    expect(capturedPrompts.at(-1)).toContain('Relevant Memory');
    expect(capturedPrompts.at(-1)).toContain('prefer Rust');
    db.close();
  });

  it('resolves the session vault for a turn so its sandbox command receives it', async () => {
    const SECRET = 'runtime-vault-demo-secret';
    const { db, directory, agents, modelRegistry } = makeRuntime({
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'bash', enabled: true }],
      }],
    });
    db.prepare(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_runtime', 'runtime vault')`).run();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sess_vault', 'agent_assistant', 'assistant', 'env_default', 'running', JSON.stringify(['vlt_runtime']), '{}');
    const encrypted = encryptSecret(SECRET, directory);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, variable_name, value_hint, network,
        injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
      ) VALUES ('crd_runtime', 'vlt_runtime', 'runtime token', 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(
      JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
      encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now,
    );

    // A provider that reports the environment it was handed rather than running a
    // shell, so the assertion does not depend on the host's expansion semantics.
    // The sandbox owns an egress boundary, so the credential arrives as a
    // placeholder — the boundary's substitution table is what carries the value.
    let commandEnv: Record<string, string> | undefined;
    const registered: Array<{ placeholder: string; value: string }> = [];
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() {
        return {
          sessionId: 'sess_vault',
          async execute(_command: string, options?: { env?: Record<string, string> }) {
            commandEnv = options?.env;
            return {
              exitCode: 0,
              stdout: `TOKEN=${commandEnv?.TOKEN ?? ''}`,
              stderr: '',
              timedOut: false,
            };
          },
          configureEgressSubstitutions(substitutions: ReadonlyArray<{ placeholder: string; value: string }>) {
            registered.push(...substitutions.map((s) => ({ ...s })));
          },
          async writeFile() {},
          async readFile() { return ''; },
          async listFiles() { return []; },
          async cleanup() {},
        } as unknown as SandboxInstance;
      },
    };
    const registry = new SandboxProviderRegistry();
    registry.register(provider);

    let observed = '';
    const strategy: AgentStrategy = {
      name: 'credential-probe',
      async *execute(context: StrategyContext) {
        observed = await context.tools.bash.execute!({ command: 'echo $TOKEN' }) as string;
      },
    };
    const services = createRuntimeSessionServices({
      db,
      agents,
      modelRegistry,
      sandboxProvider: provider,
      sandboxRegistry: registry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          timeout: 300,
        }),
      },
      strategy,
      skills: [],
      artifactStore: new LocalArtifactStore(join(directory, 'artifacts')),
      defaultMaxSteps: 25,
      resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db, sessionId, {
        dataDir: directory,
        ...target,
      }),
    });
    const session: Session = {
      id: 'sess_vault',
      agentId: 'agent_assistant',
      agentName: 'assistant',
      environmentId: 'env_default',
      vaultIds: ['vlt_runtime'],
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    for await (const _event of services.executor.execute(session, {
      type: 'user.message',
      content: [{ type: 'text', text: 'run it' }],
    })) {
      // no-op
    }

    // The session's vault reached the command environment as a placeholder…
    expect(commandEnv).toEqual({ TOKEN: '__cred_crd_runtime__' });
    // …the boundary was registered to substitute the real value on the wire…
    expect(registered).toEqual([{ placeholder: '__cred_crd_runtime__', value: SECRET, allowedHosts: null }]);
    // …and the token the strategy sees back is scrubbed rather than carried through.
    expect(observed).toBe('TOKEN=[REDACTED]');
    db.close();
  });
});
