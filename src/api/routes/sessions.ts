/**
 * Session Routes
 *
 * POST /v1/sessions          - create session
 * GET  /v1/sessions          - list sessions (paginated)
 * GET  /v1/sessions/:id      - get session detail
 * POST /v1/sessions/:id/events - send events
 * GET  /v1/sessions/:id/events - list events (paginated)
 * POST /v1/sessions/:id/stop - stop session
 * DELETE /v1/sessions/:id    - delete session
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerDeps } from '../server.js';
import type { SessionEvent, SessionLoopEngine, SessionStatus } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentDefinition } from '@/types/agent.js';
import { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';
import { cursorPageOf, cursorQueryMismatch, decodeCursor, encodeCursor, normalizeCollectionFilter, toApiEvent, toApiSession } from '../standard.js';
import { unsupportedCapability } from '../capability-errors.js';
import { isTerminal } from '@/core/session/state-machine.js';
import { STATUS_PROJECTION } from '@/core/session/session-lifecycle.js';
import { loadAgentDefinitionById } from '@/core/agent/store.js';
import { isAgentOverrideError } from '@/core/agent/overrides.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { persistFileResource, toFileResource, type FileRow } from './files.js';
import {
  memoryScopeFromResources,
  normalizeAgentRef,
  normalizeEnvironmentId,
  normalizeMessageContent,
  normalizeResources,
  normalizeVaultIds,
} from './session-normalizers.js';
import { createSessionEventQueue, isMessageStreamTerminalEvent } from './session-stream.js';
import { rejectUnexpectedQueryParams } from './query-params.js';
import { normalizeDefineOutcome, normalizeInitialEvents } from './initial-events.js';
import { isBudgetError, parseSessionBudget, BUDGET_ERROR_CODES } from '@/core/session/session-budget.js';
import { isOutcomeGraderUnavailableError } from '@/core/outcomes/loop.js';
import { isPiSessionAdmissionError } from '@/core/session/pi-policy.js';
import { isResourceNotMountableError } from '@/core/resources/resource-mountability.js';
import { isEnvironmentConfigError } from '@/sandbox/provider-names.js';
import {
  isLoopEngineAdmissionError,
  resolveRequestedLoopEngine,
} from '@/core/session/loop-engine-admission.js';
import {
  normalizeSystemMessageContent,
  systemMessageContentError,
} from './system-message.js';
import type { LoopEngineSteerReceipt } from '@/strategy/loop-engine/adapter.js';

export function sessionsRoutes(deps: ServerDeps) {
  const app = new Hono();
  const { sessionManager } = deps;

  // POST / - Create session
  app.post('/', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c, 'Request body must be valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid(c, 'Request body must be an object');
    }
    const { agent, environment_id, title, metadata } = body;
    const agentRef = normalizeAgentRef(agent);
    const environment = normalizeEnvironmentId(deps, environment_id);
    const resources = normalizeResources(deps, body.resources);
    const vaultIds = normalizeVaultIds(deps, body.vault_ids);
    let loopEngine: SessionLoopEngine | undefined;
    try {
      loopEngine = resolveRequestedLoopEngine(body.loop_engine);
    } catch (err) {
      if (isLoopEngineAdmissionError(err)) return invalidWithCode(c, err.code, err.message);
      throw err;
    }

    if (!agentRef.ok) {
      return invalidWithCode(c, agentRef.code, agentRef.message);
    }
    if (!agentRef.ref.id.startsWith('agent_')) {
      return invalidWithCode(c, 'invalid_agent_ref', 'agent must be a standard agent id');
    }
    if (!environment.ok) return invalid(c, environment.message);
    if (!resources.ok) return invalid(c, resources.message);
    if (!vaultIds.ok) return invalid(c, vaultIds.message);

    // Validate `initial_events` before any session row, event, or sandbox
    // exists, so a rejected batch leaves nothing behind.
    const initialEvents = normalizeInitialEvents(body.initial_events);
    if (!initialEvents.ok) {
      return invalidWithCode(c, initialEvents.code ?? 'invalid_initial_events', initialEvents.message ?? 'initial_events is invalid');
    }

    // A budget is attachable here and nowhere else, so a malformed one has to
    // fail before the row exists: otherwise the session would be created
    // unbudgeted and the client would learn about the typo from a spend number
    // that never stopped.
    const budget = parseSessionBudget(body.budget);
    if (!budget.ok) {
      return invalidWithCode(c, budget.code ?? 'budget_invalid_shape', budget.message ?? 'budget is invalid');
    }
    if (budget.remove) {
      return invalidWithCode(
        c,
        BUDGET_ERROR_CODES.invalidShape,
        'budget cannot be null when the session is created: a session that has no budget has nothing to remove',
      );
    }

    try {
      const session = sessionManager.createWithInitialEvents({
        agent: agentRef.ref.id,
        ...(agentRef.ref.kind === 'pinned' ? { agentVersion: agentRef.ref.version } : {}),
        ...(agentRef.ref.kind === 'overrides'
          ? {
              ...(agentRef.ref.version !== undefined ? { agentVersion: agentRef.ref.version } : {}),
              agentOverrides: agentRef.ref.overrides,
            }
          : {}),
        ...(loopEngine ? { loopEngine } : {}),
        environmentId: environment.value,
        title,
        resources: resources.value,
        vaultIds: vaultIds.value,
        contextId: memoryScopeFromResources(resources.value),
        metadata,
        ...(budget.budget ? { budget: budget.budget } : {}),
      }, initialEvents.events ?? []);
      return c.json(toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)), 201);
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (isLoopEngineAdmissionError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // Every budget refusal is a 400: the request was well formed and asked
      // for something the contract does not allow, never an internal failure.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // A refused override is the same shape of answer: the request was well
      // formed and asked for a configuration the contract does not allow, and
      // the session row was never inserted.
      if (isAgentOverrideError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // A declared outcome on a runtime that composes no grader is refused
      // before the session row exists: accepting it would promise a measurement
      // the runtime can never make, and the session would hold an outcome that
      // nothing can end.
      if (isOutcomeGraderUnavailableError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request_error',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      // A resource the session's own Environment cannot serve is refused before
      // the session row exists, on the same reasoning as the Environment refusal
      // below: the caller asked for something this backend cannot materialize,
      // and a `201` would only move the failure to provisioning.
      if (isResourceNotMountableError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // An Environment this runtime cannot resolve is refused here, before the
      // session row exists. It is a configuration fault in the request's target,
      // not an internal failure, so it answers with its own code instead of 500.
      if (isEnvironmentConfigError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      if (err instanceof Error && err.message.includes('Agent not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      return c.json({ error: { type: 'internal_error', message: String(err) } }, 500);
    }
  });

  // GET / - List sessions
  app.get('/', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'status', 'agent_id', 'page']);
    if (rejected) return rejected;
    const rawLimit = parseInt(c.req.query('limit') ?? '20', 10) || 20;
    const pageSize = Math.min(1000, Math.max(1, rawLimit)); // cap at 1000
    const status = c.req.query('status');
    const agentIdFilter = c.req.query('agent_id');

    // The window is a 1-based page number, so the cursor carries that number together
    // with the ordering and the normalized filter that produced it: replaying a cursor
    // under a different `agent_id` or `status` would otherwise address a page that
    // never existed for that query. A malformed cursor is refused rather than read as
    // "page one", which is how a client loops over the same window.
    const filter = normalizeCollectionFilter({ agent_id: agentIdFilter, status });
    const rawPage = c.req.query('page');
    const decoded = rawPage === undefined ? { ok: true as const, state: undefined } : decodeCursor(rawPage);
    if (!decoded.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' } }, 400);
    }
    const mismatch = cursorQueryMismatch(decoded.state, { order: SESSION_LIST_ORDER, filter });
    if (mismatch) return c.json({ error: { type: 'invalid_request_error', message: mismatch } }, 400);
    const page = readSessionPage(decoded.state);
    if (page === undefined) {
      return c.json({ error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' } }, 400);
    }

    const result = sessionManager.list({
      page,
      pageSize,
      ...(agentIdFilter ? { agentId: agentIdFilter } : {}),
      ...internalStatusFilter(status),
    });
    const sessions = result.data.map((session) => toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)));
    const cursorState = { order: SESSION_LIST_ORDER, filter };
    return c.json(cursorPageOf(sessions, {
      prev: page > 1 ? encodeCursor({ ...cursorState, page: page - 1 }) : null,
      next: result.hasMore ? encodeCursor({ ...cursorState, page: page + 1 }) : null,
    }));
  });

  // GET /:id - Get session detail
  app.get('/:id', (c) => {
    const session = sessionManager.get(c.req.param('id'));
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    return c.json(toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)));
  });

  // The published envelope, like the rest of the canonical `/v1` surface. This listing
  // returns its whole set, so the cursors are null rather than absent: a caller reading
  // `next_page` finds an honest "no more pages" instead of no field at all. Windowing it
  // would be a separate behaviour, and the row order is only defined to second
  // granularity until it is windowed — a tie reorders an unwindowed page but cannot drop
  // a row from it.
  app.get('/:id/artifacts', (c) => {
    // This listing reads no query parameter, so every parameter is refused by name
    // rather than ignored: `?limit=5` would otherwise answer with the whole unwindowed
    // collection, which is the silently-unscoped answer the convention exists to
    // remove. The published documentation never names this listing (no occurrence of
    // `artifacts` in the docs tree) and no caller in this repository sends it a
    // parameter, so the refusal cannot reject a documented or shipping request.
    // `beta` remains accepted and ignored through `COMPATIBILITY_QUERY_PARAMS`.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    const rows = deps.db.prepare(
      `SELECT *
       FROM files
       WHERE role = 'artifact' AND session_id = ? AND archived_at IS NULL
       ORDER BY created_at DESC`,
    ).all(sessionId) as unknown as FileRow[];
    return c.json(cursorPageOf(rows.map((row) => toFileResource(row, deps)), {}));
  });

  app.post('/:id/artifacts', async (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c, 'Request body must be valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(c, 'Request body must be an object');
    const artifactPath = normalizeArtifactPath(body.path);
    if (!artifactPath) return invalid(c, 'path is required and must start with /artifacts/');
    const content = typeof body.content === 'string' ? body.content : '';
    const encoding = typeof body.encoding === 'string' ? body.encoding : 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') return invalid(c, 'encoding must be utf8 or base64');
    const bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    const name = sanitizeArtifactName(body.name) ?? artifactPath.split('/').filter(Boolean).at(-1) ?? 'artifact';
    try {
      const artifact = persistFileResource(deps, {
        name,
        mediaType: typeof body.media_type === 'string' && body.media_type.trim() ? body.media_type.trim() : mediaTypeForArtifactName(name),
        bytes,
        metadata: stringRecordField(body.metadata),
        role: 'artifact',
        sessionId,
        artifactPath,
      });
      return c.json(artifact, 201);
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/:id/artifacts/:artifactId/content', (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    const row = deps.db.prepare(
      `SELECT *
       FROM files
       WHERE id = ? AND session_id = ? AND role = 'artifact' AND archived_at IS NULL`,
    ).get(c.req.param('artifactId'), sessionId) as FileRow | undefined;
    if (!row || !existsSync(row.storage_path)) return c.json({ error: { type: 'not_found', message: 'Artifact not found' } }, 404);
    return new Response(readFileSync(row.storage_path), {
      headers: {
        'Content-Type': row.media_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`,
      },
    });
  });

  // POST /:id/events - Send events
  app.post('/:id/events', async (c) => {
    const sessionId = c.req.param('id');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }

    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) {
      return c.json({ error: { type: 'invalid_request_error', message: 'events must be an array' } }, 400);
    }

    // Validate every event carries a string `type` before touching the log
    for (const event of events) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || event.type.length === 0) {
        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message: 'Each event must be an object with a non-empty string "type" field',
            },
          },
          400,
        );
      }
      // `system.message` is privileged system-level context, not a user turn,
      // so it is admitted here and projected as a `system` role turn below.
      if (event.type === 'system.message') {
        const content = normalizeSystemMessageContent(event.content);
        if (!content) {
          // Report which constraint was violated: an over-long batch is a
          // different client bug from a malformed block.
          return c.json(
            {
              error: {
                type: 'invalid_request_error',
                message: systemMessageContentError(event.content)
                  ?? 'system.message content must be a non-empty array of valid content blocks',
              },
            },
            400,
          );
        }
        // Validated in place: the batch this route forwards is the caller's
        // own array, and the payload is already in the shape the log stores.
        continue;
      }
      if (!event.type.startsWith('user.')) {
        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message: `Only system.message and user.* events can be sent to a session (got "${event.type}")`,
            },
          },
          400,
        );
      }
      // A `user.define_outcome` payload is normalized here rather than stored as sent:
      // the default budget has to be filled in before the event is durable, and a
      // payload the runtime will not honour must be refused at admission. The
      // normalized event replaces the caller's object in the batch this route forwards.
      if (event.type === 'user.define_outcome') {
        const outcome = normalizeDefineOutcome(event);
        if (!outcome.ok) {
          return c.json(
            {
              error: {
                type: 'invalid_request_error',
                code: 'invalid_define_outcome',
                message: `user.define_outcome.${outcome.message}`,
              },
            },
            400,
          );
        }
        events[events.indexOf(event)] = outcome.event;
      }
      // A steer carries text and an idempotency key and nothing else, so a payload
      // missing either is a client error rather than a runtime fault. It is named
      // here so the caller gets the field to fix; the Session Manager validates the
      // same payload again as the authority, because a steer must never be stored
      // on the strength of a route check alone.
      if (event.type === 'user.steer') {
        const problem = steerPayloadProblem(event);
        if (problem) {
          return c.json(
            { error: { type: 'invalid_request_error', message: `user.steer ${problem}` } },
            400,
          );
        }
      }
    }

    // Pre-flight: reject the whole batch up-front if the session is missing or
    // terminal, so we don't partially apply (L4). sendEvent still re-checks.
    const session = sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    if (isTerminal(session.status)) {
      return c.json({ error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` } }, 409);
    }

    try {
      // Evaluate every event before appending any one of them so a later Pi
      // policy failure cannot partially apply a mixed CMA batch.
      for (const event of events) {
        sessionManager.assertSessionCanAcceptEvent(sessionId, event as UserEvent);
      }
      // A `user.steer` is not a turn: it is offered to the live engine session
      // immediately, and the receipt says whether the engine saw it, already had
      // it, or never received it. `accepted` therefore has to report the
      // manager's answer rather than a constant — a rejected steer was not
      // delivered, and saying otherwise would have a client believe the engine
      // was told something it never heard.
      let steer: Record<string, unknown> | undefined;
      let accepted = true;
      for (const event of events) {
        const result = await sessionManager.sendEvent(sessionId, event);
        if (!result.accepted) accepted = false;
        if (result.steer) steer = publicSteerReceipt(result.steer);
      }
      return c.json({ accepted, ...(steer ? { steer } : {}) });
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request_error',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      // A session at its ceiling refuses the event that would start the next
      // model request. That is a well-formed request asking for something the
      // contract forbids, so it answers 400 with its own code rather than
      // letting the message-sniffing fallbacks below call it a runtime fault.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // Same answer for a declared outcome the runtime cannot ever evaluate: a
      // well-formed request asking for something the contract forbids, not a
      // runtime fault.
      if (isOutcomeGraderUnavailableError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // Admission resolves the session's Environment for every engine, so a
      // damaged config or an unsupported hosting type is a client error the
      // caller can act on, not a runtime fault.
      if (isEnvironmentConfigError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      if (err.message?.includes('not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      if (err.message?.includes('terminal state')) {
        return c.json({ error: { type: 'conflict', message: err.message } }, 409);
      }
      if (err.message?.startsWith('Invalid ')) {
        return c.json({ error: { type: 'invalid_request_error', message: err.message } }, 400);
      }
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  // POST /:id/messages - Send a user.message and optionally stream the turn.
  app.post('/:id/messages', async (c) => {
    const sessionId = c.req.param('id');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }

    const content = normalizeMessageContent(body && typeof body === 'object' ? body.content : undefined);
    if (!content) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'content must be a string or an array of content blocks',
          },
        },
        400,
      );
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    if (isTerminal(session.status)) {
      return c.json({ error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` } }, 409);
    }

    const event = { type: 'user.message' as const, content };
    const shouldStream = body && typeof body === 'object' ? body.stream !== false : true;

    // A streaming response cannot be converted into the standard JSON error
    // envelope after it starts. Preflight both current capability and Pi policy
    // so policy failures retain their stable client error before SSE opens.
    try {
      sessionManager.assertSessionCapabilities(session);
      if (shouldStream) {
        sessionManager.assertSessionCanAcceptEvent(sessionId, event);
      }
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) return unsupportedCapability(c, err);
      if (isPiSessionAdmissionError(err)) {
        return c.json({ error: {
          type: 'invalid_request_error',
          code: err.code,
          message: err.message,
        } }, 400);
      }
      // Same refusal as the events route: the ceiling is a client error, and a
      // streaming response cannot be converted into one after it has opened.
      if (isBudgetError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      // An Environment the runtime cannot resolve is refused before SSE opens,
      // so the caller still gets the standard JSON error envelope.
      if (isEnvironmentConfigError(err)) {
        return invalidWithCode(c, err.code, err.message);
      }
      throw err;
    }

    if (!shouldStream) {
      try {
        await sessionManager.sendEvent(sessionId, event);
        return c.json({ accepted: true });
      } catch (err: any) {
        if (err instanceof UnsupportedCapabilityError) {
          return unsupportedCapability(c, err);
        }
        if (isPiSessionAdmissionError(err)) {
          return c.json({ error: {
            type: 'invalid_request_error',
            code: err.code,
            message: err.message,
          } }, 400);
        }
        if (isBudgetError(err)) {
          return invalidWithCode(c, err.code, err.message);
        }
        if (isEnvironmentConfigError(err)) {
          return invalidWithCode(c, err.code, err.message);
        }
        if (err.message?.includes('not found')) {
          return c.json({ error: { type: 'not_found', message: err.message } }, 404);
        }
        if (err.message?.includes('terminal state')) {
          return c.json({ error: { type: 'conflict', message: err.message } }, 409);
        }
        return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
      }
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      const events = createSessionEventQueue();

      const unsubscribe = sessionManager.subscribe(sessionId, events.push);
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        events.push(undefined);
      });

      const writeEvent = async (sessionEvent: SessionEvent) => {
        const transient = sessionEvent.seq === 0;
        await stream.writeSSE({
          ...(transient ? {} : { id: String(sessionEvent.seq) }),
          event: sessionEvent.type,
          data: JSON.stringify(toApiEvent(sessionEvent)),
        });
      };

      try {
        await sessionManager.sendEvent(sessionId, event);

        while (!closed) {
          const sessionEvent = await events.next();
          if (!sessionEvent) break;
          await writeEvent(sessionEvent);

          if (isMessageStreamTerminalEvent(sessionEvent)) {
            break;
          }
        }
      } catch (err: any) {
        await stream.writeSSE({
          event: 'session.error',
          data: JSON.stringify({
            type: 'session.error',
            content: [{ type: 'text', text: err.message ?? String(err) }],
          }),
        });
      } finally {
        closed = true;
        unsubscribe();
      }
    });
  });

  // The events collection is the append-only log for one session, read in the order it
  // was written. The token names the collection so a cursor issued here cannot be
  // replayed against a session listing, and the filter binds the session so one
  // session's cursor cannot be replayed against another.
  const EVENTS_LIST_ORDER = 'events.appended ASC';

  // GET /:id/events - List events (paginated)
  //
  // The published envelope is `{data, prev_page, next_page}`: `has_more` / `first_id` /
  // `last_id` appear **nowhere** in the published contract (measured: zero occurrences,
  // against 34 for `next_page`), so this listing used to answer three field names a
  // published client cannot read and no cursor it could follow. `contracts/anthropic-cma/
  // pagination.md` already described this route as carrying `{session_id, after_id}` in
  // its cursor; the route never did, and now it does.
  app.get('/:id/events', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'after_id', 'page']);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');

    // 404 if session does not exist.
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }

    const rawLimit = parseInt(c.req.query('limit') ?? '1000', 10) || 1000;
    const limit = Math.min(1000, Math.max(1, rawLimit));

    // `after_id` is the local spelling of the position and stays supported; `page` is
    // the published one. Both name the last event the caller already has, and the
    // cursor carries that id together with the session it came from, so a cursor
    // issued by another session is refused by the shared filter check rather than
    // silently applied to this session's log.
    const cursorState = { order: EVENTS_LIST_ORDER, filter: { session_id: sessionId } };
    let afterId = c.req.query('after_id');
    let fromCursor = false;
    const rawPage = c.req.query('page');
    if (rawPage !== undefined) {
      const decoded = decodeCursor(rawPage);
      if (!decoded.ok || typeof decoded.state?.after_id !== 'string') {
        return c.json({
          error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
        }, 400);
      }
      const mismatch = cursorQueryMismatch(decoded.state, cursorState);
      if (mismatch) {
        return c.json({ error: { type: 'invalid_request_error', message: mismatch } }, 400);
      }
      afterId = decoded.state.after_id as string;
      fromCursor = true;
    }

    const eventLogger = sessionManager.getEventLogger();
    const allEvents = eventLogger.getEvents(sessionId);
    const start = afterId ? allEvents.findIndex((event) => event.id === afterId) + 1 : 0;

    // A cursor this route issued always names an event it returned, so one naming an
    // event that is not in the log was not issued here. Falling through to `start = 0`
    // would answer the whole log as though it were the page after the caller's position
    // — a wrong answer the caller cannot detect, unlike a refusal. `after_id` keeps its
    // old behaviour: it is a raw id the caller builds, and "everything after this id" is
    // a legitimate request even when the id is unknown to this log.
    if (fromCursor && start === 0) {
      return c.json({
        error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
      }, 400);
    }

    const events = start > 0 ? allEvents.slice(start) : allEvents;
    const limited = events.slice(0, limit);

    const last = limited[limited.length - 1];
    return c.json(cursorPageOf(limited.map(toApiEvent), {
      // A forward-only scan cannot name its predecessor, and a cursor that does not
      // resolve is worse than an honest `null` (`standard.ts`).
      prev: null,
      next: events.length > limited.length && last
        ? encodeCursor({ ...cursorState, after_id: last.id })
        : null,
    }));
  });

  // POST /:id/stop - Stop session
  app.post('/:id/stop', async (c) => {
    const sessionId = c.req.param('id');
    try {
      await sessionManager.stop(sessionId);
      const session = sessionManager.get(sessionId)!;
      return c.json(toApiSession(session, session.agentDefinition ?? findAgentById(deps, session.agentId)));
    } catch (err: any) {
      if (err instanceof UnsupportedCapabilityError) {
        return unsupportedCapability(c, err);
      }
      if (err.message?.includes('not found')) {
        return c.json({ error: { type: 'not_found', message: err.message } }, 404);
      }
      if (err.message?.includes('terminal state')) {
        return c.json({ error: { type: 'conflict', message: err.message } }, 409);
      }
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  // DELETE /:id - Delete session (logical delete; Event_Log retained per R9.8)
  app.delete('/:id', async (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    await sessionManager.delete(sessionId);
    return c.json({ id: sessionId, deleted: true });
  });

  return app;
}

/**
 * Project an engine steer receipt onto the public event API shape.
 *
 * Written out field by field rather than serialized straight from the internal
 * type, so the published contract is explicit and an internal rename cannot
 * silently change the wire format a client parses.
 */
function publicSteerReceipt(receipt: LoopEngineSteerReceipt): Record<string, unknown> {
  return {
    input_id: receipt.inputId,
    state: receipt.state,
    ...(receipt.turnId !== undefined ? { turn_id: receipt.turnId } : {}),
    ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
  };
}

/**
 * What is wrong with one `user.steer` payload, or `undefined` when nothing is.
 *
 * The three fields are the whole of a steer: an idempotency key, the text to
 * carry, and an optional turn binding. Anything else a client sends is ignored
 * rather than acted on, because a steer may not widen what it can do.
 */
function steerPayloadProblem(event: Record<string, unknown>): string | undefined {
  if (typeof event.input_id !== 'string' || event.input_id.length === 0) {
    return 'requires a non-empty string "input_id"';
  }
  if (typeof event.text !== 'string' || event.text.length === 0) {
    return 'requires a non-empty string "text"';
  }
  if (event.expected_turn_id !== undefined && typeof event.expected_turn_id !== 'string') {
    return 'requires "expected_turn_id" to be a string when it is present';
  }
  return undefined;
}

function internalStatusFilter(status: string | undefined) {
  if (status === 'failed') return { status: 'failed' as const };
  if (!status || !['idle', 'running', 'rescheduling', 'terminated'].includes(status)) return {};
  return {
    status: (Object.keys(STATUS_PROJECTION) as SessionStatus[])
      .filter((internal) => STATUS_PROJECTION[internal].wire === status),
  };
}

/** The ordering the session listing is issued under, recorded in every cursor it hands out. */
const SESSION_LIST_ORDER = 'created_at DESC';

/**
 * The page a session cursor names, or `undefined` when the state is not one of this
 * collection's cursors. An absent state is the first page rather than a rejection.
 */
function readSessionPage(state?: Record<string, unknown>): number | undefined {
  if (!state) return 1;
  const page = state.page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : undefined;
}

function findAgentById(deps: ServerDeps, id: string): AgentDefinition | undefined {
  return loadAgentDefinitionById(deps.db, id);
}


function normalizeArtifactPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+/g, '/');
  if (!trimmed.startsWith('/artifacts/') || trimmed.endsWith('/') || trimmed.includes('/../') || trimmed.includes('/./')) return undefined;
  return trimmed.slice(0, 512);
}

function sanitizeArtifactName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]/g, '_');
  return trimmed ? trimmed.slice(0, 255) : undefined;
}

function stringRecordField(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, recordValue]) => [key, String(recordValue)]));
}

function mediaTypeForArtifactName(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.ya?ml$/i.test(name)) return 'application/yaml';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.(txt|log|csv)$/i.test(name)) return 'text/plain';
  if (/\.html?$/i.test(name)) return 'text/html';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  return 'application/octet-stream';
}
function invalid(c: any, message: string): Response {
  return c.json({ error: { type: 'invalid_request_error', message } }, 400);
}

function invalidWithCode(c: any, code: string, message: string): Response {
  return c.json({ error: { type: 'invalid_request_error', code, message } }, 400);
}
