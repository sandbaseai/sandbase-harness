/**
 * Runtime wiring for session resources: a started runtime materializes what a
 * session declared.
 *
 * `SandboxLifecycle` has always been able to mount a file or a repository — it
 * takes a `fileArtifactReader` and a `githubMaterializer` — but nothing in
 * `src/` supplied either one, so `createRuntimeSessionServices` returned a
 * runtime whose first provisioning pass threw
 * `File session resources require an artifact reader` or
 * `GitHub repository session resources require a repository materializer`. A
 * session was accepted with a 201 and then failed its first turn.
 *
 * These cases drive the *composition root* rather than hand-built lifecycle
 * dependencies, because the missing wiring lived exactly there: the reader and
 * the materializer are the defaults `createRuntimeSessionServices` builds, and
 * every assertion below fails if that defaulting is removed.
 *
 * Two layers are covered on purpose. The HTTP layer is the caller's view
 * (`/v1/sessions` and `/v1/runs`), and it is where a declared resource has to
 * work. The direct `SessionManager.create` cases reach failures the routes
 * refuse earlier — a `file_id` with no row, a `github_repository` URL outside
 * the published grammar — which is the only way to observe that the default
 * reader and the default materializer are the things being reached.
 *
 * The sandboxes here are recording doubles rather than `LocalSandboxProvider`:
 * these cases are about which dependency the composition root reaches, and a
 * double records that directly. That the local backend really materializes at
 * the canonical in-sandbox roots is a property of the backend, covered against
 * the real provider in `tests/integration/local-canonical-roots.test.ts`. The
 * container backends still refuse those roots, which is pinned by the last two
 * cases and is why the two capability entries stay `partial` after the wiring
 * lands.
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
import { dockerWorkspacePath } from '@/sandbox/docker-provider.js';
import { resolveWorkspacePath } from '@/sandbox/kubernetes-provider.js';
import { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { ModelRegistry } from '@/model/registry.js';
import { createServer } from '@/api/server.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { MaterializeResult } from '@/core/resources/github-materializer.js';
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

/** Records every write so a mount can be asserted at its canonical path. */
class RecordingSandbox implements SandboxInstance {
  readonly writes: Array<{ path: string; content: string }> = [];
  readonly reads: string[] = [];
  private readonly files = new Map<string, string>();

  constructor(readonly sessionId: string) {}

  async execute() {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }

  async writeFile(path: string, content: string | Buffer) {
    const text = content.toString();
    this.writes.push({ path, content: text });
    this.files.set(path, text);
  }

  async readFile(path: string) {
    this.reads.push(path);
    return this.files.get(path) ?? '';
  }

  async listFiles() {
    return [];
  }

  async cleanup() {}
}

class PromptCaptureStrategy implements AgentStrategy {
  readonly name = 'prompt-capture';
  readonly prompts: string[] = [];

  // eslint-disable-next-line require-yield
  async *execute(context: StrategyContext) {
    this.prompts.push(context.systemPrompt);
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

describe('session resource wiring at the composition root', () => {
  let db: Database;
  let tmpDir: string;
  let artifactStore: LocalArtifactStore;
  let strategy: PromptCaptureStrategy;
  let sandboxes: Map<string, RecordingSandbox>;
  let sandboxProvider: SandboxProvider;
  let app: ReturnType<typeof createServer>;
  let sessionManager: ReturnType<typeof createRuntimeSessionServices>['sessionManager'];

  function makeRuntime(options: {
    provider?: SandboxProvider;
    githubMaterializer?: (resource: any, sandbox: SandboxInstance) => Promise<MaterializeResult>;
  } = {}) {
    sandboxes = new Map();
    const provider = options.provider ?? {
      type: 'local' as const,
      capabilities: sandboxCapabilities(),
      async provision(sessionId: string) {
        const sandbox = new RecordingSandbox(sessionId);
        sandboxes.set(sessionId, sandbox);
        return sandbox;
      },
    };
    sandboxProvider = provider;

    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'default', provider: 'openai', model: 'gpt-4o', is_default: true });
    (modelRegistry as any).createModel = () => fakeModel();

    // Registered the way a started runtime registers its backends, so an
    // Environment naming `local` resolves to the provider under test rather
    // than falling back to the default.
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
      // The production composition root passes the workspace data directory; it
      // is what the default github materializer caches under and what a
      // resource's encrypted token is bound to.
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
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-wiring-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    ensureDefaultEnvironment(db);
    importAgentSeeds(db, [{ name: 'assistant', model: 'gpt-4o', system: 'You are helpful.' }]);
    artifactStore = new LocalArtifactStore(join(tmpDir, 'artifacts'));
    strategy = new PromptCaptureStrategy();
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

  async function uploadFile(name: string, content: string) {
    const created = await post('/v1/files', { name, media_type: 'text/plain', content });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  /** Wait for the session to settle, then return the recorded `session.error` text. */
  function waitForSettled(sessionId: string): Promise<string | undefined> {
    const deadline = Date.now() + 5_000;
    return new Promise((resolve, reject) => {
      const poll = () => {
        const status = sessionManager.get(sessionId)?.status;
        if (status === 'paused' || status === 'failed' || status === 'requires_action') {
          const events = sessionManager.getEventLogger().getEvents(sessionId);
          const error = [...events].reverse().find((event) => event.type === 'session.error');
          const text = (error?.content ?? [])
            .map((block: any) => block.text)
            .join(' ');
          return resolve(text || undefined);
        }
        if (Date.now() >= deadline) return reject(new Error(`session ${sessionId} did not settle`));
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  it('mounts an uploaded file into the sandbox of a session created by POST /v1/sessions', async () => {
    const fileId = await uploadFile('notes.txt', 'attached bytes');

    const created = await post('/v1/sessions', {
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [{ type: 'file', file_id: fileId, mount_path: '/notes/input.txt' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const sent = await post(`/v1/sessions/${created.body.id}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);

    expect(await waitForSettled(created.body.id)).toBeUndefined();

    // The bytes the Files API stored, at the canonical in-sandbox path, before
    // the turn ran. Before the wiring this rejected with "File session resources
    // require an artifact reader" and the sandbox saw no write at all.
    expect(sandboxes.get(created.body.id)?.writes).toEqual([
      { path: '/mnt/session/uploads/notes/input.txt', content: 'attached bytes' },
    ]);
    expect(strategy.prompts).toHaveLength(1);
  });

  it('mounts the same file for a session created by POST /v1/runs', async () => {
    const fileId = await uploadFile('brief.txt', 'run bytes');

    const run = await post('/v1/runs', {
      agent: 'agent_assistant',
      input: 'hello',
      response_mode: 'async',
      session: {
        resources: [{ type: 'file', file_id: fileId, mount_path: '/brief.txt' }],
      },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const sessionId = run.body.session_id as string;

    // `async` returns before the turn runs, so wait for the turn the same way a
    // caller would: the mount has to be in place before the strategy sees it.
    const deadline = Date.now() + 5_000;
    while (strategy.prompts.length === 0) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(sandboxes.get(sessionId)?.writes).toEqual([
      { path: '/mnt/session/uploads/brief.txt', content: 'run bytes' },
    ]);
    expect(strategy.prompts).toHaveLength(1);
  });

  it('reaches the default reader for a file resource whose row is gone', async () => {
    // Declared through `SessionManager.create`, not the route: the route resolves
    // a file resource against the `files` table and answers 400 for an unknown
    // id, so a raw declaration is the only way to reach provisioning with one.
    const session = sessionManager.create({
      agent: 'agent_assistant',
      environmentId: 'env_default',
      resources: [{ type: 'file', file_id: 'file_missing' }],
    });

    await sessionManager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'go' }],
    } as any);

    // The reader is wired, so it runs and reports the file it could not find.
    // The wiring gap used to answer "File session resources require an artifact
    // reader" here, which named a missing dependency rather than the missing file.
    expect(await waitForSettled(session.id)).toContain('File not found: file_missing');
  });

  it('reaches the default repository materializer for a URL outside the published grammar', async () => {
    const session = sessionManager.create({
      agent: 'agent_assistant',
      environmentId: 'env_default',
      resources: [{
        type: 'github_repository',
        url: 'git@github.com:example/repo.git',
        mount_path: '/workspace/repo',
      }],
    });

    await sessionManager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'go' }],
    } as any);

    // The materializer's own URL grammar answers, which is only possible if the
    // composition root built one. The absent-dependency message this replaces
    // was "GitHub repository session resources require a repository materializer".
    expect(await waitForSettled(session.id)).toContain('SSH URLs are not supported');
  });

  it('puts a mounted repository\'s skills into the system prompt, read from the sandbox', async () => {
    // The repository's git transport is the one piece replaced: everything else is
    // the production path — the real lifecycle, the real executor, the real
    // session manager, and the real skills loader.
    makeRuntime({
      githubMaterializer: async (resource, sandbox) => {
        // A stored resource carries the route's normalized `mount_path`; the
        // production materializer resolves it the same way.
        const mountPath = (resource as unknown as { mount_path: string }).mount_path;
        await sandbox.writeFile(`${mountPath}/.claude/skills/code-review/SKILL.md`, SKILL_MARKDOWN);
        return { ok: true, mountPath, skills: ['code-review'], cached: false };
      },
    });

    const created = await post('/v1/sessions', {
      agent: 'agent_assistant',
      environment_id: 'env_default',
      resources: [{
        type: 'github_repository',
        url: 'https://github.com/example/repo',
        authorization_token: 'ghp_probe_token',
        mount_path: '/workspace/repo',
      }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await post(`/v1/sessions/${created.body.id}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    });
    expect(await waitForSettled(created.body.id)).toBeUndefined();

    // The skill was discovered at materialization and read back out of the
    // sandbox, so the prompt names what the agent can actually open.
    expect(sandboxes.get(created.body.id)?.reads).toContain('/workspace/repo/.claude/skills/code-review/SKILL.md');
    expect(strategy.prompts).toHaveLength(1);
    const prompt = strategy.prompts[0]!;
    expect(prompt).toContain('## Skill: code-review');
    expect(prompt).toContain('Read the diff, then say what would break.');
    // Not gated on the agent's own `skills` list: attaching the repository is
    // what put it in the instruction boundary.
    expect(prompt).toContain('# Available Skills');
  });

  it('still refuses the canonical file mount root on the container backends', () => {
    // The remaining gap, pinned so that fixing it forces the capability matrix
    // and its contracts to move rather than leaving a stale `partial` behind.
    //
    // The local backend reaches the canonical roots now
    // (`tests/integration/local-canonical-roots.test.ts` drives the same paths
    // through the real provider). These two do not: docker resolves every path
    // relative to its own `/workspace` and refuses an absolute one, and
    // kubernetes resolves an absolute path against `/workspace`, which leaves the
    // upload root outside it. Both are the functions the providers actually call
    // (`tests/integration/docker-sandbox.test.ts` and the kubernetes suites drive
    // them through a session), and both are pure, so the refusal is pinned without
    // a daemon or a reachable cluster.
    expect(() => dockerWorkspacePath('/mnt/session/uploads/notes/input.txt'))
      .toThrow('Docker sandbox paths must stay inside /workspace');
    expect(() => resolveWorkspacePath('/mnt/session/uploads/notes/input.txt'))
      .toThrow('Path escapes sandbox workspace');
  });

  it('still refuses the canonical repository mount root on docker, and kubernetes still accepts it', () => {
    // The repository half of the same gap: the materializer copies its tree
    // through the sandbox at the mount path the route resolved, so a backend that
    // will not take `/workspace/...` cannot mount a repository there. Docker does
    // not; kubernetes resolves it inside its own `/workspace` and does accept it,
    // which is why the repository entry's recorded blocker names docker rather
    // than "the container backends". Pinning the acceptance means the opposite
    // change — kubernetes starting to refuse the root — also fails here instead of
    // silently leaving a wrong sentence in the contract.
    expect(() => dockerWorkspacePath('/workspace/widget'))
      .toThrow('Docker sandbox paths must stay inside /workspace');
    expect(resolveWorkspacePath('/workspace/widget')).toBe('/workspace/widget');
  });
});
