import type { Context } from 'hono';
import type { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';

/**
 * Return the stable API envelope for rejected, non-executable capabilities.
 *
 * The return type is written out because the inferred one is not portable: from
 * hono 4.13.10 the JSON response type `c.json()` answers with is declared in a
 * module path a consumer cannot name, and TypeScript refuses to emit a
 * declaration that refers to it (TS2883). `Response` is the published shape
 * every caller already handles, and it is what the sibling helpers in
 * `resource-utils.ts` and `cma-admission.ts` return.
 */
export function unsupportedCapability(c: Context, error: UnsupportedCapabilityError): Response {
  return c.json({
    error: {
      type: error.type,
      message: error.message,
      details: {
        capabilities: error.capabilities.map(({ id, reason }) => ({ id, reason })),
      },
    },
  }, 400);
}
