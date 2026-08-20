import type { ServerDeps } from '../server.js';
import { BUILTIN_SKILLS } from '@/core/skills/catalog.js';
import { createSkillId, type Skill } from '@/core/skills/loader.js';

export type SkillSourceFilter = 'custom' | 'anthropic';

export function listSkillResources(deps: ServerDeps, source?: SkillSourceFilter): Skill[] {
  const customSkills = [...(deps.skills ?? [])].sort(compareSkillsByUpdatedAtDesc);
  const skills = [...customSkills, ...BUILTIN_SKILLS];
  return source ? skills.filter((skill) => skill.source === source) : skills;
}

export function skillResource(skill: Skill) {
  return {
    id: skill.id,
    created_at: skill.created_at,
    display_title: skill.display_title,
    latest_version: skill.latest_version,
    source: skill.source,
    type: skill.type,
    updated_at: skill.updated_at,
    name: skill.name,
    description: skill.description,
    compatibility: skill.compatibility,
    file: skill.file || null,
    versions: skill.versions,
  };
}

export function skillPage(skills: Skill[], limitQuery?: string, pageQuery?: string) {
  const limit = Math.max(1, Math.min(Number(limitQuery ?? 20) || 20, 100));
  const offset = decodePage(pageQuery);
  const data = skills.slice(offset, offset + limit).map(skillResource);
  const nextOffset = offset + limit;
  return {
    data,
    has_more: nextOffset < skills.length,
    next_page: nextOffset < skills.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

export function findSkill(deps: ServerDeps, id: string): Skill | undefined {
  return listSkillResources(deps).find((skill) => skill.id === id);
}

export function createUniqueSkillId(existingSkills: Skill[]): string {
  let id = createSkillId();
  while (existingSkills.some((skill) => skill.id === id)) {
    id = createSkillId();
  }
  return id;
}

export function materializeCustomSkill(skill: Skill, displayTitle?: string): Skill {
  const now = new Date().toISOString();
  const version = String(Date.now());
  return {
    ...skill,
    display_title: displayTitle?.trim() || skill.display_title || skill.name,
    created_at: now,
    updated_at: now,
    latest_version: version,
    versions: [{ id: version, created_at: now, latest: true }],
  };
}

function decodePage(page?: string): number {
  if (!page) return 0;
  const parsed = Number(Buffer.from(page, 'base64url').toString('utf8'));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function compareSkillsByUpdatedAtDesc(a: Skill, b: Skill): number {
  return timestampMs(b.updated_at) - timestampMs(a.updated_at);
}

function timestampMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
