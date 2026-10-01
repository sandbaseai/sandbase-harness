/**
 * Interactive Console test harness.
 *
 * The rest of this suite renders Console components to static markup in the
 * `node` environment (see `tests/unit/session-modals.test.tsx`); that cannot
 * exercise clicks, typing, or submit flows. This module wraps React Testing
 * Library for the jsdom-based tests, marked with
 * `// @vitest-environment jsdom`, that can.
 *
 * The Console reaches the API through the helpers in
 * `apps/console/src/api.ts` (`postJson`, `getPage`, …). Those helpers go
 * through `fetch`, which jsdom does not stub, so this module installs a
 * `vi.mock` over the api module: every call is recorded, and answered from a
 * per-test `ApiScript`. A test thus asserts on the exact request bodies the
 * Console would send to the server. The script and the request log live in
 * `vi.hoisted` state so the mock factory can close over them.
 *
 * One constraint discovered while building this: with the capturing mock
 * factory below present, a plain `import { screen }` re-exported by name
 * from this module arrives empty at the test file — so every React Testing
 * Library re-export here uses the `export … from` form, which is immune.
 */
import { vi } from 'vitest';

/** A request the Console made through an api.ts helper. */
export type ApiRequest = {
  method: string;
  path: string;
  body?: unknown;
};

/** Answers one Console request. Return an `Error` to make the call fail. */
export type ApiScript = (request: ApiRequest) => unknown;

const state = vi.hoisted(() => ({
  requests: [] as ApiRequest[],
  script: undefined as ApiScript | undefined,
}));

function record(method: string, path: string, body?: unknown) {
  state.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
}

vi.mock('../../../../apps/console/src/api', () => {
  const answer = (method: string, path: string, body?: unknown): Promise<unknown> => {
    recordViaState(method, path, body);
    if (!state.script) {
      return Promise.reject(new Error(`No API script is active for ${method} ${path}`));
    }
    const response = state.script({ method, path, body });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  // The factory must be self-contained; replicate the record push against the
  // hoisted state directly instead of reaching back into module scope.
  const recordViaState = (method: string, path: string, body?: unknown) => {
    state.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
  };
  return {
    getStoredApiKey: () => '',
    setStoredApiKey: () => {},
    clearStoredApiKey: () => {},
    postJson: (path: string, body: unknown) => answer('POST', path, body),
    putJson: (path: string, body: unknown) => answer('PUT', path, body),
    deleteJson: (path: string) => answer('DELETE', path),
    getJson: (path: string) => answer('GET', path),
    getText: (path: string) => answer('GET', path),
    getPage: (path: string) => answer('GET', path),
    getCursorPage: (path: string) => answer('GET', path),
    postForm: (path: string, body: unknown) => answer('POST', path, body),
    // Streams never settle on their own; a test that needs events captures
    // the `onEvent` argument from the recorded request and drives it.
    readEventStream: (path: string, onEvent: (event: unknown) => void) => {
      state.requests.push({ method: 'GET', path, body: onEvent });
      return new Promise<void>(() => {});
    },
    postEventStream: (path: string, body: unknown, onEvent: (event: unknown) => void) => {
      state.requests.push({ method: 'POST', path, body: onEvent });
      return new Promise<void>(() => {});
    },
    createEventStreamParser: (onEvent: (event: unknown) => void) => {
      // The real parser is pure and environment-free; delegate to it.
      const actual = require('../../../../apps/console/src/api').createEventStreamParser;
      return actual(onEvent);
    },
  };
});

/** Install the request script for the current scope. Returns a restore fn. */
export function onApiRequest(script: ApiScript): () => void {
  state.script = script;
  return () => {
    state.script = undefined;
  };
}

/** Every request recorded since the last `resetApi()`. */
export function apiRequests(): readonly ApiRequest[] {
  return state.requests;
}

/** Clears recorded requests and drops the active script. */
export function resetApi(): void {
  state.requests.length = 0;
  state.script = undefined;
}

// Re-exports must use the `export … from` form; a named re-export of an
// import from this module arrives empty at the test file under the capturing
// mock factory above (see the header note).
export { render as renderConsole } from '@testing-library/react';
export { screen, within, act, waitFor, cleanup } from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
