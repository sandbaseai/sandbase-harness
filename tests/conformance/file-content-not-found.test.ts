/**
 * `GET /v1/files/:id/content` answers an unknown file with a 404.
 *
 * The handler resolved the artifact store before it checked that the row
 * existed, and resolving the store throws when the app has no workspace data
 * directory. A request for a file that does not exist therefore came back as a
 * 500 on such an app, which tells a client the server failed rather than that
 * the file is absent.
 *
 * Both app shapes are covered: the conformance driver, which has no workspace
 * and is where the 500 appeared, and an app with a workspace, where the store
 * resolves and the answer must still be a 404 in the standard error envelope.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '@/api/server.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './support/app.js';

const CMA_HEADERS = {
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

const contexts: ConformanceContext[] = [];

function context(): ConformanceContext {
  const ctx = makeConformanceApp('ma-conformance-file-404-');
  contexts.push(ctx);
  return ctx;
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type') ?? '').toContain('application/json');
  const body = (await res.json()) as { error?: { type?: string; message?: string } };
  expect(body.error?.type).toBe('not_found');
  expect(body.error?.message).toBe('File not found');
}

describe('file content for an unknown file', () => {
  afterEach(() => {
    disposeConformanceContexts(contexts);
  });

  it('answers 404 on an app without a workspace', async () => {
    const res = await context().app.request('/v1/files/file_does_not_exist/content', { headers: CMA_HEADERS });
    await expectNotFound(res);
  });

  it('answers 404 on an app with a workspace', async () => {
    const { db, tmpDir } = context();
    const dataDir = join(tmpDir, '.managed-agents');
    mkdirSync(dataDir, { recursive: true });
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        configPath: join(dataDir, 'config.yaml'),
        target: 'local',
      },
    } as Parameters<typeof createServer>[0]);

    const res = await app.request('/v1/files/file_does_not_exist/content', { headers: CMA_HEADERS });
    await expectNotFound(res);
  });
});
