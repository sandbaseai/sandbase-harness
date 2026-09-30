/**
 * GitHub materialization against real host primitives (#2).
 *
 * The unit suite fakes the git boundary so it can assert argument and
 * environment construction precisely. This suite does the opposite: it uses the
 * *production* dependency wiring — a real `spawn`, real directory walking, real
 * deletion — against a locally-created repository, so the parts the fake
 * replaces are covered by something that actually runs.
 *
 * `materializeGithubRepository` only clones `https://github.com/...`, so it
 * cannot be pointed at a local fixture without weakening the URL rule it
 * enforces. The seam tested here is therefore the host layer itself: the real
 * `runGit` clone, the real recursive listing (including the `.git` exclusion and
 * its separator handling), and the real cleanup. Those are exactly the parts a
 * fake would otherwise paper over.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneArgs, gitAuthEnv, materializeGithubRepository, type MaterializeDeps } from '@/core/resources/github-materializer.js';
import { createGithubMaterializeDeps, createGithubMaterializer } from '@/core/resources/github-runtime.js';
import type { SandboxInstance } from '@/types/sandbox.js';

/** Whether git is on PATH; the whole suite is meaningless without it. */
function gitAvailable(): boolean {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

/** Run git in a directory, failing loudly on a non-zero exit. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * A repository with one commit and one discoverable skill.
 *
 * The branch is named explicitly so the fixture does not depend on the
 * machine's `init.defaultBranch`.
 */
function createFixtureRepo(root: string): { repoPath: string; sha: string } {
  const repoPath = join(root, 'origin');
  mkdirSync(join(repoPath, '.claude', 'skills', 'code-review'), { recursive: true });
  mkdirSync(join(repoPath, 'src', 'nested'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# widget\n');
  writeFileSync(join(repoPath, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(repoPath, 'src', 'nested', 'deep.ts'), 'export const y = 2;\n');
  writeFileSync(
    join(repoPath, '.claude', 'skills', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: Reviews code.\n---\n\nRead the diff.\n',
  );

  git(repoPath, ['init', '--quiet', '--initial-branch=main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '--quiet', '-m', 'initial']);
  return { repoPath, sha: git(repoPath, ['rev-parse', 'HEAD']) };
}

/** `file://` URL for a host path, in the spelling git expects. */
function fileUrl(path: string): string {
  return `file://${path.replace(/\\/g, '/')}`;
}

/**
 * Suite timeout.
 *
 * Every test here shells out to a real `git` and creates a real repository, so
 * the 5s default is not enough once the full suite is running in parallel and
 * git invocations queue up. A generous ceiling is set at the suite level rather
 * than per test, so a slow machine fails loudly on a genuine hang instead of on
 * scheduling contention. The fixture hook gets the same ceiling: it runs three
 * git commands of its own, and under the global `hookTimeout` a cold machine
 * failed the hook rather than a test, which reports as an unrelated failure.
 */
const REAL_GIT_TIMEOUT_MS = 60_000;

describe.skipIf(!hasGit)('github host primitives (real git + real filesystem)', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  let root: string;
  let cacheRoot: string;
  let repoPath: string;
  let sha: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ma-github-'));
    cacheRoot = join(root, 'cache');
    mkdirSync(cacheRoot, { recursive: true });
    ({ repoPath, sha } = createFixtureRepo(root));
  }, REAL_GIT_TIMEOUT_MS);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clones a real repository with the production git runner', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'clone-here');
    mkdirSync(staging, { recursive: true });

    const result = await deps.runGit(cloneArgs(fileUrl(repoPath), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv('irrelevant-for-a-local-clone'),
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(staging, 'README.md'))).toBe(true);
    expect(existsSync(join(staging, '.git'))).toBe(true);
  });

  it('lists a real checkout recursively, including skills, excluding .git', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'listing');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });
    await deps.runGit(cloneArgs(fileUrl(repoPath), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv('unused'),
    });

    const files = await deps.listFiles(staging);
    const normalized = files.map((file) => file.replace(/\\/g, '/'));

    expect(normalized).toContain('README.md');
    expect(normalized).toContain('src/index.ts');
    expect(normalized).toContain('src/nested/deep.ts');
    expect(normalized).toContain('.claude/skills/code-review/SKILL.md');
    // The git directory is never part of what the agent reads.
    expect(normalized.some((file) => file.split('/').includes('.git'))).toBe(false);
  });

  it('reads a real file from a checkout as text', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'reading');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });
    await deps.runGit(cloneArgs(fileUrl(repoPath), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv('unused'),
    });

    const content = await deps.readFile(join(staging, 'README.md'));
    expect(content).toContain('# widget');
  });

  it('deletes a real directory tree, leaving nothing behind', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'deleting');
    mkdirSync(join(staging, 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(staging, 'deep', 'deeper', 'file.txt'), 'x');
    expect(existsSync(staging)).toBe(true);

    deps.removeDir(staging);
    expect(existsSync(staging)).toBe(false);
  });

  it('checks out a real commit by sha after a shallow clone', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'commit-checkout');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });
    await deps.runGit(cloneArgs(fileUrl(repoPath), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv('unused'),
    });

    const checkedOut = await deps.runGit(['checkout', '--quiet', sha], {
      cwd: staging,
      env: gitAuthEnv('unused'),
    });

    expect(checkedOut.exitCode).toBe(0);
    const head = git(staging, ['rev-parse', 'HEAD']);
    expect(head).toBe(sha);
  });

  it('reports a non-zero exit for a repository that does not exist', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'missing');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });

    const result = await deps.runGit(cloneArgs(fileUrl(join(root, 'nope')), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv('unused'),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('never lets a non-zero exit reject the promise', async () => {
    // A failed clone is a domain result the materializer reports, not an
    // exception: a rejection here would bypass its cleanup and message shaping.
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'no-reject');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });

    await expect(
      deps.runGit(cloneArgs(fileUrl(join(root, 'absent')), { type: 'branch', name: 'main' }), {
        cwd: staging,
        env: gitAuthEnv('unused'),
      }),
    ).resolves.toMatchObject({ exitCode: expect.any(Number) });
  });

  it('does not put the token anywhere the fake would have hidden it', async () => {
    // The unit suite asserts argv and env construction; this asserts the one
    // thing only a real process can confirm: that a real `spawn` with the
    // production env builder completes without the token appearing in output.
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'token');
    deps.removeDir(staging);
    mkdirSync(staging, { recursive: true });
    const token = 'ghp_productionwiretoken0123456789';

    const result = await deps.runGit(cloneArgs(fileUrl(repoPath), { type: 'branch', name: 'main' }), {
      cwd: staging,
      env: gitAuthEnv(token),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it('composes a materializer that creates its cache root', () => {
    const freshCache = join(root, 'fresh-cache');
    expect(existsSync(join(freshCache, 'github-repositories'))).toBe(false);
    createGithubMaterializer({ cacheRoot: freshCache });
    expect(existsSync(join(freshCache, 'github-repositories'))).toBe(true);
  });

  it('clones the default branch when no checkout was asked for', async () => {
    // The published resource makes `checkout` optional; a clone with no
    // `--branch` is what follows the remote's default branch. `--branch HEAD`
    // is refused by a real git (`fatal: Remote branch HEAD not found in
    // upstream origin`), which the fake runner in the unit suite cannot show.
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const staging = join(cacheRoot, 'default-branch');
    mkdirSync(staging, { recursive: true });
    const args = cloneArgs(fileUrl(repoPath), undefined);

    expect(args).not.toContain('--branch');
    const result = await deps.runGit(args, { cwd: staging, env: gitAuthEnv('unused') });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(staging, 'README.md'))).toBe(true);
  });

  it('materializes a repository whose resource names no checkout', async () => {
    // The materializer only accepts `https://github.com/<owner>/<repo>`, so the
    // remote URL is rewritten at the git boundary and everything above it — the
    // revision decision, the argument list, the environment, the tree copy — is
    // the production path. This is the test that fails if the default branch is
    // spelled `--branch HEAD` again.
    const deps = createGithubMaterializeDeps({ cacheRoot });
    const cloned: string[][] = [];
    const runGit: MaterializeDeps['runGit'] = async (args, opts) => {
      const local = args.map((arg) => (arg === 'https://github.com/acme/widget' ? fileUrl(repoPath) : arg));
      cloned.push(local);
      return deps.runGit(local, opts);
    };
    const written = new Map<string, string>();
    const sandbox: SandboxInstance = {
      sessionId: 'sess_default_branch',
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      async writeFile(path, content) {
        written.set(path, typeof content === 'string' ? content : content.toString('utf8'));
      },
      async readFile() {
        return '';
      },
      async listFiles() {
        return [];
      },
      async cleanup() {},
    };

    const result = await materializeGithubRepository(
      {
        type: 'github_repository',
        url: 'https://github.com/acme/widget',
        repository: 'acme/widget',
        mount_path: '/workspace/widget',
        authorization_token: 'ghp_localfixturetoken0123456789',
      },
      sandbox,
      { ...deps, runGit },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clone = cloned.find((args) => args[0] === 'clone');
    expect(clone).toBeDefined();
    expect(clone).not.toContain('--branch');
    expect(result.skills).toEqual(['code-review']);
    expect(written.has('/workspace/widget/README.md')).toBe(true);
  });
});
