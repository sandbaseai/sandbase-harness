/**
 * A token-bearing git invocation must not print a curl trace.
 *
 * This is the behavioural half of the guard in `tests/unit/git-child-env.test.ts`,
 * and it needs no network and no credential: nothing listens on port 1 of the
 * loopback address, so the connection is refused before a packet leaves the
 * machine, and curl still writes its `== Info:` trace when tracing is on.
 *
 * The defect this covers: the child environment used to carry
 * `GIT_CURL_VERBOSE: ''`, and git reads that variable for its *presence*, so the
 * empty string turned tracing on for every invocation — a trace that prints the
 * `Authorization: Basic` header, whose base64 form `sanitizeGitOutput` does not
 * replace.
 *
 * The first case is the control. Without it the second could pass on a git build
 * that simply cannot trace, which would make it prove nothing; it also documents
 * git's presence rule as measured behaviour rather than as a claim.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAuthEnv } from '@/core/resources/github-materializer.js';
import { createGithubMaterializeDeps } from '@/core/resources/github-runtime.js';

/** A URL that refuses the connection locally. Nothing is contacted. */
const UNREACHABLE = 'https://127.0.0.1:1/nothing.git';

/** `no_proxy` keeps a host proxy out of the measurement. */
const OFFLINE = { no_proxy: '*' };

function gitAvailable(): boolean {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();
const TRACE_LINE = '== Info:';

describe.skipIf(!hasGit)('git tracing (real git, no network)', { timeout: 60_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ma-git-trace-'));
  }, 30_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('control: an empty GIT_CURL_VERBOSE traces, which is why the empty value was the defect', () => {
    const control = spawnSync('git', ['ls-remote', UNREACHABLE], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...OFFLINE, GIT_CURL_VERBOSE: '' },
      timeout: 30_000,
    });

    expect(control.status).not.toBe(0);
    expect(control.stderr).toContain(TRACE_LINE);
  });

  it('produces no trace when the invocation carries the authorization header', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot: join(root, 'cache') });

    const result = await deps.runGit(['ls-remote', UNREACHABLE], {
      cwd: root,
      env: { ...gitAuthEnv('unused-for-a-local-command'), ...OFFLINE },
      timeoutMs: 30_000,
    });

    // It failed, as it must — and it failed without printing the header's
    // neighborhood: no trace, so nothing carried the credential out.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain(TRACE_LINE);
  });

  it('cannot be traced by a host variable either, in any casing', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot: join(root, 'cache') });
    const saved = process.env.GIT_CURL_VERBOSE;
    const savedCase = process.env.git_curl_verbose;
    process.env.GIT_CURL_VERBOSE = '1';
    process.env.git_curl_verbose = '1';

    try {
      const result = await deps.runGit(['ls-remote', UNREACHABLE], {
        cwd: root,
        env: { ...gitAuthEnv('unused-for-a-local-command'), ...OFFLINE },
        timeoutMs: 30_000,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain(TRACE_LINE);
    } finally {
      if (saved === undefined) delete process.env.GIT_CURL_VERBOSE;
      else process.env.GIT_CURL_VERBOSE = saved;
      if (savedCase === undefined) delete process.env.git_curl_verbose;
      else process.env.git_curl_verbose = savedCase;
    }
  });
});
