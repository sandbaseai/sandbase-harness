/**
 * First-party SDK compatibility headers.
 *
 * `src/sdk/headers.ts` carries the full rationale. What is pinned here is the
 * part a caller can observe: which pair is sent for a canonical path, which beta
 * is chosen for a memory-store path, that the extension surface gets nothing, and
 * that a caller's own header still wins.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { betaForPath, withCompatibilityHeaders } from '@/sdk/headers.js';
describe('SDK compatibility headers', () => {
  it('sends the version and the managed-agents beta on a canonical request', () => {
    expect(withCompatibilityHeaders('/v1/agents', {})).toEqual({
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'managed-agents-2026-04-01',
    });
  });

  it('sends the memory beta on a memory-store request, not the managed-agents one', () => {
    const headers = withCompatibilityHeaders('/v1/memory_stores', {});
    expect(headers['anthropic-beta']).toBe('agent-memory-2026-07-22');
    expect(headers).not.toHaveProperty('anthropic-beta', 'managed-agents-2026-04-01');
  });

  it('sends no compatibility header on the extension surface', () => {
    // Admission does not gate `/v1/x/*` and no published beta describes it, so
    // claiming canonical coverage there would be false.
    expect(withCompatibilityHeaders('/v1/x/settings', {})).toEqual({});
    expect(betaForPath('/v1/x/settings')).toBeUndefined();
  });

  it('lets a caller override the derived beta', () => {
    const headers = withCompatibilityHeaders('/v1/agents', {
      'anthropic-beta': 'custom-beta',
    });
    expect(headers['anthropic-beta']).toBe('custom-beta');
    expect(headers['anthropic-version']).toBe('2026-10-21');
  });

  it('keeps unrelated caller headers untouched', () => {
    const headers = withCompatibilityHeaders('/v1/agents', { Authorization: 'Bearer k' });
    expect(headers.Authorization).toBe('Bearer k');
  });

  it('shares one definition of the literals with the admission middleware', () => {
    // A second copy in the SDK is how the two drift apart.
    const admission = readFileSync(
      join(process.cwd(), 'src/api/cma-admission.ts'),
      'utf8',
    );
    expect(admission).toContain('from \'@/core/cma/compatibility.js\'');
    expect(admission).not.toContain('managed-agents-2026-04-01');
  });
});
