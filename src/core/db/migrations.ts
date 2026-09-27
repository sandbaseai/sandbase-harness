/**
 * Database Migrations (embedded)
 *
 * Migrations are embedded as TypeScript string constants rather than loaded
 * from .sql files at runtime. This ensures they survive bundling (tsup emits
 * a single dist/index.js — external .sql files would not be found) and works
 * identically in dev, tests, and the shipped binary.
 *
 * To add a migration: append a new entry with the next version number.
 * Migrations run in ascending version order, each exactly once (tracked in
 * the _migrations table).
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M001_INITIAL = `
-- Agent runtime state (cached from YAML)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Environment definitions
CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session state machine
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT,
  context_id TEXT,
  metadata TEXT,
  sandbox_type TEXT,
  sandbox_state TEXT,
  usage_tokens_in INTEGER DEFAULT 0,
  usage_tokens_out INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (environment_id) REFERENCES environments(id)
);

CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_context ON sessions(context_id);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);

-- Event Log (append-only)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  model_used TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  stop_reason TEXT,
  duration_ms INTEGER,
  parent_event_id TEXT,
  delegation_depth INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_events_session_seq ON events(session_id, seq);
CREATE INDEX idx_events_session_time ON events(session_id, created_at);
CREATE INDEX idx_events_type ON events(session_id, type);

-- Context compaction boundaries
CREATE TABLE compaction_boundaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_id_before TEXT NOT NULL,
  tokens_before INTEGER NOT NULL,
  tokens_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Model registry (cached from config)
CREATE TABLE models (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  base_url TEXT,
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workspace snapshots (optional feature)
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

const M002_MEMORY = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_memories_context ON memories(context_id);
`;

const M003_WORK_ITEMS = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  claimed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_work_items_status ON work_items(status, created_at);
CREATE INDEX idx_work_items_session ON work_items(session_id);
`;

const M004_CONSOLE_RESOURCES = `
ALTER TABLE environments ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE environments ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE environments ADD COLUMN updated_at TEXT;
ALTER TABLE environments ADD COLUMN archived_at TEXT;
UPDATE environments SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE sessions ADD COLUMN resources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN vault_ids TEXT NOT NULL DEFAULT '[]';

CREATE TABLE credential_vaults (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE TABLE memory_stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'sqlite',
  status TEXT NOT NULL DEFAULT 'active',
  config TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
`;

const M005_AGENT_VERSIONING = `
ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN archived_at TEXT;
`;

const M006_CREDENTIAL_RECORDS = `
CREATE TABLE credential_records (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL,
  mcp_server_url TEXT,
  variable_name TEXT,
  value_hint TEXT NOT NULL DEFAULT '',
  network TEXT NOT NULL DEFAULT '{}',
  injection_locations TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (vault_id) REFERENCES credential_vaults(id)
);

CREATE INDEX idx_credential_records_vault ON credential_records(vault_id, created_at DESC);
CREATE INDEX idx_credential_records_status ON credential_records(status, created_at DESC);
`;

const M007_MEMORY_RECORDS = `
CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (store_id) REFERENCES memory_stores(id),
  UNIQUE (store_id, path)
);

CREATE INDEX idx_memory_records_store ON memory_records(store_id, path);
CREATE INDEX idx_memory_records_updated ON memory_records(store_id, updated_at DESC);
`;

const M008_CREDENTIAL_SECRET_STORAGE = `
ALTER TABLE credential_records ADD COLUMN secret_ciphertext TEXT NOT NULL DEFAULT '';
ALTER TABLE credential_records ADD COLUMN secret_nonce TEXT NOT NULL DEFAULT '';
ALTER TABLE credential_records ADD COLUMN secret_tag TEXT NOT NULL DEFAULT '';
`;

const M009_MEMORY_ACTIVE_PATH_INDEX = `
CREATE TABLE memory_records_next (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (store_id) REFERENCES memory_stores(id)
);

INSERT INTO memory_records_next (
  id, store_id, path, content, metadata, created_at, updated_at, archived_at
)
SELECT id, store_id, path, content, metadata, created_at, updated_at, archived_at
FROM memory_records;

DROP TABLE memory_records;
ALTER TABLE memory_records_next RENAME TO memory_records;

CREATE INDEX idx_memory_records_store ON memory_records(store_id, path);
CREATE INDEX idx_memory_records_updated ON memory_records(store_id, updated_at DESC);
CREATE UNIQUE INDEX idx_memory_records_active_path
  ON memory_records(store_id, path)
  WHERE archived_at IS NULL;
`;

const M010_FILE_RESOURCES = `
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX idx_files_status_created ON files(status, created_at DESC);
`;

const M011_SKILL_RESOURCES = `
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_title TEXT,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  file TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'custom',
  latest_version TEXT,
  versions TEXT NOT NULL DEFAULT '[]',
  storage_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX idx_skills_source_updated ON skills(source, updated_at DESC);
CREATE UNIQUE INDEX idx_skills_active_name
  ON skills(name)
  WHERE archived_at IS NULL;
`;

const M012_API_KEYS = `
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  archived_at TEXT
);

CREATE INDEX idx_api_keys_status_created ON api_keys(status, created_at DESC);
`;

const M013_STANDARD_OBJECT_IDS = `
CREATE TABLE agents_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT
);

INSERT INTO agents_next (
  id, name, definition, status, error_message, loaded_at, updated_at, version, archived_at
)
SELECT id, name, definition, status, error_message, loaded_at, updated_at, version, archived_at
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_next RENAME TO agents;
CREATE INDEX idx_agents_status_loaded ON agents(status, loaded_at ASC);

CREATE TABLE memory_stores_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'sqlite',
  status TEXT NOT NULL DEFAULT 'active',
  config TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

INSERT INTO memory_stores_next (
  id, name, description, provider, status, config, metadata, created_at, updated_at, archived_at
)
SELECT id, name, description, provider, status, config, metadata, created_at, updated_at, archived_at
FROM memory_stores;

DROP TABLE memory_stores;
ALTER TABLE memory_stores_next RENAME TO memory_stores;
CREATE INDEX idx_memory_stores_status_created ON memory_stores(status, created_at DESC);
`;

const M014_ENVIRONMENT_OBJECT_IDS = `
CREATE TABLE environments_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT,
  archived_at TEXT
);

INSERT INTO environments_next (
  id, name, config, created_at, description, metadata, updated_at, archived_at
)
SELECT id, name, config, created_at, description, metadata, updated_at, archived_at
FROM environments;

DROP TABLE environments;
ALTER TABLE environments_next RENAME TO environments;
CREATE INDEX idx_environments_status_created ON environments(archived_at, created_at DESC);
`;

const M015_CREDENTIAL_VAULT_OBJECT_IDS = `
CREATE TABLE credential_vaults_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

INSERT INTO credential_vaults_next (
  id, name, description, status, metadata, created_at, updated_at, archived_at
)
SELECT id, name, description, status, metadata, created_at, updated_at, archived_at
FROM credential_vaults;

DROP TABLE credential_vaults;
ALTER TABLE credential_vaults_next RENAME TO credential_vaults;
CREATE INDEX idx_credential_vaults_status_created ON credential_vaults(status, created_at DESC);
`;

const M016_MODEL_PROVIDER_SETTINGS = `
ALTER TABLE models ADD COLUMN api_key TEXT;
ALTER TABLE models ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN updated_at TEXT;

UPDATE models
SET updated_at = created_at
WHERE updated_at IS NULL;

UPDATE models
SET is_default = 1
WHERE name = (
  SELECT name FROM models ORDER BY created_at ASC LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM models WHERE is_default = 1
);

CREATE UNIQUE INDEX idx_models_default
  ON models(is_default)
  WHERE is_default = 1;
`;

const M017_MEMORY_PROVIDER_SETTINGS = `
CREATE TABLE memory_providers (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_url TEXT,
  api_key TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memory_providers (
  name, provider, connection_url, api_key, config, is_default, status, created_at, updated_at
)
VALUES (
  'local-sqlite', 'sqlite', NULL, NULL, '{}', 1, 'active', datetime('now'), datetime('now')
);

CREATE UNIQUE INDEX idx_memory_providers_default
  ON memory_providers(is_default)
  WHERE is_default = 1;
`;

const M018_STORAGE_PROVIDER_SETTINGS = `
CREATE TABLE storage_providers (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_url TEXT,
  bucket TEXT,
  region TEXT,
  base_path TEXT,
  access_key TEXT,
  secret_key TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  initialized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO storage_providers (
  name, role, provider, connection_url, bucket, region, base_path, access_key, secret_key,
  config, is_default, status, initialized_at, created_at, updated_at
)
VALUES
  (
    'metadata-sqlite', 'metadata', 'sqlite', NULL, NULL, NULL, NULL, NULL, NULL,
    '{}', 1, 'active', datetime('now'), datetime('now'), datetime('now')
  ),
  (
    'local-artifacts', 'artifact', 'local_filesystem', NULL, NULL, NULL, 'files', NULL, NULL,
    '{}', 1, 'active', datetime('now'), datetime('now'), datetime('now')
  );

CREATE UNIQUE INDEX idx_storage_providers_default_role
  ON storage_providers(role, is_default)
  WHERE is_default = 1;

CREATE INDEX idx_storage_providers_role
  ON storage_providers(role, created_at DESC);
`;

const M019_RUNTIME_SETTINGS = `
CREATE TABLE runtime_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  schema_version INTEGER NOT NULL,
  config TEXT NOT NULL,
  effective_config TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  effective_revision INTEGER NOT NULL DEFAULT 1,
  restart_required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const M020_RUNTIME_SETTINGS_SECRETS = `
CREATE TABLE runtime_settings_secrets (
  path TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const M021_RUNTIME_SETTINGS_ACTIVATION_STATE = `
ALTER TABLE runtime_settings ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE runtime_settings ADD COLUMN activation_errors TEXT NOT NULL DEFAULT '[]';
`;

const M022_FILE_ARTIFACT_METADATA = `
ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'file';
ALTER TABLE files ADD COLUMN session_id TEXT;
ALTER TABLE files ADD COLUMN artifact_path TEXT;

CREATE INDEX idx_files_role_session ON files(role, session_id, created_at DESC);
`;

const M023_OPERATIONS_RESOURCES = `
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX idx_webhooks_status_created ON webhooks(status, created_at DESC);

CREATE TABLE scheduled_deployments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  environment_id TEXT,
  cron TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  last_run_at TEXT,
  next_run_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX idx_scheduled_deployments_status_created ON scheduled_deployments(status, created_at DESC);
CREATE INDEX idx_scheduled_deployments_agent ON scheduled_deployments(agent_id, created_at DESC);

CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX idx_outcomes_status_created ON outcomes(status, created_at DESC);

CREATE TABLE session_outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  outcome_id TEXT,
  status TEXT NOT NULL,
  score REAL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);

CREATE INDEX idx_session_outcomes_session_created ON session_outcomes(session_id, created_at DESC);
CREATE INDEX idx_session_outcomes_outcome ON session_outcomes(outcome_id, created_at DESC);
`;

const M024_OPERATIONS_RUN_HISTORY = `
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  status_code INTEGER,
  error TEXT,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
);

CREATE INDEX idx_webhook_deliveries_webhook_created ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, created_at DESC);

CREATE TABLE scheduled_deployment_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (schedule_id) REFERENCES scheduled_deployments(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_scheduled_deployment_runs_schedule_created ON scheduled_deployment_runs(schedule_id, started_at DESC);
CREATE INDEX idx_scheduled_deployment_runs_session ON scheduled_deployment_runs(session_id);
`;

const M025_AGENT_VERSION_SNAPSHOTS = `
CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE UNIQUE INDEX idx_agent_versions_agent_version ON agent_versions(agent_id, version);
CREATE INDEX idx_agent_versions_agent_created ON agent_versions(agent_id, created_at DESC);

INSERT INTO agent_versions (id, agent_id, version, name, definition, created_at)
SELECT 'agver_' || id || '_' || COALESCE(version, 1),
       id,
       COALESCE(version, 1),
       name,
       definition,
       COALESCE(updated_at, loaded_at, datetime('now'))
FROM agents
WHERE definition IS NOT NULL;
`;

const M026_SESSION_AGENT_SNAPSHOTS = `
ALTER TABLE sessions ADD COLUMN agent_version INTEGER;
ALTER TABLE sessions ADD COLUMN agent_definition TEXT;
`;

const M027_ENVIRONMENT_WORKERS = `
CREATE TABLE environment_worker_keys (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (environment_id) REFERENCES environments(id)
);

CREATE INDEX idx_environment_worker_keys_environment
  ON environment_worker_keys(environment_id, status, created_at DESC);

CREATE INDEX idx_environment_worker_keys_status
  ON environment_worker_keys(status, created_at DESC);
`;

const M028_CREDENTIAL_AUDIT = `
CREATE TABLE credential_audit_events (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vault_id) REFERENCES credential_vaults(id),
  FOREIGN KEY (credential_id) REFERENCES credential_records(id)
);

CREATE INDEX idx_credential_audit_credential_created
  ON credential_audit_events(credential_id, created_at DESC);

CREATE INDEX idx_credential_audit_vault_created
  ON credential_audit_events(vault_id, created_at DESC);
`;

const M029_WEBHOOK_RETRIES = `
ALTER TABLE webhook_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN next_retry_at TEXT;

CREATE INDEX idx_webhook_deliveries_next_retry
  ON webhook_deliveries(status, next_retry_at);
`;

/** Preserves immutable confirmation and lifecycle metadata with each event. */
const M030_EVENT_METADATA = `
ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
`;

/** Freezes the selected loop engine for every durable session. */
const M031_SESSION_LOOP_ENGINE = `
ALTER TABLE sessions ADD COLUMN loop_engine TEXT NOT NULL DEFAULT 'builtin';
`;

const M032_PI_SESSION_STATE = `
CREATE TABLE pi_session_state (
  session_id TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  pi_session_id TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  continuity_notice TEXT,
  last_turn_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

const M033_SESSION_RESOURCE_INSTANCES = `
CREATE TABLE session_resource_instances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  mount_path TEXT,
  /** Cleartext-safe projection of the resource, with secrets encrypted. */
  config TEXT NOT NULL,
  /** Encrypted-only fields, kept separate so a projection cannot leak them. */
  secret TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_session_resource_instances_session
  ON session_resource_instances(session_id, position);
CREATE UNIQUE INDEX idx_session_resource_instances_live
  ON session_resource_instances(session_id, position)
  WHERE deleted_at IS NULL;
`;

const M034_MEMORY_VERSIONS = `
CREATE TABLE memory_versions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  content_size_bytes INTEGER NOT NULL,
  change TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (store_id) REFERENCES memory_stores(id)
);

CREATE INDEX idx_memory_versions_memory
  ON memory_versions(store_id, memory_id, version DESC);
CREATE UNIQUE INDEX idx_memory_versions_unique
  ON memory_versions(store_id, memory_id, version);
`;

/**
 * The session budget.
 *
 * Stored as JSON in one nullable column rather than as amount/currency columns
 * because the value is a published wire object that is echoed back verbatim, and
 * because `NULL` is needed for a third state: a session that had a budget and
 * had it removed. An absent row value means "never had one", which the contract
 * treats differently from "removed".
 */
const M035_SESSION_BUDGET = `
ALTER TABLE sessions ADD COLUMN budget TEXT;
`;

/**
 * Persist handoff bundles so a bundle can be handed out by id rather than
 * rebuilt on every read. The payload is stored whole and immutably: a bundle is
 * evidence of one session at one moment, so re-deriving it on read would let
 * later session activity silently change a bundle someone already received.
 *
 * `payload_sha256` is denormalized out of the payload so a listing can show the
 * integrity digest without parsing every bundle.
 */
const M036_HANDOFF_BUNDLES = `
CREATE TABLE handoff_bundles (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  label TEXT,
  schema_version TEXT NOT NULL,
  replay_mode TEXT NOT NULL,
  includes_message_content INTEGER NOT NULL DEFAULT 0,
  includes_file_content INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  signature_key_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_handoff_bundles_session ON handoff_bundles(session_id, created_at DESC);
CREATE INDEX idx_handoff_bundles_created ON handoff_bundles(created_at DESC, id);
`;

/**
 * The IANA zone a schedule's cron is evaluated in.
 *
 * `cron.ts` has always done the wall-clock arithmetic in a zone and
 * `scheduler.ts` has always read one off the row, but nothing could put one
 * there: the field was not read from a request and no column held it, so every
 * schedule silently ran in UTC. `NOT NULL DEFAULT 'UTC'` makes the default the
 * same one the runner applies, and an existing row reads as UTC.
 */
const M037_SCHEDULED_TIMEZONE = `
ALTER TABLE scheduled_deployments ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
`;

/**
 * Per-endpoint webhook signing secrets.
 *
 * Nullable by design: a subscription written before this migration has no stored
 * secret and keeps the legacy derivation, so upgrading does not silently
 * invalidate a receiver that is verifying today. The three columns match the
 * shape `credential-vaults` already stores its secrets in.
 */
const M038_WEBHOOK_SIGNING_SECRETS = `
ALTER TABLE webhooks ADD COLUMN secret_ciphertext TEXT;
ALTER TABLE webhooks ADD COLUMN secret_nonce TEXT;
ALTER TABLE webhooks ADD COLUMN secret_tag TEXT;
`;

/**
 * The previous webhook signing secret, for a rotation window.
 *
 * Nullable: a subscription that has never been rotated has no previous secret,
 * and retiring one clears these columns rather than the current secret. The
 * three columns mirror the shape `M038` established for the current secret.
 */
const M039_WEBHOOK_PREVIOUS_SECRET = `
ALTER TABLE webhooks ADD COLUMN secret_previous_ciphertext TEXT;
ALTER TABLE webhooks ADD COLUMN secret_previous_nonce TEXT;
ALTER TABLE webhooks ADD COLUMN secret_previous_tag TEXT;
`;

/**
 * Durable pending-interaction records for the Pi tool gate.
 *
 * A table is used rather than event metadata because a decision can have no user
 * event to hang off: when a platform-owned rule decides, writing that as a
 * `user.*` event would present an automatic decision as a human click. The event
 * log also cannot express the one-shot guarantee, while `decision IS NULL` in a
 * conditional update can.
 *
 * `ON DELETE CASCADE` is explicit so physically deleting a session cannot fail
 * on this foreign key.
 */
const M040_PI_TOOL_INTERACTIONS = `
CREATE TABLE pi_tool_interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  pi_request_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  original_input TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  decision TEXT,
  decision_source TEXT,
  decided_input TEXT,
  deny_message TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_pi_tool_interactions_use ON pi_tool_interactions(session_id, tool_use_id);
CREATE INDEX idx_pi_tool_interactions_request ON pi_tool_interactions(session_id, pi_request_id);
`;

/**
 * The contract a Pi session ran under, so a resume can prove it is continuing it.
 *
 * `pi_session_state` already proves *which* Pi conversation a managed session
 * file holds; on its own it says nothing about the work directory the turns ran
 * in or the tool policy, model, and approval mode they ran under. Both columns
 * are nullable on purpose: a row written before this migration has no recorded
 * binding, and the resume path compares only a value that was recorded, so an
 * upgrade neither blocks a live session nor invents a contract for one.
 */
const M041_PI_SESSION_POLICY_BINDING = `
ALTER TABLE pi_session_state ADD COLUMN policy_fingerprint TEXT;
ALTER TABLE pi_session_state ADD COLUMN work_dir TEXT;
`;

/**
 * Why a scheduled deployment is paused, on the row that is paused.
 *
 * `status` already carries `paused`, so the column is not needed to know *that* a
 * deployment is paused. It is needed to know *why*, and the published contract
 * makes that a read field: `paused_reason` is `{"type": "manual"}` when a person
 * paused it and is cleared when they resume it. The contract also defines a
 * second kind — an automatic pause after a non-recoverable trigger failure, whose
 * reason carries the failed run's `error.type` — and a single `status` column
 * cannot tell the two apart, so an operator could not tell an intentional pause
 * from a broken deployment.
 *
 * Nullable, with no default: a row written before this migration has no recorded
 * reason, and the projection reports `null` for it rather than inventing
 * `{"type": "manual"}`. That is the same choice `M037` and `M041` made, and for
 * the same reason — an upgrade must not claim a fact it did not observe.
 *
 * This migration only ever records the manual reason. The automatic one needs the
 * failure taxonomy of the run path, so it arrives with that work rather than
 * being half-written here.
 */
const M042_SCHEDULED_PAUSED_REASON = `
ALTER TABLE scheduled_deployments ADD COLUMN paused_reason TEXT;
`;

/**
 * The published auto-disable rule reports *why* an endpoint was disabled, and the
 * reason is machine-readable, so it is stored rather than reconstructed from the
 * delivery history — the history only shows that attempts failed, not which rule
 * fired. Nullable because an endpoint that was never auto-disabled has no reason,
 * and the update route clears it when an operator re-enables the endpoint, so a
 * stored row never carries a reason for a state the endpoint is no longer in.
 */
const M043_WEBHOOK_DISABLED_REASON = `
ALTER TABLE webhooks ADD COLUMN disabled_reason TEXT;
`;

/**
 * The third published auto-disable case is triggered by the *duration* of uninterrupted
 * failure rather than by a delivery count, so the duration has to survive a restart: an
 * in-process counter would reset on every deploy and the rule would never fire in the
 * deployment it exists for. `NULL` means "not currently failing", which is also the state a
 * `2xx` restores.
 */
const M044_WEBHOOK_FAILING_SINCE = `
ALTER TABLE webhooks ADD COLUMN failing_since TEXT;
`;

/**
 * Stop marker for queued self-hosted work.
 *
 * A pending work item is a tool call the session asked for. When the session ends -
 * a user stop included - nothing is waiting for that call any more, and without a
 * persisted marker the item stays claimable forever: a worker would execute it on
 * the operator's machine after the conversation was over.
 *
 * The marker is deliberately a timestamp rather than a new `status` value. The
 * queue's status vocabulary is frozen to be replaced by the accepted/applied
 * lifecycle, and "must not be handed out" is a fact about the item that has to hold
 * whichever queue state it is in. Existing rows are left unmarked: a session that is
 * still running has not stopped its work, so an absent marker must read as "not
 * stopped" rather than as an unknown.
 */
const M045_WORK_ITEM_STOP = `
ALTER TABLE work_items ADD COLUMN stopped_at TEXT;
`;

/**
 * When a worker confirmed, at the moment of starting, that its claim was still live.
 *
 * `claimed_at` records that an item was handed out; it cannot record that anybody
 * committed to running it, and those are different facts with different consequences.
 * Without the second, a worker that claimed an item and died before starting it is
 * indistinguishable from one that claimed it and died mid-command - so the queue cannot
 * tell "provably no effect, safe to retry" from "effect unknown, never replay".
 *
 * Existing rows stay NULL, which reads as "held but never started". That is the honest
 * back-fill: a row claimed by an earlier build was never accepted, because there was no
 * accept step for it to have been accepted by.
 */
const M046_WORK_ITEM_ACCEPT = `
ALTER TABLE work_items ADD COLUMN accepted_at TEXT;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_initial', sql: M001_INITIAL },
  { version: 2, name: '002_memory', sql: M002_MEMORY },
  { version: 3, name: '003_work_items', sql: M003_WORK_ITEMS },
  { version: 4, name: '004_console_resources', sql: M004_CONSOLE_RESOURCES },
  { version: 5, name: '005_agent_versioning', sql: M005_AGENT_VERSIONING },
  { version: 6, name: '006_credential_records', sql: M006_CREDENTIAL_RECORDS },
  { version: 7, name: '007_memory_records', sql: M007_MEMORY_RECORDS },
  { version: 8, name: '008_credential_secret_storage', sql: M008_CREDENTIAL_SECRET_STORAGE },
  { version: 9, name: '009_memory_active_path_index', sql: M009_MEMORY_ACTIVE_PATH_INDEX },
  { version: 10, name: '010_file_resources', sql: M010_FILE_RESOURCES },
  { version: 11, name: '011_skill_resources', sql: M011_SKILL_RESOURCES },
  { version: 12, name: '012_api_keys', sql: M012_API_KEYS },
  { version: 13, name: '013_standard_object_ids', sql: M013_STANDARD_OBJECT_IDS },
  { version: 14, name: '014_environment_object_ids', sql: M014_ENVIRONMENT_OBJECT_IDS },
  { version: 15, name: '015_credential_vault_object_ids', sql: M015_CREDENTIAL_VAULT_OBJECT_IDS },
  { version: 16, name: '016_model_provider_settings', sql: M016_MODEL_PROVIDER_SETTINGS },
  { version: 17, name: '017_memory_provider_settings', sql: M017_MEMORY_PROVIDER_SETTINGS },
  { version: 18, name: '018_storage_provider_settings', sql: M018_STORAGE_PROVIDER_SETTINGS },
  { version: 19, name: '019_runtime_settings', sql: M019_RUNTIME_SETTINGS },
  { version: 20, name: '020_runtime_settings_secrets', sql: M020_RUNTIME_SETTINGS_SECRETS },
  { version: 21, name: '021_runtime_settings_activation_state', sql: M021_RUNTIME_SETTINGS_ACTIVATION_STATE },
  { version: 22, name: '022_file_artifact_metadata', sql: M022_FILE_ARTIFACT_METADATA },
  { version: 23, name: '023_operations_resources', sql: M023_OPERATIONS_RESOURCES },
  { version: 24, name: '024_operations_run_history', sql: M024_OPERATIONS_RUN_HISTORY },
  { version: 25, name: '025_agent_version_snapshots', sql: M025_AGENT_VERSION_SNAPSHOTS },
  { version: 26, name: '026_session_agent_snapshots', sql: M026_SESSION_AGENT_SNAPSHOTS },
  { version: 27, name: '027_environment_workers', sql: M027_ENVIRONMENT_WORKERS },
  { version: 28, name: '028_credential_audit', sql: M028_CREDENTIAL_AUDIT },
  { version: 29, name: '029_webhook_retries', sql: M029_WEBHOOK_RETRIES },
  { version: 30, name: '030_event_metadata', sql: M030_EVENT_METADATA },
  { version: 31, name: '031_session_loop_engine', sql: M031_SESSION_LOOP_ENGINE },
  { version: 32, name: '032_pi_session_state', sql: M032_PI_SESSION_STATE },
  { version: 33, name: '033_session_resource_instances', sql: M033_SESSION_RESOURCE_INSTANCES },
  { version: 34, name: '034_memory_versions', sql: M034_MEMORY_VERSIONS },
  { version: 35, name: '035_session_budget', sql: M035_SESSION_BUDGET },
  { version: 36, name: '036_handoff_bundles', sql: M036_HANDOFF_BUNDLES },
  { version: 37, name: '037_scheduled_timezone', sql: M037_SCHEDULED_TIMEZONE },
  { version: 38, name: '038_webhook_signing_secrets', sql: M038_WEBHOOK_SIGNING_SECRETS },
  { version: 39, name: '039_webhook_previous_secret', sql: M039_WEBHOOK_PREVIOUS_SECRET },
  { version: 40, name: '040_pi_tool_interactions', sql: M040_PI_TOOL_INTERACTIONS },
  { version: 41, name: '041_pi_session_policy_binding', sql: M041_PI_SESSION_POLICY_BINDING },
  { version: 42, name: '042_scheduled_paused_reason', sql: M042_SCHEDULED_PAUSED_REASON },
  { version: 43, name: '043_webhook_disabled_reason', sql: M043_WEBHOOK_DISABLED_REASON },
  { version: 44, name: '044_webhook_failing_since', sql: M044_WEBHOOK_FAILING_SINCE },
  { version: 45, name: '045_work_item_stop', sql: M045_WORK_ITEM_STOP },
  { version: 46, name: '046_work_item_accept', sql: M046_WORK_ITEM_ACCEPT },
];
