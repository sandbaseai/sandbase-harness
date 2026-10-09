import { Hono } from 'hono';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ServerDeps } from '../server.js';
import { offsetCursorPage } from '../standard.js';
import {
  createSkillVersionId,
  parseSkill,
  SKILL_METADATA_FILE,
  type Skill,
  type SkillVersion,
} from '@/core/skills/loader.js';
import {
  deleteSkillVersion,
  getSkillStoragePath,
  getSkillVersion,
  insertSkill,
  insertSkillVersion,
  listSkillVersions,
  nextSkillVersionSeq,
  updateSkillVersionCache,
  type SkillVersionRow,
} from '@/core/skills/store.js';
import {
  buildSkillZip,
  isManagedSkillStoragePath,
  normalizeSkillPackage,
  readCreateSkillRequest,
  safeJoin,
} from './skill-packages.js';
import {
  createUniqueSkillId,
  findSkill,
  listSkillResources,
  materializeCustomSkill,
  skillPage,
  skillResource,
  skillVersionResource,
  type SkillSourceFilter,
} from './skill-resources.js';
import { rejectUnexpectedQueryParams } from './query-params.js';

export function skillsRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['source', 'limit', 'page']);
    if (rejected) return rejected;
    const source = c.req.query('source');
    if (source && source !== 'custom' && source !== 'anthropic') {
      return c.json({ error: { type: 'invalid_request_error', message: 'source must be custom or anthropic' } }, 400);
    }
    const page = skillPage(listSkillResources(deps, source as SkillSourceFilter | undefined), {
      limit: c.req.query('limit'),
      page: c.req.query('page'),
      source: source as SkillSourceFilter | undefined,
    });
    if (!page.ok) return c.json({ error: { type: 'invalid_request_error', message: page.message } }, 400);
    return c.json(page.page);
  });

  app.post('/', async (c) => {
    if (!deps.workspace?.dataDir) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Workspace data directory is not configured' } }, 400);
    }

    try {
      const { files, displayTitle } = await readCreateSkillRequest(c);
      const skillPackage = normalizeSkillPackage(files);
      const existingSkills = listSkillResources(deps);
      const skillId = createUniqueSkillId(existingSkills);
      const parsed = parseSkill(skillPackage.skillContent, skillPackage.topLevel, `${skillPackage.topLevel}/SKILL.md`, skillId);
      if (!parsed) {
        const message = skillPackage.skillContent.startsWith('---')
          ? 'SKILL.md frontmatter must include name and description.'
          : 'SKILL.md must start with YAML frontmatter (---).';
        return c.json({ error: { type: 'invalid_request_error', message } }, 400);
      }
      if (existingSkills.some((skill) => skill.name === parsed.name)) {
        return c.json({ error: { type: 'conflict', message: `Skill name ${parsed.name} already exists` } }, 409);
      }

      const skillDir = safeJoin(resolve(deps.workspace.dataDir, 'skills'), skillId);
      for (const file of skillPackage.files) {
        const outputPath = safeJoin(skillDir, file.relativePath);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, file.content);
      }

      const saved = materializeCustomSkill(parsed, displayTitle);
      insertSkill(deps.db, saved, skillDir);
      // A skill holds at least one version from the moment it exists: the
      // upload that created it is seq 1, so the version routes answer
      // consistently for every skill rather than only ones that grew.
      insertSkillVersion(deps.db, {
        id: saved.latest_version!,
        skill_id: saved.id,
        seq: 1,
        name: saved.name,
        description: saved.description,
        storage_path: skillDir,
        created_at: saved.created_at!,
      });
      deps.skills ??= [];
      deps.skills.push(saved);
      return c.json(skillResource(saved), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { type: 'invalid_request_error', message } }, 400);
    }
  });

  app.get('/:skillId', (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    return c.json(skillResource(skill));
  });

  app.delete('/:skillId', (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    if (skill.source === 'anthropic') {
      return c.json({ error: { type: 'invalid_request_error', message: 'Anthropic skills are built-in and cannot be deleted' } }, 400);
    }

    deps.db.prepare(`
      UPDATE skills
      SET archived_at = COALESCE(archived_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(skill.id);
    const storagePath = getSkillStoragePath(deps.db, skill.id);
    if (storagePath && deps.workspace?.dataDir && isManagedSkillStoragePath(storagePath, deps.workspace.dataDir)) {
      rmSync(storagePath, { recursive: true, force: true });
    }
    if (deps.skills) {
      const index = deps.skills.findIndex((item) => item.id === skill.id);
      if (index >= 0) deps.skills.splice(index, 1);
    }
    return c.json({ id: skill.id, type: 'skill_deleted' });
  });

  app.get('/:skillId/versions', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'page']);
    if (rejected) return rejected;
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    // Built-in skills have no `skill_versions` rows; their version metadata
    // lives in the catalog and projects the same shape read-only.
    const versions = skill.source === 'custom'
      ? listSkillVersions(deps.db, skill.id).map((row) => skillVersionResource(skill, row))
      : skill.versions.map((version) => skillVersionResource(skill, { ...version, description: skill.description }));
    const page = offsetCursorPage(versions, {
      limit: c.req.query('limit'),
      page: c.req.query('page'),
      filter: { skill_id: skill.id },
    });
    if (!page.ok) return c.json({ error: { type: 'invalid_request_error', message: page.message } }, 400);
    return c.json(page.page);
  });

  app.post('/:skillId/versions', async (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    if (skill.source !== 'custom') {
      return c.json({ error: { type: 'invalid_request_error', message: 'Anthropic skills are built-in and cannot accept new versions' } }, 400);
    }
    if (!deps.workspace?.dataDir) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Workspace data directory is not configured' } }, 400);
    }

    try {
      const { files } = await readCreateSkillRequest(c);
      const skillPackage = normalizeSkillPackage(files);
      const parsed = parseSkill(skillPackage.skillContent, skillPackage.topLevel, `${skillPackage.topLevel}/SKILL.md`, skill.id);
      if (!parsed) {
        const message = skillPackage.skillContent.startsWith('---')
          ? 'SKILL.md frontmatter must include name and description.'
          : 'SKILL.md must start with YAML frontmatter (---).';
        return c.json({ error: { type: 'invalid_request_error', message } }, 400);
      }
      // The skill's slug is fixed at creation; a version whose package names
      // something else would fork the identity the route addresses.
      if (parsed.name !== skill.name) {
        return c.json({
          error: {
            type: 'conflict',
            message: `Skill version name ${parsed.name} does not match skill name ${skill.name}`,
          },
        }, 409);
      }

      const versionId = createSkillVersionId();
      const seq = nextSkillVersionSeq(deps.db, skill.id);
      const versionDir = safeJoin(resolve(deps.workspace.dataDir, 'skills', skill.id), join('versions', versionId));
      for (const file of skillPackage.files) {
        const outputPath = safeJoin(versionDir, file.relativePath);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, file.content);
      }

      const createdAt = new Date().toISOString();
      insertSkillVersion(deps.db, {
        id: versionId,
        skill_id: skill.id,
        seq,
        name: skill.name,
        description: parsed.description,
        storage_path: versionDir,
        created_at: createdAt,
      });
      // The skill row tracks its newest version: the uploaded SKILL.md is now
      // what unpinned references resolve to.
      updateSkillVersionCache(deps.db, skill.id, {
        latestVersion: versionId,
        versions: cacheVersions(listSkillVersions(deps.db, skill.id), versionId),
        updatedAt: createdAt,
        description: parsed.description,
        instructions: parsed.instructions,
        frontmatter: JSON.stringify(parsed.frontmatter ?? {}),
        file: `${skillPackage.topLevel}/SKILL.md`,
      });
      refreshSkillInMemory(deps.db, skill, versionId, createdAt, {
        description: parsed.description,
        instructions: parsed.instructions,
        frontmatter: parsed.frontmatter,
        file: `${skillPackage.topLevel}/SKILL.md`,
      });
      const row = getSkillVersion(deps.db, skill.id, versionId)!;
      return c.json(skillVersionResource(skill, row), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { type: 'invalid_request_error', message } }, 400);
    }
  });

  app.get('/:skillId/versions/:versionId', (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    const versionId = c.req.param('versionId');
    if (skill.source !== 'custom') {
      const version = skill.versions.find((item) => item.id === versionId);
      if (!version) {
        return c.json({ error: { type: 'not_found', message: 'Skill version not found' } }, 404);
      }
      return c.json(skillVersionResource(skill, { ...version, description: skill.description }));
    }
    const row = getSkillVersion(deps.db, skill.id, versionId);
    if (!row) {
      return c.json({ error: { type: 'not_found', message: 'Skill version not found' } }, 404);
    }
    return c.json(skillVersionResource(skill, row));
  });

  app.delete('/:skillId/versions/:versionId', (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    if (skill.source !== 'custom') {
      return c.json({ error: { type: 'invalid_request_error', message: 'Anthropic skills are built-in and their versions cannot be deleted' } }, 400);
    }
    const versionId = c.req.param('versionId');
    const rows = listSkillVersions(deps.db, skill.id);
    const row = rows.find((item) => item.id === versionId);
    if (!row) {
      return c.json({ error: { type: 'not_found', message: 'Skill version not found' } }, 404);
    }
    if (rows.length === 1) {
      return c.json({ error: { type: 'conflict', message: 'A skill must keep at least one version.' } }, 409);
    }

    deleteSkillVersion(deps.db, skill.id, versionId);
    if (deps.workspace?.dataDir) {
      removeVersionFiles(row.storage_path, skill.id, deps.workspace.dataDir);
    }

    const remaining = rows.filter((item) => item.id !== versionId);
    const updatedAt = new Date().toISOString();
    if (skill.latest_version === versionId) {
      // Deleting the latest version repoints `latest` at the newest survivor;
      // the skill's content fields return to that version's SKILL.md.
      const next = remaining[0];
      const promoted = readVersionPackageMetadata(next.storage_path);
      updateSkillVersionCache(deps.db, skill.id, {
        latestVersion: next.id,
        versions: cacheVersions(remaining, next.id),
        updatedAt,
        description: next.description,
        ...(promoted
          ? {
              instructions: promoted.instructions,
              frontmatter: JSON.stringify(promoted.frontmatter ?? {}),
            }
          : {}),
      });
      refreshSkillInMemory(deps.db, skill, next.id, updatedAt, {
        description: next.description,
        ...(promoted
          ? { instructions: promoted.instructions, frontmatter: promoted.frontmatter }
          : {}),
      });
    } else {
      updateSkillVersionCache(deps.db, skill.id, {
        latestVersion: skill.latest_version!,
        versions: cacheVersions(remaining, skill.latest_version!),
        updatedAt,
      });
      refreshSkillInMemory(deps.db, skill, skill.latest_version!, updatedAt, {});
    }
    return c.json({ id: versionId, type: 'skill_version_deleted' });
  });

  app.get('/:skillId/versions/:versionId/content', (c) => {
    const skill = findSkill(deps, c.req.param('skillId'));
    if (!skill) {
      return c.json({ error: { type: 'not_found', message: 'Skill not found' } }, 404);
    }
    if (skill.source !== 'custom') {
      return c.json({ error: { type: 'not_found', message: 'Skill version content is not stored for built-in skills' } }, 404);
    }
    // `latest` is accepted so a caller that knows the skill but not its
    // current version id (a self-hosted worker holding an unpinned agent
    // reference) can still address the newest package.
    const requestedVersion = c.req.param('versionId');
    const row = getSkillVersion(
      deps.db,
      skill.id,
      requestedVersion === 'latest' ? (skill.latest_version ?? requestedVersion) : requestedVersion,
    );
    if (!row || !row.storage_path || !deps.workspace?.dataDir) {
      return c.json({ error: { type: 'not_found', message: 'Skill version not found' } }, 404);
    }
    const skillsRoot = resolve(deps.workspace.dataDir, 'skills');
    const versionDir = resolve(row.storage_path);
    // The stored path was written by this runtime, but a row that no longer
    // resolves under the managed skills root is refused rather than served.
    if (versionDir !== skillsRoot && !versionDir.startsWith(`${skillsRoot}${sep}`)) {
      return c.json({ error: { type: 'not_found', message: 'Skill version content not found' } }, 404);
    }
    if (!existsSync(versionDir)) {
      return c.json({ error: { type: 'not_found', message: 'Skill version content not found' } }, 404);
    }

    const entries = collectVersionFiles(versionDir, resolve(skillsRoot, skill.id));
    const zip = buildSkillZip(
      entries.map((entry) => ({
        path: `${skill.name}/${entry.relativePath}`,
        content: entry.content,
        executable: entry.executable,
      })),
    );
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${skill.name}.zip"`,
      },
    });
  });

  return app;
}

/**
 * The `skills.versions` JSON cache stays the legacy `{id, created_at, latest}`
 * shape — `skill_versions` is the record of truth and the JSON exists for
 * readers that predate the table.
 */
function cacheVersions(rows: SkillVersionRow[], latestId: string): SkillVersion[] {
  return rows.map((row) => ({ id: row.id, created_at: row.created_at, latest: row.id === latestId }));
}

/**
 * Rebuild one in-memory skill after a version write so `deps.skills` and the
 * projected resource agree with the table without a reload. Versions come
 * back from `skill_versions` rather than by patching the old list, so an
 * added or removed id can never linger.
 */
function refreshSkillInMemory(
  db: ServerDeps['db'],
  skill: Skill,
  latestId: string,
  updatedAt: string,
  patch: Partial<Pick<Skill, 'description' | 'instructions' | 'frontmatter' | 'file'>>,
): void {
  skill.latest_version = latestId;
  skill.updated_at = updatedAt;
  skill.description = patch.description ?? skill.description;
  skill.instructions = patch.instructions ?? skill.instructions;
  skill.frontmatter = patch.frontmatter ?? skill.frontmatter;
  skill.file = patch.file ?? skill.file;
  skill.versions = listSkillVersions(db, skill.id).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    latest: row.id === latestId,
    ...(row.storage_path ? { storage_path: row.storage_path } : {}),
  }));
}

/**
 * Re-read a promoted version's SKILL.md so the skill-level fields return to
 * the package that now heads the list. Returns null when the package is not
 * readable on this host (e.g. seeded skills with no managed storage path).
 */
function readVersionPackageMetadata(
  storagePath: string,
): { instructions: string; frontmatter: Record<string, unknown> } | null {
  if (!storagePath) return null;
  try {
    const content = readFileSync(join(storagePath, 'SKILL.md'), 'utf8');
    const parsed = parseSkill(content, 'skill', 'skill/SKILL.md', 'skill_readback');
    if (!parsed) return null;
    return { instructions: parsed.instructions, frontmatter: parsed.frontmatter };
  } catch {
    return null;
  }
}

/**
 * Remove a deleted version's files. Versions uploaded after this feature
 * live under `…/skills/<skill>/versions/<version>` and are removed whole; a
 * pre-migration version instead occupies the skill root, where deleting the
 * directory would also remove the surviving versions — so only its package
 * entries are removed and the `versions/` subtree is preserved.
 */
function removeVersionFiles(storagePath: string, skillId: string, dataDir: string): void {
  if (!storagePath || !isManagedSkillStoragePath(storagePath, dataDir)) return;
  const skillRoot = resolve(dataDir, 'skills', skillId);
  const target = resolve(storagePath);
  if (target === skillRoot) {
    for (const entry of readdirSync(skillRoot)) {
      if (entry === 'versions' || entry === SKILL_METADATA_FILE) continue;
      rmSync(join(skillRoot, entry), { recursive: true, force: true });
    }
    return;
  }
  if (target.startsWith(`${resolve(skillRoot, 'versions')}${sep}`)) {
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Read one version's package into zip entries. A legacy version whose
 * storage path is the skill root shares it with the `versions/` subtree of
 * newer uploads and the runtime's sidecar metadata file, neither of which is
 * package content.
 */
function collectVersionFiles(
  versionDir: string,
  skillRoot: string,
): Array<{ relativePath: string; content: Buffer; executable: boolean }> {
  const isLegacyRoot = versionDir === skillRoot;
  const entries: Array<{ relativePath: string; content: Buffer; executable: boolean }> = [];

  const walk = (dir: string, prefix: string, topLevel: boolean): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (topLevel && isLegacyRoot && (item.name === 'versions' || item.name === SKILL_METADATA_FILE)) {
        continue;
      }
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, rel, false);
      } else if (item.isFile()) {
        entries.push({ relativePath: rel, content: readFileSync(full), executable: (statSync(full).mode & 0o111) !== 0 });
      }
    }
  };
  walk(versionDir, '', true);
  return entries;
}
