/**
 * Unit tests for the Workspace Snapshot Manager (R9.11).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, relative, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Database } from '@/core/db/database.js';
import { SnapshotManager } from '@/core/session/snapshot-manager.js';

const tarCalls = vi.hoisted(() => ({ invocations: [] as Array<{ args: string[]; cwd: string | undefined }> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: ((cmd: string, args: readonly string[], opts: { cwd?: string }) => {
      tarCalls.invocations.push({ args: [...args], cwd: opts?.cwd });
      return (actual.spawnSync as typeof spawnSync)(cmd, args, { ...opts, encoding: 'utf-8' });
    }) as typeof actual.spawnSync,
  };
});

describe('SnapshotManager', () => {
  let db: Database;
  let root: string;
  let mgr: SnapshotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ma-snap-'));
    db = new Database(join(root, 'test.db'));
    db.runMigrations();
    // snapshots table FK references sessions — seed one
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default','local','{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a','a','{}')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_1','agent_a','a','env_default','running')`);
    mgr = new SnapshotManager(db, join(root, 'snapshots'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a snapshot archive and records it', () => {
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'file.txt'), 'contents');

    const snap = mgr.create('sess_1', workDir);
    expect(snap.id).toMatch(/^snap_/);
    expect(existsSync(snap.path)).toBe(true);
    expect(snap.sizeBytes).toBeGreaterThan(0);

    const list = mgr.list('sess_1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(snap.id);
  });

  it('restores the latest snapshot into a fresh directory', () => {
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'sub'), { recursive: true });
    writeFileSync(join(workDir, 'a.txt'), 'alpha');
    writeFileSync(join(workDir, 'sub', 'b.txt'), 'beta');

    mgr.create('sess_1', workDir);

    const restoreDir = join(root, 'restored');
    const ok = mgr.restoreLatest('sess_1', restoreDir);
    expect(ok).toBe(true);
    expect(readFileSync(join(restoreDir, 'a.txt'), 'utf-8')).toBe('alpha');
    expect(readFileSync(join(restoreDir, 'sub', 'b.txt'), 'utf-8')).toBe('beta');
  });

  it('restoreLatest returns false when no snapshot exists', () => {
    expect(mgr.restoreLatest('sess_1', join(root, 'x'))).toBe(false);
  });

  it('restores the most recent of multiple snapshots', () => {
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'v.txt'), 'v1');
    mgr.create('sess_1', workDir);
    writeFileSync(join(workDir, 'v.txt'), 'v2');
    mgr.create('sess_1', workDir);

    const restoreDir = join(root, 'restored');
    mgr.restoreLatest('sess_1', restoreDir);
    expect(readFileSync(join(restoreDir, 'v.txt'), 'utf-8')).toBe('v2');
    expect(mgr.list('sess_1')).toHaveLength(2);
  });

  it('throws when snapshotting a nonexistent directory', () => {
    expect(() => mgr.create('sess_1', join(root, 'nope'))).toThrow(/does not exist/);
  });

  it('never passes a drive-letter path in the tar command line', () => {
    // GNU tar (the `tar` on the PATH in Git Bash) reads `C:\...` as
    // `<remote-host>:<file>` and fails; bsdtar has no `--force-local`. Every
    // tar argument must therefore be relative to the working directory, or
    // `-` when the archive is piped through a file descriptor.
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'file.txt'), 'contents');

    const invocations = tarCalls.invocations;
    invocations.length = 0;

    const restoreDir = join(root, 'restored');
    mgr.create('sess_1', workDir);
    mgr.restoreLatest('sess_1', restoreDir);

    const calls: Array<{ args: string[]; cwd: string | undefined }> = invocations;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      // Every tar invocation runs with a cwd that holds no drive-letter path
      // in its arguments — the create pass from the working directory, the
      // extract pass from the restore target.
      expect([workDir, restoreDir]).toContain(call.cwd);
      for (const arg of call.args) {
        expect(isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg)).toBe(false);
      }
    }
  });

  it('archives and restores across drives', () => {
    if (process.platform !== 'win32') return; // multiple drives only exist on Windows
    // Probe for a drive other than the one the temp directory lives on; the
    // machine may have no second drive at all, in which case there is nothing
    // cross-drive to cover here.
    const otherDrive = ['D:\\', 'E:\\', 'F:\\'].find((d) => d[0] !== root[0].toUpperCase() && existsSync(d));
    if (!otherDrive) return;
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'a.txt'), 'alpha');

    const crossMgr = new SnapshotManager(db, join(otherDrive, 'ma-snap-xdrive'));
    const snap = crossMgr.create('sess_1', workDir);
    // path.relative goes absolute exactly when the two paths are on
    // different drives, which is the case this test exists for.
    expect(isAbsolute(relative(workDir, snap.path))).toBe(true);
    expect(existsSync(snap.path)).toBe(true);

    const restoreDir = join(root, 'restored');
    expect(crossMgr.restoreLatest('sess_1', restoreDir)).toBe(true);
    expect(readFileSync(join(restoreDir, 'a.txt'), 'utf-8')).toBe('alpha');
    rmSync(join(otherDrive, 'ma-snap-xdrive'), { recursive: true, force: true });
  });
});
