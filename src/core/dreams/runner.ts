/**
 * Dream lifecycle runner.
 *
 * A dream is durable state (`dreams` row) plus a pipeline session (`sess_*`)
 * doing the work. `startDream` builds that session — an internal agent with
 * the input store mounted read-only and the output store writable, and the
 * selected session transcripts packaged as context — and lets the normal
 * turn machinery run it. `syncDream` maps the pipeline session's status back
 * onto the dream, and is called on every read and from the operations tick so
 * a dream that nobody is watching still terminalizes and releases its sandbox.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { SqliteMemoryMountAdapter } from '@/core/memory/mount-adapter.js';
import type { SessionManager } from '@/core/session/session-manager.js';
import { getOrSeedRuntimeSettings } from '@/core/settings/store.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { ContentBlock } from '@/types/cma-protocol.js';
import type { SessionStatus } from '@/types/session.js';
import {
  ACTIVE_DREAM_STATUSES,
  type DreamInput,
  type DreamModelConfig,
  type DreamRow,
  type ParsedDreamCreate,
} from './dream.js';

/** The internal agent every dream session runs as. */
export const DREAM_AGENT_ID = 'agent_sandbase_dream';
export const DREAM_AGENT_NAME = 'sandbase-dream';

const DREAM_INPUT_MOUNT = '/mnt/memory/input';
const DREAM_OUTPUT_MOUNT = '/mnt/memory/output';
/** Single-mount path used when input and output are the same store. */
const DREAM_STORE_MOUNT = '/mnt/memory/store';

/** Per-session transcript bound, so one noisy session cannot crowd out the rest. */
const TRANSCRIPT_MAX_CHARS = 40_000;

export interface DreamRunnerDeps {
  db: Database;
  sessionManager: SessionManager;
  dataDir?: string;
  /** Workspace primary model reference, used when neither request nor settings name one. */
  defaultModelName?: () => string | undefined;
}

const DREAM_AGENT_TOOLS: AgentDefinition['tools'] = [
  {
    type: 'agent_toolset_20260401',
    // The dream profile is deliberately narrow: read/write/edit/glob reach the
    // mounted stores; nothing else a consolidation pipeline could call (bash,
    // network tools) is enabled, so an unattended run cannot step outside it.
    default_config: { enabled: false },
    configs: [
      { name: 'read', enabled: true },
      { name: 'write', enabled: true },
      { name: 'edit', enabled: true },
      { name: 'glob', enabled: true },
    ],
  },
];

const DREAM_AGENT_SYSTEM = `You are the memory-consolidation pipeline for a SandBase dream job.

Your job: read the mounted input memory store and the session transcripts in this conversation's context, consolidate what is durable into memory records, and write the result into the mounted output store.

Rules:
- Read the input store with the read/glob tools. It is read-only; never write to it.
- Write consolidated records into the output store with the write/edit tools. Keep entries self-contained and place them under stable, descriptive paths.
- Preserve input memories that are still accurate; merge duplicates, drop contradicted or stale facts, and keep the organization navigable.
- When the store already contains records, update rather than re-create them.
- Do not invent facts. Only consolidate what the inputs carry.`;

function dreamAgentDefinition(): AgentDefinition {
  return {
    name: DREAM_AGENT_NAME,
    // Always replaced by the resolved dream model before the snapshot is
    // frozen onto the session; a legible placeholder keeps a direct reader
    // honest about the definition never running as-is.
    model: 'default',
    system: DREAM_AGENT_SYSTEM,
    description: 'Internal agent that runs memory-consolidation dream jobs.',
    tools: DREAM_AGENT_TOOLS,
    metadata: { internal: 'dream_pipeline' },
  };
}

/**
 * Upsert the internal dream agent row. `sessions.agent_id` is a foreign key
 * into `agents`, so a pipeline session cannot point at a definition that has
 * no row — the row must exist even though it is never resolved for execution
 * (the session carries its own frozen snapshot). An operator can archive or
 * delete it like any other row, so creation re-checks on every dream rather
 * than assuming the row survived.
 */
export function ensureDreamAgent(db: Database): void {
  const row = db.prepare('SELECT status, archived_at FROM agents WHERE id = ?').get(DREAM_AGENT_ID) as
    | { status: string; archived_at: string | null }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      DREAM_AGENT_ID,
      DREAM_AGENT_NAME,
      JSON.stringify(dreamAgentDefinition()),
    );
    return;
  }
  if (row.archived_at || row.status === 'archived') {
    db.prepare(
      `UPDATE agents SET archived_at = NULL, status = 'active', definition = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(dreamAgentDefinition()), DREAM_AGENT_ID);
  }
}

/**
 * Model precedence: the request's `model`, then the `dreams.model` runtime
 * setting, then the workspace's default registered model. `null` means none
 * resolved — a refusal the route turns into a 400, since the dream would start
 * with no way to run.
 */
export function resolveDreamModel(deps: DreamRunnerDeps, requested: DreamModelConfig | null): DreamModelConfig | null {
  if (requested) return requested;
  const settings = getOrSeedRuntimeSettings(deps.db, {}, deps.dataDir).effective_config;
  const configured = settings.dreams?.model;
  if (typeof configured === 'string' && configured.trim()) return { id: configured.trim() };
  const fallback = deps.defaultModelName?.();
  return fallback ? { id: fallback } : null;
}

/** Read one session's event log as a bounded plain-text transcript. */
function sessionTranscript(db: Database, sessionId: string): string {
  const events = db.prepare(
    `SELECT seq, type, content, metadata FROM events WHERE session_id = ? ORDER BY seq ASC`,
  ).all(sessionId) as Array<{ seq: number; type: string; content: string | null; metadata: string | null }>;

  const lines: string[] = [];
  for (const event of events) {
    const text = extractEventText(event.type, event.content, event.metadata);
    if (text) lines.push(text);
  }
  const body = lines.join('\n');
  return body.length > TRANSCRIPT_MAX_CHARS
    ? `${body.slice(0, TRANSCRIPT_MAX_CHARS)}\n… [transcript truncated at ${TRANSCRIPT_MAX_CHARS} characters]`
    : body;
}

function extractEventText(type: string, content: string | null, metadata: string | null): string | null {
  const textOf = (raw: string | null): string => {
    if (!raw) return '';
    try {
      const blocks = JSON.parse(raw) as ContentBlock[];
      if (!Array.isArray(blocks)) return '';
      return blocks
        .map((block) => {
          if (block.type === 'text') return (block as { text?: string }).text ?? '';
          if (block.type === 'tool_use') {
            const use = block as { name?: string };
            return `[tool_use: ${use.name ?? 'unknown'}]`;
          }
          if (block.type === 'tool_result') return '[tool_result]';
          if (block.type === 'redacted') return '[redacted]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } catch {
      return '';
    }
  };
  switch (type) {
    case 'user.message':
    case 'user.steer':
      return `[user] ${textOf(content)}`;
    case 'agent.message':
      return `[assistant] ${textOf(content)}`;
    case 'session.error':
      return `[error] ${textOf(content)}`;
    case 'system.message':
      return `[system] ${textOf(content)}`;
    default:
      return null;
  }
}

/** Render the transcript corpus as the context events for a dream session. */
function dreamInitialEvents(
  db: Database,
  parsed: ParsedDreamCreate,
  inputMount: string,
  outputMount: string,
): Array<{ type: 'system.message'; content?: ContentBlock[] } | { type: 'user.message'; content: ContentBlock[] }> {
  const transcriptSections = parsed.sessionIds
    .map((id) => {
      const transcript = sessionTranscript(db, id);
      return `### Transcript: session ${id}\n${transcript || '(empty transcript)'}`;
    })
    .join('\n\n');

  const corpus =
    `The following transcripts are the dream's session inputs. Read them as source material only — ` +
    `do not answer them.\n\n${transcriptSections}`;

  const task =
    `Consolidate the mounted inputs into the output store.\n\n` +
    `- Input memory store: mounted read-only at ${inputMount}\n` +
    `- Output memory store: mounted writable at ${outputMount}\n` +
    `- ${parsed.sessionIds.length} session transcript(s) are included in context above.\n` +
    (parsed.instructions ? `\nAdditional instructions from the caller:\n${parsed.instructions}\n` : '') +
    `\nWhen you are done, stop. Do not ask questions; this pipeline runs unattended.`;

  return [
    { type: 'system.message', content: [{ type: 'text', text: corpus }] },
    { type: 'user.message', content: [{ type: 'text', text: task }] },
  ];
}

/**
 * Create a `create_new` output store seeded as a copy of the input store, as
 * the published contract requires ("the new memory store … starts as a copy of
 * the input memory store"). Records copy without their version history — the
 * store is new, and its history starts with the dream's own writes.
 */
function createOutputStoreCopy(db: Database, inputStoreId: string, dreamId: string): string {
  const id = `memstore_${nanoid(18)}`;
  const input = db.prepare('SELECT name, description FROM memory_stores WHERE id = ?').get(inputStoreId) as
    | { name: string; description: string }
    | undefined;
  db.prepare(
    `INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, 'sqlite', '{}', ?)`,
  ).run(
    id,
    `dream-${dreamId}`,
    `Output of dream ${dreamId}${input ? ` (copy of ${input.name})` : ''}`,
    JSON.stringify({ created_by: 'dream', dream_id: dreamId, copied_from: inputStoreId }),
  );
  const mount = new SqliteMemoryMountAdapter(db);
  const records = mount.list(inputStoreId);
  if (records.ok) {
    for (const record of records.value) {
      const created = mount.create(id, record.path, record.content, {
        metadata: { ...record.metadata, copied_from: inputStoreId },
      });
      if (!created.ok) {
        throw new Error(`Failed to seed dream output store: ${created.error.message}`);
      }
    }
  }
  return id;
}

/**
 * The published mid-run input check (`official-docs/dreams.md` "Errors").
 *
 * A dream's inputs were verified at create, but the rows are ordinary
 * resources with no hold: an operator can archive or delete the input memory
 * store and delete an input session while the dream is `pending` or `running`.
 * The published vocabulary names both failures —
 * `input_memory_store_unavailable` when the store went, and
 * `input_session_unavailable` when a session did — and the check runs at every
 * lifecycle decision point (create-adjacent start and every reconcile), so a
 * dream that lost its inputs reports the published cause rather than
 * `internal_error` or a stall.
 *
 * Deleted session ids stay recorded on the row's `inputs`, so the check reads
 * the stored request, not the live transcript source.
 */
/** The `sessions` input's id list from the row's stored `inputs` JSON. */
function sessionIdsFromInputs(rawInputs: string): string[] {
  try {
    const inputs = JSON.parse(rawInputs) as DreamInput[];
    const sessionsInput = inputs.find((input): input is { type: 'sessions'; session_ids: string[] } => input.type === 'sessions');
    return sessionsInput?.session_ids ?? [];
  } catch {
    return [];
  }
}

function dreamInputUnavailable(deps: DreamRunnerDeps, parsed: ParsedDreamCreate): { type: string; message: string } | undefined {
  const store = deps.db.prepare('SELECT 1 FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(parsed.memoryStoreId);
  if (!store) {
    return { type: 'input_memory_store_unavailable', message: `Input memory store ${parsed.memoryStoreId} was archived or deleted` };
  }
  for (const sessionId of parsed.sessionIds) {
    const session = deps.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return { type: 'input_session_unavailable', message: `Input session ${sessionId} was deleted` };
    }
  }
  return undefined;
}

/**
 * Start a pending dream: create the output store (if any), the pipeline
 * session, and flip the row to running. A failure anywhere marks the dream
 * failed rather than leaving it parked — a job that cannot start is a failed
 * job, not a permanently pending one.
 */
export async function startDream(deps: DreamRunnerDeps, dream: DreamRow): Promise<DreamRow> {
  const inputs = JSON.parse(dream.inputs) as DreamInput[];
  const sessionsInput = inputs.find((input): input is { type: 'sessions'; session_ids: string[] } => input.type === 'sessions');
  const parsed: ParsedDreamCreate = {
    memoryStoreId: dream.input_store_id,
    sessionIds: sessionsInput?.session_ids ?? [],
    instructions: dream.instructions,
    model: JSON.parse(dream.model) as DreamModelConfig,
    outputBehavior: JSON.parse(dream.output_behavior) as { type: 'create_new' } | { type: 'update_existing'; memory_store_id: string },
  };

  const fail = (type: string, message: string): DreamRow => {
    deps.db.prepare(
      `UPDATE dreams SET status = 'failed', error_type = ?, error_message = ?, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(type, message, dream.id);
    return deps.db.prepare('SELECT * FROM dreams WHERE id = ?').get(dream.id) as unknown as DreamRow;
  };

  // The published mid-run check fires here too: a pending row restarted by the
  // sweep may have lost an input between create and recovery, which is the same
  // cause as losing one mid-run.
  const unavailable = dreamInputUnavailable(deps, parsed);
  if (unavailable) return fail(unavailable.type, unavailable.message);

  try {
    ensureDreamAgent(deps.db);

    const outputStoreId = parsed.outputBehavior.type === 'create_new'
      ? createOutputStoreCopy(deps.db, parsed.memoryStoreId, dream.id)
      : parsed.outputBehavior.memory_store_id;
    deps.db.prepare('UPDATE dreams SET output_store_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(outputStoreId, dream.id);

    const sameStore = outputStoreId === parsed.memoryStoreId;
    const resources = sameStore
      ? [{ type: 'memory_store', memory_store_id: outputStoreId, access: 'read_write', mount_path: DREAM_STORE_MOUNT }]
      : [
          { type: 'memory_store', memory_store_id: parsed.memoryStoreId, access: 'read_only', mount_path: DREAM_INPUT_MOUNT },
          { type: 'memory_store', memory_store_id: outputStoreId, access: 'read_write', mount_path: DREAM_OUTPUT_MOUNT },
        ];

    const session = deps.sessionManager.createWithInitialEvents(
      {
        agent: DREAM_AGENT_ID,
        // The pipeline agent is internal: the snapshot is carried on the
        // session itself rather than seeded into the durable agent roster,
        // where it would appear in user-facing listings and invite edits that
        // cannot take effect on a run already in flight.
        agentSnapshot: {
          id: DREAM_AGENT_ID,
          name: DREAM_AGENT_NAME,
          version: 1,
          definition: { ...dreamAgentDefinition(), model: parsed.model!.id },
        },
        title: `Dream ${dream.id}`,
        resources,
        metadata: { dream_id: dream.id, managed_by: 'dream_pipeline' },
      },
      dreamInitialEvents(deps.db, parsed, sameStore ? DREAM_STORE_MOUNT : DREAM_INPUT_MOUNT, sameStore ? DREAM_STORE_MOUNT : DREAM_OUTPUT_MOUNT),
    );

    deps.db.prepare(
      `UPDATE dreams SET status = 'running', session_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(session.id, dream.id);
  } catch (err) {
    return fail('internal_error', err instanceof Error ? err.message : String(err));
  }
  return deps.db.prepare('SELECT * FROM dreams WHERE id = ?').get(dream.id) as unknown as DreamRow;
}

function sessionUsage(db: Database, sessionId: string | null) {
  if (!sessionId) return null;
  return db.prepare(
    'SELECT usage_tokens_in AS in_, usage_tokens_out AS out_, usage_cache_read_tokens AS cr, usage_cache_write_tokens AS cw FROM sessions WHERE id = ?',
  ).get(sessionId) as { in_: number; out_: number; cr: number; cw: number } | undefined;
}

function lastIdleStopReason(deps: DreamRunnerDeps, sessionId: string): string | undefined {
  const events = deps.sessionManager.getEventLogger().getEvents(sessionId);
  const lastIdle = [...events].reverse().find((event) => event.type === 'session.status_idle');
  const stopReason = (lastIdle?.metadata as { stop_reason?: { type?: string } } | undefined)?.stop_reason;
  return stopReason?.type;
}

/**
 * Fold the pipeline session's current status into the dream row. Terminal
 * session states finish the dream: a clean idle turn means the pipeline ran to
 * `end_turn`; `budget_reached`/`retries_exhausted` idles mean it stopped
 * without finishing, which is a failed run with partial output preserved.
 */
export async function syncDream(deps: DreamRunnerDeps, dream: DreamRow): Promise<DreamRow> {
  if (!ACTIVE_DREAM_STATUSES.includes(dream.status)) return dream;
  if (!dream.session_id) {
    // Created but never started — recover by starting it now.
    return startDream(deps, dream);
  }

  const session = deps.sessionManager.get(dream.session_id);
  const usage = sessionUsage(deps.db, dream.session_id);
  const persistUsage = () => {
    if (!usage) return;
    deps.db.prepare(
      `UPDATE dreams SET usage_input_tokens = ?, usage_output_tokens = ?, usage_cache_read_input_tokens = ?, usage_cache_creation_input_tokens = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(usage.in_, usage.out_, usage.cr, usage.cw, dream.id);
  };

  if (!session) {
    persistUsage();
    deps.db.prepare(
      `UPDATE dreams SET status = 'failed', error_type = 'internal_error', error_message = 'Pipeline session no longer exists', ended_at = datetime('now') WHERE id = ?`,
    ).run(dream.id);
    return deps.db.prepare('SELECT * FROM dreams WHERE id = ?').get(dream.id) as unknown as DreamRow;
  }

  const finish = async (status: 'completed' | 'failed' | 'canceled', errorType?: string, errorMessage?: string) => {
    persistUsage();
    deps.db.prepare(
      `UPDATE dreams SET status = ?, error_type = ?, error_message = ?, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(status, errorType ?? null, errorMessage ?? null, dream.id);
    // The pipeline session's job is done; archive it so the sandbox releases.
    // Its event log stays durable for audit through dream.session_id.
    try {
      await deps.sessionManager.archive(dream.session_id!);
    } catch {
      // best-effort: a terminal session may already be archived
    }
    return deps.db.prepare('SELECT * FROM dreams WHERE id = ?').get(dream.id) as unknown as DreamRow;
  };

  switch (session.status as SessionStatus) {
    case 'queued':
    case 'running':
    case 'retrying':
    case 'requires_action': {
      persistUsage();
      // While the pipeline is still alive, a lost input is a published
      // terminal cause — the run cannot produce the consolidation it was
      // created for, and reconciling it reports why rather than waiting for
      // the session to end on its own.
      const parsed: ParsedDreamCreate = {
        memoryStoreId: dream.input_store_id,
        sessionIds: sessionIdsFromInputs(dream.inputs),
        instructions: dream.instructions,
        model: JSON.parse(dream.model) as DreamModelConfig,
        outputBehavior: JSON.parse(dream.output_behavior) as ParsedDreamCreate['outputBehavior'],
      };
      const unavailable = dreamInputUnavailable(deps, parsed);
      if (unavailable) {
        return finish('failed', unavailable.type, unavailable.message);
      }
      if (dream.status === 'pending') {
        deps.db.prepare(`UPDATE dreams SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(dream.id);
      }
      break;
    }
    case 'paused': {
      const stopReason = lastIdleStopReason(deps, dream.session_id);
      if (!stopReason || stopReason === 'end_turn') return finish('completed');
      return finish('failed', stopReason, `Dream pipeline stopped without finishing: ${stopReason}`);
    }
    case 'completed':
      return finish('completed');
    case 'cancelled':
    case 'archived':
      return finish('canceled');
    case 'timed_out':
      return finish('failed', 'timeout', 'Dream pipeline session timed out');
    case 'failed':
    case 'cleanup_pending': {
      const lastError = [...deps.sessionManager.getEventLogger().getEvents(dream.session_id)]
        .reverse()
        .find((event) => event.type === 'session.error');
      const message = lastError?.content?.find((b) => b.type === 'text');
      return finish('failed', 'internal_error', (message as { text?: string } | undefined)?.text ?? 'Dream pipeline session failed');
    }
  }
  return deps.db.prepare('SELECT * FROM dreams WHERE id = ?').get(dream.id) as unknown as DreamRow;
}

/**
 * The operations-tick sweep: start pending dreams that never reached a session
 * (a restart between create and start) and reconcile every running one.
 */
export async function sweepDreams(deps: DreamRunnerDeps): Promise<void> {
  const rows = deps.db.prepare(
    `SELECT * FROM dreams WHERE status IN ('pending', 'running')`,
  ).all() as unknown as DreamRow[];
  for (const row of rows) {
    try {
      await syncDream(deps, row);
    } catch {
      // A wedged reconcile must not stall the rest of the sweep.
    }
  }
}

/**
 * Cancel an active dream. The dream flips to `canceled` first so a turn ending
 * during the drain cannot race it back to completed; then the session's turn
 * is interrupted and the session archived.
 */
export async function cancelDream(deps: DreamRunnerDeps, dream: DreamRow): Promise<void> {
  if (!ACTIVE_DREAM_STATUSES.includes(dream.status)) return;
  deps.db.prepare(
    `UPDATE dreams SET status = 'canceled', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  ).run(dream.id);
  if (dream.session_id) {
    try {
      const session = deps.sessionManager.get(dream.session_id);
      if (session && (session.status === 'running' || session.status === 'retrying' || session.status === 'queued' || session.status === 'requires_action' || session.status === 'paused')) {
        await deps.sessionManager.stop(dream.session_id);
      }
      await deps.sessionManager.archive(dream.session_id);
    } catch {
      // Session teardown is best-effort; the dream's canceled state is durable.
    }
  }
}
