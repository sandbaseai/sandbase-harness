import type { Database } from '@/core/db/database.js';
import type { Skill, SkillVersion } from './loader.js';

type SkillRow = {
  id: string;
  name: string;
  display_title: string | null;
  description: string;
  instructions: string;
  frontmatter: string;
  file: string;
  source: 'custom' | 'anthropic';
  latest_version: string | null;
  versions: string;
  storage_path: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function importSkillSeeds(db: Database, skills: Skill[]): void {
  for (const skill of skills) {
    const existing = db.prepare('SELECT id FROM skills WHERE id = ? OR (name = ? AND archived_at IS NULL)').get(
      skill.id,
      skill.name,
    );
    if (existing) continue;
    insertSkill(db, skill);
  }
}

export function insertSkill(db: Database, skill: Skill, storagePath?: string | null): void {
  db.prepare(`
    INSERT INTO skills (
      id, name, display_title, description, instructions, frontmatter, file,
      source, latest_version, versions, storage_path, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skill.id,
    skill.name,
    skill.display_title,
    skill.description,
    skill.instructions,
    JSON.stringify(skill.frontmatter ?? {}),
    skill.file,
    skill.source,
    skill.latest_version,
    JSON.stringify(skill.versions ?? []),
    storagePath ?? null,
    skill.created_at,
    skill.updated_at,
  );
}

export function loadCustomSkillsFromDb(db: Database): Skill[] {
  const rows = db.prepare(`
    SELECT *
    FROM skills
    WHERE archived_at IS NULL
      AND source = 'custom'
    ORDER BY updated_at DESC, created_at DESC, name ASC
  `).all() as unknown as SkillRow[];

  return rows.map(rowToSkill);
}

export function getSkillStoragePath(db: Database, id: string): string | null {
  const row = db.prepare('SELECT storage_path FROM skills WHERE id = ?').get(id) as
    | { storage_path: string | null }
    | undefined;
  return row?.storage_path ?? null;
}

function rowToSkill(row: SkillRow): Skill {
  const frontmatter = parseObject(row.frontmatter);
  return {
    id: row.id,
    type: 'skill',
    name: row.name,
    display_title: row.display_title,
    description: row.description,
    compatibility: compatibilityFromFrontmatter(frontmatter),
    instructions: row.instructions,
    frontmatter,
    file: row.file,
    source: row.source,
    latest_version: row.latest_version,
    versions: parseVersions(row.versions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function compatibilityFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  const value = frontmatter.compatibility;
  return typeof value === 'string' && value.trim() && value.trim().length <= 500
    ? value.trim()
    : null;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseVersions(value: string): SkillVersion[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SkillVersion[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return [];
      return [{
        id: record.id,
        created_at: typeof record.created_at === 'string' ? record.created_at : null,
        latest: record.latest === true,
      }];
    });
  } catch {
    return [];
  }
}
