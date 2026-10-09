/**
 * Self-hosted worker memory materialization.
 *
 * On Anthropic's own self-hosted workers an attached memory store is a real
 * directory on the worker host: the worker downloads the store, drops an
 * `.anthropic-memory-store` marker in the root, reconciles it against the API
 * on a sync interval while the session runs, and flushes one final sync
 * before the copy is removed. Reads see the newest synced version and writes
 * hit the local disk first, then upload on the next reconcile — conflicts
 * resolve in favour of the store's newer version. This module is that half of
 * the worker protocol; the API semantics it syncs against (paths,
 * `content_sha256` preconditions, read-only attachments) live in
 * `src/api/routes/memory-stores.ts` and `src/core/auth/session-work-scope.ts`.
 *
 * A mount maps to `<root>/<mount_path>/` — the declared mount path is already
 * the canonical absolute spelling (the default is `/mnt/memory/<slug>`), so
 * mounts land at `<root>/mnt/memory/<slug>/` by the same
 * absolute-path-into-root mapping every other work-item path takes.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  memoryBindingIsWritable,
  resolveMemoryBindings,
  type MemoryBinding,
  type MemoryStoreResourceLike,
} from '../core/memory/bindings.js';
import { CMA_AGENT_MEMORY_BETA, CMA_ANTHROPIC_VERSION } from '../core/cma/compatibility.js';

/** Marker file the published worker contract drops at a mounted store's root. */
export const MEMORY_MARKER_FILE = '.anthropic-memory-store';
export const DEFAULT_MEMORY_SYNC_INTERVAL_MS = 15_000;
export const MIN_MEMORY_SYNC_INTERVAL_MS = 5_000;
export const MEMORY_FINAL_SYNC_BUDGET_MS = 30_000;

export interface WorkerMemoryConfig {
  baseUrl: string;
  /** The claim's `mawt_` sessions token; memory routes are scoped to the claimed session's stores. */
  sessionToken: string;
  /** Worker workdir — a store's `mount_path` lands beneath it as `<root>/<mount_path>/`. */
  root: string;
  requestTimeoutMs: number;
  /**
   * Worker memory is POSIX-only on Anthropic's workers (the download relies on
   * `O_NOFOLLOW`-style path safety); a Windows host refuses mounts rather than
   * syncing an unverifiable directory. Injectable for tests.
   */
  platform?: NodeJS.Platform;
  /** Directory the same-store lock files live in. Injectable for tests. */
  lockDir?: string;
}

/**
 * A store's on-disk mount plus the last-synced remote state. `known` maps a
 * memory path to the record id and `content_sha256` the store held at the end
 * of the previous reconcile — the baseline that tells a local edit apart from
 * a remote edit during the next pass.
 */
export interface WorkerMemoryMount {
  storeId: string;
  dir: string;
  writable: boolean;
  lockPath: string;
  /** The token/baseUrl the mount was materialized with — reconcile and release use it. */
  config: WorkerMemoryConfig;
  known: Map<string, { id: string; sha256: string }>;
}

interface RemoteMemory {
  id: string;
  path: string;
  content: string | null;
  content_sha256: string;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function memoryApi(
  config: WorkerMemoryConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.sessionToken}`,
      // The memory family carries its own beta; an official-SDK-identical
      // header set keeps the admission middleware on the documented path.
      'anthropic-version': CMA_ANTHROPIC_VERSION,
      'anthropic-beta': CMA_AGENT_MEMORY_BETA,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`memory ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function listRemoteMemories(config: WorkerMemoryConfig, storeId: string): Promise<RemoteMemory[]> {
  const page = (await memoryApi(
    config,
    'GET',
    `/v1/memory_stores/${storeId}/memories?view=full`,
  )) as { data?: unknown };
  const rows = Array.isArray(page.data) ? page.data : [];
  return rows.filter(
    (row): row is RemoteMemory =>
      !!row && typeof row === 'object' &&
      typeof (row as RemoteMemory).id === 'string' &&
      typeof (row as RemoteMemory).path === 'string' &&
      typeof (row as RemoteMemory).content_sha256 === 'string',
  );
}

/** Map a store-side memory path (`/a/b.md`) to a file inside the mount dir. */
function memoryLocalPath(dir: string, memoryPath: string): string {
  const target = resolve(dir, `.${memoryPath}`);
  const rel = relative(dir, target);
  if (rel !== '' && (rel.startsWith('..') || rel.split(sep).includes('..'))) {
    throw new Error(`memory path escapes its mount: ${memoryPath}`);
  }
  return target;
}

/**
 * Write a store record to disk. A symlink at the target is unlinked first —
 * the published worker refuses to follow links during download, and unlinking
 * before the write is the portable equivalent of opening with `O_NOFOLLOW`.
 */
function writeMemoryFile(dir: string, memoryPath: string, content: string): void {
  const target = memoryLocalPath(dir, memoryPath);
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  } catch {
    // Not present — nothing to unlink.
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function readMemoryFile(dir: string, memoryPath: string): Buffer | null {
  const target = memoryLocalPath(dir, memoryPath);
  try {
    if (!lstatSync(target).isFile()) return null;
    return readFileSync(target);
  } catch {
    return null;
  }
}

/** Every regular file under the mount, marker excluded, as store-style `/…` paths. */
function* localMemoryFiles(dir: string, base: string = dir): Generator<string> {
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const full = join(base, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* localMemoryFiles(dir, full);
    } else if (entry.isFile() && entry.name !== MEMORY_MARKER_FILE) {
      yield `/${relative(dir, full).split(sep).join('/')}`;
    }
  }
}

/**
 * Same-store exclusivity: the published contract forbids two workers on one
 * host mounting the same store at once. The lock is an exclusive-create file
 * in the host's temp dir carrying the claimant's pid, released on `release`.
 */
function acquireStoreLock(config: WorkerMemoryConfig, storeId: string): string {
  const lockDir = config.lockDir ?? join(tmpdir(), 'managed-agents-memory-locks');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDir, `${storeId}.lock`);
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, `${process.pid} ${config.root}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new Error(`memory store ${storeId} is already mounted by a worker on this host`);
  }
  return lockPath;
}

/**
 * Download every attached `memory_store` in `resources` and return the mounts
 * to reconcile. A store lands at `<root>/mnt/memory/<mount_path>/` — the
 * canonical Anthropic worker layout — with the marker file in its root. A
 * platform or lock failure throws so the item fails rather than executing
 * without the session's declared memory.
 */
export async function mountSessionMemoryStores(
  config: WorkerMemoryConfig,
  resources: readonly MemoryStoreResourceLike[] | undefined,
): Promise<WorkerMemoryMount[]> {
  const bindings = resolveMemoryBindings(resources, (storeId) => storeId);
  if (bindings.length === 0) return [];
  if ((config.platform ?? process.platform) === 'win32') {
    throw new Error('memory store materialization is supported only on POSIX worker hosts');
  }

  const mounts: WorkerMemoryMount[] = [];
  try {
    for (const binding of bindings) {
      mounts.push(await mountOne(config, binding));
    }
    return mounts;
  } catch (error) {
    await releaseSessionMemoryMounts(mounts, { finalSync: false });
    throw error;
  }
}

async function mountOne(config: WorkerMemoryConfig, binding: MemoryBinding): Promise<WorkerMemoryMount> {
  // The binding's mount path is already the canonical absolute path — the
  // default `/mnt/memory/<slug>` or an explicit `mount_path` — and lands under
  // the worker root by the same mapping every work-item path takes.
  const mountRoot = resolve(config.root, `.${binding.mountPath}`);
  const rel = relative(config.root, mountRoot);
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`memory mount path escapes worker root: ${binding.mountPath}`);
  }
  const lockPath = acquireStoreLock(config, binding.storeId);
  const mount: WorkerMemoryMount = {
    storeId: binding.storeId,
    dir: mountRoot,
    writable: memoryBindingIsWritable(binding),
    lockPath,
    config,
    known: new Map(),
  };
  try {
    mkdirSync(mountRoot, { recursive: true });
    writeFileSync(join(mountRoot, MEMORY_MARKER_FILE), `memory_store_id=${binding.storeId}\n`);
    // The initial download is just the pull half of a reconcile against an
    // empty disk and an empty baseline.
    await pullRemoteState(config, mount, await listRemoteMemories(config, binding.storeId));
    return mount;
  } catch (error) {
    rmSync(mountRoot, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
    throw error;
  }
}

/**
 * Pull the fetched remote state onto the disk. A path whose local file is
 * untouched since the baseline takes the remote content; a path edited on
 * both sides takes the remote content too — the store's newer version wins a
 * conflict. Remote deletions remove the local file outright. The baseline is
 * updated to the remote state as pulled.
 */
function pullRemoteState(
  config: WorkerMemoryConfig,
  mount: WorkerMemoryMount,
  remote: RemoteMemory[],
): void {
  const remotePaths = new Set<string>();
  for (const rec of remote) {
    remotePaths.add(rec.path);
    const local = readMemoryFile(mount.dir, rec.path);
    const baseline = mount.known.get(rec.path)?.sha256;
    const localDirty = local !== null && sha256(local) !== baseline;
    // A locally-edited file whose remote did not move survives the pull — the
    // push phase uploads it. Everything else takes the remote version, which
    // is also the store-wins answer when both sides moved.
    if (localDirty && rec.content_sha256 === baseline) continue;
    if (local !== null && sha256(local) === rec.content_sha256) {
      mount.known.set(rec.path, { id: rec.id, sha256: rec.content_sha256 });
      continue;
    }
    writeMemoryFile(mount.dir, rec.path, rec.content ?? '');
    mount.known.set(rec.path, { id: rec.id, sha256: rec.content_sha256 });
  }
  for (const [path] of mount.known) {
    if (remotePaths.has(path)) continue;
    const target = memoryLocalPath(mount.dir, path);
    try {
      unlinkSync(target);
    } catch {
      // Already gone.
    }
    mount.known.delete(path);
  }
}

/**
 * One reconcile pass over a mount: pull the store's current state, then — for
 * a writable attachment — upload the agent's edits with the baseline hash as
 * each write's `content_sha256` precondition. A store that moved underneath a
 * pending local edit answers the precondition with a 409; that conflict is
 * logged and the local copy is re-pulled next pass, keeping the store the
 * winner.
 */
export async function reconcileMemoryMount(
  config: WorkerMemoryConfig,
  mount: WorkerMemoryMount,
): Promise<void> {
  const remote = await listRemoteMemories(config, mount.storeId);
  const remoteByPath = new Map(remote.map((rec) => [rec.path, rec]));
  pullRemoteState(config, mount, remote);

  if (mount.writable) {
    const localPaths = new Set(localMemoryFiles(mount.dir));
    for (const path of localPaths) {
      const local = readMemoryFile(mount.dir, path);
      if (local === null) continue;
      const localHash = sha256(local);
      const rec = remoteByPath.get(path);
      const baseline = mount.known.get(path);
      if (rec && (rec.content_sha256 === localHash || rec.content_sha256 !== baseline?.sha256)) {
        // Either already in sync or the remote moved too — the pull already
        // made the store's version the local one, so nothing uploads.
        continue;
      }
      const content = local.toString('utf8');
      try {
        if (!rec) {
          await memoryApi(config, 'POST', `/v1/memory_stores/${mount.storeId}/memories`, { path, content });
        } else {
          await memoryApi(config, 'POST', `/v1/memory_stores/${mount.storeId}/memories/${rec.id}`, {
            content,
            precondition: { type: 'content_sha256', content_sha256: rec.content_sha256 },
          });
        }
      } catch (error) {
        // A 409 means the store won a race; the next pull repairs the local
        // copy. Other failures surface at the next interval too — a sync
        // problem must not take the worker down.
        console.warn(`memory sync: could not upload ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [path, baseline] of mount.known) {
      if (localPaths.has(path)) continue;
      const rec = remoteByPath.get(path);
      if (rec && rec.content_sha256 === baseline.sha256) {
        try {
          await memoryApi(
            config,
            'DELETE',
            `/v1/memory_stores/${mount.storeId}/memories/${rec.id}?expected_content_sha256=${rec.content_sha256}`,
          );
        } catch (error) {
          console.warn(`memory sync: could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // Re-baseline from the post-push remote so the next pass compares against
  // what the store actually holds.
  const after = await listRemoteMemories(config, mount.storeId);
  mount.known = new Map(after.map((rec) => [rec.path, { id: rec.id, sha256: rec.content_sha256 }]));
}

/**
 * Worker exit: one final sync inside the published 30-second budget (a
 * writable mount flushes the agent's last edits; a read-only one just
 * refreshes), then the directories and locks go away — the published
 * contract keeps the API store authoritative and the disk copy disposable.
 */
export async function releaseSessionMemoryMounts(
  mounts: readonly WorkerMemoryMount[],
  options?: { finalSync?: boolean },
): Promise<void> {
  const deadline = Date.now() + MEMORY_FINAL_SYNC_BUDGET_MS;
  for (const mount of mounts) {
    try {
      if (options?.finalSync !== false && Date.now() < deadline) {
        await reconcileMemoryMount(mount.config, mount);
      }
    } catch (error) {
      console.warn(`memory sync: final sync of ${mount.storeId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      rmSync(mount.dir, { recursive: true, force: true });
      rmSync(mount.lockPath, { force: true });
    } catch {
      // A leftover directory is noise on a worker about to exit; do not fail
      // shutdown over it.
    }
  }
}
