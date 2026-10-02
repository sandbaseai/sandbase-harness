/**
 * CMA compatibility request admission.
 *
 * CMA clients identify themselves with x-api-key or Anthropic compatibility
 * headers. Those requests must supply the current API version and the beta
 * required by the resource family before a CMA handler can run. Legacy bearer
 * callers without compatibility headers retain the local API contract.
 */

import type { Context, MiddlewareHandler } from 'hono';
import {
  CMA_AGENT_MEMORY_BETA,
  CMA_ANTHROPIC_VERSION,
  CMA_MANAGED_AGENTS_BETA,
  CMA_REFUSED_RESOURCE_BETAS,
} from '@/core/cma/compatibility.js';

// The three literals are owned by `@/core/cma/compatibility.js` so the SDK can
// declare itself a CMA caller with the same values this middleware admits on.
export { CMA_AGENT_MEMORY_BETA, CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA };

/**
 * Stable admission error codes.
 *
 * A caller needs to tell these apart programmatically: a missing version header
 * is a bug in their client, a wrong beta is a wrong resource family, and a
 * combined memory beta is a request that can never be valid for that path.
 * Collapsing them all into one opaque 400 makes correct retry logic impossible,
 * so each condition gets a code that will not change once published.
 */
export const CMA_ADMISSION_CODES = {
  /** A compatibility caller omitted `anthropic-version`. */
  missingVersion: 'missing_anthropic_version',
  /** `anthropic-version` is present but not the supported value. */
  unsupportedVersion: 'unsupported_anthropic_version',
  /** A compatibility caller omitted `anthropic-beta`. */
  missingBeta: 'missing_anthropic_beta',
  /** `anthropic-beta` is present but not comma-separated identifiers. */
  malformedBeta: 'malformed_anthropic_beta',
  /** The beta does not match the resource family being addressed. */
  unsupportedBeta: 'unsupported_anthropic_beta',
  /** Both memory-store betas were sent on a memory-store request. */
  conflictingMemoryBeta: 'conflicting_memory_store_beta',
} as const;

export type CmaAdmissionCode = (typeof CMA_ADMISSION_CODES)[keyof typeof CMA_ADMISSION_CODES];

export function createCmaRequestAdmissionMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isCmaResourcePath(c.req.path) || !hasCmaCompatibilityHeaders(c)) {
      return next();
    }

    const version = c.req.header('anthropic-version')?.trim();
    if (!version) {
      return invalidRequest(c, CMA_ADMISSION_CODES.missingVersion, 'Missing required header: anthropic-version.');
    }
    if (version !== CMA_ANTHROPIC_VERSION) {
      return invalidRequest(
        c,
        CMA_ADMISSION_CODES.unsupportedVersion,
        `Unsupported anthropic-version. Expected "${CMA_ANTHROPIC_VERSION}".`,
      );
    }

    const betaHeader = c.req.header('anthropic-beta')?.trim();
    if (!betaHeader) {
      return invalidRequest(c, CMA_ADMISSION_CODES.missingBeta, 'Missing required header: anthropic-beta.');
    }

    const betas = parseBetaHeader(betaHeader);
    if (!betas) {
      return invalidRequest(
        c,
        CMA_ADMISSION_CODES.malformedBeta,
        'Malformed anthropic-beta header. Provide comma-separated beta identifiers.',
      );
    }

    const memoryStorePath = isMemoryStorePath(c.req.path);
    const hasManagedAgentsBeta = betas.includes(CMA_MANAGED_AGENTS_BETA);
    const hasAgentMemoryBeta = betas.includes(CMA_AGENT_MEMORY_BETA);
    // The CMA memory contract explicitly prohibits combining these resource
    // betas. Reject it before the request can mutate a memory store.
    if (memoryStorePath && hasManagedAgentsBeta && hasAgentMemoryBeta) {
      return invalidRequest(
        c,
        CMA_ADMISSION_CODES.conflictingMemoryBeta,
        'Do not combine managed-agents and agent-memory beta headers for memory-store requests.',
      );
    }

    // CMA defines this read-only listing as equivalent under either beta. It is
    // the sole memory-store exception; all other memory routes require the
    // agent-memory beta and every other CMA resource requires managed-agents.
    if (isMemoryListPath(c.req.method, c.req.path)) {
      if (hasManagedAgentsBeta || hasAgentMemoryBeta) return next();
      return invalidRequest(
        c,
        CMA_ADMISSION_CODES.unsupportedBeta,
        `Unsupported anthropic-beta. Expected "${CMA_MANAGED_AGENTS_BETA}" or "${CMA_AGENT_MEMORY_BETA}".`,
      );
    }

    const requiredBeta = memoryStorePath ? CMA_AGENT_MEMORY_BETA : CMA_MANAGED_AGENTS_BETA;
    const refusedResourceBeta = Object.entries(CMA_REFUSED_RESOURCE_BETAS)
      .find(([prefix]) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`))?.[1];
    if (!betas.includes(requiredBeta) && (!refusedResourceBeta || !betas.includes(refusedResourceBeta))) {
      return invalidRequest(
        c,
        CMA_ADMISSION_CODES.unsupportedBeta,
        `Unsupported anthropic-beta. Expected "${requiredBeta}"${refusedResourceBeta ? ` or "${refusedResourceBeta}"` : ''}.`,
      );
    }

    return next();
  };
}

function isCmaResourcePath(path: string): boolean {
  // The `/v1/x` extension root and everything beneath it stay outside CMA
  // admission, so a caller addressing the extension namespace never has to
  // declare a beta just to reach a non-CMA route.
  return path.startsWith('/v1/') && path !== '/v1/x' && !path.startsWith('/v1/x/');
}

function hasCmaCompatibilityHeaders(c: Context): boolean {
  return c.req.header('x-api-key') !== undefined
    || c.req.header('anthropic-version') !== undefined
    || c.req.header('anthropic-beta') !== undefined;
}

function isMemoryStorePath(path: string): boolean {
  return path === '/v1/memory_stores' || path.startsWith('/v1/memory_stores/');
}

function isMemoryListPath(method: string, path: string): boolean {
  return method === 'GET' && /^\/v1\/memory_stores\/[^/]+\/memories\/?$/.test(path);
}

function parseBetaHeader(value: string): string[] | null {
  const betas = value.split(',').map((beta) => beta.trim());
  return betas.every(Boolean) ? betas : null;
}

/**
 * The admission layer owns the request before any handler runs, so it answers
 * in the same envelope shape the routes use: a typed error with a stable code.
 */
function invalidRequest(c: Context, code: CmaAdmissionCode, message: string): Response {
  return c.json({ error: { type: 'invalid_request_error', code, message } }, 400);
}
