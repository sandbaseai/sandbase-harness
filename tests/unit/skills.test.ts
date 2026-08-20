/**
 * Unit tests for the Skills system (Requirement 4, Property 2 round-trip).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseSkill,
  serializeSkill,
  loadSkills,
  composeSystemPrompt,
  SKILL_METADATA_FILE,
  type Skill,
} from '@/core/skills/loader.js';

const SKILL_MD = `---
name: code-review
description: Reviews code for bugs and style
compatibility: Requires git and network access
---

# Code Review Skill

When reviewing code:
1. Check for bugs
2. Check style
`;

describe('Skills', () => {
  describe('parseSkill', () => {
    it('parses frontmatter and body', () => {
      const skill = parseSkill(SKILL_MD, 'package-name')!;
      expect(skill.name).toBe('code-review');
      expect(skill.description).toBe('Reviews code for bugs and style');
      expect(skill.compatibility).toBe('Requires git and network access');
      expect(skill.instructions).toContain('# Code Review Skill');
      expect(skill.instructions).toContain('Check for bugs');
    });

    it('rejects content without YAML frontmatter', () => {
      const skill = parseSkill('# Just a body, no frontmatter', 'my-skill');
      expect(skill).toBeNull();
    });

    it('rejects missing description', () => {
      const skill = parseSkill('---\nname: x\n---\nbody', 'f');
      expect(skill).toBeNull();
    });

    it('rejects invalid compatibility metadata', () => {
      expect(parseSkill('---\nname: x\ndescription: x\ncompatibility: []\n---\nbody', 'x')).toBeNull();
      expect(parseSkill(`---\nname: x\ndescription: x\ncompatibility: ${'x'.repeat(501)}\n---\nbody`, 'x')).toBeNull();
    });
  });

  describe('round-trip (Property 2)', () => {
    it('parse → serialize → parse yields semantically equivalent skill', () => {
      const first = parseSkill(SKILL_MD, 'code-review')!;
      const serialized = serializeSkill(first);
      const second = parseSkill(serialized, 'code-review')!;

      expect(second.name).toBe(first.name);
      expect(second.description).toBe(first.description);
      expect(second.compatibility).toBe(first.compatibility);
      expect(second.instructions).toBe(first.instructions);
    });
  });

  describe('loadSkills', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ma-skills-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('loads skill directories with SKILL.md', () => {
      mkdirSync(join(dir, 'code-review'));
      mkdirSync(join(dir, 'web-search'));
      writeFileSync(join(dir, 'code-review', 'SKILL.md'), SKILL_MD);
      writeFileSync(join(dir, 'web-search', 'SKILL.md'), '---\nname: web-search\ndescription: Search the web\n---\nInstructions here');
      const result = loadSkills(dir);
      expect(result.skills).toHaveLength(2);
      expect(result.skills.map((s) => s.name).sort()).toEqual(['code-review', 'web-search']);
      expect(result.skills.map((s) => s.id).sort()).toEqual(['skill_code-review', 'skill_web-search']);
    });

    it('uses persisted opaque IDs when metadata is present', () => {
      mkdirSync(join(dir, 'code-review'));
      writeFileSync(join(dir, 'code-review', 'SKILL.md'), SKILL_MD);
      writeFileSync(join(dir, 'code-review', SKILL_METADATA_FILE), JSON.stringify({
        id: 'skill_randomUploadId',
        display_title: 'Code Review Assistant',
        created_at: '2026-07-12T00:00:00.000Z',
        updated_at: '2026-07-12T00:00:00.000Z',
        latest_version: '1783852456290',
        versions: [{ id: '1783852456290', created_at: '2026-07-12T00:00:00.000Z', latest: true }],
      }));

      const result = loadSkills(dir);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].id).toBe('skill_randomUploadId');
      expect(result.skills[0].display_title).toBe('Code Review Assistant');
      expect(result.skills[0].latest_version).toBe('1783852456290');
    });

    it('reports directories without SKILL.md', () => {
      mkdirSync(join(dir, 'skill'));
      mkdirSync(join(dir, 'broken'));
      writeFileSync(join(dir, 'skill', 'SKILL.md'), SKILL_MD);
      writeFileSync(join(dir, 'readme.txt'), 'not a skill');
      const result = loadSkills(dir);
      expect(result.skills).toHaveLength(1);
      expect(result.errors).toEqual([{ file: 'broken/SKILL.md', reason: 'Missing SKILL.md' }]);
    });

    it('returns empty for a missing directory', () => {
      const result = loadSkills(join(dir, 'nonexistent'));
      expect(result.skills).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('composeSystemPrompt', () => {
    const skills: Skill[] = [
      testSkill('a', 'skill A', 'do A'),
      testSkill('b', 'skill B', 'do B'),
    ];

    it('returns base prompt unchanged when no skills assigned', () => {
      expect(composeSystemPrompt('base', undefined, skills)).toBe('base');
      expect(composeSystemPrompt('base', [], skills)).toBe('base');
    });

    it('injects only the assigned skill subset (R4.5)', () => {
      const result = composeSystemPrompt('base', ['skill_a'], skills);
      expect(result).toContain('base');
      expect(result).toContain('Skill: a');
      expect(result).toContain('do A');
      expect(result).not.toContain('do B'); // not assigned
    });

    it('ignores unknown skill names', () => {
      const result = composeSystemPrompt('base', ['nonexistent'], skills);
      expect(result).toBe('base'); // no matching skills → unchanged
    });
  });
});

function testSkill(name: string, description: string, instructions: string): Skill {
  return {
    id: `skill_${name}`,
    type: 'skill',
    name,
    display_title: name,
    description,
    compatibility: null,
    instructions,
    frontmatter: {},
    file: `${name}/SKILL.md`,
    source: 'custom',
    latest_version: '1',
    versions: [{ id: '1', created_at: null, latest: true }],
    created_at: null,
    updated_at: null,
  };
}
