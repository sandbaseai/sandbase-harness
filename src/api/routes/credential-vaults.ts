import { Hono } from 'hono';
import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { unsupportedMcpOAuthValidation } from './unsupported-official.js';
import { cursorPageOf, cursorQueryMismatch, decodeCursor, encodeCursor, normalizeCollectionFilter } from '../standard.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { normalizeCredentialNetworkPolicy } from '@/core/credentials/policy.js';
import {
  parseCredentialAuth,
  toCanonicalCredential,
  type CredentialInjectionLocation,
} from '@/core/credentials/canonical-credential.js';
import {
  appendCredentialAuditEvent,
  listCredentialAuditEvents,
} from '@/core/credentials/audit.js';
import {
  archiveResource,
  conflict,
  invalid,
  notFound,
  parseObject,
  parseStringArray,
  readObjectBody,
  stringField,
  stringRecordField,
} from './resource-utils.js';
import {
  COLLECTION_LISTING_QUERY_PARAMS,
  INCLUDE_ARCHIVED_PARAM,
  parseCollectionWindow,
  parseIncludeArchived,
  rejectUnexpectedQueryParams,
} from './query-params.js';
import { publishOperationEvent } from './operation-events.js';

/**
 * The vault listing's ordering, as the token a page cursor carries.
 *
 * It names the collection as well as the sort: two collections ordered the same
 * way would otherwise accept each other's cursors, and a page number means
 * nothing outside the collection it was counted in.
 */
const VAULT_LIST_ORDER = 'vaults.created_at DESC, rowid DESC';

/**
 * The audit listing's own parameters, named once because two routes expose it.
 *
 * The refusal runs in the route handlers rather than in `auditPage`, because
 * `auditPage` is reached only after the vault exists: a request carrying a
 * parameter this route does not implement would otherwise be answered `404` for
 * a missing vault, which tells the caller their parameter was understood. The
 * request is judged before state is read.
 */
const AUDIT_QUERY_PARAMS: readonly string[] = ['limit', 'page'];

type ResourceKind = 'credential_vault';

export function credentialVaultRoutes(deps: ServerDeps) {
  const app = new Hono();
  app.post('/:id/credentials/:credentialId/mcp_oauth_validate', unsupportedMcpOAuthValidation);

  // Paths in this router are **relative to its mount**, because the resource is
  // served under two prefixes: the published `/v1/vaults` the contract addresses
  // vaults at, and the local `/v1/credential-vaults` the Console, the SDK and
  // existing stored references already use. `resources.ts` mounts this same
  // factory at both, so the two spellings cannot diverge route by route — a route
  // added here is reachable at both prefixes with no second edit. It is also why
  // the paths are literals rather than built from a base-path variable: the
  // mounted-route table the Console guard reads
  // (`tests/unit/support/route-table.ts`) expands `app.<method>('<literal>'` and
  // `app.route('<prefix>', factory)` statically, so a computed path would make
  // these routes invisible to a guard whose whole purpose is to notice exactly
  // that kind of drift.
  app.get('/', (c) => {
    // Admission first, like every other listing route: a parameter this listing does
    // not implement used to be ignored, so `?include_archived=true&status=archived`
    // answered a page as if the second half of the request had been understood. The
    // list is the same one the memory-store listing passes, because both read the
    // same three parameters through the same two helpers.
    const rejected = rejectUnexpectedQueryParams(c, COLLECTION_LISTING_QUERY_PARAMS);
    if (rejected) return rejected;
    // The published contract makes the archived half of the collection opt-in:
    // "默认排除已归档的记录（传递 `include_archived=true` 可将其包含在内）"
    // (`将工作委派给智能体/使用保管库进行身份验证.md:1119`). The exclusion used to be
    // hardcoded in the `WHERE` clause, so a caller who passed the documented parameter
    // was handed a page that omitted exactly the rows they asked for, and nothing in the
    // response said the filter had been ignored. `toVault` already labels an archived row
    // (`status: row.archived_at ? 'archived' : row.status`, `archived_at`), so the only
    // thing missing was reading the parameter. The reading itself lives in
    // `query-params.ts` because the memory-store listing takes the same parameter.
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;

    // The published pagination rule applies here too, and the cursor carries this
    // collection's ordering and the archived filter that produced it, so a cursor
    // issued for one view of the collection cannot be replayed against another.
    const window = parseCollectionWindow(c, {
      order: VAULT_LIST_ORDER,
      filter: includeArchived.value ? { [INCLUDE_ARCHIVED_PARAM]: 'true' } : {},
    });
    if (!window.ok) return window.response;

    const where = includeArchived.value ? '' : 'WHERE v.archived_at IS NULL';
    // `rowid` breaks the tie between rows created in the same second: `created_at` is
    // `datetime('now')`, so a burst of vaults shares one timestamp and the ordering
    // within that group was whatever the scan produced. A windowed listing has to slice
    // a total order — without it a page boundary can repeat or drop a row — and
    // descending `rowid` is insertion-recency, which is what the tie group means.
    const rows = deps.db.prepare(`${vaultSelect(where)} ORDER BY v.created_at DESC, v.rowid DESC`).all() as unknown as VaultRow[];
    return c.json(window.value.slice(rows.map((row) => toVault(row, deps))));
  });

  app.post('/', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const id = `vlt_${nanoid(18)}`;
    try {
      deps.db.prepare(
        'INSERT INTO credential_vaults (id, name, description, metadata) VALUES (?, ?, ?, ?)',
      ).run(
        id,
        name,
        stringField(body.value.description) ?? '',
        JSON.stringify(stringRecordField(body.value.metadata)),
      );
      const row = deps.db.prepare(vaultSelect('WHERE v.id = ? AND v.archived_at IS NULL')).get(id) as unknown as VaultRow;
      await publishOperationEvent(deps, { type: 'vault.created', subjectId: id });
      return c.json(toVault(row, deps), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Credential vault id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/:id', (c) => {
    const row = deps.db.prepare(vaultSelect('WHERE v.id = ? AND v.archived_at IS NULL')).get(c.req.param('id')) as VaultRow | undefined;
    return row ? c.json(toVault(row, deps)) : notFound(c, 'Credential vault not found');
  });

  app.get('/:id/credentials', (c) => {
    const vault = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!vault) return notFound(c, 'Credential vault not found');
    // The archived-half opt-in is published for credentials as well as vaults ("列出 vault
    // 或凭证"), and the same helper validates it so an invalid value is refused identically on
    // both listings rather than by two rules that can drift. Unknown parameters are still
    // ignored on this listing; that gap is recorded separately rather than closed here.
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;
    return c.json(cursorPageOf(
      listCredentials(deps, c.req.param('id'), { includeArchived: includeArchived.value }),
      {},
    ));
  });

  app.post('/:id/credentials', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const vaultId = c.req.param('id');
    const vault = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(vaultId);
    if (!vault) return notFound(c, 'Credential vault not found');

    // One parser for both wire shapes: the canonical nested `auth` object is the
    // published profile, and the flat spelling stays accepted as a local alias.
    // A payload supplying both is refused rather than merged, so a flat field can
    // never silently override a nested one.
    const parsed = parseCredentialAuth(body.value);
    if (!parsed.ok) return invalid(c, parsed.message);
    const credential = parsed.value;
    // The parser records a canonical `environment_variable` with no `secret_value`
    // as "no value supplied"; the route refuses it, because a credential whose
    // secret was never set is an unusable row.
    if (credential.authType === 'environment_variable' && !credential.secretValue) {
      return invalid(c, 'secret_value is required');
    }

    // `auth.networking` is the canonical spelling for the policy; the flat shape
    // carried `network`. Both run through the same normalizer as before.
    const networkValue = credential.networking ?? body.value.network;
    const encryptedSecret = credential.secretValue
      ? encryptSecret(credential.secretValue, deps.workspace?.dataDir)
      : { ciphertext: '', nonce: '', tag: '' };
    const id = `vcrd_${nanoid(18)}`;
    const now = new Date().toISOString();
    deps.db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, mcp_server_url, variable_name, value_hint,
        network, injection_locations, metadata, secret_ciphertext, secret_nonce, secret_tag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      vaultId,
      credential.displayName,
      credential.authType,
      credential.mcpServerUrl ?? null,
      credential.secretName ?? null,
      secretHint(credential.secretValue ?? ''),
      JSON.stringify(normalizeCredentialNetwork(networkValue)),
      JSON.stringify(credential.legacyInjectionTokens ?? injectionTokens(credential.injectionLocation)),
      JSON.stringify(credential.metadata),
      encryptedSecret.ciphertext,
      encryptedSecret.nonce,
      encryptedSecret.tag,
      now,
      now,
    );
    deps.db.prepare('UPDATE credential_vaults SET updated_at = datetime(\'now\') WHERE id = ?').run(vaultId);
    const row = deps.db.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as unknown as CredentialRow;
    await publishOperationEvent(deps, {
      type: 'vault_credential.created',
      subjectId: id,
      extra: { vault_id: vaultId },
    });
    return c.json(withWarnings(toCredential(row), parsed.warnings), 201);
  });

  app.post('/:id/credentials/:credentialId/archive', (c) => updateCredentialState(c, deps, 'archived'));

  app.delete('/:id/credentials/:credentialId', (c) => updateCredentialState(c, deps, 'deleted'));

  // Archiving a vault archives its credentials with it: the published table
  // emits one `vault_credential.archived` per credential alongside the vault's
  // own event (`订阅Webhook.md:37-38`). A 404 — missing or already archived —
  // raises nothing.
  app.post('/:id/archive', async (c) => {
    const vaultId = c.req.param('id');
    const credentials = deps.db.prepare(
      "SELECT id FROM credential_records WHERE vault_id = ? AND archived_at IS NULL AND status != 'deleted'",
    ).all(vaultId) as Array<{ id: string }>;
    const response = archiveResource(c, deps, 'credential_vaults', (row) => toVault(row, deps));
    if (response.status === 200) {
      for (const credential of credentials) {
        await publishOperationEvent(deps, {
          type: 'vault_credential.archived',
          subjectId: credential.id,
          extra: { vault_id: vaultId },
        });
      }
      await publishOperationEvent(deps, { type: 'vault.archived', subjectId: vaultId });
    }
    return response;
  });

  // --- Credential rotation, use and audit (published) ----------------------
  //
  // `docs/api.md` publishes rotate and mark-used with a worked example, and
  // `docs/api-matrix.md` publishes the audit listing. The events come from
  // `credential_audit_events` (M028), which records what happened to a secret
  // without ever recording the secret.

  app.post('/:id/credentials/:credentialId/rotate', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const vaultId = c.req.param('id');
    const credentialId = c.req.param('credentialId');
    const vault = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(vaultId);
    if (!vault) return notFound(c, 'Credential vault not found');
    if (!liveCredential(deps, vaultId, credentialId)) return notFound(c, 'Credential not found');

    const secretValue = typeof body.value.value === 'string' ? body.value.value : '';
    if (!secretValue) return invalid(c, 'value is required');

    const encrypted = encryptSecret(secretValue, deps.workspace?.dataDir);
    // A rotation replaces the secret material and nothing else: the credential
    // keeps its identity, its policy and its history.
    deps.db.prepare(
      `UPDATE credential_records
       SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?, value_hint = ?, updated_at = ?
       WHERE id = ? AND vault_id = ?`,
    ).run(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      secretHint(secretValue),
      new Date().toISOString(),
      credentialId,
      vaultId,
    );
    deps.db.prepare('UPDATE credential_vaults SET updated_at = datetime(\'now\') WHERE id = ?').run(vaultId);
    appendCredentialAuditEvent(deps.db, {
      vaultId,
      credentialId,
      action: 'rotate',
      actor: stringField(body.value.actor),
      metadata: stringRecordField(body.value.metadata),
    });
    // The rotation is committed above, so every session that references this vault
    // is asked to rebuild its MCP transports: a transport that keeps the previous
    // value authenticates with a credential the operator has just replaced, and
    // waiting for the next restart would leave that gap open. A reconnect failure is
    // deliberately not rolled back — the MCP status reports a degraded server.
    await deps.sessionManager.refreshVaultMcpCredentials(vaultId);
    const row = deps.db.prepare('SELECT * FROM credential_records WHERE id = ? AND vault_id = ?').get(credentialId, vaultId) as unknown as CredentialRow;
    return c.json(toCredential(row));
  });

  app.post('/:id/credentials/:credentialId/mark-used', async (c) => {
    // Marking a credential used is the management call a client makes without a
    // body, so an absent body is read as an empty one rather than rejected.
    const raw = await c.req.json().catch(() => ({}));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(c, 'Request body must be an object');
    const body = raw as Record<string, unknown>;
    const vaultId = c.req.param('id');
    const credentialId = c.req.param('credentialId');
    const vault = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(vaultId);
    if (!vault) return notFound(c, 'Credential vault not found');
    if (!liveCredential(deps, vaultId, credentialId)) return notFound(c, 'Credential not found');

    appendCredentialAuditEvent(deps.db, {
      vaultId,
      credentialId,
      action: 'mark_used',
      actor: stringField(body.actor),
      metadata: stringRecordField(body.metadata),
      touchLastUsed: true,
    });
    const row = deps.db.prepare('SELECT * FROM credential_records WHERE id = ? AND vault_id = ?').get(credentialId, vaultId) as unknown as CredentialRow;
    return c.json(toCredential(row));
  });

  app.get('/:id/credentials/:credentialId/audit', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, AUDIT_QUERY_PARAMS);
    if (rejected) return rejected;
    const vaultId = c.req.param('id');
    const credentialId = c.req.param('credentialId');
    if (!deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ?').get(vaultId)) {
      return notFound(c, 'Credential vault not found');
    }
    // A deleted credential keeps its history, so the row is read in any state;
    // a credential that never existed in this vault is still a 404.
    if (!deps.db.prepare('SELECT id FROM credential_records WHERE id = ? AND vault_id = ?').get(credentialId, vaultId)) {
      return notFound(c, 'Credential not found');
    }
    return auditPage(c, deps, { vaultId, credentialId });
  });

  app.get('/:id/audit', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, AUDIT_QUERY_PARAMS);
    if (rejected) return rejected;
    const vaultId = c.req.param('id');
    if (!deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ?').get(vaultId)) {
      return notFound(c, 'Credential vault not found');
    }
    return auditPage(c, deps, { vaultId });
  });

  return app;
}

/**
 * One canonical page of the credential audit trail.
 *
 * The listing is ordered `created_at DESC, rowid DESC`, so the position is an offset
 * and the cursor carries that offset together with the scope that produced it: a
 * vault-scoped cursor replayed against a credential listing would address rows that
 * never belonged to that scope. One row beyond `limit` is read so the page can say
 * whether another exists instead of claiming the trail ends here.
 */
function auditPage(
  c: Context,
  deps: ServerDeps,
  scope: { vaultId: string; credentialId?: string },
) {
  // The store defaults to 100 and caps at 500, so the route mirrors the default and
  // lets the store apply the cap: `limit + 1` is the probe row that says whether a
  // next page exists.
  const limit = parseLimit(c.req.query('limit')) ?? 100;
  const filter = normalizeCollectionFilter({
    vault_id: scope.vaultId,
    credential_id: scope.credentialId,
  });
  const rawPage = c.req.query('page');
  const decoded = rawPage === undefined ? { ok: true as const, state: undefined } : decodeCursor(rawPage);
  if (!decoded.ok) return invalid(c, 'page must be a cursor returned by this endpoint');
  const mismatch = cursorQueryMismatch(decoded.state, { filter });
  if (mismatch) return invalid(c, mismatch);
  const offset = readAuditOffset(decoded.state);
  if (offset === undefined) return invalid(c, 'page must be a cursor returned by this endpoint');

  const rows = listCredentialAuditEvents(deps.db, { ...scope, limit: limit + 1, offset });
  const data = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const prevOffset = offset - limit;
  return c.json(cursorPageOf(data, {
    prev: offset > 0 && prevOffset >= 0 ? encodeCursor({ offset: prevOffset, filter }) : null,
    next: hasMore ? encodeCursor({ offset: offset + limit, filter }) : null,
  }));
}

/** The offset an audit cursor carries, or `undefined` for a foreign cursor. */
function readAuditOffset(state?: Record<string, unknown>): number | undefined {
  if (!state) return 0;
  const offset = state.offset;
  return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

/** A credential that can still be used: not archived and not deleted. */
function liveCredential(deps: ServerDeps, vaultId: string, credentialId: string): CredentialRow | undefined {
  return deps.db.prepare(
    "SELECT * FROM credential_records WHERE id = ? AND vault_id = ? AND archived_at IS NULL AND status != 'deleted'",
  ).get(credentialId, vaultId) as CredentialRow | undefined;
}

/** A usable positive `limit` query value, or `undefined` for the default. */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function vaultSelect(where = '') {
  return `
    SELECT v.*,
      (
        SELECT COUNT(*)
        FROM credential_records cr
        WHERE cr.vault_id = v.id AND cr.archived_at IS NULL AND cr.status != 'deleted'
      ) AS credential_count
    FROM credential_vaults v
    ${where}
  `;
}

function toVault(row: VaultRow, deps?: ServerDeps) {
  return {
    id: row.id,
    type: 'credential_vault' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    status: row.archived_at ? 'archived' : row.status,
    credential_count: Number(row.credential_count ?? 0),
    credentials: deps ? listCredentials(deps, row.id) : [],
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function listCredentials(deps: ServerDeps, vaultId: string, options: { includeArchived?: boolean } = {}) {
  // The published contract makes the archived half of a credential listing opt-in:
  // "列出 vault 或凭证：… 默认排除已归档的记录（传递 `include_archived=true` 可将其包含在内）"
  // (`将工作委派给智能体/使用保管库进行身份验证.md:1119`). The exclusion used to be hardcoded
  // here, so a caller who passed the documented parameter was handed a page that omitted
  // exactly the rows they asked for, with nothing in the response saying the filter had been
  // ignored — the same defect this file's vaults listing carried before it was fixed.
  // `toCredential` already labels an archived row (`status: 'archived'` and `archived_at`), so
  // reading the parameter was the only missing piece. Rows with `status = 'deleted'` are
  // excluded either way: deletion is a hard delete that keeps no audit record, which is not
  // what "archived" means.
  const archivedClause = options.includeArchived ? '' : ' AND archived_at IS NULL';
  const rows = deps.db.prepare(
    `SELECT *
     FROM credential_records
     WHERE vault_id = ?${archivedClause} AND status != 'deleted'
     ORDER BY created_at DESC`,
  ).all(vaultId) as unknown as CredentialRow[];
  return rows.map(toCredential);
}

function toCredential(row: CredentialRow) {
  const displayName = row.name ?? '';
  return {
    ...toCanonicalCredential({
      id: row.id,
      vaultId: row.vault_id,
      displayName,
      authType: row.auth_type,
      mcpServerUrl: row.mcp_server_url,
      secretName: row.variable_name,
      injectionLocation: readCanonicalInjectionLocation(row),
      metadata: stringRecordField(parseObject(row.metadata)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    // The local fields stay beside the canonical projection. A Console page renders
    // and searches on `auth_type` / `name` / `variable_name`
    // (`apps/console/src/components/pages/CredentialPages.tsx`,
    // `CredentialVaultPages.tsx`) and `tests/integration/api.test.ts` asserts them,
    // so removing them is a Console migration rather than a wire change. `id` is
    // repeated here because the canonical projection is an index-signature record,
    // which contributes no named properties to the spread.
    id: row.id,
    name: displayName,
    auth_type: row.auth_type,
    mcp_server_url: row.mcp_server_url ?? '',
    variable_name: row.variable_name ?? '',
    value_hint: row.value_hint ?? '',
    network: parseObject(row.network),
    injection_locations: parseStringArray(row.injection_locations),
    status: row.status === 'deleted' ? 'deleted' : row.archived_at ? 'archived' : row.status,
    last_used_at: row.last_used_at ?? null,
    archived_at: row.archived_at ?? null,
  };
}

/** The local token list for a canonical `injection_location`. */
function injectionTokens(location: CredentialInjectionLocation | undefined): string[] {
  if (!location) return [];
  const tokens: string[] = [];
  if (location.header) tokens.push('request_headers');
  if (location.body) tokens.push('request_body');
  return tokens;
}

/** Attach creation warnings only when there are some, so the key stays absent otherwise. */
function withWarnings(credential: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { ...credential, warnings } : credential;
}

/**
 * The canonical `injection_location` of a stored row.
 *
 * The row keeps the local token list, so a credential written before the
 * canonical profile existed still projects a location. An empty list has no
 * canonical reading — the profile refuses a pair with both positions disabled —
 * so the field is omitted rather than sent as false/false.
 */
function readCanonicalInjectionLocation(row: CredentialRow): CredentialInjectionLocation | undefined {
  if (row.auth_type !== 'environment_variable') return undefined;
  const tokens = parseStringArray(row.injection_locations);
  const location = {
    header: tokens.includes('request_headers'),
    body: tokens.includes('request_body'),
  };
  return location.header || location.body ? location : undefined;
}

function normalizeCredentialNetwork(value: unknown) {
  return normalizeCredentialNetworkPolicy(value);
}

function secretHint(value: string) {
  if (!value) return '';
  const visible = value.slice(-4);
  return visible ? `••••${visible}` : '••••';
}

async function updateCredentialState(c: any, deps: ServerDeps, status: 'archived' | 'deleted') {
  const vaultId = c.req.param('id');
  const credentialId = c.req.param('credentialId');
  const vault = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(vaultId);
  if (!vault) return notFound(c, 'Credential vault not found');
  const existing = status === 'deleted'
    ? deps.db.prepare('SELECT * FROM credential_records WHERE id = ? AND vault_id = ? AND status != ?').get(credentialId, vaultId, 'deleted') as CredentialRow | undefined
    : deps.db.prepare('SELECT * FROM credential_records WHERE id = ? AND vault_id = ? AND archived_at IS NULL AND status != ?').get(credentialId, vaultId, 'deleted') as CredentialRow | undefined;
  if (!existing) return notFound(c, 'Credential not found');
  deps.db.prepare(
    'UPDATE credential_records SET status = ?, archived_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ? AND vault_id = ?',
  ).run(status, credentialId, vaultId);
  deps.db.prepare('UPDATE credential_vaults SET updated_at = datetime(\'now\') WHERE id = ?').run(vaultId);
  // The row filter above only admits a credential that was not already in the
  // target state, so reaching here is the transition itself.
  await publishOperationEvent(deps, {
    type: status === 'archived' ? 'vault_credential.archived' : 'vault_credential.deleted',
    subjectId: credentialId,
    extra: { vault_id: vaultId },
  });
  const row = deps.db.prepare('SELECT * FROM credential_records WHERE id = ? AND vault_id = ?').get(credentialId, vaultId) as unknown as CredentialRow;
  return c.json(toCredential(row));
}

interface VaultRow {
  id: string;
  name: string;
  description: string;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  credential_count?: number;
}

interface CredentialRow {
  id: string;
  vault_id: string;
  name: string;
  auth_type: 'mcp_oauth' | 'bearer_token' | 'environment_variable';
  mcp_server_url: string | null;
  variable_name: string | null;
  value_hint: string;
  network: string;
  injection_locations: string;
  secret_ciphertext: string;
  secret_nonce: string;
  secret_tag: string;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  archived_at: string | null;
}
