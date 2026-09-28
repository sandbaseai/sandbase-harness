/**
 * Canonical in-sandbox roots on the shipped local backend.
 *
 * A session's resources are addressed by the paths this runtime publishes to the
 * agent: a checkout under `/workspace`, and uploaded files, published outputs,
 * and spilled tool output under `/mnt/session`. A published path is a promise,
 * so on the backend a local user actually runs, the bytes have to be reachable
 * at exactly that spelling.
 *
 * These cases drive the real `LocalSandboxProvider` rather than a recording
 * double: the property under test *is* what this backend does with a canonical
 * path, and a double that accepts every string would assert nothing about it.
 * Every case writes through one entry point of the running runtime and reads the
 * bytes back at the canonical path, so a mapping that only worked in one
 * direction would fail here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { importAgentSeeds } from '@/core/agent/store.js';
import { ensureDefaultEnvironment } from '@/core/runtime/config-bootstrap.js';
import { createRuntimeSessionServices } from '@/core/runtime/session-runtime.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { ModelRegistry } from '@/model/registry.js';
import { createServer } from '@/api/server.js';
import {
  LOCAL_TOOL_RESULT_MAX_CHARS,
  spillToolOutput,
} from '@/core/session/tool-output-overflow.js';
import { SESSION_OUTPUT_ROOT } from '@/core/session/session-outputs.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';
import type { MaterializeResult } from '@/core/resources/github-materializer.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

const CMA_HEADERS = {
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't', supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any;
    },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

/**
 * A strategy that records the system prompt and, when a turn hook is set, acts
 * on the sandbox the way the agent's own file tools would.
 */
class HookedStrategy implements AgentStrategy {
  readonly name = 'hooked';
  readonly prompts: string[] = [];
  onTurn?: (sandbox: SandboxInstance) => Promise<void>;

  async *execute(context: StrategyContext) {
    this.prompts.push(context.systemPrompt);
    if (this.onTurn) await this.onTurn(context.sandbox);
  }
}

const SKILL_MARKDOWN = [
  '---',
  'name: code-review',
  'description: Reviews a change before it lands.',
  '---',
  '',
  'Read the diff, then say what would break.',
].join('\n');

describe('canonical in-sandbox roots on the local backend', () => {
  let db: Database;
  let tmpDir: string;
  let artifactStore: LocalArtifactStore;
  let strategy: HookedStrategy;
  let provider: LocalSandboxProvider;
  let app: ReturnType<typeof createServer>;
  let sessionManager: ReturnType<typeof createRuntimeSessionServices>['sessionManager'];

  function makeRuntime(options: {
    githubMaterializer?: (resource: any, sandbox: SandboxInstance) => Promise<MaterializeResult>;
  } = {}) {
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'default', provider: 'openai', model: 'gpt-4o', is_default: true });
    (modelRegistry as any).createModel = () => fakeModel();

    const sandboxRegistry = new SandboxProviderRegistry();
    sandboxRegistry.register(provider);

    const services = createRuntimeSessionServices({
      db,
      agents: [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }],
      modelRegistry,
      sandboxProvider: provider,
      sandboxRegistry,
      runtimeComposition: {
        resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300 }),
      },
      strategy,
      skills: [],
      artifactStore,
      dataDir: tmpDir,
      defaultMaxSteps: 5,
      githubMaterializer: options.githubMaterializer,
    });
    sessionManager = services.sessionManager;

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
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-local-canonical-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    ensureDefaultEnvironment(db);
    importAgentSeeds(db, [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }]);
    artifactStore = new LocalArtifactStore(join(tmpDir, 'artifacts'));
    strategy = new HookedStrategy();
    provider = new LocalSandboxProvider(tmpDir);
    makeRuntime();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The session's sandbox directory: the root the canonical paths map into. */
  function sandboxDir(sessionId: string): string {
    return join(tmpDir, 'sandbox', sessionId);
  }

  /** Provision a second handle on the same directory, to read back what ran. */
  function sandboxFor(sessionId: string): Promise<SandboxInstance> {
    return provider.provision(sessionId, { name: 'local', sandbox_provider: 'local' });
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function uploadFile(name: string, content: string) {
    const created = await post('/v1/files', { name, media_type: 'text/plain', content });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  async function startSession(body: Record<string, unknown>) {
    const created = await post('/v1/sessions', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.id as string;
    await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    });
    return sessionId;
  }

  /** Wait for the session to settle, then return the recorded `session.error` text. */
  async function waitForSettled(sessionId: string): Promise<string | undefined> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const status = sessionManager.get(sessionId)?.status;
      if (status === 'paused' || status === 'failed' || status === 'requires_action') {
        const events = sessionManager.getEventLogger().getEvents(sessionId);
        const error = [...events].reverse().find((event) => event.type === 'session.error');
        const text = (error?.content ?? []).map((block: any) => block.text).join(' ');
        return text || undefined;
      }
      if (Date.now() >= deadline) throw new Error(`session ${sessionId} did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Wait for a session-scoped file record to appear in the scoped listing. */
  async function waitForOutputFile(sessionId: string, name: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const res = await app.request(`/v1/files?scope_id=${sessionId}`, { headers: CMA_HEADERS });
      const body = (await res.json()) as any;
      expect(res.status, JSON.stringify(body)).toBe(200);
      const found = body.data.find((file: any) => file.name === name);
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`output ${name} was not published`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('writes an attached file to the canonical upload path and reads it back', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');

    const sessionId = await startSession({
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [{ type: 'file', file_id: fileId, mount_path: '/notes/input.txt' }],
    });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    // The bytes are on the host below the session sandbox, so `/mnt/session` is a
    // real directory rather than another name for the sandbox root.
    const onDisk = join(sandboxDir(sessionId), 'mnt', 'session', 'uploads', 'notes', 'input.txt');
    expect(readFileSync(onDisk, 'utf-8')).toBe('attached bytes');

    // And the published spelling is the one the sandbox reads back.
    const sandbox = await sandboxFor(sessionId);
    expect(await sandbox.readFile('/mnt/session/uploads/notes/input.txt')).toBe('attached bytes');
  });

  it('materializes a repository under the canonical workspace root and reads its skills back', async () => {
    makeRuntime({
      githubMaterializer: async (resource, sandbox) => {
        const mountPath = (resource as unknown as { mount_path: string }).mount_path;
        await sandbox.writeFile(`${mountPath}/.claude/skills/code-review/SKILL.md`, SKILL_MARKDOWN);
        return { ok: true, mountPath, skills: ['code-review'], cached: false };
      },
    });

    const sessionId = await startSession({
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [{
        type: 'github_repository',
        url: 'https://github.com/example/widget',
        authorization_token: 'ghp_probe_token',
        mount_path: '/workspace/widget',
      }],
    });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    const onDisk = join(sandboxDir(sessionId), 'workspace', 'widget', '.claude', 'skills', 'code-review', 'SKILL.md');
    expect(existsSync(onDisk)).toBe(true);

    // The skill text in the prompt was read back through the same sandbox at the
    // same canonical path, so the prompt cannot name a tree the agent cannot open.
    expect(strategy.prompts).toHaveLength(1);
    expect(strategy.prompts[0]).toContain('## Skill: code-review');
    expect(strategy.prompts[0]).toContain('Read the diff, then say what would break.');
  });

  it('publishes a file the agent writes under the canonical output root', async () => {
    strategy.onTurn = async (sandbox) => {
      await sandbox.writeFile(`${SESSION_OUTPUT_ROOT}/report.md`, '# Report\n');
    };

    const sessionId = await startSession({ agent: 'agent_assistant', environment_id: 'env_default' });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    expect(readFileSync(join(sandboxDir(sessionId), 'mnt', 'session', 'outputs', 'report.md'), 'utf-8'))
      .toBe('# Report\n');

    // Collected after the turn and published as a session-scoped file record.
    const report = await waitForOutputFile(sessionId, 'report.md');
    const content = await app.request(`/v1/files/${report.id}/content`, { headers: CMA_HEADERS });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('# Report\n');
  });

  it('reads back a spilled tool output at the canonical path it was given', async () => {
    const sandbox = await sandboxFor('sess_spill');
    const output = 'x'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1);

    const spilled = await spillToolOutput(output, { sessionId: 'sess_spill', sandbox });
    expect(spilled.file).toBeDefined();
    expect(spilled.file!.path.startsWith('/mnt/session/tool_outputs/')).toBe(true);

    // The model is told it can read this path, so the path has to be real.
    expect(await sandbox.readFile(spilled.file!.path)).toBe(output);
    expect(existsSync(join(
      sandboxDir('sess_spill'),
      'mnt',
      'session',
      'tool_outputs',
      spilled.file!.path.split('/').at(-1)!,
    ))).toBe(true);
  });
});
