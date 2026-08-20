import type { Skill } from './loader.js';

export const BUILTIN_SKILLS: Skill[] = [
  builtinSkill({
    id: 'xlsx',
    description: 'Work with spreadsheets, formulas, tables, charts, and workbook data.',
    latestVersion: '20260710',
    updatedAt: '2026-07-10T00:00:00.000Z',
    versions: ['20260710', '20260709', '20260702', '20260701', '20260623', '20260622'],
  }),
  builtinSkill({
    id: 'pptx',
    description: 'Create, inspect, and edit presentations, slide decks, templates, layouts, speaker notes, and comments.',
    latestVersion: '20260710',
    updatedAt: '2026-07-10T00:00:00.000Z',
    versions: ['20260710', '20260709', '20260702', '20260701', '20260623', '20260622', '20260608', '20260304', '20260203', '20260128', '20260127', '20260125', '20260122'],
  }),
  builtinSkill({
    id: 'pdf',
    description: 'Read, create, inspect, render, and verify PDF files when extraction or visual layout matters.',
    latestVersion: '20260709',
    updatedAt: '2026-07-09T00:00:00.000Z',
    versions: ['20260709', '20260702', '20260701', '20260623', '20260608', '20260304'],
  }),
  builtinSkill({
    id: 'docx',
    description: 'Create, edit, review, and convert Word documents while preserving document structure and layout.',
    latestVersion: '20260710',
    updatedAt: '2026-07-10T00:00:00.000Z',
    versions: ['20260710', '20260709', '20260702', '20260701', '20260623', '20260608'],
  }),
];

function builtinSkill(input: {
  id: string;
  description: string;
  latestVersion: string;
  updatedAt: string;
  versions: string[];
}): Skill {
  return {
    id: input.id,
    type: 'skill',
    name: input.id,
    display_title: input.id,
    description: input.description,
    compatibility: null,
    instructions: '',
    frontmatter: {},
    file: '',
    source: 'anthropic',
    latest_version: input.latestVersion,
    versions: input.versions.map((version, index) => ({
      id: version,
      created_at: versionToIso(version),
      latest: index === 0,
    })),
    created_at: input.versions.at(-1) ? versionToIso(input.versions.at(-1)!) : input.updatedAt,
    updated_at: input.updatedAt,
  };
}

function versionToIso(version: string): string | null {
  if (!/^\d{8}$/.test(version)) return null;
  const year = version.slice(0, 4);
  const month = version.slice(4, 6);
  const day = version.slice(6, 8);
  return `${year}-${month}-${day}T00:00:00.000Z`;
}
