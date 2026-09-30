/**
 * Host-side wiring for GitHub repository materialization.
 *
 * {@link materializeGithubRepository} states *what* mounting a repository
 * means; this module supplies the host capabilities it needs — spawning git,
 * walking a directory, reading and deleting files. Keeping the two apart is
 * what lets the materializer be tested without a real clone while production
 * still runs the real thing.
 *
 * The git invocation is the security-relevant half. A token reaches git only
 * through {@link gitAuthEnv} (the environment), never through argv: argv is
 * visible to any process that can list processes, and a command line also tends
 * to be echoed back in error messages. Every byte of git output is additionally
 * passed through the session sanitizer before it leaves this module.
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SandboxInstance } from '@/types/sandbox.js';
import {
  materializeGithubRepository,
  GIT_TIMEOUT_MS,
  sanitizeGitOutput,
  type GithubRepositoryResource,
  type MaterializeDeps,
  type MaterializeResult,
} from './github-materializer.js';

export interface GithubRuntimeOptions {
  /** Root directory cached checkouts and temporary clones live under. */
  cacheRoot: string;
  /** Workspace data dir, used to decrypt a stored authorization token. */
  dataDir?: string;
}

/** Directories never copied into a sandbox from a checkout. */
const EXCLUDED_DIRS = new Set(['.git']);

/**
 * How many characters of each git stream are retained for an error message.
 *
 * The cap is a security property — a message that reaches an event or a log line
 * must be bounded — but *which* characters survive is a diagnostic one: the line
 * that explains a failure is the last one git wrote, so the cap keeps the tail.
 */
export const MAX_OUTPUT_CHARS = 4_000;

/**
 * Append a chunk to a bounded buffer, keeping the tail.
 *
 * Retaining the first `MAX_OUTPUT_CHARS * 2` characters and then slicing the last
 * `MAX_OUTPUT_CHARS` out of them keeps the *middle* of a long output. A clone
 * that fails after 8 KiB of progress or trace output then reported none of the
 * `fatal: …` line, which is the only actionable line in the whole stream.
 */
export function retainTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}

/**
 * Run git with the token in the environment.
 *
 * Resolves rather than rejects on a non-zero exit: a failed clone is an
 * expected outcome the materializer reports as a domain result, not an
 * exceptional condition for the caller to unwrap. Only a spawn failure (for
 * example, git not installed) rejects.
 */
function runGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (opts.cwd) mkdirSync(opts.cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      // A caller-supplied env is additive: PATH and the rest of the parent
      // environment still have to reach git for it to find its own helpers.
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const timedOut = `git command timed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms`;
      resolve({
        exitCode: 124,
        stdout,
        // The timeout line is appended inside the same cap, so the reason the
        // command ended is never what the cap trims away.
        stderr: retainTail(stderr, `\n${timedOut}`),
      });
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = retainTail(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = retainTail(stderr, chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Recursively list files under a directory, relative to it, dirs excluded.
 *
 * A directory that cannot be read is an error, not an empty listing. The
 * difference is load-bearing: the materializer probes the cache with
 * `listFiles(cachePath).then(() => true).catch(() => false)`, so a listing that
 * resolves for a path which does not exist makes **every** commit-pinned
 * resource look cached — the clone is skipped and the session mounts nothing,
 * silently. Returning `[]` here also made a listing that failed indistinguishable
 * from a checkout that genuinely contains no files, which is the same mistake one
 * layer down. The caller's `.catch` already states the contract this implements.
 */
function listFilesRecursive(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...listFilesRecursive(root, absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(relative(root, absolute));
  }
  return files;
}

/**
 * Build the production {@link MaterializeDeps}.
 *
 * Exported so a composition test can assert the wiring without importing the
 * whole runtime, and so `SandboxLifecycle` receives a materializer bound to the
 * same host primitives the rest of the runtime uses.
 */
export function createGithubMaterializeDeps(options: GithubRuntimeOptions): MaterializeDeps {
  return {
    cacheRoot: options.cacheRoot,
    dataDir: options.dataDir,
    runGit,
    removeDir: (path: string) => {
      rmSync(path, { recursive: true, force: true });
    },
    listFiles: async (path: string) => listFilesRecursive(path),
    readFile: async (path: string) => readFileSync(path, 'utf8'),
  };
}

/**
 * A materializer bound to a fixed {@link MaterializeDeps}.
 *
 * No database handle is passed: a repository's identity lives on the session
 * resource, and the cache key is derived from the URL and revision alone.
 */
export function createGithubMaterializer(options: GithubRuntimeOptions) {
  const deps = createGithubMaterializeDeps(options);
  mkdirSync(join(options.cacheRoot, 'github-repositories'), { recursive: true });

  return async (
    resource: GithubRepositoryResource,
    sandbox: SandboxInstance,
  ): Promise<MaterializeResult> => {
    const result = await materializeGithubRepository(resource, sandbox, deps);
    // Belt-and-braces: the materializer sanitizes its own messages, but this is
    // the last hop before the string can reach an event or a log line.
    if (!result.ok) {
      const token = typeof resource.authorization_token === 'string'
        ? resource.authorization_token
        : '';
      return { ok: false, message: sanitizeGitOutput(result.message, token) };
    }
    return result;
  };
}
