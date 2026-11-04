import { probePiCli, type PiCliProbeResult } from '@/strategy/pi-launcher.js';
import type { Database } from '@/core/db/database.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeKubernetesCluster, resolveKubernetesNamespace } from '@/sandbox/kubernetes-provider.js';
import type { RuntimeSettings } from './schema.js';
import { hasRuntimeSettingsSecret, localArtifactStorageDir, runtimeSettingsSecretStates } from './store.js';
import { MINIMAX_PROVIDER } from '@/core/model/minimax.js';

export type RuntimeSettingsTestArea =
  | 'model'
  | 'loop_engine'
  | 'storage.metadata'
  | 'storage.artifacts'
  | 'memory'
  | 'sandbox'
  | 'web_search';

export type RuntimeSettingsTestCheck = {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  message: string;
};

export type RuntimeSettingsTestResult = {
  ok: boolean;
  area: RuntimeSettingsTestArea;
  status: 'ok' | 'failed' | 'skipped';
  checks: RuntimeSettingsTestCheck[];
};

export function mergeRuntimeSettingsArea(
  base: RuntimeSettings,
  area: RuntimeSettingsTestArea,
  config: unknown,
): RuntimeSettings {
  const fragment = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  switch (area) {
    case 'model':
      return { ...base, model: fragment as RuntimeSettings['model'] };
    case 'loop_engine':
      return { ...base, loop_engine: fragment as RuntimeSettings['loop_engine'] };
    case 'storage.metadata':
      return { ...base, storage: { ...base.storage, metadata: fragment as RuntimeSettings['storage']['metadata'] } };
    case 'storage.artifacts':
      return { ...base, storage: { ...base.storage, artifacts: fragment as RuntimeSettings['storage']['artifacts'] } };
    case 'memory':
      return { ...base, memory: fragment as RuntimeSettings['memory'] };
    case 'sandbox':
      return { ...base, sandbox: fragment as RuntimeSettings['sandbox'] };
    case 'web_search':
      return { ...base, web_search: fragment as RuntimeSettings['web_search'] };
  }
}

export interface RuntimeSettingsTestParams {
  db: Database;
  dataDir?: string;
  area: RuntimeSettingsTestArea;
  config: RuntimeSettings;
  /** Injectable only for deterministic settings-test coverage. */
  piProbe?: () => Promise<PiCliProbeResult>;
}

export function testRuntimeSettingsArea(params: RuntimeSettingsTestParams): Promise<RuntimeSettingsTestResult> {
  return testRuntimeSettingsAreaWithFetch(params);
}

export async function testRuntimeSettingsAreaWithFetch(
  params: RuntimeSettingsTestParams,
  fetchImpl: typeof fetch = fetch,
  kubernetesProbe: typeof probeKubernetesCluster = probeKubernetesCluster,
): Promise<RuntimeSettingsTestResult> {
  const checks = await runChecks(params, fetchImpl, kubernetesProbe);
  const failed = checks.some((check) => check.status === 'failed');
  const skipped = checks.length > 0 && checks.every((check) => check.status === 'skipped');
  return {
    area: params.area,
    ok: !failed,
    status: failed ? 'failed' : skipped ? 'skipped' : 'ok',
    checks,
  };
}

async function runChecks(
  params: RuntimeSettingsTestParams,
  fetchImpl: typeof fetch,
  kubernetesProbe: typeof probeKubernetesCluster,
): Promise<RuntimeSettingsTestCheck[]> {
  const { db, dataDir, area, config } = params;
  switch (area) {
    case 'model':
      return testModel(db, config);
    case 'loop_engine':
      return testLoopEngine(config, params.piProbe);
    case 'storage.metadata':
      return testMetadataStorage(db, config);
    case 'storage.artifacts':
      return testArtifactStorage(dataDir, config);
    case 'memory':
      return testMemory(db, config);
    case 'sandbox':
      return testSandbox(dataDir, config, fetchImpl, kubernetesProbe);
    case 'web_search':
      return testWebSearch(db, config);
  }
}

async function testLoopEngine(
  config: RuntimeSettings,
  piProbe?: () => Promise<PiCliProbeResult>,
): Promise<RuntimeSettingsTestCheck[]> {
  if (config.loop_engine.provider === 'builtin') {
    return [{ name: 'engine_available', status: 'ok', message: 'Built-in loop engine is available.' }];
  }
  if (config.loop_engine.provider === 'pi') {
    if (config.sandbox.provider !== 'local') {
      return [{
        name: 'pi_host_workdir',
        status: 'failed',
        message: 'Pi loop engine requires the local sandbox provider because it needs a host-accessible work directory.',
      }];
    }
    const result = await (piProbe ?? probePiCli)();
    return [{
      name: 'pi_cli',
      status: result.available ? 'ok' : 'failed',
      message: result.message,
    }];
  }
  return [{
    name: 'engine_available',
    status: 'failed',
    message: `Loop engine "${config.loop_engine.provider}" is not installed.`,
  }];
}

function testModel(db: Database, config: RuntimeSettings): RuntimeSettingsTestCheck[] {
  const checks: RuntimeSettingsTestCheck[] = [];
  const vendor = config.model.vendor;
  checks.push({
    name: 'vendor',
    status: ['openai', 'anthropic', 'openai_compatible', MINIMAX_PROVIDER].includes(vendor) ? 'ok' : 'failed',
    message: `Model vendor is ${vendor}.`,
  });

  if (vendor === 'openai_compatible') {
    checks.push({
      name: 'base_url',
      status: config.model.base_url ? 'ok' : 'failed',
      message: config.model.base_url ? 'OpenAI-compatible base URL is configured.' : 'OpenAI-compatible vendors require base_url.',
    });
  } else if (config.model.base_url) {
    checks.push({
      name: 'base_url',
      status: 'ok',
      message: 'Custom base URL is configured.',
    });
  }

  checks.push({
    name: 'api_key',
    status: hasResolvableModelKey(db, config) ? 'ok' : 'failed',
    message: hasResolvableModelKey(db, config)
      ? 'Model API key is configured or resolves from the environment.'
      : 'Model API key is not configured or its environment variable is missing.',
  });
  return checks;
}

function testMetadataStorage(db: Database, config: RuntimeSettings): RuntimeSettingsTestCheck[] {
  if (config.storage.metadata.provider !== 'sqlite') {
    return [{
      name: 'metadata_provider',
      status: 'failed',
      message: `Metadata provider "${config.storage.metadata.provider}" is not installed.`,
    }];
  }
  try {
    const result = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    return [{
      name: 'sqlite_quick_check',
      status: result?.quick_check === 'ok' ? 'ok' : 'failed',
      message: result?.quick_check === 'ok' ? 'SQLite metadata database passed quick_check.' : 'SQLite metadata database failed quick_check.',
    }];
  } catch (err) {
    return [{ name: 'sqlite_quick_check', status: 'failed', message: err instanceof Error ? err.message : 'SQLite quick_check failed.' }];
  }
}

function testArtifactStorage(dataDir: string | undefined, config: RuntimeSettings): RuntimeSettingsTestCheck[] {
  if (!dataDir) return [{ name: 'artifact_data_dir', status: 'failed', message: 'Runtime data directory is not available.' }];
  try {
    const target = localArtifactStorageDir(dataDir, config);
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
    const probe = join(target, `.managed-agents-write-test-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return [{ name: 'local_artifact_storage', status: 'ok', message: `Local artifact storage is writable at ${target}.` }];
  } catch (err) {
    return [{ name: 'local_artifact_storage', status: 'failed', message: err instanceof Error ? err.message : 'Artifact storage check failed.' }];
  }
}

function testMemory(db: Database, config: RuntimeSettings): RuntimeSettingsTestCheck[] {
  if (!config.memory.enabled) {
    return [{ name: 'memory_enabled', status: 'skipped', message: 'Context memory is disabled.' }];
  }
  if (config.memory.provider !== 'sqlite') {
    return [{ name: 'memory_provider', status: 'failed', message: `Memory provider "${config.memory.provider}" is not installed.` }];
  }
  try {
    db.prepare('SELECT 1').get();
    return [{ name: 'sqlite_memory', status: 'ok', message: 'SQLite memory backend is available.' }];
  } catch (err) {
    return [{ name: 'sqlite_memory', status: 'failed', message: err instanceof Error ? err.message : 'SQLite memory check failed.' }];
  }
}

async function testSandbox(
  dataDir: string | undefined,
  config: RuntimeSettings,
  fetchImpl: typeof fetch,
  kubernetesProbe: typeof probeKubernetesCluster,
): Promise<RuntimeSettingsTestCheck[]> {
  if (config.sandbox.provider === 'remote') {
    return testRemoteSandbox(config, fetchImpl);
  }
  if (config.sandbox.provider === 'kubernetes') {
    return testKubernetesSandbox(config, kubernetesProbe);
  }
  if (config.sandbox.provider !== 'local') {
    return [{
      name: 'sandbox_live_health',
      status: 'skipped',
      message: `Sandbox provider "${config.sandbox.provider}" is selected. Live health checks are not implemented for this provider yet.`,
    }];
  }
  if (!dataDir) return [{ name: 'sandbox_data_dir', status: 'failed', message: 'Runtime data directory is not available.' }];
  const timeout = config.sandbox.options.timeout_seconds;
  const checks: RuntimeSettingsTestCheck[] = [{
    name: 'timeout',
    status: Number.isInteger(timeout) && timeout > 0 ? 'ok' : 'failed',
    message: `Sandbox timeout is ${timeout} seconds.`,
  }];
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.managed-agents-sandbox-test-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    checks.push({ name: 'local_data_dir', status: 'ok', message: 'Runtime data directory is writable for local sandbox work.' });
  } catch (err) {
    checks.push({ name: 'local_data_dir', status: 'failed', message: err instanceof Error ? err.message : 'Local sandbox directory check failed.' });
  }
  return checks;
}

/**
 * Check the Kubernetes backend's two preconditions: a namespace the API server
 * will accept, and a reachable cluster. Without this the Console's Test action
 * gave no signal at all for this backend, so the first failure an operator saw
 * was a session that would not start.
 */
async function testKubernetesSandbox(
  config: RuntimeSettings,
  kubernetesProbe: typeof probeKubernetesCluster,
): Promise<RuntimeSettingsTestCheck[]> {
  const options = config.sandbox.options;
  const namespace = typeof options.namespace === 'string' && options.namespace.trim()
    ? options.namespace.trim()
    : 'default';
  const checks: RuntimeSettingsTestCheck[] = [{
    name: 'timeout',
    status: Number.isInteger(options.timeout_seconds) && options.timeout_seconds > 0 ? 'ok' : 'failed',
    message: `Sandbox timeout is ${options.timeout_seconds} seconds.`,
  }];

  let namespaceOk = true;
  try {
    resolveKubernetesNamespace(namespace);
  } catch (err) {
    namespaceOk = false;
    checks.push({
      name: 'namespace',
      status: 'failed',
      message: err instanceof Error ? err.message : `Namespace "${namespace}" is invalid.`,
    });
  }
  if (namespaceOk) {
    checks.push({ name: 'namespace', status: 'ok', message: `Session Pods will be created in namespace "${namespace}".` });
    const probe = await kubernetesProbe({
      kubeconfig: typeof options.kubeconfig === 'string' ? options.kubeconfig : undefined,
      context: typeof options.context === 'string' ? options.context : undefined,
    });
    checks.push({
      name: 'cluster_reachable',
      status: probe.ok ? 'ok' : 'failed',
      message: probe.message,
    });
  } else {
    checks.push({
      name: 'cluster_reachable',
      status: 'skipped',
      message: 'Skipped Kubernetes cluster probe because the namespace is invalid.',
    });
  }

  const serviceAccount = typeof options.service_account === 'string' ? options.service_account.trim() : '';
  checks.push({
    name: 'service_account',
    status: 'ok',
    message: serviceAccount
      ? `Session Pods will run as ServiceAccount "${serviceAccount}" with a mounted API token.`
      : 'Session Pods will run without a mounted Kubernetes API token.',
  });

  return checks;
}

async function testRemoteSandbox(config: RuntimeSettings, fetchImpl: typeof fetch): Promise<RuntimeSettingsTestCheck[]> {
  const endpoint = typeof config.sandbox.options.endpoint === 'string'
    ? config.sandbox.options.endpoint.trim().replace(/\/$/, '')
    : '';
  const apiKey = config.sandbox.options.api_key;
  const checks: RuntimeSettingsTestCheck[] = [{
    name: 'timeout',
    status: Number.isInteger(config.sandbox.options.timeout_seconds) && config.sandbox.options.timeout_seconds > 0 ? 'ok' : 'failed',
    message: `Sandbox timeout is ${config.sandbox.options.timeout_seconds} seconds.`,
  }];
  if (!endpoint) {
    checks.push({
      name: 'remote_endpoint',
      status: 'failed',
      message: 'Remote sandbox requires a worker API URL.',
    });
    return checks;
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    checks.push({
      name: 'remote_api_key',
      status: 'failed',
      message: 'Remote sandbox requires a worker API key.',
    });
    return checks;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchImpl(`${endpoint}/v1/x/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    checks.push({
      name: 'remote_health',
      status: response.ok ? 'ok' : 'failed',
      message: response.ok
        ? `Remote sandbox worker API responded at ${endpoint}.`
        : `Remote sandbox worker API returned HTTP ${response.status}.`,
    });
  } catch (err) {
    checks.push({
      name: 'remote_health',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Remote sandbox worker API health check failed.',
    });
  } finally {
    clearTimeout(timeout);
  }
  return checks;
}

/** Web-search adapters this runtime ships; `keyless` ones run without an api_key. */
const SHIPPED_WEB_SEARCH_ADAPTERS: Partial<Record<string, { label: string; keyless: boolean }>> = {
  tavily: { label: 'Tavily', keyless: false },
  keenable: { label: 'Keenable', keyless: true },
};

/**
 * Web-search checks stay configuration-level: a live probe would spend one of
 * the operator's metered requests on a Test button, so the check verifies the
 * pieces a turn needs — a shipped adapter selected and a key that resolves —
 * rather than proving the vendor answers.
 */
function testWebSearch(db: Database, config: RuntimeSettings): RuntimeSettingsTestCheck[] {
  const webSearch = config.web_search;
  if (!webSearch) {
    return [{
      name: 'provider',
      status: 'skipped',
      message: 'No web_search provider is configured; the tool stays unavailable.',
    }];
  }
  const shipped = SHIPPED_WEB_SEARCH_ADAPTERS[webSearch.provider];
  const checks: RuntimeSettingsTestCheck[] = [{
    name: 'provider',
    status: shipped ? 'ok' : 'failed',
    message: shipped
      ? `${shipped.label} adapter is installed.`
      : `Web search provider "${webSearch.provider}" has no adapter in this runtime.`,
  }];
  const key = webSearch.options.api_key;
  if (shipped?.keyless && (typeof key !== 'string' || key.trim().length === 0)) {
    checks.push({
      name: 'api_key',
      status: 'ok',
      message: `No api_key configured; ${shipped.label} uses its keyless public endpoint (rate limited per IP).`,
    });
    return checks;
  }
  const envRef = typeof key === 'string' ? /^\$\{([^}]+)\}$/.exec(key) : null;
  const resolvable = typeof key === 'string' && key.trim().length > 0 && (
    key === '********' || key.startsWith('__managed_secret__')
      ? hasRuntimeSettingsSecret(db, 'web_search.options.api_key')
      : envRef
        ? Boolean(process.env[envRef[1]])
        : true
  );
  checks.push({
    name: 'api_key',
    status: resolvable ? 'ok' : 'failed',
    message: resolvable
      ? 'Web search API key is configured or resolves from the environment.'
      : 'Web search api_key is not configured or its environment variable is missing.',
  });
  return checks;
}

function hasResolvableModelKey(db: Database, config: RuntimeSettings): boolean {
  const value = config.model.api_key;
  if (!value) return false;
  if (value === '********') return runtimeSettingsSecretStates(db, config).model.api_key === 'configured';
  const match = /^\$\{([^}]+)\}$/.exec(value);
  if (match) return Boolean(process.env[match[1]]);
  return true;
}
