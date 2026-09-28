import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import {
  WEBHOOK_HEADERS,
  signWebhookDelivery,
  webhookSigningKey,
} from './webhook-signature.js';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { isBlockedInternalHostname, isPrivateAddress } from '@/core/web/address-policy.js';
import { resolveWebhookSigningSecrets, type StoredWebhookSecret } from './webhook-secrets.js';

/** The published retry window: jitter starts at 5 s and never exceeds 120 s. */
const MIN_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 120;

export type WebhookDispatchEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
  created_at?: string;
};

export type WebhookDispatchOptions = {
  /** The key a subscription with no stored secret is signed with. */
  secret: string;
  /** Workspace data directory holding the key material for stored secrets. */
  dataDir?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  now?: () => Date;
  /**
   * Address screening for the connection a delivery opens. Unset means "deliver
   * anywhere", which is the local-first default; see `webhookAddressPolicyFromEnv`
   * for why the published rule is opt-in here, and for the switch that turns it on.
   */
  addressPolicy?: WebhookAddressPolicy;
  /** Jitter source for retry backoff; injectable so the published window can be asserted. */
  random?: () => number;
  /**
   * How long an endpoint must fail without interruption before the sustained-failure
   * auto-disable fires, in seconds. Unset means the deployment's switch decides —
   * `webhookSustainedFailureWindowSeconds` reads it, and the runtime records what it
   * resolved at startup — so a caller only sets this to override that for a test.
   */
  sustainedFailureWindowSeconds?: number;
};

export type WebhookDeliveryResult = {
  id: string;
  webhook_id: string;
  status: string;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  next_retry_at: string | null;
};

export async function dispatchWebhookEvent(
  db: Database,
  event: WebhookDispatchEvent,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult[]> {
  const webhooks = db.prepare(
    `SELECT *
     FROM webhooks
     WHERE archived_at IS NULL AND status = 'active'
     ORDER BY created_at ASC`,
  ).all() as WebhookRow[];
  const matched = webhooks.filter((webhook) => eventMatches(parseStringArray(webhook.events), event.event));
  const results: WebhookDeliveryResult[] = [];
  for (const webhook of matched) {
    results.push(await attemptDelivery(db, webhook, makePayload(webhook.id, event, opts.now), opts));
  }
  return results;
}

export async function retryDueWebhookDeliveries(
  db: Database,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult[]> {
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const rows = db.prepare(
    `SELECT d.*, w.url, w.secret_ciphertext, w.secret_nonce, w.secret_tag,
            w.secret_previous_ciphertext, w.secret_previous_nonce, w.secret_previous_tag
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending_retry'
       AND d.next_retry_at IS NOT NULL
       AND d.next_retry_at <= ?
       AND w.archived_at IS NULL
       AND w.status = 'active'
     ORDER BY d.next_retry_at ASC, d.created_at ASC
     LIMIT 50`,
  ).all(nowIso) as RetryDeliveryRow[];
  const results: WebhookDeliveryResult[] = [];
  for (const row of rows) {
    results.push(await retryDelivery(db, row, opts));
  }
  return results;
}

async function attemptDelivery(
  db: Database,
  webhook: WebhookRow,
  payload: Record<string, unknown>,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult> {
  const payloadJson = JSON.stringify(payload);
  // Each endpoint is signed with its own secret; a subscription written before
  // per-endpoint secrets existed falls back to the caller's value.
  const signingSecrets = resolveWebhookSigningSecrets(webhook, opts.secret, opts.dataDir);
  // The legacy body signature follows the current key; the published header set
  // carries every key a rotation window still accepts.
  const signature = signPayload(payloadJson, signingSecrets[0]);
  const id = `whd_${nanoid(18)}`;
  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  // The published header set is keyed by the delivery id and the timestamp the
  // signature covers, so a receiver can verify a replay or an altered body.
  const deliveryIdentity = {
    id,
    timestamp: String(Math.floor(new Date(createdAt).getTime() / 1000)),
  };
  // The address is screened before the connection rather than after, because the point of
  // the rule is that no packet reaches a network the operator has not exposed.
  const blocked = await screenEndpointAddress(
    webhook.url,
    opts.addressPolicy ?? webhookAddressPolicyFromEnv(),
  );
  const attempt = blocked
    ? { ok: false, statusCode: null, error: blocked }
    : await postWebhook(
      webhook.url,
      payloadJson,
      signature,
      opts.fetchImpl,
      { ...deliveryIdentity, secrets: signingSecrets },
    );
  // Both auto-disable conditions have the same consequence: the endpoint is disabled with
  // its published reason and this attempt is terminal. `nextRetry` is therefore null rather
  // than the attempt ceiling being reached — the rule says a response that triggers
  // auto-disable is never retried, while three attempts still apply to every other failure.
  let autoDisableReason = blocked
    ? ADDRESS_DISABLED_REASON
    : isRedirectStatus(attempt.statusCode)
      ? REDIRECT_DISABLED_REASON
      : null;
  // The third rule is about elapsed time rather than this response, so it is consulted only
  // when the attempt was an ordinary failure. The streak advances on both outcomes: a `2xx`
  // clears it, which is the published reset and the reason a single flaky event cannot
  // accumulate into a disable.
  if (!autoDisableReason && recordFailureStreak(db, webhook.id, attempt.ok, createdAt, sustainedFailureWindowSeconds(opts)) === 'overdue') {
    autoDisableReason = SUSTAINED_DISABLED_REASON;
  }
  if (autoDisableReason) disableEndpoint(db, webhook.id, autoDisableReason, createdAt);
  const nextRetry = autoDisableReason ? null : nextRetryAt(attempt.ok, 1, opts);
  db.prepare(
    `INSERT INTO webhook_deliveries (
      id, webhook_id, event, payload, status, status_code, error, signature,
      attempt_count, next_retry_at, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    webhook.id,
    String(payload.event ?? 'event'),
    payloadJson,
    attempt.ok ? 'delivered' : nextRetry ? 'pending_retry' : 'failed',
    attempt.statusCode,
    attempt.error,
    signature,
    1,
    nextRetry,
    createdAt,
    attempt.ok ? createdAt : null,
  );
  return rowById(db, id);
}

async function retryDelivery(
  db: Database,
  row: RetryDeliveryRow,
  opts: WebhookDispatchOptions,
): Promise<WebhookDeliveryResult> {
  const attemptCount = row.attempt_count + 1;
  const signingSecrets = resolveWebhookSigningSecrets(row, opts.secret, opts.dataDir);
  const signature = signPayload(row.payload, signingSecrets[0]);
  const attemptTime = opts.now?.() ?? new Date();
  // A retry is another attempt at the same delivery, so it carries the same
  // published header set as the first attempt: `webhook-id` stays the delivery
  // id so a receiver can deduplicate, and the timestamp is this attempt's, which
  // is what keeps the receiver's freshness window satisfied.
  const blocked = await screenEndpointAddress(row.url, opts.addressPolicy ?? webhookAddressPolicyFromEnv());
  const attempt = blocked
    ? { ok: false, statusCode: null, error: blocked }
    : await postWebhook(row.url, row.payload, signature, opts.fetchImpl, {
      id: row.id,
      timestamp: String(Math.floor(attemptTime.getTime() / 1000)),
      secrets: signingSecrets,
    });
  // The rules are about the response and the address, not the attempt number, so a retry
  // takes the same terminal path when it observes either condition. This is reachable: a
  // retry is queued before the endpoint is disabled, and an operator can re-enable an
  // endpoint while that retry is still due.
  let autoDisableReason = blocked
    ? ADDRESS_DISABLED_REASON
    : isRedirectStatus(attempt.statusCode)
      ? REDIRECT_DISABLED_REASON
      : null;
  // A retry is where this rule is most likely to fire: the first attempt starts the streak and
  // the retries that follow are what carry it across the window.
  if (!autoDisableReason && recordFailureStreak(db, row.webhook_id, attempt.ok, attemptTime.toISOString(), sustainedFailureWindowSeconds(opts)) === 'overdue') {
    autoDisableReason = SUSTAINED_DISABLED_REASON;
  }
  if (autoDisableReason) disableEndpoint(db, row.webhook_id, autoDisableReason, attemptTime.toISOString());
  const nextRetry = autoDisableReason ? null : nextRetryAt(attempt.ok, attemptCount, opts);
  db.prepare(
    `UPDATE webhook_deliveries
     SET status = ?, status_code = ?, error = ?, signature = ?, attempt_count = ?,
         next_retry_at = ?, delivered_at = ?
     WHERE id = ?`,
  ).run(
    attempt.ok ? 'delivered' : nextRetry ? 'pending_retry' : 'failed',
    attempt.statusCode,
    attempt.error,
    signature,
    attemptCount,
    nextRetry,
    attempt.ok ? attemptTime.toISOString() : null,
    row.id,
  );
  return rowById(db, row.id);
}

async function postWebhook(
  url: string,
  payload: string,
  signature: string,
  fetchImpl: typeof fetch = fetch,
  delivery?: { id: string; timestamp: string; secrets: string[] },
) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      // A redirect must be observed, never followed. The address being delivered
      // to is chosen by the subscriber, so following a `3xx` hands that subscriber
      // the ability to have the payload replayed wherever it likes — including an
      // address only reachable from inside this runtime — with the `webhook-*`
      // signature headers still attached and still valid for the body. Observed,
      // a `3xx` is simply not a 2xx: the attempt is recorded with its real status.
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'managed-agents-webhook/0.1',
        'X-Managed-Agents-Signature': signature,
        // The published header set. `webhook-id` and `webhook-timestamp` are
        // what the signature covers, so a receiver can verify a replay or an
        // altered body rather than only a forged one.
        ...(delivery
          ? {
            [WEBHOOK_HEADERS.id]: delivery.id,
            [WEBHOOK_HEADERS.timestamp]: delivery.timestamp,
            // Every key the endpoint still accepts, space-separated, which is how
            // the published scheme expresses a rotation window.
            [WEBHOOK_HEADERS.signature]: delivery.secrets
              .map((secret) => webhookDeliverySignature({
                secret,
                id: delivery.id,
                timestamp: delivery.timestamp,
                body: payload,
              }))
              .join(' '),
          }
          : {}),
      },
      body: payload,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, statusCode: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, statusCode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A `3xx` is the published condition for the first auto-disable case. `postWebhook`
 * refuses to follow the redirect, so this is the status of the response that was
 * observed, not of wherever it pointed.
 */
function isRedirectStatus(statusCode: number | null): boolean {
  return statusCode !== null && statusCode >= 300 && statusCode < 400;
}

/**
 * The published reason strings, verbatim. They are machine-readable, so each is written
 * from one place rather than spelled out at every call site.
 */
const REDIRECT_DISABLED_REASON = 'auto-disabled: endpoint URL returned a redirect (3xx)';
const ADDRESS_DISABLED_REASON = 'auto-disabled: endpoint URL resolved to an invalid address';
// The third published reason has a different form from the other two — no `: ` and no
// parenthetical. It is still machine-readable, so it is written verbatim rather than
// normalised to match its neighbours.
const SUSTAINED_DISABLED_REASON = 'auto-disabled after sustained delivery failures';

/**
 * The resolver and the guard for the address screening, named as the WebFetch seam names
 * them (`src/core/web/web-fetch.ts`): the guard answers "may this attempt open a
 * connection to this address", and the resolver exists so a test can decide what a host
 * name answers without needing a network.
 */
export type WebhookAddressPolicy = {
  lookupAddresses: (hostname: string) => Promise<string[]>;
  isAddressAllowed: (address: string) => boolean;
};

/**
 * Screening is opt-in per deployment, and the default is deliberately "deliver".
 *
 * The published rule is unconditional, but it is written for a hosted control plane whose
 * subscribers are necessarily remote. This runtime is local-first and its receiver is
 * normally on the same host — every webhook test in this repository delivers to a loopback
 * listener — and loopback is a private address, so enforcing the rule by default would
 * switch off the receiver a self-hosted deployment exists to talk to. A deployment exposed
 * to untrusted callers turns it on; everyone else keeps the local behaviour.
 *
 * That is also what makes the security property testable: the only address a hermetic test
 * can make reachable is loopback, so "no packet was sent" is observable only when the
 * screening covers loopback — the very case that would break the product if it ran
 * unguarded. `MANAGED_AGENTS_` is the prefix `paths.ts` and `secrets.ts` already read.
 */
export function webhookAddressPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebhookAddressPolicy | undefined {
  const configured = (env.MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES ?? '').trim().toLowerCase();
  // Off unless explicitly switched on: a typo in a variable nobody set must not change
  // delivery behaviour, and neither must a value like `0` or `off` read as truthy.
  if (!['1', 'true', 'on', 'yes', 'enabled'].includes(configured)) return undefined;
  return {
    lookupAddresses: async (hostname) => {
      const answers = await lookup(hostname, { all: true, verbatim: true });
      return answers.map((answer) => answer.address);
    },
    isAddressAllowed: (address) => !isPrivateAddress(address),
  };
}

/**
 * Decide whether an attempt may open a connection, returning the refusal reason when it
 * may not.
 *
 * Every answer the resolver gives must be allowed. A host answering with one public and
 * one private address is refused rather than raced, because which answer the connection
 * would use is not something this code decides.
 *
 * Only a resolved, disallowed address is the published condition. A resolver that fails,
 * or answers with nothing, returns null so the attempt proceeds and fails as an ordinary
 * retryable delivery failure — a name that does not resolve is not an invalid address, and
 * disabling an endpoint for it would turn a transient DNS problem into an operator task.
 */
async function screenEndpointAddress(
  url: string,
  policy: WebhookAddressPolicy | undefined,
): Promise<string | null> {
  if (!policy) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // A URL this malformed has no destination to screen; `fetch` refuses it as before.
    return null;
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // An internal name is refused before the resolver is consulted, so the answer does not
  // depend on resolver state — the rule `address-policy.ts` documents for the same family.
  if (isBlockedInternalHostname(bare)) return `blocked host name ${bare}`;
  let addresses: string[];
  if (net.isIP(bare)) {
    addresses = [bare];
  } else {
    try {
      addresses = await policy.lookupAddresses(bare);
    } catch {
      return null;
    }
  }
  if (addresses.length === 0) return null;
  const disallowed = addresses.find((address) => !policy.isAddressAllowed(address));
  return disallowed ? `disallowed address ${disallowed}` : null;
}

/**
 * The endpoint's state and the reason for it are written together: a stored `disabled`
 * with no reason would be indistinguishable from an operator having switched the endpoint
 * off by hand, and the published contract reports the reason as machine-readable.
 */
function disableEndpoint(db: Database, webhookId: string, reason: string, nowIso: string): void {
  db.prepare(
    `UPDATE webhooks
     SET status = 'disabled', disabled_reason = ?, updated_at = ?
     WHERE id = ?`,
  ).run(reason, nowIso, webhookId);
}

/**
 * How long an endpoint must fail without interruption before the third published auto-disable
 * case fires, when the deployment has not set its own.
 *
 * **This number is not published.** The contract states that the trigger is the *duration* of
 * uninterrupted failure rather than a delivery count, and that a `2xx` resets the window; it
 * never says how long that duration is, so this is a local parameter rather than a conformed
 * value. Recording it as a local choice is the point: a sentence claiming "the published
 * window" here would claim something the contract does not say.
 *
 * Ten minutes is the local policy. It is long enough that a receiver restarting or a network
 * blip — what the published sentence exists to tolerate — is not enough to switch an endpoint
 * off, and short enough that a subscriber which has permanently gone away stops being retried
 * in the same afternoon rather than the next day. The deployment may set its own window with
 * {@link WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV}; an earlier value of 24 hours was neither the
 * published one nor configurable.
 */
export const DEFAULT_SUSTAINED_FAILURE_WINDOW_SECONDS = 600;

/**
 * Bounds for the deployment's own window. A typo guard rather than a policy: a window an
 * operator sets has to be one they could plausibly mean, and the ceiling is the same 30 days
 * the parked-wait bound uses.
 */
const MIN_SUSTAINED_FAILURE_WINDOW_SECONDS = 1;
const MAX_SUSTAINED_FAILURE_WINDOW_SECONDS = 2_592_000;

/**
 * The deployment switch that sets the sustained-failure window, in seconds.
 *
 * This sits beside `MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES` because both are policies
 * of the same delivery subsystem and both are deployment properties rather than parts of the
 * versioned Settings document, whose areas are adapters (`model`, loop engine, storage,
 * memory, sandbox). The runtime records the window it resolves at startup, which is this
 * switch's change trail: a deployment-level variable has no write path of its own to record.
 */
export const WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV = 'MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS';

/** Where the window in effect came from, for the startup record. */
export type WebhookSustainedFailureWindowSource = 'deployment' | 'default' | 'unusable';

export type WebhookSustainedFailureWindow = {
  seconds: number;
  /**
   * `deployment` when the switch supplied a usable value, `default` when it was unset, and
   * `unusable` when it was set to something the parser refused. The third state exists so a
   * typo is recorded as a typo rather than presented as the default the deployment chose.
   */
  source: WebhookSustainedFailureWindowSource;
};

/**
 * Resolve the sustained-failure window from the deployment, falling back to the local default.
 *
 * A value that is not a positive integer inside the bounds is refused rather than clamped: a
 * window of zero would disable an endpoint on its first failure, and a malformed value must not
 * quietly become a policy the operator never chose.
 */
export function resolveWebhookSustainedFailureWindow(
  env: NodeJS.ProcessEnv = process.env,
): WebhookSustainedFailureWindow {
  const configured = (env[WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV] ?? '').trim();
  if (!configured) return { seconds: DEFAULT_SUSTAINED_FAILURE_WINDOW_SECONDS, source: 'default' };
  const seconds = Number(configured);
  if (
    !Number.isInteger(seconds)
    || seconds < MIN_SUSTAINED_FAILURE_WINDOW_SECONDS
    || seconds > MAX_SUSTAINED_FAILURE_WINDOW_SECONDS
  ) {
    return { seconds: DEFAULT_SUSTAINED_FAILURE_WINDOW_SECONDS, source: 'unusable' };
  }
  return { seconds, source: 'deployment' };
}

/** The window one dispatch call runs with: the caller's override, else the deployment's. */
function sustainedFailureWindowSeconds(opts: WebhookDispatchOptions): number {
  const requested = opts.sustainedFailureWindowSeconds;
  if (requested !== undefined && Number.isInteger(requested) && requested > 0) return requested;
  return resolveWebhookSustainedFailureWindow().seconds;
}

/**
 * Advance the per-endpoint failure streak and report where it stands.
 *
 * The streak is stored rather than kept in process memory because the published condition is
 * elapsed time: a counter that resets on every restart would never reach the window in the
 * deployment the rule exists for. `started` opens a streak, `continuing` leaves one running,
 * `overdue` means the window elapsed, and `cleared` is the `2xx` reset — which is a write on
 * the success path, not a no-op, because only a `2xx` resets the window and an endpoint whose
 * failures are interrupted never accumulates toward a disable. The window itself is a
 * parameter: it is the deployment's to set, so a constant here would be the wrong shape.
 */
function recordFailureStreak(
  db: Database,
  webhookId: string,
  ok: boolean,
  nowIso: string,
  windowSeconds: number,
): 'cleared' | 'started' | 'continuing' | 'overdue' {
  const row = db.prepare('SELECT failing_since FROM webhooks WHERE id = ?').get(webhookId) as
    | { failing_since: string | null }
    | undefined;
  if (!row) return 'cleared';
  if (ok) {
    if (row.failing_since !== null) {
      db.prepare('UPDATE webhooks SET failing_since = NULL WHERE id = ?').run(webhookId);
    }
    return 'cleared';
  }
  if (row.failing_since === null) {
    db.prepare('UPDATE webhooks SET failing_since = ? WHERE id = ?').run(nowIso, webhookId);
    return 'started';
  }
  return Date.parse(nowIso) - Date.parse(row.failing_since) >= windowSeconds * 1000
    ? 'overdue'
    : 'continuing';
}

/**
 * The published retry schedule: "retries up to three times per endpoint and event with 5-120 s jittered
 * exponential backoff" (`operations.md`). The ceiling doubles per attempt (60 s, then 120 s) and the
 * actual delay is uniform inside [5 s, ceiling], so two endpoints failing at the same moment do not
 * retry together and no delay leaves the published window. Jitter is what makes retries load-spreading
 * rather than a synchronised re-attack on a receiver that is already struggling.
 */
export function nextRetryAt(ok: boolean, attemptCount: number, opts: WebhookDispatchOptions): string | null {
  if (ok) return null;
  const maxAttempts = opts.maxAttempts ?? 3;
  if (attemptCount >= maxAttempts) return null;
  const ceilingSeconds = Math.min(MAX_RETRY_SECONDS, 2 ** Math.max(0, attemptCount - 1) * 60);
  const random = opts.random ?? Math.random;
  const span = ceilingSeconds - MIN_RETRY_SECONDS;
  const delaySeconds = MIN_RETRY_SECONDS + span * Math.min(Math.max(random(), 0), 1);
  return new Date((opts.now?.() ?? new Date()).getTime() + delaySeconds * 1000).toISOString();
}

function makePayload(webhookId: string, event: WebhookDispatchEvent, now?: () => Date) {
  return {
    type: 'webhook_event',
    id: event.id ?? `whevt_${nanoid(18)}`,
    event: event.event,
    webhook_id: webhookId,
    data: event.data,
    created_at: event.created_at ?? (now?.() ?? new Date()).toISOString(),
  };
}

function eventMatches(subscriptions: string[], event: string): boolean {
  return subscriptions.includes('*') || subscriptions.includes(event) || subscriptions.some((item) => item.endsWith('.*') && event.startsWith(item.slice(0, -1)));
}

/**
 * Legacy signature, kept so a receiver that predates the published header set
 * keeps working. The canonical signature is carried in `webhook-signature`; see
 * `webhook-signature.ts`.
 */
export function signPayload(payload: string, secret: string) {
  return `sha256=${createHmac('sha256', webhookSigningKey(secret)).update(payload).digest('hex')}`;
}

/**
 * The Standard Webhooks v1 signature for one delivery.
 *
 * The signed content is `id.timestamp.body`, so a receiver can detect a
 * replayed or altered delivery rather than only a forged one.
 */
export function webhookDeliverySignature(opts: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
}): string {
  return signWebhookDelivery(opts);
}

function rowById(db: Database, id: string): WebhookDeliveryResult {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as DeliveryRow;
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    status: row.status,
    status_code: row.status_code,
    error: row.error,
    attempt_count: row.attempt_count,
    next_retry_at: row.next_retry_at,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type WebhookRow = StoredWebhookSecret & {
  id: string;
  url: string;
  events: string;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  status: string;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  next_retry_at: string | null;
};

type RetryDeliveryRow = DeliveryRow & StoredWebhookSecret & {
  url: string;
  event: string;
  payload: string;
};
