import { describe, expect, it } from 'vitest';
import {
  authorizationDigest,
  createExternalAuthorizationHook,
  EXTERNAL_AUTHORIZATION_CAPABILITY,
  EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA,
  EXTERNAL_AUTHORIZATION_SCHEMA,
  externalAuthorizationRequest,
  policyContextDigest,
} from '@/core/auth/external-authorization.js';
import { externalAuthorizationTool } from '@/strategy/default-strategy.js';
import { toolErrorText } from '@/core/tool-result-error.js';
import type { ExternalAuthorizationRequest } from '@/types/strategy.js';

const basePolicyContext = {
  environmentId: 'env_1',
  loopEngine: 'builtin',
  toolPolicies: { read_file: 'always_allow', write_file: 'auto' },
};

describe('authorizationDigest', () => {
  it('is insensitive to object key order', () => {
    expect(authorizationDigest({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(authorizationDigest({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('policyContextDigest', () => {
  it('changes when the effective posture changes', () => {
    const before = policyContextDigest({ capability: 'tool.execute', target: 'write_file', ...basePolicyContext });
    const after = policyContextDigest({
      capability: 'tool.execute',
      target: 'write_file',
      ...basePolicyContext,
      toolPolicies: { ...basePolicyContext.toolPolicies, write_file: 'always_ask' },
    });
    expect(before).not.toBe(after);
  });

  it('is stable for identical posture', () => {
    const a = policyContextDigest({ capability: 'tool.execute', target: 'write_file', ...basePolicyContext });
    const b = policyContextDigest({ capability: 'tool.execute', target: 'write_file', ...basePolicyContext });
    expect(a).toBe(b);
  });
});

describe('externalAuthorizationRequest', () => {
  it('assembles the versioned envelope', () => {
    const request = externalAuthorizationRequest({
      sessionId: 'sess_1',
      toolCallId: 'call_1',
      toolName: 'write_file',
      argumentsDigest: 'aa',
      policyContextDigest: 'bb',
    });
    expect(request).toEqual({
      schema: EXTERNAL_AUTHORIZATION_SCHEMA,
      session_id: 'sess_1',
      invocation_id: 'call_1',
      capability: EXTERNAL_AUTHORIZATION_CAPABILITY,
      target: 'write_file',
      arguments_digest: 'aa',
      policy_context_digest: 'bb',
      digest_schema: EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA,
    });
  });
});

function hookWith(impl: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return createExternalAuthorizationHook({
    endpoint: 'https://authorizer.test/decide',
    timeoutMs: 50,
    fetchImpl: impl as typeof fetch,
  });
}

const sampleRequest = externalAuthorizationRequest({
  sessionId: 'sess_1',
  toolCallId: 'call_1',
  toolName: 'write_file',
  argumentsDigest: 'aa',
  policyContextDigest: 'bb',
});

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

describe('createExternalAuthorizationHook', () => {
  it('posts the request envelope as JSON', async () => {
    let seen: { url: string | URL; init: RequestInit | undefined } | undefined;
    const hook = hookWith(async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { decision: 'ALLOW' });
    });
    await hook(sampleRequest);
    expect(String(seen?.url)).toBe('https://authorizer.test/decide');
    expect(seen?.init?.method).toBe('POST');
    expect((seen?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(seen?.init?.body as string)).toEqual(sampleRequest);
  });

  it('maps allow to allow', async () => {
    const hook = hookWith(() => jsonResponse(200, { decision: 'allow' }));
    expect(await hook(sampleRequest)).toEqual({ type: 'allow' });
  });

  it.each([
    ['deny', 'denied'],
    ['DENY', 'denied'],
    ['reauthorize', 'reauthorize'],
    ['REAUTHORIZE', 'reauthorize'],
  ])('maps %s to a %s refusal', async (decision, reasonCode) => {
    const hook = hookWith(() => jsonResponse(200, {
      decision,
      reason: 'policy rolled forward',
      policy_version: 'v2',
      decision_id: 'dec_9',
    }));
    expect(await hook(sampleRequest)).toEqual({
      type: 'refuse',
      reasonCode,
      reason: 'policy rolled forward',
      policy_version: 'v2',
      decision_id: 'dec_9',
    });
  });

  it.each([
    ['a transport failure', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['an HTTP error status', () => jsonResponse(503, 'unavailable')],
  ])('fails closed on %s', async (_label, impl) => {
    const hook = hookWith(impl);
    expect(await hook(sampleRequest)).toEqual({ type: 'refuse', reasonCode: 'unavailable' });
  });

  it.each([
    ['non-JSON body', () => jsonResponse(200, 'not json {')],
    ['an unknown decision', () => jsonResponse(200, { decision: 'maybe' })],
    ['a missing decision', () => jsonResponse(200, {})],
  ])('fails closed on %s', async (_label, impl) => {
    const hook = hookWith(impl);
    expect(await hook(sampleRequest)).toEqual({ type: 'refuse', reasonCode: 'malformed' });
  });
});

describe('externalAuthorizationTool', () => {
  const underlying = { execute: async () => 'ran' };

  function wrapped(authorize: (request: ExternalAuthorizationRequest) => Promise<{ type: 'allow' } | { type: 'refuse'; reasonCode: 'denied' }>, refusals: Array<{ request: ExternalAuthorizationRequest }>) {
    return externalAuthorizationTool(underlying, {
      sessionId: 'sess_1',
      toolName: 'write_file',
      policyContext: {
        environmentId: 'env_1',
        loopEngine: 'builtin',
        vaultIds: [],
        toolPolicies: { write_file: 'always_allow' },
      },
      authorize,
      onRefusal: (request, outcome) => refusals.push({ request }),
    });
  }

  it('executes on allow and binds the request to the invocation', async () => {
    let seen: ExternalAuthorizationRequest | undefined;
    const tool = wrapped(async (request) => {
      seen = request;
      return { type: 'allow' };
    }, []);
    const result = await tool.execute({ path: 'a.txt' }, { toolCallId: 'call_7' });
    expect(result).toBe('ran');
    expect(seen?.invocation_id).toBe('call_7');
    expect(seen?.target).toBe('write_file');
    expect(seen?.arguments_digest).toBe(authorizationDigest({ path: 'a.txt' }));
    expect(seen?.digest_schema).toBe(EXTERNAL_AUTHORIZATION_DIGEST_SCHEMA);
  });

  it('answers a synthetic error on refuse and never runs the tool', async () => {
    const refusals: Array<{ request: ExternalAuthorizationRequest }> = [];
    const tool = wrapped(
      async () => ({ type: 'refuse' as const, reasonCode: 'denied' as const }),
      refusals,
    );
    const result = await tool.execute({ path: 'a.txt' }, { toolCallId: 'call_8' });
    expect(toolErrorText(result)).toContain('refused by external authorization (denied)');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.request.invocation_id).toBe('call_8');
  });
});
