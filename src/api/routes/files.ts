import { resolve } from 'node:path';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf } from '../standard.js';
import { LocalArtifactStore, type ArtifactStore } from '@/core/storage/artifact-store.js';
import {
  conflict,
  invalid,
  notFound,
  parseObject,
  readObjectBody,
  stringField,
  stringRecordField,
} from './resource-utils.js';
import { rejectUnexpectedQueryParams } from './query-params.js';

export type FileCreateInput = {
  name: string;
  mediaType: string;
  bytes: Buffer;
  metadata: Record<string, string>;
  role?: 'file' | 'artifact';
  sessionId?: string;
  artifactPath?: string;
};

const FILE_PREVIEW_MAX_BYTES = 24 * 1024;
const FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;

export function fileRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/files', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['scope_id']);
    if (rejected) return rejected;
    return c.json(cursorPageOf(listFileResources(deps, c.req.query('scope_id')), {}));
  });

  app.post('/files', async (c) => {
    if (!deps.workspace?.dataDir) return invalid(c, 'workspace data directory is not configured');

    try {
      const input = await readCreateFileRequest(c);
      if (!input.ok) return input.response;
      const file = persistFileResource(deps, input.value);
      return c.json(file, 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'File id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/files/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM files WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as FileRow | undefined;
    return row ? c.json(toFileResource(row, deps)) : notFound(c, 'File not found');
  });

  app.get('/files/:id/content', (c) => {
    const row = deps.db.prepare('SELECT * FROM files WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as FileRow | undefined;
    // Answer a missing row before resolving the store: without a workspace the
    // store cannot be resolved at all, and that throw would turn a plain 404
    // into a 500.
    if (!row) return notFound(c, 'File not found');
    const store = artifactStore(deps);
    if (!store.exists(row.storage_path)) return notFound(c, 'File not found');
    // Uint8Array rather than the Buffer itself: Buffer is not a BodyInit in the
    // DOM/undici typings even though it works at runtime.
    return new Response(new Uint8Array(store.readFile(row.storage_path)), {
      headers: {
        'Content-Type': row.media_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`,
      },
    });
  });

  app.delete('/files/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM files WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as FileRow | undefined;
    if (!row) return notFound(c, 'File not found');
    deps.db.prepare('UPDATE files SET status = ?, archived_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').run('archived', row.id);
    const archived = deps.db.prepare('SELECT * FROM files WHERE id = ?').get(row.id) as unknown as FileRow;
    return c.json(toFileResource(archived, deps));
  });

  return app;
}

/**
 * List the files a caller may see, optionally scoped to one session.
 *
 * `scope_id` is the published parameter name and `session_id` is the column's
 * local spelling — the projection happens here, on the way in, which is what
 * keeps the two spellings from being confused for each other.
 *
 * Without a scope the listing is every file, which is what this route has always
 * returned and what a caller who did not ask a scoped question should keep
 * getting. **With** a scope the answer is only that session's files, including
 * when the id names no session: an empty page is a true answer to "which files
 * does this session have", and falling back to the global list would answer a
 * scoped question with an unscoped list, which is the failure this parameter
 * exists to prevent. That fallback is the shape the published contract warns
 * about — a silently ignored `scope_id` looks exactly like a session-scoped
 * listing that happens to contain files the caller does not recognise.
 *
 * Files created directly through `POST /v1/files` carry no session, so they are
 * absent from every scoped listing rather than attributed to one.
 */
export function listFileResources(deps: ServerDeps, scopeId?: string) {
  const rows = (scopeId === undefined
    ? deps.db.prepare(
      `SELECT *
       FROM files
       WHERE role = 'file' AND archived_at IS NULL
       ORDER BY created_at DESC`,
    ).all()
    : deps.db.prepare(
      `SELECT *
       FROM files
       WHERE role = 'file' AND archived_at IS NULL AND session_id = ?
       ORDER BY created_at DESC`,
    ).all(scopeId)) as unknown as FileRow[];
  return rows.map((row) => toFileResource(row, deps));
}

export function toFileResource(row: FileRow, deps: ServerDeps) {
  const preview = previewFileResource(row, deps);
  return {
    id: row.id,
    type: 'file',
    name: row.name,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    role: row.role,
    session_id: row.session_id ?? null,
    artifact_path: row.artifact_path ?? null,
    status: row.archived_at ? 'archived' : row.status,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
    preview: preview?.content ?? null,
    preview_truncated: preview?.truncated ?? false,
  };
}

async function readCreateFileRequest(c: any): Promise<{ ok: true; value: FileCreateInput } | { ok: false; response: Response }> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    return readMultipartFileRequest(c);
  }

  const body = await readObjectBody(c);
  if (!body.ok) return body;

  const name = fileName(body.value.name);
  if (!name) return { ok: false, response: invalid(c, 'name is required') };
  const content = typeof body.value.content === 'string' ? body.value.content : '';
  const encoding = stringField(body.value.encoding) ?? 'utf8';
  if (encoding !== 'utf8' && encoding !== 'base64') {
    return { ok: false, response: invalid(c, 'encoding must be utf8 or base64') };
  }

  const bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  if (bytes.length > FILE_CONTENT_MAX_BYTES) {
    return { ok: false, response: invalid(c, 'file content exceeds the 10 MB limit') };
  }

  return {
    ok: true,
    value: {
      name,
      mediaType: stringField(body.value.media_type) ?? mediaTypeForName(name),
      bytes,
      metadata: stringRecordField(body.value.metadata),
    },
  };
}

async function readMultipartFileRequest(c: any): Promise<{ ok: true; value: FileCreateInput } | { ok: false; response: Response }> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  } catch {
    return { ok: false, response: invalid(c, 'Request body must be valid multipart/form-data') };
  }

  const files: Array<{ name: string; mediaType?: string; bytes: Buffer }> = [];
  let requestedName: string | undefined;
  let requestedMediaType: string | undefined;
  let metadata: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(body)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (isFileField(key) && isUploadedFileLike(value)) {
        const bytes = Buffer.from(await value.arrayBuffer());
        files.push({ name: value.name, mediaType: value.type, bytes });
        continue;
      }
      if (key === 'name' && typeof value === 'string') requestedName = value;
      if (key === 'media_type' && typeof value === 'string') requestedMediaType = value;
      if (key === 'metadata' && typeof value === 'string') metadata = parseStringRecord(value);
    }
  }

  if (files.length === 0) return { ok: false, response: invalid(c, 'file is required') };
  if (files.length > 1) return { ok: false, response: invalid(c, 'Only one file can be uploaded per request') };

  const upload = files[0];
  const name = fileName(requestedName) ?? fileName(upload.name);
  if (!name) return { ok: false, response: invalid(c, 'name is required') };
  if (upload.bytes.length > FILE_CONTENT_MAX_BYTES) {
    return { ok: false, response: invalid(c, 'file content exceeds the 10 MB limit') };
  }

  return {
    ok: true,
    value: {
      name,
      mediaType: stringField(requestedMediaType) ?? stringField(upload.mediaType) ?? mediaTypeForName(name),
      bytes: upload.bytes,
      metadata,
    },
  };
}

export function persistFileResource(deps: ServerDeps, input: FileCreateInput) {
  if (!deps.workspace?.dataDir) throw new Error('workspace data directory is not configured');
  const id = `file_${nanoid(18)}`;
  const store = artifactStore(deps);
  const storagePath = store.path(id);
  const now = new Date().toISOString();

  try {
    store.writeFile(storagePath, input.bytes);
    deps.db.prepare(
      `INSERT INTO files (
        id, name, media_type, size_bytes, storage_path, role, session_id, artifact_path,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.mediaType,
      input.bytes.length,
      storagePath,
      input.role ?? 'file',
      input.sessionId ?? null,
      input.artifactPath ?? null,
      JSON.stringify(input.metadata),
      now,
      now,
    );
  } catch (err) {
    store.remove(storagePath);
    throw err;
  }

  const row = deps.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow;
  return toFileResource(row, deps);
}

function isFileField(key: string): boolean {
  return key === 'file' || key === 'files' || key === 'files[]';
}

function isUploadedFileLike(value: unknown): value is { name: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { name?: unknown }).name === 'string'
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function';
}

function parseStringRecord(value: string): Record<string, string> {
  try {
    return stringRecordField(JSON.parse(value));
  } catch {
    return {};
  }
}

function previewFileResource(row: FileRow, deps: ServerDeps): { content: string; truncated: boolean } | null {
  const store = artifactStore(deps);
  if (!isPreviewableMediaType(row.media_type) || !store.exists(row.storage_path)) return null;
  const bytes = store.readFile(row.storage_path).subarray(0, FILE_PREVIEW_MAX_BYTES);
  const raw = bytes.toString('utf8');
  if (raw.includes('\u0000')) return null;
  return {
    content: raw,
    truncated: row.size_bytes > FILE_PREVIEW_MAX_BYTES,
  };
}

function artifactStore(deps: ServerDeps): ArtifactStore {
  if (deps.artifactStore) return deps.artifactStore();
  if (!deps.workspace?.dataDir) throw new Error('workspace data directory is not configured');
  return new LocalArtifactStore(deps.artifactStorageDir?.() ?? resolve(deps.workspace.dataDir, 'files'));
}

function isPreviewableMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/yaml'
    || mediaType === 'application/x-yaml';
}

function mediaTypeForName(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.ya?ml$/i.test(name)) return 'application/yaml';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.(txt|log|csv)$/i.test(name)) return 'text/plain';
  return 'application/octet-stream';
}

function fileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]/g, '_');
  if (!trimmed) return undefined;
  return trimmed.slice(0, 255);
}

export interface FileRow {
  id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  storage_path: string;
  role: 'file' | 'artifact';
  session_id: string | null;
  artifact_path: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
