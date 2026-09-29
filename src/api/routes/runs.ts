import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerDeps } from '../server.js';
import { toApiEvent } from '../standard.js';
import type { ContentBlock, UserEvent } from '@/types/cma-protocol.js';
import type { Session, SessionEvent, CreateSessionParams, SessionLoopEngine } from '@/types/session.js';
import { isPiSessionAdmissionError } from '@/core/session/pi-policy.js';
import { isResourceNotMountableError } from '@/core/resources/resource-mountability.js';
import { isEnvironmentConfigError } from '@/sandbox/provider-names.js';
import { isLoopEngineAdmissionError, resolveRequestedLoopEngine } from '@/core/session/loop-engine-admission.js';
import { createSessionEventQueue, isMessageStreamTerminalEvent } from './session-stream.js';
import {
  memoryScopeFromResources,
  normalizeAgentRef,
  normalizeEnvironmentId,
  normalizeMessageContent,
  normalizeResources,
  normalizeVaultIds,
  type ValidationResult,
} from './session-normalizers.js';

interface RunRequest {
  agent: { id: string; version?: number };
  environmentId: string;
  loopEngine?: SessionLoopEngine;
  input: ContentBlock[];
  title?: string;
  resources: Array<Record<string, unknown>>;
  vaultIds: string[];
  metadata?: Record<string, unknown>;
  responseMode: 'wait' | 'sse' | 'async';
  maxWaitSeconds: number;
}

interface RunAdmission {
  agent: { id: string; version?: number };
  environmentId: string;
  loopEngine?: SessionLoopEngine;
}

export function runsRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c, 'Request body must be valid JSON');
    }
    let requestedLoopEngine: SessionLoopEngine | undefined;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      try {
        requestedLoopEngine = resolveRequestedLoopEngine((body as Record<string, unknown>).loop_engine);
      } catch (err) {
        if (isLoopEngineAdmissionError(err)) return invalidWithCode(c, err.code, err.message);
        throw err;
      }
    }

    const admission = parseRunAdmission(deps, body, requestedLoopEngine);
    if (!admission.ok) return invalid(c, admission.message);
    const parsed = parseRunRequest(deps, body, admission.value);
    if (!parsed.ok) return invalid(c, parsed.message);

    const request = parsed.value;
    try {
      // An omitted engine lets SessionManager apply its own resolved default,
      // so the route does not need a second source for that decision.
      const params = sessionParams(request, request.loopEngine);
      const event: UserEvent = { type: 'user.message', content: request.input };

      if (request.responseMode === 'async') {
        const session = deps.sessionManager.createWithInitialEvents(params, [event]);
        return c.json(runAccepted(session.id, 'running'), 202);
      }

      if (request.responseMode === 'sse') {
        const session = deps.sessionManager.create(params);
        deps.sessionManager.assertSessionCanAcceptEvent(session.id, event);
        return streamRun(c, deps, session.id, event);
      }

      const session = deps.sessionManager.create(params);
      deps.sessionManager.assertSessionCanAcceptEvent(session.id, event);
      return await waitRun(c, deps, session.id, event, request.maxWaitSeconds);
    } catch (err) {
      return respondAdmissionError(c, err);
    }
  });

  return app;
}

/**
 * Map a pre-execution refusal onto its documented HTTP status.
 *
 * These all happen before (or instead of) a turn, so they are requests the
 * runtime declined rather than sessions that failed: reporting them as
 * `internal_error`/500 would tell a client to treat a fixable request as a
 * runtime fault. A session that was already created and then refused an event
 * is answered with its own recorded `session.error` instead (see
 * `recordErrorOnce`), never with a fabricated one.
 */
function respondAdmissionError(c: any, err: unknown) {
  if (
    isLoopEngineAdmissionError(err)
    || isPiSessionAdmissionError(err)
    || isEnvironmentConfigError(err)
    || isResourceNotMountableError(err)
  ) {
    const code = (err as { code: string }).code;
    return c.json({ error: { type: 'invalid_request_error', code, message: (err as Error).message } }, 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Agent not found')) {
    return c.json({ error: { type: 'not_found', message } }, 404);
  }
  if (message.includes('Session not found')) {
    return c.json({ error: { type: 'not_found', message } }, 404);
  }
  if (message.includes('terminal state') || message.includes('is archived')) {
    return c.json({ error: { type: 'conflict', message } }, 409);
  }
  return c.json({ error: { type: 'internal_error', message } }, 500);
}

function parseRunAdmission(
  deps: ServerDeps,
  body: unknown,
  requestedLoopEngine: SessionLoopEngine | undefined,
): ValidationResult<RunAdmission> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be an object' };
  }
  const record = body as Record<string, unknown>;
  const agentRef = normalizeAgentRef(record.agent);
  if (!agentRef.ok) {
    return { ok: false, message: 'agent field is required and must be a standard agent id' };
  }
  // The run facade pins a reference; per-session overrides are a session
  // creation behaviour. Refusing the form here keeps a caller from reading a
  // 200 as evidence that the overrides were applied.
  if (agentRef.ref.kind === 'overrides') {
    return { ok: false, message: 'agent_with_overrides is not supported on /v1/runs; create a session with the overrides instead' };
  }
  if (!agentRef.ref.id.startsWith('agent_')) {
    return { ok: false, message: 'agent field is required and must be a standard agent id' };
  }
  const environment = normalizeEnvironmentId(deps, record.environment_id);
  if (!environment.ok) return environment;
  return {
    ok: true,
    value: {
      agent: {
        id: agentRef.ref.id,
        ...(agentRef.ref.kind === 'pinned' ? { version: agentRef.ref.version } : {}),
      },
      environmentId: environment.value,
      loopEngine: requestedLoopEngine,
    },
  };
}

function parseRunRequest(deps: ServerDeps, body: unknown, admission: RunAdmission): ValidationResult<RunRequest> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be an object' };
  }
  const record = body as Record<string, unknown>;
  const { agent, environmentId, loopEngine } = admission;
  const sessionInput = readSessionObject(record.session);
  const resources = normalizeResources(deps, sessionInput?.resources);
  if (!resources.ok) return resources;
  const vaultIds = normalizeVaultIds(deps, sessionInput?.vault_ids);
  if (!vaultIds.ok) return vaultIds;
  const input = normalizeMessageContent(record.input);
  if (!input || input.length === 0) return { ok: false, message: 'input must be a non-empty string or content block array' };

  const responseMode = record.response_mode === undefined ? 'wait' : record.response_mode;
  if (responseMode !== 'wait' && responseMode !== 'sse' && responseMode !== 'async') {
    return { ok: false, message: 'response_mode must be wait, sse, or async' };
  }
  const rawWait = record.max_wait_seconds === undefined ? 60 : record.max_wait_seconds;
  if (typeof rawWait !== 'number' || !Number.isFinite(rawWait) || rawWait < 0 || rawWait > 3600) {
    return { ok: false, message: 'max_wait_seconds must be a number from 0 to 3600' };
  }

  const session = sessionInput;
  return {
    ok: true,
    value: {
      agent,
      environmentId,
      loopEngine,
      input,
      title: typeof session?.title === 'string' ? session.title : undefined,
      resources: resources.value,
      vaultIds: vaultIds.value,
      metadata: session?.metadata,
      responseMode,
      maxWaitSeconds: rawWait,
    },
  };
}

function readSessionObject(body: unknown): {
  title?: unknown;
  resources?: unknown;
  vault_ids?: unknown;
  metadata?: Record<string, unknown>;
} | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  return {
    title: value.title,
    resources: value.resources,
    vault_ids: value.vault_ids,
    metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata as Record<string, unknown>
      : undefined,
  };
}

function sessionParams(request: RunRequest, loopEngine: SessionLoopEngine | undefined): CreateSessionParams {
  return {
    agent: request.agent.id,
    agentVersion: request.agent.version,
    ...(loopEngine ? { loopEngine } : {}),
    environmentId: request.environmentId,
    title: request.title,
    resources: request.resources,
    vaultIds: request.vaultIds,
    contextId: memoryScopeFromResources(request.resources),
    metadata: request.metadata,
  };
}

async function waitRun(
  c: any,
  deps: ServerDeps,
  sessionId: string,
  event: UserEvent,
  maxWaitSeconds: number,
): Promise<Response> {
  const queue = createSessionEventQueue();
  const seen: SessionEvent[] = [];
  let closed = false;
  const unsubscribe = deps.sessionManager.subscribe(sessionId, (sessionEvent) => {
    seen.push(sessionEvent);
    queue.push(sessionEvent);
  });

  try {
    await deps.sessionManager.sendEvent(sessionId, event);
    const deadline = Date.now() + Math.trunc(maxWaitSeconds * 1000);
    while (!closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await nextEventBefore(queue, remaining);
      if (!next) break;
      if (isMessageStreamTerminalEvent(next)) {
        closed = true;
        break;
      }
    }
  } catch (err) {
    // A synchronous rejection here means the request was refused before the
    // session ever started (validation, admission, a session that cannot accept
    // the event). Record it once against the session so it is replayable from
    // GET events, then report the session's own state rather than inventing one.
    const recorded = deps.sessionManager.recordErrorOnce(sessionId, err);
    return c.json(
      runTerminalBody(deps, sessionId, recorded),
      runTerminalHttpStatus(deps, sessionId),
    );
  } finally {
    unsubscribe();
  }

  const history = deps.sessionManager.getEventLogger().getEvents(sessionId);
  const events = uniqueEvents([...history, ...seen]);
  const session = deps.sessionManager.get(sessionId);
  const terminal = seen.find((item) => isMessageStreamTerminalEvent(item));
  const requiresAction = terminal?.type === 'session.status_idle'
    && terminal.metadata?.stop_reason
    && typeof terminal.metadata.stop_reason === 'object'
    && (terminal.metadata.stop_reason as Record<string, unknown>).type === 'requires_action';

  if (!closed || requiresAction) {
    // The HTTP wait deadline elapsed with the agent still working. This is a
    // transport deadline, not an execution timeout: the session keeps running
    // and its real terminal state must not be pre-empted here, so the answer is
    // a 202 with a query handle and an explicit `wait_deadline_reached` marker.
    return c.json(
      { ...runAccepted(sessionId, requiresAction ? 'requires_action' : 'running'), wait_deadline_reached: true },
      202,
    );
  }

  const status = runResultStatus(session, terminal);
  return c.json({
    run_id: sessionId,
    session_id: sessionId,
    status,
    output: outputFromEvents(events),
    usage: session?.usage
      ? { input_tokens: session.usage.tokensIn, output_tokens: session.usage.tokensOut }
      : { input_tokens: 0, output_tokens: 0 },
  }, 200);
}

/**
 * Terminal body for a run that ended without a successful wait, used by both
 * facades so `wait` and `sse` report the same status vocabulary.
 */
function runTerminalBody(deps: ServerDeps, sessionId: string, recorded: SessionEvent | undefined) {
  const session = deps.sessionManager.get(sessionId);
  const events = deps.sessionManager.getEventLogger().getEvents(sessionId);
  return {
    run_id: sessionId,
    session_id: sessionId,
    status: runResultStatus(session, recorded),
    ...(recorded ? { error: recordedError(recorded) } : {}),
    output: outputFromEvents(events),
    usage: session?.usage
      ? { input_tokens: session.usage.tokensIn, output_tokens: session.usage.tokensOut }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

/** HTTP status paired with `runTerminalBody` for the wait facade. */
function runTerminalHttpStatus(deps: ServerDeps, sessionId: string): 200 | 202 {
  const session = deps.sessionManager.get(sessionId);
  // A session that is still runnable after the refusal keeps its query handle;
  // only a settled session reports a final status with 200.
  return session && !isTerminalStatus(session.status) && session.status !== 'failed' ? 202 : 200;
}

function isTerminalStatus(status: Session['status']): boolean {
  return status === 'cancelled' || status === 'timed_out' || status === 'cleanup_pending' || status === 'completed';
}

function streamRun(
  c: any,
  deps: ServerDeps,
  sessionId: string,
  event: UserEvent,
): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;
    // Set when a `session.error` reached the client, so the catch below does not
    // emit a second one for the same incident.
    let errorSent = false;
    const queue = createSessionEventQueue();
    const unsubscribe = deps.sessionManager.subscribe(sessionId, (sessionEvent) => queue.push(sessionEvent));
    stream.onAbort(() => {
      // Caller disconnect is not a session failure: stop delivering and leave
      // the turn running so a client can reconnect and resume from the log.
      closed = true;
      unsubscribe();
      queue.push(undefined);
    });

    const writeEvent = async (sessionEvent: SessionEvent) => {
      const transient = sessionEvent.seq === 0;
      if (sessionEvent.type === 'session.error') errorSent = true;
      await stream.writeSSE({
        ...(transient ? {} : { id: String(sessionEvent.seq) }),
        event: sessionEvent.type,
        data: JSON.stringify(toApiEvent(sessionEvent)),
      });
    };

    try {
      await deps.sessionManager.sendEvent(sessionId, event);
      while (!closed) {
        const next = await queue.next();
        if (!next) break;
        await writeEvent(next);
        if (isMessageStreamTerminalEvent(next)) break;
      }
    } catch (err) {
      // Durability first: the failure goes into the Event Log so it replays from
      // GET events exactly like one the turn loop recorded itself, then to the
      // client as the documented structured `session.error` carrying the
      // session id. `errorSent` keeps a turn-level error that already reached
      // the stream from being written twice.
      const recorded = deps.sessionManager.recordErrorOnce(sessionId, err);
      if (!errorSent && recorded) {
        await writeEvent(recorded);
      }
    } finally {
      closed = true;
      unsubscribe();
    }
  });
}

function nextEventBefore(queue: ReturnType<typeof createSessionEventQueue>, timeoutMs: number): Promise<SessionEvent | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    void queue.next().then((event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(event);
    });
  });
}

function runResultStatus(
  session: Session | null,
  terminal: SessionEvent | undefined,
): 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'cleanup_pending' {
  switch (session?.status) {
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'cleanup_pending':
      return 'cleanup_pending';
    case 'failed':
      return 'failed';
    default:
      return terminal?.type === 'session.error' ? 'failed' : 'completed';
  }
}

function uniqueEvents(events: SessionEvent[]): SessionEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.seq > 0 ? `${event.sessionId}:${event.seq}` : event.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Structured error carried by a recorded session.error, in the wire envelope. */
function recordedError(event: SessionEvent): { type: string; message: string; code?: string } {
  const text = (event.content ?? []).find((block) => block.type === "text");
  const code = typeof event.metadata?.code === "string" ? event.metadata.code : undefined;
  return {
    type: "session_error",
    message: (text as { text?: unknown } | undefined)?.text as string ?? "",
    ...(code ? { code } : {}),
  };
}

/** Structured error carried by a recorded session.error, in the wire envelope. */
function outputFromEvents(events: SessionEvent[]): ContentBlock[] {
  return events
    .filter((event) => event.type === 'agent.message' && event.content)
    .flatMap((event) => event.content ?? []);
}

function runAccepted(sessionId: string, status: 'running' | 'requires_action') {
  return {
    run_id: sessionId,
    session_id: sessionId,
    status,
    events_url: `/v1/sessions/${sessionId}/events`,
    stream_url: `/v1/sessions/${sessionId}/events/stream`,
  };
}

function invalid(c: any, message: string) {
  return c.json({ error: { type: 'invalid_request_error', message } }, 400);
}

function invalidWithCode(c: any, code: string | undefined, message: string) {
  // A rejection with no published code still answers in the same envelope; the
  // `code` key is omitted rather than filled with a placeholder the client
  // could mistake for a stable identifier.
  return c.json({ error: { type: 'invalid_request_error', ...(code ? { code } : {}), message } }, 400);
}
