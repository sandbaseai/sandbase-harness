/**
 * The official webhook event catalog and the session-stream projection.
 *
 * Two published rules live here so they cannot drift apart:
 *
 * - `OFFICIAL_WEBHOOK_EVENTS` is the set a subscription may name, transcribed
 *   verbatim from the `BetaWebhook*EventData.type` union in
 *   `@anthropic-ai/sdk@0.129.0` (`resources/beta/webhooks.d.ts`). A name outside
 *   it is refused at subscription time with a 400 rather than stored as a
 *   subscription that can never fire.
 * - `webhookEventsForSessionEvent` is the map from the durable session event
 *   stream onto the catalog. Anything not in the map is dropped — stream
 *   events like `agent.message` or `span.model_request_start` are session
 *   telemetry, not webhook events, and forwarding them made a subscription to
 *   `session.*` receive traffic the contract never defines.
 */

import type { SessionEvent } from '@/types/session.js';

/**
 * The event names the published contract defines (`订阅Webhook.md` plus the
 * SDK union), grouped the way the documentation groups them.
 *
 * `session.pending`, `session.running`, `session.idled`, and
 * `session.requires_action` are valid subscription names — the SDK declares
 * them and a published client config must not be refused — but this runtime
 * produces no trigger for them, so they can be subscribed to yet never fire.
 * `session.thread_*` names are accepted for the same reason while the
 * multiagent surface is unimplemented.
 */
export const OFFICIAL_WEBHOOK_EVENTS = [
  // Sessions
  'session.created',
  'session.pending',
  'session.running',
  'session.idled',
  'session.requires_action',
  'session.archived',
  'session.deleted',
  'session.updated',
  'session.status_run_started',
  'session.status_idled',
  'session.status_rescheduled',
  'session.status_terminated',
  'session.budget_reached',
  'session.outcome_evaluation_ended',
  'session.thread_created',
  'session.thread_idled',
  'session.thread_terminated',
  // Vaults and credentials
  'vault.created',
  'vault.archived',
  'vault.deleted',
  'vault_credential.created',
  'vault_credential.archived',
  'vault_credential.deleted',
  'vault_credential.refresh_failed',
  // Agents
  'agent.created',
  'agent.updated',
  'agent.archived',
  'agent.deleted',
  // Deployments
  'deployment.created',
  'deployment.updated',
  'deployment.paused',
  'deployment.unpaused',
  'deployment.archived',
  'deployment.deleted',
  // Deployment runs
  'deployment_run.started',
  'deployment_run.succeeded',
  'deployment_run.failed',
  // Environments
  'environment.created',
  'environment.updated',
  'environment.archived',
  'environment.deleted',
  // Memory stores
  'memory_store.created',
  'memory_store.archived',
  'memory_store.deleted',
] as const;

export type OfficialWebhookEvent = (typeof OFFICIAL_WEBHOOK_EVENTS)[number];

const OFFICIAL_EVENT_SET = new Set<string>(OFFICIAL_WEBHOOK_EVENTS);

/** The subscription names that are not in the catalog, in request order. */
export function invalidWebhookEventNames(names: string[]): string[] {
  return names.filter((name) => !OFFICIAL_EVENT_SET.has(name));
}

/**
 * The webhook events a durable session event raises, in dispatch order.
 *
 * One stream event can raise more than one webhook event — a `budget_reached`
 * idle raises `session.status_idled` and `session.budget_reached` — so this
 * returns a list rather than a name. A stream event with no published meaning
 * returns an empty list and is simply not delivered.
 *
 * The `budget_reached` companion is returned unconditionally for an idle whose
 * stop reason names it; the listener applies the per-(session, budget) "at
 * most once" rule, because only it can read the session's current budget.
 */
export function webhookEventsForSessionEvent(
  event: Pick<SessionEvent, 'type' | 'sessionId' | 'metadata'>,
): Array<{ type: OfficialWebhookEvent; subjectId: string }> {
  const base = { subjectId: event.sessionId };
  switch (event.type) {
    case 'session.status_running':
      return [{ ...base, type: 'session.status_run_started' }];
    case 'session.status_idle': {
      const events: Array<{ type: OfficialWebhookEvent; subjectId: string }> = [
        { ...base, type: 'session.status_idled' },
      ];
      // The durable event publishes its stop reason under
      // `metadata.stop_reason` — the same `{type, event_ids}` shape the SSE
      // projection exposes — not on the scalar `stopReason` column.
      const stopReason = (event.metadata as { stop_reason?: { type?: string } } | undefined)
        ?.stop_reason;
      if (stopReason?.type === 'budget_reached') {
        events.push({ ...base, type: 'session.budget_reached' });
      }
      return events;
    }
    case 'session.status_rescheduled':
      return [{ ...base, type: 'session.status_rescheduled' }];
    case 'session.status_terminated':
      return [{ ...base, type: 'session.status_terminated' }];
    case 'session.updated':
      return [{ ...base, type: 'session.updated' }];
    case 'session.deleted':
      return [{ ...base, type: 'session.deleted' }];
    case 'span.outcome_evaluation_end':
      return [{ ...base, type: 'session.outcome_evaluation_ended' }];
    default:
      return [];
  }
}

/**
 * The deduplication rule for `session.budget_reached`.
 *
 * The published rule is "at most once per budget value": a session that idles
 * on the same ceiling twice reports it once, and raising the ceiling resets
 * the allowance. The budget JSON itself is the dedup key — a changed budget is
 * a different string, so no parsing is needed and a removed budget can never
 * collide with a set one.
 */
export function budgetReachedDedupKey(sessionId: string, budgetJson: string | null): string {
  return `${sessionId}|${budgetJson ?? 'none'}`;
}
