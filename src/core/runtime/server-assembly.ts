import type { Database } from '@/core/db/database.js';
import type { Logger, LogStore } from '@/core/observability/logger.js';
import type { Metrics } from '@/core/observability/metrics.js';
import type { SessionManager } from '@/core/session/session-manager.js';
import type { DefaultSessionExecutor } from '@/core/session/executor.js';
import type { Skill } from '@/core/skills/loader.js';
import { loadAgents } from '@/core/agent/loader.js';
import { importAgentSeeds, refreshAgentsFromDb } from '@/core/agent/store.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import type { SessionWorkQueue } from '@/sandbox/session-work-queue.js';
import type { ModelRegistry } from '@/model/registry.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { createServer } from '@/api/server.js';
import { createModelAssistedOutcomeEvaluator } from '@/core/operations/outcome-evaluator.js';

export function createRuntimeServerApp(opts: {
  db: Database;
  sessionManager: SessionManager;
  agents: AgentDefinition[];
  apiKeys: string[];
  hasRuntimeApiKeys: () => boolean;
  validateRuntimeApiKey: (key: string) => boolean;
  logger: Logger;
  logStore: LogStore;
  metrics: Metrics;
  restart: () => Promise<void> | void;
  workQueue: WorkQueue;
  sessionWorkQueue?: SessionWorkQueue;
  workspace: {
    root: string;
    dataDir: string;
    agentsDir: string;
    skillsDir: string;
    configPath: string;
    target: string;
  };
  modelRegistry: ModelRegistry;
  sandboxRegistry: SandboxProviderRegistry;
  memoryName: string;
  skills: Skill[];
  executor: DefaultSessionExecutor;
}) {
  return createServer({
    db: opts.db,
    sessionManager: opts.sessionManager,
    agents: opts.agents,
    apiKeys: opts.apiKeys,
    hasApiKeys: opts.hasRuntimeApiKeys,
    validateApiKey: opts.validateRuntimeApiKey,
    logger: opts.logger,
    logStore: opts.logStore,
    metrics: opts.metrics,
    restart: opts.restart,
    workQueue: opts.workQueue,
    sessionWorkQueue: opts.sessionWorkQueue,
    sandboxCapabilities: (type) => opts.sandboxRegistry.capabilitiesOf(type),
    workspace: opts.workspace,
    runtime: {
      models: opts.modelRegistry.listRuntimeInfo(),
      sandboxProviders: opts.sandboxRegistry.listTypes(),
      memory: opts.memoryName,
      authEnabled: opts.apiKeys.length > 0,
    },
    listRuntimeModels: () => opts.modelRegistry.listRuntimeInfo(),
    registerModelProvider: (config) => opts.modelRegistry.register(config),
    setDefaultRuntimeModel: (name) => opts.modelRegistry.setDefault(name),
    skills: opts.skills,
    getMcpStatus: (sessionId) => opts.executor.getMcpStatus(sessionId),
    reloadAgents: () => {
      const result = loadAgents(opts.workspace.agentsDir);
      importAgentSeeds(opts.db, result.agents);
      const activeAgents = refreshAgentsFromDb(opts.db, opts.agents);
      return { agents: activeAgents, errors: result.errors };
    },
    evaluateOutcome: createModelAssistedOutcomeEvaluator(opts.modelRegistry),
  });
}
