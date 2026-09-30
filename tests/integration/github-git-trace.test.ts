/**
 * A token-bearing git invocation must not print a curl trace.
 *
 * This is the behavioural half of the guard in `tests/unit/git-child-env.test.ts`.
 *
 * The defect this covers: the child environment used to carry
 * `GIT_CURL_VERBOSE: ''`, and git reads that variable for its *presence*, so the
 * empty string turned tracing on for every invocation. What that trace wrote is
 * narrower than the first revision of this comment claimed: git redacts the
 * `Authorization` header by default, so the token was not printed as base64 by
 * the empty value alone — the header's presence and the transport metadata were,
 * and the trace became credential-bearing once a host also exported
 * `GIT_TRACE_REDACT=false` (measured on git 2.55).
 *
 * Two fixtures, because they answer different questions:
 *
 * - a **refused** connection (nothing listens on port 1) needs no network and
 *   pins that the guarded invocation writes no trace at all;
 * - a **loopback server that accepts** the request is what makes the header
 *   assertion able to fail. A refused connection never sends a header, so
 *   asserting "no `Authorization` line" against it would pass even with the guard
 *   removed. With a listener, tracing on writes
 *   `=> Send header: Authorization: Basic <redacted>`, which is exactly the
 *   control case below.
 *
 * Every case that asserts an absence has a control that shows the fixture can
 * produce the thing being asserted absent. No credential is involved: the header
 * carries a fixture token, and no traffic leaves the loopback interface.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAuthEnv } from '@/core/resources/github-materializer.js';
import { createGithubMaterializeDeps } from '@/core/resources/github-runtime.js';

/** A URL that refuses the connection locally. Nothing is contacted. */
const UNREACHABLE = 'https://127.0.0.1:1/nothing.git';

/** `no_proxy` keeps a host proxy out of the measurement. */
const OFFLINE = { no_proxy: '*' };

const FIXTURE_TOKEN = 'unused-for-a-local-command';
const TRACE_LINE = '== Info:';

function gitAvailable(): boolean {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

/**
 * Run git without the guard, asynchronously.
 *
 * Asynchronous on purpose: the loopback server below runs in this process, and a
 * synchronous spawn would block the event loop it needs to answer on.
 */
function runGitUnguarded(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn('git', args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

/**
 * Serve one git-smart-HTTP-shaped response on a loopback port while `fn` runs.
 *
 * The body does not have to satisfy git: the request reaching the server is the
 * point, because that is what makes curl write the header line.
 */
async function withLoopbackServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    response.end('001e# service=git-upload-pack\n0000');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}/nothing.git`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe.skipIf(!hasGit)('git tracing (real git, loopback only)', { timeout: 60_000 }, () => {
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
      env: { ...gitAuthEnv(FIXTURE_TOKEN), ...OFFLINE },
      timeoutMs: 30_000,
    });

    // It failed, as it must — and it failed without a trace, so nothing carried
    // the credential out.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain(TRACE_LINE);
  });

  it('control: tracing an accepted request writes the header line, which is what the guard prevents', async () => {
    await withLoopbackServer(async (url) => {
      // Unguarded on purpose: the same environment the old `gitAuthEnv` produced,
      // run without `gitChildEnv` in the way.
      const control = await runGitUnguarded(['ls-remote', url], {
        cwd: root,
        env: {
          ...process.env,
          ...OFFLINE,
          ...gitAuthEnv(FIXTURE_TOKEN),
          GIT_CURL_VERBOSE: '',
        },
      });

      expect(control.stderr).toContain(TRACE_LINE);
      // The header goes out. git redacts its value by default, so this is the
      // header's presence rather than the token — which is still the line the
      // guard exists to keep out of stderr.
      expect(control.stderr).toContain('Authorization');
    });
  });

  it('sends no header and writes no trace, even to a server that answers', async () => {
    await withLoopbackServer(async (url) => {
      const deps = createGithubMaterializeDeps({ cacheRoot: join(root, 'cache') });

      const result = await deps.runGit(['ls-remote', url], {
        cwd: root,
        env: { ...gitAuthEnv(FIXTURE_TOKEN), ...OFFLINE },
        timeoutMs: 30_000,
      });

      // This assertion can fail: the control above produces exactly this line
      // with the guard out of the way.
      expect(result.stderr).not.toContain('Authorization');
      expect(result.stderr).not.toContain(TRACE_LINE);
    });
  });

  it('cannot be traced by a host variable either, in any casing', async () => {
    await withLoopbackServer(async (url) => {
      const deps = createGithubMaterializeDeps({ cacheRoot: join(root, 'cache') });
      const saved = process.env.GIT_CURL_VERBOSE;
      const savedCase = process.env.git_curl_verbose;
      process.env.GIT_CURL_VERBOSE = '1';
      process.env.git_curl_verbose = '1';

      try {
        const result = await deps.runGit(['ls-remote', url], {
          cwd: root,
          env: { ...gitAuthEnv(FIXTURE_TOKEN), ...OFFLINE },
          timeoutMs: 30_000,
        });

        expect(result.stderr).not.toContain('Authorization');
        expect(result.stderr).not.toContain(TRACE_LINE);
      } finally {
        if (saved === undefined) delete process.env.GIT_CURL_VERBOSE;
        else process.env.GIT_CURL_VERBOSE = saved;
        if (savedCase === undefined) delete process.env.git_curl_verbose;
        else process.env.git_curl_verbose = savedCase;
      }
    });
  });
});
