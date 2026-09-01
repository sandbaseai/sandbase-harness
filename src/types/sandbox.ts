/// <reference types="node" />
/**
 * Sandbox Provider Types
 *
 * Pluggable execution backend interface for running tool commands.
 * Session state machine and Sandbox are separate concerns — the Session
 * owns the control plane (Event_Log, status), the Sandbox owns the
 * execution plane (file system, process execution).
 *
 * Providers declare what they can actually do through `capabilities` rather
 * than letting callers infer it from optional fields. A backend that silently
 * ignores a requested feature (resource limits, snapshots) is worse than one
 * that reports it cannot honor the request, so every capability consumed by
 * the runtime has an explicit bit here.
 */

// ============================================================
// Provider Identity
// ============================================================

/**
 * Sandbox backend identifier.
 *
 * The listed values are the backends this repository ships. The `(string & {})`
 * arm keeps literal autocomplete while allowing an out-of-tree provider to
 * register its own type: the registry — not this union — is the authority on
 * what is actually available at runtime. Unknown types are preserved through
 * configuration normalization and rejected at provision time with a message
 * naming the registered backends (fail loud rather than silently downgrading
 * to local execution).
 */
export type SandboxProviderType =
  | 'local'
  | 'docker'
  | 'kubernetes'
  | 'self_hosted'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Backends shipped in this repository, for docs, UI listings, and hints. */
export const SHIPPED_SANDBOX_PROVIDER_TYPES = [
  'local',
  'docker',
  'kubernetes',
  'self_hosted',
] as const;

// ============================================================
// Capabilities
// ============================================================

export interface SandboxCapabilities {
  /**
   * Commands do not run unconfined on the runtime host.
   *
   * `true` covers two shapes: a kernel or container boundary on this machine
   * (docker, kubernetes), and execution on separate infrastructure entirely
   * (the self-hosted worker, whose own hardening is the operator's to
   * configure and is outside this process's knowledge — this bit says the
   * runtime host is not what is exposed, not that the worker is hardened).
   *
   * `false` means commands run as the same OS user on the same machine as the
   * runtime, with only path-level confinement of the file tools: the agent can
   * still read outside the workspace and reach the network.
   */
  isolatedExecution: boolean;

  /**
   * The working directory is a host path the runtime process can read
   * directly (exposed as `SandboxInstance.hostWorkDir`). Required for
   * workspace snapshots.
   */
  hostFilesystem: boolean;

  /**
   * `EnvironmentConfig.resources` limits (memory / CPU) are enforced by the
   * backend. When `false`, a configured limit is not silently honored and the
   * runtime reports the gap instead of pretending it applied.
   */
  resourceLimits: boolean;

  /**
   * Command output can be delivered incrementally rather than only as the
   * buffered result of `execute()`.
   *
   * No backend implements this yet and there is no consumer: tool results reach
   * the model as a single value, so there is nowhere for partial output to go.
   * The bit exists so the gap is visible and declared rather than discovered
   * when someone assumes streaming works; a provider may only set it once the
   * incremental interface exists.
   */
  streamingExec: boolean;
}

/**
 * Build a capability set from the bits a provider actually supports.
 *
 * Defaults are deliberately the most conservative answer for every axis, so a
 * provider that forgets to declare a capability is treated as not having it
 * rather than as silently having it.
 */
export function sandboxCapabilities(
  overrides: Partial<SandboxCapabilities> = {},
): SandboxCapabilities {
  return {
    isolatedExecution: false,
    hostFilesystem: false,
    resourceLimits: false,
    streamingExec: false,
    ...overrides,
  };
}

// ============================================================
// Sandbox Provider Interface
// ============================================================

export interface SandboxProvider {
  readonly type: SandboxProviderType;

  /** What this backend can actually do. See {@link SandboxCapabilities}. */
  readonly capabilities: SandboxCapabilities;

  /** Create and initialize a Sandbox instance bound to a session */
  provision(
    sessionId: string,
    config: EnvironmentConfig,
  ): Promise<SandboxInstance>;
}

// ============================================================
// Sandbox Instance Interface
// ============================================================

export interface SandboxInstance {
  readonly sessionId: string;

  /** Execute a shell command */
  execute(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Write a file (relative to working directory) */
  writeFile(path: string, content: string | Buffer): Promise<void>;

  /** Read a file (relative to working directory) */
  readFile(path: string): Promise<string>;

  /** List files in a directory (relative to working directory) */
  listFiles(path: string): Promise<string[]>;

  /**
   * Local host path of the working directory. Present only when the provider
   * declares `hostFilesystem`; undefined for backends whose file system isn't
   * directly host-accessible (docker, kubernetes, self-hosted worker). Used
   * for workspace snapshots (R9.11).
   */
  readonly hostWorkDir?: string;

  /** Release all resources (remove working directory, kill processes) */
  cleanup(): Promise<void>;
}

// ============================================================
// Execution Options & Result
// ============================================================

export interface ExecOptions {
  /** Timeout in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Working directory (relative to sandbox root) */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ============================================================
// Environment Configuration
// ============================================================

export interface EnvironmentConfig {
  name: string;
  sandbox_provider: SandboxProviderType;
  /** Default timeout in seconds (default: 300) */
  timeout?: number;
  /** Resource limits. Honored only by providers declaring `resourceLimits`. */
  resources?: {
    memory?: string; // e.g. '512m'
    cpu?: number; // e.g. 1.0
  };
  /** Workspace snapshot configuration */
  snapshot?: {
    enabled: boolean;
    interval_seconds?: number;
  };
  /** Container image (docker and kubernetes providers) */
  image?: string;
  /** Kubernetes-specific settings (kubernetes provider only) */
  kubernetes?: KubernetesEnvironmentConfig;
}

export interface KubernetesEnvironmentConfig {
  /** Namespace the session Pod is created in (default: 'default') */
  namespace?: string;
  /** kubeconfig context name; omit to use the current context */
  context?: string;
  /** Explicit kubeconfig path; omit to use the default resolution chain */
  kubeconfig?: string;
  /** ServiceAccount for the session Pod */
  service_account?: string;
  /** Extra labels applied to the session Pod */
  labels?: Record<string, string>;
}
