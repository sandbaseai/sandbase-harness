/**
 * Session work token scope — what a `mawt_...` bearer may call beyond the
 * Work API itself.
 *
 * The token is minted per claim inside a work item's `secret` and hands a
 * worker exactly the session-level calls the published worker flow needs,
 * without giving it an API key or the environment key: fetch its session
 * (the `resources` list tells it which memory stores and files to
 * materialize and the `agent.skills` list which skill packages to download),
 * read and answer the session's event log, fetch the content of exactly the
 * skill versions the agent assigns, download the file resources the session
 * attached, and read or write the memory stores that session attached. The
 * binding is enforced here,
 * not by the request's own claims: the session id in the path must be the
 * session the token was minted for, and a memory store id must appear in
 * that session's attached `resources`.
 *
 * Writes on a `read_only` attachment are refused with 403: the token is
 * valid and the store is attached, so this is not an authentication
 * failure — it is the access mode the session's creator chose for that
 * store. Every other out-of-scope call (a different session, an unattached
 * store, a route the worker has no business on) answers 401 with the same
 * `authentication_error` family the Work API's own resolver uses for
 * credential/scope mismatches.
 *
 * The token's authority ends with the session: `validateSessionWorkToken`
 * already refuses once the session reaches a terminal state, so nothing
 * here has to re-check liveness.
 */

import type { Database } from '@/core/db/database.js';
import { validateSessionWorkToken } from './session-work-tokens.js';

export type SessionWorkCallAuth =
  | { ok: true; sessionId: string; environmentId: string }
  | { ok: false; status: 401 | 403; type: string; message: string };

interface AttachedMemoryStore {
  memoryStoreId: string;
  readOnly: boolean;
}

/** Event types a worker legitimately posts: answers to parked tool calls. */
export const SESSION_WORK_SENDABLE_EVENTS: ReadonlySet<string> = new Set([
  'user.tool_result',
  'user.custom_tool_result',
]);

/**
 * The session-work binding a request's bearer resolves to, re-derived for a
 * route that needs the identity itself (the middleware only decides
 * admission — Hono's untyped context cannot carry the binding across a
 * mounted router). `undefined` means the request is not session-work
 * authenticated: no bearer, a non-`mawt_` bearer, or a dead token.
 */
export function sessionWorkAuthFromHeader(db: Database, authorization: string | undefined): { sessionId: string; environmentId: string } | undefined {
  const bearer = authorization === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (!bearer || !bearer.startsWith('mawt_')) return undefined;
  const resolved = validateSessionWorkToken(db, bearer);
  return resolved.ok ? { sessionId: resolved.sessionId, environmentId: resolved.environmentId } : undefined;
}

/**
 * Decide whether a `mawt_` bearer may make `method path`.
 *
 * `path` is the request's pathname (no query). The answer carries the
 * token's recorded binding on success and a ready error on refusal; the
 * middleware turns the refusal into the wire response.
 */
export function authorizeSessionWorkCall(
  db: Database,
  tokenValue: string,
  method: string,
  path: string,
): SessionWorkCallAuth {
  const token = validateSessionWorkToken(db, tokenValue);
  if (!token.ok) {
    return deny(401, 'authentication_error', 'Invalid session work token.');
  }

  const sessionMatch = /^\/v1\/sessions\/([^/]+)(\/events(?:\/stream)?)?$/.exec(path);
  if (sessionMatch) {
    if (sessionMatch[1] !== token.sessionId) {
      return deny(401, 'authentication_error', 'Session work token is not valid for this session.');
    }
    const sub = sessionMatch[2];
    if (sub === undefined) {
      return method === 'GET' ? ok(token) : outOfScope();
    }
    if (sub === '/events' || sub === '/events/stream') {
      if (method === 'GET') return ok(token);
      if (sub === '/events' && method === 'POST') return ok(token);
      return outOfScope();
    }
    return outOfScope();
  }

  const memoryMatch = /^\/v1\/memory_stores\/([^/]+)\/memories(?:\/[^/]+)?$/.exec(path);
  if (memoryMatch) {
    const store = attachedMemoryStore(db, token.sessionId, memoryMatch[1]);
    if (!store) {
      return deny(401, 'authentication_error', 'Session work token is not valid for this memory store.');
    }
    if (method === 'GET') return ok(token);
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      return store.readOnly
        ? deny(403, 'permission_error', 'This memory store is attached to the session read-only; the session work token cannot write it.')
        : ok(token);
    }
    return outOfScope();
  }

  const skillContentMatch = /^\/v1\/skills\/([^/]+)\/versions\/([^/]+)\/content$/.exec(path);
  if (skillContentMatch) {
    if (method !== 'GET') return outOfScope();
    return sessionAllowsSkillVersion(db, token.sessionId, skillContentMatch[1], skillContentMatch[2])
      ? ok(token)
      : deny(401, 'authentication_error', 'Session work token is not valid for this skill version.');
  }

  const fileMatch = /^\/v1\/files\/([^/]+)\/content$/.exec(path);
  if (fileMatch) {
    if (method !== 'GET') return outOfScope();
    return sessionAttachesFile(db, token.sessionId, fileMatch[1])
      ? ok(token)
      : deny(401, 'authentication_error', 'Session work token is not valid for this file.');
  }

  return outOfScope();
}

function ok(token: { sessionId: string; environmentId: string }): SessionWorkCallAuth {
  return { ok: true, sessionId: token.sessionId, environmentId: token.environmentId };
}

function outOfScope(): SessionWorkCallAuth {
  return deny(401, 'authentication_error', 'Session work token is not valid for this endpoint.');
}

function deny(status: 401 | 403, type: string, message: string): SessionWorkCallAuth {
  return { ok: false, status, type, message };
}

/**
 * The session's own record of what it attached, read from `sessions.resources`
 * — the same list the worker's session retrieve projects, so the fence and
 * the wire cannot disagree about which stores are mountable.
 *
 * A store row that vanished or was archived still counts as attached: the
 * refusal then comes from the memory route's own not_found, which is the
 * honest answer for a store that no longer exists — widening this check to
 * re-validate the store row would make the scope layer quietly decide
 * questions the route is supposed to answer.
 */
function attachedMemoryStore(db: Database, sessionId: string, memoryStoreId: string): AttachedMemoryStore | null {
  const row = db.prepare('SELECT resources FROM sessions WHERE id = ?').get(sessionId) as
    | { resources: string }
    | undefined;
  if (!row) return null;
  let resources: unknown;
  try {
    resources = JSON.parse(row.resources);
  } catch {
    return null;
  }
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') continue;
    const r = resource as Record<string, unknown>;
    if (r.type === 'memory_store' && r.memory_store_id === memoryStoreId) {
      return { memoryStoreId, readOnly: r.access === 'read_only' };
    }
  }
  return null;
}

/**
 * Whether the session's agent assigns `skillId` at `versionId`.
 *
 * The reference list comes from the same place the session retrieve projects:
 * the frozen `agent_definition` snapshot when present, else the live `agents`
 * row the session points at. A pinned reference admits exactly its version id;
 * an unpinned one admits the `latest` literal or the skill row's current
 * `latest_version`, which is what the route then serves.
 */
function sessionAllowsSkillVersion(db: Database, sessionId: string, skillId: string, versionId: string): boolean {
  const sessionRow = db.prepare('SELECT agent_id, agent_definition FROM sessions WHERE id = ?').get(sessionId) as
    | { agent_id: string; agent_definition: string | null }
    | undefined;
  if (!sessionRow) return false;

  let definitionJson = sessionRow.agent_definition;
  if (!definitionJson) {
    const agentRow = db.prepare('SELECT definition FROM agents WHERE id = ?').get(sessionRow.agent_id) as
      | { definition: string }
      | undefined;
    definitionJson = agentRow?.definition ?? null;
  }
  if (!definitionJson) return false;

  let skills: unknown;
  try {
    skills = (JSON.parse(definitionJson) as { skills?: unknown }).skills;
  } catch {
    return false;
  }
  if (!Array.isArray(skills)) return false;

  for (const ref of skills) {
    if (!ref || typeof ref !== 'object') continue;
    const r = ref as Record<string, unknown>;
    if (r.skill_id !== skillId) continue;
    const pinned = typeof r.version === 'string' && r.version.length > 0 && r.version !== 'latest'
      ? r.version
      : undefined;
    if (pinned) return versionId === pinned;
    if (versionId === 'latest') return true;
    const skillRow = db.prepare('SELECT latest_version FROM skills WHERE id = ?').get(skillId) as
      | { latest_version: string | null }
      | undefined;
    return skillRow?.latest_version === versionId;
  }
  return false;
}

/**
 * Whether the session's `resources` attach `fileId` — the same list the
 * worker's session retrieve projects, so the fence and the wire agree about
 * which files this session's worker may fetch. A file resource is content the
 * session's creator already chose to hand the sandbox, so an attached id is a
 * GET admission; everything else answers 401 like any other scope miss.
 */
function sessionAttachesFile(db: Database, sessionId: string, fileId: string): boolean {
  const row = db.prepare('SELECT resources FROM sessions WHERE id = ?').get(sessionId) as
    | { resources: string }
    | undefined;
  if (!row) return false;
  let resources: unknown;
  try {
    resources = JSON.parse(row.resources);
  } catch {
    return false;
  }
  if (!Array.isArray(resources)) return false;
  return resources.some(
    (r) => Boolean(r) && typeof r === 'object'
      && (r as Record<string, unknown>).type === 'file'
      && (r as Record<string, unknown>).file_id === fileId,
  );
}
