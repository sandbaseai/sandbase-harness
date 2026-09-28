/**
 * Session resource instances (CMA `/v1/sessions/:id/resources`).
 *
 * A session resource is a first-class object with its own ID, not a JSON blob
 * inside the session row. The published contract makes that distinction
 * load-bearing: file resources are added and removed while a session runs,
 * each add returns a `sesrsc_...` ID, and a GitHub resource's ID is what a
 * token rotation addresses. Treating `session.resources` JSON as the resource
 * API would mean inventing an addressing scheme the contract does not have.
 *
 * Lifecycle rules implemented here:
 * - `file` — addable, listable, and deletable while the session runs.
 * - `github_repository` — attached at creation or added live; the repository
 *   URL, checkout, and mount path are immutable afterwards, and only
 *   `authorization_token` may be replaced. Removing it is allowed because the
 *   contract's delete operates on any resource ID; changing where a repository
 *   points is not, and requires a new session.
 * - `memory_store` — attachable only when the session is created. Attaching
 *   memory later would give the agent writes to a store it was not admitted
 *   against, so live add is refused.
 *
 * The instances here are the durable record; materialization happens in
 * `sandbox-lifecycle.ts`, which mounts a repository once a sandbox is
 * provisioned. Splitting them keeps admission honest: a resource instance
 * records intent faithfully, and the mount is performed (or the session is
 * refused) when a sandbox actually exists.
 */

import type { Database } from '@/core/db/database.js';
import type { ArtifactStore } from '@/core/storage/artifact-store.js';
import type { FileArtifactReader } from './sandbox-lifecycle.js';
import { nanoid } from 'nanoid';

/** Canonical resource-instance ID prefix. */
export const SESSION_RESOURCE_ID_PREFIX = 'sesrsc_';

/**
 * Read the bytes of an attached file resource.
 *
 * The composition root hands this to `SandboxLifecycle` so a session's file
 * resources can be written into the sandbox. The lookup is the one resource
 * admission performs — `role = 'file'`, not archived, backed by an artifact
 * that is actually on disk — so the reader can neither fail a resource the API
 * accepted nor become a way to mount a session artifact or an archived upload
 * that admission refuses.
 */
export function createFileArtifactReader(
  db: Database,
  artifactStore: ArtifactStore,
): FileArtifactReader {
  return (fileId: string) => {
    const row = db.prepare(
      "SELECT storage_path FROM files WHERE id = ? AND role = 'file' AND archived_at IS NULL",
    ).get(fileId) as { storage_path?: string } | undefined;
    if (!row?.storage_path || !artifactStore.exists(row.storage_path)) {
      throw new Error(`File not found: ${fileId}`);
    }
    return artifactStore.readFile(row.storage_path);
  };
}

export type SessionResourceType = 'file' | 'github_repository' | 'memory_store';

export const SESSION_RESOURCE_TYPES: readonly SessionResourceType[] = [
  'file',
  'github_repository',
  'memory_store',
];

export interface SessionResourceInstance {
  id: string;
  sessionId: string;
  type: SessionResourceType;
  /** Zero-based declaration order within the session. */
  position: number;
  mountPath?: string;
  /** Projection safe to echo: secrets already encrypted, never cleartext. */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AddResourceParams {
  sessionId: string;
  type: SessionResourceType;
  /** Normalized resource, as produced by the session resource normalizers. */
  resource: Record<string, unknown>;
  mountPath?: string;
}

export type ResourceMutationResult =
  | { ok: true; instance: SessionResourceInstance }
  | { ok: false; code: 'not_found' | 'invalid_request' | 'conflict'; message: string };

interface ResourceRow {
  id: string;
  session_id: string;
  resource_type: string;
  position: number;
  mount_path: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

/** Create the `sesrsc_...` identifier used on the wire. */
export function createSessionResourceId(): string {
  return `${SESSION_RESOURCE_ID_PREFIX}${nanoid(16)}`;
}

/**
 * True for a well-formed resource-instance ID.
 *
 * Used to distinguish "you addressed a resource that does not exist" from "you
 * addressed a session that does not exist", which the contract reports
 * differently.
 */
export function isSessionResourceId(value: string): boolean {
  return value.startsWith(SESSION_RESOURCE_ID_PREFIX) && value.length > SESSION_RESOURCE_ID_PREFIX.length;
}

function rowToInstance(row: ResourceRow): SessionResourceInstance {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.resource_type as SessionResourceType,
    position: row.position,
    ...(row.mount_path ? { mountPath: row.mount_path } : {}),
    config: JSON.parse(row.config) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resources attached to a session, in declaration order, excluding deletions. */
export function listSessionResources(db: Database, sessionId: string): SessionResourceInstance[] {
  const rows = db.prepare(`
    SELECT id, session_id, resource_type, position, mount_path, config, created_at, updated_at
    FROM session_resource_instances
    WHERE session_id = ? AND deleted_at IS NULL
    ORDER BY position ASC, created_at ASC
  `).all(sessionId) as unknown as ResourceRow[];
  return rows.map(rowToInstance);
}

/** One live resource instance, or `undefined` when absent or deleted. */
export function getSessionResource(
  db: Database,
  sessionId: string,
  resourceId: string,
): SessionResourceInstance | undefined {
  const row = db.prepare(`
    SELECT id, session_id, resource_type, position, mount_path, config, created_at, updated_at
    FROM session_resource_instances
    WHERE id = ? AND session_id = ? AND deleted_at IS NULL
  `).get(resourceId, sessionId) as unknown as ResourceRow | undefined;
  return row ? rowToInstance(row) : undefined;
}

/**
 * Attach a resource to a session.
 *
 * `memory_store` is refused when `atCreation` is false: the published contract
 * allows a memory store only at session creation, and admitting one later
 * would bind memory the session was never admitted against.
 */
export function addSessionResource(
  db: Database,
  params: AddResourceParams,
  options: { atCreation?: boolean; now?: string } = {},
): ResourceMutationResult {
  if (params.type === 'memory_store' && !options.atCreation) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'memory_store resources can only be attached when the session is created',
    };
  }

  const now = options.now ?? new Date().toISOString();
  const id = createSessionResourceId();

  const existing = db.prepare(`
    SELECT COUNT(*) AS count FROM session_resource_instances
    WHERE session_id = ? AND deleted_at IS NULL
  `).get(params.sessionId) as unknown as { count: number } | undefined;
  const position = existing?.count ?? 0;

  db.prepare(`
    INSERT INTO session_resource_instances
      (id, session_id, resource_type, position, mount_path, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.sessionId,
    params.type,
    position,
    params.mountPath ?? null,
    JSON.stringify(params.resource),
    now,
    now,
  );

  return {
    ok: true,
    instance: {
      id,
      sessionId: params.sessionId,
      type: params.type,
      position,
      ...(params.mountPath ? { mountPath: params.mountPath } : {}),
      config: params.resource,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Soft-delete a resource.
 *
 * `memory_store` deletion is refused: the contract attaches it for the life of
 * the session, and detaching a store mid-run would silently strand memory
 * writes that already happened.
 */
export function deleteSessionResource(
  db: Database,
  sessionId: string,
  resourceId: string,
  options: { now?: string } = {},
): ResourceMutationResult {
  const instance = getSessionResource(db, sessionId, resourceId);
  if (!instance) {
    return { ok: false, code: 'not_found', message: `Resource not found: ${resourceId}` };
  }
  if (instance.type === 'memory_store') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'memory_store resources cannot be removed from a running session',
    };
  }
  db.prepare(`
    UPDATE session_resource_instances SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND session_id = ?
  `).run(options.now ?? new Date().toISOString(), options.now ?? new Date().toISOString(), resourceId, sessionId);
  return { ok: true, instance };
}

/**
 * Replace a GitHub resource's authorization token.
 *
 * Only the credential changes. The repository URL, checkout, and mount path
 * stay as created, because the mount identity is fixed for the session; a
 * caller wanting a different repository creates a new session.
 */
export function rotateGithubAuthorizationToken(
  db: Database,
  sessionId: string,
  resourceId: string,
  encryptedToken: Record<string, unknown>,
  options: { now?: string } = {},
): ResourceMutationResult {
  const instance = getSessionResource(db, sessionId, resourceId);
  if (!instance) {
    return { ok: false, code: 'not_found', message: `Resource not found: ${resourceId}` };
  }
  if (instance.type !== 'github_repository') {
    return {
      ok: false,
      code: 'invalid_request',
      message: `Resource ${resourceId} is a ${instance.type} resource; only github_repository resources support token rotation`,
    };
  }

  const now = options.now ?? new Date().toISOString();
  const config = { ...instance.config, authorization_token: encryptedToken };
  db.prepare(`
    UPDATE session_resource_instances SET config = ?, updated_at = ?
    WHERE id = ? AND session_id = ?
  `).run(JSON.stringify(config), now, resourceId, sessionId);

  return { ok: true, instance: { ...instance, config, updatedAt: now } };
}

/**
 * Project a resource instance to its API shape.
 *
 * Credentials are dropped rather than masked: the contract states the
 * authorization token is not echoed, and a mask would still confirm the value
 * the caller supplied.
 */
export function toApiSessionResourceInstance(instance: SessionResourceInstance): Record<string, unknown> {
  const config = { ...instance.config };
  delete config.authorization_token;
  delete config.encrypted_secret;
  return {
    id: instance.id,
    type: instance.type,
    ...(instance.mountPath ? { mount_path: instance.mountPath } : {}),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
    ...config,
  };
}

/** Attach every normalized resource from a session-create payload. */
export function attachSessionResources(
  db: Database,
  sessionId: string,
  resources: readonly Record<string, unknown>[],
  options: { now?: string } = {},
): SessionResourceInstance[] {
  const attached: SessionResourceInstance[] = [];
  for (const resource of resources) {
    const type = resource.type as SessionResourceType;
    const result = addSessionResource(
      db,
      {
        sessionId,
        type,
        resource,
        ...(typeof resource.mount_path === 'string' ? { mountPath: resource.mount_path } : {}),
      },
      { atCreation: true, now: options.now },
    );
    if (result.ok) attached.push(result.instance);
  }
  return attached;
}
