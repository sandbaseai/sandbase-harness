/**
 * CMA compatibility header admission.
 *
 * A canonical CMA caller must present `anthropic-version` and the beta matching
 * the resource family it is addressing. The three failure families are kept
 * distinct on purpose — a missing header, a wrong beta, and a beta combination
 * that can never be valid each need different client-side handling, so each
 * returns its own stable code rather than a shared opaque 400.
 *
 * The counterpart guarantee is that `/v1/x/...` is a SandBase extension and is
 * never gated by CMA beta headers: a local caller must not have to impersonate
 * an Anthropic cloud credential to reach its own extension routes.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  CMA_ADMISSION_CODES,
  CMA_AGENT_MEMORY_BETA,
  CMA_ANTHROPIC_VERSION,
  CMA_MANAGED_AGENTS_BETA,
  createCmaRequestAdmissionMiddleware,
} from '../../src/api/cma-admission.js';
import { CMA_ADMITTED_ANTHROPIC_VERSIONS } from '../../src/core/cma/compatibility.js';

function buildApp() {
  const app = new Hono();
  app.use('/v1/*', createCmaRequestAdmissionMiddleware());
  app.get('/v1/agents', (c) => c.json({ ok: true, route: 'agents' }));
  app.get('/v1/sessions/:id/events', (c) => c.json({ ok: true, route: 'events' }));
  app.get('/v1/memory_stores', (c) => c.json({ ok: true, route: 'memory_stores_list' }));
  app.get('/v1/memory_stores/:id', (c) => c.json({ ok: true, route: 'memory_store' }));
  app.get('/v1/memory_stores/:id/memories', (c) => c.json({ ok: true, route: 'memories' }));
  app.get('/v1/x/settings', (c) => c.json({ ok: true, route: 'settings' }));
  return app;
}

const CANONICAL = {
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

describe('CMA admission: compatibility header detection', () => {
  it('leaves a plain local bearer request untouched', async () => {
    const res = await buildApp().request('/v1/agents', { headers: { Authorization: 'Bearer local' } });
    expect(res.status).toBe(200);
    expect((await res.json()).route).toBe('agents');
  });

  it('never gates /v1/x extension routes even with no headers at all', async () => {
    const res = await buildApp().request('/v1/x/settings');
    expect(res.status).toBe(200);
    expect((await res.json()).route).toBe('settings');
  });

  it('treats x-api-key alone as a compatibility caller', async () => {
    const res = await buildApp().request('/v1/agents', { headers: { 'x-api-key': 'sk-test' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.missingVersion);
  });
});

describe('CMA admission: anthropic-version', () => {
  it('rejects a missing anthropic-version with its own code', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: { 'anthropic-beta': CMA_MANAGED_AGENTS_BETA },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe(CMA_ADMISSION_CODES.missingVersion);
  });

  it('rejects an unsupported anthropic-version distinctly from a missing one', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: { ...CANONICAL, 'anthropic-version': '2020-01-01' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.unsupportedVersion);
  });

  it('admits every version value a published client sends and nothing else', async () => {
    // The two admitted values are the published `2026-10-21` (the 1.x SDK and
    // every official-docs example) and `2023-06-01` (the 0.x SDK line). The
    // list is closed: a third value is refused rather than pattern-matched.
    expect(CMA_ADMITTED_ANTHROPIC_VERSIONS).toEqual(['2026-10-21', '2023-06-01']);
    for (const version of CMA_ADMITTED_ANTHROPIC_VERSIONS) {
      const res = await buildApp().request('/v1/agents', {
        headers: { ...CANONICAL, 'anthropic-version': version },
      });
      expect(res.status, version).toBe(200);
    }
  });
});

describe('CMA admission: anthropic-beta', () => {
  it('rejects a missing beta with its own code', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.missingBeta);
  });

  it('rejects a malformed beta list rather than guessing', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': 'managed-agents-2026-04-01,,x' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.malformedBeta);
  });

  it('rejects the memory beta on a non-memory resource', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': CMA_AGENT_MEMORY_BETA },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.unsupportedBeta);
  });

  it('rejects the managed-agents beta on a memory-store mutation', async () => {
    const res = await buildApp().request('/v1/memory_stores/memstore_1', { headers: CANONICAL });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.unsupportedBeta);
  });

  it('accepts the memory beta on a memory-store route', async () => {
    const res = await buildApp().request('/v1/memory_stores/memstore_1', {
      headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': CMA_AGENT_MEMORY_BETA },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).route).toBe('memory_store');
  });
});

describe('CMA admission: memory beta exclusivity', () => {
  it('rejects both memory betas on a memory-store route with a dedicated code', async () => {
    const res = await buildApp().request('/v1/memory_stores/memstore_1', {
      headers: {
        'anthropic-version': CMA_ANTHROPIC_VERSION,
        'anthropic-beta': `${CMA_MANAGED_AGENTS_BETA},${CMA_AGENT_MEMORY_BETA}`,
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.conflictingMemoryBeta);
  });

  it('allows the memory listing under either beta, the sole exception', async () => {
    for (const beta of [CMA_MANAGED_AGENTS_BETA, CMA_AGENT_MEMORY_BETA]) {
      const res = await buildApp().request('/v1/memory_stores/memstore_1/memories', {
        headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': beta },
      });
      expect(res.status, beta).toBe(200);
      expect((await res.json()).route).toBe('memories');
    }
  });

  it('rejects a memory listing with neither accepted beta', async () => {
    const res = await buildApp().request('/v1/memory_stores/memstore_1/memories', {
      headers: { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': 'some-other-beta' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(CMA_ADMISSION_CODES.unsupportedBeta);
  });
});

describe('CMA admission: the happy path still passes', () => {
  it('admits a fully-formed canonical request', async () => {
    for (const path of ['/v1/agents', '/v1/sessions/sevt_1/events']) {
      const res = await buildApp().request(path, { headers: CANONICAL });
      expect(res.status, path).toBe(200);
    }
  });

  it('tolerates surrounding whitespace in header values', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: {
        'anthropic-version': ` ${CMA_ANTHROPIC_VERSION} `,
        'anthropic-beta': ` ${CMA_MANAGED_AGENTS_BETA} `,
      },
    });
    expect(res.status).toBe(200);
  });

  it('accepts a beta list that includes the required beta among others', async () => {
    const res = await buildApp().request('/v1/agents', {
      headers: {
        'anthropic-version': CMA_ANTHROPIC_VERSION,
        'anthropic-beta': `some-preview,${CMA_MANAGED_AGENTS_BETA}`,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('CMA admission: error codes are distinct and stable', () => {
  it('every code is a unique, lowercase snake_case identifier', () => {
    const codes = Object.values(CMA_ADMISSION_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
