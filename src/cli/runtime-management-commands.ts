import {
  ManagedAgentsClient,
  RuntimeSettingsValidationError,
  type EnvironmentSummary,
  type RuntimeSettingsSummary,
} from '@/sdk/client.js';

export type CliConnectionOptions = {
  port: string;
  apiKey?: string;
};

export type JsonOutputOption = {
  json?: boolean;
};

export type SettingsSetModelOptions = CliConnectionOptions & JsonOutputOption & {
  vendor: string;
  baseUrl?: string;
  apiKeyEnv?: string;
};

export type EnvironmentCreateOptions = CliConnectionOptions & JsonOutputOption & {
  name: string;
  description?: string;
  hostingType?: 'cloud' | 'local' | 'self_hosted';
  sandboxProvider?: string;
  configJson?: string;
};

export type EnvironmentUpdateOptions = CliConnectionOptions & JsonOutputOption & {
  name?: string;
  description?: string;
  hostingType?: 'cloud' | 'local' | 'self_hosted';
  sandboxProvider?: string;
  configJson?: string;
};

export async function settingsGetCommand(opts: CliConnectionOptions & JsonOutputOption) {
  const result = await createClient(opts).settings.get();
  if (opts.json) {
    printJson(result);
    return;
  }
  console.log(formatSettings(result));
}

/**
 * Point the model boundary at a vendor.
 *
 * `--api-key-env` writes a `${VAR}` *reference*, never a literal key, so the secret never
 * appears in shell history or in this process's arguments. The runtime resolves the
 * reference in its own environment, which is why `patch` reports `missing_env` with the
 * variable's name when it is not set there — a reference the CLI cannot check itself.
 */
export async function settingsSetModelCommand(opts: SettingsSetModelOptions) {
  const vendor = requiredString(opts.vendor, 'vendor');
  const apiKeyEnv = opts.apiKeyEnv?.trim();
  try {
    const result = await createClient(opts).settings.patch({
      model: {
        vendor,
        ...(apiKeyEnv ? { api_key: envReference(apiKeyEnv) } : {}),
        ...(opts.baseUrl ? { base_url: opts.baseUrl } : {}),
      },
    });
    if (opts.json) {
      printJson(result);
      return;
    }
    console.log(formatSettings(result));
  } catch (error) {
    // A rejected write carries the issues that name the fix; printing only
    // `API error 422: Settings configuration is invalid` would hide them.
    if (error instanceof RuntimeSettingsValidationError) {
      console.error(`Settings were not saved: ${error.message}`);
      for (const issue of error.errors) console.error(`  ${issue.path}: ${issue.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function settingsValidateCommand(opts: CliConnectionOptions & JsonOutputOption) {
  const client = createClient(opts);
  // The route validates whatever it is given as a complete document, so the stored document
  // is what answers "are the current settings valid?".
  const current = await client.settings.get();
  const result = await client.settings.validate(current.saved_config);
  if (opts.json) {
    printJson(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  console.log(`settings: ${result.valid ? 'valid' : 'invalid'}`);
  for (const issue of result.errors) console.log(`error  ${issue.path}: ${issue.message}`);
  for (const issue of result.warnings) console.log(`warning  ${issue.path}: ${issue.message}`);
  // The command succeeded either way, but an invalid document is what a caller script is
  // testing for, so it exits non-zero rather than making the caller parse the output.
  if (!result.valid) process.exitCode = 1;
}

function envReference(name: string): string {
  return `\${${name}}`;
}

export async function environmentsListCommand(opts: CliConnectionOptions & JsonOutputOption) {
  const result = await createClient(opts).environments.list();
  if (opts.json) {
    printJson(result.data);
    return;
  }
  if (result.data.length === 0) {
    console.log('No environments configured.');
    return;
  }
  for (const item of result.data) {
    console.log(formatEnvironment(item));
  }
}

export async function environmentInspectCommand(id: string, opts: CliConnectionOptions & JsonOutputOption) {
  const result = await createClient(opts).environments.get(id);
  if (opts.json) {
    printJson(result);
    return;
  }
  console.log(formatEnvironment(result));
  console.log(`config: ${JSON.stringify(result.config, null, 2)}`);
}

export async function environmentCreateCommand(opts: EnvironmentCreateOptions) {
  const config = parseConfigJson(opts.configJson);
  const result = await createClient(opts).environments.create({
    name: requiredString(opts.name, 'name'),
    description: opts.description,
    hosting_type: opts.hostingType,
    sandbox_provider: opts.sandboxProvider,
    config,
  });
  if (opts.json) {
    printJson(result);
    return;
  }
  console.log(`Created environment: ${formatEnvironment(result)}`);
}

export async function environmentUpdateCommand(id: string, opts: EnvironmentUpdateOptions) {
  const config = parseConfigJson(opts.configJson);
  const result = await createClient(opts).environments.update(id, {
    name: opts.name,
    description: opts.description,
    hosting_type: opts.hostingType,
    sandbox_provider: opts.sandboxProvider,
    config,
  });
  if (opts.json) {
    printJson(result);
    return;
  }
  console.log(`Updated environment: ${formatEnvironment(result)}`);
}

export async function environmentArchiveCommand(id: string, opts: CliConnectionOptions & JsonOutputOption) {
  const result = await createClient(opts).environments.archive(id);
  if (opts.json) {
    printJson(result);
    return;
  }
  console.log(`Archived environment: ${result.id} (${result.name})`);
}

export async function environmentWorkerKeysCommand(id: string, opts: CliConnectionOptions & JsonOutputOption) {
  const result = await createClient(opts).environments.workerKeys(id);
  if (opts.json) {
    printJson(result.data);
    return;
  }
  if (result.data.length === 0) {
    console.log('No worker keys for this environment.');
    return;
  }
  for (const key of result.data) {
    console.log(`${key.id}  ${key.status}  ${key.name}  ${key.key_prefix}`);
  }
}

function createClient(opts: CliConnectionOptions) {
  return new ManagedAgentsClient({
    baseUrl: `http://localhost:${opts.port}`,
    apiKey: opts.apiKey,
  });
}

function parseConfigJson(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    // Name the option. The parser's own message is kept because it says where the typo is,
    // but on its own it reads like a server fault rather than a mistake in one flag.
    throw new Error(`--config-json must be valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--config-json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: string | undefined, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${name} is required`);
}

/**
 * Render the settings document the routes actually return.
 *
 * This previously printed `model_provider`, `loop_engine.implemented`, `storage.metadata.type`,
 * `sandbox.available` and `validation.status` — fields read from a type no route produces, so
 * the command threw `Cannot read properties of undefined (reading 'metadata')` before printing
 * anything. The lines below are the routes' own fields, and `saved` is shown alongside
 * `effective` because a saved change is not in use until the runtime restarts.
 */
function formatSettings(settings: RuntimeSettingsSummary): string {
  const saved = settings.saved_config;
  const effective = settings.effective_config;
  const modelKey = settings.secret_states.model?.api_key ?? 'not_set';
  return [
    `revision: ${settings.revision}  effective_revision: ${settings.effective_revision}  restart_required=${settings.restart_required}`,
    `activation: ${settings.activation_status}${settings.activation_errors.length > 0 ? `  errors=${settings.activation_errors.length}` : ''}`,
    `model: ${saved.model.vendor}  api_key=${modelKey}  base_url=${saved.model.base_url ?? '-'}  (effective: ${effective.model.vendor})`,
    `loop_engine: ${saved.loop_engine.provider}  (effective: ${effective.loop_engine.provider})`,
    `metadata: ${saved.storage.metadata.provider}  (effective: ${effective.storage.metadata.provider})`,
    `artifacts: ${saved.storage.artifacts.provider}  (effective: ${effective.storage.artifacts.provider})`,
    `memory: ${saved.memory.provider}  enabled=${saved.memory.enabled}  (effective: ${effective.memory.provider})`,
    `sandbox: ${saved.sandbox.provider}  (effective: ${effective.sandbox.provider})`,
  ].join('\n');
}

function formatEnvironment(item: EnvironmentSummary): string {
  const type = typeof item.config.type === 'string' ? item.config.type : '-';
  return `${item.id}  ${item.name}  ${type}  sandbox=${item.effective_sandbox_provider ?? '-'}  status=${item.archived_at ? 'archived' : 'active'}`;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
