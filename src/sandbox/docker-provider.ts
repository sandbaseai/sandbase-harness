/**
 * Docker Sandbox Provider
 *
 * Runs agent commands inside an isolated Docker container (one container per
 * session, 1:1 with the Session lifecycle). Provides real process isolation,
 * unlike the local subprocess provider.
 *
 * Requires the `docker` CLI on PATH. provision() starts a long-lived container
 * (`docker run -d ... sleep infinity`); execute() uses `docker exec`; files are
 * transferred via `docker cp`; cleanup() removes the container.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  sandboxCapabilities,
  type SandboxProvider,
  type SandboxInstance,
  type EnvironmentConfig,
  type EgressSubstitution,
  type ExecOptions,
  type ExecResult,
} from '@/types/sandbox.js';
import { withAgentIdentity } from './agent-identity.js';
import { canonicalRootRelativePath } from './local-provider.js';
import { EgressProxy } from '@/core/net/egress-proxy.js';
import {
  environmentEgressAllowlist,
  environmentNetworkPolicyOf,
  type EnvironmentNetworkPolicy,
} from '@/core/config/environment-network.js';

/**
 * The reference session-sandbox image this repository publishes
 * (`docker/sandbox-image/Dockerfile` → ghcr.io, `latest` plus release semver
 * tags). It approximates the managed cloud sandbox spec — Ubuntu 24.04,
 * bash at /bin/bash, Python 3.12, Node 22, git/curl/jq/rg/tmux/make,
 * ffmpeg/ImageMagick — instead of a bare runtime image, and it is what
 * `config.type: "cloud"` runs on. `config.image` still overrides it, which is
 * also how a deployment pins a specific release tag instead of `latest`.
 */
const DEFAULT_IMAGE = 'ghcr.io/sandbaseai/sandbase-harness-sandbox:latest';
const WORKDIR = '/workspace';
/**
 * `docker run` pulls an absent image inline under the run's own timeout — a
 * cold pull of the multi-GB reference image would lose the session before it
 * starts, so provision pulls deliberately first under this budget instead.
 */
const IMAGE_PULL_TIMEOUT_MS = 10 * 60 * 1000;
/** Relay sidecar image: a static `socat` (~8 MB) that forwards the internal network's only permitted peer to the host proxy. */
const RELAY_IMAGE = 'alpine/socat';
/** Port the relay listens on inside the internal network. */
const RELAY_PORT = 8080;

/** True if the `docker` CLI is available on PATH. */
export function isDockerAvailable(): boolean {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly type = 'docker';

  readonly capabilities = sandboxCapabilities({
    // Container namespaces provide a real boundary against the runtime host.
    isolatedExecution: true,
    // The workspace lives inside the container; files move via `docker cp`, so
    // there is no host path for the snapshot manager to read.
    hostFilesystem: false,
    // Enforced through `--memory` / `--cpus` at provision time.
    resourceLimits: true,
    // A `limited` policy puts the session container on an `--internal`
    // network — no route off the bridge — whose only permitted peer is a
    // relay sidecar forwarding to the runtime's allowlist egress proxy.
    networkPolicyEnforcement: 'enforced',
  });

  async provision(sessionId: string, config: EnvironmentConfig): Promise<SandboxInstance> {
    if (!isDockerAvailable()) {
      throw new Error(
        'The docker sandbox provider needs a running Docker daemon and none answered. '
          + 'Start Docker (Docker Desktop / the dockerd service), or declare a different '
          + 'backend — `config.type: "cloud"` also resolves here.',
      );
    }
    const image = config.image ?? DEFAULT_IMAGE;
    if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
      const pull = spawnSync('docker', ['pull', image], { encoding: 'utf-8', timeout: IMAGE_PULL_TIMEOUT_MS });
      if (pull.status !== 0) {
        throw new Error(
          `docker pull ${image} failed: ${(pull.stderr || pull.stdout || 'unknown error').trim()}`,
        );
      }
    }
    const containerName = `ma-sandbox-${safeContainerSuffix(sessionId)}`;
    const policy = environmentNetworkPolicyOf(config);
    // Every session gets a proxy, not only `limited` ones: the proxy is also
    // the placeholder-substitution boundary, and a session without a declared
    // policy can still carry vault credentials that must never reach the
    // container as plaintext. An absent policy binds it in allow-all mode.
    const egress = await provisionEgressBoundary(sessionId, policy);

    // Override the image's own entrypoint with `sleep` so the container stays
    // alive as a plain command host regardless of what the image declares.
    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `managed-agents.session=${sessionId}`,
      '-w',
      WORKDIR,
      '--entrypoint',
      'sleep',
      ...egress.containerArgs,
    ];
    for (const [k, v] of Object.entries(egress.containerEnvironment)) {
      args.push('-e', `${k}=${v}`);
    }
    // Resource limits
    if (config.resources?.memory) args.push('--memory', config.resources.memory);
    if (config.resources?.cpu) args.push('--cpus', String(config.resources.cpu));
    args.push(image, 'infinity');

    const run = spawnSync('docker', args, { encoding: 'utf-8', timeout: 30_000 });
    if (run.status !== 0) {
      await egress?.close();
      throw new Error(`docker run failed: ${run.stderr || run.stdout || 'unknown error'}`);
    }

    // Ensure workdir exists
    spawnSync('docker', ['exec', containerName, 'mkdir', '-p', WORKDIR], { timeout: 10_000 });

    return new DockerSandboxInstance(sessionId, containerName, egress);
  }
}

/**
 * The egress boundary a `limited` docker sandbox sits behind.
 *
 * Three pieces of docker state plus the host-side proxy:
 *
 * - `ma-net-<session>`: an `--internal` network holding only the sandbox and
 *   the relay. `internal` removes the NAT/masquerade and forwarding that
 *   would let the container reach anything beyond its own bridge, so the
 *   allowlist cannot be bypassed by ignoring proxy variables — there is
 *   simply no other route.
 * - `ma-ext-<session>`: an ordinary NAT'd bridge holding only the relay, the
 *   path the relay uses to reach the host's proxy listener. The sandbox is
 *   never attached to it.
 * - `ma-relay-<session>`: `socat` forwarding the sandbox's proxy target to
 *   `host.docker.internal:<proxy port>`. Two networks, one trusted hop — the
 *   pattern that reaches the host identically on Linux (gateway IP) and
 *   Docker Desktop (vpnkit), where reaching the host from an internal network
 *   is otherwise platform-dependent.
 *
 * Residual exposure, deliberately unchanged from the default bridge: a
 * container can still address host services listening on all interfaces via
 * its gateway IP. The proxy itself requires its per-session credential, which
 * rides in the container's proxy URL.
 */
interface DockerEgressBoundary {
  /** Extra `docker run` args the boundary needs (`--network`, `--add-host`). */
  containerArgs: string[];
  /** Proxy environment baked into the sandbox container (`docker run -e`). */
  containerEnvironment: Record<string, string>;
  /** Proxy environment for runtime-spawned host processes (stdio MCP). */
  hostEnvironment: Record<string, string>;
  /** The host-side proxy; owns the placeholder substitution table. */
  proxy: EgressProxy;
  close(): Promise<void>;
}

async function provisionEgressBoundary(
  sessionId: string,
  policy: EnvironmentNetworkPolicy | undefined,
): Promise<DockerEgressBoundary> {
  const suffix = safeContainerSuffix(sessionId);
  const internalNetwork = `ma-net-${suffix}`;
  const externalNetwork = `ma-ext-${suffix}`;
  const relayName = `ma-relay-${suffix}`;

  const proxy = await EgressProxy.listen('0.0.0.0', {
    allowedHosts: policy?.type === 'limited' ? environmentEgressAllowlist(policy) : null,
  });

  if (policy?.type !== 'limited') {
    // No allowlist to enforce, so no isolation is needed — the proxy exists
    // as the credential-substitution boundary. The container keeps the
    // default bridge and reaches the host listener through
    // `host.docker.internal` (built in on Docker Desktop; `host-gateway`
    // fills it in on a plain Linux daemon).
    return {
      containerArgs: dockerIsDesktop() ? [] : ['--add-host', 'host.docker.internal:host-gateway'],
      containerEnvironment: proxy.environment('host.docker.internal'),
      hostEnvironment: proxy.environment('127.0.0.1'),
      proxy,
      close: () => proxy.close(),
    };
  }

  const cleanup = async () => {
    spawnSync('docker', ['rm', '-f', relayName], { timeout: 15_000 });
    spawnSync('docker', ['network', 'rm', internalNetwork], { timeout: 15_000 });
    spawnSync('docker', ['network', 'rm', externalNetwork], { timeout: 15_000 });
    await proxy.close();
  };
  try {
    dockerRunOrThrow(['network', 'create', '--internal', internalNetwork], 'network create');
    dockerRunOrThrow(['network', 'create', externalNetwork], 'network create');
    const relayArgs = [
      'run', '-d',
      '--name', relayName,
      '--network', internalNetwork,
      // `host.docker.internal` resolves natively on Docker Desktop; on a
      // plain Linux daemon it needs `host-gateway`, which resolves to the
      // external bridge's gateway — the host — because the relay is also
      // attached to `ma-ext`.
      ...(dockerIsDesktop() ? [] : ['--add-host', 'host.docker.internal:host-gateway']),
      RELAY_IMAGE,
      `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr`,
      `TCP:host.docker.internal:${proxy.port}`,
    ];
    dockerRunOrThrow(relayArgs, 'relay run');
    dockerRunOrThrow(['network', 'connect', externalNetwork, relayName], 'network connect');

    const relayIp = dockerInspectNetworkAddress(relayName, internalNetwork);
    if (!relayIp) {
      throw new Error(`relay ${relayName} has no address on ${internalNetwork}`);
    }

    return {
      containerArgs: ['--network', internalNetwork],
      containerEnvironment: proxy.environment(relayIp, RELAY_PORT),
      hostEnvironment: proxy.environment('127.0.0.1'),
      proxy,
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** `docker info` operating system → whether `host.docker.internal` is built in. */
function dockerIsDesktop(): boolean {
  const info = spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return info.status === 0 && (info.stdout ?? '').includes('Docker Desktop');
}

/** The IPv4 address `container` holds on `network`, or undefined. */
function dockerInspectNetworkAddress(container: string, network: string): string | undefined {
  const inspect = spawnSync(
    'docker',
    ['inspect', '-f', '{{json .NetworkSettings.Networks}}', container],
    { encoding: 'utf-8', timeout: 10_000 },
  );
  if (inspect.status !== 0) return undefined;
  try {
    const networks = JSON.parse(inspect.stdout) as Record<string, { IPAddress?: string }>;
    const ip = networks[network]?.IPAddress?.trim();
    return ip || undefined;
  } catch {
    return undefined;
  }
}

function dockerRunOrThrow(args: string[], what: string): void {
  // `run` may have to pull the relay image on first use, so the timeout is
  // generous; network create/connect and inspect answer in milliseconds.
  const run = spawnSync('docker', args, { encoding: 'utf-8', timeout: 180_000 });
  if (run.status !== 0) {
    throw new Error(`docker ${what} failed: ${run.stderr || run.stdout || 'unknown error'}`);
  }
}

class DockerSandboxInstance implements SandboxInstance {
  constructor(
    readonly sessionId: string,
    private readonly containerName: string,
    private readonly egress?: DockerEgressBoundary,
  ) {}

  /**
   * The proxy block runtime-spawned session processes (stdio MCP servers)
   * receive. They run on the host, not in the container, so the address is
   * the proxy's loopback listener — which enforces the same allowlist.
   */
  get egressEnvironment(): Record<string, string> | undefined {
    return this.egress?.hostEnvironment;
  }

  /** The host-side proxy is the session's substitution boundary. */
  configureEgressSubstitutions(substitutions: readonly EgressSubstitution[]): void {
    this.egress?.proxy.addSubstitutions(substitutions);
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    const timeout = options?.timeout ?? 300_000;
    const cwd = options?.cwd ? dockerWorkspacePath(options.cwd) : WORKDIR;

    const execArgs = ['exec', '-w', cwd];
    for (const [k, v] of Object.entries(withAgentIdentity(options?.env))) {
      execArgs.push('-e', `${k}=${v}`);
    }
    execArgs.push(this.containerName, '/bin/sh', '-c', command);

    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let done = false;

      const proc = spawn('docker', execArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve({ exitCode: 1, stdout, stderr: err.message, timedOut: false });
        }
      });
    });
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    // Stage locally then docker cp into the container
    const staging = mkdtempSync(join(tmpdir(), 'ma-dcp-'));
    try {
      const localFile = join(staging, 'file');
      writeFileSync(localFile, content);
      const targetPath = dockerWorkspacePath(path);
      const target = `${this.containerName}:${targetPath}`;
      // Ensure parent dir exists in the container
      const dir = posix.dirname(targetPath);
      spawnSync('docker', ['exec', this.containerName, 'mkdir', '-p', dir], { timeout: 10_000 });
      const cp = spawnSync('docker', ['cp', localFile, target], { encoding: 'utf-8', timeout: 15_000 });
      if (cp.status !== 0) throw new Error(`docker cp failed: ${cp.stderr}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async readFile(path: string): Promise<string> {
    const staging = mkdtempSync(join(tmpdir(), 'ma-dcp-'));
    try {
      const localFile = join(staging, 'file');
      const src = `${this.containerName}:${dockerWorkspacePath(path)}`;
      const cp = spawnSync('docker', ['cp', src, localFile], { encoding: 'utf-8', timeout: 15_000 });
      if (cp.status !== 0) throw new Error(`docker cp failed: ${cp.stderr}`);
      return readFileSync(localFile, 'utf-8');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async listFiles(path: string): Promise<string[]> {
    const target = dockerWorkspacePath(path);
    const r = await this.execute(`find ${shellQuote(target)} -type f`);
    if (r.exitCode !== 0) return [];
    // `find` answers with absolute container paths. Entries under the
    // workspace are reported relative to it; every other listing target is a
    // canonical root, whose entries drop the leading separator to land in the
    // same sandbox-root-relative spelling the in-process providers use.
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith(WORKDIR + '/') ? l.slice(WORKDIR.length + 1) : l.replace(/^\/+/, '')));
  }

  async cleanup(): Promise<void> {
    spawnSync('docker', ['rm', '-f', this.containerName], { timeout: 15_000 });
    await this.egress?.close();
  }
}

export function dockerWorkspacePath(path: string): string {
  if (posix.isAbsolute(path)) {
    // A canonical absolute path names the sandbox's own interior, and a
    // container's filesystem is the sandbox: `/mnt/session/uploads/x` is
    // literally that path inside the container, matching the layout the
    // runtime publishes. `canonicalRootRelativePath` also rejects a `..` that
    // climbs out of its root, so the accepted set is exactly the roots.
    const canonical = canonicalRootRelativePath(path);
    if (canonical !== undefined) return `/${canonical}`;
    throw new Error('Docker sandbox paths must stay inside /workspace or a canonical mount root');
  }
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Docker sandbox paths must stay inside /workspace or a canonical mount root');
  }
  const normalized = posix.normalize(parts.join('/'));
  if (!normalized || normalized === '.') return WORKDIR;
  return posix.join(WORKDIR, normalized);
}

function safeContainerSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'session';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
