import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** One file of a skill package, in the sandbox-relative spelling it materializes under. */
export interface SkillPackageFile {
  /** `/`-separated path inside the package directory. */
  path: string;
  content: Buffer;
  /** Whether the host file carried an execute bit (POSIX mode `& 0o111`). */
  executable: boolean;
}

/** A resolved skill package: the sandbox-facing name plus every file under its root. */
export interface SkillPackage {
  name: string;
  files: SkillPackageFile[];
}

/**
 * A skill directory name must stay a single path segment: the materializer
 * joins it under `skills/`, so a name carrying a separator or a `..` component
 * would write outside the package root. Fail loudly — like repository
 * materialization, a session without the skill it declared is running against
 * a different contract than the caller asked for.
 */
export function assertSkillPackageName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Skill package name cannot be materialized as a directory: ${name}`);
  }
}

/**
 * Read a skill package directory on the host into memory.
 *
 * Regular files only: symlinks are skipped because a link target can point
 * outside the package root, and materializing it as a file would copy host
 * content the package author never declared. Relative paths are normalized to
 * `/` separators; a `..` component cannot occur from a directory walk but is
 * rejected defensively before anything reaches `writeFile`.
 */
export function readSkillPackageDir(dir: string): SkillPackageFile[] {
  const files: SkillPackageFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (posix.normalize(rel).split('/').includes('..')) {
        throw new Error(`Skill package entry escapes its root: ${rel}`);
      }
      const executable = (statSync(full).mode & 0o111) !== 0;
      files.push({ path: rel, content: readFileSync(full), executable });
    }
  };
  walk(dir, '');
  return files;
}
