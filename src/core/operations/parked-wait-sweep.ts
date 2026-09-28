/**
 * The bounded-parked-wait sweep.
 *
 * A session parked on a caller's answer does not run again until that answer
 * arrives, so nothing inside the turn machinery can notice that nobody is coming.
 * Without an operator-configured bound, that is exactly the published behaviour —
 * the session waits indefinitely (`权限策略.md:668`) — and this sweep does nothing
 * at all. With a bound configured, this is what ends a session nobody answered.
 *
 * It is best-effort in the same way the two wirings beside it are: it must never
 * gate the model loop, and a pass that throws is retried on the next tick rather
 * than propagated. A session it fails to end stays parked, which is the state it
 * was already in.
 *
 * The decision itself is not made here. `expiredParkedWait` owns the rule and
 * `SessionManager.expireParkedWait` owns the exchange, so that the reason a
 * session is or is not ended can be read and tested in one place instead of
 * being spread across a timer callback.
 */

import type { Database } from '@/core/db/database.js';
import type { SessionManager } from '@/core/session/session-manager.js';
import { getOrSeedRuntimeSettings } from '@/core/settings/store.js';
import { REQUIRES_ACTION_TIMEOUT_OPTION } from '@/core/settings/adapters.js';

/** Page size for the parked-session scan; large enough that a normal workspace is one page. */
export const PARKED_WAIT_SCAN_PAGE_SIZE = 200;

export interface ParkedWaitSweepOptions {
  db: Database;
  sessionManager: SessionManager;
  /** Workspace data directory, needed to read the activated settings. */
  dataDir?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
  /**
   * Page size for the parked-session scan, defaulting to
   * {@link PARKED_WAIT_SCAN_PAGE_SIZE}.
   *
   * Injectable only so a test can put the page boundary where it can reach it
   * cheaply. Proving the re-read rule needs **more parked sessions than one page
   * holds**, and each of them has to be a real session the sweep can end, so at
   * the production page size the fixture is heavy enough to compete with a
   * shared runner's test budget instead of with the rule. The runtime never sets
   * this: it always scans at the production page size.
   *
   * Only a positive integer is honoured; anything else is the default, so a
   * caller cannot turn the scan into an empty page that ends nothing.
   */
  pageSize?: number;
}

/** The scan width to use, refusing anything that is not a positive integer. */
function resolveScanPageSize(requested: number | undefined): number {
  if (requested === undefined) return PARKED_WAIT_SCAN_PAGE_SIZE;
  return Number.isInteger(requested) && requested > 0 ? requested : PARKED_WAIT_SCAN_PAGE_SIZE;
}

/**
 * Read the configured bound, or `undefined` for the published indefinite wait.
 *
 * Reads the **effective** config, so the bound is whatever an operator last
 * activated rather than whatever they last typed, and a bound that failed
 * activation does not silently start ending sessions. Returns `undefined` for
 * anything that is not a positive number, so a malformed row cannot become a
 * bound of zero — which would end every parked session the moment it parked.
 */
export function parkedWaitTimeoutSeconds(db: Database, dataDir?: string): number | undefined {
  const settings = getOrSeedRuntimeSettings(db, {}, dataDir);
  const value = settings.effective_config.loop_engine.options[REQUIRES_ACTION_TIMEOUT_OPTION];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * End every parked session whose wait has expired.
 *
 * Returns the ids that were ended, which is what the tests assert on and what a
 * caller could log. An empty array covers both "no bound is configured" and
 * "nothing had expired"; the two are distinguished by
 * {@link parkedWaitTimeoutSeconds}.
 */
export function sweepExpiredParkedWaits(opts: ParkedWaitSweepOptions): string[] {
  const timeoutSeconds = parkedWaitTimeoutSeconds(opts.db, opts.dataDir);
  // No bound configured is the published behaviour, and it is the common case:
  // return before scanning anything.
  if (timeoutSeconds === undefined) return [];

  const now = opts.now ?? new Date();
  const pageSize = resolveScanPageSize(opts.pageSize);
  const ended: string[] = [];
  // Always re-read the first page rather than walking page numbers. Ending a
  // session removes it from `requires_action`, which shifts every later row down
  // by one — so a forward walk would step over the row that moved into the slot
  // it just left. Re-reading stops when a pass ends nothing, at which point every
  // remaining parked session has been examined and none had expired.
  for (;;) {
    const parked = opts.sessionManager.list({ status: 'requires_action', page: 1, pageSize });
    let endedThisPass = 0;
    for (const session of parked.data) {
      if (opts.sessionManager.expireParkedWait(session.id, timeoutSeconds, now)) {
        ended.push(session.id);
        endedThisPass += 1;
      }
    }
    if (endedThisPass === 0) break;
  }
  return ended;
}
