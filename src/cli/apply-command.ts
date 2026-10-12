/**
 * `managed-agents apply <file...>` — declarative manifest application.
 *
 * The published `ant apply` workflow: a resource is described by a checked-in
 * document, and applying it creates the resource the first time and updates it
 * afterwards. Three document kinds are served, distinguished by file form and
 * frontmatter:
 *
 * - **Agent** — a Markdown file whose frontmatter is the create body minus
 *   `system`; the body below the frontmatter becomes the system prompt.
 * - **Environment** — a `.yaml`/`.yml` file whose top-level `config` object
 *   names the hosting axis (`type: "cloud"` …) — the published environment
 *   spelling.
 * - **Deployment** — a Markdown file whose frontmatter declares `schedule`
 *   (and, per the published contract, `agent`/`environment_id`); the body below
 *   becomes the deployment's initial `user.message`.
 *
 * The resolved ids land in `managed-agents-lock.json` in the apply directory —
 * the `claude-lock.json` pattern under this CLI's name — keyed by the file's
 * path relative to the lock file, so the next `apply` of the same file updates
 * the same resource instead of creating a second one. A later document may
 * reference an earlier file by name: a deployment's `agent` that is not a
 * `agent_…` id is resolved through the recorded identity of the agent file
 * applied before it (then the live list), which is what makes the published
 * `ant apply coding-assistant.md deployment.md` pair work.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ManagedAgentsApiError, ManagedAgentsClient } from '@/sdk/client.js';
import type { CliConnectionOptions, JsonOutputOption } from './runtime-management-commands.js';

export const APPLY_LOCK_FILE = 'managed-agents-lock.json';

export type ApplyOptions = CliConnectionOptions &
  JsonOutputOption & {
    /** Lock file location; defaults to `./managed-agents-lock.json`. */
    lockFile?: string;
  };

/** One recorded apply: which resource a file was last resolved to. */
type LockEntry = {
  kind: Manifest['kind'];
  id: string;
  version?: number | null;
  name?: string;
  applied_at: string;
};

type LockFile = {
  version: 1;
  resources: Record<string, LockEntry>;
};

type Manifest =
  | { kind: 'agent'; file: string; frontmatter: Record<string, unknown>; body: string }
  | { kind: 'environment'; file: string; document: Record<string, unknown> }
  | { kind: 'deployment'; file: string; frontmatter: Record<string, unknown>; body: string };

type AppliedResult = {
  file: string;
  kind: Manifest['kind'];
  action: 'created' | 'updated';
  id: string;
  name?: string;
  version?: number | null;
};

/**
 * Apply each manifest file in argument order, then write the lock file once.
 *
 * Order matters because a later file may reference an earlier one by name —
 * the published quickstart applies `coding-assistant.md deployment.md` in one
 * command — so a file is only applied after the files before it have resolved
 * their ids. A file that fails aborts the run with a named error; resources
 * already applied stay applied (the lock records them), matching the published
 * semantics where apply is per-file rather than a transaction.
 */
export async function applyCommand(files: string[], opts: ApplyOptions): Promise<AppliedResult[]> {
  if (files.length === 0) {
    throw new Error('apply requires at least one manifest file');
  }
  const client = new ManagedAgentsClient({
    baseUrl: `http://localhost:${opts.port}`,
    apiKey: opts.apiKey,
  });
  const lockPath = resolve(opts.lockFile ?? APPLY_LOCK_FILE);
  const lock = readLockFile(lockPath);
  const results: AppliedResult[] = [];
  /** Agent names this run resolved, so a later file's `agent: <name>` binds locally. */
  const appliedAgentNames = new Map<string, LockEntry>();
  /** Same for environments — a deployment's `environment` name binds the same way. */
  const appliedEnvironmentNames = new Map<string, LockEntry>();

  for (const file of files) {
    const manifest = loadManifest(file);
    const key = lockKeyFor(manifest.file, lockPath);
    const prior = lock.resources[key];
    const applied = await applyOne(client, manifest, prior, appliedAgentNames, appliedEnvironmentNames);
    lock.resources[key] = {
      kind: manifest.kind,
      id: applied.id,
      version: applied.version,
      name: applied.name,
      applied_at: new Date().toISOString(),
    };
    if (applied.kind === 'agent' && applied.name) {
      appliedAgentNames.set(applied.name, lock.resources[key]);
    }
    if (applied.kind === 'environment' && applied.name) {
      appliedEnvironmentNames.set(applied.name, lock.resources[key]);
    }
    results.push(applied);
    if (!opts.json) {
      console.log(`${applied.action === 'created' ? 'Created' : 'Updated'} ${applied.kind}: ${applied.id}${applied.name ? ` (${applied.name})` : ''}  <- ${manifest.file}`);
    }
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  return results;
}

async function applyOne(
  client: ManagedAgentsClient,
  manifest: Manifest,
  prior: LockEntry | undefined,
  appliedAgentNames: Map<string, LockEntry>,
  appliedEnvironmentNames: Map<string, LockEntry>,
): Promise<AppliedResult> {
  switch (manifest.kind) {
    case 'agent': {
      const input = agentInputFrom(manifest);
      // The lock file is authoritative, but a lock written on another machine —
      // or against a runtime that has since been reset — names a row that no
      // longer exists. Fall back to the live list by name before deciding this
      // is a create, so a stale lock entry does not fork a duplicate agent.
      const target = await resolveExisting(client, 'agent', prior, stringFieldOf(input.name));
      if (target) {
        const updated = await client.agents.update(target.id, input);
        return { file: manifest.file, kind: 'agent', action: 'updated', id: updated.id, name: updated.name, version: updated.version };
      }
      const created = await client.agents.create(input);
      return { file: manifest.file, kind: 'agent', action: 'created', id: created.id, name: created.name, version: created.version };
    }
    case 'environment': {
      const input = environmentInputFrom(manifest);
      const target = await resolveExisting(client, 'environment', prior, stringFieldOf(input.name));
      if (target) {
        const updated = await client.environments.update(target.id, input);
        return { file: manifest.file, kind: 'environment', action: 'updated', id: updated.id, name: updated.name };
      }
      const created = await client.environments.create(input);
      return { file: manifest.file, kind: 'environment', action: 'created', id: created.id, name: created.name };
    }
    case 'deployment': {
      const input = await deploymentInputFrom(client, manifest, appliedAgentNames, appliedEnvironmentNames);
      const target = await resolveExisting(client, 'deployment', prior, stringFieldOf(input.name));
      if (target) {
        const updated = await client.request<Record<string, unknown>>(
          'POST',
          `/v1/deployments/${encodeURIComponent(target.id)}`,
          input,
        );
        return { file: manifest.file, kind: 'deployment', action: 'updated', id: String(updated.id), name: typeof updated.name === 'string' ? updated.name : stringFieldOf(input.name) };
      }
      const created = await client.request<Record<string, unknown>>('POST', '/v1/deployments', input);
      return { file: manifest.file, kind: 'deployment', action: 'created', id: String(created.id), name: typeof created.name === 'string' ? created.name : stringFieldOf(input.name) };
    }
  }
}

/**
 * Find the existing row a manifest should update: the lock entry first (when it
 * still resolves live), then a same-named row on the server. Returns `null`
 * when neither exists — a create.
 */
async function resolveExisting(
  client: ManagedAgentsClient,
  kind: Manifest['kind'],
  prior: LockEntry | undefined,
  name: string | undefined,
): Promise<{ id: string } | null> {
  if (prior && prior.kind === kind) {
    try {
      const found = await readResource(client, kind, prior.id);
      if (found) return found;
    } catch (error) {
      if (!(error instanceof ManagedAgentsApiError && error.status === 404)) throw error;
    }
  }
  if (!name) return null;
  const listed = await listResources(client, kind);
  return listed.find((item) => item.name === name && !item.archived_at) ?? null;
}

async function readResource(
  client: ManagedAgentsClient,
  kind: Manifest['kind'],
  id: string,
): Promise<{ id: string } | null> {
  const path = kind === 'agent' ? `/v1/agents/${encodeURIComponent(id)}`
    : kind === 'environment' ? `/v1/environments/${encodeURIComponent(id)}`
      : `/v1/deployments/${encodeURIComponent(id)}`;
  const row = await client.request<Record<string, unknown>>('GET', path);
  return row && typeof row.id === 'string' ? { id: row.id } : null;
}

async function listResources(
  client: ManagedAgentsClient,
  kind: Manifest['kind'],
): Promise<Array<{ id: string; name?: string; archived_at?: string | null }>> {
  const path = kind === 'agent' ? '/v1/agents' : kind === 'environment' ? '/v1/environments' : '/v1/deployments';
  const page = await client.request<{ data?: Array<{ id: string; name?: string; archived_at?: string | null }> }>('GET', path);
  return page.data ?? [];
}

/**
 * Translate an agent document: frontmatter minus `system`/`max_turns`-level
 * fields the create route takes, plus the markdown body as `system`.
 */
function agentInputFrom(manifest: Extract<Manifest, { kind: 'agent' }>) {
  const fm = manifest.frontmatter;
  const input: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'model', 'tools', 'mcp_servers', 'skills', 'metadata'] as const) {
    if (fm[key] !== undefined) input[key] = fm[key];
  }
  // The body is the prompt; an explicit frontmatter `system` wins over it, so
  // an agent file that keeps its prompt as data still applies.
  input.system = fm.system !== undefined ? fm.system : manifest.body;
  return input as Parameters<ManagedAgentsClient['agents']['create']>[0];
}

/** The environment document is the create body verbatim, minus `type`. */
function environmentInputFrom(manifest: Extract<Manifest, { kind: 'environment' }>) {
  const { type: _schemaDiscriminator, ...input } = manifest.document;
  return input as Parameters<ManagedAgentsClient['environments']['create']>[0];
}

/**
 * Translate a deployment document: the frontmatter is the create body, with
 * two folds — `schedule: {type: cron, ...}` flattens onto the route's `cron`/
 * `timezone` pair when it needs to (the route accepts the object as-is too,
 * but the published flat spelling is what older callers send), and the body
 * below the frontmatter becomes the initial `user.message` the contract
 * describes ("frontmatter 下方的文本会成为该 user.message").
 *
 * `agent` may be an id (`agent_…`), or the *name* of an agent — resolved first
 * through the ids this very apply run just created (the published
 * `ant apply coding-assistant.md deployment.md` pair), then through the live
 * list. A name that resolves to nothing is left for the server to refuse, so
 * the error names the runtime's own rule rather than the CLI's guess.
 */
async function deploymentInputFrom(
  client: ManagedAgentsClient,
  manifest: Extract<Manifest, { kind: 'deployment' }>,
  appliedAgentNames: Map<string, LockEntry>,
  appliedEnvironmentNames: Map<string, LockEntry>,
) {
  const fm = manifest.frontmatter;
  const input: Record<string, unknown> = {};
  for (const key of [
    'name', 'description', 'initial_events', 'resources',
    'vault_ids', 'budget', 'metadata', 'status', 'payload', 'next_run_at',
  ] as const) {
    if (fm[key] !== undefined) input[key] = fm[key];
  }
  if (fm.schedule !== undefined) input.schedule = fm.schedule;
  if (fm.cron !== undefined) input.cron = fm.cron;
  if (fm.timezone !== undefined) input.timezone = fm.timezone;

  const agentRef = fm.agent ?? fm.agent_id;
  if (agentRef !== undefined) {
    input.agent = await resolveAgentReference(client, agentRef, appliedAgentNames);
  }

  const envRef = fm.environment_id ?? fm.environment;
  if (envRef !== undefined) {
    input.environment_id = await resolveEnvironmentReference(client, envRef, appliedEnvironmentNames);
  }

  if (input.initial_events === undefined) {
    const body = manifest.body.trim();
    if (!body) {
      throw new Error(`deployment manifest ${manifest.file} declares neither initial_events nor a body: one is required so the deployment's sessions have work to start`);
    }
    input.initial_events = [{ type: 'user.message', content: body }];
  }
  return input;
}

async function resolveAgentReference(
  client: ManagedAgentsClient,
  ref: unknown,
  appliedAgentNames: Map<string, LockEntry>,
): Promise<unknown> {
  if (typeof ref !== 'string' || ref.startsWith('agent_')) return ref;
  const local = appliedAgentNames.get(ref);
  if (local) return { type: 'agent', id: local.id, ...(local.version ? { version: local.version } : {}) };
  // A name that was not applied in this run may still be live on the runtime.
  const page = await client.request<{ data?: Array<{ id: string; name?: string; version?: number }> }>('GET', '/v1/agents');
  const found = (page.data ?? []).find((agent) => agent.name === ref);
  return found ? { type: 'agent', id: found.id, ...(found.version ? { version: found.version } : {}) } : ref;
}

/**
 * Same resolution for `environment`: an `env_…` id or object passes through; a
 * bare name binds the environment this run applied first, then a same-named
 * live row. The route takes only `environment_id`, so a resolved name is sent
 * as the id string the column stores.
 */
async function resolveEnvironmentReference(
  client: ManagedAgentsClient,
  ref: unknown,
  appliedEnvironmentNames: Map<string, LockEntry>,
): Promise<unknown> {
  if (typeof ref !== 'string' || ref.startsWith('env_')) return ref;
  const local = appliedEnvironmentNames.get(ref);
  if (local) return local.id;
  const page = await client.request<{ data?: Array<{ id: string; name?: string; archived_at?: string | null }> }>('GET', '/v1/environments');
  const found = (page.data ?? []).find((env) => env.name === ref && !env.archived_at);
  return found ? found.id : ref;
}

// ============================================================
// Manifest loading
// ============================================================

/**
 * Read one file into its manifest kind. The discriminator is the file form:
 * a `.yaml`/`.yml`/`.json` file is an environment document; anything else must
 * be a Markdown document with frontmatter, whose `schedule` (or `cron`) marks
 * it a deployment and whose absence marks it an agent — the same split the
 * published examples use.
 */
export function loadManifest(file: string): Manifest {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(`manifest file not found: ${file}`);
  }
  const ext = extname(path).toLowerCase();
  const text = readFileSync(path, 'utf8');

  if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
    const document = ext === '.json'
      ? safeParseJson(text, file)
      : safeParseYaml(text, file);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`environment manifest ${file} must be a YAML/JSON object`);
    }
    if (typeof (document as Record<string, unknown>).name !== 'string' || !(document as Record<string, unknown>).name) {
      throw new Error(`environment manifest ${file} requires a name`);
    }
    return { kind: 'environment', file: path, document: document as Record<string, unknown> };
  }

  const { frontmatter, body } = splitFrontmatter(text, file);
  if (frontmatter.schedule !== undefined || frontmatter.cron !== undefined) {
    return { kind: 'deployment', file: path, frontmatter, body };
  }
  if (frontmatter.model === undefined && frontmatter.name === undefined) {
    throw new Error(
      `manifest ${file} is neither an agent (needs at least a name or model in frontmatter), ` +
      `a deployment (needs schedule or cron), nor an environment (use a .yaml/.json file)`,
    );
  }
  return { kind: 'agent', file: path, frontmatter, body };
}

/**
 * Split a Markdown document on its `---` frontmatter fence. The frontmatter is
 * parsed as YAML — the published examples write it that way — and the body is
 * everything after the closing fence, with one leading newline stripped so the
 * prompt does not begin on a blank line.
 */
function splitFrontmatter(text: string, file: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized.trim() !== '---') {
    throw new Error(`manifest ${file} must start with a --- frontmatter block`);
  }
  const close = normalized.indexOf('\n---', 4);
  if (close === -1) {
    throw new Error(`manifest ${file} has an unterminated frontmatter block`);
  }
  const rawFrontmatter = normalized.slice(4, close);
  const after = normalized.slice(close + 4);
  const body = after.startsWith('\n') ? after.slice(1) : after;
  const parsed = rawFrontmatter.trim() === '' ? {} : safeParseYaml(rawFrontmatter, file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`frontmatter in ${file} must be a YAML object`);
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function safeParseYaml(text: string, file: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(`${file}: invalid YAML — ${(error as Error).message}`);
  }
}

/** Narrow a manifest field to a plain string, or `undefined`. */
function stringFieldOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeParseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON — ${(error as Error).message}`);
  }
}

// ============================================================
// Lock file
// ============================================================

function readLockFile(path: string): LockFile {
  if (!existsSync(path)) return { version: 1, resources: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`lock file ${basename(path)} is not valid JSON: ${(error as Error).message}`);
  }
  const resources = (parsed as LockFile).resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error(`lock file ${basename(path)} is missing its "resources" object`);
  }
  return { version: 1, resources: resources as LockFile['resources'] };
}

/**
 * The lock key for a manifest: its path relative to the lock file's directory,
 * in forward slashes, so a checkout produces the same key on every OS and a
 * moved file is simply a different resource. An absolute path outside the
 * lock's tree keeps its absolute spelling.
 */
function lockKeyFor(file: string, lockPath: string): string {
  const lockDir = dirname(lockPath);
  const relative = file.startsWith(lockDir)
    ? file.slice(lockDir.length + 1)
    : file;
  return relative.replace(/\\/g, '/');
}
