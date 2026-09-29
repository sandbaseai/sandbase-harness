/**
 * Session Resource Routes
 *
 * GET    /v1/sessions/:id/resources             - list resource instances
 * POST   /v1/sessions/:id/resources             - attach a resource
 * GET    /v1/sessions/:id/resources/:rid        - get one resource instance
 * PATCH  /v1/sessions/:id/resources/:rid        - rotate a GitHub token
 * DELETE /v1/sessions/:id/resources/:rid        - detach a resource
 *
 * Two behaviours here are contract, not convenience:
 *
 * - A `memory_store` may only be attached while the session is being created.
 *   Attaching one later would bind memory the session was never admitted
 *   against, so the live add path refuses it.
 * - A GitHub resource's repository URL, checkout, and mount path are fixed for
 *   the session. Only `authorization_token` may be replaced. The PATCH handler
 *   rejects any other field instead of quietly ignoring it, because a caller
 *   who believes they repointed a mount would be wrong in a way that silently
 *   changes which code the agent trusts.
 */

import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { cursorPageOf } from '../standard.js';
import { rejectUnexpectedQueryParams } from './query-params.js';
import { encryptSecret } from '@/core/security/secrets.js';
import {
  addSessionResource,
  deleteSessionResource,
  getSessionResource,
  listSessionResources,
  rotateGithubAuthorizationToken,
  toApiSessionResourceInstance,
  type SessionResourceType,
} from '@/core/session/session-resources.js';
import {
  normalizeFileResource,
  normalizeGithubRepositoryResource,
} from './session-normalizers.js';
import { isTerminal } from '@/core/session/state-machine.js';
import { isResourceNotMountableError } from '@/core/resources/resource-mountability.js';
import { isEnvironmentConfigError } from '@/sandbox/provider-names.js';

/**
 * The core's local mutation code, as the wire spelling for `error.type`.
 *
 * `session-resources.ts` in `core` returns a small local vocabulary
 * (`not_found` / `invalid_request` / `conflict`) that also decides the HTTP
 * status. That vocabulary is **internal** and stays as it is; the response is a
 * different contract, and `invalid_request` is not its canonical spelling. The
 * two were the same string, so the response type silently followed the core code
 * — which is exactly why canonicalising the route literals alone would have left
 * three paths still emitting the legacy value.
 *
 * Written as an explicit map rather than a `.replace()` so an unrecognized code
 * surfaces as a compile error instead of being passed through unmapped.
 */
const WIRE_ERROR_TYPE: Record<'invalid_request' | 'not_found' | 'conflict', string> = {
  invalid_request: 'invalid_request_error',
  not_found: 'not_found',
  conflict: 'conflict',
};

/** PATCH accepts exactly one mutating field. */
const GITHUB_ROTATION_FIELDS = ['authorization_token'] as const;

export function sessionResourceRoutes(deps: ServerDeps) {
  const app = new Hono();

  const requireSession = (sessionId: string) => deps.sessionManager.get(sessionId);

  app.get('/:id/resources', (c) => {
    // Admission first, so a malformed request cannot be answered as a missing session —
    // the same order the artifacts listing uses. The accept list is empty because this
    // listing implements no parameter: the published CMA docs document none for it (the
    // resource API is documented for adding and removing resources, not for filtering a
    // listing), and this repository's own contract names the route in the group that
    // "return their whole set rather than a window"
    // (`contracts/anthropic-cma/pagination.md`), so no window parameter is implemented or
    // claimed. A parameter used to be ignored, so `?limit=5` answered a page as though the
    // request had been understood. No caller passes one: the SDK and the Console both call
    // the route bare, and a repository-wide search for a `resources?<param>=` request finds
    // nothing.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const sessionId = c.req.param('id')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const instances = listSessionResources(deps.db, sessionId).map(toApiSessionResourceInstance);
    return c.json(cursorPageOf(instances, {}));
  });

  app.post('/:id/resources', async (c) => {
    const sessionId = c.req.param('id')!;
    const session = requireSession(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be an object' } }, 400);
    }

    const resource = body as Record<string, unknown>;
    const type = resource.type;
    if (type !== 'file' && type !== 'github_repository' && type !== 'memory_store') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: 'type must be file, github_repository, or memory_store',
        },
      }, 400);
    }

    if (type === 'memory_store') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: 'memory_store resources can only be attached when the session is created',
        },
      }, 400);
    }

    const normalized = normalizeResourceForLiveAdd(deps, type, resource);
    if (!normalized.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: normalized.message } }, 400);
    }

    // Attaching a resource is admitting a mount, so a backend that cannot serve
    // it is refused here for the same reason creation refuses it: otherwise the
    // instance is recorded and the failure surfaces at the next provisioning.
    // Resolving the Environment can also fail on its own — a legacy or damaged
    // config — and that is the same kind of answer (a request the runtime
    // declined), so both are mapped here rather than escaping as a 500: this
    // route is mounted on its own and has no shared error handler.
    try {
      deps.sessionManager.assertResourcesMountable(session.environmentId, [normalized.value]);
    } catch (err) {
      if (isResourceNotMountableError(err) || isEnvironmentConfigError(err)) {
        return c.json({ error: {
          type: 'invalid_request_error',
          code: (err as Error & { code: string }).code,
          message: (err as Error).message,
        } }, 400);
      }
      throw err;
    }

    const result = addSessionResource(deps.db, {
      sessionId,
      type,
      resource: normalized.value,
      ...(typeof normalized.value.mount_path === 'string' ? { mountPath: normalized.value.mount_path } : {}),
    });
    if (!result.ok) {
      return c.json({ error: { type: WIRE_ERROR_TYPE[result.code], message: result.message } }, 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance), 201);
  });

  app.get('/:id/resources/:resourceId', (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const instance = getSessionResource(deps.db, sessionId, resourceId);
    if (!instance) {
      return c.json({ error: { type: 'not_found', message: `Resource not found: ${resourceId}` } }, 404);
    }
    return c.json(toApiSessionResourceInstance(instance));
  });

  app.patch('/:id/resources/:resourceId', async (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    const session = requireSession(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be an object' } }, 400);
    }

    const instance = getSessionResource(deps.db, sessionId, resourceId);
    if (!instance) {
      return c.json({ error: { type: 'not_found', message: `Resource not found: ${resourceId}` } }, 404);
    }
    if (instance.type !== 'github_repository') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: `Resource ${resourceId} is a ${instance.type} resource; only github_repository resources support updates`,
        },
      }, 400);
    }
    if (isTerminal(session.status)) {
      return c.json({
        error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` },
      }, 409);
    }

    const patch = body as Record<string, unknown>;
    const unsupported = Object.keys(patch).filter(
      (key) => !(GITHUB_ROTATION_FIELDS as readonly string[]).includes(key),
    );
    if (unsupported.length > 0) {
      // Naming the offending fields keeps a caller from believing they changed
      // a mount identity the runtime cannot change mid-session.
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: `Only authorization_token can be updated on a github_repository resource; unsupported fields: ${unsupported.join(', ')}. Create a new session to change the repository, checkout, or mount path.`,
        },
      }, 400);
    }

    const token = patch.authorization_token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      return c.json({
        error: { type: 'invalid_request_error', message: 'authorization_token is required and must be a non-empty string' },
      }, 400);
    }

    const result = rotateGithubAuthorizationToken(deps.db, sessionId, resourceId, {
      type: 'encrypted_secret',
      ...encryptSecret(token.trim(), deps.workspace?.dataDir),
    });
    if (!result.ok) {
      return c.json({ error: { type: WIRE_ERROR_TYPE[result.code], message: result.message } }, 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance));
  });

  app.delete('/:id/resources/:resourceId', (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const result = deleteSessionResource(deps.db, sessionId, resourceId);
    if (!result.ok) {
      return c.json({ error: { type: WIRE_ERROR_TYPE[result.code], message: result.message } }, result.code === 'not_found' ? 404 : 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance));
  });

  return app;
}

/** Normalize a resource supplied on the live add path. */
function normalizeResourceForLiveAdd(
  deps: ServerDeps,
  type: SessionResourceType,
  resource: Record<string, unknown>,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  const index = 0;
  const result = type === 'file'
    ? normalizeFileResource(deps, resource, index)
    : normalizeGithubRepositoryResource(deps, resource, index);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, value: result.value };
}
