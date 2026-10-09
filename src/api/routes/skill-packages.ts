import { resolve, sep } from 'node:path';
import { buildSkillZip, extractSkillZipEntries, isIgnoredArchiveEntry } from '@/core/skills/skill-zip.js';

export { buildSkillZip } from '@/core/skills/skill-zip.js';

export type UploadedSkillFile = {
  path: string;
  content: Buffer;
};

export type NormalizedSkillPackage = {
  topLevel: string;
  files: Array<{ relativePath: string; content: Buffer }>;
  skillContent: string;
};

type JsonSkillFile = {
  path?: string;
  name?: string;
  filename?: string;
  content?: string;
  base64?: string;
};

const SKILL_DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;
const MAX_SKILL_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function readCreateSkillRequest(c: any): Promise<{ files: UploadedSkillFile[]; displayTitle?: string }> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody({ all: true });
    const files: UploadedSkillFile[] = [];
    let displayTitle: string | undefined;

    for (const [key, rawValue] of Object.entries(body)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (key === 'display_title' && typeof value === 'string') {
          displayTitle = value;
          continue;
        }
        if (!isSkillFileField(key) || !isFileLike(value)) {
          continue;
        }

        const filePath = value.webkitRelativePath || value.name;
        const content = Buffer.from(await value.arrayBuffer());
        files.push(...expandUploadedSkillFile(filePath, content));
      }
    }

    return { files, displayTitle };
  }

  const body = await c.req.json().catch(() => ({})) as { files?: JsonSkillFile[]; display_title?: string };
  const files = (body.files ?? []).map((file) => {
    const filePath = file.path ?? file.name ?? file.filename;
    if (!filePath) throw new Error('Each uploaded file must include a path.');
    if (file.base64) return expandUploadedSkillFile(filePath, Buffer.from(file.base64, 'base64'));
    if (typeof file.content === 'string') return expandUploadedSkillFile(filePath, Buffer.from(file.content, 'utf8'));
    throw new Error(`File ${filePath} must include content or base64.`);
  }).flat();
  return { files, displayTitle: body.display_title };
}

export function normalizeSkillPackage(files: UploadedSkillFile[]): NormalizedSkillPackage {
  if (files.length === 0) {
    throw new Error('files is required.');
  }

  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalBytes > MAX_SKILL_UPLOAD_BYTES) {
    throw new Error('Total skill package size must be 8MB or less.');
  }

  let topLevel: string | null = null;
  let skillContent: string | null = null;
  const normalizedFiles: NormalizedSkillPackage['files'] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.endsWith('/')) continue;
    if (isIgnoredArchiveEntry(normalizedPath)) continue;
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length < 2 || parts.some((part) => part === '..' || part === '.')) {
      throw new Error('All files must be in the same top-level directory and include SKILL.md at the root of that directory.');
    }
    if (!topLevel) {
      topLevel = parts[0];
      if (!SKILL_DIR_RE.test(topLevel)) {
        throw new Error('Top-level skill directory must use letters, numbers, dots, underscores, or hyphens.');
      }
    }
    if (parts[0] !== topLevel) {
      throw new Error('All files must be in the same top-level directory.');
    }

    const relativePath = parts.slice(1).join('/');
    if (seenPaths.has(relativePath)) {
      throw new Error(`Duplicate skill package file: ${parts.join('/')}.`);
    }
    seenPaths.add(relativePath);
    normalizedFiles.push({ relativePath, content: file.content });
    if (relativePath === 'SKILL.md') {
      skillContent = file.content.toString('utf8');
    }
  }

  if (!topLevel || !skillContent) {
    throw new Error('Upload must include SKILL.md at the root of the top-level directory.');
  }

  return { topLevel, files: normalizedFiles, skillContent };
}

export function safeJoin(root: string, relativePath: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, relativePath);
  if (targetPath !== rootPath && !targetPath.startsWith(rootPath + sep)) {
    throw new Error('Path escapes the skills directory.');
  }
  return targetPath;
}

export function isManagedSkillStoragePath(path: string, dataDir: string): boolean {
  const root = resolve(dataDir, 'skills');
  const target = resolve(path);
  return target.startsWith(root + sep);
}

function isSkillFileField(key: string): boolean {
  return key === 'files' || key === 'files[]' || key.startsWith('files.');
}

function isFileLike(value: unknown): value is { name: string; webkitRelativePath?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { name?: unknown }).name === 'string'
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function';
}

function isZipPackage(filePath: string, content: Buffer): boolean {
  const lower = filePath.toLowerCase();
  return (lower.endsWith('.zip') || lower.endsWith('.skill')) && content.length >= 4 && content.readUInt32LE(0) === 0x04034b50;
}

function expandUploadedSkillFile(filePath: string, content: Buffer): UploadedSkillFile[] {
  if (content.length > MAX_SKILL_UPLOAD_BYTES) {
    throw new Error('Total skill package size must be 8MB or less.');
  }
  return isZipPackage(filePath, content) ? extractZipEntries(content) : [{ path: filePath, content }];
}

function extractZipEntries(zip: Buffer): UploadedSkillFile[] {
  return extractSkillZipEntries(zip, MAX_SKILL_UPLOAD_BYTES);
}
