import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, extname, join, resolve, sep, win32 } from 'node:path';
import { referencedEnvVars, resolveEnvVarsFrom } from '@/core/config/env-resolver.js';
import type { Database } from '@/core/db/database.js';
import type { ModelConfig } from '@/types/model.js';
import { acquirePiSessionFileLease, type PiSessionFileLease } from './pi/session-lease.js';
import { PI_GATE_EXTENSION_FILENAME, piGateExtensionSource } from './pi/gate-extension.js';
import { PI_GATE_ENV } from './pi/rpc-wire.js';
import {
  assertPiSessionContinuity,
  markPiSessionContinuityFailure,
  type PiContinuityError,
} from './pi/session-continuity.js';

const INHERITED_ENVIRONMENT_KEYS = [
  'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR',
  'TMP', 'TEMP', 'USER', 'USERPROFILE', 'SystemRoot', 'ComSpec',
] as const;

type PiModelConfig = Pick<ModelConfig, 'provider' | 'model' | 'base_url' | 'api_key'>;
type ResolvedPiModel = Required<Pick<PiModelConfig, 'provider' | 'model' | 'api_key'>>
  & Pick<PiModelConfig, 'base_url'>;

export interface PiLaunchRequest {
  sessionId: string;
  workDir: string;
  prompt: string;
  /** Already-composed agent system prompt, including loaded skills. */
  systemPrompt: string;
  /** Concrete configuration selected for this agent turn. */
  model: PiModelConfig;
  /** Explicit Pi skill directories, one `--skill` flag per directory. */
  skillDirs?: string[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * The agent's native tool policy, already compiled into Pi's own flags.
   *
   * Omitted means "launch with no built-in tools at all" — see
   * {@link piToolArgsFor} — because the safe default is expressible: a launch that
   * cannot say which tools are allowed exposes none, rather than inheriting Pi's
   * full toolset and widening the agent's declared policy. The strategy always
   * supplies the compiled plan.
   */
  toolArgs?: readonly string[];
  /** Cancels the in-flight child only after it has exited and released its workdir. */
  abortSignal?: AbortSignal;
}

/**
 * Flags a launch that states no tool policy is given: none at all.
 *
 * `--no-builtin-tools` is the strict end of Pi's own surface, so an omitted policy
 * cannot widen what the agent may do. It still leaves extension tools enabled,
 * which is what the managed gate extension will need.
 */
export const PI_TOOL_ARGS_WHEN_UNSTATED = ['--no-builtin-tools'] as const;

/**
 * The tool flags one launch uses.
 *
 * A request that cannot say which tools are allowed is launched with none rather
 * than with Pi's default set: the compiled plan is what makes a declared policy
 * true, and guessing here would be the widening this field exists to prevent.
 */
export function piToolArgsFor(request: Pick<PiLaunchRequest, 'toolArgs'>): readonly string[] {
  return request.toolArgs ?? PI_TOOL_ARGS_WHEN_UNSTATED;
}

export class PiCleanupPendingError extends Error {
  readonly code = 'pi_cleanup_pending';

  constructor(message = 'Pi process tree cleanup is pending; the workspace remains retained') {
    super(message);
    this.name = 'PiCleanupPendingError';
  }
}

export class PiTimeoutError extends Error {
  readonly code = 'pi_timed_out';

  constructor(readonly timeoutMs: number) {
    super(`Pi turn timed out after ${timeoutMs}ms`);
    this.name = 'PiTimeoutError';
  }
}

export interface PiProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A started Pi child whose stdout/stderr can be consumed by the adapter. */
export interface PiProcessHandle {
  readonly child: ChildProcess;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly sessionFile?: string;
  readonly leaseRecovered?: boolean;
  wait(): Promise<PiProcessExit>;
  terminate(force?: boolean): Promise<void>;
}

export type PiProcessTerminator = (
  child: ChildProcess,
  platform: NodeJS.Platform,
  force: boolean,
) => void | Promise<void>;

export type PiProcessGroupInspector = (pid: number) => boolean;

/**
 * A long-lived `--mode rpc` Pi child.
 *
 * `stdin` is exposed because it is the session's command channel for the child's
 * whole life: unlike a print-mode turn, it is never given a prompt at launch and
 * never closed by the launcher.
 */
export interface PiRpcProcessHandle extends PiProcessHandle {
  readonly stdin: Writable;
  /**
   * Terminate the child and wait for it to release its work-directory lease.
   *
   * Rejects with a cleanup failure when tree ownership could not be confirmed,
   * so a caller never reports a released workspace it does not own.
   */
  interrupt(): Promise<void>;
  /** Absolute path of the managed gate extension, when one was written. */
  readonly gateExtensionFile?: string;
}

/**
 * The tool flags one RPC launch uses.
 *
 * Omitted means the same thing it means for a print-mode turn — see
 * {@link piToolArgsFor} — so an RPC launch that cannot state its policy still
 * exposes no built-in tool rather than inheriting Pi's full toolset.
 */
export interface PiRpcLaunchRequest {
  sessionId: string;
  /**
   * Host work directory the child runs in; also its cwd.
   *
   * Part of the resume binding: a Pi session file records the directory its own
   * conversation ran in, and a child started elsewhere would continue the history
   * under a contract the recorded turns never had.
   */
  workDir: string;
  /** Already-composed agent system prompt, including loaded skills. */
  systemPrompt: string;
  model: PiModelConfig;
  toolArgs?: readonly string[];
  /**
   * Digest of the contract this launch is resuming under — the compiled plan,
   * the model and provider, the work directory, and the approval mode.
   *
   * Compared against the recorded binding before a child is spawned, so a resume
   * that would continue a conversation under a different contract is refused
   * instead of started. Required rather than optional because a launch that
   * cannot state its contract has not proved the resume it is claiming.
   */
  policyFingerprint: string;
  /**
   * Native tool names whose calls must pass the managed pre-execution gate.
   *
   * A launch that states gated names loads the SandBase-owned gate extension for
   * exactly those tools, so a call to one of them is blocked and asked about
   * before it executes. Omitted means nothing is gated, which is only safe when
   * the agent declares no `always_ask` native tool: this list and the compiled
   * tool flags come from the same plan.
   */
  gateTools?: readonly string[];
  skillDirs?: string[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Hard cancellation for the whole child, shared with the cleanup ladder. */
  abortSignal?: AbortSignal;
}

/** The launcher surface the Pi adapter calls. */
export interface PiRpcLauncher {
  startRpc(request: PiRpcLaunchRequest): Promise<PiRpcProcessHandle>;
}

export interface PiLauncherOptions {
  dataDir: string;
  command?: string;
  /** Test-only command prefix used by a controlled executable before Pi arguments. */
  commandArgs?: string[];
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  /** Host Settings environment used for resolving model placeholders. */
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  /** Host database used to validate the Pi session header against continuity state. */
  database?: Database;
  /** Stale lease expiry; the default is deliberately short and observable. */
  leaseStaleAfterMs?: number;
  /** Maximum time to wait for a child tree after abort before cleanup_pending. */
  cleanupTimeoutMs?: number;
  /** Per-turn timeout; defaults to five minutes. */
  timeoutMs?: number;
  /** Test seam for terminating an in-flight Pi child process tree. */
  terminateProcess?: PiProcessTerminator;
  /** Bounded grace period before a POSIX process-group kill is escalated. */
  terminationGraceMs?: number;
  /** Test seam for determining whether a POSIX Pi process group is still alive. */
  processGroupAlive?: PiProcessGroupInspector;
}

export interface PiCliProbeOptions {
  command?: string;
  /** Test-only command prefix used by a controlled executable before probe arguments. */
  commandArgs?: string[];
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export interface PiCliProbeResult {
  available: boolean;
  message: string;
}

export interface PiInvocationOptions {
  command?: string;
  commandArgs?: string[];
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

/**
 * Extracts the real entry script from an npm `.cmd` shim.
 *
 * The shim runs `node "%dp0%\node_modules\<pkg>\...\cli.js" %*`, so the entry
 * path can be read instead of re-derived from the package layout — this keeps
 * working when the package name or its dist layout changes.
 */
function npmShimEntryPoint(cmdPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const match = /%~?[dD][pP]0%[\\/]?([^\s"']+?\.js)\b/.exec(text);
  if (!match) return null;
  return win32.resolve(win32.dirname(cmdPath), match[1]);
}

/**
 * Resolves Pi's executable invocation without invoking a shell. npm's Windows
 * shim is a .cmd file; run its extracted entry script through `node` directly,
 * because wrapping the adjacent `pi.ps1` in `powershell -Command` severs piped
 * stdin (`$input` binds to the command pipeline, not the process stream), and a
 * Pi child that sees stdin at EOF exits its RPC loop — the runtime's first
 * command then fails with EPIPE. A shim that does not match the npm layout
 * falls back to the PowerShell script.
 */
export function piInvocationFor(
  piArgs: string[],
  options: PiInvocationOptions = {},
): { file: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const command = options.command ?? 'pi';
  const commandArgs = options.commandArgs ?? [];
  const fileExists = options.fileExists ?? existsSync;
  const executable = platform === 'win32'
    ? resolveWindowsCommand(command, environment, fileExists)
    : command;

  if (platform !== 'win32' || extname(executable).toLowerCase() !== '.cmd') {
    return { file: executable, args: [...commandArgs, ...piArgs] };
  }

  const entry = npmShimEntryPoint(executable);
  if (entry && fileExists(entry)) {
    return { file: process.execPath, args: [entry, ...commandArgs, ...piArgs] };
  }

  const ps1 = win32.join(win32.dirname(executable), `${win32.basename(executable, '.cmd')}.ps1`);
  if (!fileExists(ps1)) {
    throw new Error('Pi CLI PowerShell shim is missing next to its npm pi.cmd executable');
  }
  const systemRoot = environment.SystemRoot?.trim() || 'C:\\Windows';
  return {
    file: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '& $args[0] @args[1..($args.Length - 1)]', ps1, ...commandArgs, ...piArgs,
    ],
  };
}

/** Launches one print-mode Pi turn with a private per-session file and config. */
export class PiLauncher {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly spawnImpl: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fileExists: (path: string) => boolean;
  private readonly terminateProcess: PiProcessTerminator;
  private readonly terminationGraceMs: number;
  private readonly processGroupAlive: PiProcessGroupInspector;
  private readonly database?: Database;
  private readonly leaseStaleAfterMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PiLauncherOptions) {
    this.command = options.command ?? 'pi';
    this.commandArgs = options.commandArgs ?? [];
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.fileExists = options.fileExists ?? existsSync;
    this.terminateProcess = options.terminateProcess ?? terminatePiProcess;
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
    this.processGroupAlive = options.processGroupAlive ?? isProcessGroupAlive;
    this.database = options.database;
    this.leaseStaleAfterMs = options.leaseStaleAfterMs ?? 30_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  /** Compatibility wrapper used by the foundation: drain output and wait. */
  async launch(request: PiLaunchRequest): Promise<void> {
    const handle = await this.start(request);
    handle.stdout?.resume();
    handle.stderr?.resume();
    const exit = await handle.wait();
    if (exit.code !== 0) {
      throw piLaunchError(new Error(`Pi process exited with code ${exit.code ?? 'unknown'}`));
    }
  }

  /** Start a Pi child for a protocol adapter to consume incrementally. */
  async start(request: PiLaunchRequest): Promise<PiProcessHandle> {
    const model = this.resolveModel(request.model);
    const modelEnvironmentKeys = new Set([
      ...referencedEnvVars(request.model.api_key),
      ...referencedEnvVars(request.model.base_url),
    ]);
    const paths = this.prepareSessionPaths(request.sessionId);
    const lease = await acquirePiSessionFileLease(paths.sessionFile, {
      staleAfterMs: this.leaseStaleAfterMs,
    });

    try {
      // A print-mode turn carries no policy fingerprint, so it can prove only the
      // half of the binding it does state: the directory this conversation ran in.
      if (this.database) {
        assertPiSessionContinuity(this.database, request.sessionId, paths.sessionFile, {
          workDir: resolve(request.workDir),
        });
      }
      this.materializeModelsConfig(paths.configDir, model);
      this.materializeAgentsPrompt(request.workDir, request.systemPrompt);
      const invocation = piInvocationFor([
        '-p', '--mode', 'json', '--model', `sandbase/${model.model}`, '--session', paths.sessionFile,
        ...piToolArgsFor(request),
        ...(request.thinkingLevel ? ['--thinking', request.thinkingLevel] : []),
        ...(request.skillDirs ?? []).flatMap((directory) => ['--skill', directory]),
      ], {
        command: this.command,
        commandArgs: this.commandArgs,
        platform: this.platform,
        environment: this.environment,
        fileExists: this.fileExists,
      });

      const env = restrictedPiEnvironment(this.environment, {
        PI_CODING_AGENT_DIR: paths.configDir,
        PI_TELEMETRY: '0',
        SANDBASE_PI_API_KEY: model.api_key,
      }, modelEnvironmentKeys);
      const abortController = new AbortController();
      let timedOut = false;
      const onRequestAbort = () => abortController.abort();
      if (request.abortSignal) {
        if (request.abortSignal.aborted) abortController.abort();
        else request.abortSignal.addEventListener('abort', onRequestAbort, { once: true });
      }
      const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, this.timeoutMs);

      let raw: PiProcessHandle;
      try {
        raw = await spawnPiProcess(this.spawnImpl, invocation.file, invocation.args, {
          cwd: request.workDir,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: this.platform !== 'win32',
        }, request.prompt, abortController.signal, {
          platform: this.platform,
          terminateProcess: this.terminateProcess,
          terminationGraceMs: this.terminationGraceMs,
          cleanupTimeoutMs: this.cleanupTimeoutMs,
          processGroupAlive: this.processGroupAlive,
        });
      } catch (error) {
        clearTimeout(timeout);
        request.abortSignal?.removeEventListener('abort', onRequestAbort);
        throw error;
      }

      const wait = async (): Promise<PiProcessExit> => {
        let failure: unknown;
        try {
          const exit = await raw.wait();
          if (timedOut) throw new PiTimeoutError(this.timeoutMs);
          return exit;
        } catch (error) {
          failure = error;
          if (timedOut && !(error instanceof PiCleanupPendingError)) {
            throw new PiTimeoutError(this.timeoutMs);
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          request.abortSignal?.removeEventListener('abort', onRequestAbort);
          if (isCleanupPendingError(failure)) lease.suspendHeartbeat();
          else await lease.release().catch(() => {});
        }
      };

      return {
        ...raw,
        sessionFile: paths.sessionFile,
        leaseRecovered: lease.recoveredStale,
        wait,
      };
    } catch (error) {
      if (this.database && isPiContinuityError(error)) {
        // Persist the reason so a later retry cannot silently fork a new file.
        const message = error instanceof Error ? error.message : String(error);
        markPiSessionContinuityFailure(this.database, request.sessionId, paths.sessionFile, error.code, message);
      }
      await lease.release().catch(() => {});
      throw error;
    }
  }

  /**
   * Start a long-lived Pi RPC child for one SandBase session.
   *
   * Differences from `start()`, each deliberate:
   *
   * - `--mode rpc` instead of `-p --mode json`, and no prompt is written at
   *   launch: prompts arrive as RPC commands, so the channel stays writable for
   *   the session's whole life. That is what makes a second turn on the same
   *   child possible at all.
   * - No process-level turn timeout. An RPC child serves many prompts, so a
   *   whole-process deadline would kill a healthy session mid-conversation; the
   *   per-turn deadline belongs to the session owner.
   * - Continuity state, the lease, and the tool flags are the same ones the
   *   print-mode launch used, so the two modes cannot disagree about which tools
   *   an agent may use or which Pi conversation it is continuing.
   * - A named `always_ask` tool gets a managed `--extension` gate, materialized
   *   per session inside the private configuration directory and published to the
   *   extension through its own environment. Without it the tool would be exposed
   *   and run with nobody asked, so a launch that names gated tools and cannot
   *   materialize the gate fails rather than starting ungated.
   */
  async startRpc(request: PiRpcLaunchRequest): Promise<PiRpcProcessHandle> {
    const model = this.resolveModel(request.model);
    const modelEnvironmentKeys = new Set([
      ...referencedEnvVars(request.model.api_key),
      ...referencedEnvVars(request.model.base_url),
    ]);
    // An empty or blank name would be a gated tool the extension can never match,
    // so a list that names one is refused rather than silently gated by nothing.
    const gateTools = (request.gateTools ?? []).filter((name) => name.length > 0);
    if ((request.gateTools?.length ?? 0) > 0 && gateTools.length === 0) {
      throw new Error('Pi gate tool list contains no usable native tool name');
    }
    const paths = this.prepareSessionPaths(request.sessionId);
    const lease = await acquirePiSessionFileLease(paths.sessionFile, {
      staleAfterMs: this.leaseStaleAfterMs,
    });

    try {
      // Both halves of the resume binding are proved here, before the lease is
      // used for a child: the directory this session ran in, and the digest of
      // the policy, model, and approval contract it ran under. A session file
      // records which conversation this is; it records nothing about what that
      // conversation was allowed to do.
      if (this.database) {
        assertPiSessionContinuity(this.database, request.sessionId, paths.sessionFile, {
          workDir: resolve(request.workDir),
          policyFingerprint: request.policyFingerprint,
        });
      }
      this.materializeModelsConfig(paths.configDir, model);
      this.materializeAgentsPrompt(request.workDir, request.systemPrompt);
      const gateExtensionFile = gateTools.length > 0
        ? this.materializeGateExtension(paths.configDir)
        : undefined;
      const invocation = piInvocationFor([
        '--mode', 'rpc', '--model', `sandbase/${model.model}`, '--session', paths.sessionFile,
        ...piToolArgsFor(request),
        // Discovery off, then the one managed extension on: a project-local file
        // in the work directory cannot add itself to, or replace, the gate.
        ...(gateExtensionFile ? ['--no-extensions', '--extension', gateExtensionFile] : []),
        ...(request.thinkingLevel ? ['--thinking', request.thinkingLevel] : []),
        ...(request.skillDirs ?? []).flatMap((directory) => ['--skill', directory]),
      ], {
        command: this.command,
        commandArgs: this.commandArgs,
        platform: this.platform,
        environment: this.environment,
        fileExists: this.fileExists,
      });

      const env = restrictedPiEnvironment(this.environment, {
        PI_CODING_AGENT_DIR: paths.configDir,
        PI_TELEMETRY: '0',
        SANDBASE_PI_API_KEY: model.api_key,
        ...(gateExtensionFile
          ? {
            [PI_GATE_ENV.sessionId]: request.sessionId,
            [PI_GATE_ENV.gatedTools]: JSON.stringify(gateTools),
          }
          : {}),
      }, modelEnvironmentKeys);

      const abortController = new AbortController();
      const onRequestAbort = () => abortController.abort();
      if (request.abortSignal) {
        if (request.abortSignal.aborted) abortController.abort();
        else request.abortSignal.addEventListener('abort', onRequestAbort, { once: true });
      }

      let raw: PiProcessHandle;
      try {
        raw = await spawnPiProcess(this.spawnImpl, invocation.file, invocation.args, {
          cwd: request.workDir,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: this.platform !== 'win32',
        }, undefined, abortController.signal, {
          platform: this.platform,
          terminateProcess: this.terminateProcess,
          terminationGraceMs: this.terminationGraceMs,
          cleanupTimeoutMs: this.cleanupTimeoutMs,
          processGroupAlive: this.processGroupAlive,
        });
      } catch (error) {
        request.abortSignal?.removeEventListener('abort', onRequestAbort);
        throw error;
      }

      const stdin = raw.child.stdin;
      if (!stdin) {
        request.abortSignal?.removeEventListener('abort', onRequestAbort);
        await raw.terminate(true).catch(() => {});
        throw new Error('Pi RPC child did not expose stdin');
      }

      const wait = async (): Promise<PiProcessExit> => {
        let failure: unknown;
        try {
          return await raw.wait();
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          request.abortSignal?.removeEventListener('abort', onRequestAbort);
          if (isCleanupPendingError(failure)) lease.suspendHeartbeat();
          else await lease.release().catch(() => {});
        }
      };

      // A natural child exit must release the lease even when the session owner
      // learns about it through the RPC reader rather than by calling
      // interrupt(). The promise is shared with later wait/interrupt calls, and
      // its rejection is observed here so it cannot go unhandled.
      void wait().catch(() => {});

      return {
        ...raw,
        stdin,
        sessionFile: paths.sessionFile,
        leaseRecovered: lease.recoveredStale,
        ...(gateExtensionFile ? { gateExtensionFile } : {}),
        wait,
        interrupt: async () => {
          if (!abortController.signal.aborted) abortController.abort();
          try {
            await wait();
          } catch (error) {
            // Ownership failures stay visible; an aborted child that is confirmed
            // gone is the expected outcome of asking it to stop.
            if (isCleanupPendingError(error)) throw error;
            if (error instanceof Error && error.name === 'AbortError') return;
            throw error;
          }
        },
      };
    } catch (error) {
      if (this.database && isPiContinuityError(error)) {
        // Persist the reason so a later retry cannot silently fork a new file.
        const message = error instanceof Error ? error.message : String(error);
        markPiSessionContinuityFailure(this.database, request.sessionId, paths.sessionFile, error.code, message);
      }
      await lease.release().catch(() => {});
      throw error;
    }
  }

  private prepareSessionPaths(sessionId: string): { sessionFile: string; configDir: string } {
    if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error('Pi session id is invalid');
    }
    const root = resolve(this.options.dataDir);
    const sessionsDir = resolve(root, 'pi-sessions');
    const sessionFile = resolve(sessionsDir, `${sessionId}.jsonl`);
    const configDir = resolve(sessionsDir, sessionId);
    assertInside(sessionsDir, sessionFile);
    assertInside(sessionsDir, configDir);
    ensurePrivateDirectory(sessionsDir, 'Pi session directory');
    ensurePrivateDirectory(configDir, 'Pi session configuration directory');
    // Pi expects a session target. Create it privately before placing its path
    // in argv, so the CLI never selects a different default session file.
    ensurePrivateFile(sessionFile, 'Pi session file');
    return { sessionFile, configDir };
  }

  private resolveModel(model: PiModelConfig): ResolvedPiModel {
    if (!model.model?.trim()) {
      throw new Error('Pi loop engine requires a selected model id');
    }
    if (!model.api_key) {
      throw new Error('Pi loop engine requires a configured model API key');
    }
    const api_key = resolveEnvVarsFrom(model.api_key, this.environment);
    if (api_key.includes('${')) {
      throw new Error('Pi loop engine model API key contains unresolved environment references');
    }
    const base_url = model.base_url
      ? resolveEnvVarsFrom(model.base_url, this.environment)
      : undefined;
    if (base_url?.includes('${')) {
      throw new Error('Pi loop engine model base URL contains unresolved environment references');
    }
    return { provider: model.provider, model: model.model, api_key, base_url };
  }

  private materializeModelsConfig(configDir: string, model: ResolvedPiModel): void {
    const providerConfig: Record<string, unknown> = {
      // Pi resolves this reference at request time; the literal key is never
      // serialized into the per-session configuration file.
      apiKey: '$SANDBASE_PI_API_KEY',
      api: model.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      models: [{ id: model.model }],
    };
    if (model.base_url) providerConfig.baseUrl = model.base_url;
    const path = join(configDir, 'models.json');
    writePrivateFile(path, `${JSON.stringify({ providers: { sandbase: providerConfig } }, null, 2)}\n`, 'Pi models configuration');
  }

  /**
   * Write the per-session managed gate extension into the private session
   * configuration directory.
   *
   * `--extension` receives an absolute path inside that directory, which the
   * launcher already created 0700 and which Pi reads through
   * `PI_CODING_AGENT_DIR`. A project-local file in the work directory cannot
   * shadow a path outside it, so repository content cannot replace the gate — and
   * the path is re-checked here rather than trusted, because the whole point of
   * the extension is that it is the platform's decision point.
   */
  private materializeGateExtension(configDir: string): string {
    const resolvedConfigDir = resolve(configDir);
    const path = resolve(resolvedConfigDir, PI_GATE_EXTENSION_FILENAME);
    if (!path.startsWith(`${resolvedConfigDir}${sep}`)) {
      throw new Error('Pi gate extension path escapes the session configuration directory');
    }
    writePrivateFile(path, piGateExtensionSource(), 'Pi gate extension');
    return path;
  }

  private materializeAgentsPrompt(workDir: string, systemPrompt: string): void {
    const root = resolve(workDir);
    const path = resolve(root, 'AGENTS.md');
    assertInside(root, path);
    // A previous local-sandbox turn can create files in its work directory.
    // Refuse symlinks and atomically replace only a regular AGENTS.md, rather
    // than following a link outside the sandbox while preparing the next turn.
    writePrivateFile(path, systemPrompt, 'Pi AGENTS.md');
  }
}

/** Probe the executable only; it never receives user input or model credentials. */
export async function probePiCli(options: PiCliProbeOptions = {}): Promise<PiCliProbeResult> {
  let invocation: { file: string; args: string[] };
  try {
    invocation = piInvocationFor(['--version'], options);
  } catch {
    return { available: false, message: 'Pi CLI is not available.' };
  }
  try {
    const handle = await spawnPiProcess(
      options.spawnImpl ?? spawn,
      invocation.file,
      invocation.args,
      {
        env: restrictedPiEnvironment(options.environment ?? process.env, { PI_TELEMETRY: '0' }),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const exit = await handle.wait();
    if (exit.code !== 0) throw new Error(`Pi process exited with code ${exit.code ?? 'unknown'}`);
    return { available: true, message: 'Pi CLI is available.' };
  } catch {
    return { available: false, message: 'Pi CLI is not available.' };
  }
}

export function restrictedPiEnvironment(
  environment: NodeJS.ProcessEnv,
  additions: Record<string, string>,
  excludedKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = environment[key];
      return value === undefined || excludedKeys.has(key) ? [] : [[key, value]];
    }),
  );
  return { ...inherited, ...additions };
}

type PiProcessAbortOptions = {
  platform: NodeJS.Platform;
  terminateProcess: PiProcessTerminator;
  terminationGraceMs: number;
  cleanupTimeoutMs: number;
  processGroupAlive: PiProcessGroupInspector;
};

function isCleanupPendingError(error: unknown): error is PiCleanupPendingError {
  return error instanceof PiCleanupPendingError || (
    error instanceof Error && (error as Error & { code?: unknown }).code === 'pi_cleanup_pending'
  );
}

function isPiContinuityError(error: unknown): error is PiContinuityError {
  return error instanceof Error && error.name === 'PiContinuityError'
    && typeof (error as Error & { code?: unknown }).code === 'string';
}

async function spawnPiProcess(
  spawnImpl: typeof spawn,
  file: string,
  args: string[],
  options: SpawnOptions,
  prompt?: string,
  abortSignal?: AbortSignal,
  abortOptions: PiProcessAbortOptions = {
    platform: process.platform,
    terminateProcess: terminatePiProcess,
    terminationGraceMs: 1_000,
    cleanupTimeoutMs: 10_000,
    processGroupAlive: isProcessGroupAlive,
  },
): Promise<PiProcessHandle> {
  if (abortSignal?.aborted) throw abortError();

  let child: ChildProcess;
  try {
    child = spawnImpl(file, args, options);
  } catch (error) {
    throw piLaunchError(error);
  }

  const stdout = child.stdout ?? null;
  const stderr = child.stderr ?? null;
  let abortRequested = false;
  let childClosed = false;
  let windowsTreeTerminationComplete = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveWait: (exit: PiProcessExit) => void = () => {};
  let rejectWait: (error: unknown) => void = () => {};
  const waitPromise = new Promise<PiProcessExit>((resolvePromise, rejectPromise) => {
    resolveWait = (exit) => {
      if (settled) return;
      settled = true;
      resolvePromise(exit);
    };
    rejectWait = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(piLaunchError(error));
    };
  });

  const processGroupStillAlive = () => (
    abortOptions.platform !== 'win32'
      && child.pid !== undefined
      && abortOptions.processGroupAlive(child.pid)
  );
  const requestTermination = (force: boolean): Promise<void> => {
    try {
      return Promise.resolve(abortOptions.terminateProcess(child, abortOptions.platform, force));
    } catch {
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // The child may already have exited; close/error will settle below.
      }
      return Promise.resolve();
    }
  };
  const rejectAbortIfSafe = () => {
    if (!childClosed) return;
    if (abortOptions.platform === 'win32') {
      if (windowsTreeTerminationComplete) rejectWait(abortError());
    } else if (!processGroupStillAlive()) {
      rejectWait(abortError());
    }
  };
  const onAbort = () => {
    if (abortRequested) return;
    abortRequested = true;
    cleanupTimer = setTimeout(() => {
      rejectWait(new PiCleanupPendingError(
        `Pi process tree cleanup did not complete within ${abortOptions.cleanupTimeoutMs}ms; workspace retained`,
      ));
    }, abortOptions.cleanupTimeoutMs);
    const termination = requestTermination(false);
    if (abortOptions.platform === 'win32') {
      void termination.then(
        () => {
          windowsTreeTerminationComplete = true;
          rejectAbortIfSafe();
        },
        () => {
          // Do not settle: without confirmed task-tree completion, draining
          // the turn must not release a workspace held by an unknown child.
        },
      );
    }
    if (abortOptions.platform !== 'win32' && abortOptions.terminationGraceMs > 0) {
      forceTimer = setTimeout(() => {
        void requestTermination(true);
        if (child.pid === undefined) {
          rejectAbortIfSafe();
          return;
        }
        void waitForProcessGroupExit(child.pid, abortOptions.processGroupAlive, abortOptions.cleanupTimeoutMs)
          .then(() => {
            rejectAbortIfSafe();
          })
          .catch(() => {});
      }, abortOptions.terminationGraceMs);
    }
    rejectAbortIfSafe();
  };
  const cleanup = () => {
    if (forceTimer) clearTimeout(forceTimer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    abortSignal?.removeEventListener('abort', onAbort);
  };

  child.once('error', (error) => {
    if (!abortRequested) {
      cleanup();
      rejectWait(error);
      return;
    }
    childClosed = true;
    rejectAbortIfSafe();
  });
  child.once('close', (code, signal) => {
    childClosed = true;
    if (abortRequested) {
      rejectAbortIfSafe();
      return;
    }
    cleanup();
    resolveWait({ code, signal });
  });

  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  if (!abortRequested && prompt !== undefined) {
    if (!child.stdin) {
      cleanup();
      rejectWait(new Error('Pi process did not expose stdin'));
    } else {
      child.stdin.once('error', (error) => {
        if (!abortRequested) rejectWait(error);
      });
      try {
        child.stdin.end(prompt);
      } catch (error) {
        if (!abortRequested) rejectWait(error);
      }
    }
  }

  return {
    child,
    stdout,
    stderr,
    wait: () => waitPromise,
    terminate: async (force = false) => {
      await requestTermination(force);
      if (force && abortOptions.platform !== 'win32' && child.pid !== undefined) {
        await waitForProcessGroupExit(child.pid, abortOptions.processGroupAlive, abortOptions.cleanupTimeoutMs);
      }
    },
  };
}

/** Terminate Pi and any descendants that could retain the session workdir. */
function terminatePiProcess(
  child: ChildProcess,
  platform: NodeJS.Platform,
  force: boolean,
): void | Promise<void> {
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    if (platform === 'win32' && child.pid) {
      // `taskkill /T` reaches Pi launched through an npm PowerShell shim; do
      // not interpolate a shell command or pass untrusted values here. Its
      // completion is part of cancellation: parent close alone cannot prove
      // a descendant no longer retains the session workspace.
      return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolvePromise();
        };
        const rejectOnce = (error: unknown) => {
          if (settled) return;
          settled = true;
          try {
            child.kill(signal);
          } catch {
            // The direct child may already have exited.
          }
          rejectPromise(error);
        };
        let killer: ChildProcess;
        try {
          killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (error) {
          rejectOnce(error);
          return;
        }
        killer.once('error', rejectOnce);
        killer.once('close', (code) => {
          if (code === 0) resolveOnce();
          else rejectOnce(new Error(`taskkill exited with code ${code ?? 'unknown'}`));
        });
      });
    }
    if (platform !== 'win32' && child.pid) {
      // Pi children launch detached on POSIX, so negative PID targets their
      // process group rather than only the wrapper executable.
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the direct child below if the group/tree is already gone.
  }
  try {
    child.kill(signal);
  } catch {
    // The close/error handlers settle the launch promise if it is still live.
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  processGroupAlive: PiProcessGroupInspector,
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new PiCleanupPendingError(`Pi process group did not exit within ${timeoutMs}ms`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function abortError(): Error {
  const error = new Error('Pi process aborted');
  error.name = 'AbortError';
  return error;
}

function piLaunchError(error: unknown): Error {
  if (error instanceof PiCleanupPendingError || error instanceof PiTimeoutError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT') {
    return new Error('Pi CLI is not available. Install it and ensure "pi" is on PATH.');
  }
  if (error instanceof Error && /^Pi process exited with code/.test(error.message)) return error;
  return new Error('Pi CLI failed to launch.');
}

function ensurePrivateDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a directory, not a symlink`);
  }
  chmodSync(path, 0o700);
}

function ensurePrivateFile(path: string, label: string): void {
  const entry = lstatIfPresent(path);
  if (entry) {
    assertPrivateRegularFile(entry, label);
  } else {
    // Exclusive creation never follows a newly planted symlink.
    writeFileSync(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  chmodSync(path, 0o600);
}

/** Atomically replace a sandbox-controlled regular file without following links. */
function writePrivateFile(path: string, content: string, label: string): void {
  const existing = lstatIfPresent(path);
  if (existing) assertPrivateRegularFile(existing, label);

  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function lstatIfPresent(path: string): NonNullable<ReturnType<typeof lstatSync>> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function assertPrivateRegularFile(
  entry: NonNullable<ReturnType<typeof lstatSync>>,
  label: string,
): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`${label} must be a private regular file`);
  }
}

function errorCodeIs(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function assertInside(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('Pi session path escapes the runtime data directory');
  }
}

function resolveWindowsCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string {
  if (win32.isAbsolute(command) || command.includes('\\') || command.includes('/')) return command;
  const pathValue = environment.PATH;
  if (!pathValue) return command;
  const candidates = extname(command)
    ? [command]
    // The bare name resolves to npm's POSIX sh script, which Windows cannot
    // execute — check executable extensions first, then the bare name.
    : [`${command}.cmd`, `${command}.exe`, command];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const fullPath = win32.join(directory, candidate);
      if (fileExists(fullPath)) return fullPath;
    }
  }
  return command;
}
