/**
 * Workspace Snapshot Manager (Requirement 9.11)
 *
 * Periodically (or on demand) archives a Sandbox working directory to a tar.gz
 * so a Session can restore its file-system contents when it continues after
 * its sandbox has been re-provisioned. Event_Log
 * replay restores the conversation; snapshots restore the actual bytes.
 *
 * Snapshots are recorded in the `snapshots` table. This uses the `tar` CLI
 * (universally available on macOS/Linux) to avoid a native/npm tar dependency.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdirSync, existsSync, statSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';

export interface SnapshotRecord {
  id: string;
  sessionId: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
}

const TAR_SPAWN_BASE: SpawnSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: 60_000,
};

/**
 * Plan a tar invocation that never passes a drive-letter path on the command
 * line. GNU tar (the `tar` on the PATH in Git Bash) reads `C:\...` as
 * `<remote-host>:<file>` and fails on "Cannot connect to C:", and it is not
 * the only tar in play on a Windows host (bsdtar has no `--force-local`), so
 * neither argument may rely on tar-specific remote-host escape hatches.
 *
 * When the archive and the working directory share a drive, both are passed
 * relative to the working directory. When they sit on different drives
 * (`path.relative` returns an absolute path), the archive is piped through
 * tar's stdin/stdout instead — the command line never mentions the other
 * drive, and the file descriptor carries the bytes across drives.
 */
function planTar(
  workDir: string,
  archivePath: string,
  direction: 'create' | 'extract',
): { cwd: string; args: string[]; stdio?: SpawnSyncOptionsWithStringEncoding['stdio'] } {
  const archiveRel = relative(workDir, archivePath);
  if (!isAbsolute(archiveRel)) {
    return {
      cwd: workDir,
      args:
        direction === 'create'
          ? ['-czf', archiveRel, '-C', '.', '.']
          : ['-xzf', archiveRel, '-C', '.'],
    };
  }
  // Cross-drive: pipe the archive through stdin/stdout.
  if (direction === 'create') {
    return { cwd: workDir, args: ['-czf', '-', '-C', '.', '.'] };
  }
  return { cwd: workDir, args: ['-xzf', '-', '-C', '.'] };
}

export class SnapshotManager {
  constructor(
    private readonly db: Database,
    private readonly snapshotDir: string,
  ) {}

  /**
   * Archive `workDir` into a tar.gz and record it. Returns the snapshot record.
   */
  create(sessionId: string, workDir: string): SnapshotRecord {
    if (!existsSync(workDir)) {
      throw new Error(`Cannot snapshot: working directory does not exist: ${workDir}`);
    }
    const id = `snap_${nanoid(12)}`;
    const outPath = join(this.snapshotDir, sessionId, `${id}.tar.gz`);
    mkdirSync(dirname(outPath), { recursive: true });

    const plan = planTar(workDir, outPath, 'create');
    let fd: number | undefined;
    let stdio: SpawnSyncOptionsWithStringEncoding['stdio'];
    if (plan.args[1] === '-') {
      fd = openSync(outPath, 'w');
      stdio = ['ignore', fd, 'pipe'];
    }
    const r = spawnSync('tar', plan.args, { ...TAR_SPAWN_BASE, cwd: plan.cwd, stdio });
    if (fd !== undefined) closeSync(fd);
    if (r.status !== 0) {
      throw new Error(`tar failed: ${r.stderr || 'unknown error'}`);
    }

    const sizeBytes = existsSync(outPath) ? statSync(outPath).size : 0;
    this.db
      .prepare('INSERT INTO snapshots (id, session_id, path, size_bytes) VALUES (?, ?, ?, ?)')
      .run(id, sessionId, outPath, sizeBytes);

    return { id, sessionId, path: outPath, sizeBytes, createdAt: new Date() };
  }

  /**
   * Restore the most recent snapshot for a session into `workDir`.
   * Returns false if no snapshot exists.
   */
  restoreLatest(sessionId: string, workDir: string): boolean {
    const row = this.db
      .prepare('SELECT path FROM snapshots WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(sessionId) as { path: string } | undefined;
    if (!row || !existsSync(row.path)) return false;

    mkdirSync(workDir, { recursive: true });
    const plan = planTar(workDir, row.path, 'extract');
    let fd: number | undefined;
    let stdio: SpawnSyncOptionsWithStringEncoding['stdio'];
    if (plan.args[1] === '-') {
      fd = openSync(row.path, 'r');
      stdio = [fd, 'ignore', 'pipe'];
    }
    const r = spawnSync('tar', plan.args, { ...TAR_SPAWN_BASE, cwd: plan.cwd, stdio });
    if (fd !== undefined) closeSync(fd);
    return r.status === 0;
  }

  /** List snapshots for a session, newest first. */
  list(sessionId: string): SnapshotRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(sessionId) as unknown as Array<{
      id: string;
      session_id: string;
      path: string;
      size_bytes: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      path: r.path,
      sizeBytes: r.size_bytes,
      createdAt: new Date(r.created_at),
    }));
  }

  /** Remove snapshot files for a session without changing its database rows. */
  removeFiles(sessionId: string): void {
    const rows = this.db
      .prepare('SELECT path FROM snapshots WHERE session_id = ?')
      .all(sessionId) as Array<{ path: string }>;
    const root = resolve(this.snapshotDir);

    for (const row of rows) {
      const target = resolve(row.path);
      if (target === root || !target.startsWith(`${root}${sep}`)) continue;
      rmSync(target, { force: true });
    }

    const sessionDir = resolve(this.snapshotDir, sessionId);
    if (sessionDir.startsWith(`${root}${sep}`)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}
