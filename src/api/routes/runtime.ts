import { Hono } from 'hono';
import { dirname } from 'node:path';
import type { LogLevel } from '@/core/observability/logger.js';
import {
  listMemoryProviders,
  toRuntimeMemoryProviderInfo,
} from '@/core/memory/providers.js';
import {
  listStorageProviders,
  toRuntimeStorageProviderInfo,
} from '@/core/storage/providers.js';
import type { ServerDeps } from '../server.js';

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

export function runtimeRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.post('/reload', (c) => {
    try {
      const result = deps.reloadAgents();
      deps.agents.length = 0;
      deps.agents.push(...result.agents);

      return c.json({
        reloaded: true,
        agents_loaded: result.agents.length,
        errors: result.errors,
      });
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.post('/restart', (c) => {
    if (!deps.restart) {
      return c.json({
        error: {
          type: 'unsupported',
          message: 'Runtime restart is not available for this server instance.',
        },
      }, 501);
    }

    deps.logger?.warn('runtime_restart_scheduled', {
      source: 'api',
      path: c.req.path,
    });

    setTimeout(() => {
      void Promise.resolve(deps.restart?.()).catch((err: any) => {
        deps.logger?.error('runtime_restart_failed', {
          error: err?.message ?? String(err),
        });
      });
    }, 50);

    return c.json({ restarting: true, status: 'scheduled' }, 202);
  });

  app.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      agents_loaded: deps.agents.length,
    });
  });

  app.get('/logs', (c) => {
    const rawLevel = c.req.query('level');
    const level = rawLevel as LogLevel | undefined;
    if (rawLevel && !LOG_LEVELS.has(level as LogLevel)) {
      return c.json({
        error: {
          type: 'invalid_request',
          message: 'level must be one of debug, info, warn, or error',
        },
      }, 400);
    }

    const limit = parsePositiveInteger(c.req.query('limit')) ?? 200;
    const query = c.req.query('q') ?? c.req.query('query') ?? undefined;
    const data = deps.logStore?.list({ limit, level, query }) ?? [];
    return c.json({
      data,
      has_more: false,
      first_id: data[0]?.time ?? null,
      last_id: data.at(-1)?.time ?? null,
    });
  });

  app.get('/metrics', (c) => {
    if (!deps.metrics) {
      return c.text('# metrics disabled\n', 200, { 'Content-Type': 'text/plain' });
    }
    return c.text(deps.metrics.render(), 200, { 'Content-Type': 'text/plain; version=0.0.4' });
  });

  // GET /metrics/summary - JSON runtime/workspace summary for Console monitoring.
  app.get('/metrics/summary', (c) => {
    const sessionsByStatus = countBy(deps.db, 'sessions', 'status');
    const eventsByType = countBy(deps.db, 'events', 'type');
    const sessionUsage = deps.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(usage_tokens_in), 0) AS input_tokens,
        COALESCE(SUM(usage_tokens_out), 0) AS output_tokens
       FROM sessions`,
    ).get() as { total: number; input_tokens: number; output_tokens: number };
    const eventUsage = deps.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(tokens_in), 0) AS input_tokens,
        COALESCE(SUM(tokens_out), 0) AS output_tokens,
        COALESCE(AVG(NULLIF(duration_ms, 0)), 0) AS average_duration_ms
       FROM events
       WHERE type = 'span.model_request_end'`,
    ).get() as { total: number; input_tokens: number; output_tokens: number; average_duration_ms: number };
    const files = deps.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(size_bytes), 0) AS bytes
       FROM files
       WHERE archived_at IS NULL`,
    ).get() as { total: number; bytes: number };
    const artifacts = deps.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(size_bytes), 0) AS bytes
       FROM files
       WHERE archived_at IS NULL AND role = 'artifact'`,
    ).get() as { total: number; bytes: number };
    const metricsSnapshot = deps.metrics?.snapshot();
    return c.json({
      type: 'metrics_summary',
      generated_at: new Date().toISOString(),
      sessions: {
        total: Number(sessionUsage.total ?? 0),
        by_status: sessionsByStatus,
        input_tokens: Number(sessionUsage.input_tokens ?? 0),
        output_tokens: Number(sessionUsage.output_tokens ?? 0),
      },
      events: {
        total: Number(eventUsage.total ?? 0),
        by_type: eventsByType,
        input_tokens: Number(eventUsage.input_tokens ?? 0),
        output_tokens: Number(eventUsage.output_tokens ?? 0),
        average_duration_ms: Math.round(Number(eventUsage.average_duration_ms ?? 0)),
      },
      storage: {
        files: Number(files.total ?? 0),
        file_bytes: Number(files.bytes ?? 0),
        artifacts: Number(artifacts.total ?? 0),
        artifact_bytes: Number(artifacts.bytes ?? 0),
      },
      work_queue: deps.workQueue?.stats() ?? {},
      http: {
        requests: metricsSnapshot?.counters.http_requests_total ?? 0,
        errors: metricsSnapshot?.counters.http_errors_total ?? 0,
        request_duration_ms: metricsSnapshot?.histograms.http_request_duration_ms ?? { count: 0, sum: 0 },
      },
    });
  });
  app.get('/mcp/status', (c) => {
    const sessionId = c.req.query('session_id');
    if (!sessionId) {
      return c.json({ error: { type: 'invalid_request', message: 'session_id query param is required' } }, 400);
    }
    if (!deps.sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    const servers = deps.getMcpStatus ? deps.getMcpStatus(sessionId) : [];
    return c.json({ session_id: sessionId, servers });
  });

  app.get('/workspace', (c) => {
    const workspace = deps.workspace;
    const configDir = workspace?.configPath ? dirname(workspace.configPath) : workspace?.root;
    return c.json({
      type: 'workspace',
      name: workspace?.root.split('/').filter(Boolean).at(-1) ?? 'local workspace',
      ...workspace,
      configDir,
      directories: workspace
        ? {
          root: workspace.root,
          agents: workspace.agentsDir,
          skills: workspace.skillsDir,
          data: workspace.dataDir,
          database: workspace.databasePath,
          config: workspace.configPath,
          logs: workspace.logsDir,
          logFile: workspace.logFile,
        }
        : {},
    });
  });

  app.get('/runtime', (c) => {
    const authEnabled = Boolean(deps.runtime?.authEnabled || deps.hasApiKeys?.());
    return c.json({
      type: 'runtime',
      status: 'running',
      agents_loaded: deps.agents.length,
      skills_loaded: deps.skills?.length ?? 0,
      models: runtimeModels(deps),
      sandbox_providers: deps.runtime?.sandboxProviders ?? [],
      memory: deps.runtime?.memory ?? 'disabled',
      memory_providers: listMemoryProviders(deps.db).map(toRuntimeMemoryProviderInfo),
      storage_providers: listStorageProviders(deps.db).map(toRuntimeStorageProviderInfo),
      auth_enabled: authEnabled,
    });
  });

  return app;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function countBy(db: ServerDeps['db'], table: 'sessions' | 'events', column: 'status' | 'type'): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS name, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ name: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]));
}

function runtimeModels(deps: ServerDeps) {
  return deps.listRuntimeModels?.() ?? deps.runtime?.models ?? [];
}
