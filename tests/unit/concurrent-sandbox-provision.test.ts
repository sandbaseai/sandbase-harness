/**
 * Unit test: concurrent callers share one provisioning pass.
 *
 * `sandbox-lifecycle.ts:73-74` states the rule and the field that implements it:
 * "Prevent concurrent callers from provisioning/materializing twice", over
 * `provisioning: Map<string, Promise<SandboxInstance>>`. `getOrProvision` looks up
 * the bound sandbox, then the in-flight promise, and only then starts a new pass,
 * releasing the entry in a `finally` once it settles.
 *
 * The suite pinned the *sequential* half - "reuses one sandbox per session and
 * cleans it up once" - where the first call has already completed before the second
 * begins, so the bound map answers and the in-flight map is never consulted. That
 * makes the test insensitive to the field it is meant to protect: a provider whose
 * `provision` resolves in a microtask never leaves a second caller anything to
 * collide with. The comment is about callers that arrive *while* a pass is running,
 * and nothing exercised that.
 *
 * The two halves of the guard are asserted here: an in-flight pass is shared rather
 * than duplicated, and a pass that fails is not left in the map, so the next caller
 * gets a real attempt instead of a cached rejection.
 */

import { describe, expect, it } from 'vitest';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import {
  sandboxCapabilities,
  type SandboxInstance,
  type SandboxProvider,
} from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';

function makeSandbox(sessionId: string): SandboxInstance {
  return {
    sessionId,
    async execute() {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeFile() {},
    async readFile() {
      return '';
    },
    async listFiles() {
      return [];
    },
    async cleanup() {},
  };
}

function makeSession(id: string): Session {
  return {
    id,
    agentId: 'agent_a',
    agentName: 'a',
    environmentId: 'env_default',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Session;
}

describe('SandboxLifecycle concurrent provisioning', () => {
  it('gives callers that arrive during a pass the same sandbox, provisioning once', async () => {
    let provisionCount = 0;
    let release: ((sandbox: SandboxInstance) => void) | undefined;
    const sandbox = makeSandbox('sess_1');
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities({ hostFilesystem: true }),
      provision() {
        provisionCount += 1;
        return new Promise<SandboxInstance>((resolve) => {
          release = resolve;
        });
      },
    };
    const lifecycle = new SandboxLifecycle({ sandboxProvider: provider });
    const session = makeSession('sess_1');

    // The second caller arrives while the first pass is still in flight.
    const first = lifecycle.getOrProvision(session);
    const second = lifecycle.getOrProvision(session);
    expect(provisionCount).toBe(1);

    release!(sandbox);
    expect(await first).toBe(sandbox);
    expect(await second).toBe(sandbox);
    expect(lifecycle.get(session.id)).toBe(sandbox);
    expect(provisionCount).toBe(1);
  });

  it('does not answer a later caller with a pass that already failed', async () => {
    let provisionCount = 0;
    const sandbox = makeSandbox('sess_2');
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities({ hostFilesystem: true }),
      async provision() {
        provisionCount += 1;
        if (provisionCount === 1) throw new Error('backend unavailable');
        return sandbox;
      },
    };
    const lifecycle = new SandboxLifecycle({ sandboxProvider: provider });
    const session = makeSession('sess_2');

    await expect(lifecycle.getOrProvision(session)).rejects.toThrow('backend unavailable');
    // The failed attempt must not stay cached: the retry has to reach the backend.
    await expect(lifecycle.getOrProvision(session)).resolves.toBe(sandbox);
    expect(provisionCount).toBe(2);
  });
});
