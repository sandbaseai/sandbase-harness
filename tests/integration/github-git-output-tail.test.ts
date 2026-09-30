/**
 * The tail of a long git stream survives the output cap.
 *
 * `runGit` is only observable through what it actually runs, so this suite gives
 * a real `git` a reason to write tens of thousands of characters to stderr and
 * then reads what came back. Keeping the middle of that stream and keeping its
 * end are the difference between a message that names the failure and one that
 * names nothing — which is how a repository mount once reported 4 017 characters
 * of transport noise instead of the `fatal:` line that explained it.
 *
 * No network: the stream comes from `core.autocrlf` warnings about the fixture's
 * own files.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAuthEnv } from '@/core/resources/github-materializer.js';
import { createGithubMaterializeDeps } from '@/core/resources/github-runtime.js';

/** Enough files that the warnings are an order of magnitude past the cap. */
const WIDE_FILE_COUNT = 400;
const FIRST_FILE = 'f0000.txt';
const LAST_FILE = `f${String(WIDE_FILE_COUNT - 1).padStart(4, '0')}.txt`;

/**
 * The cap the contract documents (`MAX_OUTPUT_CHARS = 4_000`).
 *
 * Written out rather than imported so this case still asserts a bound on the
 * baseline revision, where the constant is not exported: the regression it has to
 * demonstrate is the content of the message, not a missing import.
 */
const DOCUMENTED_CAP = 4_000;

/** Whether git is on PATH; the suite is meaningless without it. */
function gitAvailable(): boolean {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

describe.skipIf(!hasGit)('git output retention (real git)', { timeout: 60_000 }, () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ma-git-tail-'));
    repo = join(root, 'wide');
    mkdirSync(repo, { recursive: true });

    const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo, encoding: 'utf8' });
    expect(init.status).toBe(0);
    // `core.autocrlf=true` makes `git add` warn once per file whose line endings
    // it would rewrite: one long deterministic stream, written to stderr, whose
    // last line names the last file — the same shape a failure message has.
    const config = spawnSync('git', ['config', 'core.autocrlf', 'true'], { cwd: repo, encoding: 'utf8' });
    expect(config.status).toBe(0);
    // The warnings only exist while `core.safecrlf` keeps its default. An ambient
    // `core.safecrlf=false` (a developer's or a runner's global config) silences
    // the stream entirely and fails this case for a reason unrelated to the code:
    // pinned explicitly, so the fixture depends on nothing but this file.
    const safecrlf = spawnSync('git', ['config', 'core.safecrlf', 'warn'], { cwd: repo, encoding: 'utf8' });
    expect(safecrlf.status).toBe(0);

    for (let i = 0; i < WIDE_FILE_COUNT; i += 1) {
      writeFileSync(join(repo, `f${String(i).padStart(4, '0')}.txt`), 'line one\nline two\n');
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the end of a long stream rather than its middle', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot: join(root, 'cache') });
    const result = await deps.runGit(['add', '--all'], { cwd: repo, env: gitAuthEnv('unused-for-a-local-command') });

    expect(result.exitCode).toBe(0);
    // The pair is the point: the fixture's stream is an order of magnitude past
    // the cap, so keeping the tail and keeping the middle cannot both contain
    // the last file and omit the first one.
    expect(result.stderr.length).toBeLessThanOrEqual(DOCUMENTED_CAP);
    expect(result.stderr).toContain(LAST_FILE);
    expect(result.stderr).not.toContain(FIRST_FILE);
  });
});
