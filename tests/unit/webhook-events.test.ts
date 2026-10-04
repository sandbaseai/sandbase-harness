/**
 * The official webhook event catalog and the stream projection onto it.
 *
 * Two published surfaces are pinned here:
 *
 * - `OFFICIAL_WEBHOOK_EVENTS` is the subscription vocabulary, transcribed from
 *   the `BetaWebhook*EventData.type` union in `@anthropic-ai/sdk@0.129.0`.
 *   The count and the no-wildcard invariants are the contract — a name that
 *   drifts out of the union stops being subscribable, and a wildcard coming
 *   back would silently re-broaden every stored subscription.
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
  it('contains every name the published contract defines', () => {
    // Transcribed from the `BetaWebhook*EventData.type` union in
    // `@anthropic-ai/sdk@0.129.0` — 17 session + 7 vault + 4 agent +
    // 6 deployment + 3 deployment_run + 4 environment + 3 memory_store. The
    // count is part of the contract because a dropped name silently
    // unsubscribes it.
    expect(OFFICIAL_WEBHOOK_EVENTS).toHaveLength(44);
    expect(new Set(OFFICIAL_WEBHOOK_EVENTS).size).toBe(44);
    for (const name of OFFICIAL_WEBHOOK_EVENTS) {
      expect(name).not.toContain('*');
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('accepts the SDK-declared names this runtime does not emit', () => {
    // `session.pending`, `session.running`, `session.idled`,
    // `session.requires_action`, and the `session.thread_*` family are valid
    // subscription names even though nothing raises them yet — refusing them
    // would break a published client config.
    for (const name of [
      'session.pending',
      'session.running',
      'session.idled',
      'session.requires_action',
      'session.thread_created',
      'session.thread_idled',
      'session.thread_terminated',
    ]) {
      expect(OFFICIAL_WEBHOOK_EVENTS).toContain(name);
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
      .toEqual([{ type: 'session.status_run_started', subjectId: 'sess_1' }]);
    expect(webhookEventsForSessionEvent(at('session.status_idle')))
      .toEqual([{ type: 'session.status_idled', subjectId: 'sess_1' }]);
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
      { type: 'session.budget_reached', subjectId: 'sess_1' },
    ]);
    // Any other stop reason raises only the idle.
    for (const reason of ['end_turn', 'requires_action', 'retries_exhausted']) {
      expect(webhookEventsForSessionEvent(
        at('session.status_idle', { metadata: { stop_reason: { type: reason } } }),
      )).toEqual([{ type: 'session.status_idled', subjectId: 'sess_1' }]);
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
