/**
 * Integration test: a self-hosted worker downloads the session's assigned
 * skill packages into `<workdir>/skills/<name>/` — the same layout the
 * runtime's own provisioning writes for `local`/`docker` sessions.
 *
 * Everything runs against the real routes: the session retrieve that names
 * the agent's skill references, the version-content route that serves the
 * package zip, and the `mawt_` scope fence that admits exactly the referenced
 * skill+version and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { createServer } from '@/api/server.js';
import { issueSessionWorkToken } from '@/core/auth/session-work-tokens.js';
import { workerRunCommand } from '@/cli/worker-commands.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};
const API_KEY = 'test-api-key';

describe('worker skill package materialization', () => {
  let db: Database;
  let tmpDir: string;
  let workdir: string;
  let listening: { close: (cb?: () => void) => void } | undefined;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-wskill-'));
    const dataDir = join(tmpDir, 'data');
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();

    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    // The agent assigns one custom skill unpinned and one pinned version.
    db.prepare(
      `INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', ?)`,
    ).run(JSON.stringify({
      name: 'x',
      model: 'test-model',
      skills: [
        { type: 'custom', skill_id: 'skill_pdf' },
        { type: 'custom', skill_id: 'skill_img', version: 'skv_img_v1' },
      ],
    }));
    db.prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_y', 'y', ?)`).run(
      JSON.stringify({ name: 'y', model: 'test-model' }),
    );
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_skills', 'agent_x', 'x', 'env_a', '[]', 'paused')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_other', 'agent_y', 'y', 'env_a', '[]', 'paused')",
    ).run();

    // skill_pdf: two versions, latest points at v2. skill_img: pinned v1.
    const pkgV1 = join(dataDir, 'skills', 'skill_pdf', 'versions', 'skv_pdf_v1');
    const pkgV2 = join(dataDir, 'skills', 'skill_pdf', 'versions', 'skv_pdf_v2');
    const pkgImg = join(dataDir, 'skills', 'skill_img', 'versions', 'skv_img_v1');
    mkdirSync(pkgV1, { recursive: true });
    mkdirSync(join(pkgV2, 'scripts'), { recursive: true });
    mkdirSync(pkgImg, { recursive: true });
    writeFileSync(join(pkgV1, 'SKILL.md'), '# pdf v1\n');
    writeFileSync(join(pkgV2, 'SKILL.md'), '# pdf v2\n');
    const script = join(pkgV2, 'scripts', 'run.sh');
    writeFileSync(script, '#!/bin/sh\necho v2-ran\n');
    if (process.platform !== 'win32') chmodSync(script, 0o755);
    writeFileSync(join(pkgImg, 'SKILL.md'), '# img v1\n');

    const insertSkill = db.prepare(`INSERT INTO skills
      (id, name, description, instructions, frontmatter, file, source, latest_version, versions)
      VALUES (?, ?, 'd', 'i', '{}', '', 'custom', ?, '[]')`);
    insertSkill.run('skill_pdf', 'pdf-tools', 'skv_pdf_v2');
    insertSkill.run('skill_img', 'img-tools', 'skv_img_v1');
    insertSkill.run('skill_secret', 'not-assigned', 'skv_sec_v1');

    const insertVersion = db.prepare(`INSERT INTO skill_versions
      (id, skill_id, seq, name, description, storage_path, created_at) VALUES (?, ?, ?, 'n', 'd', ?, '2026-01-01')`);
    insertVersion.run('skv_pdf_v1', 'skill_pdf', 1, pkgV1);
    insertVersion.run('skv_pdf_v2', 'skill_pdf', 2, pkgV2);
    insertVersion.run('skv_img_v1', 'skill_img', 1, pkgImg);
    const pkgSec = join(dataDir, 'skills', 'skill_secret', 'versions', 'skv_sec_v1');
    mkdirSync(pkgSec, { recursive: true });
    writeFileSync(join(pkgSec, 'SKILL.md'), '# secret\n');
    insertVersion.run('skv_sec_v1', 'skill_secret', 1, pkgSec);

    const skillStub = (id: string, name: string, latest: string) => ({
      id,
      type: 'skill' as const,
      name,
      display_title: name,
      description: 'd',
      instructions: 'i',
      frontmatter: {},
      file: '',
      source: 'custom' as const,
      compatibility: null,
      latest_version: latest,
      versions: [],
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      skills: [
        skillStub('skill_pdf', 'pdf-tools', 'skv_pdf_v2'),
        skillStub('skill_img', 'img-tools', 'skv_img_v1'),
        skillStub('skill_secret', 'not-assigned', 'skv_sec_v1'),
      ],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      // Auth must be on for the mawt_ scope fence to run at all — an
      // api-key-free runtime is open and admits the token unconditionally.
      apiKeys: [API_KEY],
      workQueue: new WorkQueue(db),
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });
    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as { close: (cb?: () => void) => void };
        resolve(info.port);
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;
    token = issueSessionWorkToken(db, 'sess_skills', 'env_a');
  });

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('admits the session-assigned skill versions to a mawt_ bearer and refuses the rest', async () => {
    const get = (path: string) => fetch(`${baseUrl}${path}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });

    // Unpinned reference resolves through the `latest` alias to v2.
    const latest = await get('/v1/skills/skill_pdf/versions/latest/content');
    expect(latest.status).toBe(200);
    expect(latest.headers.get('content-type')).toContain('application/zip');

    // The concrete latest id works too; a version the reference does not
    // point at (the superseded v1) is refused.
    expect((await get('/v1/skills/skill_pdf/versions/skv_pdf_v2/content')).status).toBe(200);
    expect((await get('/v1/skills/skill_pdf/versions/skv_pdf_v1/content')).status).toBe(401);

    // The pinned reference serves exactly its version.
    expect((await get('/v1/skills/skill_img/versions/skv_img_v1/content')).status).toBe(200);

    // A skill the agent never assigned, and a second session's token, refuse.
    expect((await get('/v1/skills/skill_secret/versions/skv_sec_v1/content')).status).toBe(401);
    const otherToken = issueSessionWorkToken(db, 'sess_other', 'env_a');
    const other = await fetch(`${baseUrl}/v1/skills/skill_pdf/versions/latest/content`, {
      headers: { ...HEADERS, authorization: `Bearer ${otherToken}` },
    });
    expect(other.status).toBe(401);
  });

  it('worker run materializes the assigned packages under <workdir>/skills/<name>/', async () => {
    const queue = new WorkQueue(db);
    // The item reads the skill file out of the materialized tree — it can
    // only succeed if the download ran before the item's execution.
    const itemId = queue.enqueue('sess_skills', 'read', { path: 'skills/pdf-tools/SKILL.md' });

    // The poller's half: claim over the real route so the handed item is a
    // real claim carrying the minted `secret`, exactly as a spawned worker
    // receives it.
    const claimRes = await fetch(`${baseUrl}/v1/x/worker/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ worker_id: 'worker_spawn' }),
    });
    const handed = (await claimRes.json()) as { id: string; secret?: string };
    expect(handed.id).toBe(itemId);
    expect(handed.secret).toBeTruthy();

    const envBackup = { ...process.env };
    process.env.MANAGED_AGENTS_SESSION_ID = 'sess_skills';
    process.env.MANAGED_AGENTS_WORKER_ID = 'worker_spawn';
    process.env.MANAGED_AGENTS_BASE_URL = baseUrl;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_ID;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_KEY;
    // The /v1/x/worker/* endpoints sit behind the API key; the worker carries
    // it for claim/accept/heartbeat, while skill content rides on the mawt_.
    process.env.MANAGED_AGENTS_API_KEY = API_KEY;
    try {
      await workerRunCommand(
        { workdir, maxIdleMs: '500', intervalMs: '250' },
        Readable.from([JSON.stringify(handed)]),
      );
    } finally {
      process.env = envBackup;
    }

    // The unpinned reference landed at its latest package; the pinned one at
    // its pinned version. Both under the worker workdir's skills root.
    expect(readFileSync(join(workdir, 'skills', 'pdf-tools', 'SKILL.md'), 'utf8')).toBe('# pdf v2\n');
    expect(readFileSync(join(workdir, 'skills', 'pdf-tools', 'scripts', 'run.sh'), 'utf8')).toContain('v2-ran');
    expect(readFileSync(join(workdir, 'skills', 'img-tools', 'SKILL.md'), 'utf8')).toBe('# img v1\n');
    // A skill the agent never assigned never arrives.
    expect(existsSync(join(workdir, 'skills', 'not-assigned'))).toBe(false);

    if (process.platform !== 'win32') {
      const mode = (await import('node:fs')).statSync(join(workdir, 'skills', 'pdf-tools', 'scripts', 'run.sh')).mode;
      expect(mode & 0o111).not.toBe(0);
    }

    // The work item itself ran inside the materialized tree and reported applied.
    expect(queue.get(itemId)!.status).toBe('applied');
    expect(queue.get(itemId)!.result).toBe('# pdf v2\n');
  });
});
