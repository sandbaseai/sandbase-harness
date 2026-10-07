/**
 * Environment worker keys (R9.14 self-hosted workers).
 *
 * A key scopes a self-hosted worker to one environment. Only the SHA-256 hash
 * is persisted; the raw `mawk_...` secret is returned once at creation and can
 * never be read back, matching the managed API key contract.
 *
 * Both the issuing routes (`/v1/environments/:id/worker-keys`) and the
 * consuming route (`POST /v1/x/worker/claim`) go through this module so the
 * hash, prefix, and status rules cannot drift apart.
 */
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';

export type EnvironmentWorkerKeyStatus = 'active' | 'revoked';

export interface EnvironmentWorkerKeyRecord {
  id: string;
  type: 'environment_worker_key';
  environment_id: string;
  name: string;
  status: EnvironmentWorkerKeyStatus;
  key_prefix: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreatedEnvironmentWorkerKeyRecord extends EnvironmentWorkerKeyRecord {
  /** Raw key. Present only on the creation response. */
  secret_key: string;
}

export interface CreateEnvironmentWorkerKeyInput {
  name: string;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

type EnvironmentWorkerKeyRow = {
  id: string;
  environment_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

export function listEnvironmentWorkerKeys(db: Database, environmentId: string): EnvironmentWorkerKeyRecord[] {
  const rows = db.prepare(
    `SELECT *
     FROM environment_worker_keys
     WHERE environment_id = ?
     ORDER BY created_at DESC, rowid DESC`,
  ).all(environmentId) as unknown as EnvironmentWorkerKeyRow[];
  return rows.map(toEnvironmentWorkerKeyRecord);
}

export function createEnvironmentWorkerKey(
  db: Database,
  environmentId: string,
  input: CreateEnvironmentWorkerKeyInput,
): CreatedEnvironmentWorkerKeyRecord {
  const secret = generateEnvironmentWorkerKeySecret();
  const id = `ewk_${nanoid(18)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO environment_worker_keys (
      id, environment_id, name, key_hash, key_prefix, status, metadata,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    environmentId,
    input.name.trim(),
    hashEnvironmentWorkerKey(secret),
    workerKeyPrefix(secret),
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
    input.expires_at ?? null,
  );
  const row = db.prepare('SELECT * FROM environment_worker_keys WHERE id = ?').get(id) as unknown as EnvironmentWorkerKeyRow;
  return { ...toEnvironmentWorkerKeyRecord(row), secret_key: secret };
}

export function revokeEnvironmentWorkerKey(
  db: Database,
  environmentId: string,
  keyId: string,
): EnvironmentWorkerKeyRecord | null {
  const existing = db.prepare(
    'SELECT * FROM environment_worker_keys WHERE id = ? AND environment_id = ?',
  ).get(keyId, environmentId) as EnvironmentWorkerKeyRow | undefined;
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE environment_worker_keys
     SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE id = ? AND environment_id = ?`,
  ).run(now, now, keyId, environmentId);
  const row = db.prepare('SELECT * FROM environment_worker_keys WHERE id = ?').get(keyId) as unknown as EnvironmentWorkerKeyRow;
  return toEnvironmentWorkerKeyRecord(row);
}

export type EnvironmentWorkerKeyValidation =
  | { ok: true; environmentId: string | undefined }
  | { ok: false; message: string };

/**
 * Validate the `environment_key` presented by a claiming worker.
 *
 * An absent key is accepted: the claim is then unscoped, which is the documented
 * behaviour for a runtime that has not issued worker keys yet.
 */
export function validateEnvironmentWorkerKey(
  db: Database,
  value: unknown,
): EnvironmentWorkerKeyValidation {
  if (value === undefined || value === null || value === '') return { ok: true, environmentId: undefined };
  if (typeof value !== 'string') return { ok: false, message: 'environment_key must be a string' };
  const row = db.prepare(
    `SELECT id, environment_id, expires_at
     FROM environment_worker_keys
     WHERE key_hash = ? AND status = 'active' AND revoked_at IS NULL`,
  ).get(hashEnvironmentWorkerKey(value)) as { id: string; environment_id: string; expires_at: string | null } | undefined;
  if (!row) return { ok: false, message: 'Invalid environment worker key' };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, message: 'Environment worker key has expired' };
  }
  db.prepare("UPDATE environment_worker_keys SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(row.id);
  return { ok: true, environmentId: row.environment_id };
}

function toEnvironmentWorkerKeyRecord(row: EnvironmentWorkerKeyRow): EnvironmentWorkerKeyRecord {
  return {
    id: row.id,
    type: 'environment_worker_key',
    environment_id: row.environment_id,
    name: row.name,
    status: row.revoked_at || row.status === 'revoked' ? 'revoked' : 'active',
    key_prefix: row.key_prefix,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at ?? null,
    expires_at: row.expires_at ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function generateEnvironmentWorkerKeySecret(): string {
  return `mawk_${randomBytes(32).toString('base64url')}`;
}

/**
 * SHA-256 is the right digest here, not a password hash: the input is a
 * 256-bit random bearer (`mawk_` + 32 random bytes), so brute force through
 * the hash is already 2^256 work and a slow KDF would only add latency to
 * every authenticated call.
 */
function hashEnvironmentWorkerKey(keyValue: string): string {
  return createHash('sha256').update(keyValue, 'utf8').digest('hex');
}

/**
 * Same shape as the managed API key prefix so an operator reading logs cannot
 * tell the two families apart by format alone; only the `mawk_`/`ma_` stem does.
 */
function workerKeyPrefix(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 14) return `${trimmed.slice(0, 4)}...`;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}`;
}
