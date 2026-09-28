import type { Database } from '@/core/db/database.js';
import { MODEL_EFFORT_LEVELS } from './model-object.js';
import { validateAgentDefinition } from './schema.js';
import type { AgentDefinition, AgentLoadError } from '@/types/agent.js';

type AgentRow = {
  id: string;
  name: string;
  definition: string;
  loaded_at?: string;
  updated_at?: string;
  status?: string;
  version?: number;
  archived_at?: string | null;
};

export function importAgentSeeds(db: Database, agents: AgentDefinition[]): AgentLoadError[] {
  const errors: AgentLoadError[] = [];

  for (const agent of agents) {
    const result = validateAgentDefinition(agent);
    if (!result.valid || !result.data) {
      errors.push({
        file: agent.name,
        reason: 'Invalid seeded agent definition',
        field: result.errors?.[0]?.path,
      });
      continue;
    }

    const id = standardAgentId(agent.name);
    const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (existing) continue;

    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      id,
      agent.name,
      JSON.stringify(agent),
    );
  }

  return errors;
}

export function loadActiveAgentRows(db: Database): AgentRow[] {
  return db
    .prepare(`
      SELECT id, name, definition, loaded_at, updated_at, status, version, archived_at
      FROM agents
      WHERE archived_at IS NULL
        AND status != 'archived'
      ORDER BY loaded_at ASC, name ASC
    `)
    .all() as unknown as AgentRow[];
}

export function loadActiveAgentsFromDb(db: Database): AgentDefinition[] {
  const rows = loadActiveAgentRows(db);
  return rows.flatMap((row) => {
    const agent = parseAgentDefinitionFromRow(row);
    return agent ? [agent] : [];
  });
}

export function loadAgentRowById(db: Database, id: string): AgentRow | undefined {
  return db.prepare(`
    SELECT id, name, definition, loaded_at, updated_at, status, version, archived_at
    FROM agents
    WHERE id = ?
  `).get(id) as AgentRow | undefined;
}

export function loadAgentDefinitionById(db: Database, id: string): AgentDefinition | undefined {
  const row = loadAgentRowById(db, id);
  if (!row || row.status === 'archived' || row.archived_at) return undefined;
  return parseAgentDefinitionFromRow(row);
}

export function parseAgentDefinitionFromRow(row: Pick<AgentRow, 'definition'>): AgentDefinition | undefined {
  try {
    const parsed = JSON.parse(row.definition) as unknown;
    const result = validateAgentDefinition(foldLegacyEffort(parsed));
    return result.valid && result.data ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold an `effort` stored beside `model_config` into the profile.
 *
 * An earlier version of `normalizeAgentDefinition` wrote the canonical level as a
 * sibling of `model_config`, where nothing read it. Re-validating such a row drops
 * the key — the definition schema is not strict and strips what it does not
 * declare — so without this the caller's level would disappear the first time the
 * row is read after an upgrade. Every agent write lands inside the profile now,
 * and the update path reads through this function too, so a legacy row is repaired
 * rather than merely tolerated; this is for what is already on disk. A profile that
 * carries its own `effort` wins, because that spelling is the current one.
 *
 * Only a value the profile could hold is folded: a hand-edited row carrying
 * something else keeps its shape and is judged by the schema, instead of this
 * function deciding that an unknown string is a level.
 */
function foldLegacyEffort(definition: unknown): unknown {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return definition;
  const record = definition as Record<string, unknown>;
  const effort = record['effort'];
  const config = record['model_config'];
  if (typeof effort !== 'string' || !effort) return definition;
  if (!MODEL_EFFORT_LEVELS.includes(effort as (typeof MODEL_EFFORT_LEVELS)[number])) return definition;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return definition;
  const profile = config as Record<string, unknown>;
  if (profile['effort'] !== undefined) return definition;
  return { ...record, model_config: { ...profile, effort } };
}

export function refreshAgentsFromDb(db: Database, target: AgentDefinition[]): AgentDefinition[] {
  const agents = loadActiveAgentsFromDb(db);
  target.length = 0;
  target.push(...agents);
  return agents;
}

function standardAgentId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `agent_${slug || 'untitled'}`;
}
