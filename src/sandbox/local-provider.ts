/**
 * Local Sandbox Provider
 *
 * Default execution backend: runs commands as local subprocesses.
 * Working directory: <runtime-data-dir>/sandbox/<session_id>/
 *
 * No kernel-level isolation. File tools are confined to the workspace by path
 * resolution (including symlink-escape checks) and the subprocess environment
 * is reduced to an allowlist, but a shell command still runs as the same OS
 * user on the same machine as the runtime: it can read outside the workspace
 * and reach the network. This is why the provider declares
 * `isolatedExecution: false` — suitable for trusted local development, not for
 * running untrusted agent output.
 *
 * ## Canonical in-sandbox roots
 *
 * A session's resources are addressed by the paths this runtime publishes to the
 * agent: a checkout under `/workspace`, and session data (uploaded files,
 * published outputs, spilled tool output) under `/mnt/session`. A published path
 * is a promise that the bytes are there, so the backend has to reach them at
 * exactly that spelling.
 *
 * For this provider's file operations the sandbox directory stands for the
 * sandbox's own filesystem root, and a canonical path maps into it by dropping the
 * leading separator: `/workspace/<repo>` is `<sandbox>/workspace/<repo>` and
 * `/mnt/session/uploads/x` is `<sandbox>/mnt/session/uploads/x`. The mapped path
 * then goes through the same resolution and confinement as a relative input, so
 * a canonical root is a second spelling for a path inside the sandbox rather
 * than a wider reach: `/mnt/session/../../x` normalizes out of the sandbox and
 * is refused exactly like `../x`.
 *
 * The two roots stay distinct directories rather than both aliasing the sandbox
 * directory. One shared root would make `/workspace/uploads` and
 * `/mnt/session/uploads` the same host directory, so a repository whose name is
 * `uploads` or `outputs` would be written into the directory the runtime reads
 * uploaded files from, publishes session outputs from, and spills oversized tool
 * output into. Keeping the roots apart keeps the mapping injective.
 *
 * The mapping covers `readFile`, `writeFile`, `listFiles`, and an `execute`
 * working directory. It does not cover a command string and cannot: a command runs
 * as an ordinary host subprocess, so the shell resolves an absolute path against
 * the host filesystem, where `/mnt/session` and `/workspace` are not this
 * session's directories. A command therefore names the same file by its
 * sandbox-relative spelling (`mnt/session/uploads/x`, relative to the working
 * directory the command starts in), and the agent has to be told that spelling —
 * a context-builder concern, not a rewrite of the command line that this provider
 * is in no position to perform.
 *
 * Known limitation of the confinement, pre-existing and unchanged here: the
 * realpath check on a write returns early when the target does not exist, so a
 * dangling symlink as the final component is not detected and the write follows
 * it. A symlink whose target exists is caught. Resolving the link itself before
 * that early return is a separate change; it is recorded here because this file
 * owns the check.
 *
 * Reference: OMA local-subprocess.ts
 */

import { execFile, spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import {
  sandboxCapabilities,
  type SandboxProvider,
  type SandboxInstance,
  type EnvironmentConfig,
  type ExecOptions,
  type ExecResult,
} from '@/types/sandbox.js';
import { withAgentIdentity } from './agent-identity.js';

const INHERITED_ENVIRONMENT_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
] as const;

function sandboxEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return { ...inherited, ...withAgentIdentity(extra) };
}

function shellInvocation(command: string): { file: string; args: string[] } {
  return shellInvocationFor(command, process.platform, process.env, existsSync);
}

/**
 * The absolute in-sandbox roots the runtime publishes to an agent.
 *
 * A backend maps each root into its own sandbox interior; the local backend
 * maps them as the sandbox directory's own top-level entries (see the file
 * header). Anything else absolute stays a refusal, so this list is the whole
 * set of absolute paths a session's file operations can name.
 */
export const CANONICAL_SANDBOX_ROOTS = ['/workspace', '/mnt/session'] as const;

/**
 * Rewrite a canonical in-sandbox path as a path relative to the sandbox
 * directory, or `undefined` when the input is not under a canonical root.
 *
 * The leading separator is the only thing dropped, which keeps the mapping
 * injective and makes the result structurally identical to the relative path a
 * shell inside the sandbox would use. The prefix test is whole-segment, so
 * `/workspacex` is not a canonical path and stays subject to the ordinary
 * confinement rules.
 *
 * A `..` segment inside a canonical path may not climb out of the root it was
 * spelled in. `/mnt/session/../../x` normalizes to `/x`, which is a path the
 * runtime never published, so it is refused rather than retargeted at the
 * sandbox root. A `..` that stays inside the root is ordinary normalization:
 * `/mnt/session/uploads/../notes.txt` is `/mnt/session/notes.txt`.
 */
export function canonicalRootRelativePath(inputPath: string): string | undefined {
  for (const root of CANONICAL_SANDBOX_ROOTS) {
    if (inputPath !== root && !inputPath.startsWith(`${root}/`)) continue;
    const normalized = posix.normalize(inputPath);
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      throw new Error(`Path escapes sandbox workspace: ${inputPath}`);
    }
    return normalized.slice(1);
  }
  return undefined;
}

/** Resolve the local command shell; parameters make platform fallback testable. */
export function shellInvocationFor(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };

  // `/bin/sh` is not present on a normal Windows installation. Allow local
  // developers to opt into Git Bash or another POSIX shell, while keeping a
  // dependency-free cmd.exe fallback that reports command failures normally.
  const configuredShell = environment.SANDBASE_SHELL?.trim();
  if (configuredShell) return { file: configuredShell, args: ['-c', command] };
  const gitBashCandidates = [
    environment.ProgramFiles ? join(environment.ProgramFiles, 'Git', 'bin', 'bash.exe') : undefined,
    environment['ProgramFiles(x86)'] ? join(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : undefined,
    // Sandboxed service managers and trimmed launch environments sometimes
    // strip ProgramFiles from the process environment; probe the standard
    // install locations directly before giving up on a POSIX shell.
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const gitBash = gitBashCandidates.find((candidate) => fileExists(candidate));
  if (gitBash) return { file: gitBash, args: ['-c', command] };
  return {
    file: environment.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command],
  };
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly type = 'local';

  readonly capabilities = sandboxCapabilities({
    // Same host, same user: path confinement only, no kernel boundary.
    isolatedExecution: false,
    // The workspace is a real directory under the runtime data dir.
    hostFilesystem: true,
    // `resources.memory` / `resources.cpu` cannot be enforced for a plain
    // subprocess, so the provider reports it rather than ignoring them.
    resourceLimits: false,
  });

  constructor(private readonly baseDir: string) {}

  async provision(sessionId: string, _config: EnvironmentConfig): Promise<SandboxInstance> {
    const workDir = join(this.baseDir, 'sandbox', sessionId);
    mkdirSync(workDir, { recursive: true });
    return new LocalSandboxInstance(sessionId, workDir);
  }
}

class LocalSandboxInstance implements SandboxInstance {
  constructor(
    readonly sessionId: string,
    private readonly workDir: string,
  ) {}

  /** Host filesystem path of the working directory (for snapshots). */
  get hostWorkDir(): string {
    return this.workDir;
  }

  private resolveInsideWorkDir(inputPath: string): string {
    const canonical = this.canonicalRelativePath(inputPath);
    const fullPath = resolve(this.workDir, canonical ?? inputPath);
    const workDir = resolve(this.workDir);
    const isInside = fullPath === workDir || fullPath.startsWith(`${workDir}${sep}`);

    if (!isInside) {
      throw new Error(`Path escapes sandbox workspace: ${inputPath}`);
    }

    return fullPath;
  }

  /**
   * The sandbox-relative spelling of a canonical in-sandbox path, or `undefined`.
   *
   * Mapping happens on the raw string, before any resolution, so the canonical
   * form is recognized exactly as the runtime published it. A `undefined` result
   * means the input goes to the filesystem as given, which is how every other
   * absolute path keeps being refused by the ordinary containment check.
   */
  private canonicalRelativePath(inputPath: string): string | undefined {
    // A NUL byte cannot appear in a real path, and `resolve` would carry it into
    // a filesystem call whose error differs per platform. Refusing it here keeps
    // the answer the same on every backend and in every method.
    if (inputPath.includes('\0')) {
      throw new Error('Path must not contain a NUL byte');
    }
    return canonicalRootRelativePath(inputPath);
  }

  private assertExistingPathInsideWorkDir(fullPath: string, inputPath: string): void {
    if (!existsSync(fullPath)) return;

    const realPath = realpathSync(fullPath);
    const realWorkDir = realpathSync(this.workDir);
    const isInside = realPath === realWorkDir || realPath.startsWith(`${realWorkDir}${sep}`);

    if (!isInside) {
      throw new Error(`Path escapes sandbox workspace: ${inputPath}`);
    }
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    const timeout = options?.timeout ?? 300_000; // 5 minutes default
    const cwd = options?.cwd ? this.resolveInsideWorkDir(options.cwd) : this.workDir;
    this.assertExistingPathInsideWorkDir(cwd, options?.cwd ?? '.');
    // Commands are untrusted agent actions. Do not inherit service credentials
    // or arbitrary host configuration; credentials must be injected explicitly.
    const env = sandboxEnvironment(options?.env);

    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;

      const shell = shellInvocation(command);
      const proc = spawn(shell.file, shell.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Give the command its own process group so a timeout can terminate
        // grandchildren as well as the shell itself on POSIX systems.
        detached: process.platform !== 'win32',
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== 'win32' && proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        } else if (process.platform === 'win32' && proc.pid) {
          // `proc.kill()` only terminates the shell on Windows; taskkill's
          // tree flag also stops sleep/bash children left behind by a timed
          // out tool call.
          execFile('taskkill', ['/pid', String(proc.pid), '/t', '/f'], () => undefined);
        } else {
          proc.kill('SIGKILL');
        }
      }, timeout);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // The shell exiting is the real end of a command. Foreground output is
      // already collected by the time the shell exits; `close` alone is not a
      // reliable completion signal because grandchildren (e.g. a background
      // dev server started with `&`) can inherit the stdio pipes and keep
      // them open indefinitely. Wait briefly so the streams can flush, then
      // return instead of stalling until the timeout.
      proc.on('exit', (code) => {
        if (resolved) return;
        clearTimeout(timer);
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut,
          });
        }, 100);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve({
            exitCode: 1,
            stdout,
            stderr: err.message,
            timedOut: false,
          });
        }
      });
    });
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const fullPath = this.resolveInsideWorkDir(path);
    const dir = dirname(fullPath);
    this.assertExistingPathInsideWorkDir(dir, path);
    this.assertExistingPathInsideWorkDir(fullPath, path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  async readFile(path: string): Promise<string> {
    const fullPath = this.resolveInsideWorkDir(path);
    this.assertExistingPathInsideWorkDir(fullPath, path);
    return readFileSync(fullPath, 'utf-8');
  }

  async listFiles(path: string): Promise<string[]> {
    const fullPath = this.resolveInsideWorkDir(path);
    if (!existsSync(fullPath)) return [];
    this.assertExistingPathInsideWorkDir(fullPath, path);

    const results: string[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else {
          results.push(relative(this.workDir, entryPath).split(sep).join('/'));
        }
      }
    };
    walk(fullPath);
    return results;
  }

  async cleanup(): Promise<void> {
    if (existsSync(this.workDir)) {
      rmSync(this.workDir, { recursive: true, force: true });
    }
  }
}
