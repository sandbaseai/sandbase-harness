import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf, offsetCursorPage, ApiCursorPage } from '../standard.js';
import { publishOperationEvent } from './operation-events.js';
import {
  COLLECTION_LISTING_QUERY_PARAMS,
  INCLUDE_ARCHIVED_PARAM,
  parseCollectionWindow,
  parseIncludeArchived,
  rejectUnexpectedQueryParams,
} from './query-params.js';
import {
  applyMemoryListScope,
  checkMemorySize,
  checkStoreCapacity,
  memoryContentBytes,
  memoryContentHash,
  evaluateContentPrecondition,
  validateMemoryListScope,
} from '@/core/memory/semantics.js';
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
import { isTerminal } from '@/core/session/state-machine.js';
import type { SessionStatus } from '@/types/session.js';

type ResourceKind = 'memory_store';

/**
 * The memory-store listing's ordering, as the token a page cursor carries.
 *
 * It names the collection as well as the sort, so a cursor issued by the vault
 * listing is refused here rather than counted against a different collection.
 */
const MEMORY_STORE_LIST_ORDER = 'memory_stores.created_at DESC, rowid DESC';

export function memoryStoreRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/memory_stores', (c) => {
    // Admission first, through the same list the vault listing passes: both read the
    // same three parameters, so a parameter one of them refused and the other ignored
    // would be the drift the shared readings exist to prevent.
    const rejected = rejectUnexpectedQueryParams(c, COLLECTION_LISTING_QUERY_PARAMS);
    if (rejected) return rejected;
    // The published contract makes the archived half of the collection opt-in:
    // "默认排除已归档的存储；传递 `include_archived: true` 可将其包含在内"
    // (`管理智能体上下文/记忆存储.md:1206`), and its worked example is
    // `?include_archived=true` (`:1210`). The exclusion used to be hardcoded here, so a
    // caller who passed the documented parameter was handed a page that omitted exactly
    // the rows they asked for, with nothing saying the filter had been ignored.
    // `toMemoryStore` already labels an archived store, so only the `WHERE` was missing.
    // The parameter is read by the same helper the vault listing uses, so the two
    // collections cannot come to accept different values for it.
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;

    // The published pagination rule applies here too, read by the same helper as the
    // vault listing so the two collections cannot come to accept different values for
    // `limit`/`page` either. The cursor carries this collection's ordering and the
    // archived filter that produced the page.
    const window = parseCollectionWindow(c, {
      order: MEMORY_STORE_LIST_ORDER,
      filter: includeArchived.value ? { [INCLUDE_ARCHIVED_PARAM]: 'true' } : {},
    });
    if (!window.ok) return window.response;

    const where = includeArchived.value ? '' : 'WHERE m.archived_at IS NULL';
    // The same tie-break as the vault listing, for the same reason: `created_at` is
    // `datetime('now')`, so stores created in one second share a timestamp and the
    // order within that group has to be decided by something.
    const rows = deps.db.prepare(`${memoryStoreSelect(where)} ORDER BY m.created_at DESC, m.rowid DESC`).all() as unknown as MemoryStoreRow[];
    return c.json(window.value.slice(rows.map((row) => toMemoryStore(row, deps))));
  });

  app.post('/memory_stores', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const id = `memstore_${nanoid(18)}`;
    try {
      deps.db.prepare(
        'INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        name,
        stringField(body.value.description) ?? '',
        stringField(body.value.provider) ?? 'sqlite',
        JSON.stringify(objectField(body.value.config)),
        JSON.stringify(stringRecordField(body.value.metadata)),
      );
      const row = deps.db.prepare(memoryStoreSelect('WHERE m.id = ? AND m.archived_at IS NULL')).get(id) as unknown as MemoryStoreRow;
      await publishOperationEvent(deps, { type: 'memory_store.created', subjectId: id });
      return c.json(toMemoryStore(row, deps), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Memory store id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/memory_stores/:id', (c) => {
    const row = deps.db.prepare(memoryStoreSelect('WHERE m.id = ? AND m.archived_at IS NULL')).get(c.req.param('id')) as MemoryStoreRow | undefined;
    return row ? c.json(toMemoryStore(row, deps)) : notFound(c, 'Memory store not found');
  });

  // `POST` is the published update verb; `PUT` stays as the local alias — both
  // run the same patch semantics.
  app.post('/memory_stores/:id', updateMemoryStore);
  app.put('/memory_stores/:id', updateMemoryStore);

  app.delete('/memory_stores/:id', async (c) => {
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) return notFound(c, 'Memory store not found');
    // A session mounts a store through a `session_resource_instances` row
    // whose config names it — a soft reference with no foreign key, so a
    // finished session's mount is history while a live session still reads
    // the store. Only the live one blocks the delete.
    const mounted = deps.db.prepare(
      `SELECT s.status FROM sessions s
       JOIN session_resource_instances sri ON sri.session_id = s.id
       WHERE sri.resource_type = 'memory_store'
         AND sri.deleted_at IS NULL
         AND json_extract(sri.config, '$.memory_store_id') = ?`,
    ).all(id) as Array<{ status: SessionStatus }>;
    if (mounted.some((row) => !isTerminal(row.status))) {
      return conflict(c, 'Memory store is mounted by an active session', 'memory_store_in_use');
    }
    deps.db.transaction(() => {
      deps.db.prepare('DELETE FROM memory_versions WHERE store_id = ?').run(id);
      deps.db.prepare('DELETE FROM memory_records WHERE store_id = ?').run(id);
      deps.db.prepare('DELETE FROM memory_stores WHERE id = ?').run(id);
    });
    await publishOperationEvent(deps, { type: 'memory_store.deleted', subjectId: id });
    return c.json({ id, type: 'memory_store_deleted' });
  });

  async function updateMemoryStore(c: any) {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM memory_stores WHERE id = ?').get(id) as MemoryStoreRow | undefined;
    if (!existing) return notFound(c, 'Memory store not found');
    if (existing.archived_at) {
      return conflict(c, 'Memory store is archived and read-only', 'memory_store_archived');
    }

    const name = stringField(body.value.name) ?? existing.name;
    if (body.value.name !== undefined && body.value.name !== null) {
      // The published bound: 1–255 characters, no control characters.
      if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) {
        return invalid(c, 'name must be 1-255 characters without control characters');
      }
    }
    if (body.value.metadata !== undefined && body.value.metadata !== null && !isPlainObject(body.value.metadata)) {
      return invalid(c, 'metadata must be an object');
    }
    try {
      deps.db.prepare(
        'UPDATE memory_stores SET name = ?, description = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(
        name,
        descriptionPatch(body.value.description, existing.description),
        JSON.stringify(mergeMetadataPatch(existing.metadata, body.value.metadata)),
        id,
      );
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Memory store name already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
    const row = deps.db.prepare(memoryStoreSelect('WHERE m.id = ?')).get(id) as unknown as MemoryStoreRow;
    return c.json(toMemoryStore(row, deps));
  }

  app.get('/memory_stores/:id/memories', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['path_prefix', 'depth', 'view']);
    if (rejected) return rejected;
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!store) return notFound(c, 'Memory store not found');
    // `path_prefix` must be an absolute path ending in `/`, and `depth` must be
    // 0 or 1. Matching is segment-based and depth 1 lists only direct children.
    const scope = validateMemoryListScope(
      c.req.query('path_prefix'),
      c.req.query('depth') === undefined ? undefined : Number(c.req.query('depth')),
    );
    if (!scope.ok) return invalid(c, scope.message!);
    // The published default for a listing is `basic`: the page carries the hash
    // and byte size of each memory but not its content.
    const view = parseMemoryView(c, 'basic');
    if (!view.ok) return view.response;
    const memories = applyMemoryListScope(listMemories(deps, c.req.param('id'), view.view), {
      prefix: scope.prefix,
      depth: scope.depth,
    });
    return c.json(cursorPageOf(memories, {}));
  });

  app.get('/memory_stores/:id/memories/:memoryId', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['view']);
    if (rejected) return rejected;
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!store) return notFound(c, 'Memory store not found');
    const row = deps.db.prepare(
      'SELECT * FROM memory_records WHERE id = ? AND store_id = ? AND archived_at IS NULL',
    ).get(c.req.param('memoryId'), c.req.param('id')) as MemoryRecordRow | undefined;
    if (!row) return notFound(c, 'Memory not found');
    // A single-memory read is a retrieve: the published default is `full`.
    const view = parseMemoryView(c, 'full');
    if (!view.ok) return view.response;
    return c.json(toMemory(row, deps, view.view));
  });

  app.post('/memory_stores/:id/memories', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const storeId = c.req.param('id');
    const store = writableStore(c, deps, storeId);
    if (store instanceof Response) return store;
    const path = memoryPath(body.value.path);
    if (!path) return invalid(c, 'path is required and must start with /');
    const content = typeof body.value.content === 'string' ? body.value.content : '';
    // The published caps are enforced here rather than left to the caller, so a
    // store cannot be filled past its capacity or its per-memory size budget by
    // a client that ignores them.
    const size = checkMemorySize(content);
    if (!size.ok) return invalid(c, size.message!, size.code);
    const capacity = checkStoreCapacity(
      (deps.db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE store_id = ? AND archived_at IS NULL').get(storeId) as { count: number }).count,
    );
    if (!capacity.ok) return conflict(c, capacity.message!, capacity.code);
    const view = parseMemoryView(c, 'basic');
    if (!view.ok) return view.response;
    const id = `mem_${nanoid(18)}`;
    const now = new Date().toISOString();
    try {
      deps.db.prepare(
        `INSERT INTO memory_records (id, store_id, path, content, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, storeId, path, content, JSON.stringify(stringRecordField(body.value.metadata)), now, now);
      deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
      recordMemoryVersion(deps, storeId, id, path, content, 'created', now);
      const row = deps.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as unknown as MemoryRecordRow;
      return c.json(toMemory(row, deps, view.view), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return memoryPathConflict(c, deps, storeId, path);
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  // `POST` is the published update verb; `PUT` stays as the local alias — both
  // run the same write semantics.
  app.post('/memory_stores/:id/memories/:memoryId', updateMemory);
  app.put('/memory_stores/:id/memories/:memoryId', updateMemory);

  async function updateMemory(c: any) {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const storeId = c.req.param('id');
    const memoryId = c.req.param('memoryId');
    const store = writableStore(c, deps, storeId);
    if (store instanceof Response) return store;
    const existing = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(memoryId, storeId) as MemoryRecordRow | undefined;
    if (!existing) return notFound(c, 'Memory not found');
    const path = body.value.path === undefined ? existing.path : memoryPath(body.value.path);
    if (!path) return invalid(c, 'path must start with /');
    const content = typeof body.value.content === 'string' ? body.value.content : existing.content;
    const size = checkMemorySize(content);
    if (!size.ok) return invalid(c, size.message!, size.code);
    const view = parseMemoryView(c, 'basic');
    if (!view.ok) return view.response;
    // A precondition refuses a write whose content moved underneath the caller.
    // The refusal reports the current hash so the caller can retry without a
    // separate re-read — unless the stored state already matches the requested
    // write exactly, which the published contract answers with the memory itself.
    const precondition = evaluateContentPrecondition(body.value.precondition, existing.content);
    if (!precondition.ok) {
      if (precondition.code === 'invalid_precondition') {
        return conflict(c, precondition.message!, precondition.code);
      }
      if (path === existing.path && content === existing.content) {
        return c.json(toMemory(existing, deps, view.view));
      }
      // The current hash is surfaced as its own field as well as inside the
      // message, so a caller can retry without parsing prose.
      return c.json(
        {
          error: {
            type: 'memory_precondition_failed_error',
            code: precondition.code,
            message: precondition.message,
            current_content_sha256: memoryContentHash(existing.content),
          },
        },
        409,
      );
    }
    try {
      deps.db.prepare(
        'UPDATE memory_records SET path = ?, content = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ? AND store_id = ?',
      ).run(
        path,
        content,
        JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : stringRecordField(body.value.metadata)),
        memoryId,
        storeId,
      );
      deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
      recordMemoryVersion(deps, storeId, memoryId, path, content, 'updated', new Date().toISOString());
      const row = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ?').get(memoryId, storeId) as unknown as MemoryRecordRow;
      return c.json(toMemory(row, deps, view.view));
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return memoryPathConflict(c, deps, storeId, path, memoryId);
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  }

  app.delete('/memory_stores/:id/memories/:memoryId', async (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['expected_content_sha256']);
    if (rejected) return rejected;
    const storeId = c.req.param('id');
    const memoryId = c.req.param('memoryId');
    const store = writableStore(c, deps, storeId);
    if (store instanceof Response) return store;
    const existing = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(memoryId, storeId) as MemoryRecordRow | undefined;
    if (!existing) return notFound(c, 'Memory not found');
    // `expected_content_sha256` is the delete-side precondition: a caller that
    // read the memory earlier cannot delete a memory that has since changed.
    const expected = c.req.query('expected_content_sha256');
    if (expected !== undefined && expected !== memoryContentHash(existing.content)) {
      return c.json(
        {
          error: {
            type: 'memory_precondition_failed_error',
            code: 'precondition_failed',
            message: 'expected_content_sha256 does not match the memory\'s current content hash',
            current_content_sha256: memoryContentHash(existing.content),
          },
        },
        409,
      );
    }
    deps.db.prepare('UPDATE memory_records SET archived_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ? AND store_id = ?').run(memoryId, storeId);
    deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
    recordMemoryVersion(deps, storeId, memoryId, existing.path, existing.content, 'deleted', new Date().toISOString());
    return c.json({ id: memoryId, type: 'memory_deleted' });
  });

  app.post('/memory_stores/:id/archive', async (c) => {
    const response = archiveResource(c, deps, 'memory_stores', (row) => toMemoryStore(row, deps));
    if (response.status === 200) {
      await publishOperationEvent(deps, { type: 'memory_store.archived', subjectId: c.req.param('id') });
    }
    return response;
  });

  // Every write records a version, so the history of a memory is reconstructable
  // without diffing snapshots of the store.
  app.get('/memory_stores/:id/memory_versions', (c) => {
    // This listing is paginated in the published contract: the documented clients walk it with the
    // SDK's `autoPager()` (`记忆存储.md`), and `会话操作.md` documents the convention — `limit` sets
    // the page size and the `next_page` cursor is handed back as `page`. It previously refused both
    // and answered its whole set.
    const rejected = rejectUnexpectedQueryParams(c, ['memory_id', 'limit', 'page', 'view', 'operation']);
    if (rejected) return rejected;
    const storeId = c.req.param('id');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const memoryId = c.req.query('memory_id');
    // `operation` is the published filter and uses the published vocabulary —
    // `modified` is stored as `updated` so existing rows keep their meaning.
    const operation = c.req.query('operation');
    if (operation !== undefined && !OFFICIAL_MEMORY_OPERATIONS.has(operation)) {
      return invalid(c, `operation must be one of: ${[...OFFICIAL_MEMORY_OPERATIONS].join(', ')}`);
    }
    const view = parseMemoryView(c, 'basic');
    if (!view.ok) return view.response;
    const storedOperation = operation === 'modified' ? 'updated' : operation;
    const rows = (memoryId
      ? deps.db.prepare(
        'SELECT * FROM memory_versions WHERE store_id = ? AND memory_id = ? ORDER BY version DESC',
      ).all(storeId, memoryId)
      : deps.db.prepare(
        'SELECT * FROM memory_versions WHERE store_id = ? ORDER BY created_at DESC',
      ).all(storeId)) as unknown as MemoryVersionRow[];
    const filtered = storedOperation ? rows.filter((row) => row.change === storedOperation) : rows;
    const page = memoryVersionsPage(filtered.map((row) => toMemoryVersion(row, view.view)), {
      limit: c.req.query('limit'),
      page: c.req.query('page'),
      memoryId,
    });
    if (!page.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: page.message } }, 400);
    }
    return c.json(page.page);
  });

  app.get('/memory_stores/:id/memory_versions/:versionId', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['view']);
    if (rejected) return rejected;
    const storeId = c.req.param('id');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const row = deps.db.prepare(
      'SELECT * FROM memory_versions WHERE id = ? AND store_id = ?',
    ).get(c.req.param('versionId'), storeId) as unknown as MemoryVersionRow | undefined;
    if (!row) return notFound(c, 'Memory version not found');
    const view = parseMemoryView(c, 'full');
    if (!view.ok) return view.response;
    return c.json(toMemoryVersion(row, view.view));
  });

  // Redaction clears what a version recorded while keeping the row — the
  // published contract keeps the version itself listable with its payload
  // fields nulled and `redacted_at` set. The head version is refused because
  // redacting it would orphan the memory's current content.
  app.post('/memory_stores/:id/memory_versions/:versionId/redact', (c) => {
    const storeId = c.req.param('id');
    const versionId = c.req.param('versionId');
    const store = writableStore(c, deps, storeId);
    if (store instanceof Response) return store;
    const version = deps.db.prepare(
      'SELECT * FROM memory_versions WHERE id = ? AND store_id = ?',
    ).get(versionId, storeId) as unknown as MemoryVersionRow | undefined;
    if (!version) return notFound(c, 'Memory version not found');
    const head = deps.db.prepare(
      'SELECT id FROM memory_versions WHERE store_id = ? AND memory_id = ? ORDER BY version DESC LIMIT 1',
    ).get(storeId, version.memory_id) as { id: string } | undefined;
    if (head?.id === versionId) {
      return c.json(
        { error: { type: 'conflict_error', code: 'memory_version_is_head', message: 'Cannot redact the memory\'s current version' } },
        409,
      );
    }
    // Redacting an already-redacted version is a no-op that answers the version
    // as it now stands — the row is already in its terminal redacted state.
    if (!version.redacted_at) {
      deps.db.prepare(
        `UPDATE memory_versions
         SET content = NULL, content_sha256 = NULL, content_size_bytes = NULL, path = NULL,
             redacted_at = datetime('now')
         WHERE id = ?`,
      ).run(versionId);
    }
    const row = deps.db.prepare('SELECT * FROM memory_versions WHERE id = ?').get(versionId) as unknown as MemoryVersionRow;
    return c.json(toMemoryVersion(row, 'full'));
  });

  return app;
}

/**
 * Append a memory version.
 *
 * `content` is captured as it was written, so a later redaction can replace the
 * stored text without losing the fact that a version existed. Numbering is per
 * memory and monotonic, and the unique index refuses a second writer claiming a
 * version that already exists rather than letting it overwrite the first.
 */
function recordMemoryVersion(
  deps: ServerDeps,
  storeId: string,
  memoryId: string,
  path: string,
  content: string,
  change: 'created' | 'updated' | 'deleted',
  now: string,
  sessionId?: string,
): void {
  const next = deps.db.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_versions WHERE store_id = ? AND memory_id = ?',
  ).get(storeId, memoryId) as unknown as { version: number } | undefined;
  deps.db.prepare(
    `INSERT INTO memory_versions
       (id, store_id, memory_id, version, path, content, content_sha256, content_size_bytes, change, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `memver_${nanoid(18)}`,
    storeId,
    memoryId,
    next?.version ?? 1,
    path,
    content,
    memoryContentHash(content),
    memoryContentBytes(content),
    change,
    sessionId ?? null,
    now,
  );
}

const OFFICIAL_MEMORY_OPERATIONS = new Set(['created', 'modified', 'deleted']);

/**
 * The published `memory_version` object. The stored `change` column keeps its
 * local vocabulary (`updated`) so existing rows stay meaningful; the projection
 * emits the published `modified`. A `deleted` version and a redacted version
 * both null their payload fields; redaction additionally nulls `path`.
 */
function toMemoryVersion(row: MemoryVersionRow, view: MemoryView = 'basic') {
  const redacted = Boolean(row.redacted_at);
  const deleted = row.change === 'deleted';
  return {
    id: row.id,
    type: 'memory_version',
    memory_id: row.memory_id,
    memory_store_id: row.store_id,
    operation: row.change === 'updated' ? 'modified' : row.change,
    created_at: row.created_at,
    content: view === 'full' && !redacted && !deleted ? row.content : null,
    content_sha256: redacted || deleted ? null : row.content_sha256,
    content_size_bytes: redacted || deleted ? null : row.content_size_bytes,
    path: redacted ? null : row.path,
    created_by: row.session_id
      ? { type: 'session_actor', session_id: row.session_id }
      : null,
    redacted_at: row.redacted_at ?? null,
  };
}

function memoryStoreSelect(where = '') {
  return `
    SELECT m.*,
      (
        SELECT COUNT(*)
        FROM memory_records mr
        WHERE mr.store_id = m.id AND mr.archived_at IS NULL
      ) AS memory_count
    FROM memory_stores m
    ${where}
  `;
}

function toMemoryStore(row: MemoryStoreRow, deps?: ServerDeps) {
  return {
    id: row.id,
    type: 'memory_store' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    provider: row.provider,
    status: row.archived_at ? 'archived' : row.status,
    memory_count: Number(row.memory_count ?? 0),
    memories: deps ? listMemories(deps, row.id) : [],
    config: parseObject(row.config),
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function listMemories(deps: ServerDeps, storeId: string, view: MemoryView = 'full') {
  const rows = deps.db.prepare(
    `SELECT *
     FROM memory_records
     WHERE store_id = ? AND archived_at IS NULL
     ORDER BY path ASC`,
  ).all(storeId) as unknown as MemoryRecordRow[];
  return rows.map((row) => toMemory(row, deps, view));
}

/**
 * The published `memory` object: `store_id` is `memory_store_id`, the content
 * digest is `content_sha256`, and `memory_version_id` names the version row
 * that recorded the current state. `content` is populated only under `view=full`;
 * the `basic` view still carries the hash and byte size so a client can diff
 * without fetching content.
 */
function toMemory(row: MemoryRecordRow, deps: ServerDeps, view: MemoryView = 'basic') {
  const content = row.content ?? '';
  const head = deps.db.prepare(
    'SELECT id FROM memory_versions WHERE store_id = ? AND memory_id = ? ORDER BY version DESC LIMIT 1',
  ).get(row.store_id, row.id) as { id: string } | undefined;
  return {
    id: row.id,
    type: 'memory',
    memory_store_id: row.store_id,
    memory_version_id: head?.id ?? null,
    path: row.path,
    content: view === 'full' ? content : null,
    content_sha256: memoryContentHash(content),
    content_size_bytes: memoryContentBytes(content),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type MemoryView = 'basic' | 'full';

/** `view` accepts only the published pair; anything else is a 400. */
function parseMemoryView(c: any, fallback: MemoryView): { ok: true; view: MemoryView } | { ok: false; response: Response } {
  const raw = c.req.query('view');
  if (raw === undefined) return { ok: true, view: fallback };
  if (raw === 'basic' || raw === 'full') return { ok: true, view: raw };
  return { ok: false, response: invalid(c, "view must be 'basic' or 'full'") };
}

/**
 * The published path-conflict error: the write refused because another memory
 * already holds the requested path. The blocking memory's id is included when
 * it can be identified.
 */
function memoryPathConflict(c: any, deps: ServerDeps, storeId: string, path: string, excludeMemoryId?: string) {
  const blocker = deps.db.prepare(
    'SELECT id FROM memory_records WHERE store_id = ? AND path = ? AND archived_at IS NULL',
  ).get(storeId, path) as { id: string } | undefined;
  return c.json(
    {
      error: {
        type: 'memory_path_conflict_error',
        message: `Memory already exists at path: ${path}`,
        conflicting_path: path,
        conflicting_memory_id: blocker && blocker.id !== excludeMemoryId ? blocker.id : '',
      },
    },
    409,
  );
}

/**
 * The store a write may target, or the refusal it earns. An archived store is
 * read-only by the published contract, so a write to one is a `409` naming the
 * state rather than the `404` a missing store gets — "read-only" and "absent"
 * are different answers and a retry cannot fix either.
 */
function writableStore(c: any, deps: ServerDeps, storeId: string): { id: string } | Response {
  const store = deps.db.prepare('SELECT id, archived_at FROM memory_stores WHERE id = ?').get(storeId) as
    | { id: string; archived_at: string | null }
    | undefined;
  if (!store) return notFound(c, 'Memory store not found');
  if (store.archived_at) {
    return conflict(c, 'Memory store is archived and read-only', 'memory_store_archived');
  }
  return store;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The published `description` patch: omitted preserves the stored value,
 * `null` clears it, and an empty or whitespace-only string is stored as an
 * empty string.
 */
function descriptionPatch(incoming: unknown, stored: string | null): string {
  if (incoming === undefined) return stored ?? '';
  if (incoming === null) return '';
  return stringField(incoming) ?? '';
}

/**
 * Merge a `metadata` patch onto the stored bag. The published contract deletes
 * a key on a `null` **or** empty-string value; an omitted or whole `null`
 * field preserves the bag unchanged.
 */
function mergeMetadataPatch(stored: string | null | undefined, patch: unknown): Record<string, unknown> {
  const merged = parseObject(stored);
  if (patch === undefined || patch === null) return merged;
  for (const [key, value] of Object.entries(objectField(patch))) {
    if (value === null || value === '') delete merged[key];
    else merged[key] = String(value);
  }
  return merged;
}

function memoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const normalized = trimmed.replace(/\/+/g, '/');
  if (normalized === '/' || normalized.endsWith('/')) return undefined;
  return normalized;
}

interface MemoryStoreRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  status: string;
  config: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  memory_count?: number;
}

interface MemoryVersionRow {
  id: string;
  store_id: string;
  memory_id: string;
  version: number;
  path: string | null;
  content: string | null;
  content_sha256: string | null;
  content_size_bytes: number | null;
  change: string;
  session_id: string | null;
  created_at: string;
  redacted_at: string | null;
}

interface MemoryRecordRow {
  id: string;
  store_id: string;
  path: string;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/**
 * One canonical page of a memory store's version history.
 *
 * Mirrors the skills and agent-history pagers: the window is an offset carried by the cursor, the
 * cursor also carries the `memory_id` filter that produced it, a malformed cursor is refused rather
 * than read as page one, and the limit is clamped into 1..100 with a default of 20. An absent cursor
 * means the first page — offset 0 — and only a *present* cursor must carry a usable offset.
 */
function memoryVersionsPage<T>(
  rows: T[],
  options: { limit?: string; page?: string; memoryId?: string },
): { ok: true; page: ApiCursorPage<T> } | { ok: false; message: string } {
  // This listing is filtered by memory, so the filter travels inside the cursor.
  return offsetCursorPage(rows, { limit: options.limit, page: options.page, filter: { memory_id: options.memoryId } });
}