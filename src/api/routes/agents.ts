/**
 * Agent Routes
 *
 * GET /v1/agents      — list loaded agents
 * GET /v1/agents/:id  — get agent detail
 */

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf, offsetCursorPage, toApiAgent, type ApiCursorPage } from '../standard.js';
import { rejectUnexpectedQueryParams } from './query-params.js';
import { unsupportedCapability } from '../capability-errors.js';
import { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import { parseObject } from './resource-utils.js';
import {
  agentDefinitionsEqual,
  applyAgentUpdatePatch,
  validateAgentUpdateRequest,
} from '@/core/agent/update.js';
import {
  loadActiveAgentRows,
  loadAgentRowById,
  parseAgentDefinitionFromRow,
  refreshAgentsFromDb,
} from '@/core/agent/store.js';

export function agentsRoutes(deps: ServerDeps) {
  const app = new Hono();

  // GET / — List agents
  app.get('/', (c) => {
    // Admission first, like every other listing route: a parameter this listing does not
    // implement used to be ignored, so `?limit=5` answered a page as though the request had been
    // understood. The accept list is empty because the listing implements no parameter, and four
    // measurements agree. Of the 21 published `/v1/agents` lines, only two carry a query string and
    // both are `?beta=true`, the compatibility parameter this route layer already accepts and
    // ignores. No cursor pagination is documented for the listing at all: `before_id`, `after_id`,
    // `has_more` and `page_token` appear zero times across the published docs, and the documented
    // `limit`/`page`/`next_page` convention is shown for `/v1/sessions`. This repository's contract
    // names `/v1/agents`, with its versions, in the group of collections that return their whole
    // set (`pagination.md`). And no local caller passes a query string.
    //
    // Deliberately NOT applied to `GET /:id/versions` in this file: the published contract states
    // that the version history listing *is* paginated (`智能体设置.md`), so refusing its `limit` or
    // `page` would refuse a capability a caller was promised.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const agents = loadActiveAgentRows(deps.db).flatMap((row) => {
      const agent = parseAgentDefinitionFromRow(row);
      return agent ? [toApiAgent(agent, agentRowMetaFromRow(row))] : [];
    });
    return c.json(cursorPageOf(agents, {}));
  });

  // POST / — Create a standard agent definition in SQLite.
  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }

    const result = validateAgentDefinition(body);
    if (!result.valid || !result.data) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Invalid agent definition', details: result.errors } }, 400);
    }

    const agent = result.data;
    try {
      deps.sessionManager.assertAgentCapabilities(agent);
    } catch (error) {
      if (error instanceof UnsupportedCapabilityError) return unsupportedCapability(c, error);
      throw error;
    }
    const id = createAgentId(deps);

    deps.db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      id,
      agent.name,
      JSON.stringify(agent),
    );
    insertAgentVersion(deps, id, 1, agent.name, agent);
    refreshAgentsFromDb(deps.db, deps.agents);

    return c.json(toApiAgent(agent, agentRowMeta(deps, id)), 201);
  });

  app.get('/:id/versions', (c) => {
    // This listing is paginated in the published contract, unlike the agent list next door: the
    // documented clients walk it with the SDK's `autoPager()` (`智能体设置.md`), and
    // `会话操作.md` documents the convention itself — `limit` sets the page size and the
    // `next_page` cursor is handed back as the `page` parameter. It previously ignored both and
    // answered its whole set.
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'page']);
    if (rejected) return rejected;
    const id = c.req.param('id');
    const row = activeAgentRow(deps, id);
    const agent = row ? parseAgentDefinitionFromRow(row) : undefined;
    if (!row || !agent) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    const versions = loadAgentVersions(deps, id);
    // An agent with no recorded history still reports its current definition as one version.
    const rows = versions.length === 0 ? [toApiAgent(agent, agentRowMetaFromRow(row))] : versions;
    const page = agentVersionsPage(rows, { limit: c.req.query('limit'), page: c.req.query('page') });
    if (!page.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: page.message } }, 400);
    }
    return c.json(page.page);
  });

  const updateAgent = async (c: any) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }

    const id = c.req.param('id');
    const existing = activeAgentRow(deps, id);
    if (!existing) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }

    // Partial-update semantics: validate the fields the body actually carries,
    // merge them onto the stored definition, then revalidate the merged result
    // so a request that changes one side of a coupled pair is judged on the
    // pair it produces.
    const patch = validateAgentUpdateRequest(body);
    if (!patch.valid) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Invalid agent update', details: patch.errors } }, 400);
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== (existing.version ?? 1)) {
      return c.json({
        error: {
          type: 'conflict',
          message: `Agent ${id} is at version ${existing.version ?? 1}; expected version ${patch.expectedVersion}`,
        },
      }, 409);
    }

    // Read the stored definition the way every other read path does, so a row
    // written before `effort` moved inside the profile is folded before the patch
    // is merged onto it. Parsing the column directly would hand the merge a sibling
    // `effort`, the non-strict schema would strip it on revalidation, and a caller
    // who changed only the description would silently lose the level.
    //
    // The raw object is still what an unreadable row is merged from: a request that
    // would change something has to be judged on the definition it produces — an
    // invalid definition rather than a missing one — and only the no-change branch
    // below refuses it as missing.
    const parsed = parseAgentDefinitionFromRow(existing);
    const current = parsed ?? (parseObject(existing.definition) as Record<string, unknown>);
    const merged = applyAgentUpdatePatch(current as never, patch.fields);
    if (agentDefinitionsEqual(current, merged)) {
      // No field actually changed, so no new immutable version is written. The
      // response is the agent, built the way `GET /:id` builds it: from the
      // **parsed** definition. This branch used to pass `existing.definition` —
      // the raw JSON string from the column — into `toApiAgent`, which reads
      // properties off its argument, so every read was `undefined` and the caller
      // got an object with `name`, `system` and `model` absent and `description`,
      // `tools`, `skills` and `metadata` zeroed, while `id` and `version` stayed
      // correct. That is the branch an idempotent re-`PUT` takes, so the fabricated
      // body arrived on the ordinary retry path.
      if (!parsed) {
        // A stored definition `GET /:id` also refuses to serve. Answering the same
        // 404 keeps this branch from being the one place that projects an
        // unreadable definition into a well-formed-looking resource.
        return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
      }
      return c.json(toApiAgent(parsed, agentRowMeta(deps, id)));
    }

    const result = validateAgentDefinition(merged);
    if (!result.valid || !result.data) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Invalid agent definition', details: result.errors } }, 400);
    }

    const agent = result.data;
    try {
      deps.sessionManager.assertAgentCapabilities(agent);
    } catch (error) {
      if (error instanceof UnsupportedCapabilityError) return unsupportedCapability(c, error);
      throw error;
    }

    deps.db.prepare(`
      UPDATE agents
      SET name = ?,
          definition = ?,
          status = 'active',
          error_message = NULL,
          archived_at = NULL,
          version = COALESCE(version, 1) + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(agent.name, JSON.stringify(agent), id);

    const nextVersion = (existing.version ?? 1) + 1;
    insertAgentVersion(deps, id, nextVersion, agent.name, agent);

    refreshAgentsFromDb(deps.db, deps.agents);

    return c.json(toApiAgent(agent, agentRowMeta(deps, id)));
  };

  // Partial-update semantics rather than a full replace: a `PUT` that silently
  // cleared every field the body omitted would be a data-loss path, and the
  // Console editor only ever shows a subset of the definition.
  app.put('/:id', updateAgent);

  // The published update verb is `POST` on this path: both published examples send a
  // body with `curl -d` and no `-X` (which curl issues as `POST`), while the same file
  // writes `-X POST` out explicitly for archive — so the omission is meaningful, and
  // no `PUT` or `PATCH` spelling appears anywhere in the published documentation. The
  // runtime mounted only `PUT`, so a caller following the contract built a request the
  // documentation said would work and got a 404. Both verbs take one handler reference
  // rather than a second copy, because the published operation and the local spelling
  // are the same operation; this contract's §1 already treats the verb as part of an
  // endpoint's identity (`contracts/anthropic-cma/routes.md:24`).
  app.post('/:id', updateAgent);

  app.post('/:id/archive', (c) => {
    const id = c.req.param('id');
    const existing = activeAgentRow(deps, id);
    if (!existing) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    const agent = parseAgentDefinitionFromRow(existing);
    deps.db.prepare(`
      UPDATE agents
      SET status = 'archived',
          archived_at = COALESCE(archived_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    refreshAgentsFromDb(deps.db, deps.agents);
    return c.json(agent ? toApiAgent(agent, agentRowMeta(deps, id)) : { id, status: 'archived' });
  });

  // GET /:id — Get agent detail
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = activeAgentRow(deps, id);
    const agent = row ? parseAgentDefinitionFromRow(row) : undefined;
    if (!row || !agent) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    return c.json(toApiAgent(agent, agentRowMetaFromRow(row)));
  });

  return app;
}

function agentRowMeta(deps: ServerDeps, id: string) {
  const row = loadAgentRowById(deps.db, id);
  if (!row) return undefined;
  return agentRowMetaFromRow(row);
}

function agentRowMetaFromRow(row: {
  id: string;
  loaded_at?: string;
  updated_at?: string;
  status?: string;
  version?: number;
  archived_at?: string | null;
}) {
  return {
    id: row.id,
    createdAt: row.loaded_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    status: row.status === 'archived' || row.archived_at ? 'archived' as const : 'active' as const,
    version: row.version ?? 1,
  };
}

function activeAgentRow(deps: ServerDeps, id: string) {
  const row = loadAgentRowById(deps.db, id);
  if (!row || row.status === 'archived' || row.archived_at) return undefined;
  return row;
}

function loadAgentVersions(deps: ServerDeps, agentId: string) {
  const rows = deps.db.prepare(`
    SELECT id, agent_id, version, name, definition, created_at
    FROM agent_versions
    WHERE agent_id = ?
    ORDER BY version DESC
  `).all(agentId) as Array<{
    id: string;
    agent_id: string;
    version: number;
    name: string;
    definition: string;
    created_at: string;
  }>;
  return rows.flatMap((row) => {
    const agent = parseAgentDefinitionFromRow(row);
    return agent ? [toApiAgent(agent, {
      id: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.created_at,
      archivedAt: null,
      status: 'active',
      version: row.version,
    })] : [];
  });
}

function insertAgentVersion(deps: ServerDeps, agentId: string, version: number, name: string, agent: unknown) {
  deps.db.prepare(`
    INSERT OR IGNORE INTO agent_versions (id, agent_id, version, name, definition, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(`agver_${nanoid(18)}`, agentId, version, name, JSON.stringify(agent));
}

function expectedVersionFromBody(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>).expected_version;
  if (value === undefined) return undefined;
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function createAgentId(deps: ServerDeps): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `agent_${nanoid(24)}`;
    const existing = deps.db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!existing) return id;
  }
  throw new Error('Unable to allocate unique agent id');
}

/**
 * One canonical page of the agent version history.
 *
 * Mirrors the skills pager: the window is an offset carried by the cursor, a malformed cursor is
 * refused rather than read as page one, and the limit is clamped into 1..100 with a default of 20.
 * The cursor also carries the (empty) filter so a cursor cannot be replayed against a different one.
 */
function agentVersionsPage<T>(
  rows: T[],
  options: { limit?: string; page?: string },
): { ok: true; page: ApiCursorPage<T> } | { ok: false; message: string } {
  // The window semantics live in one place; this listing has no filter to carry.
  return offsetCursorPage(rows, { limit: options.limit, page: options.page });
}