/**
 * `initial_events` normalizer for session creation.
 *
 * The published contract allows a session to start its agent loop in the same
 * call that creates it: `POST /v1/sessions` accepts an optional `initial_events`
 * array, and a non-empty list means the session is created already `running`
 * rather than idle. The constraints below are enforced here so an invalid batch
 * fails before any session row, event, or sandbox exists:
 *
 * - only `user.message` is accepted (every other event kind is either
 *   server-owned or meaningless before the session exists);
 * - at most 50 events;
 * - an empty array is equivalent to omitting the field.
 *
 * The creation response deliberately does not echo `initial_events`; a client
 * confirms them by listing the session's events.
 */

import type { ContentBlock, UserDefineOutcomeEvent, UserEvent } from '@/types/cma-protocol.js';
import { normalizeMessageContent, redactedBlockProblem } from './session-normalizers.js';
import { normalizeSystemMessageContent, systemMessageContentError } from './system-message.js';
import {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  MAX_OUTCOME_MAX_ITERATIONS,
} from '@/core/outcomes/contract.js';

/** Maximum number of events accepted in one creation call. */
export const MAX_INITIAL_EVENTS = 50;

/**
 * Maximum session-create request body in bytes (32 MB).
 *
 * The published contract answers `413` when the create body exceeds 32 MB.
 * The bound is checked before the body is parsed so an over-large payload is
 * refused without materializing it as a session or a half-admitted batch. It
 * is a request-size rule, not an `initial_events` rule — it applies to the
 * whole create call — so it lives next to the event caps the same call
 * enforces.
 */
export const MAX_SESSION_CREATE_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Maximum number of `user.define_outcome` events in one creation call.
 *
 * The published contract admits at most one outcome declaration per session:
 * a second is rejected with 400 rather than silently dropped or allowed to
 * shadow the first, because two outcomes would race to own the session's
 * `outcome_id` join.
 */
export const MAX_INITIAL_DEFINE_OUTCOME = 1;

/**
 * Maximum number of file-sourced `document` content blocks across the whole
 * `initial_events` list.
 *
 * The published contract bounds the file-document fan-out at creation to 100
 * blocks — `{type:"document", source:{type:"file"}}` — counted across every
 * `user.message` in the batch, not per event. Enforced here so an over-large
 * file expansion fails before any session row exists.
 */
export const MAX_INITIAL_FILE_DOCUMENT_BLOCKS = 100;

/**
 * A `system.message` event as the deployment contract allows it in
 * `initial_events`. It is appended to the session's log as privileged context
 * but is not a `UserEvent` — it never answers a tool call or a steer — so it
 * stays outside that union.
 */
export interface InitialSystemMessageEvent {
  type: 'system.message';
  content: ContentBlock[];
}

/**
 * The event set a deployment may send into a freshly created session. The
 * published deployment contract adds `system.message` to the session API's
 * `user.message` / `user.define_outcome` pair.
 */
export type DeploymentInitialEvent = UserEvent | InitialSystemMessageEvent;

/**
 * The published `user.define_outcome` budget, owned by the outcome contract.
 *
 * Re-exported here so the ingress validator and any future outcome loop cannot drift
 * apart on how much work an outcome is allowed to do.
 */
export {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  MAX_OUTCOME_MAX_ITERATIONS,
} from '@/core/outcomes/contract.js';

const INITIAL_EVENT_TYPES = new Set(['user.message', 'user.define_outcome']);
const DEPLOYMENT_EVENT_TYPES = new Set([...INITIAL_EVENT_TYPES, 'system.message']);

export interface InitialEventsResult {
  ok: boolean;
  events?: DeploymentInitialEvent[];
  code?: string;
  message?: string;
}

/**
 * Validate and normalize an `initial_events` payload.
 *
 * `undefined` and `[]` both mean "no initial events", so a caller that
 * normalizes the field unconditionally gets one consistent representation.
 *
 * Session creation accepts the two `user.*` types. A deployment's
 * `initial_events` also allows `system.message`, which the caller enables with
 * `allowSystemMessage`: it is appended as privileged context for the turns the
 * user events start, and never starts a turn itself.
 */
export function normalizeInitialEvents(
  value: unknown,
  opts: { allowSystemMessage?: boolean } = {},
): InitialEventsResult {
  if (value === undefined || value === null) return { ok: true, events: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: 'invalid_initial_events',
      message: 'initial_events must be an array',
    };
  }
  if (value.length === 0) return { ok: true, events: [] };
  if (value.length > MAX_INITIAL_EVENTS) {
    return {
      ok: false,
      code: 'too_many_initial_events',
      message: `initial_events accepts at most ${MAX_INITIAL_EVENTS} events (received ${value.length})`,
    };
  }

  const events: DeploymentInitialEvent[] = [];
  let defineOutcomeCount = 0;
  let fileDocumentBlocks = 0;
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events[${index}] must be an object`,
      };
    }
    const event = raw as Record<string, unknown>;
    const allowed = opts.allowSystemMessage ? DEPLOYMENT_EVENT_TYPES : INITIAL_EVENT_TYPES;
    if (typeof event.type !== 'string' || !allowed.has(event.type)) {
      return {
        ok: false,
        code: 'invalid_initial_event_type',
        message: opts.allowSystemMessage
          ? `initial_events[${index}].type must be user.message, user.define_outcome, or system.message (got "${String(event.type)}")`
          : `initial_events[${index}].type must be user.message or user.define_outcome (got "${String(event.type)}")`,
      };
    }

    if (event.type === 'system.message') {
      const content = normalizeSystemMessageContent(event.content);
      if (!content) {
        return {
          ok: false,
          code: 'invalid_initial_events',
          message: `initial_events[${index}].${systemMessageContentError(event.content) ?? 'content must be a non-empty array of valid content blocks'}`,
        };
      }
      events.push({ type: 'system.message', content });
      continue;
    }

    if (event.type === 'user.define_outcome') {
      // The published contract admits at most one outcome declaration per
      // session: a second races the first for the `outcome_id` join, so it is
      // refused rather than normalized.
      defineOutcomeCount += 1;
      if (defineOutcomeCount > MAX_INITIAL_DEFINE_OUTCOME) {
        return {
          ok: false,
          code: 'invalid_initial_events',
          message: `initial_events accepts at most ${MAX_INITIAL_DEFINE_OUTCOME} user.define_outcome event; initial_events[${index}] is the second`,
        };
      }
      const outcome = normalizeDefineOutcome(event);
      if (!outcome.ok) {
        return {
          ok: false,
          code: 'invalid_initial_events',
          message: `initial_events[${index}].${outcome.message}`,
        };
      }
      events.push(outcome.event);
      continue;
    }

    const content = Array.isArray(event.content) && event.content.length === 0
      ? []
      : normalizeMessageContent(event.content);
    if (!content) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events[${index}].content must be a string or an array of content blocks`,
      };
    }
    const redacted = redactedBlockProblem(content);
    if (redacted) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events[${index}].${redacted}`,
      };
    }
    // The published bound counts file-sourced document blocks across the whole
    // batch, not per event, so the tally is a running total rather than a
    // per-message check. Counted on the normalized blocks so a coerced string
    // payload contributes its real block count.
    fileDocumentBlocks += content.filter(isFileSourcedDocumentBlock).length;
    if (fileDocumentBlocks > MAX_INITIAL_FILE_DOCUMENT_BLOCKS) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events accepts at most ${MAX_INITIAL_FILE_DOCUMENT_BLOCKS} file-sourced document blocks across the list; initial_events[${index}] pushes the total past the bound`,
      };
    }
    events.push({ type: 'user.message', content });
  }

  return { ok: true, events };
}

/**
 * A `document` content block whose bytes come from an uploaded file — the
 * block shape the published file-document bound counts. `source.type:"file"`
 * and a bare `file_id` reference are the same source by different spelling.
 */
function isFileSourcedDocumentBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const record = block as Record<string, unknown>;
  if (record.type !== 'document') return false;
  const source = record.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const kind = (source as Record<string, unknown>).type;
    if (kind === 'file') return true;
    if (typeof (source as Record<string, unknown>).file_id === 'string') return true;
  }
  return false;
}

type DefineOutcomeResult = { ok: true; event: UserDefineOutcomeEvent } | { ok: false; message: string };

/**
 * Validate a `user.define_outcome` payload.
 *
 * `rubric` is a union of an inline text document and a reference to an uploaded file.
 * `max_iterations` defaults to 3 and is rejected outside 1..20 rather than clamped,
 * because silently lowering a caller's budget would change how much work the outcome is
 * allowed to do. Unknown fields are dropped rather than stored, so the admitted event
 * carries exactly what the projection returns.
 */
export function normalizeDefineOutcome(event: Record<string, unknown>): DefineOutcomeResult {
  const description = typeof event.description === 'string' ? event.description.trim() : '';
  if (description.length === 0) return { ok: false, message: 'description is required' };

  const rubric = normalizeRubric(event.rubric);
  if (!rubric.ok) return { ok: false, message: rubric.message };

  let maxIterations = DEFAULT_OUTCOME_MAX_ITERATIONS;
  if (event.max_iterations !== undefined) {
    if (typeof event.max_iterations !== 'number' || !Number.isInteger(event.max_iterations)) {
      return { ok: false, message: 'max_iterations must be an integer' };
    }
    if (event.max_iterations < 1 || event.max_iterations > MAX_OUTCOME_MAX_ITERATIONS) {
      return {
        ok: false,
        message: `max_iterations must be between 1 and ${MAX_OUTCOME_MAX_ITERATIONS}`,
      };
    }
    maxIterations = event.max_iterations;
  }

  return {
    ok: true,
    event: {
      type: 'user.define_outcome',
      description,
      rubric: rubric.value,
      max_iterations: maxIterations,
    },
  };
}

type RubricResult =
  | { ok: true; value: UserDefineOutcomeEvent['rubric'] }
  | { ok: false; message: string };

function normalizeRubric(value: unknown): RubricResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'rubric is required' };
  }
  const rubric = value as Record<string, unknown>;
  if (rubric.type === 'text') {
    const content = typeof rubric.content === 'string' ? rubric.content.trim() : '';
    if (content.length === 0) return { ok: false, message: 'rubric.content is required for a text rubric' };
    return { ok: true, value: { type: 'text', content } };
  }
  if (rubric.type === 'file') {
    if (typeof rubric.file_id !== 'string' || rubric.file_id.length === 0) {
      return { ok: false, message: 'rubric.file_id is required for a file rubric' };
    }
    return { ok: true, value: { type: 'file', file_id: rubric.file_id } };
  }
  return { ok: false, message: 'rubric.type must be text or file' };
}
