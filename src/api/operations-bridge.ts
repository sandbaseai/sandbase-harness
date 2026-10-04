/**
 * Operations bridge: connects the in-process event stream and the scheduler to
 * the surfaces that should keep working without a caller.
 *
 * Two wirings live here, and they share one property: neither may gate the model
 * loop. A webhook is an advisory projection of an event that is already durable
 * in the append-only log, and a scheduled deployment runs on its own cadence — so
 * both are best-effort, with failures recorded rather than propagated.
 *
 * This module lives under `api/` because it projects public event shapes;
 * importing the API layer from `core/` would invert the dependency direction.
 */

import type { Database } from '@/core/db/database.js';
import type { SessionEvent } from '@/types/session.js';
import type { SessionManager } from '@/core/session/session-manager.js';
import type { Logger } from '@/core/observability/logger.js';
import {
  dispatchWebhookEvent,
  resolveWebhookSustainedFailureWindow,
  retryDueWebhookDeliveries,
  sessionEventWebhookId,
} from '@/core/operations/webhook-dispatcher.js';
import {
  budgetReachedDedupKey,
  webhookEventsForSessionEvent,
} from '@/core/operations/webhook-events.js';
import { rearmScheduledDeployments, runDueScheduledDeployments } from '@/core/operations/scheduler.js';
import { sweepExpiredParkedWaits } from '@/core/operations/parked-wait-sweep.js';

export type OperationsBridgeOptions = {
  db: Database;
  sessionManager: SessionManager;
  /**
   * The key a subscription created before per-endpoint secrets is signed with.
   * A subscription that holds its own `whsec_` secret uses that one, so this
   * value only keeps an older workspace verifiable.
   */
  webhookSecret: string;
  /** Workspace data directory, needed to decrypt a subscription's own secret. */
  dataDir?: string;
  /** Injectable for deterministic bridge tests. */
  fetchImpl?: typeof fetch;
  /** Cadence for due webhook retries and scheduled deployments. */
  intervalMs?: number;
  /**
   * Where the start-up record of the webhook auto-disable window goes. Optional so a
   * test can compose the bridge without one; the runtime passes its logger.
   */
  logger?: Logger;
  /**
   * The sustained-failure window `composeOperations` resolved and recorded, carried
   * down so the deliveries use the value the record names. Unset reads the
   * deployment switch, which is what a caller that starts the timers on its own gets.
   */
  sustainedFailureWindowSeconds?: number;
};

/** The runtime's legacy webhook signing secret. Derived per workspace, not hardcoded. */
export function webhookSigningSecret(dataDir: string | undefined): string {
  return dataDir || 'managed-agents';
}

/**
 * A broadcast listener that projects each durable session event to every
 * matching webhook subscription — through the official event catalog.
 *
 * `webhookEventsForSessionEvent` decides which webhook events a stream event
 * raises; a stream event with no published counterpart (an `agent.message`, a
 * `span.*`) is dropped, so a subscription only ever sees catalog names.
 *
 * The write to the event log has already completed by the time this runs, so a
 * failed delivery can lose a notification but never a session event.
 */
export function createWebhookEventListener(opts: {
  db: Database;
  webhookSecret: string;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  sustainedFailureWindowSeconds?: number;
}): (event: SessionEvent) => void {
  // The published `session.budget_reached` fires at most once per budget value.
  // The set lives with the listener because the dedup window it guards is the
  // listener's own lifetime: a restart that re-fired once would report a
  // transition the budget already caused, which is the same lie as reporting
  // it twice in one lifetime — but the trigger itself (a `budget_reached`
  // idle) cannot recur for the same unraised budget, so process memory is the
  // whole window the rule needs.
  const budgetReachedSent = new Set<string>();
  return (event: SessionEvent) => {
    const raised = webhookEventsForSessionEvent(event);
    if (raised.length === 0) return;
    const createdAt = event.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : new Date(event.createdAt).toISOString();
    for (const webhookEvent of raised) {
      if (webhookEvent.type === 'session.budget_reached') {
        const budget = opts.db.prepare('SELECT budget FROM sessions WHERE id = ?')
          .get(event.sessionId) as { budget: string | null } | undefined;
        const dedupKey = budgetReachedDedupKey(event.sessionId, budget?.budget ?? null);
        if (budgetReachedSent.has(dedupKey)) continue;
        budgetReachedSent.add(dedupKey);
      }
      void dispatchWebhookEvent(
        opts.db,
        {
          type: webhookEvent.type,
          // The payload is a reference, not the resource: a receiver fetches
          // `GET /v1/sessions/<id>` for current state. Shipping a projection here
          // would also make a retry carry a snapshot the session has since moved
          // past.
          subjectId: webhookEvent.subjectId,
          // Deterministic per (stream event, webhook type): one stream event can
          // raise more than one webhook event, and every retry of a trigger must
          // keep the `webhook-id` it first carried.
          id: sessionEventWebhookId(event.id, webhookEvent.type),
          created_at: createdAt,
        },
        {
          secret: opts.webhookSecret,
          dataDir: opts.dataDir,
          fetchImpl: opts.fetchImpl,
          sustainedFailureWindowSeconds: opts.sustainedFailureWindowSeconds,
        },
      ).catch(() => {
        // dispatchWebhookEvent records failed attempts as delivery rows; a
        // rejection here means the delivery could not even be recorded, which no
        // in-band handler can improve on.
      });
    }
  };
}

export interface ComposeOperationsResult {
  /** Stop function for the operations timers. Pass into the runtime stopper. */
  stopOperationsTimers: () => void;
  /** The registered broadcast listener, exposed for composition assertions. */
  listener: (event: SessionEvent) => void;
}

/**
 * Compose both operations wirings onto a live runtime.
 *
 * This is the single entry point the runtime calls at startup, kept here rather
 * than inline in `index.ts` so the composition itself is testable: a test can
 * assert that a started runtime has a broadcast listener and a running timer,
 * which is a different claim from "the helper functions work when called by
 * hand".
 *
 * Ordering matters. The listener is registered before the timers start, and both
 * run before the HTTP server accepts traffic: a webhook subscription created in
 * the window between the server binding and the listener being registered would
 * silently miss every event until the next restart.
 */
export function composeOperations(opts: OperationsBridgeOptions): ComposeOperationsResult {
  // The auto-disable window is a deployment-level variable, so it has no write path of its
  // own to record a change. The change trail is this line instead: the runtime states the
  // window it will use and where that came from, so editing
  // `MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS` shows up as a new recorded
  // value after the restart that applies it, and a value the parser refused is recorded as
  // refused rather than presented as the default. `config_model_not_effective` is the same
  // seam for a config.yaml fact at start-up.
  const window = resolveWebhookSustainedFailureWindow();
  opts.logger?.info('webhook_disable_window', {
    window_seconds: window.seconds,
    source: window.source,
  });
  const listener = createWebhookEventListener({
    db: opts.db,
    webhookSecret: opts.webhookSecret,
    dataDir: opts.dataDir,
    fetchImpl: opts.fetchImpl,
    sustainedFailureWindowSeconds: window.seconds,
  });
  opts.sessionManager.setBroadcastListener(listener);
  // Re-arm before the timers start. A deployment whose `next_run_at` passed
  // while the runtime was down would never match the due query again, because
  // that query only matches rows that already carry a time — so restarting is
  // the one moment the forward schedule has to be restored.
  rearmScheduledDeployments({ db: opts.db });
  const stopOperationsTimers = startOperationsTimers({
    ...opts,
    sustainedFailureWindowSeconds: window.seconds,
  });
  return { stopOperationsTimers, listener };
}

/**
 * Start the operations timers: webhook retries whose backoff has elapsed,
 * scheduled deployments whose cron time is due, and parked sessions whose
 * configured wait bound has passed. Returns a stop function.
 */
export function startOperationsTimers(opts: OperationsBridgeOptions): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;
  // Resolved once, when the timers start, so a tick cannot half-apply an edited switch.
  const windowSeconds = opts.sustainedFailureWindowSeconds ?? resolveWebhookSustainedFailureWindow().seconds;
  const timer = setInterval(() => {
    void retryDueWebhookDeliveries(opts.db, {
      secret: opts.webhookSecret,
      dataDir: opts.dataDir,
      fetchImpl: opts.fetchImpl,
      sustainedFailureWindowSeconds: windowSeconds,
    }).catch(() => undefined);
    try {
      void runDueScheduledDeployments(opts.db, opts.sessionManager, {
        onEvent: async (event) => {
          await dispatchWebhookEvent(opts.db, event, {
            secret: opts.webhookSecret,
            dataDir: opts.dataDir,
            fetchImpl: opts.fetchImpl,
            sustainedFailureWindowSeconds: windowSeconds,
          });
        },
      }).catch(() => undefined);
    } catch {
      // A failed deployment run is recorded by the scheduler itself; the next
      // tick picks up anything still due.
    }
    try {
      sweepExpiredParkedWaits({ db: opts.db, sessionManager: opts.sessionManager, dataDir: opts.dataDir });
    } catch {
      // A session this pass failed to end is still parked, which is the state it
      // was already in; the next tick retries it.
    }
  }, intervalMs);
  // An operations timer must never keep a process alive on its own: shutdown is
  // orchestrated by the runtime stopper, not by pending background work.
  timer.unref();
  return () => clearInterval(timer);
}
