import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf, pageOf } from '../standard.js';
import {
  archiveResource,
  conflict,
  invalid,
  notFound,
  objectField,
  parseObject,
  readObjectBody,
  stringField,
  stringRecordField,
} from './resource-utils.js';
import { rejectUnexpectedQueryParams } from './query-params.js';
import { SHIPPED_SANDBOX_PROVIDER_TYPES } from '@/types/sandbox.js';
import {
  ENVIRONMENT_CONFIG_ERROR_CODES,
  ENVIRONMENT_HOSTING_FIELDS,
  environmentHostingProjection,
  hostingTypeError,
  isEnvironmentConfigError,
  parseEnvironmentConfig,
  readDeclaredHostingType,
  UNREADABLE_HOSTING_TYPE,
} from '@/sandbox/provider-names.js';
import {
  normalizeEnvironmentNetwork,
  sameEnvironmentNetwork,
} from '@/core/config/environment-network.js';
import {
  createEnvironmentWorkerKey,
  listEnvironmentWorkerKeys,
  revokeEnvironmentWorkerKey,
} from '@/core/auth/environment-worker-keys.js';

type ResourceKind = 'environment';

export function environmentRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/environments', (c) => {
    // Admission first, like every other listing route: a parameter this listing does not
    // implement used to be ignored, so `?limit=5` answered a page as though the request had
    // been understood. The accept list is empty because the listing implements no parameter,
    // and four measurements agree. The published contract documents the endpoint but no
    // parameter for its listing — every published `/v1/environments` line was read and not one
    // carries a query string, the "管理环境" section documents list/retrieve/archive/delete with
    // bare `curl`s (`云环境设置.md:582-605`) — and its `include_archived` opt-in is documented
    // for the memory-store and vault listings only. This repository's contract names the route,
    // with its worker keys, in the group that "return their whole set rather than a window"
    // (`pagination.md`), so no window parameter is implemented or claimed. And no local caller
    // passes a query string: the Console, the SDK, the CLI and the tests all call it bare.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const rows = deps.db.prepare('SELECT * FROM environments WHERE archived_at IS NULL ORDER BY created_at DESC').all() as unknown as EnvironmentRow[];
    return c.json(cursorPageOf(rows.map(toEnvironment), {}));
  });

  app.post('/environments', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const normalized = normalizeEnvironmentConfig(body.value);
    if (!normalized.ok) return invalid(c, normalized.message, normalized.code);
    const config = normalized.config;
    const providerError = sandboxProviderError(config);
    if (providerError) return invalid(c, providerError.message, providerError.code);
    const id = `env_${nanoid(18)}`;
    try {
      deps.db.prepare(
        'INSERT INTO environments (id, name, description, config, metadata, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
      ).run(
        id,
        name,
        stringField(body.value.description) ?? '',
        JSON.stringify(config),
        JSON.stringify(stringRecordField(body.value.metadata)),
      );
      const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as unknown as EnvironmentRow;
      return c.json(toEnvironment(row), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Environment id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/environments/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as EnvironmentRow | undefined;
    return row ? c.json(toEnvironment(row)) : notFound(c, 'Environment not found');
  });

  app.put('/environments/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as EnvironmentRow | undefined;
    if (!existing) return notFound(c, 'Environment not found');

    const name = stringField(body.value.name) ?? existing.name;
    // The stored config is the merge base, so an unreadable one is refused
    // rather than silently replaced by `{}` — which would rewrite a damaged
    // Environment into an Environment that declares nothing and therefore runs
    // locally. A request that carries a complete `config` is the repair path.
    let storedConfig: Record<string, unknown>;
    try {
      storedConfig = parseEnvironmentConfig(existing.config, `Environment ${id}`);
    } catch (err) {
      if (isEnvironmentConfigError(err) && isPlainObject(body.value.config)) {
        storedConfig = {};
      } else {
        return invalid(c, err instanceof Error ? err.message : String(err), isEnvironmentConfigError(err) ? err.code : undefined);
      }
    }
    const normalized = normalizeEnvironmentConfig(body.value, storedConfig);
    if (!normalized.ok) return invalid(c, normalized.message, normalized.code);
    const config = normalized.config;
    const providerError = sandboxProviderError(config);
    if (providerError) return invalid(c, providerError.message, providerError.code);
    deps.db.prepare(
      'UPDATE environments SET name = ?, description = ?, config = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(
      name,
      stringField(body.value.description) ?? existing.description ?? '',
      JSON.stringify(config),
      JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : stringRecordField(body.value.metadata)),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as unknown as EnvironmentRow;
    return c.json(toEnvironment(row));
  });

  app.post('/environments/:id/archive', (c) => archiveResource(c, deps, 'environments', toEnvironment));

  // --- Self-hosted worker keys (R9.14) -------------------------------------
  //
  // The issuing side of the worker-key contract whose consuming side is
  // `POST /v1/x/worker/claim`. Only the SHA-256 hash of a key is stored, so
  // `secret_key` is present in the creation response and can never be read
  // back; list and revoke responses carry `key_prefix` instead. Both routes are
  // published in `docs/api.md` and `docs/api-matrix.md`.

  app.get('/environments/:id/worker-keys', (c) => {
    // Admission first, in the same order as the work-items listing below: this listing
    // reads no query parameter, and the published contract documents none for it — the
    // route is a local self-hosted extension with no counterpart in the published CMA
    // surface, so there is no documented parameter to honour and no ambiguity to resolve.
    // An empty accept list is therefore the honest one, and a parameter used to be
    // ignored, so `?limit=5` answered a page as if the request had been understood. Every
    // local caller passes no query string (`src/sdk/client.ts`, the CLI), and the Console
    // carries API-reference metadata for the route rather than a request.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    return c.json(cursorPageOf(listEnvironmentWorkerKeys(deps.db, environmentId), {}));
  });

  app.post('/environments/:id/worker-keys', async (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    if (name.length > 80) return invalid(c, 'name must be 80 characters or fewer');
    const expiresAt = stringField(body.value.expires_at);
    if (body.value.expires_at !== undefined && body.value.expires_at !== null && !expiresAt) {
      return invalid(c, 'expires_at must be an ISO 8601 timestamp');
    }
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      return invalid(c, 'expires_at must be an ISO 8601 timestamp');
    }
    const created = createEnvironmentWorkerKey(deps.db, environmentId, {
      name,
      expires_at: expiresAt ?? null,
      metadata: stringRecordField(body.value.metadata),
    });
    return c.json(created, 201);
  });

  app.post('/environments/:id/worker-keys/:keyId/revoke', (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const revoked = revokeEnvironmentWorkerKey(deps.db, environmentId, c.req.param('keyId'));
    if (!revoked) return notFound(c, 'Worker key not found');
    return c.json(revoked);
  });

  // --- Self-hosted work queue (R9.14) --------------------------------------
  //
  // The inspecting side of the same protocol whose consuming side is
  // `POST /v1/x/worker/claim`, and published in `docs/api.md` and
  // `docs/api-matrix.md`. `WorkQueue.list`/`stats` already answer the question
  // for one environment. Without a configured queue the route refuses instead of
  // answering an empty page, because "this runtime has no queue" and "this queue
  // has no work" must not read the same.

  app.get('/environments/:id/work-items', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit']);
    if (rejected) return rejected;
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const queue = deps.workQueue;
    if (!queue) {
      return c.json({
        error: {
          type: 'work_queue_unavailable',
          message: 'This runtime has no self-hosted work queue configured.',
        },
      }, 503);
    }
    return c.json({
      ...pageOf(queue.list({ environmentId, limit: parseLimit(c.req.query('limit')) })),
      counts: queue.stats({ environmentId }),
    });
  });

  return app;
}

/**
 * A usable positive `limit` query value.
 *
 * An unusable value falls back to the queue's own default rather than being
 * refused, which is how the extension routes in `runtime.ts` already treat a
 * malformed pagination hint.
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The environment id when it names a live (non-archived) environment. */
function activeEnvironmentId(c: any, deps: ServerDeps): string | undefined {
  const id = c.req.param('id');
  const row = deps.db.prepare('SELECT id FROM environments WHERE id = ? AND archived_at IS NULL').get(id);
  return row ? id : undefined;
}

function toEnvironment(row: EnvironmentRow) {
  let config: Record<string, unknown>;
  let unreadable = false;
  try {
    config = parseEnvironmentConfig(row.config, `Environment ${row.id}`);
  } catch {
    // A row this build cannot read is reported as unreadable rather than as the
    // backend an empty config would resolve to: showing `local` is what let an
    // operator open the damaged Environment, save the form, and thereby store a
    // local one. `unknown` is unservable, so that save is refused instead.
    config = {};
    unreadable = true;
  }
  return {
    id: row.id,
    type: 'environment' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    hosting_type: unreadable ? UNREADABLE_HOSTING_TYPE : environmentHostingType(config),
    sandbox_provider: typeof config.sandbox_provider === 'string' ? config.sandbox_provider : null,
    network: environmentNetworkProjection(config),
    packages: Array.isArray(config.packages) ? config.packages : [],
    status: row.archived_at ? 'archived' : 'active',
    config,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    archived_at: row.archived_at ?? null,
  };
}

/**
 * Merge the request's declared hosting fields over the stored config.
 *
 * A `config` that is not an object is refused rather than dropped: ignoring it
 * would leave the Environment resolving to a backend the caller did not ask
 * for. Individual field shapes are validated on the merged config by
 * {@link sandboxProviderError}.
 *
 * Both published spellings are read here rather than stored as written:
 * `config.networking` becomes `config.network`, and `config.type` counts as
 * `hosting_type`. The local spelling is the one this runtime records and reads
 * back. Two spellings declared by **one request** with different content are
 * refused — they cannot both be honoured, and silently preferring one would
 * apply a declaration the caller did not write. A spelling left behind by an
 * older row is not a caller statement: a declaration in the request supersedes
 * it, because an update naming one spelling is a normal field update and not a
 * contradiction. Leaving the stale twin in place would make the record
 * unrepairable through the spelling the caller actually wrote — including
 * through the Console, which only ever sends the local one.
 */
function normalizeEnvironmentConfig(
  body: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string; code: string } {
  if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) {
    return { ok: false, message: 'config must be an object', code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig };
  }
  const incoming = { ...objectField(body.config) };
  for (const key of ['hosting_type', 'sandbox_provider', 'network', 'networking', 'packages'] as const) {
    if (body[key] !== undefined) incoming[key] = body[key];
  }

  const translated = translateIncomingNetwork(incoming);
  if (!translated.ok) return translated;
  // A policy the request named — in either spelling — replaces the stored one,
  // including a damaged stored value the request is repairing.
  const declaredNetwork = incoming.network !== undefined;

  const config = { ...existing, ...incoming };
  supersedeStoredHostingSpelling(config, incoming);
  const stored = migrateStoredNetwork(config, declaredNetwork);
  if (!stored.ok) return stored;
  return { ok: true, config };
}

/**
 * Drop the stored spelling of the hosting axis that the request did not use.
 *
 * The request's own declaration is already merged in. What can still sit beside
 * it is the *other* spelling left by an older row — `config.type` beside a
 * request's `hosting_type`, or the reverse. A declaration in one spelling
 * supersedes the stored declaration in the other, which makes an update a normal
 * field update: without it, a row the previous version wrote with the published
 * spelling could not be renamed or repaired through the local spelling, and a
 * request naming the hosting type once would be refused for disagreeing with a
 * value it never sent. Clearing a spelling with `null` or an empty string
 * touches only that spelling, so the other one still decides the backend.
 */
function supersedeStoredHostingSpelling(
  config: Record<string, unknown>,
  incoming: Record<string, unknown>,
): void {
  const declared = ENVIRONMENT_HOSTING_FIELDS.filter((field) => {
    const value = incoming[field];
    return typeof value === 'string' && value.trim() !== '';
  });
  if (declared.length === 0) return;
  for (const field of ENVIRONMENT_HOSTING_FIELDS) {
    if (!declared.includes(field)) delete config[field];
  }
}

/**
 * Read the two spellings of the network policy a request declares.
 *
 * `networking` is translated into the local `network` key; both being present
 * with different content is refused. The published key is consumed rather than
 * echoed, the same way a legacy spelling elsewhere in this runtime is accepted
 * on ingress and not returned as written.
 */
function translateIncomingNetwork(
  incoming: Record<string, unknown>,
): { ok: true } | { ok: false; message: string; code: string } {
  if (incoming.networking === undefined) return { ok: true };
  if (incoming.networking === null) {
    // `null` is how a client clears a field, in this spelling too: the two
    // spellings are one policy, so clearing through either clears it.
    delete incoming.networking;
    if (incoming.network === undefined) incoming.network = null;
    return { ok: true };
  }
  const published = normalizeEnvironmentNetwork(incoming.networking);
  if (!published) {
    return {
      ok: false,
      message: 'config.networking must be an object',
      code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
    };
  }
  if (incoming.network !== undefined) {
    const local = normalizeEnvironmentNetwork(incoming.network);
    if (!local) {
      return {
        ok: false,
        message: 'config.network must be an object',
        code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      };
    }
    if (!sameEnvironmentNetwork(local, published)) {
      return {
        ok: false,
        message: 'config.network and config.networking are two spellings of one network policy '
          + 'and they disagree. Declare the policy once, or make both spellings name the same one.',
        code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      };
    }
  }
  incoming.network = published;
  delete incoming.networking;
  return { ok: true };
}

/**
 * Normalize the policy a merged config holds, including a stored `networking`
 * from a row written before both spellings were read.
 *
 * `declaredByRequest` says whether the request named the policy. When it did, the
 * request's value is the policy and any stored spelling of it — readable or
 * damaged, local or published — is superseded, which is what makes a damaged
 * stored value repairable by writing a good one and clearable with `null`. When
 * it did not, storage decides: a readable published-spelling policy is
 * translated into the recorded local key, and one that cannot be read at all is
 * refused with the repair it needs rather than applied or dropped.
 */
function migrateStoredNetwork(
  config: Record<string, unknown>,
  declaredByRequest: boolean,
): { ok: true } | { ok: false; message: string; code: string } {
  if (declaredByRequest) {
    delete config.networking;
    if (config.network === null) {
      // `null` clears the policy instead of being stored as an unreadable one.
      delete config.network;
      return { ok: true };
    }
    const normalized = normalizeEnvironmentNetwork(config.network);
    if (!normalized) {
      return {
        ok: false,
        message: 'config.network must be an object',
        code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      };
    }
    config.network = normalized;
    return { ok: true };
  }

  if (config.network === null) {
    delete config.network;
  } else if (config.network !== undefined) {
    const normalized = normalizeEnvironmentNetwork(config.network);
    if (!normalized) return unreadableStoredPolicy('network');
    config.network = normalized;
  }
  if (config.networking === undefined) return { ok: true };
  if (config.networking === null) {
    delete config.networking;
    return { ok: true };
  }
  const legacy = normalizeEnvironmentNetwork(config.networking);
  if (!legacy) return unreadableStoredPolicy('networking');
  if (config.network === undefined) config.network = legacy;
  // The local key is the record; the published one is an ingress spelling.
  delete config.networking;
  return { ok: true };
}

/**
 * Refuse a stored policy that is not an object, naming the way out.
 *
 * The row is not repaired silently: the caller asked to change something else,
 * and dropping a value they did not mention is how a policy disappears without
 * anyone deciding it should. The message names the request that replaces it, so
 * a stuck row is one call away from being usable again.
 */
function unreadableStoredPolicy(key: string): { ok: false; message: string; code: string } {
  return {
    ok: false,
    message: `stored ${key} is not an object and cannot be read as a network policy. `
      + 'Send config.network with a policy object to replace it, or null to clear it.',
    code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
  };
}

/**
 * The declared network policy, in the local spelling.
 *
 * A stored row that holds only the published `networking` is read here too, so a
 * policy written before both spellings were accepted is still reported instead of
 * disappearing from the response. A policy that cannot be read at all reports as
 * an empty object: nothing executes on it, so there is no backend to misreport.
 */
function environmentNetworkProjection(config: Record<string, unknown>): Record<string, unknown> {
  return normalizeEnvironmentNetwork(config.network)
    ?? normalizeEnvironmentNetwork(config.networking)
    ?? {};
}

/**
 * Reject an Environment whose declared backend or hosting type this runtime
 * cannot execute.
 *
 * Without this the environment is accepted at write time and then either fails
 * much later, when a session tries to boot a sandbox that does not exist, or —
 * for `hosting_type` — silently ran on the local backend instead. The refusal
 * carries the same code the resolution path raises, because `docs/api.md`
 * documents one code per cause and a caller that only sees this response must be
 * able to branch on it.
 */
function sandboxProviderError(
  config: Record<string, unknown>,
): { message: string; code: string } | undefined {
  const malformed = hostingFieldError(config);
  if (malformed) return { message: malformed, code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig };
  // `hosting_type` is checked before `sandbox_provider` so the message names the
  // field the caller most likely wrote: the Console derives the backend from it,
  // so a hosting value this runtime cannot serve would otherwise be reported as a
  // backend name the operator never typed. The published `type` is read by the
  // same function, so it is refused in the same words.
  const declared = readDeclaredHostingType(config, 'Environment');
  if (!declared.ok) return { message: declared.message, code: declared.code };
  const hostingError = declared.value ? hostingTypeError(declared.value) : undefined;
  if (hostingError) return { message: hostingError, code: ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType };
  const provider = stringField(config.sandbox_provider);
  if (provider && !(SHIPPED_SANDBOX_PROVIDER_TYPES as readonly string[]).includes(provider)) {
    return {
      message: `sandbox_provider "${provider}" is not a known sandbox backend `
        + `(expected one of: ${SHIPPED_SANDBOX_PROVIDER_TYPES.join(', ')})`,
      code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
    };
  }
  return undefined;
}

/**
 * Refuse a hosting field that is present but cannot name a backend.
 *
 * A non-string (`7`, `{ type: "cloud" }`) is refused rather than dropped:
 * dropping it would leave the Environment resolving to the default local
 * backend while the caller believed it had declared something. `null` and an
 * empty string mean "not declared" — how a client clears a field — and are left
 * to the resolver's documented default. Both spellings are checked, because the
 * published `type` is a hosting declaration too.
 */
function hostingFieldError(config: Record<string, unknown>): string | undefined {
  for (const key of ['hosting_type', 'type', 'sandbox_provider'] as const) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${key} must be a string`;
  }
  return undefined;
}

/**
 * The public `hosting_type` an Environment reports.
 *
 * Shared with the runtime so a backend the runtime can execute is never
 * described as hosting it does not have: a `kubernetes` Environment used to be
 * reported as `cloud`, and a config that declared only a backend used to fall
 * through to `cloud` as well. A declared value that this runtime does not
 * recognize is echoed verbatim rather than replaced, and a config that declares
 * nothing reports the backend it resolves to.
 */
function environmentHostingType(config: Record<string, unknown>): string {
  return environmentHostingProjection(config);
}

interface EnvironmentRow {
  id: string;
  name: string;
  description: string;
  config: string;
  metadata: string;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
