/**
 * The official session event vocabulary.
 *
 * Transcribed by hand from the SDK union
 * `BetaManagedAgentsSessionEventType` in
 * `@anthropic-ai/sdk@0.131.0` (`resources/beta/sessions/events.d.ts`) — the
 * Console's event render table is keyed by these names. Update this list when
 * the pinned SDK version changes.
 */
export const SESSION_EVENT_TYPES = [
  'user.message',
  'user.interrupt',
  'user.tool_confirmation',
  'user.tool_result',
  'user.custom_tool_result',
  'user.define_outcome',
  'agent.message',
  'agent.thinking',
  'agent.tool_use',
  'agent.tool_result',
  'agent.mcp_tool_use',
  'agent.mcp_tool_result',
  'agent.custom_tool_use',
  'agent.thread_message_received',
  'agent.thread_message_sent',
  'agent.thread_context_compacted',
  'session.error',
  'session.status_running',
  'session.status_idle',
  'session.status_rescheduled',
  'session.status_terminated',
  'session.thread_created',
  'session.thread_status_running',
  'session.thread_status_idle',
  'session.thread_status_rescheduled',
  'session.thread_status_terminated',
  'session.updated',
  'session.usage',
  'system.message',
  'span.model_request_start',
  'span.model_request_end',
  'span.outcome_evaluation_start',
  'span.outcome_evaluation_ongoing',
  'span.outcome_evaluation_end',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Event types the local runtime emits that are not part of the published
 * vocabulary. They render through the generic card, but listing them keeps
 * the extension surface explicit rather than accidental.
 */
export const LOCAL_SESSION_EVENT_TYPES = [
  'session.deleted',
  'agent.message_stream_start',
  'agent.message_chunk',
  'agent.message_stream_end',
  'event_start',
  'event_delta',
  'user.steer',
  'turn_complete',
  'internal.resume_after_budget',
  'agent.external_authorization',
] as const;

/** Events that open a tool call in the transcript. */
export const TOOL_USE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.tool_use',
  'agent.mcp_tool_use',
  'agent.custom_tool_use',
]);

/**
 * Events that answer a tool call. Pairing is by the correlation id fields —
 * `tool_use_id`, `mcp_tool_use_id`, `custom_tool_use_id` — never by the
 * event-type name.
 */
export const TOOL_RESULT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.tool_result',
  'agent.mcp_tool_result',
  'user.tool_result',
  'user.custom_tool_result',
]);
