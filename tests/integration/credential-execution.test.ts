/**
 * Integration test: a session's vault credentials reach its sandbox commands.
 *
 * Two materialization shapes, both through `DefaultSessionExecutor`:
 *
 * - a sandbox that owns an egress boundary receives placeholders (`__cred_<id>__`)
 *   while the boundary is handed the real values for on-the-wire substitution;
 * - a boundary-less sandbox has its environment credentials refused — the
 *   published contract does not support `environment_variable` where nothing
 *   substitutes them, and plaintext would expose the secret to the process.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { ModelRegistry } from '@/model/registry.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { Session } from '@/types/session.js';

const SECRET = 'executor-demo-secret';

describe('credential execution wiring', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses the environment credential on a backend with no egress boundary', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-execution-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'credential-agent', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_exec', 'execution vault')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_exec', 'agent_test', 'credential-agent', 'env_test', 'running', '["vlt_exec"]')`);
    const encrypted = encryptSecret(SECRET, tmpDir);
    db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, variable_name, value_hint, network,
        injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(
      'crd_exec', 'vlt_exec', 'token', JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
      encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), new Date().toISOString(),
    );

    let executeOptions: Record<string, unknown> | undefined;
    let observedOutput = '';
    const sandbox: SandboxInstance = {
      sessionId: 'sess_exec',
      async execute(_command, options) {
        executeOptions = options as Record<string, unknown>;
        const env = (options as { env?: Record<string, string> } | undefined)?.env ?? {};
        return { exitCode: 0, stdout: `TOKEN=${env.TOKEN ?? ''}`, stderr: '', timedOut: false };
      },
      async writeFile() {},
      async readFile() { return ''; },
      async listFiles() { return []; },
      async cleanup() {},
    };
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() { return sandbox; },
    };
    const agent: AgentDefinition = {
      name: 'credential-agent', model: 'm', system: 'test',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'bash', enabled: true }],
      }],
    };
    const strategy: AgentStrategy = {
      name: 'credential-test',
      requiresModel: false,
      async *execute(context) {
        observedOutput = await context.tools.bash.execute!({ command: 'echo $TOKEN' }) as string;
        context.eventLog.append(context.session.id, {
          type: 'agent.tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tool_exec', content: observedOutput }],
        });
      },
    };

    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'm', provider: 'openai', model: 'm', is_default: true });
    const executor = new DefaultSessionExecutor({
      agents: [agent],
      modelRegistry,
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' }),
      strategy,
      eventLogger: new EventLogger(db),
      resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db!, sessionId, {
        dataDir: tmpDir,
        ...target,
      }),
    });
    const session: Session = {
      id: 'sess_exec', agentId: 'agent_test', agentName: agent.name, agentDefinition: agent,
      environmentId: 'env_test', status: 'running', vaultIds: ['vlt_exec'],
      createdAt: new Date(), updatedAt: new Date(),
    };

    for await (const _event of executor.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'run it' }] })) {
      // drain
    }

    // The credential is refused on this boundary-less sandbox rather than
    // materialized as plaintext, so the command environment carries nothing
    // and the denial — not an injection — reaches the audit trail.
    expect((executeOptions?.env as Record<string, string> | undefined)?.TOKEN).toBeUndefined();
    expect(JSON.stringify(executeOptions ?? {})).not.toContain(SECRET);
    const denied = db.prepare(
      "SELECT action, metadata FROM credential_audit_events WHERE credential_id = 'crd_exec'",
    ).all() as Array<{ action: string; metadata: string }>;
    expect(denied.map((row) => row.action)).toEqual(['runtime_denied']);
    expect(JSON.parse(denied[0]?.metadata ?? '{}').reason).toBe('backend_unsupported');
    const events = new EventLogger(db).getEvents(session.id);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await executor.cleanupSession(session.id);
  });

  it('hands a sandbox with an egress boundary a placeholder, and the boundary the real value', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-placeholder-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'credential-agent', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_exec', 'execution vault')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_exec', 'agent_test', 'credential-agent', 'env_test', 'running', '["vlt_exec"]')`);
    const encrypted = encryptSecret(SECRET, tmpDir);
    db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, variable_name, value_hint, network,
        injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(
      'crd_exec', 'vlt_exec', 'token', JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
      encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), new Date().toISOString(),
    );

    let executeOptions: Record<string, unknown> | undefined;
    const registered: Array<{ placeholder: string; value: string; allowedHosts?: readonly string[] | null }> = [];
    const sandbox: SandboxInstance = {
      sessionId: 'sess_exec',
      async execute(_command, options) {
        executeOptions = options as Record<string, unknown>;
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
      async writeFile() {},
      async readFile() { return ''; },
      async listFiles() { return []; },
      configureEgressSubstitutions(substitutions) { registered.push(...substitutions.map((s) => ({ ...s }))); },
      async cleanup() {},
    };
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() { return sandbox; },
    };
    const agent: AgentDefinition = {
      name: 'credential-agent', model: 'm', system: 'test',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'bash', enabled: true }],
      }],
    };
    const strategy: AgentStrategy = {
      name: 'credential-test',
      requiresModel: false,
      async *execute(context) {
        await context.tools.bash.execute!({ command: 'env' });
      },
    };
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'm', provider: 'openai', model: 'm', is_default: true });
    const executor = new DefaultSessionExecutor({
      agents: [agent],
      modelRegistry,
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' }),
      strategy,
      eventLogger: new EventLogger(db),
      resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db!, sessionId, {
        dataDir: tmpDir,
        ...target,
      }),
    });
    const session: Session = {
      id: 'sess_exec', agentId: 'agent_test', agentName: agent.name, agentDefinition: agent,
      environmentId: 'env_test', status: 'running', vaultIds: ['vlt_exec'],
      createdAt: new Date(), updatedAt: new Date(),
    };

    for await (const _event of executor.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'run it' }] })) {
      // drain
    }

    // The process environment holds a token, never the secret; the session's
    // egress boundary is what can materialize it.
    expect(executeOptions).toEqual({ env: { TOKEN: '__cred_crd_exec__' } });
    expect(registered).toEqual([{ placeholder: '__cred_crd_exec__', value: SECRET, allowedHosts: null }]);
    await executor.cleanupSession(session.id);
  });
});
