/**
 * Unit tests for the retry policy and middleware:
 * - `statusCode`-first classification into `server_error` / `overloaded`
 * - exponential backoff honoring Retry-After
 * - the per-turn `RetryObserver` notifications (`onRetryScheduled`,
 *   `onRetryRecovered`) and the `isRetriesExhausted` marker `runTurn` reads
 * - abort-aware waiting so a `user.interrupt` ends the backoff
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { ModelRegistry, isRetriesExhausted } from '@/model/registry.js';
import { DEFAULT_RETRY_POLICY } from '@/types/model.js';

type WireModel = Exclude<LanguageModel, string>;

function apiError(statusCode: number, message = `status ${statusCode}`) {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** A model whose `doGenerate` replays the scripted outcomes in order. */
function scriptedModel(outcomes: Array<unknown>): WireModel {
  let call = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'm',
    supportedUrls: {},
    async doGenerate() {
      const outcome = outcomes[call++] ?? { content: [] };
      if (outcome instanceof Error) throw outcome;
      return { content: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] };
    },
    async doStream() {
      throw new Error('not used');
    },
  } as unknown as WireModel;
}

function wrappedWith(model: WireModel, observer?: Parameters<ModelRegistry['retryMiddleware']>[0]) {
  const registry = new ModelRegistry();
  return wrapLanguageModel({ model, middleware: [registry.retryMiddleware(observer)] });
}

const generateParams = { prompt: [] } as never;

afterEach(() => {
  vi.useRealTimers();
});

describe('DEFAULT_RETRY_POLICY.classify', () => {
  it('reads statusCode before the message', () => {
    const policy = DEFAULT_RETRY_POLICY;
    expect(policy.classify(apiError(500))).toBe('server_error');
    expect(policy.classify(apiError(502))).toBe('server_error');
    expect(policy.classify(apiError(503))).toBe('server_error');
    expect(policy.classify(apiError(504))).toBe('server_error');
    expect(policy.classify(apiError(529))).toBe('overloaded');
    expect(policy.classify(apiError(429))).toBe('rate_limit');
    expect(policy.classify(apiError(401))).toBe('auth');
    expect(policy.classify(apiError(403))).toBe('auth');
    // A status the policy does not retry stays unknown even when the message
    // mentions a retryable word.
    expect(policy.classify(apiError(422, 'timeout while validating'))).toBe('unknown');
    // ...and a retryable status wins over a misleading message.
    expect(policy.classify(apiError(503, '401 unauthorized upstream'))).toBe('server_error');
  });

  it('falls back to the message when there is no status', () => {
    const policy = DEFAULT_RETRY_POLICY;
    expect(policy.classify(new Error('socket timeout'))).toBe('timeout');
    expect(policy.classify(new Error('HTTP 429 rate limit exceeded'))).toBe('rate_limit');
    expect(policy.classify(new Error('model is overloaded'))).toBe('overloaded');
    expect(policy.classify(new Error('401 unauthorized'))).toBe('auth');
    expect(policy.classify(new Error('something else'))).toBe('unknown');
  });
});

describe('DEFAULT_RETRY_POLICY backoff', () => {
  it('retries server_error and overloaded three times with 1s/2s/4s backoff', () => {
    const policy = DEFAULT_RETRY_POLICY;
    expect(policy.maxRetries('server_error')).toBe(3);
    expect(policy.maxRetries('overloaded')).toBe(3);
    expect(policy.getDelay('server_error', 0)).toBe(1000);
    expect(policy.getDelay('server_error', 1)).toBe(2000);
    expect(policy.getDelay('server_error', 2)).toBe(4000);
    expect(policy.getDelay('overloaded', 0)).toBe(1000);
  });

  it('honors Retry-After for the new types too', () => {
    const policy = DEFAULT_RETRY_POLICY;
    const headers = new Headers({ 'retry-after': '7' });
    expect(policy.getDelay('server_error', 0, headers)).toBe(7000);
    expect(policy.getDelay('overloaded', 2, headers)).toBe(7000);
    expect(policy.getDelay('rate_limit', 0, headers)).toBe(7000);
  });
});

describe('retry middleware observer', () => {
  it('reports each scheduled retry and the recovery', async () => {
    const model = scriptedModel([apiError(503), apiError(503), { content: [] }]);
    const scheduled: Array<{ attempt: number; delayMs: number; type: string }> = [];
    let recovered = 0;
    const wrapped = wrappedWith(model, {
      onRetryScheduled: (info) => scheduled.push({ attempt: info.attempt, delayMs: info.delayMs, type: info.type }),
      onRetryRecovered: () => { recovered++; },
    });

    await wrapped.doGenerate(generateParams);

    expect(scheduled).toEqual([
      { attempt: 1, delayMs: 1000, type: 'server_error' },
      { attempt: 2, delayMs: 2000, type: 'server_error' },
    ]);
    expect(recovered).toBe(1);
  }, 10000);

  it('marks the propagated error when retries are exhausted', async () => {
    const failure = apiError(503);
    const model = scriptedModel([failure, failure, failure, failure]);
    const scheduled: number[] = [];
    const wrapped = wrappedWith(model, {
      onRetryScheduled: () => scheduled.push(1),
      onRetryRecovered: () => {},
    });

    const thrown = await wrapped.doGenerate(generateParams).then((v) => v, (err: unknown) => err);
    expect(thrown).toBe(failure);
    expect(isRetriesExhausted(thrown)).toBe(true);
    expect(scheduled).toHaveLength(3);
  }, 10000);

  it('does not observe or mark a non-retryable failure', async () => {
    const failure = apiError(401);
    const model = scriptedModel([failure]);
    const wrapped = wrappedWith(model, {
      onRetryScheduled: () => { throw new Error('must not fire'); },
      onRetryRecovered: () => { throw new Error('must not fire'); },
    });

    const thrown = await wrapped.doGenerate(generateParams).then((v) => v, (err: unknown) => err);
    expect(thrown).toBe(failure);
    expect(isRetriesExhausted(thrown)).toBe(false);
  });

  it('aborts a pending backoff instead of letting the retry land', async () => {
    const model = scriptedModel([apiError(503), { content: [] }]);
    const wrapped = wrappedWith(model);
    const controller = new AbortController();

    const pending = wrapped.doGenerate({ prompt: [], abortSignal: controller.signal } as never);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const thrown = await pending.then((v) => v, (err: unknown) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('AbortError');
  });
});
