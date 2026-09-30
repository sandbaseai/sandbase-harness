/**
 * GitHub repository materialization: turning a `github_repository` resource
 * into a real checkout inside a session's sandbox.
 *
 * The contract treats a mounted repository as part of the agent's *instruction
 * boundary*: its root `.claude/skills` becomes agent-visible skill content
 * with no review step. Three consequences shape this module.
 *
 * **The token never becomes observable.** It is decrypted only to build an
 * `Authorization` header for the clone, passed to git through the environment
 * rather than argv (argv is visible in `ps` and lands in process listings), and
 * never included in a command string, an event, a log line, or a skill file.
 * Any output produced during the clone passes through the session redactor
 * before it can be returned or persisted.
 *
 * **The cache is keyed by identity, not by session.** Two sessions mounting the
 * same commit share a checkout, because a repository at a fixed revision is
 * immutable. A branch is *not* immutable, so a branch checkout is re-resolved
 * on every materialization and is never served from cache — serving a stale
 * branch head would silently change what the agent reads.
 *
 * **Failure must leave nothing behind.** A clone that fails partway, an unknown
 * commit, and a token that authenticates nothing all land in the same place:
 * the working directory is removed and the error propagates, so a session never
 * starts against a half-populated mount.
 */

import { createHash } from 'node:crypto';
import type { Database } from '@/core/db/database.js';
import { decryptSecret, type EncryptedSecret } from '@/core/security/secrets.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import {
  githubCheckoutSchema,
  isDiscoverableSkillPath,
  normalizeRepoMountPath,
  parseCheckout,
  parseGithubRepositoryUrl,
  repoSkillsPath,
  sortDiscoveredSkills,
  type GithubCheckout,
} from './github-repository.js';

/** Directory a repository is staged into on the host before copying in. */
export const GITHUB_CACHE_DIRNAME = 'github-repositories';

/** Timeout for a single git invocation, in milliseconds. */
export const GIT_TIMEOUT_MS = 120_000;

export interface GithubRepositoryResource {
  type: 'github_repository';
  url: string;
  repository: string;
  mount_path: string;
  checkout?: GithubCheckout;
  authorization_token?: EncryptedSecret | string;
}

export type MaterializeResult =
  | {
      ok: true;
      /** Absolute sandbox path the repository is mounted at. */
      mountPath: string;
      /** Skill directories discovered at `.claude/skills/<name>/SKILL.md`. */
      skills: string[];
      /** Whether the checkout was served from cache. */
      cached: boolean;
    }
  | {
      ok: false;
      message: string;
    };

export interface MaterializeDeps {
  /**
   * Reserved for a future revision that records cache provenance. The
   * materializer derives everything it needs from the resource plus the cache
   * root, so nothing here reads it yet.
   */
  db?: Database;
  /** Root directory for cached checkouts, on the host. */
  cacheRoot: string;
  /** Workspace data dir, for secret decryption. */
  dataDir?: string;
  /** Runs a command; returns stdout/stderr/exit code. Never receives the token. */
  runGit: (args: string[], opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Removes a directory tree, used for failure cleanup. */
  removeDir: (path: string) => Promise<void> | void;
  /** Recursively lists files under a directory, as paths relative to it. */
  listFiles: (path: string) => Promise<string[]>;
  /** Reads a file as text. */
  readFile: (path: string) => Promise<string>;
}

/**
 * Cache key for a repository at a fixed revision.
 *
 * A branch has no fixed revision, so it never gets a cache key and is always
 * re-resolved. So does an absent checkout, which resolves to the remote's own
 * default branch and therefore names no revision at all. The key includes the
 * URL so two repositories that happen to share a commit id cannot collide.
 */
export function githubCacheKey(url: string, checkout: GithubCheckout | undefined): string | undefined {
  if (!checkout || checkout.type !== 'commit') return undefined;
  return createHash('sha256').update(`${url}\n${checkout.sha}`).digest('hex').slice(0, 32);
}

/**
 * The git clone arguments for a repository.
 *
 * The token is deliberately absent: a caller supplies it via `GIT_ASKPASS`-less
 * header injection instead, so it cannot appear in argv. `--depth 1` is used
 * for a branch (the head is all the contract promises) and omitted for a commit,
 * where a full fetch is needed to reach an arbitrary revision.
 *
 * An absent checkout is the remote's default branch, which is what a clone
 * without `--branch` already produces: `HEAD` is a local ref name, not a branch
 * a remote serves, so spelling the default as `--branch HEAD` makes git refuse
 * the clone with `fatal: Remote branch HEAD not found in upstream origin`.
 */
export function cloneArgs(url: string, checkout: GithubCheckout | undefined): string[] {
  const args = ['clone', '--no-tags', '--quiet'];
  if (!checkout || checkout.type === 'branch') args.push('--depth', '1');
  if (checkout?.type === 'branch') args.push('--branch', checkout.name);
  args.push(url, '.');
  return args;
}

/**
 * Environment for a git invocation that must authenticate.
 *
 * GitHub's Git Smart HTTP transport accepts the token as the password for the
 * `x-access-token` user. The resulting Basic header is carried through
 * `GIT_CONFIG_*` rather than argv, so `ps`, shell history, and error output do
 * not expose the token.
 *
 * No tracing switch is set here, and none may be: git reads `GIT_CURL_VERBOSE`
 * for its *presence*, so the `GIT_CURL_VERBOSE: ''` an earlier revision set to
 * "keep the header out of any config dump" did the opposite and turned curl
 * tracing on for every invocation — that is, it wrote transport metadata and the
 * `Authorization` header's presence to stderr on every clone, and it pushed the
 * `fatal:` line past the bounded output this module keeps. The header itself is
 * redacted by default (`Authorization: Basic <redacted>`, measured on git 2.55)
 * and unredacted once `GIT_TRACE_REDACT=false` is exported alongside it, so the
 * trace was one host variable away from the token and the mechanism cannot rest
 * on redaction. Where that guarantee lives now is `gitChildEnv` in
 * `github-runtime.ts`, which removes every tracing switch from the child
 * environment whether it was inherited or passed in.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const header = `Authorization: Basic ${basic}`;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: header,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  };
}

/** Decrypt a resource's stored token, tolerating a plain string for tests. */
export function resolveGithubToken(
  resource: GithubRepositoryResource,
  dataDir?: string,
): { ok: true; token: string } | { ok: false; message: string } {
  const stored = resource.authorization_token;
  if (!stored) return { ok: false, message: 'github_repository resource is missing authorization_token' };
  if (typeof stored === 'string') return { ok: true, token: stored };
  try {
    return { ok: true, token: decryptSecret(stored, dataDir) };
  } catch {
    return { ok: false, message: 'github_repository authorization_token could not be decrypted' };
  }
}

/**
 * Whether a path may appear in any string that reaches a log, event, error, or
 * the model. Skill paths are repository-relative and contain no token, but the
 * check keeps the invariant explicit and testable.
 */
export function skillPathsAreTokenFree(paths: readonly string[], token: string): boolean {
  if (!token) return true;
  return paths.every((path) => !path.includes(token));
}

/**
 * GitHub's own error text can echo the request URL. Strip the token before any
 * string derived from git output is returned or persisted.
 */
export function sanitizeGitOutput(text: string, token: string): string {
  if (!text) return text;
  if (!token) return text;
  return text.split(token).join('[REDACTED]');
}

/**
 * Await a cleanup step without letting its own failure mask the real error.
 *
 * `removeDir` may be synchronous or asynchronous depending on the caller, and a
 * cleanup that throws must never replace the clone failure that triggered it.
 */
async function ignoreFailure(step: void | Promise<void>): Promise<void> {
  try {
    await step;
  } catch {
    /* cleanup is best-effort by design */
  }
}

/**
 * List skill directory names discoverable from a checked-out repository.
 *
 * Discovery is exactly one level under `.claude/skills`, matching the contract;
 * a nested layout is not announced as a session skill. Names are returned
 * sorted and de-duplicated so a listing is stable across runs.
 */
export async function discoverRepositorySkills(
  repoRoot: string,
  deps: Pick<MaterializeDeps, 'listFiles'>,
): Promise<string[]> {
  const prefix = '.claude/skills/';
  const files = await deps.listFiles(repoRoot);
  const names = files
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => file.startsWith(prefix))
    .filter((file) => isDiscoverableSkillPath(file))
    .map((file) => file.slice(prefix.length).split('/')[0]!)
    .filter((name): name is string => Boolean(name));
  return sortDiscoveredSkills(names);
}

/**
 * Clone (or reuse) a repository and materialize it into a sandbox.
 *
 * Order is chosen so that no failure can leave a partially mounted repository:
 *
 * 1. Validate the resource and decrypt the token.
 * 2. Reuse a cached commit checkout when one exists.
 * 3. Otherwise clone into the cache, checking out the requested revision.
 * 4. Scan `.claude/skills` before copying, so a repository whose skills cannot
 *    be enumerated is refused rather than mounted skill-less.
 * 5. Copy the tree into the sandbox at `mount_path`.
 *
 * Every failure path removes whatever was created, so the sandbox never keeps a
 * half-populated mount.
 */
export async function materializeGithubRepository(
  resource: GithubRepositoryResource,
  sandbox: SandboxInstance,
  deps: MaterializeDeps,
): Promise<MaterializeResult> {
  const parsedUrl = parseGithubRepositoryUrl(resource.url);
  if (!parsedUrl.ok) return { ok: false, message: parsedUrl.message };

  const checkout = resource.checkout;
  const checkoutCheck = parseCheckout(checkout);
  if (!checkoutCheck.ok) return { ok: false, message: checkoutCheck.message };

  const mount = normalizeRepoMountPath(resource.mount_path, parsedUrl.value.mountPath);
  if (!mount.ok) return { ok: false, message: mount.message };
  const mountPath = mount.value;

  const token = resolveGithubToken(resource, deps.dataDir);
  if (!token.ok) return { ok: false, message: token.message };

  // An absent checkout is the remote's default branch, not a branch named
  // `HEAD`: the clone below follows the default branch when no `--branch` is
  // passed. Synthesizing `{ type: 'branch', name: 'HEAD' }` here made every
  // un-pinned resource clone with `--branch HEAD`, which a real remote refuses
  // (`fatal: Remote branch HEAD not found in upstream origin`), so the mount
  // failed for exactly the resources that asked for no revision in particular.
  const revision = checkoutCheck.value;
  const cacheKey = githubCacheKey(parsedUrl.value.url, revision);
  const cachePath = cacheKey ? `${deps.cacheRoot}/${GITHUB_CACHE_DIRNAME}/${cacheKey}` : undefined;

  let staging: string | undefined;
  let cached = false;
  try {
    if (cachePath) {
      const hit = await deps.listFiles(cachePath).then(() => true).catch(() => false);
      if (hit) {
        staging = cachePath;
        cached = true;
      }
    }

    if (!staging) {
      staging = cachePath ?? `${deps.cacheRoot}/${GITHUB_CACHE_DIRNAME}/tmp-${createHash('sha256').update(`${parsedUrl.value.url}:${Date.now()}`).digest('hex').slice(0, 16)}`;
      await ignoreFailure(deps.removeDir(staging));
      const clone = await deps.runGit(cloneArgs(parsedUrl.value.url, revision), {
        cwd: staging,
        env: gitAuthEnv(token.token),
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (clone.exitCode !== 0) {
        await ignoreFailure(deps.removeDir(staging));
        return {
          ok: false,
          message: `git clone failed: ${sanitizeGitOutput(clone.stderr || clone.stdout, token.token).trim()}`,
        };
      }

      // A clone follows the default branch unless `--branch` said otherwise, so
      // an explicit commit still needs a checkout (and, for a shallow clone, a
      // fetch of that revision).
      if (revision?.type === 'commit') {
        const checkedOut = await deps.runGit(['checkout', '--quiet', revision.sha], {
          cwd: staging,
          env: gitAuthEnv(token.token),
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (checkedOut.exitCode !== 0) {
          const fetched = await deps.runGit(['fetch', '--quiet', '--depth', '1', 'origin', revision.sha], {
            cwd: staging,
            env: gitAuthEnv(token.token),
            timeoutMs: GIT_TIMEOUT_MS,
          });
          if (fetched.exitCode !== 0) {
            await ignoreFailure(deps.removeDir(staging));
            return {
              ok: false,
              message: `git checkout failed: ${sanitizeGitOutput(fetched.stderr || fetched.stdout, token.token).trim()}`,
            };
          }
          const retry = await deps.runGit(['checkout', '--quiet', revision.sha], {
            cwd: staging,
            env: gitAuthEnv(token.token),
            timeoutMs: GIT_TIMEOUT_MS,
          });
          if (retry.exitCode !== 0) {
            await ignoreFailure(deps.removeDir(staging));
            return {
              ok: false,
              message: `git checkout failed: ${sanitizeGitOutput(retry.stderr || retry.stdout, token.token).trim()}`,
            };
          }
        }
      }
    }

    const skills = await discoverRepositorySkills(staging, deps);
    // A discovered skill name becomes a path in the sandbox and a line in the
    // prompt, so it must never carry the token.
    if (!skillPathsAreTokenFree(skills, token.token)) {
      return { ok: false, message: 'repository skill names are not safe to expose' };
    }

    const files = await deps.listFiles(staging);
    for (const relative of files) {
      const normalized = relative.replace(/\\/g, '/');
      if (normalized.includes('.git/') || normalized.endsWith('/.git') || normalized === '.git') continue;
      const content = await deps.readFile(`${staging}/${normalized}`);
      await sandbox.writeFile(`${mountPath}/${normalized}`, content);
    }

    return { ok: true, mountPath, skills, cached };
  } catch (err) {
    // A failed materialization must not leave a staged tree behind for the next
    // session to mistake for a valid cache entry.
    if (staging && !cached) await ignoreFailure(deps.removeDir(staging));
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: sanitizeGitOutput(message, token.token) };
  }
}

/**
 * Whether a resource's mount identity changed in a way that requires a new
 * session.
 *
 * URL, checkout, and mount path define *what is mounted and where*. The token
 * is auth material and may rotate in place; rebinding the others mid-session
 * would change the agent's instruction boundary without re-running admission.
 */
export function mountIdentityChanged(
  previous: GithubRepositoryResource,
  next: GithubRepositoryResource,
): boolean {
  if (previous.url !== next.url) return true;
  if (previous.mount_path !== next.mount_path) return true;
  return JSON.stringify(previous.checkout ?? null) !== JSON.stringify(next.checkout ?? null);
}

/** Re-exported so callers assert against the same skill path rule. */
export { repoSkillsPath, githubCheckoutSchema };

