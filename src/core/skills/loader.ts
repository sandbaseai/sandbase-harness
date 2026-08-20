/**
 * Skills Loader (Requirement 4)
 *
 * Loads skill directories from a project's skills/ directory. Each skill uses
 * a SKILL.md file with YAML frontmatter (name, description, ...) followed by a
 * markdown body of instructions.
 *
 * Skills are injected into an agent's system prompt so the model knows the
 * available capabilities up-front (no read-tool round-trip needed).
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillSource = 'custom' | 'anthropic';

export interface SkillVersion {
  id: string;
  created_at: string | null;
  latest: boolean;
}

export interface Skill {
  /** Public skill identifier. Custom skills use the `skill_` prefix. */
  id: string;
  /** Object type. */
  type: 'skill';
  /** Unique skill name from frontmatter. */
  name: string;
  /** Human-readable label not injected into the model prompt. */
  display_title: string | null;
  /** Short description (from frontmatter `description`). */
  description: string;
  /** Optional Agent Skills environment requirements. */
  compatibility: string | null;
  /** Markdown body - the instructions the model should follow. */
  instructions: string;
  /** Original frontmatter (preserved for round-trip). */
  frontmatter: Record<string, unknown>;
  /** Source file path relative to the skills directory. */
  file: string;
  /** Skill provenance. */
  source: SkillSource;
  /** Latest version identifier for this skill. */
  latest_version: string | null;
  /** Version history known to this runtime. */
  versions: SkillVersion[];
  /** ISO timestamp of when the skill was created. */
  created_at: string | null;
  /** ISO timestamp of when the skill was last updated. */
  updated_at: string | null;
}

export interface SkillLoadError {
  file: string;
  reason: string;
}

export interface SkillLoadResult {
  skills: Skill[];
  errors: SkillLoadError[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
export const SKILL_METADATA_FILE = '.managed-agent-skill.json';

type SkillMetadata = Partial<Pick<Skill, 'id' | 'display_title' | 'created_at' | 'updated_at' | 'latest_version' | 'versions'>>;

export function createSkillId(): string {
  return `skill_${randomBytes(18).toString('base64url')}`;
}

export function customSkillId(name: string): string {
  return `skill_${name}`;
}

/**
 * Parse a SKILL.md string into a structured Skill.
 * Returns null if required fields are missing.
 */
export function parseSkill(content: string, packageName: string, file = `${packageName}/SKILL.md`, id = customSkillId(packageName)): Skill | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return null;
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!name || !description) {
    return null;
  }
  const compatibility = readCompatibility(frontmatter);
  if (frontmatter.compatibility !== undefined && compatibility === null) {
    return null;
  }

  const displayTitle = typeof frontmatter.display_title === 'string' && frontmatter.display_title.trim()
    ? frontmatter.display_title.trim()
    : name;

  return {
    id,
    type: 'skill',
    name,
    display_title: displayTitle,
    description,
    compatibility,
    instructions: (match[2] ?? '').trim(),
    frontmatter,
    file,
    source: 'custom',
    latest_version: null,
    versions: [],
    created_at: null,
    updated_at: null,
  };
}

/**
 * Serialize a Skill back to SKILL.md format (Property 2 round-trip support).
 */
export function serializeSkill(skill: Skill): string {
  const fm = { name: skill.name, description: skill.description, ...skill.frontmatter };
  // Ensure name/description reflect the current values
  fm.name = skill.name;
  fm.description = skill.description;
  const yamlLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  return `---\n${yamlLines}\n---\n\n${skill.instructions}\n`;
}

/**
 * Load all skills from a directory. Each custom skill is a top-level directory
 * containing a SKILL.md file.
 * Malformed skills are skipped with an error.
 */
export function loadSkills(skillsDir: string): SkillLoadResult {
  const skills: Skill[] = [];
  const errors: SkillLoadError[] = [];

  if (!existsSync(skillsDir)) {
    return { skills, errors };
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  for (const entry of entries) {
    try {
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) {
        errors.push({ file: `${entry.name}/SKILL.md`, reason: 'Missing SKILL.md' });
        continue;
      }

      const content = readFileSync(skillFile, 'utf-8');
      const metadata = readSkillMetadata(join(skillsDir, entry.name));
      const skill = parseSkill(content, entry.name, `${entry.name}/SKILL.md`, metadata?.id);
      if (skill) {
        const stat = statSync(skillFile);
        const updatedAt = stat.mtime.toISOString();
        const createdAt = stat.birthtime.toISOString();
        const version = String(Math.trunc(stat.mtimeMs));
        skill.created_at = metadata?.created_at ?? createdAt;
        skill.updated_at = metadata?.updated_at ?? updatedAt;
        skill.latest_version = metadata?.latest_version ?? version;
        skill.display_title = metadata?.display_title ?? skill.display_title;
        skill.versions = metadata?.versions?.length
          ? metadata.versions
          : [{ id: skill.latest_version, created_at: skill.updated_at, latest: true }];
        skills.push(skill);
      } else {
        errors.push({ file: `${entry.name}/SKILL.md`, reason: 'SKILL.md must include YAML frontmatter with name and description' });
      }
    } catch (err) {
      errors.push({ file: `${entry.name}/SKILL.md`, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { skills, errors };
}

/**
 * Build the full system prompt for an agent by appending its assigned skills'
 * instructions to the base system. Only the named subset is included
 * (R4.5). Unknown skill names are ignored by the caller (warned at load time).
 */
export function composeSystemPrompt(
  basePrompt: string,
  assignedSkillNames: string[] | undefined,
  allSkills: Skill[],
): string {
  if (!assignedSkillNames || assignedSkillNames.length === 0) {
    return basePrompt;
  }

  const assigned = allSkills.filter((s) => assignedSkillNames.includes(s.id) || assignedSkillNames.includes(s.name));
  if (assigned.length === 0) {
    return basePrompt;
  }

  const skillSections = assigned
    .map((s) => `## Skill: ${s.name}\n${s.description ? s.description + '\n\n' : ''}${s.instructions}`)
    .join('\n\n');

  return `${basePrompt}\n\n# Available Skills\n\nYou have the following skills available. Use them when relevant:\n\n${skillSections}`;
}

function readSkillMetadata(skillDir: string): SkillMetadata | null {
  const metadataPath = join(skillDir, SKILL_METADATA_FILE);
  if (!existsSync(metadataPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
    const id = readString(raw.id);
    if (!id?.startsWith('skill_')) return null;

    const versions = Array.isArray(raw.versions)
      ? raw.versions.flatMap((item): SkillVersion[] => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        const versionId = readString(value.id);
        if (!versionId) return [];
        return [{
          id: versionId,
          created_at: readString(value.created_at),
          latest: value.latest === true,
        }];
      })
      : undefined;

    return {
      id,
      display_title: readString(raw.display_title),
      created_at: readString(raw.created_at),
      updated_at: readString(raw.updated_at),
      latest_version: readString(raw.latest_version),
      versions,
    };
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCompatibility(frontmatter: Record<string, unknown>): string | null {
  const compatibility = readString(frontmatter.compatibility);
  return compatibility && compatibility.length <= 500 ? compatibility : null;
}
