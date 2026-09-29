import { join } from 'node:path';
import type { Database } from '../db/database.js';
import { runtimeCapabilityRegistry } from '../capabilities/registry.js';
import { loadAgentDefinitionById } from '../agent/store.js';
import { SessionManager } from '../session/session-manager.js';
import { DefaultSessionExecutor } from '../session/executor.js';
import { ContextCompactor } from '../session/context-compactor.js';
import { recordSessionOutputs } from '@/core/session/session-outputs.js';
import { readRubricFileText } from '@/core/session/outcome-rubric.js';
import { createModelOutcomeGrader } from '@/core/outcomes/grader.js';
import { SnapshotManager } from '../session/snapshot-manager.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { Skill } from '../skills/loader.js';
import type { MemoryProvider } from '../memory/memory-provider.js';
import { SqliteMemoryRecordsProvider } from '../memory/sqlite-memory-records-provider.js';
import { SqliteMemoryMountAdapter, type MemoryMountAdapter } from '../memory/mount-adapter.js';
import type { ModelRegistry } from '../../model/registry.js';
import type { SandboxProvider } from '@/types/sandbox.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { SessionLoopEngine } from '@/types/session.js';
import type { SandboxLifecycleLogger, FileArtifactReader, GithubRepositoryMaterializer } from '../session/sandbox-lifecycle.js';
import { createFileArtifactReader } from '../session/session-resources.js';
import { createGithubMaterializer } from '../resources/github-runtime.js';
import type { RuntimeComposition } from './composition.js';
import type { CredentialInjectionBundle, CredentialInjectionTarget } from '@/core/credentials/injection.js';

export interface RuntimeSessionServicesOptions {
  db: Database;
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  sandboxProvider: SandboxProvider;
  sandboxRegistry: SandboxProviderRegistry;
  runtimeComposition: Pick<RuntimeComposition, 'resolveEnvironmentConfig'>;
  strategy: AgentStrategy;
  /** Engine copied to each new session. Existing rows retain their own engine. */
  loopEngine?: SessionLoopEngine;
  /** Resolve the strategy matching a persisted session engine. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  /**
   * Release whatever a strategy owns for a session — for Pi, its RPC child —
   * when the session reaches a terminal state.
   *
   * Supplied by the host that assembled the strategies, because only it knows
   * which engines are registered. Without it a stopped session's child would
   * keep running against a work directory the runtime has released.
   */
  disposeStrategySessions?: (sessionId: string) => Promise<void> | void;
  /** Engines this process can actually dispatch for new sessions. */
  isLoopEngineAvailable?: (loopEngine: SessionLoopEngine) => boolean;
  skills: Skill[];
  skillsDir?: string;
  memory?: MemoryProvider;
  /** Optional override for API-managed memory_records; defaults to SQLite. */
  memoryRecords?: MemoryProvider;
  /** Resolves a store name for legacy resources without persisted mount_path. */
  memoryStoreName?: (storeId: string) => string | undefined;
  memoryMount?: MemoryMountAdapter;
  artifactStore: ArtifactStore;
  defaultMaxSteps: number;
  /**
   * Resolve a session's vault credentials for a turn.
   *
   * Optional: a host that embeds these services without a credential store
   * passes nothing, and a session with no vaults resolves to an empty bundle. The
   * resolver enforces the network policy before it decrypts anything, so a
   * credential the turn cannot use arrives in `denied` rather than in the
   * environment.
   */
  resolveCredentialInjections?: (sessionId: string, target?: CredentialInjectionTarget) => CredentialInjectionBundle;
  /**
   * Resolve a `{type: "file"}` rubric to its text.
   *
   * Defaulted to reading the upload the Files API stored, so the declared rubric
   * and the readable file cannot drift apart; an embedder may override it.
   */
  resolveRubricFile?: (fileId: string) => string | undefined;
  /** Optional sink for sandbox capability-gap warnings. */
  logger?: SandboxLifecycleLogger;
  /**
   * Workspace data directory.
   *
   * Required for the default repository materializer: the clone cache lives
   * under it, and a resource's authorization token is encrypted with key
   * material derived from it, so the materializer has to be given the same
   * directory the API routes encrypted with. Without it no default materializer
   * is built, and a session that attaches a repository keeps failing loudly at
   * provisioning instead of starting against a tree it could not read.
   */
  dataDir?: string;
  /** Override the default repository materializer (tests, embedders). */
  githubMaterializer?: GithubRepositoryMaterializer;
  /** Override the default reader for attached file resources (tests, embedders). */
  fileArtifactReader?: FileArtifactReader;
}

export interface RuntimeSessionServices {
  sessionManager: SessionManager;
  executor: DefaultSessionExecutor;
  snapshots: SnapshotManager;
  reconciled: number;
}

export function createRuntimeSessionServices(options: RuntimeSessionServicesOptions): RuntimeSessionServices {
  const sessionManager = new SessionManager(
    options.db,
    runtimeCapabilityRegistry,
    options.loopEngine ?? 'builtin',
    (environmentId: string) => options.runtimeComposition.resolveEnvironmentConfig(environmentId)?.sandbox_provider,
    options.isLoopEngineAvailable,
  );
  const eventLogger = sessionManager.getEventLogger();
  const snapshots = new SnapshotManager(options.db, options.artifactStore.path('snapshots'));
  const memoryRecords = options.memoryRecords ?? new SqliteMemoryRecordsProvider(options.db);

  // The two dependencies `SandboxLifecycle` needs to materialize a session's
  // declared resources. Both are defaulted here, in the composition root, which
  // is the only layer that holds the workspace directory, the database, and the
  // artifact store at once. An embedder that supplies neither still runs; a
  // session that attaches such a resource then fails at provisioning with the
  // missing dependency named, which is the behaviour this wiring replaces for
  // the started runtime. Admission is a separate decision, made before anything
  // is stored: a session on a backend that cannot serve the canonical roots is
  // refused with `resource_not_mountable`.
  const fileArtifactReader = options.fileArtifactReader
    ?? createFileArtifactReader(options.db, options.artifactStore);
  const githubMaterializer = options.githubMaterializer
    ?? (options.dataDir
      ? createGithubMaterializer({
          cacheRoot: join(options.dataDir, 'cache'),
          // The token was encrypted against this directory by the session
          // resource routes; handing the materializer anything else would make
          // every authorized clone fail to decrypt.
          dataDir: options.dataDir,
        })
      : undefined);

  const executor = new DefaultSessionExecutor({
    agents: options.agents,
    modelRegistry: options.modelRegistry,
    sandboxProvider: options.sandboxProvider,
    sandboxRegistry: options.sandboxRegistry,
    resolveEnvironmentConfig: options.runtimeComposition.resolveEnvironmentConfig,
    resolveAgent: (agentId) => loadAgentDefinitionById(options.db, agentId),
    strategy: options.strategy,
    resolveStrategy: options.resolveStrategy,
    disposeStrategySessions: options.disposeStrategySessions,
    eventLogger,
    compactor: new ContextCompactor(),
    skills: options.skills,
    skillsDir: options.skillsDir,
    memory: options.memory,
    memoryRecords,
    memoryStoreName: options.memoryStoreName ?? ((storeId: string) => {
      const row = options.db.prepare('SELECT name FROM memory_stores WHERE id = ?').get(storeId) as { name: string } | undefined;
      return row?.name;
    }),
    memoryMount: options.memoryMount ?? new SqliteMemoryMountAdapter(options.db),
    snapshots,
    defaultMaxSteps: options.defaultMaxSteps,
    // Passed through rather than defaulted: the executor resolves a session's
    // vault per turn only when the host that assembled these services supplied a
    // credential store, so an embedder with none keeps running sessions that hold
    // no vault.
    resolveCredentialInjections: options.resolveCredentialInjections,
    logger: options.logger,
    // Session resources are materialized at provisioning, which is the first
    // point a sandbox exists. Both dependencies are passed explicitly: the
    // executor hands them to `SandboxLifecycle`, and dropping either one here
    // would put the runtime back to refusing a session whose resources the
    // caller declared and the API accepted.
    fileArtifactReader,
    githubMaterializer,
    sessionOutputSink: (sessionId, files) => {
      recordSessionOutputs({
        db: options.db,
        artifactStore: options.artifactStore,
        sessionId,
        files,
      });
    },
  });
  sessionManager.setExecutor(executor);
  // A declared outcome is graded through the session manager, which owns the log
  // the evaluation both reads (the transcript) and writes (the span triple), so
  // the rubric and the verdict cannot drift from what was actually recorded.
  sessionManager.setOutcomeGrader(createModelOutcomeGrader(options.modelRegistry));
  sessionManager.setRubricFileResolver(
    options.resolveRubricFile
      ?? ((fileId: string) => readRubricFileText(options.db, options.artifactStore, fileId)),
  );

  const reconciled = sessionManager.reconcileOrphans();

  return {
    sessionManager,
    executor,
    snapshots,
    reconciled,
  };
}
