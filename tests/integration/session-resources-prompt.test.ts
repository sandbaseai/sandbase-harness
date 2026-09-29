/**
 * The paths a session's resources are announced by.
 *
 * A mounted file or repository is only usable if the agent is told where it
 * landed. These cases drive the running runtime — a session created through the
 * API, a turn executed by the real executor and context builder — and assert the
 * system prompt the strategy received, then check the path the prompt names
 * against the sandbox the turn actually used, so the instructions cannot
 * describe a mount that is not there.
 *
 * The backend answer is deliberately routed through the session's Environment
 * rather than a global: one case edits the Environment after the sandbox is
 * bound and asserts the prompt still describes the backend that served it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { SESSION_RESOURCES_HEADING } from '@/core/session/session-resource-prompt.js';
import {
  sandboxCapabilities,
  type EnvironmentConfig,
  type SandboxInstance,
  type SandboxProvider,
  type SandboxProviderType,
} from '@/types/sandbox.js';
import type { MaterializeResult } from '@/core/resources/github-materializer.js';
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

/** Records the system prompt of every turn, and nothing else. */
class PromptStrategy implements AgentStrategy {
  readonly name = 'prompt-capture';
  readonly prompts: string[] = [];

  async *execute(context: StrategyContext) {
    this.prompts.push(context.systemPrompt);
  }
}

/** A container backend, recorded rather than run: no daemon is involved. */
function dockerStub(writes: string[]): SandboxProvider {
  return {
    type: 'docker',
    capabilities: sandboxCapabilities(),
    async provision(sessionId: string): Promise<SandboxInstance> {
      return {
        sessionId,
        async execute() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
        async writeFile(path: string) { writes.push(path); },
        async readFile() { return ''; },
        async listFiles() { return []; },
        async cleanup() {},
      };
    },
  };
}

const SKILL_MARKDOWN = [
  '---',
  'name: code-review',
  'description: Reviews a change before it lands.',
  '---',
  '',
  'Read the diff, then say what would break.',
].join('\n');

const REPOSITORY_URL = 'https://github.com/example/widget';
const REPOSITORY_TOKEN = 'ghp_probe_token';

describe('session resource paths in the system prompt', () => {
  let db: Database;
  let tmpDir: string;
  let artifactStore: LocalArtifactStore;
  let strategy: PromptStrategy;
  let app: ReturnType<typeof createServer>;
  let sessionManager: ReturnType<typeof createRuntimeSessionServices>['sessionManager'];
  let localProvider: LocalSandboxProvider;
  /** What each Environment resolves to, mutable so a case can edit one mid-session. */
  let environmentProviders: Record<string, SandboxProviderType>;

  function makeRuntime(options: {
    providers: SandboxProvider[];
    githubMaterializer?: (resource: any, sandbox: SandboxInstance) => Promise<MaterializeResult>;
  }) {
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'default', provider: 'openai', model: 'gpt-4o', is_default: true });
    (modelRegistry as any).createModel = () => fakeModel();

    const sandboxRegistry = new SandboxProviderRegistry();
    for (const provider of options.providers) sandboxRegistry.register(provider);

    const environmentConfig = (environmentId: string): EnvironmentConfig => {
      const name = environmentProviders[environmentId] ?? 'local';
      return { name, sandbox_provider: name, timeout: 300 };
    };

    const services = createRuntimeSessionServices({
      db,
      agents: [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }],
      modelRegistry,
      sandboxProvider: options.providers[0],
      sandboxRegistry,
      runtimeComposition: { resolveEnvironmentConfig: environmentConfig },
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
      runtime: { models: [], sandboxProviders: ['local', 'docker'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-prompt-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    ensureDefaultEnvironment(db);
    importAgentSeeds(db, [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }]);
    artifactStore = new LocalArtifactStore(join(tmpDir, 'artifacts'));
    strategy = new PromptStrategy();
    environmentProviders = { env_default: 'local' };
    localProvider = new LocalSandboxProvider(tmpDir);
    makeRuntime({ providers: [localProvider] });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** An Environment row naming a container backend, as `ensureDefaultEnvironment` writes one. */
  function addDockerEnvironment(id: string) {
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('${id}', 'docker', '{"sandbox_provider":"docker","timeout":300}')`);
    environmentProviders[id] = 'docker';
  }

  async function post(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await sendMessage(sessionId, 'go');
    return sessionId;
  }

  async function sendMessage(sessionId: string, text: string) {
    const sent = await post(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  }

  /** Wait for the session to settle, then return the recorded `session.error` text. */
  async function waitForSettled(sessionId: string): Promise<string | undefined> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const status = sessionManager.get(sessionId)?.status;
      if (status === 'paused' || status === 'failed' || status === 'requires_action') {
        const events = sessionManager.getEventLogger().getEvents(sessionId);
        const error = [...events].reverse().find((event) => event.type === 'session.error');
        return ((error?.content ?? []) as any[]).map((block) => block.text).join(' ') || undefined;
      }
      if (Date.now() >= deadline) throw new Error(`session ${sessionId} did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForPrompts(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (strategy.prompts.length < count) {
      if (Date.now() >= deadline) {
        throw new Error(`only ${strategy.prompts.length} prompt(s) after ${count} turn(s)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('announces a file and a repository in both spellings on the local backend', async () => {
    makeRuntime({
      providers: [localProvider],
      githubMaterializer: async (resource, sandbox) => {
        const mountPath = (resource as unknown as { mount_path: string }).mount_path;
        await sandbox.writeFile(`${mountPath}/.claude/skills/code-review/SKILL.md`, SKILL_MARKDOWN);
        return { ok: true, mountPath, skills: ['code-review'], cached: false };
      },
    });

    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const sessionId = await startSession({
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [
        { type: 'file', file_id: fileId, mount_path: '/notes/input.txt' },
        {
          type: 'github_repository',
          url: REPOSITORY_URL,
          authorization_token: REPOSITORY_TOKEN,
          mount_path: '/workspace/widget',
          checkout: { type: 'branch', name: 'main' },
        },
      ],
    });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    const prompt = strategy.prompts.at(-1)!;
    expect(prompt).toContain(SESSION_RESOURCES_HEADING);
    // The canonical path, which is what the runtime's file tools accept.
    expect(prompt).toContain('- File: `/mnt/session/uploads/notes/input.txt`');
    expect(prompt).toContain(
      `- Repository: \`${REPOSITORY_URL}\`, checkout: branch main, mounted at \`/workspace/widget\``,
    );
    // Plus the sandbox-relative spelling a command on this backend needs, since a
    // local command resolves an absolute path against the host filesystem.
    expect(prompt).toContain('(in a shell, use `mnt/session/uploads/notes/input.txt`)');
    expect(prompt).toContain('(in a shell, use `workspace/widget`)');

    // The credential the caller supplied does not reach the instructions.
    expect(prompt).not.toContain(REPOSITORY_TOKEN);

    // And the path the prompt names is the path the sandbox serves the bytes at.
    const sandbox = await localProvider.provision(sessionId, { name: 'local', sandbox_provider: 'local' });
    expect(await sandbox.readFile('/mnt/session/uploads/notes/input.txt')).toBe('attached bytes');
  });

  it('leaves the section out when the session declares no resource', async () => {
    const sessionId = await startSession({ agent: 'agent_assistant', environment_id: 'env_default' });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    expect(strategy.prompts).toHaveLength(1);
    expect(strategy.prompts[0]).not.toContain(SESSION_RESOURCES_HEADING);
  });

  it('refuses to build the section at all for a session its backend cannot serve', async () => {
    // A backend that cannot reach the canonical root no longer produces a
    // misleading announcement — naming a path the mount will never reach — because
    // the session is refused before a turn, and therefore before any prompt,
    // exists. The rendering rule this case used to cover (canonical spelling only,
    // no shell spelling) is pinned where it is reachable, in
    // `tests/unit/session-resource-prompt.test.ts`; the admission decision, the
    // status, and the code are pinned in
    // `tests/integration/resource-admission-refusal.test.ts`.
    const writes: string[] = [];
    addDockerEnvironment('env_docker');
    makeRuntime({ providers: [localProvider, dockerStub(writes)] });

    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const refused = await post('/v1/sessions', {
      agent: 'agent_assistant',
      environment_id: 'env_docker',
      resources: [{ type: 'file', file_id: fileId, mount_path: '/notes/input.txt' }],
    });

    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    expect(refused.body.error.code).toBe('resource_not_mountable');
    // No turn was queued and no sandbox was asked to write anything, so nothing
    // reached the instruction boundary.
    expect(strategy.prompts).toEqual([]);
    expect(writes).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_resource_instances').get() as { n: number }).n).toBe(0);
  });

  it('keeps describing the backend the sandbox was provisioned on after its Environment changes', async () => {
    const dockerWrites: string[] = [];
    makeRuntime({ providers: [localProvider, dockerStub(dockerWrites)] });

    const fileId = await uploadFile('notes.txt', 'attached bytes');
    const sessionId = await startSession({
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [{ type: 'file', file_id: fileId, mount_path: '/notes/input.txt' }],
    });
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();
    expect(strategy.prompts.at(-1)).toContain('(in a shell, use `mnt/session/uploads/notes/input.txt`)');

    // The Environment is edited after the sandbox is bound. The session keeps
    // running on the sandbox it already has, so its instructions must keep
    // naming the spelling that sandbox reaches — re-resolving the Environment
    // here would describe a backend that is not serving this session.
    environmentProviders.env_default = 'docker';
    await sendMessage(sessionId, 'again');
    await waitForPrompts(2);
    expect(await waitForSettled(sessionId), 'the turn failed').toBeUndefined();

    expect(strategy.prompts.at(-1)).toContain('(in a shell, use `mnt/session/uploads/notes/input.txt`)');
    expect(dockerWrites).toEqual([]);
  });
});
