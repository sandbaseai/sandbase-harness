import { describe, expect, it } from 'vitest';
import { skillPage, skillResource } from '@/api/routes/skill-resources.js';
import type { Skill } from '@/core/skills/loader.js';

describe('skill resource helpers', () => {
  it('renders standard skill resource shape', () => {
    expect(skillResource(testSkill('a'))).toMatchObject({
      id: 'skill_a',
      type: 'skill',
      name: 'a',
      compatibility: 'Requires network access',
      file: 'a/SKILL.md',
      versions: [{ id: '1', created_at: null, latest: true }],
    });
  });

  it('paginates skill resources with opaque page cursors', () => {
    const page = skillPage([testSkill('a'), testSkill('b'), testSkill('c')], '2');

    expect(page.data.map((item) => item.id)).toEqual(['skill_a', 'skill_b']);
    expect(page.has_more).toBe(true);
    expect(page.next_page).toBe(Buffer.from('2').toString('base64url'));

    const next = skillPage([testSkill('a'), testSkill('b'), testSkill('c')], '2', page.next_page ?? undefined);
    expect(next.data.map((item) => item.id)).toEqual(['skill_c']);
    expect(next.has_more).toBe(false);
  });
});

function testSkill(name: string): Skill {
  return {
    id: `skill_${name}`,
    type: 'skill',
    name,
    display_title: name,
    description: `${name} description`,
    compatibility: 'Requires network access',
    instructions: `${name} instructions`,
    frontmatter: {},
    file: `${name}/SKILL.md`,
    source: 'custom',
    latest_version: '1',
    versions: [{ id: '1', created_at: null, latest: true }],
    created_at: null,
    updated_at: null,
  };
}
