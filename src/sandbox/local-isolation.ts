/**
 * OS-level command confinement for the `local` sandbox provider.
 *
 * Plain `local` execution is a host subprocess — `docs` have always said it is
 * not a security boundary. On POSIX hosts that carry the right tool this
 * module wraps the shell invocation in a best-effort confinement so `exec`
 * tool calls stop being able to write outside the session workdir:
 *
 * - macOS → `sandbox-exec` with a seatbelt profile that allows reads and
 *   denies writes outside the workdir, the temp dirs, and device files.
 * - Linux → `bubblewrap` with the host filesystem read-only, the workdir (and
 *   configured extra roots) read-write, a fresh `/tmp` and `/proc`, and the
 *   shared network namespace the egress policy still governs through env.
 * - Windows → nothing; there is no equivalent and the docs steer untrusted
 *   work to Docker.
 *
 * Detection runs once per process: `MANAGED_AGENTS_LOCAL_ISOLATION` selects
 * `auto` (default — use the tool when present, warn once when not), `off`
 * (never wrap), or `require` (fail the execute call rather than degrade
 * silently — the operator asked for a boundary and a subprocess without it is
 * a different contract). `MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS` lists
 * additional writable roots for tooling that must write outside the workdir
 * (a toolchain cache, a socket dir).
 *
 * This is seatbelt/namespace confinement, not a VM boundary — it narrows what
 * a hostile command can touch but does not replace `docker` for untrusted
 * code. Network stays governed by the egress proxy env, which is applied to
 * the command's environment before the wrapper runs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export type LocalIsolationMode = 'off' | 'auto' | 'require';
export type LocalIsolationTool = 'sandbox-exec' | 'bwrap';

export interface ShellInvocation {
  file: string;
  args: string[];
}

export interface LocalIsolationPlan {
  tool: LocalIsolationTool;
  /** Wrap a resolved shell invocation into the confined one. */
  wrap(shell: ShellInvocation): ShellInvocation;
}

interface IsolationEnv {
  MANAGED_AGENTS_LOCAL_ISOLATION?: string;
  MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS?: string;
  TMPDIR?: string;
  PATH?: string;
}

/** Parse the operator's isolation setting; unknown values degrade to `auto`. */
export function localIsolationMode(env: IsolationEnv): LocalIsolationMode {
  const raw = (env.MANAGED_AGENTS_LOCAL_ISOLATION ?? 'auto').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'require' || raw === 'required') return 'require';
  return 'auto';
}

/** Extra writable roots, split on `:` or `;` — the feature is POSIX-only, so absolute POSIX spellings are kept verbatim. */
export function extraWritePaths(env: IsolationEnv): string[] {
  const raw = env.MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS ?? '';
  return raw
    .split(/[;:]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/') && existsSync(entry));
}

function toolPresent(file: string, probeArgs: string[]): boolean {
  try {
    const probe = spawnSync(file, probeArgs, { stdio: 'ignore' });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

/** `sandbox-exec` lives at a fixed path and is probeable with a trivial profile. */
export function sandboxExecAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && toolPresent('/usr/bin/sandbox-exec', [
    '-p', '(version 1)(allow default)', '/usr/bin/true',
  ]);
}

export function bubblewrapAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'linux' && toolPresent('bwrap', ['--version']);
}

function seatbeltProfile(workDir: string, writePaths: string[], tmpRoot: string): string {
  const writable = [workDir, '/tmp', '/private/tmp', tmpRoot, '/dev', ...writePaths]
    .filter((path, index, all) => path && all.indexOf(path) === index)
    // Seatbelt string quoting: backslashes first, then quotes, so a path can
    // never break out of the subpath literal.
    .map((path) => `(subpath "${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`)
    .join(' ');
  return (
    '(version 1)(allow default)(deny file-write*)' +
    `(allow file-write* ${writable})`
  );
}

function bubblewrapArgs(workDir: string, writePaths: string[], shell: ShellInvocation): string[] {
  const args = [
    // Host filesystem read-only, then carve the writable subtrees back in.
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', workDir, workDir,
  ];
  for (const path of writePaths) {
    args.push('--bind', path, path);
  }
  // The command's cwd is already inside the workdir, so `--chdir` there keeps
  // the invocation identical to an unconfined run.
  args.push('--chdir', workDir, '--', shell.file, ...shell.args);
  return args;
}

/**
 * Resolve the confinement plan for a workdir once — tool detection and the
 * operator's env settings — or `null` when the mode is `off` or no tool
 * exists on this platform. `require` throws instead of returning null when no
 * tool is available.
 */
export function localIsolationPlan(
  workDir: string,
  env: IsolationEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probes: { sandboxExec?: () => boolean; bubblewrap?: () => boolean } = {},
): LocalIsolationPlan | null {
  const mode = localIsolationMode(env);
  if (mode === 'off') return null;

  const writable = extraWritePaths(env);
  const sandboxExec = probes.sandboxExec ?? (() => sandboxExecAvailable(platform));
  const bubblewrap = probes.bubblewrap ?? (() => bubblewrapAvailable(platform));

  if (sandboxExec()) {
    const profile = seatbeltProfile(workDir, writable, env.TMPDIR ?? tmpdir());
    return {
      tool: 'sandbox-exec',
      wrap: (shell) => ({
        file: '/usr/bin/sandbox-exec',
        args: ['-p', profile, shell.file, ...shell.args],
      }),
    };
  }
  if (bubblewrap()) {
    return {
      tool: 'bwrap',
      wrap: (shell) => ({ file: 'bwrap', args: bubblewrapArgs(workDir, writable, shell) }),
    };
  }
  if (mode === 'require') {
    throw new Error(
      'MANAGED_AGENTS_LOCAL_ISOLATION=require but neither sandbox-exec (macOS) nor bubblewrap (Linux) is available on this host',
    );
  }
  return null;
}
