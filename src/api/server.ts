/**
 * HTTP API Server
 *
 * Hono-based REST API exposing Managed Agents endpoints.
 * Factory function pattern - creates server with injected dependencies.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionsRoutes } from './routes/sessions.js';
import { agentsRoutes } from './routes/agents.js';
import { resourceRoutes } from './routes/resources.js';
import { skillsRoutes } from './routes/skills.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { extendedRoutes } from './routes/extended.js';
import { streamRoutes } from './routes/stream.js';
import { createAuthMiddleware } from './auth.js';
import type { SessionManager } from '@/core/session/session-manager.js';
import type { AgentDefinition } from '@/types/agent.js';
import { workerRoutes } from './routes/worker.js';
import { operationsRoutes } from './routes/operations.js';
import type { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import type { Logger, LogStore } from '@/core/observability/logger.js';
import type { Metrics } from '@/core/observability/metrics.js';
import type { Skill } from '@/core/skills/loader.js';
import type { Database } from '@/core/db/database.js';
import type { ModelConfig, RuntimeModelInfo } from '@/types/model.js';
import type { ArtifactStore } from '@/core/storage/artifact-store.js';
import type { OutcomeEvaluator } from '@/core/operations/outcome-evaluator.js';

export interface ServerDeps {
  db: Database;
  sessionManager: SessionManager;
  agents: AgentDefinition[];
  reloadAgents: () => { agents: AgentDefinition[]; errors: any[] };
  /** Accepted API keys. Empty/undefined = auth disabled (open, local-first). */
  apiKeys?: string[];
  /** Dynamic key presence check for database-managed API keys. */
  hasApiKeys?: () => boolean;
  /** Dynamic API key validator for database-managed API keys. */
  validateApiKey?: (key: string) => boolean;
  /** MCP connection status for a session (for /v1/x/mcp/status). */
  getMcpStatus?: (sessionId: string) => Array<{
    name: string;
    type: string;
    connected: boolean;
    toolCount: number;
    error?: string;
  }>;
  workspace?: {
    root: string;
    dataDir: string;
    databasePath?: string;
    agentsDir: string;
    skillsDir: string;
    /**
     * Optional: a workspace need not have a config file. `/v1/x/workspace`
     * already falls back to the workspace root when it is absent, so the
     * required declaration overstated the contract.
     */
    configPath?: string;
    logFile?: string;
    logsDir?: string;
    target: string;
  };
  /** Active local artifact directory resolved from effective runtime settings. */
  artifactStorageDir?: () => string;
  /** Active artifact store. Local-only for the first Settings V2 release. */
  artifactStore?: () => ArtifactStore;
  /** Optional model-assisted outcome evaluator for advanced operations routes. */
  evaluateOutcome?: OutcomeEvaluator;
  runtime?: {
    models: RuntimeModelInfo[];
    sandboxProviders: string[];
    memory: string;
    authEnabled: boolean;
  };
  /** Dynamic runtime model registry; used after dashboard-managed providers change. */
  listRuntimeModels?: () => RuntimeModelInfo[];
  /** Register a dashboard-managed model provider with the live model registry. */
  registerModelProvider?: (config: ModelConfig) => void;
  /** Mark the live runtime default model provider. */
  setDefaultRuntimeModel?: (name: string) => void;
  skills?: Skill[];
  /** Override for tests. Undefined = auto-detect dist/console; null = disabled. */
  consoleRoot?: string | null;
  /** Optional structured logger for request logging. */
  logger?: Logger;
  /** Optional in-process log store (exposed at /v1/x/logs). */
  logStore?: LogStore;
  /** Optional metrics registry (exposed at /v1/x/metrics). */
  metrics?: Metrics;
  /** Optional runtime restart hook (exposed at /v1/x/restart). */
  restart?: () => Promise<void> | void;
  /** Optional work queue for the self_hosted sandbox worker endpoints (R9.14). */
  workQueue?: WorkQueue;
  /**
   * Additional browser origins allowed to call the API. Same-origin and
   * localhost loopback origins are always allowed for the local Dashboard.
   */
  corsOrigins?: string[];
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  // Middleware
  app.use('*', cors({
    origin: (origin, c) => allowedCorsOrigin(origin, c.req.url, deps.corsOrigins),
  }));

  // Request logging + metrics (F3)
  if (deps.logger || deps.metrics) {
    app.use('*', async (c, next) => {
      const start = Date.now();
      await next();
      const durationMs = Date.now() - start;
      const route = c.req.routePath ?? c.req.path;
      deps.metrics?.counter('http_requests_total', 'Total HTTP requests');
      deps.metrics?.observe('http_request_duration_ms', durationMs, 'HTTP request duration (ms)');
      if (c.res.status >= 500) {
        deps.metrics?.counter('http_errors_total', 'Total HTTP 5xx responses');
      }
      deps.logger?.info('http_request', {
        method: c.req.method,
        path: c.req.path,
        route,
        status: c.res.status,
        durationMs,
      });
    });
  }

  app.use('*', createAuthMiddleware({
    apiKeys: deps.apiKeys,
    hasApiKeys: deps.hasApiKeys,
    validateApiKey: deps.validateApiKey,
  }));

  // Managed Agents API endpoints
  app.route('/v1/sessions', sessionsRoutes(deps));
  app.route('/v1/agents', agentsRoutes(deps));
  app.route('/v1', resourceRoutes(deps));
  app.route('/v1/skills', skillsRoutes(deps));
  app.route('/v1/api-keys', apiKeysRoutes(deps));

  // SSE streaming
  app.route('/v1/sessions', streamRoutes(deps));

  // Runtime extension endpoints
  app.route('/v1/x', extendedRoutes(deps));
  // Operations are part of the documented public API. Keep the legacy /v1/x
  // mount for compatibility with clients that adopted the preview paths.
  app.route('/v1', operationsRoutes(deps));
  app.route('/v1/x', operationsRoutes(deps));

  // Self-hosted sandbox worker endpoints (R9.14)
  if (deps.workQueue) {
    app.route('/v1/x/worker', workerRoutes(deps.workQueue));
  }

  // Root health check (JSON - used by SDK/clients)
  app.get('/', (c) => c.json({ status: 'ok', name: 'managed-agents', version: '0.1.0' }));

  // Web dashboard (R10)
  app.get('/ui', (c) => c.redirect('/dashboard', 308));
  app.get('/ui/*', (c) => c.redirect(c.req.path.replace(/^\/ui/, '/dashboard'), 308));
  app.get('/dashboard', (c) => serveConsoleAsset(c, 'index.html', deps.consoleRoot));
  app.get('/dashboard/*', (c) => {
    const path = c.req.path.replace(/^\/dashboard\/?/, '') || 'index.html';
    return serveConsoleAsset(c, path, deps.consoleRoot);
  });

  return app;
}

export function allowedCorsOrigin(
  origin: string,
  requestUrl: string,
  configuredOrigins: string[] = [],
): string | null {
  if (!origin) return null;
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return null;
  const requestOrigin = normalizeOrigin(new URL(requestUrl).origin);
  if (normalizedOrigin === requestOrigin) return normalizedOrigin;
  if (isLoopbackOrigin(normalizedOrigin)) return normalizedOrigin;
  const allowed = new Set(configuredOrigins.map(normalizeOrigin).filter((item): item is string => Boolean(item)));
  return allowed.has(normalizedOrigin) ? normalizedOrigin : null;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function serveConsoleAsset(c: any, requestedPath: string, overrideRoot?: string | null) {
  const root = resolveConsoleRoot(overrideRoot);
  if (!root) {
    return c.html(
      '<!doctype html><html><head><title>Dashboard not built</title></head><body><h1>Dashboard not built</h1><p>Run <code>npm run build:console</code> before serving /dashboard.</p></body></html>',
      503,
    );
  }

  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const assetPath = join(root, safePath);
  const filePath = existsSync(assetPath) && statSync(assetPath).isFile()
    ? assetPath
    : join(root, 'index.html');

  const content = readFileSync(filePath);
  return c.body(content, 200, {
    'Content-Type': contentTypeFor(filePath),
  });
}

function resolveConsoleRoot(overrideRoot?: string | null): string | null {
  if (overrideRoot === null) return null;
  if (overrideRoot) return existsSync(join(overrideRoot, 'index.html')) ? overrideRoot : null;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'console'),
    join(process.cwd(), 'dist', 'console'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
