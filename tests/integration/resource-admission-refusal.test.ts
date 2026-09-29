/**
 * A session whose backend cannot mount its resources is refused when it is created.
 *
 * `local` maps the canonical roots (`/mnt/session/uploads`, `/workspace`) into its
 * sandbox directory. `docker` refuses every absolute in-sandbox path, and
 * `kubernetes` resolves an absolute path inside its own `/workspace` and so refuses
 * the upload root. `self_hosted` is refused on a different ground: its worker maps
 * an absolute path into its own root, so the operator's process decides where the
 * bytes land and the runtime cannot hold it to the canonical roots — the last case
 * here records that measurement so the stated reason is evidence rather than an
 * assumption. A session that
 * declares a `file` or `github_repository` resource on one of those used to be
 * accepted with a `201` and then fail at provisioning, with a path error the
 * caller had no way to connect to the environment they chose.
 *
 * These cases drive the running runtime through the two creation entry points and
 * the route that attaches a resource to an existing session, assert the dedicated
 * code, and assert that a refused request left nothing behind — no session row, no
 * resource instance, no event. One case pins the other direction: the same
 * resources on `local` are still accepted and recorded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { importAgentSeeds } from '@/core/agent/store.js';
import { ensureDefaultEnvironment } from '@/core/runtime/config-bootstrap.js';
import { createRuntimeSessionServices } from '@/core/runtime/session-runtime.js';
import { executeWorkItem } from '@/cli/worker-commands.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { parseEnvironmentConfig, sandboxProviderForEnvironmentConfig } from '@/sandbox/provider-names.js';
import { ModelRegistry } from '@/model/registry.js';
import { createServer } from '@/api/server.js';
import { sandboxCapabilities, type EnvironmentConfig, type SandboxProvider, type SandboxProviderType } from '@/types/sandbox.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't', supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any;
    },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

/** Records that a turn ran; no case here needs a turn to run. */
class QuietStrategy implements AgentStrategy {
  readonly name = 'quiet';
  async *execute(_context: StrategyContext) {}
}

/** A backend that is recorded rather than run: no daemon and no cluster are involved. */
function recordingProvider(type: SandboxProviderType): SandboxProvider {
  return {
    type,
    capabilities: sandboxCapabilities(),
    async provision(sessionId: string) {
      return {
        sessionId,
        async execute() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
        async writeFile() {},
        async readFile() { return ''; },
        async listFiles() { return []; },
        async cleanup() {},
      };
    },
  };
}

const FILE_RESOURCE = { type: 'file', mount_path: '/notes/input.txt' };
const REPO_RESOURCE = {
  type: 'github_repository',
  url: 'https://github.com/example/widget',
  authorization_token: 'ghp_admission_token',
  mount_path: '/workspace/widget',
};

describe('resource admission against the session backend', () => {
  let db: Database;
  let tmpDir: string;
  let artifactStore: LocalArtifactStore;
  let app: ReturnType<typeof createServer>;
  /** What each Environment resolves to, so a case can pick the backend under test. */
  let environmentProviders: Record<string, SandboxProviderType>;

  function makeRuntime() {
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'default', provider: 'openai', model: 'gpt-4o', is_default: true });
    (modelRegistry as any).createModel = () => fakeModel();

    const sandboxRegistry = new SandboxProviderRegistry();
    sandboxRegistry.register(recordingProvider('local'));
    for (const type of ['docker', 'kubernetes', 'self_hosted'] as const) sandboxRegistry.register(recordingProvider(type));

    const environmentConfig = (environmentId: string): EnvironmentConfig => {
      const name = environmentProviders[environmentId];
      if (!name) {
        // An Environment this suite does not stub resolves the way production
        // does — from its stored config — so a case can exercise a row that no
        // longer resolves without standing up the whole settings overlay.
        const row = db.prepare('SELECT config FROM environments WHERE id = ?').get(environmentId) as
          | { config: string }
          | undefined;
        const context = `Environment ${environmentId}`;
        return {
          name: environmentId,
          sandbox_provider: sandboxProviderForEnvironmentConfig(
            parseEnvironmentConfig(row?.config ?? '{}', context),
            context,
          ),
          timeout: 300,
        };
      }
      return { name, sandbox_provider: name, timeout: 300 };
    };

    const services = createRuntimeSessionServices({
      db,
      agents: [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }],
      modelRegistry,
      sandboxProvider: recordingProvider('local'),
      sandboxRegistry,
      runtimeComposition: { resolveEnvironmentConfig: environmentConfig },
      strategy: new QuietStrategy(),
      skills: [],
      artifactStore,
      dataDir: tmpDir,
      defaultMaxSteps: 5,
    });

    app = createServer({
      db,
      sessionManager: services.sessionManager,
      agents: [{ id: 'agent_assistant', name: 'assistant', model: 'gpt-4o', instructions: 'You are helpful.' } as any],
      skills: [],
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      artifactStore: () => artifactStore,
      runtime: { models: [], sandboxProviders: ['local', 'docker', 'kubernetes', 'self_hosted'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-admission-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    ensureDefaultEnvironment(db);
    importAgentSeeds(db, [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }]);
    artifactStore = new LocalArtifactStore(join(tmpDir, 'artifacts'));
    environmentProviders = { env_default: 'local' };
    for (const type of ['docker', 'kubernetes', 'self_hosted'] as const) {
      const id = `env_${type}`;
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('${id}', '${type}', '{"sandbox_provider":"${type}","timeout":300}')`);
      environmentProviders[id] = type;
    }
    makeRuntime();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  function counts() {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      sessions: count('sessions'),
      instances: count('session_resource_instances'),
      events: count('events'),
    };
  }

  async function uploadFile(name: string, content: string) {
    const created = await post('/v1/files', { name, media_type: 'text/plain', content });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  async function createSession(environmentId: string, resources: unknown[]) {
    return post('/v1/sessions', { agent: 'agent_assistant', environment_id: environmentId, resources });
  }

  it('refuses POST /v1/sessions on a backend that cannot mount a file, and stores nothing', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const created = await createSession('env_docker', [{ ...FILE_RESOURCE, file_id: fileId }]);

    expect(created.status).toBe(400);
    expect(created.body.error.type).toBe('invalid_request_error');
    expect(created.body.error.code).toBe('resource_not_mountable');
    expect(created.body.error.message).toContain('docker');
    expect(created.body.error.message).toContain('file');
    // Nothing was created: the refusal precedes the insert, so there is no
    // session to clean up and no half-admitted mount to explain later.
    expect(counts()).toEqual({ sessions: 0, instances: 0, events: 0 });
  });

  it('refuses a repository resource the same way', async () => {
    const created = await createSession('env_docker', [REPO_RESOURCE]);
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('resource_not_mountable');
    expect(created.body.error.message).toContain('github_repository');
    expect(counts()).toEqual({ sessions: 0, instances: 0, events: 0 });
    // The caller's write-only token is not echoed back with the refusal.
    expect(JSON.stringify(created.body)).not.toContain('ghp_admission_token');
  });

  it('refuses the same resources on kubernetes and self_hosted', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');
    for (const environmentId of ['env_kubernetes', 'env_self_hosted']) {
      const created = await createSession(environmentId, [{ ...FILE_RESOURCE, file_id: fileId }]);
      expect(created.status, environmentId).toBe(400);
      expect(created.body.error.code, environmentId).toBe('resource_not_mountable');
    }
    expect(counts()).toEqual({ sessions: 0, instances: 0, events: 0 });
  });

  it('refuses POST /v1/runs before the session exists', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');
    // A run declares its session fields under `session`, which is where its
    // resources are read from.
    const run = await post('/v1/runs', {
      agent: 'agent_assistant',
      environment_id: 'env_docker',
      input: [{ type: 'text', text: 'go' }],
      session: { resources: [{ ...FILE_RESOURCE, file_id: fileId }] },
      response_mode: 'async',
    });

    expect(run.status, JSON.stringify(run.body)).toBe(400);
    expect(run.body.error.code).toBe('resource_not_mountable');
    expect(counts()).toEqual({ sessions: 0, instances: 0, events: 0 });
  });

  it('refuses a streaming run before the stream starts, not inside it', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const run = await post('/v1/runs', {
      agent: 'agent_assistant',
      environment_id: 'env_docker',
      input: [{ type: 'text', text: 'go' }],
      session: { resources: [{ ...FILE_RESOURCE, file_id: fileId }] },
      response_mode: 'sse',
    });

    // The refusal is a JSON error, not an SSE stream that opens and then fails:
    // the session is created before the response is committed, so the status is
    // still available to the caller.
    expect(run.status, JSON.stringify(run.body)).toBe(400);
    expect(run.body.error.code).toBe('resource_not_mountable');
    expect(counts()).toEqual({ sessions: 0, instances: 0, events: 0 });
  });

  it('refuses attaching a resource to an existing session on such a backend', async () => {
    // A session with no resources is admitted on docker: there is nothing to
    // mount yet, so nothing is refused yet.
    const created = await createSession('env_docker', []);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.id as string;
    expect(counts()).toEqual({ sessions: 1, instances: 0, events: 0 });

    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const attached = await post(`/v1/sessions/${sessionId}/resources`, {
      type: 'file',
      file_id: fileId,
      mount_path: '/notes/input.txt',
    });

    expect(attached.status).toBe(400);
    expect(attached.body.error.code).toBe('resource_not_mountable');
    // The instance was not recorded, so the session still holds no mount it
    // cannot serve.
    expect(counts()).toEqual({ sessions: 1, instances: 0, events: 0 });
  });

  it('still admits and records the same resources on the local backend', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const created = await createSession('env_default', [
      { ...FILE_RESOURCE, file_id: fileId },
      REPO_RESOURCE,
    ]);

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const listed = await app.request(`/v1/sessions/${created.body.id}/resources`);
    const body = (await listed.json()) as any;
    expect(body.data).toHaveLength(2);
    // The refusal is scoped to the backends that cannot serve the roots, not to
    // resources in general.
    expect(counts()).toEqual({ sessions: 1, instances: 2, events: 0 });
  });

  it('answers an Environment that stopped resolving with a code, not a bare 500', async () => {
    // Resolving the Environment is part of the decision, so it can fail on its
    // own: a stored config naming `cloud`, an unknown hosting type, or a damaged
    // row. Creation and the event routes answer that with 400 and its own code,
    // and the append route has to as well — it is mounted on its own and has no
    // shared error handler, so an unhandled throw would be a text/plain 500.
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_legacy', 'legacy', '{"sandbox_provider":"local"}')`);
    environmentProviders.env_legacy = 'local';
    const created = await createSession('env_legacy', []);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.id as string;

    // The Environment the session already points at becomes one this build
    // cannot read — what a legacy `hosting_type: "cloud"` row looks like — and
    // resolution falls back to the production reader of that row.
    db.exec(`UPDATE environments SET config = '{"hosting_type":"cloud"}' WHERE id = 'env_legacy'`);
    delete environmentProviders.env_legacy;

    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const attached = await post(`/v1/sessions/${sessionId}/resources`, {
      type: 'file',
      file_id: fileId,
      mount_path: '/notes/input.txt',
    });

    expect(attached.status, JSON.stringify(attached.body)).toBe(400);
    expect(attached.body.error.type).toBe('invalid_request_error');
    expect(attached.body.error.code).toBe('unsupported_hosting_type');
    // Nothing was recorded, so the refusal did not leave a resource the session
    // cannot mount.
    expect(counts()).toEqual({ sessions: 1, instances: 0, events: 0 });
  });

  it('records what the shipped self-hosted worker does with a canonical path', async () => {
    // The evidence behind the `self_hosted` half of the refusal. The worker does
    // not refuse `/mnt/session/uploads/...`; it maps an absolute path into its own
    // root, so where the bytes land is the operator's process to decide and the
    // runtime cannot verify or enforce the canonical root. That is why the
    // refusal is stated as "cannot be held to it" rather than "refuses the path".
    const workerRoot = mkdtempSync(join(tmpdir(), 'ma-worker-root-'));
    try {
      await executeWorkItem(
        { kind: 'write', payload: { path: '/mnt/session/uploads/probe.txt', content: 'worker bytes' } } as any,
        workerRoot,
      );
      // Mapped into the worker's own root, not written to the host's real
      // `/mnt/session/uploads`.
      expect(readFileSync(join(workerRoot, 'mnt', 'session', 'uploads', 'probe.txt'), 'utf8')).toBe('worker bytes');
      const readBack = await executeWorkItem(
        { kind: 'read', payload: { path: '/mnt/session/uploads/probe.txt' } } as any,
        workerRoot,
      );
      expect(readBack).toBe('worker bytes');
    } finally {
      rmSync(workerRoot, { recursive: true, force: true });
    }
  });
});
