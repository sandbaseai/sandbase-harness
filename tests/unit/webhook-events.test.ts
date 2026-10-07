/**
 * The official webhook event catalog and the stream projection onto it.
 *
 * Two published surfaces are pinned here:
 *
 * - `OFFICIAL_WEBHOOK_EVENTS` is the subscription vocabulary: the
 *   `BetaWebhook*EventData.type` union in `@anthropic-ai/sdk@0.131.0` minus
 *   the names this runtime can never produce. The count and the no-wildcard
 *   invariants are the contract — a name that drifts in without a producer
 *   silently unsubscribes it, and a wildcard coming back would silently
 *   re-broaden every stored subscription.
 * - `webhookEventsForSessionEvent` is the only path from the durable session
 *   stream to a webhook. Stream events without a published counterpart must
 *   return nothing: forwarding them is how `agent.message` used to leak to a
 *   `session.*` subscription.
 */

import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_WEBHOOK_EVENTS,
  budgetReachedDedupKey,
  invalidWebhookEventNames,
  webhookEventsForSessionEvent,
} from '@/core/operations/webhook-events.js';

describe('OFFICIAL_WEBHOOK_EVENTS', () => {
  it('contains every name the published contract defines that this runtime can produce', () => {
    // The `BetaWebhook*EventData.type` union in `@anthropic-ai/sdk@0.131.0` is
    // 17 session + 7 vault + 4 agent + 6 deployment + 3 deployment_run +
    // 4 environment + 3 memory_store = 44 names. This catalog is that union
    // minus the four with no producing surface — `session.thread_created`,
    // `session.thread_idled`, `session.thread_terminated` (no multiagent
    // surface), and `agent.deleted` (agents archive; no delete route) — so a
    // stored subscription can only name an event that can actually fire.
    expect(OFFICIAL_WEBHOOK_EVENTS).toHaveLength(40);
    expect(new Set(OFFICIAL_WEBHOOK_EVENTS).size).toBe(40);
    for (const name of OFFICIAL_WEBHOOK_EVENTS) {
      expect(name).not.toContain('*');
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('refuses the SDK-declared names this runtime can never produce', () => {
    // `session.thread_*` waits on the deferred multiagent surface and
    // `agent.deleted` on a delete route that does not exist — a subscription
    // accepted for either would look live and never deliver, so they are
    // refused like any name outside the catalog.
    for (const name of [
      'session.thread_created',
      'session.thread_idled',
      'session.thread_terminated',
      'agent.deleted',
    ]) {
      expect(OFFICIAL_WEBHOOK_EVENTS).not.toContain(name);
      expect(invalidWebhookEventNames([name])).toEqual([name]);
    }
  });
});

describe('invalidWebhookEventNames', () => {
  it('rejects wildcards and names outside the catalog, in request order', () => {
    expect(invalidWebhookEventNames(['session.created', '*', 'bogus.event', 'session.*']))
      .toEqual(['*', 'bogus.event', 'session.*']);
  });

  it('accepts every catalog name', () => {
    expect(invalidWebhookEventNames([...OFFICIAL_WEBHOOK_EVENTS])).toEqual([]);
  });
});

describe('webhookEventsForSessionEvent', () => {
  const at = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    sessionId: 'sess_1',
    ...extra,
  }) as Parameters<typeof webhookEventsForSessionEvent>[0];

  it('maps each published status transition to its webhook name', () => {
    expect(webhookEventsForSessionEvent(at('session.status_running')))
      .toEqual([
        { type: 'session.status_run_started', subjectId: 'sess_1' },
        { type: 'session.running', subjectId: 'sess_1' },
      ]);
    expect(webhookEventsForSessionEvent(at('session.status_idle')))
      .toEqual([
        { type: 'session.status_idled', subjectId: 'sess_1' },
        { type: 'session.idled', subjectId: 'sess_1' },
      ]);
    expect(webhookEventsForSessionEvent(at('session.status_rescheduled')))
      .toEqual([{ type: 'session.status_rescheduled', subjectId: 'sess_1' }]);
    expect(webhookEventsForSessionEvent(at('session.status_terminated')))
      .toEqual([{ type: 'session.status_terminated', subjectId: 'sess_1' }]);
    expect(webhookEventsForSessionEvent(at('session.updated')))
      .toEqual([{ type: 'session.updated', subjectId: 'sess_1' }]);
    expect(webhookEventsForSessionEvent(at('session.deleted')))
      .toEqual([{ type: 'session.deleted', subjectId: 'sess_1' }]);
    expect(webhookEventsForSessionEvent(at('span.outcome_evaluation_end')))
      .toEqual([{ type: 'session.outcome_evaluation_ended', subjectId: 'sess_1' }]);
  });

  it('raises the budget companion alongside the idle it rode in on', () => {
    // The durable event carries the published stop reason under
    // `metadata.stop_reason`, matching the shape the SSE projection exposes.
    expect(webhookEventsForSessionEvent(
      at('session.status_idle', { metadata: { stop_reason: { type: 'budget_reached' } } }),
    )).toEqual([
      { type: 'session.status_idled', subjectId: 'sess_1' },
      { type: 'session.idled', subjectId: 'sess_1' },
      { type: 'session.budget_reached', subjectId: 'sess_1' },
    ]);
    // A parked session is reported under `requires_action`, not `idled`.
    expect(webhookEventsForSessionEvent(
      at('session.status_idle', { metadata: { stop_reason: { type: 'requires_action' } } }),
    )).toEqual([
      { type: 'session.status_idled', subjectId: 'sess_1' },
      { type: 'session.requires_action', subjectId: 'sess_1' },
    ]);
    // Any other stop reason raises the idle pair and nothing else.
    for (const reason of ['end_turn', 'retries_exhausted']) {
      expect(webhookEventsForSessionEvent(
        at('session.status_idle', { metadata: { stop_reason: { type: reason } } }),
      )).toEqual([
        { type: 'session.status_idled', subjectId: 'sess_1' },
        { type: 'session.idled', subjectId: 'sess_1' },
      ]);
    }
  });

  it('drops stream events that have no published counterpart', () => {
    for (const type of [
      'user.message',
      'user.interrupt',
      'agent.message',
      'agent.thinking',
      'tool.call',
      'span.model_request_start',
      'span.model_request_end',
      'session.usage',
      'session.error',
    ]) {
      expect(webhookEventsForSessionEvent(at(type))).toEqual([]);
    }
  });
});

describe('budgetReachedDedupKey', () => {
  it('keys on the session and the budget value', () => {
    const key = budgetReachedDedupKey('sess_1', '{"limit":5}');
    expect(budgetReachedDedupKey('sess_1', '{"limit":5}')).toBe(key);
    expect(budgetReachedDedupKey('sess_1', '{"limit":10}')).not.toBe(key);
    expect(budgetReachedDedupKey('sess_2', '{"limit":5}')).not.toBe(key);
    // A cleared budget cannot collide with a set one.
    expect(budgetReachedDedupKey('sess_1', null)).not.toBe(key);
    expect(budgetReachedDedupKey('sess_1', null)).toBe(budgetReachedDedupKey('sess_1', null));
  });
});
