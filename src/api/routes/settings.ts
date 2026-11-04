import { Hono } from 'hono';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import { join } from 'node:path';
import { createInboundRateLimiter } from '@/api/rate-limit.js';
import { testModelConnection } from '@/core/settings/model-connection.js';
import { describeSettingsAdapters, availabilityFromDescriptors } from '@/core/settings/adapters.js';
import { validateRuntimeSettings, validateRuntimeSettingsCredentials, type RuntimeSettings } from '@/core/settings/schema.js';
import {
  mergeRuntimeSettingsArea,
  testRuntimeSettingsArea,
  type RuntimeSettingsTestArea,
} from '@/core/settings/test.js';
import {
  getOrSeedRuntimeSettings,
  findRuntimeSettings,
  hasRuntimeSettingsSecret,
  maskRuntimeSettings,
  runtimeSettingsSecretStates,
  saveRuntimeSettings,
} from '@/core/settings/store.js';

const SETTINGS_TEST_AREAS = new Set<RuntimeSettingsTestArea>([
  'model',
  'loop_engine',
  'storage.metadata',
  'storage.artifacts',
  'memory',
  'sandbox',
  'web_search',
]);

const modelConnectionInput = z.object({
  model: z.string().trim().min(1).max(256),
  revision: z.number().int().positive(),
}).strict();

export function settingsRoutes(deps: ServerDeps) {
  const app = new Hono();
  app.use('/test-model', createInboundRateLimiter({
    enabled: true,
    readPerMinute: 1200,
    writePerMinute: 5,
  }).middleware);

  app.get('/', (c) => {
    const settings = getOrSeedRuntimeSettings(deps.db, {}, deps.workspace?.dataDir);
    const adapters = describeSettingsAdapters(deps.runtime?.sandboxProviders);
    return c.json({
      schema_version: settings.schema_version,
      revision: settings.revision,
      effective_revision: settings.effective_revision,
      saved_config: maskRuntimeSettings(settings.saved_config),
      effective_config: maskRuntimeSettings(settings.effective_config),
      restart_required: settings.restart_required,
      activation_status: settings.activation_status,
      activation_errors: settings.activation_errors,
      diagnostics: settingsDiagnostics(deps),
      adapters,
      secret_states: runtimeSettingsSecretStates(deps.db, settings.saved_config),
    });
  });

  app.post('/validate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        valid: false,
        errors: [{ path: '', code: 'invalid_json', message: 'Request body must be valid JSON' }],
        warnings: [],
      }, 400);
    }
    const adapters = describeSettingsAdapters(deps.runtime?.sandboxProviders);
    const result = validateRuntimeSettings(body, availabilityFromDescriptors(adapters));
    if (result.normalized_config) {
      result.errors.push(...validateRuntimeSettingsCredentials(
        result.normalized_config,
        (path) => hasRuntimeSettingsSecret(deps.db, path),
      ));
      result.valid = result.errors.length === 0;
    }
    return c.json({
      ...result,
      ...(result.normalized_config ? { normalized_config: maskRuntimeSettings(result.normalized_config) } : {}),
    });
  });

  app.post('/test', async (c) => {
    let body: { area?: unknown; config?: unknown; full_config?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    const area = body?.area;
    if (typeof area !== 'string' || !SETTINGS_TEST_AREAS.has(area as RuntimeSettingsTestArea)) {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: 'area must be one of model, loop_engine, storage.metadata, storage.artifacts, memory, sandbox, or web_search',
        },
      }, 400);
    }

    const settings = getOrSeedRuntimeSettings(deps.db, {}, deps.workspace?.dataDir);
    const candidate = body.full_config
      ? body.full_config
      : mergeRuntimeSettingsArea(settings.saved_config, area as RuntimeSettingsTestArea, body.config);
    const adapters = describeSettingsAdapters(deps.runtime?.sandboxProviders);
    const validation = validateRuntimeSettings(candidate, availabilityFromDescriptors(adapters));
    if (validation.normalized_config) {
      validation.errors.push(...credentialIssuesForTestArea(
        area as RuntimeSettingsTestArea,
        validation.normalized_config,
        (path) => hasRuntimeSettingsSecret(deps.db, path),
      ));
      validation.valid = validation.errors.length === 0;
    }
    if (!validation.valid || !validation.normalized_config) {
      return c.json({
        ok: false,
        area,
        status: 'failed',
        checks: [],
        errors: validation.errors,
        warnings: validation.warnings,
      }, 422);
    }

    const result = await testRuntimeSettingsArea({
      db: deps.db,
      dataDir: deps.workspace?.dataDir,
      area: area as RuntimeSettingsTestArea,
      config: validation.normalized_config,
    });
    return c.json({ ...result, errors: [], warnings: validation.warnings });
  });

  app.post('/test-model', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    const input = modelConnectionInput.safeParse(body);
    if (!input.success) {
      return c.json({ error: {
        type: 'invalid_request_error',
        message: 'Provide only model (1–256 characters) and revision (a positive integer)',
      } }, 400);
    }
    const settings = findRuntimeSettings(deps.db);
    if (!settings) {
      return c.json({ ok: false, outcome: 'configuration_invalid', model: input.data.model,
        provider: 'unconfigured', config_source: 'saved', revision: 0, elapsed_ms: 0 });
    }
    if (settings.revision !== input.data.revision) {
      return c.json({ error: {
        type: 'revision_conflict', message: 'Settings changed. Refresh before testing the model.',
      } }, 409);
    }
    return c.json(await testModelConnection({
      db: deps.db, dataDir: deps.workspace?.dataDir, settings,
      model: input.data.model, signal: c.req.raw.signal,
    }));
  });

  app.put('/', async (c) => {
    let body: { revision?: unknown; config?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    if (!body || typeof body !== 'object' || !Number.isInteger(body.revision) || (body.revision as number) < 1) {
      return c.json({ error: { type: 'invalid_request_error', message: 'revision must be a positive integer' } }, 400);
    }
    const adapters = describeSettingsAdapters(deps.runtime?.sandboxProviders);
    const validation = validateRuntimeSettings(body.config, availabilityFromDescriptors(adapters));
    if (validation.normalized_config) {
      validation.errors.push(...validateRuntimeSettingsCredentials(
        validation.normalized_config,
        (path) => hasRuntimeSettingsSecret(deps.db, path),
      ));
      validation.valid = validation.errors.length === 0;
    }
    if (!validation.valid || !validation.normalized_config) {
      return c.json({
        error: { type: 'validation_error', message: 'Settings configuration is invalid' },
        ...validation,
      }, 422);
    }
    const previous = getOrSeedRuntimeSettings(deps.db, {}, deps.workspace?.dataDir);
    const saved = saveRuntimeSettings(
      deps.db,
      validation.normalized_config,
      body.revision as number,
      deps.workspace?.dataDir,
    );
    if (!saved.ok) {
      return c.json({
        error: { type: 'revision_conflict', message: 'Settings were modified by another request' },
        revision: saved.record.revision,
        saved_config: maskRuntimeSettings(saved.record.saved_config),
      }, 409);
    }
    deps.logger?.info('runtime_settings_saved', {
      old_revision: previous.revision,
      new_revision: saved.record.revision,
      changed_paths: changedRuntimeSettingsPaths(previous.saved_config, saved.record.saved_config, validation.normalized_config),
      restart_required: saved.record.restart_required,
    });
    return c.json({
      schema_version: saved.record.schema_version,
      revision: saved.record.revision,
      effective_revision: saved.record.effective_revision,
      saved_config: maskRuntimeSettings(saved.record.saved_config),
      effective_config: maskRuntimeSettings(saved.record.effective_config),
      restart_required: saved.record.restart_required,
      activation_status: saved.record.activation_status,
      activation_errors: saved.record.activation_errors,
      diagnostics: settingsDiagnostics(deps),
      secret_states: runtimeSettingsSecretStates(deps.db, saved.record.saved_config),
    });
  });

  return app;
}

function settingsDiagnostics(deps: ServerDeps) {
  let metadataHealth: 'ok' | 'failed' = 'failed';
  try {
    const result = deps.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    metadataHealth = result?.quick_check === 'ok' ? 'ok' : 'failed';
  } catch {
    metadataHealth = 'failed';
  }
  return {
    metadata: {
      path: deps.workspace?.dataDir ? join(deps.workspace.dataDir, 'data.db') : null,
      health: metadataHealth,
    },
  };
}

function changedRuntimeSettingsPaths(before: RuntimeSettings, after: RuntimeSettings, candidate: RuntimeSettings = after): string[] {
  const paths = new Set<string>();
  collectChangedPaths(before, after, candidate, '', paths);
  return Array.from(paths).sort();
}

function credentialIssuesForTestArea(
  area: RuntimeSettingsTestArea,
  config: RuntimeSettings,
  hasStoredSecret: (path: string) => boolean,
) {
  const prefixes = credentialPrefixesForTestArea(area);
  return validateRuntimeSettingsCredentials(config, hasStoredSecret)
    .filter((issue) => prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)));
}

function credentialPrefixesForTestArea(area: RuntimeSettingsTestArea): string[] {
  switch (area) {
    case 'model':
      return ['model'];
    case 'loop_engine':
      return ['loop_engine'];
    case 'storage.metadata':
      return ['storage.metadata'];
    case 'storage.artifacts':
      return ['storage.artifacts'];
    case 'memory':
      return ['memory'];
    case 'sandbox':
      return ['sandbox'];
    case 'web_search':
      return ['web_search'];
  }
}

function collectChangedPaths(before: unknown, after: unknown, candidate: unknown, prefix: string, paths: Set<string>): void {
  if (prefix && isSettingsSecretPath(prefix)) {
    if (candidate === '********') {
      if (!Object.is(before, after)) paths.add(prefix);
      return;
    }
    if (candidate === undefined) {
      if (before !== undefined) paths.add(prefix);
      return;
    }
    if (typeof candidate === 'string') {
      if (!Object.is(before, candidate)) paths.add(prefix);
      return;
    }
  }
  if (Object.is(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childCandidate = isPlainObject(candidate) ? candidate[key] : after[key];
      collectChangedPaths(before[key], after[key], childCandidate, childPrefix, paths);
    }
    return;
  }
  if (prefix) paths.add(prefix);
}

function isSettingsSecretPath(path: string): boolean {
  if (path === 'model.api_key') return true;
  if (!path.includes('.options.')) return false;
  const key = path.split('.').at(-1) ?? '';
  return /(api[_-]?key|access[_-]?key|secret|token|password|credential)/i.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
