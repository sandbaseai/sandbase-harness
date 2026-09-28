/**
 * Session output files.
 *
 * The published contract says an agent's deliverables are the files it writes
 * under `/mnt/session/outputs/` inside the sandbox, and that those files become
 * retrievable through the Files API scoped to the session
 * (`GET /v1/files?scope_id=<session_id>`) shortly after the agent finishes
 * writing them.
 *
 * Two halves live here:
 *
 * - {@link collectSessionOutputs} reads what the sandbox actually holds. It
 *   walks the output root itself instead of trusting a side channel, because
 *   the agent writes with ordinary shell and file tools that record nothing.
 * - {@link recordSessionOutputs} persists those bytes as session-scoped file
 *   records. It is idempotent per (session, sandbox path) so a second pass over
 *   the same output root updates the existing record rather than minting a
 *   duplicate — the same deliverable must have one file id.
 */

import type { SandboxInstance } from '@/types/sandbox.js';
import type { Database } from '@/core/db/database.js';
import type { ArtifactStore } from '@/core/storage/artifact-store.js';
import { nanoid } from 'nanoid';

/** Absolute sandbox directory whose contents are published as session files. */
export const SESSION_OUTPUT_ROOT = '/mnt/session/outputs';

/** The output root as it appears in a listing that is relative to the sandbox root. */
const SESSION_OUTPUT_ROOT_RELATIVE = SESSION_OUTPUT_ROOT.replace(/^\/+/, '');

/**
 * Guard against a runaway agent filling the artifact store in one pass.
 *
 * The cap is on *new* files per pass, not on total size: files already recorded
 * are refreshed in place and never counted, so a session that legitimately
 * accumulates output across many turns is not throttled by its own history.
 */
export const SESSION_OUTPUT_MAX_NEW_FILES = 200;

/** One file read back from the sandbox output directory. */
export interface SessionOutputFile {
  /** Path relative to {@link SESSION_OUTPUT_ROOT}, using `/` separators. */
  relativePath: string;
  bytes: Buffer;
}

/**
 * Read every file under the sandbox output root.
 *
 * Best-effort by design: an absent directory simply means the agent wrote no
 * deliverables, and a single unreadable file must not fail the turn that just
 * completed. A missing directory or listing error yields an empty result.
 *
 * An entry is read in the spelling its provider uses. The in-process providers
 * answer with paths relative to the sandbox root
 * (`mnt/session/outputs/report.md`), which is already the whole answer; a provider
 * that answers with a name relative to the directory it was asked about — a
 * `self_hosted` worker may — is handled by descending into it, because a name is
 * only known to be a file once reading it succeeds.
 *
 * Known limitation: the sandbox read interface yields text, so a binary
 * deliverable (`.zip`, image) is stored as its decoded text rather than its
 * exact bytes. Closing that needs a byte-level read on the provider
 * interface; until then a binary output is published, but not byte-faithful.
 */
export async function collectSessionOutputs(
  sandbox: SandboxInstance,
): Promise<SessionOutputFile[]> {
  const files: SessionOutputFile[] = [];
  await walk(sandbox, SESSION_OUTPUT_ROOT, '', files);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  async function walk(
    target: SandboxInstance,
    absoluteDir: string,
    relativeDir: string,
    out: SessionOutputFile[],
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await target.listFiles(absoluteDir);
    } catch {
      return;
    }

    for (const rawEntry of entries) {
      const located = locateOutput(rawEntry, absoluteDir, relativeDir);
      if (!located) continue;

      // Probe with a read rather than a list: `listFiles` returns paths only,
      // with no type bit, so a successful read is the only proof of a file.
      let content: string;
      try {
        content = await target.readFile(located.absolute);
      } catch {
        // Not readable as a file. A single segment may still be a directory the
        // provider lists by name, so descend; a longer path came from the
        // provider's own listing and has nothing below it to walk.
        if (located.isName) await walk(target, located.absolute, located.relative, out);
        continue;
      }
      out.push({ relativePath: located.relative, bytes: Buffer.from(content) });
    }
  }
}

interface LocatedOutput {
  /** Path relative to {@link SESSION_OUTPUT_ROOT}, using `/` separators. */
  relative: string;
  /** Sandbox path to read the entry from. */
  absolute: string;
  /** The entry named one segment under `absoluteDir` rather than a full path. */
  isName: boolean;
}

/**
 * Interpret one listing entry as an output file.
 *
 * Two spellings name the same deliverable: a path relative to the sandbox root,
 * and a name relative to the directory the provider was asked about. Both are
 * accepted here rather than at every call site, and an entry that would name a
 * path with a traversal segment or an empty segment is dropped — the provider is
 * the source of these strings, and a caller-visible record keyed by them must
 * still be a path inside the output root.
 */
function locateOutput(rawEntry: string, absoluteDir: string, relativeDir: string): LocatedOutput | undefined {
  const entry = rawEntry.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (entry === '' || entry === '.' || entry === '..') return undefined;

  const fromRoot = entry.startsWith(`${SESSION_OUTPUT_ROOT_RELATIVE}/`)
    ? entry.slice(SESSION_OUTPUT_ROOT_RELATIVE.length + 1)
    : undefined;
  const relative = fromRoot ?? (relativeDir === '' ? entry : `${relativeDir}/${entry}`);
  if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }

  return {
    relative,
    absolute: fromRoot === undefined ? `${absoluteDir}/${entry}` : `${SESSION_OUTPUT_ROOT}/${fromRoot}`,
    isName: fromRoot === undefined && !entry.includes('/'),
  };
}

export interface RecordSessionOutputsResult {
  /** Files newly registered for this session. */
  recorded: Array<{ id: string; name: string; path: string }>;
  /** Files whose bytes were refreshed under their existing id. */
  updated: Array<{ id: string; name: string; path: string }>;
  /** Files skipped because this pass hit {@link SESSION_OUTPUT_MAX_NEW_FILES}. */
  skipped: number;
}

export interface RecordSessionOutputsDeps {
  db: Database;
  artifactStore: ArtifactStore;
  sessionId: string;
  files: SessionOutputFile[];
  now?: Date;
}

/**
 * Persist collected outputs as session-scoped file records.
 *
 * Identity is (session, sandbox path), carried in
 * `files.metadata.session_output_path`. Re-running over an unchanged output
 * root therefore refreshes the same records instead of duplicating them, and a
 * file the agent rewrote keeps the id a caller already holds.
 */
export function recordSessionOutputs(deps: RecordSessionOutputsDeps): RecordSessionOutputsResult {
  const now = (deps.now ?? new Date()).toISOString();
  const result: RecordSessionOutputsResult = { recorded: [], updated: [], skipped: 0 };
  let created = 0;

  for (const file of deps.files) {
    const existing = findExistingOutput(deps.db, deps.sessionId, file.relativePath);
    const mediaType = mediaTypeForOutput(file.relativePath);

    if (existing) {
      const storagePath = deps.artifactStore.path(existing.id);
      deps.artifactStore.writeFile(storagePath, file.bytes);
      deps.db.prepare(
        `UPDATE files
         SET size_bytes = ?, media_type = ?, storage_path = ?, updated_at = ?
         WHERE id = ?`,
      ).run(file.bytes.length, mediaType, storagePath, now, existing.id);
      result.updated.push({ id: existing.id, name: existing.name, path: file.relativePath });
      continue;
    }

    if (created >= SESSION_OUTPUT_MAX_NEW_FILES) {
      result.skipped += 1;
      continue;
    }

    const id = `file_${nanoid(18)}`;
    const storagePath = deps.artifactStore.path(id);
    const name = outputNameFor(file.relativePath);
    deps.artifactStore.writeFile(storagePath, file.bytes);
    deps.db.prepare(
      `INSERT INTO files (
        id, name, media_type, size_bytes, storage_path, role, session_id, artifact_path,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      mediaType,
      file.bytes.length,
      storagePath,
      'file',
      deps.sessionId,
      null,
      JSON.stringify({ session_output_path: file.relativePath }),
      now,
      now,
    );
    created += 1;
    result.recorded.push({ id, name, path: file.relativePath });
  }

  return result;
}

/** The existing record for a sandbox output path, if any. */
function findExistingOutput(
  db: Database,
  sessionId: string,
  relativePath: string,
): { id: string; name: string } | undefined {
  return db.prepare(
    `SELECT id, name
     FROM files
     WHERE session_id = ?
       AND archived_at IS NULL
       AND role = 'file'
       AND json_extract(metadata, '$.session_output_path') = ?`,
  ).get(sessionId, relativePath) as { id: string; name: string } | undefined;
}

/** Basename of an output path, capped to the 255-character column limit. */
function outputNameFor(relativePath: string): string {
  const basename = relativePath.split('/').filter(Boolean).at(-1) ?? relativePath;
  return basename.slice(0, 255);
}

function mediaTypeForOutput(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.ya?ml$/i.test(name)) return 'application/yaml';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.(txt|log|csv)$/i.test(name)) return 'text/plain';
  if (/\.html?$/i.test(name)) return 'text/html';
  return 'application/octet-stream';
}
