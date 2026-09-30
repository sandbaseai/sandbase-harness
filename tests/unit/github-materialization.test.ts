/**
 * GitHub repository execution closure (#2).
 *
 * The contract promises a mounted repository, not an intent to mount one, so
 * these tests drive the materializer through the *real* decisions it makes:
 * which revision a clone targets, what reaches git's environment, what happens
 * to a failed clone, which skills get discovered, and whether a token can leak.
 *
 * The clone itself is faked at the git boundary. That is the one seam that
 * cannot be exercised without network access, and faking it there still tests
 * every line of argument and environment construction — which is where the
 * security properties actually live.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_CACHE_DIRNAME,
  cloneArgs,
  discoverRepositorySkills,
  githubCacheKey,
  gitAuthEnv,
  materializeGithubRepository,
  mountIdentityChanged,
  sanitizeGitOutput,
  skillPathsAreTokenFree,
  type GithubRepositoryResource,
  type MaterializeDeps,
} from '@/core/resources/github-materializer.js';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import {
  sandboxCapabilities,
  type SandboxInstance,
  type SandboxProvider,
} from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';

const TOKEN = 'ghp_supersecrettokenvalue0123456789';
const URL = 'https://github.com/acme/widget';

/** A repository tree as `listFiles` would report it. */
const REPO_FILES = [
  'README.md',
  'src/index.ts',
  '.claude/skills/code-review/SKILL.md',
  '.claude/skills/changelog/SKILL.md',
  '.claude/skills/nested/deeper/SKILL.md',
  '.claude/skills/README.md',
  '.git/config',
];

interface FakeGitCall {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A `MaterializeDeps` whose host operations are recorded.
 *
 * The cache probe and the tree listing are the same call in production (a
 * listing either succeeds or it does not), so this fake models them the same
 * way: a path under the cache directory only lists when the test planted it
 * there. Treating every path as listable would make every commit look cached
 * and hide the clone path entirely.
 *
 * `cloneResult` drives the first git call; `failWhen` can fail a later call so
 * a test can break the checkout without breaking the clone.
 */
function fakeDeps(options: {
  files?: string[];
  cloneResult?: { exitCode: number; stdout?: string; stderr?: string };
  failWhen?: (args: string[]) => { exitCode: number; stderr: string } | undefined;
  existingCaches?: Set<string>;
} = {}) {
  const calls: FakeGitCall[] = [];
  const removed: string[] = [];
  const written = new Map<string, string>();
  const files = options.files ?? REPO_FILES;
  const caches = options.existingCaches ?? new Set<string>();

  const deps: MaterializeDeps = {
    cacheRoot: '/cache',
    runGit: async (args, opts) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      const injected = options.failWhen?.(args);
      if (injected) return { exitCode: injected.exitCode, stdout: '', stderr: injected.stderr };
      if (args[0] === 'clone') {
        return {
          exitCode: options.cloneResult?.exitCode ?? 0,
          stdout: options.cloneResult?.stdout ?? '',
          stderr: options.cloneResult?.stderr ?? '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    removeDir: (path) => {
      removed.push(path);
    },
    listFiles: async (path) => {
      // The only listing that can miss is the cache probe, which the
      // materializer runs before it touches git. Once a clone has run, a
      // listing of the staging directory resolves — that is what "the clone
      // produced a tree" means. Modelling it by call order rather than by path
      // shape keeps the fake honest for both the cached and the fresh path.
      if (path.includes(`/${GITHUB_CACHE_DIRNAME}/`) && calls.length === 0) {
        if (!caches.has(path)) throw new Error('ENOENT');
      }
      return files;
    },
    readFile: async (path) => `content of ${path}`,
  };

  const sandbox: SandboxInstance = {
    sessionId: 'sess_test',
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

  return { deps, sandbox, calls, removed, written };
}

function makeResource(overrides: Partial<GithubRepositoryResource> = {}): GithubRepositoryResource {
  return {
    type: 'github_repository',
    url: URL,
    repository: 'acme/widget',
    mount_path: '/workspace/widget',
    authorization_token: TOKEN,
    ...overrides,
  };
}

describe('github clone argument construction', () => {
  it('keeps the token out of argv', () => {
    const args = cloneArgs(URL, { type: 'branch', name: 'main' });
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args.at(-1)).toBe('.');
    expect(args).toContain(URL);
  });

  it('shallow-clones a named branch', () => {
    const args = cloneArgs(URL, { type: 'branch', name: 'release' });
    expect(args).toContain('--depth');
    expect(args).toContain('--branch');
    expect(args[args.indexOf('--branch') + 1]).toBe('release');
  });

  it('does not shallow-clone a commit, which may be unreachable from the head', () => {
    const args = cloneArgs(URL, { type: 'commit', sha: 'abc123' });
    expect(args).not.toContain('--depth');
    expect(args).not.toContain('--branch');
  });

  it('follows the remote default branch when no checkout was asked for', () => {
    const args = cloneArgs(URL, undefined);
    expect(args).toContain('--depth');
    // `HEAD` is a local ref, not a branch a remote serves: passing
    // `--branch HEAD` makes git refuse the clone outright.
    expect(args).not.toContain('--branch');
    expect(args).not.toContain('HEAD');
    expect(args.at(-1)).toBe('.');
  });
});

describe('github git environment', () => {
  it('carries the GitHub Basic authorization header through the environment, not argv', () => {
    const env = gitAuthEnv(TOKEN);
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraheader');
    const expected = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${expected}`);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });

  it('never prompts and never asks for a password', () => {
    const env = gitAuthEnv(TOKEN);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
  });

  it('base64-encodes the GitHub credential inside the Basic header', () => {
    const env = gitAuthEnv(TOKEN);
    const encoded = env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', '');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).toBe(`x-access-token:${TOKEN}`);
  });

  it('sets no tracing switch, because the header a trace would print is in this environment', () => {
    // `GIT_CURL_VERBOSE: ''` looks like "tracing off" and is the opposite: git
    // reads the variable for its presence, so it turned curl tracing on for every
    // invocation. The trace printed the request metadata and the header's
    // presence — git redacts the value by default — and it printed the header as
    // base64 once a host also exported `GIT_TRACE_REDACT=false`, which
    // `sanitizeGitOutput` does not replace, because it strips the token, not its
    // encoding. The child environment is stripped of every tracing family by
    // `gitChildEnv` instead.
    const env = gitAuthEnv(TOKEN);
    const switches = Object.keys(env).filter((name) => /^(GIT_TRACE|GIT_TRACE2|GIT_CURL_VERBOSE)/.test(name));
    expect(switches).toEqual([]);
  });
});

describe('github cache keying', () => {
  it('keys a commit checkout by URL and revision', () => {
    const key = githubCacheKey(URL, { type: 'commit', sha: 'abc123' });
    expect(key).toBeDefined();
    const expected = createHash('sha256').update(`${URL}\nabc123`).digest('hex').slice(0, 32);
    expect(key).toBe(expected);
  });

  it('separates two repositories that share a commit id', () => {
    const a = githubCacheKey('https://github.com/acme/a', { type: 'commit', sha: 'abc123' });
    const b = githubCacheKey('https://github.com/acme/b', { type: 'commit', sha: 'abc123' });
    expect(a).not.toBe(b);
  });

  it('does not cache a branch, whose head moves', () => {
    expect(githubCacheKey(URL, { type: 'branch', name: 'main' })).toBeUndefined();
  });

  it('does not cache an absent checkout, which names no revision at all', () => {
    expect(githubCacheKey(URL, undefined)).toBeUndefined();
  });
});

describe('github materialization', () => {
  it('clones, discovers skills, and mounts the tree without .git', async () => {
    const { deps, sandbox, calls, written } = fakeDeps();
    const result = await materializeGithubRepository(makeResource(), sandbox, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mountPath).toBe('/workspace/widget');
    expect(result.cached).toBe(false);
    // Discovery is one level deep: the nested skill is not announced.
    expect(result.skills).toEqual(['changelog', 'code-review']);
    expect(calls[0]!.args[0]).toBe('clone');
    expect(written.has('/workspace/widget/README.md')).toBe(true);
    expect([...written.keys()].some((path) => path.includes('.git/'))).toBe(false);
  });

  it('checks out a commit after cloning the default branch', async () => {
    const { deps, sandbox, calls } = fakeDeps();
    await materializeGithubRepository(makeResource({ checkout: { type: 'commit', sha: 'abc123' } }), sandbox, deps);

    const checkout = calls.find((call) => call.args[0] === 'checkout');
    expect(checkout?.args).toEqual(['checkout', '--quiet', 'abc123']);
  });

  it('clones the default branch for a resource that names no checkout', async () => {
    // The published resource makes `checkout` optional, and the mount the agent
    // is told about is "the repository's default branch". A clone follows that
    // branch only when no `--branch` is passed, so the materializer must not
    // invent one: a real remote refuses `--branch HEAD`, which is how every
    // un-pinned repository resource failed to mount.
    const { deps, sandbox, calls } = fakeDeps();
    const result = await materializeGithubRepository(makeResource({ checkout: undefined }), sandbox, deps);

    expect(result.ok).toBe(true);
    const clone = calls.find((call) => call.args[0] === 'clone');
    expect(clone?.args).not.toContain('--branch');
    expect(calls.some((call) => call.args[0] === 'checkout')).toBe(false);
  });

  it('fetches a commit the shallow clone could not reach', async () => {
    // Only the *first* checkout fails: the point is that the materializer
    // reaches for the revision after the initial checkout misses, then succeeds.
    let checkouts = 0;
    const { deps, sandbox, calls } = fakeDeps({
      failWhen: (args) => {
        if (args[0] !== 'checkout') return undefined;
        checkouts += 1;
        return checkouts === 1 ? { exitCode: 1, stderr: 'not found' } : undefined;
      },
    });
    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.args[0] === 'fetch')).toBe(true);
    expect(checkouts).toBe(2);
  });

  it('removes the staging directory when the clone fails', async () => {
    const { deps, sandbox, removed } = fakeDeps({
      cloneResult: { exitCode: 128, stderr: 'fatal: repository not found' },
    });
    const result = await materializeGithubRepository(makeResource(), sandbox, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('git clone failed');
    expect(removed.length).toBeGreaterThan(0);
  });

  it('never writes a partially mounted tree when the clone fails', async () => {
    const { deps, sandbox, written } = fakeDeps({
      cloneResult: { exitCode: 128, stderr: 'fatal: nope' },
    });
    await materializeGithubRepository(makeResource(), sandbox, deps);
    expect(written.size).toBe(0);
  });

  it('removes the staging directory when the checkout fails', async () => {
    const { deps, sandbox, removed } = fakeDeps({
      failWhen: (args) =>
        args[0] === 'checkout' || args[0] === 'fetch' ? { exitCode: 128, stderr: 'bad revision' } : undefined,
    });
    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'deadbeef' } }),
      sandbox,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(removed.length).toBeGreaterThan(0);
  });

  it('reuses a cached commit checkout without cloning again', async () => {
    const cacheKey = githubCacheKey(URL, { type: 'commit', sha: 'abc123' })!;
    const cachePath = `/cache/${GITHUB_CACHE_DIRNAME}/${cacheKey}`;
    const { deps, sandbox, calls } = fakeDeps({ existingCaches: new Set([cachePath]) });

    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cached).toBe(true);
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(false);
  });

  it('re-clones a branch even when a checkout is already on disk', async () => {
    const { deps, sandbox, calls } = fakeDeps({ existingCaches: new Set() });
    await materializeGithubRepository(makeResource({ checkout: { type: 'branch', name: 'main' } }), sandbox, deps);
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(true);
  });

  it('refuses a token that cannot be decrypted', async () => {
    const { deps, sandbox } = fakeDeps();
    const result = await materializeGithubRepository(
      makeResource({ authorization_token: { v: 1, data: 'garbage' } as never }),
      sandbox,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('could not be decrypted');
  });

  it('refuses a resource with no token at all', async () => {
    const { deps, sandbox } = fakeDeps();
    const result = await materializeGithubRepository(
      makeResource({ authorization_token: undefined }),
      sandbox,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('missing authorization_token');
  });

  it('refuses a mount path outside the workspace root', async () => {
    const { deps, sandbox } = fakeDeps();
    const result = await materializeGithubRepository(makeResource({ mount_path: '/etc' }), sandbox, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('/workspace');
  });
});

describe('github token hygiene', () => {
  it('uses GitHub Git Smart HTTP Basic auth without placing the token in argv', () => {
    const env = gitAuthEnv(TOKEN);
    const expected = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${expected}`);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(TOKEN);
    expect(Object.values(env).some((value) => value.includes(TOKEN))).toBe(false);
  });

  it('redacts the token from git output', () => {
    const message = `fatal: could not read from https://x-access-token:${TOKEN}@github.com/acme/widget`;
    expect(sanitizeGitOutput(message, TOKEN)).not.toContain(TOKEN);
    expect(sanitizeGitOutput(message, TOKEN)).toContain('[REDACTED]');
  });

  it('redacts a token echoed by a failing clone', async () => {
    const { deps, sandbox } = fakeDeps({
      cloneResult: { exitCode: 128, stderr: `remote: denied for ${TOKEN}` },
    });
    const result = await materializeGithubRepository(makeResource(), sandbox, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(TOKEN);
      expect(result.message).toContain('[REDACTED]');
    }
  });

  it('keeps the token out of every git invocation environment and argv', async () => {
    const { deps, sandbox, calls } = fakeDeps();
    await materializeGithubRepository(makeResource(), sandbox, deps);

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
      // The token is encoded inside the Basic header value rather than exposed
      // as plaintext in any environment field outside git's config channel.
      for (const [key, value] of Object.entries(call.env ?? {})) {
        if (value.includes(TOKEN)) expect(key).toBe('GIT_CONFIG_VALUE_0');
      }
    }
  });

  it('treats a skill name containing the token as unsafe to expose', () => {
    expect(skillPathsAreTokenFree(['code-review'], TOKEN)).toBe(true);
    expect(skillPathsAreTokenFree([`skill-${TOKEN}`], TOKEN)).toBe(false);
  });

  it('refuses to mount when a discovered skill name would carry the token', async () => {
    const { deps, sandbox } = fakeDeps({ files: [`.claude/skills/${TOKEN}/SKILL.md`] });
    const result = await materializeGithubRepository(makeResource(), sandbox, deps);
    expect(result.ok).toBe(false);
  });
});

describe('github skill discovery', () => {
  it('accepts exactly one level of nesting under .claude/skills', async () => {
    const skills = await discoverRepositorySkills('/repo', { listFiles: async () => REPO_FILES });
    expect(skills).toEqual(['changelog', 'code-review']);
  });

  it('ignores a SKILL.md directly under .claude/skills', async () => {
    const skills = await discoverRepositorySkills('/repo', {
      listFiles: async () => ['.claude/skills/SKILL.md'],
    });
    expect(skills).toEqual([]);
  });

  it('normalizes Windows separators', async () => {
    const skills = await discoverRepositorySkills('/repo', {
      listFiles: async () => ['.claude\\skills\\code-review\\SKILL.md'],
    });
    expect(skills).toEqual(['code-review']);
  });

  it('is stable and de-duplicated', async () => {
    const skills = await discoverRepositorySkills('/repo', {
      listFiles: async () => [
        '.claude/skills/zeta/SKILL.md',
        '.claude/skills/alpha/SKILL.md',
        '.claude/skills/zeta/SKILL.md',
      ],
    });
    expect(skills).toEqual(['alpha', 'zeta']);
  });
});

describe('github mount identity', () => {
  it('treats a URL change as requiring a new session', () => {
    expect(mountIdentityChanged(makeResource(), makeResource({ url: 'https://github.com/acme/other' }))).toBe(true);
  });

  it('treats a mount path change as requiring a new session', () => {
    expect(mountIdentityChanged(makeResource(), makeResource({ mount_path: '/workspace/moved' }))).toBe(true);
  });

  it('treats a checkout change as requiring a new session', () => {
    expect(
      mountIdentityChanged(makeResource(), makeResource({ checkout: { type: 'branch', name: 'dev' } })),
    ).toBe(true);
  });

  it('allows a token rotation in place', () => {
    expect(mountIdentityChanged(makeResource(), makeResource({ authorization_token: 'ghp_rotated' }))).toBe(false);
  });
});

// ============================================================
// Lifecycle integration: the mount happens during provisioning
// ============================================================

function makeSandbox(sessionId: string): SandboxInstance {
  return {
    sessionId,
    async execute() {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeFile() {},
    async readFile() {
      return '';
    },
    async listFiles() {
      return [];
    },
    async cleanup() {},
  };
}

function makeProvider(type: string, sandbox: SandboxInstance): SandboxProvider {
  return {
    type,
    capabilities: sandboxCapabilities({}),
    async provision() {
      return sandbox;
    },
  };
}

function sessionWithResources(id: string, resources: unknown[]): Session {
  return {
    id,
    agentId: 'agent_a',
    agentName: 'a',
    environmentId: 'local',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    resources,
  } as unknown as Session;
}

describe('SandboxLifecycle github mounting', () => {
  it('mounts a repository while provisioning and records its skills', async () => {
    const sandbox = makeSandbox('sess_1');
    const mount = vi.fn(async () => ({ ok: true as const, mountPath: '/workspace/widget', skills: ['code-review'], cached: false }));
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', sandbox),
      githubMaterializer: mount,
    });

    await lifecycle.getOrProvision(
      sessionWithResources('sess_1', [
        { type: 'github_repository', url: URL, mount_path: '/workspace/widget', authorization_token: TOKEN },
      ]),
    );

    expect(mount).toHaveBeenCalledTimes(1);
    expect(lifecycle.discoveredRepositorySkills('sess_1')).toEqual(['code-review']);
  });

  it('fails the turn when a repository cannot be mounted', async () => {
    const sandbox = makeSandbox('sess_2');
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', sandbox),
      githubMaterializer: async () => ({ ok: false as const, message: 'git clone failed: denied' }),
    });

    await expect(
      lifecycle.getOrProvision(
        sessionWithResources('sess_2', [{ type: 'github_repository', url: URL, mount_path: '/workspace/widget' }]),
      ),
    ).rejects.toThrow('git clone failed: denied');
  });

  it('refuses a repository resource when no materializer is wired', async () => {
    const sandbox = makeSandbox('sess_3');
    const lifecycle = new SandboxLifecycle({ sandboxProvider: makeProvider('local', sandbox) });

    await expect(
      lifecycle.getOrProvision(
        sessionWithResources('sess_3', [{ type: 'github_repository', url: URL, mount_path: '/workspace/widget' }]),
      ),
    ).rejects.toThrow('require a repository materializer');
  });

  it('does not touch the materializer for a session with no repository', async () => {
    const sandbox = makeSandbox('sess_4');
    const mount = vi.fn();
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', sandbox),
      githubMaterializer: mount as never,
    });

    await lifecycle.getOrProvision(sessionWithResources('sess_4', []));
    expect(mount).not.toHaveBeenCalled();
  });

  it('forgets discovered skills once the session sandbox is cleaned up', async () => {
    const sandbox = makeSandbox('sess_5');
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', sandbox),
      githubMaterializer: async () => ({ ok: true as const, mountPath: '/workspace/widget', skills: ['code-review'], cached: false }),
    });

    await lifecycle.getOrProvision(
      sessionWithResources('sess_5', [{ type: 'github_repository', url: URL, mount_path: '/workspace/widget' }]),
    );
    expect(lifecycle.discoveredRepositorySkills('sess_5')).toEqual(['code-review']);

    await lifecycle.cleanup('sess_5');
    expect(lifecycle.discoveredRepositorySkills('sess_5')).toEqual([]);
  });
});
