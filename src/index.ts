/**
 * managed-agents - Entry Point
 *
 * Managed Agents runtime.
 * CLI commands: start (default), init, list, reload
 */

import { serve } from '@hono/node-server';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from './core/db/database.js';
import { createServer } from './api/server.js';
import { composeOperations, webhookSigningSecret } from './api/operations-bridge.js';
import { logDirForFile, resolveConfigPath, resolveDataDir, resolveLogFile, resolveUserPath, resolveWorkspaceRoot } from './core/config/paths.js';
import { composeRuntimeFromSettings } from './core/runtime/composition.js';
import { ensureDefaultEnvironment, configModelWarnings, loadRuntimeConfigBootstrap } from './core/runtime/config-bootstrap.js';
import { createRuntimeStopper } from './core/runtime/lifecycle.js';
import { loadRuntimeAgentSkillState, reloadRuntimeAgents } from './core/runtime/agent-skill-bootstrap.js';
import { bootstrapRuntimeModelRegistry } from './core/runtime/model-bootstrap.js';
import { bootstrapRuntimeSandboxes } from './core/runtime/sandbox-bootstrap.js';
import { bootstrapRuntimeLoopEngine } from './core/runtime/loop-engine-bootstrap.js';
import { resolveRuntimeApiAuth } from './core/runtime/api-auth.js';
import { createRuntimeSessionServices } from './core/runtime/session-runtime.js';
import { resolveSessionCredentialInjections } from './core/credentials/injection.js';
import { attachRuntimeServerErrorHandler, parseCsv, runtimeStartupBannerLines } from './core/runtime/http-server.js';
import { createLogger, InMemoryLogStore } from './core/observability/logger.js';
import { Metrics } from './core/observability/metrics.js';
import { runCli, type StartServerOptions } from './cli/program.js';

const VERSION = '0.1.0';

// V1 local-first quick-start contract:
// - Settings pages configure the active model provider boundary.
// - init creates local seed folders with mkdirSync(join(cwd, 'agents')) and
//   mkdirSync(join(cwd, 'skills')).
// - the starter skill id is skill_example-skill.
// - the default environment uses sandbox_provider: local.

// ============================================================
// Start Server
// ============================================================

async function startServer(opts: StartServerOptions) {
  const port = parseInt(opts.port, 10);
  const host = opts.host;
  const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
  const dataDir = resolveDataDir(opts.dataDir, workspaceRoot);
  const agentsDir = resolveUserPath(opts.agentsDir, workspaceRoot);
  const skillsDir = resolveUserPath(opts.skillsDir, workspaceRoot);
  const configPath = resolveConfigPath(opts.config, workspaceRoot);
  const logFile = resolveLogFile(opts.logFile, workspaceRoot);
  const target = opts.target ?? 'local';

  // Initialize workspace state directories
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDirForFile(logFile), { recursive: true });

  // Initialize database (migrations are embedded and bundle-safe)
  const dbPath = join(dataDir, 'data.db');
  const db = new Database(dbPath);
  db.runMigrations();

  ensureDefaultEnvironment(db);

  const configBootstrap = loadRuntimeConfigBootstrap({ db, configPath, target });
  const { modelRegistry } = bootstrapRuntimeModelRegistry({ db, configModels: configBootstrap.models });

  const agentSkillState = loadRuntimeAgentSkillState({ db, agentsDir, skillsDir });
  const agents = agentSkillState.agents;
  const skills = agentSkillState.skills;
  // Observability is created before the sandbox and session layers so both can
  // report what would otherwise be invisible: a Pod that could not be deleted,
  // or an Environment asking for a capability its backend does not have.
  const logStore = new InMemoryLogStore();
  const logger = createLogger({
    logStore,
    write: (line) => {
      process.stderr.write(line + '\n');
      appendFileSync(logFile, line + '\n', 'utf8');
    },
  });
  const metrics = new Metrics();

  const { sandboxProvider, sandboxRegistry, workQueue } = bootstrapRuntimeSandboxes({ db, dataDir, logger });

  // Settings V2 is seeded after legacy config/import data exists, then becomes
  // the runtime source for settings that have a shipped adapter.
  const runtimeComposition = composeRuntimeFromSettings({
    db,
    dataDir,
    modelRegistry,
    settingsSeed: configBootstrap.settingsSeed,
    sandboxProviders: sandboxRegistry.listTypes(),
  });
  const effectiveSettings = runtimeComposition.settings.effective_config;
  const memory = runtimeComposition.memory;

  // config.yaml is a first-start import, not a live setting. Saying so at
  // startup is what keeps an edit that will not take effect from presenting
  // itself as an endpoint that "still uses the old base URL".
  for (const warning of configModelWarnings(configBootstrap, effectiveSettings.model)) {
    logger.warn('config_model_not_effective', { detail: warning });
    console.warn(`  Warning:   ${warning}`);
  }

  const loopEngine = bootstrapRuntimeLoopEngine(effectiveSettings, { dataDir, database: db });
  const artifactStore = runtimeComposition.artifactStore;

  const {
    sessionManager,
    executor,
    reconciled,
  } = createRuntimeSessionServices({
    db,
    agents,
    modelRegistry,
    sandboxProvider,
    sandboxRegistry,
    runtimeComposition,
    // The same workspace directory the API routes encrypt a resource's
    // authorization token against, so the default repository materializer can
    // decrypt it, and the directory its clone cache belongs under.
    dataDir,
    strategy: loopEngine.strategy,
    loopEngine: loopEngine.provider,
    resolveStrategy: (provider) => {
      const strategy = loopEngine.strategies[provider];
      if (!strategy) throw new Error(`Persisted loop engine "${provider}" is not available`);
      return strategy;
    },
    isLoopEngineAvailable: (provider) => Boolean(loopEngine.strategies[provider]),
    // Every strategy owns whatever an engine needs released when a session
    // reaches a terminal state — for Pi, the session-owned RPC child, whose
    // work-directory lease must not outlive the session. A strategy that owns
    // nothing has no `disposeSession`, and asking it for one is not an error.
    disposeStrategySessions: async (sessionId) => {
      await Promise.all(
        Object.values(loopEngine.strategies).map((strategy) => strategy?.disposeSession?.(sessionId)),
      );
    },
    skills,
    skillsDir,
    memory,
    artifactStore,
    defaultMaxSteps: loopEngine.defaultMaxSteps,
    // The turn's injection boundary: a session that attaches a vault gets its
    // unrestricted environment variables in the sandbox command environment, and
    // its `limited` ones only where the policy can name a host. A shell command
    // declares none, which is why this call passes no target.
    resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db, sessionId, {
      dataDir,
      ...target,
    }),
    logger,
  });
  if (reconciled > 0) {
    console.log(`  Recovery:  reconciled ${reconciled} interrupted session(s)`);
  }

  // Compose the operations wirings before the server accepts traffic: a webhook
  // subscription created in the gap between binding and registration would miss
  // every event until the next restart, and a deployment whose next run passed
  // while the runtime was down needs its forward schedule restored.
  const { stopOperationsTimers } = composeOperations({
    db,
    sessionManager,
    webhookSecret: webhookSigningSecret(dataDir),
    dataDir,
    logger,
  });

  const runtimeApiAuth = resolveRuntimeApiAuth({ db });

  let server: ReturnType<typeof serve> | undefined;
  const stopRuntime = createRuntimeStopper({
    getServer: () => server,
    sessionManager,
    db,
    logger,
  });

  // Create HTTP server
  const app = createServer({
    db,
    sessionManager,
    agents,
    apiKeys: runtimeApiAuth.apiKeys,
    hasApiKeys: runtimeApiAuth.hasApiKeys,
    validateApiKey: runtimeApiAuth.validateApiKey,
    logger,
    logStore,
    metrics,
    restart: () => {
      stopOperationsTimers();
      stopRuntime('restart');
    },
    workQueue,
    corsOrigins: parseCsv(process.env.MANAGED_AGENTS_CORS_ORIGINS),
    workspace: {
      root: workspaceRoot,
      dataDir,
      databasePath: dbPath,
      agentsDir,
      skillsDir,
      configPath,
      logFile,
      logsDir: logDirForFile(logFile),
      target,
    },
    artifactStorageDir: () => artifactStore.rootPath(),
    artifactStore: () => artifactStore,
    runtime: {
      models: modelRegistry.listRuntimeInfo(),
      sandboxProviders: sandboxRegistry.listTypes(),
      memory: memory ? memory.name : 'disabled',
      authEnabled: runtimeApiAuth.hasApiKeys(),
      version: VERSION,
    },
    listRuntimeModels: () => modelRegistry.listRuntimeInfo(),
    registerModelProvider: (config) => modelRegistry.register(config),
    setDefaultRuntimeModel: (name) => modelRegistry.setDefault(name),
    skills,
    getMcpStatus: (sessionId) => executor.getMcpStatus(sessionId),
    reloadAgents: () => {
      return reloadRuntimeAgents({ db, agentsDir, agents });
    },
  });

  // Start the server
  server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  }, (info) => {
    for (const line of runtimeStartupBannerLines({
      version: VERSION,
      host,
      port: info.port,
      agentsCount: agents.length,
      skillsCount: skills.length,
      sandboxProviders: sandboxRegistry.listTypes(),
      memory: memory ? memory.name : 'disabled',
      target,
      dataDir,
      authEnabled: runtimeApiAuth.hasApiKeys(),
      agentLoadErrorCount: agentSkillState.agentLoadErrors.length,
    })) {
      console.log(line);
    }
  });

  // Port-in-use / bind errors: print a clear message and exit (R1.5) rather
  // than crashing with an unhandled 'error' event stack trace.
  attachRuntimeServerErrorHandler({ server, port, db });

  // Graceful shutdown: stop accepting requests, stop the operations timers,
  // drain turns + sandboxes, close DB
  process.on('SIGINT', () => {
    stopOperationsTimers();
    void stopRuntime('shutdown');
  });
  process.on('SIGTERM', () => {
    stopOperationsTimers();
    void stopRuntime('shutdown');
  });
}

runCli({ version: VERSION, startServer });
