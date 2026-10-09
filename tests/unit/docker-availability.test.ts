import { describe, expect, it } from 'vitest';
import { isDockerAvailable } from '@/sandbox/docker-provider.js';

/**
 * `isDockerAvailable` gates docker provider registration at runtime boot. A
 * single timed-out probe on a loaded machine used to unregister the provider
 * even when the daemon was healthy — the probe result, not the daemon, was
 * what flaked. These cases pin the retry contract with an injected probe so
 * no docker daemon is needed.
 */
describe('isDockerAvailable', () => {
  it('reports available on the first successful probe', () => {
    let calls = 0;
    expect(isDockerAvailable(() => (calls += 1, true))).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries a failed probe before reporting unavailable', () => {
    let calls = 0;
    expect(isDockerAvailable(() => (calls += 1, calls === 3))).toBe(true);
    expect(calls).toBe(3);
  });

  it('stops after the attempt budget and reports unavailable', () => {
    let calls = 0;
    expect(isDockerAvailable(() => (calls += 1, false))).toBe(false);
    expect(calls).toBe(3);
  });
});
