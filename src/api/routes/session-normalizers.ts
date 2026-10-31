import type { ServerDeps } from '../server.js';
import type { ContentBlock } from '@/types/cma-protocol.js';
import type { AgentOverrides } from '@/types/agent.js';
import { AGENT_OVERRIDE_TYPE, parseAgentOverrides } from '@/core/agent/overrides.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveFileMountPath } from '@/core/session/file-mount-path.js';
import {
  checkMemoryInstructions,
  defaultMemoryMountPath,
  MAX_MEMORY_STORES_PER_SESSION,
} from '@/core/memory/semantics.js';
import {
  normalizeRepoMountPath,
  parseCheckout,
  parseGithubRepositoryUrl,
} from '@/core/resources/github-repository.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** The published bound: at most 500 file resources attached per session. */
const MAX_FILE_RESOURCES_PER_SESSION = 500;

export function normalizeMessageContent(content: unknown): ContentBlock[] | null {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content) && content.every((block) => block && typeof block === 'object')) {
    return content as ContentBlock[];
  }
  return null;
}

/**
 * What is wrong with a client-supplied content-block tree, or `null` when no
 * `redacted` block appears anywhere in it.
 *
 * `redacted` is a runtime output — the placeholder the published contract uses
 * for content withheld by model policy — so a client that sends one is asking
 * the log to claim the model withheld content it never produced. The scan
 * recurses into `tool_result` children because a result carried on
 * `user.custom_tool_result` / `user.tool_result` is the same ingress boundary.
 */
export function redactedBlockProblem(content: unknown, field = 'content'): string | null {
  if (!Array.isArray(content)) return null;
  for (const [index, block] of content.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'redacted') {
      return `${field}[${index}].type "redacted" marks content withheld by the model and cannot be sent`;
    }
    const nested = redactedBlockProblem(record.content, `${field}[${index}].content`);
    if (nested) return nested;
  }
  return null;
}

/**
 * The three shapes the published contract accepts for `agent`.
 *
 * - `id` (string) — the agent's current version;
 * - `type: "agent"` + optional `version` — a pinned version;
 * - `type: "agent_with_overrides"` — a pinned or current version with part of
 *   its configuration replaced for this session only.
 *
 * The override form carries its parsed overrides rather than the raw body, so
 * every consumer downstream works from validated values.
 */
export type AgentRef =
  | { kind: 'current'; id: string }
  | { kind: 'pinned'; id: string; version: number }
  | { kind: 'overrides'; id: string; version?: number; overrides: AgentOverrides };

export type AgentRefResult =
  | { ok: true; ref: AgentRef }
  | { ok: false; code: string; message: string };

/**
 * Normalize the `agent` reference.
 *
 * An absent `agent` is a different client mistake from a malformed one, and the
 * two are told apart: a caller fixing "required field missing" and a caller
 * fixing "malformed reference" need different answers. Every refusal carries a
 * code, because the override form adds enough ways to be wrong that a code-less
 * 400 would leave the caller guessing which part of the object to change.
 */
export function normalizeAgentRef(value: unknown): AgentRefResult {
  if (value === undefined || value === null) {
    return { ok: false, code: 'agent_required', message: 'agent field is required' };
  }
  if (typeof value === 'string') {
    if (value.length === 0) return agentRefError('agent must be a non-empty agent id');
    return { ok: true, ref: { kind: 'current', id: value } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return agentRefError('agent must be an agent id string or an agent object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return agentRefError('agent.id is required');
  }
  const version = typeof record.version === 'number' && Number.isInteger(record.version) && record.version > 0
    ? record.version
    : undefined;
  if (record.version !== undefined && version === undefined) {
    return agentRefError('agent.version must be a positive integer');
  }

  if (record.type === AGENT_OVERRIDE_TYPE) {
    const parsed = parseAgentOverrides(record);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
    return {
      ok: true,
      ref: { kind: 'overrides', id: record.id, ...(version !== undefined ? { version } : {}), overrides: parsed.overrides },
    };
  }
  if (record.type !== undefined && record.type !== 'agent') {
    return agentRefError('agent.type must be "agent" or "agent_with_overrides"');
  }
  return {
    ok: true,
    ref: version !== undefined ? { kind: 'pinned', id: record.id, version } : { kind: 'current', id: record.id },
  };
}

function agentRefError(message: string): AgentRefResult {
  return { ok: false, code: 'invalid_agent_ref', message };
}


export function normalizeEnvironmentId(deps: ServerDeps, value: unknown): ValidationResult<string> {
  const id = typeof value === 'string' && value.trim() ? value.trim() : 'env_default';
  const row = deps.db.prepare('SELECT id FROM environments WHERE id = ? AND archived_at IS NULL').get(id);
  if (!row) return { ok: false, message: `Environment not found: ${id}` };
  return { ok: true, value: id };
}

export function normalizeVaultIds(deps: ServerDeps, value: unknown): ValidationResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'vault_ids must be an array' };
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id = readString(item);
    if (!id) return { ok: false, message: `vault_ids[${index}] must be a credential vault id` };
    if (!ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    const row = deps.db.prepare('SELECT id FROM credential_vaults WHERE id = ? AND archived_at IS NULL').get(id);
    if (!row) return { ok: false, message: `Credential vault not found: ${id}` };
  }
  return { ok: true, value: ids };
}

export function normalizeResources(deps: ServerDeps, value: unknown): ValidationResult<Array<Record<string, unknown>>> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'resources must be an array' };

  const resources: Array<Record<string, unknown>> = [];
  let memoryStoreCount = 0;
  let fileCount = 0;
  const memoryMounts = new Set<string>();
  for (const [index, resource] of value.entries()) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      return { ok: false, message: `resources[${index}] must be an object` };
    }
    if ((resource as Record<string, unknown>).type === 'memory_store') memoryStoreCount += 1;
    if (memoryStoreCount > MAX_MEMORY_STORES_PER_SESSION) {
      return { ok: false, message: `A session may attach at most ${MAX_MEMORY_STORES_PER_SESSION} memory stores` };
    }
    // The published bound is 500 files per session: `file` resources are the
    // file attachments, so the counter keys on that type alone — a memory
    // store or a github repository does not draw it down.
    if ((resource as Record<string, unknown>).type === 'file') fileCount += 1;
    if (fileCount > MAX_FILE_RESOURCES_PER_SESSION) {
      return { ok: false, message: `A session may attach at most ${MAX_FILE_RESOURCES_PER_SESSION} file resources` };
    }
    const normalized = normalizeSessionResource(deps, resource as Record<string, unknown>, index);
    if (!normalized.ok) return normalized;
    if (normalized.value.type === 'memory_store') {
      const mountPath = normalized.value.mount_path as string;
      if (memoryMounts.has(mountPath)) return { ok: false, message: `resources[${index}].mount_path duplicates ${mountPath}` };
      memoryMounts.add(mountPath);
    }
    resources.push(normalized.value);
  }
  return { ok: true, value: resources };
}

export function memoryScopeFromResources(resources: Array<Record<string, unknown>>): string | undefined {
  const memoryStore = resources.find((resource) => resource.type === 'memory_store');
  return typeof memoryStore?.memory_store_id === 'string' ? memoryStore.memory_store_id : undefined;
}

function normalizeSessionResource(deps: ServerDeps, resource: Record<string, unknown>, index: number): ValidationResult<Record<string, unknown>> {
  switch (resource.type) {
    case 'file':
      return normalizeFileResource(deps, resource, index);
    case 'github_repository':
      return normalizeGithubRepositoryResource(deps, resource, index);
    case 'memory_store':
      return normalizeMemoryStoreResource(deps, resource, index);
    default:
      return { ok: false, message: `resources[${index}].type must be file, github_repository, or memory_store` };
  }
}

export function normalizeFileResource(deps: ServerDeps, resource: Record<string, unknown>, index: number): ValidationResult<Record<string, unknown>> {
  const fileId = readString(resource.file_id);
  if (!fileId?.startsWith('file_')) return { ok: false, message: `resources[${index}].file_id is required` };
  // `mount_path` is a logical path inside the session, not an internal sandbox
  // path. The mapping to the mount root happens here, so a caller never has to
  // know the sandbox layout and a traversal attempt cannot be made to look
  // valid by carrying the internal prefix.
  const mount = resolveFileMountPath(readString(resource.mount_path), fileId);
  if (!mount.ok || !mount.mountPath) {
    return { ok: false, message: `resources[${index}].mount_path ${mount.message ?? 'is invalid'}` };
  }
  const row = deps.db.prepare("SELECT id FROM files WHERE id = ? AND role = 'file' AND archived_at IS NULL").get(fileId);
  if (!row) return { ok: false, message: `File not found: ${fileId}` };
  return { ok: true, value: { type: 'file', file_id: fileId, mount_path: mount.mountPath } };
}

export function normalizeGithubRepositoryResource(deps: ServerDeps, resource: Record<string, unknown>, index: number): ValidationResult<Record<string, unknown>> {
  const rawUrl = readString(resource.url);
  const authorizationToken = readString(resource.authorization_token);
  if (!rawUrl) return { ok: false, message: `resources[${index}].url is required` };
  if (!authorizationToken) return { ok: false, message: `resources[${index}].authorization_token is required` };

  // The URL is the mount's identity: a URL that does not resolve to exactly
  // `https://github.com/<owner>/<repo>` would mount something other than what
  // the caller named, and repository skills from it would enter the agent's
  // trusted instruction boundary unreviewed.
  const parsedUrl = parseGithubRepositoryUrl(rawUrl);
  if (!parsedUrl.ok) return { ok: false, message: `resources[${index}].${parsedUrl.message}` };

  const checkout = parseCheckout(resource.checkout);
  if (!checkout.ok) return { ok: false, message: `resources[${index}].${checkout.message}` };

  const mountPath = normalizeRepoMountPath(resource.mount_path, parsedUrl.value.mountPath);
  if (!mountPath.ok) return { ok: false, message: `resources[${index}].${mountPath.message}` };

  return {
    ok: true,
    value: {
      type: 'github_repository',
      url: parsedUrl.value.url,
      repository: parsedUrl.value.repository,
      mount_path: mountPath.value,
      ...(checkout.value ? { checkout: checkout.value } : {}),
      authorization_token: {
        type: 'encrypted_secret',
        ...encryptSecret(authorizationToken, deps.workspace?.dataDir),
      },
    },
  };
}

function normalizeMemoryStoreResource(deps: ServerDeps, resource: Record<string, unknown>, index: number): ValidationResult<Record<string, unknown>> {
  const memoryStoreId = readString(resource.memory_store_id);
  if (!memoryStoreId?.startsWith('memstore_')) return { ok: false, message: `resources[${index}].memory_store_id is required` };
  const row = deps.db.prepare('SELECT id, name FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(memoryStoreId) as { id: string; name: string } | undefined;
  if (!row) return { ok: false, message: `Memory store not found: ${memoryStoreId}` };

  const access = readString(resource.access);
  if (access && access !== 'read_write' && access !== 'read_only') {
    return { ok: false, message: `resources[${index}].access must be read_write or read_only` };
  }
  const rawMountPath = readString(resource.mount_path);
  const mountPath = rawMountPath ? normalizeMemoryMountPath(rawMountPath) : defaultMemoryMountPath(row.name);
  if (!mountPath) return { ok: false, message: `resources[${index}].mount_path is invalid` };
  const instructions = readString(resource.instructions);
  const instructionsCheck = checkMemoryInstructions(instructions);
  if (!instructionsCheck.ok) {
    return { ok: false, message: `resources[${index}].instructions ${instructionsCheck.message}` };
  }
  return {
    ok: true,
    value: {
      type: 'memory_store',
      memory_store_id: memoryStoreId,
      mount_path: mountPath,
      ...(access ? { access } : {}),
      ...(instructions ? { instructions } : {}),
    },
  };
}

function normalizeMemoryMountPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(new RegExp('/+', 'g'), '/').replace(new RegExp('/+$'), '');
  if (!normalized.startsWith('/') || normalized === '/' || normalized.includes('\0')) return undefined;
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return normalized;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
