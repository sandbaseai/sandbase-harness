/**
 * Unit tests for solution templates (R14, Property 18 install, Property 19 round-trip).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  installTemplate,
  createTemplate,
  listTemplates,
  readManifest,
  resolveTemplateSource,
  validateTemplate,
} from '@/core/templates/templates.js';

describe('Templates', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ma-tpl-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeProject(dir: string) {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    mkdirSync(join(dir, 'skills', 's'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'a.yaml'), 'name: a\nmodel:\n  id: m\n  speed: standard\nsystem: p\n');
    writeFileSync(join(dir, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\nbody');
  }

  describe('createTemplate', () => {
    it('exports agents/skills + manifest', () => {
      const project = join(root, 'project');
      makeProject(project);
      const tpl = join(root, 'tpl');

      const result = createTemplate(project, tpl, { name: 'my-template', description: 'test' });
      expect(existsSync(join(tpl, 'manifest.yaml'))).toBe(true);
      expect(existsSync(join(tpl, 'agents', 'a.yaml'))).toBe(true);
      expect(existsSync(join(tpl, 'skills', 's', 'SKILL.md'))).toBe(true);
      expect(result.files).toContain('manifest.yaml');

      const manifest = readManifest(tpl);
      expect(manifest.name).toBe('my-template');
    });
  });

  describe('validateTemplate', () => {
    it('accepts a valid template and reports files', () => {
      const project = join(root, 'project');
      makeProject(project);
      const tpl = join(root, 'tpl');
      createTemplate(project, tpl, { name: 'valid-template', description: 'test' });

      const result = validateTemplate(tpl);
      expect(result.valid).toBe(true);
      expect(result.files).toContain('manifest.yaml');
      // Manifest-relative identifiers are POSIX on every platform, so they are
      // written as literals here rather than joined with the host separator.
      expect(result.files).toContain('agents/a.yaml');
    });

    it('rejects invalid agent definitions', () => {
      const tpl = join(root, 'bad-agent');
      mkdirSync(join(tpl, 'agents'), { recursive: true });
      writeFileSync(join(tpl, 'manifest.yaml'), 'name: bad-agent\ndescription: bad\n');
      writeFileSync(join(tpl, 'agents', 'bad.yaml'), 'name: bad\nmodel: ""\n');

      const result = validateTemplate(tpl);
      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.path)).toContain('agents/bad.yaml');
    });

    it('rejects skill directories without SKILL.md', () => {
      const tpl = join(root, 'bad-skill');
      mkdirSync(join(tpl, 'skills', 'missing'), { recursive: true });
      writeFileSync(join(tpl, 'manifest.yaml'), 'name: bad-skill\ndescription: bad\n');
      writeFileSync(join(tpl, 'skills', 'missing', 'notes.md'), 'notes');

      const result = validateTemplate(tpl);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'skills/missing' }));
    });

    it('rejects manifest-only templates', () => {
      const tpl = join(root, 'empty');
      mkdirSync(tpl, { recursive: true });
      writeFileSync(join(tpl, 'manifest.yaml'), 'name: empty\ndescription: empty\n');

      const result = validateTemplate(tpl);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: '.' }));
    });
  });

  describe('installTemplate (Property 18)', () => {
    it('places files byte-identically in the target project', () => {
      const source = join(root, 'source');
      makeProject(source);
      const tpl = join(root, 'tpl');
      createTemplate(source, tpl, { name: 't', description: '' });

      const target = join(root, 'target');
      mkdirSync(target, { recursive: true });
      const result = installTemplate(tpl, target);

      expect(result.installed).toContain('agents/a.yaml');
      expect(result.installed).toContain('skills/s/SKILL.md');

      // Byte-identical
      expect(readFileSync(join(target, 'agents', 'a.yaml'), 'utf-8')).toBe(
        readFileSync(join(source, 'agents', 'a.yaml'), 'utf-8'),
      );
    });

    it('skips existing files unless --force', () => {
      const source = join(root, 'source');
      makeProject(source);
      const tpl = join(root, 'tpl');
      createTemplate(source, tpl, { name: 't', description: '' });

      const target = join(root, 'target');
      mkdirSync(join(target, 'agents'), { recursive: true });
      writeFileSync(join(target, 'agents', 'a.yaml'), 'PREEXISTING');

      const skip = installTemplate(tpl, target);
      expect(skip.skipped).toContain('agents/a.yaml');
      expect(readFileSync(join(target, 'agents', 'a.yaml'), 'utf-8')).toBe('PREEXISTING');

      const force = installTemplate(tpl, target, { force: true });
      expect(force.installed).toContain('agents/a.yaml');
      expect(readFileSync(join(target, 'agents', 'a.yaml'), 'utf-8')).not.toBe('PREEXISTING');
    });

    it('throws for a template without a manifest', () => {
      const bad = join(root, 'bad');
      mkdirSync(bad, { recursive: true });
      expect(() => installTemplate(bad, join(root, 'target'))).toThrow(/manifest/);
    });
  });

  describe('round-trip (Property 19)', () => {
    it('create → install reproduces the original files', () => {
      const source = join(root, 'source');
      makeProject(source);
      const tpl = join(root, 'tpl');
      createTemplate(source, tpl, { name: 't', description: '' });

      const dest = join(root, 'dest');
      mkdirSync(dest, { recursive: true });
      installTemplate(tpl, dest);

      for (const f of ['agents/a.yaml', 'skills/s/SKILL.md']) {
        expect(readFileSync(join(dest, f), 'utf-8')).toBe(readFileSync(join(source, f), 'utf-8'));
      }
    });
  });

  describe('resolveTemplateSource', () => {
    it('returns a local path directly when it has a manifest', async () => {
      const project = join(root, 'p');
      makeProject(project);
      const tpl = join(root, 'tpl');
      createTemplate(project, tpl, { name: 't', description: '' });

      const resolved = await resolveTemplateSource(tpl, { cacheDir: join(root, 'cache') });
      expect(resolved).toBe(tpl);
    });
  });

  describe('listTemplates', () => {
    it('lists template subdirectories with valid manifests', () => {
      const repo = join(root, 'repo');
      const t1 = join(repo, 'one');
      const t2 = join(repo, 'two');
      makeProject(join(root, 'p'));
      createTemplate(join(root, 'p'), t1, { name: 'one', description: 'first' });
      createTemplate(join(root, 'p'), t2, { name: 'two', description: 'second' });

      const items = listTemplates(repo);
      expect(items.map((t) => t.name).sort()).toEqual(['one', 'two']);
    });

    it('returns empty for a missing directory', () => {
      expect(listTemplates(join(root, 'nope'))).toEqual([]);
    });
  });
});
