/**
 * API Authentication Middleware
 *
 * Optional API-key auth. Local-first by default: if no API key is configured,
 * the server runs unauthenticated (suitable for localhost dev). When one or
 * more keys are configured (via MANAGED_AGENTS_API_KEY or managed keys), all
 * protected /v1 routes require exactly one of `Authorization: Bearer <key>` or
 * `x-api-key: <key>`. Supplying both credential sources is always rejected,
 * including while optional auth is disabled and on public paths.
 *
 * Health check (/v1/x/health), metrics, and the dashboard shell (/dashboard and its
 * static assets) are public so liveness probes and the browser app can load
 * before it has a stored API key. Data APIs still require Bearer auth.
 */

import type { MiddlewareHandler } from 'hono';

export interface AuthConfig {
  /** Accepted API keys. Empty/undefined = auth disabled (open). */
  apiKeys?: string[];
  /** Dynamic key presence check, used for database-managed API keys. */
  hasApiKeys?: () => boolean;
  /** Dynamic key validator, used for database-managed API keys. */
  validateApiKey?: (key: string) => boolean;
}

const PUBLIC_PATHS = new Set(['/', '/dashboard', '/ui', '/v1/x/health', '/v1/x/metrics']);

/**
 * The official Work API authenticates with its own credential set — an
 * environment worker key or the per-session token inside a claimed item's
 * `secret`, validated by the route itself (see routes/environment-work.ts).
 * Exempting the prefix lets those bearers reach the resolver instead of being
 * rejected as non-API-key bearers, while the resolver still fails closed on a
 * credential it cannot place. Subroutes that remain unimplemented answer
 * `unsupported_capability` whether or not a credential is present, so
 * exempting them leaks nothing an authenticated caller could not already see.
 */
const WORK_API_PATH = /^\/v1\/environments\/[^/]+\/work(?:\/|$)/;
const INVALID_CREDENTIAL_MESSAGE = 'Missing or invalid API key. Provide exactly one of "Authorization: Bearer <key>" or "x-api-key: <key>".';

export function createAuthMiddleware(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header('Authorization');
    const xApiKeyHeader = c.req.header('x-api-key');

    // Credential-source ambiguity must fail closed before optional-auth and
    // public-route exemptions. Those exemptions make a credential optional,
    // but never make two competing credential sources valid.
    if (authorization !== undefined && xApiKeyHeader !== undefined) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: INVALID_CREDENTIAL_MESSAGE,
          },
        },
        401,
      );
    }

    const keys = new Set((config.apiKeys ?? []).filter((k) => k && k.length > 0));
    const enabled = keys.size > 0 || Boolean(config.hasApiKeys?.());
    if (!enabled) {
      return next();
    }

    // Always allow public liveness/root paths and the static console shell.
    if (
      PUBLIC_PATHS.has(c.req.path)
      || c.req.path.startsWith('/dashboard/')
      || c.req.path.startsWith('/ui/')
      || WORK_API_PATH.test(c.req.path)
    ) {
      return next();
    }

    const bearerToken = authorization === undefined
      ? undefined
      : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
    const xApiKey = xApiKeyHeader?.trim();

    const hasInvalidCredential = (authorization !== undefined && !bearerToken)
      || (xApiKeyHeader !== undefined && !xApiKey);
    const token = bearerToken ?? xApiKey;
    const valid = !hasInvalidCredential && token !== undefined
      ? keys.has(token) || Boolean(config.validateApiKey?.(token))
      : false;
    if (!valid) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: INVALID_CREDENTIAL_MESSAGE,
          },
        },
        401,
      );
    }

    return next();
  };
}

/**
 * Resolve static API keys from the process environment.
 * Env var MANAGED_AGENTS_API_KEY may contain one or more comma-separated keys.
 */
export function resolveApiKeys(): string[] {
  const keys = new Set<string>();
  const envKeys = process.env['MANAGED_AGENTS_API_KEY'];
  if (envKeys) {
    for (const k of envKeys.split(',').map((s) => s.trim()).filter(Boolean)) {
      keys.add(k);
    }
  }
  return Array.from(keys);
}
