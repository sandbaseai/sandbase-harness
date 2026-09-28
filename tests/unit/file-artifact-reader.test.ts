/**
 * The reader `SandboxLifecycle` uses to mount an attached file resource.
 *
 * The composition root builds it from the database and the artifact store, and
 * it must answer exactly what the resource admission check admits: the row the
 * Files API wrote, not archived, backed by bytes that are actually on disk. A
 * reader that answered more than that would mount something the caller never
 * attached (a session artifact, an archived upload), and one that answered less
 * would fail a resource the API already accepted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import { createFileArtifactReader } from '@/core/session/session-resources.js';
import { persistFileResource } from '@/api/routes/files.js';
import type { ServerDeps } from '@/api/server.js';

describe('file artifact reader', () => {
  let db: Database;
  let tmpDir: string;
  let store: LocalArtifactStore;
  let deps: ServerDeps;
  let read: (fileId: string) => Buffer | Promise<Buffer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-file-reader-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    store = new LocalArtifactStore(join(tmpDir, 'artifacts'));
    deps = {
      db,
      workspace: { root: tmpDir, dataDir: tmpDir, agentsDir: tmpDir, skillsDir: tmpDir, target: 'local' },
      artifactStore: () => store,
    } as unknown as ServerDeps;
    read = createFileArtifactReader(db, store);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function upload(name: string, content: string, extra: Record<string, unknown> = {}) {
    return persistFileResource(deps, {
      name,
      mediaType: 'text/plain',
      bytes: Buffer.from(content, 'utf8'),
      metadata: {},
      ...extra,
    } as never);
  }

  it('reads back the bytes the Files API stored', () => {
    const file = upload('notes.txt', 'attached bytes') as { id: string };

    expect(read(file.id).toString()).toBe('attached bytes');
  });

  it('answers an archived file as not found', () => {
    const file = upload('notes.txt', 'attached bytes') as { id: string };
    db.prepare('UPDATE files SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), file.id);

    // The same answer the resource admission check gives, so a session cannot
    // mount an upload the caller already archived.
    expect(() => read(file.id)).toThrow(`File not found: ${file.id}`);
  });

  it('answers a row whose bytes are gone as not found', () => {
    const file = upload('notes.txt', 'attached bytes') as { id: string };
    const row = db.prepare('SELECT storage_path FROM files WHERE id = ?').get(file.id) as { storage_path: string };
    store.remove(row.storage_path);

    // A dangling row is reported by file id, never by the host path it points at.
    expect(() => read(file.id)).toThrow(`File not found: ${file.id}`);
  });

  it('refuses a session artifact, which is not an attachable file resource', () => {
    const artifact = upload('log.txt', 'artifact bytes', { role: 'artifact', sessionId: 'sess_x' }) as { id: string };

    // `POST /v1/sessions/{id}/resources` resolves `file_id` against role
    // 'file' only, so an artifact id is never admitted; the reader must not
    // become the way around that check.
    expect(() => read(artifact.id)).toThrow(`File not found: ${artifact.id}`);
  });
});
