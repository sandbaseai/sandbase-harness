import { describe, expect, it } from 'vitest';
import { describeModelError } from '@/strategy/default-strategy.js';
import { MODEL_AUTH_FAILED_CODE, MODEL_NOT_FOUND_CODE } from '@/model/errors.js';

describe('describeModelError', () => {
  it('preserves a plain Error with a real message', () => {
    const result = describeModelError(new Error('boom'));
    expect(result.message).toBe('boom');
  });

  it('enriches an Error that carries HTTP status and network cause', () => {
    const err = Object.assign(new Error('provider request failed'), {
      statusCode: 404,
      cause: { code: 'ECONNRESET' },
    });
    const result = describeModelError(err);
    expect(result.message).toContain('provider request failed');
    expect(result.message).toContain('HTTP 404');
    expect(result.message).toContain('ECONNRESET');
  });

  it('keeps the upstream body on an Error that already has a message', () => {
    // APICallError carries `message: "Bad Request"` plus statusCode and
    // responseBody; the body used to be dropped, leaving "Bad Request (HTTP
    // 400)" with no way to tell an overdrawn account from a bad parameter.
    const err = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
      responseBody: '{"code":"Arrearage","message":"Access denied"}',
    });
    const result = describeModelError(err);
    expect(result.message).toContain('Bad Request');
    expect(result.message).toContain('HTTP 400');
    expect(result.message).toContain('Arrearage');
  });

  it('redacts secrets in a message-bearing Error\'s body and url too', () => {
    const err = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
      url: 'https://gw.example.com/v1/messages?api_key=top-secret-999',
      responseBody: 'key sk-ant-zzzz9999 rejected',
    });
    const result = describeModelError(err);
    expect(result.message).not.toContain('top-secret-999');
    expect(result.message).not.toContain('sk-ant-zzzz9999');
  });

  it('reconstructs a message from an AI SDK-style error with an empty message', () => {
    // APICallError-style object whose message is blank but which carries the
    // real detail in statusCode/url/responseBody.
    const err = Object.assign(new Error(''), {
      name: 'AI_APICallError',
      statusCode: 404,
      url: 'https://api.sandbase.ai/chat/completions',
      responseBody: '404 page not found',
    });
    const result = describeModelError(err);
    expect(result.message).not.toBe('');
    expect(result.message).toContain('HTTP 404');
    expect(result.message).toContain('https://api.sandbase.ai/chat/completions');
    expect(result.message).toContain('404 page not found');
  });

  it('handles a non-Error thrown value without collapsing to [object Object]', () => {
    const result = describeModelError({ statusCode: 500, cause: { code: 'ETIMEDOUT' } });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toBe('[object Object]');
    expect(result.message).toContain('HTTP 500');
    expect(result.message).toContain('ETIMEDOUT');
  });

  it('truncates an oversized response body', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 400,
      responseBody: 'x'.repeat(2000),
    });
    const result = describeModelError(err);
    expect(result.message).toContain('…');
    expect(result.message.length).toBeLessThan(700);
  });

  it('redacts a secret carried in the request URL query string', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 401,
      url: 'https://gw.example.com/v1/chat/completions?api_key=super-secret-value-123&x=1',
    });
    const result = describeModelError(err);
    expect(result.message).not.toContain('super-secret-value-123');
    expect(result.message).toContain('api_key=***');
    expect(result.message).toContain('x=1');
  });

  it('redacts bearer tokens and provider key prefixes echoed in the body', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 500,
      responseBody: 'upstream rejected Authorization: Bearer abcDEF1234567890 for key sk-ant-abcd1234efgh',
    });
    const result = describeModelError(err);
    expect(result.message).not.toContain('abcDEF1234567890');
    expect(result.message).not.toContain('sk-ant-abcd1234efgh');
    expect(result.message).toContain('Bearer ***');
    expect(result.message).toContain('sk-***');
  });

  // A model failure used to reach `session.error` as the same `internal_error`
  // every crashed turn got, so a client could not tell a wrong model id from a
  // broken runtime.
  it('codes a provider 404 as a missing model', () => {
    const err = Object.assign(new Error('model not found'), { statusCode: 404 });
    expect(describeModelError(err)).toMatchObject({ code: MODEL_NOT_FOUND_CODE });
  });

  it.each([401, 403])('codes a provider %i as an authentication failure', (statusCode) => {
    const err = Object.assign(new Error('unauthorized'), { statusCode });
    expect(describeModelError(err)).toMatchObject({ code: MODEL_AUTH_FAILED_CODE });
  });

  it('leaves an unclassified status uncoded', () => {
    // Only a structured status is read: a body that merely mentions "404" must
    // not be classified as a missing model, because a mis-classified failure is
    // worse than an unclassified one.
    const err = Object.assign(new Error('upstream said 404 for a deleted route'), { statusCode: 500 });
    expect((describeModelError(err) as { code?: string }).code).toBeUndefined();
    expect((describeModelError(new Error('turn blew up')) as { code?: string }).code).toBeUndefined();
  });

  it('does not write the code onto the error the caller still holds', () => {
    // The SDK re-throws the same provider error object through the stream, so a
    // caller further out may still inspect it.
    const err = Object.assign(new Error('model not found'), { statusCode: 404 });
    const described = describeModelError(err);
    expect(described).not.toBe(err);
    expect((err as { code?: string }).code).toBeUndefined();
    expect(described.message).toContain(err.message);
  });

  it('keeps the code an error already carries', () => {
    const err = Object.assign(new Error('Provider "openai" is not configured.'), { code: 'model_provider_not_configured' });
    const described = describeModelError(err);
    expect(described).toBe(err);
  });
});
