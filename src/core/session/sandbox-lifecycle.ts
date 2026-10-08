import {
  type SandboxProvider,
  type SandboxInstance,
  type SandboxProviderType,
  type EnvironmentConfig,
} from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';
import { UnknownSandboxProviderError, type SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { SnapshotManager } from './snapshot-manager.js';
import { sandboxPathForStoredMountPath } from './file-mount-path.js';
import {
  materializeGithubRepository,
  type GithubRepositoryResource,
  type MaterializeDeps,
  type MaterializeResult,
} from '@/core/resources/github-materializer.js';
import { repoSkillFilePath } from '@/core/resources/github-repository.js';
import { environmentNetworkPolicyOf } from '@/core/config/environment-network.js';
import { assertSkillPackageName, type SkillPackage } from '@/core/skills/package-files.js';

/** Minimal warn sink so the lifecycle can report capability gaps. */
export interface SandboxLifecycleLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export type FileArtifactReader = (fileId: string) => Buffer | Promise<Buffer>;

/**
 * Mounts a `github_repository` resource into a fresh sandbox.
 *
 * Injected rather than constructed here so the lifecycle stays free of host
 * process concerns (git, the filesystem, secret decryption) and so tests can
 * drive materialization without a real clone. The default wiring lives in the
 * runtime composition, which is where a real `runGit` belongs.
 */
export type GithubRepositoryMaterializer = (
  resource: GithubRepositoryResource,
  sandbox: SandboxInstance,
) => Promise<MaterializeResult>;

export interface SandboxLifecycleDeps {
  sandboxProvider: SandboxProvider;
  sandboxRegistry?: SandboxProviderRegistry;
  resolveEnvironmentConfig?: (environmentId: string) => EnvironmentConfig | undefined;
  snapshots?: SnapshotManager;
  /** Reads active file resources without exposing host storage paths. */
  fileArtifactReader?: FileArtifactReader;
  /**
   * Mounts github_repository resources. Absent in an embedder that never
   * attaches a repository; a session that *does* attach one then fails loudly
   * rather than starting with an empty mount.
   */
  githubMaterializer?: GithubRepositoryMaterializer;
  logger?: SandboxLifecycleLogger;
}

/** Result of one provisioning pass, exposed so callers can surface mounts. */
export interface MaterializedSessionResources {
  /** Absolute paths mounted from github_repository resources, in order. */
  repositories: string[];
  /** Skill directory names discovered across all mounted repositories. */
  skills: string[];
}

export type { MaterializeDeps, GithubRepositoryResource, MaterializeResult };
export type { SkillPackage, SkillPackageFile } from '@/core/skills/package-files.js';

/** Per-provision inputs the caller resolved before the sandbox exists. */
export interface ProvisionOptions {
  /**
   * Assigned skill packages already read off the host, materialized under
   * `skills/<name>/` relative to the sandbox workdir — `/workspace/...` in a
   * container, the session workdir on the local backend — matching where a
   * self-hosted worker puts the same packages.
   */
  skillPackages?: SkillPackage[];
}

/** A provisioned sandbox plus the backend that produced it. */
interface BoundSandbox {
  sandbox: SandboxInstance;
  provider: SandboxProvider;
}

export class SandboxLifecycle {
  private readonly bound = new Map<string, BoundSandbox>();
  /** Prevent concurrent callers from provisioning/materializing twice. */
  private readonly provisioning = new Map<string, Promise<SandboxInstance>>();
  /**
   * Skills discovered in mounted repositories, keyed by session.
   *
   * A repository's `.claude/skills` enters the agent's instruction boundary at
   * session start, so the names must be reachable by the context builder
   * without re-listing the sandbox on every turn. The mount path is kept beside
   * them because a name alone cannot be read: the instructions live in the
   * mounted tree, and the reader needs the path the skill was actually written
   * to.
   */
  private readonly repositorySkills = new Map<string, Array<{ mountPath: string; skills: string[] }>>();
  /**
   * Sandbox-relative roots the session's assigned skill packages materialized
   * to, keyed by session. Read by the context builder so the prompt names the
   * same path the agent's file tools can reach.
   */
  private readonly materializedSkills = new Map<string, string[]>();
  /**
   * Backends whose lack of isolation has already been reported.
   *
   * Keyed by provider type, not by session: "this backend does not isolate" is
   * a property of the configuration, and repeating it for every session on a
   * single-developer local runtime would be pure noise.
   */
  private readonly reportedUnisolated = new Set<string>();
  /** Same dedup for the advisory-only enforcement backends report. */
  private readonly reportedBestEffort = new Set<string>();

  constructor(private readonly deps: SandboxLifecycleDeps) {}

  /**
   * The sandbox currently bound to a session, or `undefined` when none is.
   *
   * Deliberately does not provision. The tool-output overflow contract needs to
   * know whether a sandbox exists before it tells the model to read an overflow
   * file back; provisioning one lazily here would make a read path allocate
   * execution resources as a side effect.
   */
  get(sessionId: string): SandboxInstance | undefined {
    return this.bound.get(sessionId)?.sandbox;
  }

  /**
   * Provision an extra sandbox for a session-scoped side task (a delegated
   * sub-agent) using the same backend the session itself resolves to.
   *
   * Not tracked in `bound`: the caller owns the returned instance and must
   * clean it up. Resolution goes through the same fail-loud path as the main
   * sandbox, so a session configured for an isolated backend cannot end up
   * running its sub-agent commands on the runtime host.
   */
  async provisionDetached(session: Session, sandboxId: string): Promise<SandboxInstance> {
    const envConfig = this.resolveEnvironmentConfig(session);
    const provider = this.resolveProvider(envConfig.sandbox_provider);
    return provider.provision(sandboxId, envConfig);
  }

  async getOrProvision(session: Session, options?: ProvisionOptions): Promise<SandboxInstance> {
    const existing = this.bound.get(session.id);
    if (existing) return existing.sandbox;

    const pending = this.provisioning.get(session.id);
    if (pending) return pending;

    const operation = this.provisionAndMaterialize(session, options);
    this.provisioning.set(session.id, operation);
    try {
      return await operation;
    } finally {
      if (this.provisioning.get(session.id) === operation) this.provisioning.delete(session.id);
    }
  }

  private async provisionAndMaterialize(session: Session, options?: ProvisionOptions): Promise<SandboxInstance> {
    const envConfig = this.resolveEnvironmentConfig(session);
    const provider = this.resolveProvider(envConfig.sandbox_provider);
    this.reportCapabilityGaps(session, envConfig, provider);

    const sandbox = await provider.provision(session.id, envConfig);
    try {
      if (this.snapshotsSupported(envConfig, provider) && this.deps.snapshots && sandbox.hostWorkDir) {
        try {
          this.deps.snapshots.restoreLatest(session.id, sandbox.hostWorkDir);
        } catch {
          // best-effort restore
        }
      }

      await this.materializeFileResources(session, sandbox);
      await this.materializeGithubResources(session, sandbox);
      await this.materializeSkillPackages(session, sandbox, options?.skillPackages);
      this.bound.set(session.id, { sandbox, provider });
      return sandbox;
    } catch (err) {
      // A provisioned sandbox must never survive a failed restore/materialize
      // phase, otherwise a later retry could observe a partially initialized
      // workspace. Preserve the original error if cleanup also fails.
      try {
        await sandbox.cleanup();
      } catch {
        // best-effort failure cleanup
      }
      throw err;
    }
  }

  private async materializeFileResources(session: Session, sandbox: SandboxInstance): Promise<void> {
    const resources = session.resources ?? [];
    const fileResources = resources.filter((resource) => resource.type === 'file');
    if (fileResources.length === 0) return;
    if (!this.deps.fileArtifactReader) {
      throw new Error('File session resources require an artifact reader');
    }

    for (const resource of fileResources) {
      const fileId = typeof resource.file_id === 'string' ? resource.file_id : '';
      if (!fileId) throw new Error('File session resource is missing file_id');
      const mountPath = sandboxPathForStoredMountPath(resource.mount_path, fileId);
      const bytes = await this.deps.fileArtifactReader(fileId);
      await sandbox.writeFile(mountPath, bytes);
    }
  }

  /**
   * Clone and mount every `github_repository` resource attached to a session.
   *
   * A materialization failure is fatal to the turn rather than a warning: the
   * repository root is part of the agent's instruction boundary, and a session
   * that silently starts without the skills it declared would run against a
   * different contract than the caller asked for. The lifecycle's caller
   * already unwinds the sandbox on a throw from this phase.
   */
  private async materializeGithubResources(session: Session, sandbox: SandboxInstance): Promise<void> {
    const resources = (session.resources ?? []).filter(
      (resource) => resource.type === 'github_repository',
    ) as unknown as GithubRepositoryResource[];
    if (resources.length === 0) return;

    const materializer = this.deps.githubMaterializer;
    if (!materializer) {
      throw new Error('GitHub repository session resources require a repository materializer');
    }

    const mounts: Array<{ mountPath: string; skills: string[] }> = [];
    for (const resource of resources) {
      const result = await materializer(resource, sandbox);
      if (!result.ok) throw new Error(result.message);
      if (result.skills.length > 0) {
        mounts.push({ mountPath: result.mountPath, skills: [...result.skills] });
      }
    }
    if (mounts.length > 0) this.repositorySkills.set(session.id, mounts);
  }

  /**
   * Write each assigned skill package into the sandbox under
   * `skills/<name>/`, the same location a self-hosted worker downloads to.
   *
   * The relative spelling lands under the sandbox workdir on every backend
   * that honors it, so a container sees `/workspace/skills/<name>/` while the
   * local backend sees `<workdir>/skills/<name>/`. A host-executable file gets
   * its execute bit restored through the sandbox command channel; on a backend
   * or host where chmod is meaningless (Windows local runs through Git Bash)
   * a failure is reported rather than silently shipping a script that cannot
   * run.
   */
  private async materializeSkillPackages(
    session: Session,
    sandbox: SandboxInstance,
    packages?: SkillPackage[],
  ): Promise<void> {
    if (!packages || packages.length === 0) return;
    const roots: string[] = [];
    for (const pkg of packages) {
      assertSkillPackageName(pkg.name);
      const root = `skills/${pkg.name}`;
      for (const file of pkg.files) {
        await sandbox.writeFile(`${root}/${file.path}`, file.content);
      }
      const executables = pkg.files.filter((file) => file.executable);
      if (executables.length > 0) {
        const targets = executables.map((file) => `'${root}/${file.path.replace(/'/g, `'\\''`)}'`).join(' ');
        try {
          const result = await sandbox.execute(`chmod +x -- ${targets}`);
          if (result.exitCode !== 0) {
            this.deps.logger?.warn('skill package executable bits could not be restored', {
              session_id: session.id,
              skill: pkg.name,
              stderr: result.stderr,
            });
          }
        } catch (error) {
          this.deps.logger?.warn('skill package executable bits could not be restored', {
            session_id: session.id,
            skill: pkg.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      roots.push(root);
    }
    this.materializedSkills.set(session.id, roots);
  }

  /**
   * Sandbox-relative roots of the session's materialized skill packages,
   * empty until provisioning writes them.
   */
  materializedSkillPaths(sessionId: string): string[] {
    return [...(this.materializedSkills.get(sessionId) ?? [])];
  }

  /**
   * Skill names discovered under a mounted repository's `.claude/skills`.
   *
   * Empty until the session's sandbox has been provisioned, which is the point
   * at which a repository actually exists to scan.
   */
  discoveredRepositorySkills(sessionId: string): string[] {
    const mounts = this.repositorySkills.get(sessionId) ?? [];
    return [...new Set(mounts.flatMap((entry) => entry.skills))];
  }

  /**
   * Read paths of the discovered repository skills, inside the sandbox.
   *
   * The context builder reads each `SKILL.md` through the sandbox it was
   * written to, so what the prompt says is what the agent can see. A repository
   * whose tree ships no skills contributes nothing rather than an empty path.
   */
  discoveredRepositorySkillFiles(sessionId: string): Array<{ name: string; path: string }> {
    const mounts = this.repositorySkills.get(sessionId) ?? [];
    return mounts.flatMap((entry) => entry.skills.map((name) => ({
      name,
      path: repoSkillFilePath(entry.mountPath, name),
    })));
  }

  snapshotAfterTurn(session: Session, sandbox: SandboxInstance): void {
    // Read the backend recorded at provision time rather than re-resolving:
    // the sandbox in hand already proves which provider served this session.
    const provider = this.bound.get(session.id)?.provider;
    if (!provider) return;
    const envConfig = this.resolveEnvironmentConfig(session);
    if (this.snapshotsSupported(envConfig, provider) && this.deps.snapshots && sandbox.hostWorkDir) {
      try {
        this.deps.snapshots.create(session.id, sandbox.hostWorkDir);
      } catch {
        // best-effort snapshot
      }
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const entry = this.bound.get(sessionId);
    if (!entry) return;

    this.bound.delete(sessionId);
    this.repositorySkills.delete(sessionId);
    this.materializedSkills.delete(sessionId);
    try {
      await entry.sandbox.cleanup();
    } catch {
      // best-effort cleanup
    }
  }

  snapshotsEnabled(envConfig: EnvironmentConfig): boolean {
    return envConfig.snapshot?.enabled === true;
  }

  /**
   * Snapshots need a host-readable workspace. Asking for them on a backend
   * without `hostFilesystem` is a configuration gap, not something to satisfy
   * silently — {@link reportCapabilityGaps} surfaces it once per session.
   */
  private snapshotsSupported(envConfig: EnvironmentConfig, provider: SandboxProvider): boolean {
    return this.snapshotsEnabled(envConfig) && provider.capabilities.hostFilesystem;
  }

  /**
   * Report anything the Environment asked for that the selected backend cannot
   * deliver. Previously these requests were dropped with no signal at all: a
   * snapshot-enabled docker session simply never produced a snapshot, and
   * `resources` limits on the local provider were ignored.
   *
   * Called once per session, from the provision path that caches its result.
   * Config-driven gaps are logged per session because they come from that
   * session's Environment; the isolation notice is deduplicated per backend
   * because it describes the backend itself.
   */
  private reportCapabilityGaps(
    session: Session,
    envConfig: EnvironmentConfig,
    provider: SandboxProvider,
  ): void {
    const logger = this.deps.logger;
    if (!logger) return;

    if (this.snapshotsEnabled(envConfig) && !provider.capabilities.hostFilesystem) {
      logger.warn('sandbox: workspace snapshots requested but backend has no host filesystem', {
        session_id: session.id,
        sandbox_provider: provider.type,
        capability: 'hostFilesystem',
      });
    }

    const wantsLimits = Boolean(envConfig.resources?.memory || envConfig.resources?.cpu);
    if (wantsLimits && !provider.capabilities.resourceLimits) {
      logger.warn('sandbox: resource limits requested but backend does not enforce them', {
        session_id: session.id,
        sandbox_provider: provider.type,
        capability: 'resourceLimits',
      });
    }

    if (!provider.capabilities.isolatedExecution && !this.reportedUnisolated.has(provider.type)) {
      this.reportedUnisolated.add(provider.type);
      logger.warn('sandbox: commands run without isolation from the runtime host', {
        sandbox_provider: provider.type,
        capability: 'isolatedExecution',
      });
    }

    const networkPolicy = environmentNetworkPolicyOf(envConfig);
    const enforcement = provider.capabilities.networkPolicyEnforcement;
    if (networkPolicy?.type === 'limited' && enforcement === 'none') {
      logger.warn('sandbox: limited network policy declared but backend cannot enforce it', {
        session_id: session.id,
        sandbox_provider: provider.type,
        capability: 'networkPolicyEnforcement',
      });
    } else if (networkPolicy?.type === 'limited' && enforcement === 'best_effort'
      && !this.reportedBestEffort.has(provider.type)) {
      this.reportedBestEffort.add(provider.type);
      logger.warn('sandbox: limited network policy enforced best-effort — subprocesses that ignore proxy variables egress freely', {
        sandbox_provider: provider.type,
        capability: 'networkPolicyEnforcement',
      });
    }
  }

  private resolveEnvironmentConfig(session: Session): EnvironmentConfig {
    return this.deps.resolveEnvironmentConfig?.(session.environmentId) ?? {
      name: session.environmentId || 'local',
      sandbox_provider: 'local',
      timeout: 300,
    };
  }

  /**
   * Resolve the backend named by the Environment.
   *
   * An unresolvable type is an error. The previous behavior — falling back to
   * the default (local, unsandboxed) provider — meant a session configured for
   * an isolated backend would silently execute on the runtime host instead,
   * which is a security regression disguised as a fallback.
   */
  private resolveProvider(type: SandboxProviderType): SandboxProvider {
    const registry = this.deps.sandboxRegistry;
    if (registry) return registry.get(type);
    // No registry wired (embedded / test usage): the single configured
    // provider is the only backend that can serve the request.
    if (type === this.deps.sandboxProvider.type) return this.deps.sandboxProvider;
    throw new UnknownSandboxProviderError(type, [this.deps.sandboxProvider.type]);
  }

  /**
   * The backend that serves a session, for a caller that has to describe it.
   *
   * The provider bound at provision time is authoritative, for the same reason
   * `snapshotAfterTurn` reads it: the sandbox in hand proves which backend served
   * this session, and the environment row can be edited after that bind — a
   * session running on a local sandbox whose named environment is later switched
   * to `docker` must still be described as local, or the instructions would name
   * the one spelling that sandbox cannot reach. Re-resolving would also make a
   * session fail that previously continued on its bound sandbox, because an
   * environment edited to name an unregistered backend now throws here.
   *
   * A session with no bound sandbox (a delegated sub-agent's own session, which
   * owns a detached sandbox) falls back to the environment resolution, which is
   * the same decision provisioning would make.
   */
  resolveProviderType(session: Session): SandboxProviderType {
    const bound = this.bound.get(session.id)?.provider;
    if (bound) return bound.type;
    const envConfig = this.resolveEnvironmentConfig(session);
    return this.resolveProvider(envConfig.sandbox_provider).type;
  }
}
