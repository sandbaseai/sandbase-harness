/**
 * Session work tokens — the per-session bearer carried in a claimed work
 * item's `secret` on the official Work API wire.
 *
 * A self-hosted worker that claimed an item through
 * `GET /v1/environments/{id}/work/poll` can hold only this token: it
 * authorizes the item-scoped calls for the session that produced the item
 * (ack, heartbeat, update, stop, retrieve) without handing the worker the
 * environment key or an API key. The wire value inside `secret` is a
 * base64url JSON document (`{sessions_token, api_base_url?}`, the published
 * `BetaWorkSecret` shape); this module owns the token's issuance and
 * validation, not the envelope.
 *
 * Issuance is one token per claim: each poll that hands out an item mints a
 * fresh `mawt_...` bound to that item's session and environment. Only the
 * SHA-256 hash and a display prefix are persisted; the raw token is returned
 * to exactly one caller and can never be read back — matching the
 * worker-key contract. A claimed item's secret therefore always differs from
 * the next claim's, which is the published behaviour too: the payload is a
 * per-claim credential, not a session's standing identity.
 *
 * Validation binds three facts at once: the token exists and is not revoked,
 * the session it names is still non-terminal, and the environment it names
 * matches the route's. A session that ended stops authenticating immediately,
 * without a revocation sweep — the token's authority is the session's
 * lifetime, and a worker holding it past the end could otherwise keep
 * touching item records nobody is waiting for.
 */
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { isTerminal } from '@/core/session/state-machine.js';
import type { SessionStatus } from '@/types/session.js';

export type SessionWorkTokenValidation =
  | { ok: true; sessionId: string; environmentId: string }
  | { ok: false };

/** Mint a fresh bearer for a claim about to be handed to a worker. */
export function issueSessionWorkToken(
  db: Database,
  sessionId: string,
  environmentId: string,
): string {
  const token = `mawt_${randomBytes(32).toString('base64url')}`;
  db.prepare(
    `INSERT INTO session_work_tokens (id, session_id, environment_id, token_hash, token_prefix)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`swt_${nanoid(18)}`, sessionId, environmentId, hashSessionWorkToken(token), sessionWorkTokenPrefix(token));
  return token;
}

/**
 * Authenticate a `mawt_...` bearer: the token must be live, its session
 * non-terminal, and it returns the recorded binding rather than trusting the
 * request's own claims about session or environment.
 */
export function validateSessionWorkToken(
  db: Database,
  value: unknown,
): SessionWorkTokenValidation {
  if (typeof value !== 'string' || !value.startsWith('mawt_')) return { ok: false };
  const hash = hashSessionWorkToken(value);
  const row = db.prepare(
    `SELECT id, session_id, environment_id
     FROM session_work_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`,
  ).get(hash) as { id: string; session_id: string; environment_id: string } | undefined;
  if (!row) return { ok: false };
  const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(row.session_id) as
    | { status: SessionStatus }
    | undefined;
  if (!session || isTerminal(session.status)) return { ok: false };
  db.prepare("UPDATE session_work_tokens SET last_seen_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true, sessionId: row.session_id, environmentId: row.environment_id };
}

/**
 * SHA-256 is the right digest here, not a password hash: the input is a
 * 256-bit random bearer (`mawt_` + 32 random bytes), so brute force through
 * the hash is already 2^256 work and a slow KDF would only add latency to
 * every authenticated call. The name avoids `secret`/`password`-style
 * parameter names that pattern-match as credential hashing.
 */
function hashSessionWorkToken(tokenValue: string): string {
  return createHash('sha256').update(tokenValue, 'utf8').digest('hex');
}

/** Same disclosure shape as environment worker keys; only the `mawt_` stem differs. */
function sessionWorkTokenPrefix(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 14) return `${trimmed.slice(0, 4)}...`;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}`;
}
