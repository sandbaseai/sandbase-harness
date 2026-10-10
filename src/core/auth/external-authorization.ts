/**
 * External authorization freshness — the optional veto-only hook consulted
 * once per governed tool call, after the local permission policy cleared it
 * and immediately before execution.
 *
 * The boundary exists for a case the local model cannot answer: a long-running
 * session holds an authorization that was valid when granted, while the policy
 * that produced it has since changed externally (an admin revoked a capability,
 * a policy version rolled forward). The hook composes with the existing
 * permission/approval gates rather than replacing them:
 *
 * - **Veto-only.** A `refuse` blocks the call; an `allow` never widens a local
 *   denial — the hook only ever sees calls the local policy already admitted.
 * - **Fail-closed.** Timeout, unreachable endpoint, malformed response —
 *   everything negative collapses to `refuse`, the same asymmetry the
 *   auto-permission evaluator keeps: a broken judge never silently releases.
 * - **Off means off.** With no hook configured, the turn is byte-for-byte the
 *   one it always was.
 *
 * Wire protocol (`sandbase.authz/v1`): the runtime POSTs the request envelope
 * to the configured endpoint and reads back a decision object
 * (`{"decision": "allow"|"deny"|"reauthorize", ...}` — the decision word is
 * matched case-insensitively because external control planes disagree on
 * casing). Digests are sha256 over the repository's shared canonical-JSON
 * form (`sandbase.digest/v1`), so a policy change that alters the canonical
 * context is what makes a prior authorization stale — the runtime computes
 * the same digest for every call of the same posture, and the authorizer can
 * bind its decision to it.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@/core/handoff/bundle.js';
import type {
  ExternalAuthorizationHook,
  ExternalAuthorizationOutcome,
  ExternalAuthorizationRequest,
  ExternalAuthorizationRefusalReason,
} from '@/types/strategy.js';

export const EXTERNAL_AUTHORIZATION_SCHEMA = 'sandbase.authz/v1' as const;
export const EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA = 'sandbase.digest/v1' as const;
export const EXTERNAL_AUTHORIZATION_CAPABILITY = 'tool.execute' as const;
/** Bounded wait for the synchronous check; expiry is a refusal, not a stall. */
export const EXTERNAL_AUTHORIZATION_DEFAULT_TIMEOUT_MS = 2_000;

export interface ExternalAuthorizationHookOptions {
  /** URL the request envelope is POSTed to. */
  endpoint: string;
  /** Per-call budget in ms; overruns refuse as `unavailable`. */
  timeoutMs?: number;
  /** Extra headers — e.g. an authorizer-facing bearer token. */
  headers?: Record<string, string>;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function refuse(
  reasonCode: ExternalAuthorizationRefusalReason,
  extra: Partial<Extract<ExternalAuthorizationOutcome, { type: 'refuse' }>> = {},
): ExternalAuthorizationOutcome {
  return { type: 'refuse', reasonCode, ...extra };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * sha256 over the shared canonical-JSON form — sorted keys, `undefined`
 * dropped — so both sides digest byte-identical input regardless of how the
 * context object happened to be assembled.
 */
export function authorizationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The digest of everything that can change the decision: the session's
 * effective per-tool permission posture plus the environment and engine it
 * runs under. Capability and target are already first-class request fields —
 * they ride inside the digest too, per the agreed canonical input.
 */
export function policyContextDigest(input: {
  capability: string;
  target: string;
  environmentId?: string | null;
  loopEngine?: string | null;
  toolPolicies: Record<string, string | undefined>;
  /** The credential-set identity bound to the session — a changed set can change the decision. */
  vaultIds?: string[];
}): string {
  return authorizationDigest({
    digest_schema: EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA,
    capability: input.capability,
    target: input.target,
    environment_id: input.environmentId ?? null,
    loop_engine: input.loopEngine ?? null,
    tool_policies: input.toolPolicies,
    vault_ids: input.vaultIds ?? [],
  });
}

/** Assemble the versioned request envelope for one governed invocation. */
export function externalAuthorizationRequest(input: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argumentsDigest: string;
  policyContextDigest: string;
}): ExternalAuthorizationRequest {
  return {
    schema: EXTERNAL_AUTHORIZATION_SCHEMA,
    session_id: input.sessionId,
    invocation_id: input.toolCallId,
    capability: EXTERNAL_AUTHORIZATION_CAPABILITY,
    target: input.toolName,
    arguments_digest: input.argumentsDigest,
    policy_context_digest: input.policyContextDigest,
    digest_schema: EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA,
  };
}

/**
 * Build the HTTP form of the hook. The endpoint contract is deliberately
 * minimal so the authorizer can stay protocol-neutral: the request is the
 * envelope above, the answer is a decision object — and any deviation from
 * that shape is itself a refusal, because an unreadable verdict must never
 * read as permission.
 */
export function createExternalAuthorizationHook(
  options: ExternalAuthorizationHookOptions,
): ExternalAuthorizationHook {
  const timeoutMs = options.timeoutMs ?? EXTERNAL_AUTHORIZATION_DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return refuse('unavailable');
    }
    if (!response.ok) return refuse('unavailable');

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return refuse('malformed');
    }
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const decision = typeof record?.decision === 'string' ? record.decision.toLowerCase() : undefined;
    if (decision === 'allow') return { type: 'allow' };
    if (decision === 'deny' || decision === 'reauthorize') {
      return refuse(decision === 'deny' ? 'denied' : 'reauthorize', {
        reason: optionalString(record?.reason),
        policy_version: optionalString(record?.policy_version),
        decision_id: optionalString(record?.decision_id),
      });
    }
    return refuse('malformed');
  };
}
