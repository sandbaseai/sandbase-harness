import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import { assertSkillPackageName, readSkillPackageDir } from '@/core/skills/package-files.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';

/**
 * Skill package materialization: the parity model puts skill *contents* under
 * `skills/<name>/` in the session workspace — metadata stays in the prompt,
 * files land where file/shell tools can reach them. These tests pin the write
 * layout, the executable-bit restore, the name/path confinement, and the
 * lifecycle bookkeeping the context builder reads.
 */

function minimalSandbox(sessionId: string): SandboxInstance {
  return {
    sessionId,
    async execute() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    async writeFile() {},
    async readFile() { return ''; },
    async listFiles() { return []; },
    async cleanup() {},
  };
}

function session(id: string): Session {
  return {
    id,
    agentId: 'agent_x',
    agentName: 'agent',
    environmentId: 'env_1',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Session;
}

function lifecycleWith(sandbox: SandboxInstance): SandboxLifecycle {
  const provider: SandboxProvider = {
    type: 'local',
    capabilities: sandboxCapabilities({ isolatedExecution: true }),
    async provision() { return sandbox; },
  };
  return new SandboxLifecycle({ sandboxProvider: provider });
}

describe('readSkillPackageDir', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('walks nested package files with slash-separated relative paths', () => {
    root = mkdtempSync(join(tmpdir(), 'ma-skillpkg-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# skill');
    writeFileSync(join(root, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n');

    const files = readSkillPackageDir(root).map((file) => file.path);
    expect(files.sort()).toEqual(['SKILL.md', 'scripts/check.sh']);
  });

  it('marks host-executable files', () => {
    root = mkdtempSync(join(tmpdir(), 'ma-skillpkg-'));
    const script = join(root, 'run.sh');
    writeFileSync(script, '#!/bin/sh\n');
    writeFileSync(join(root, 'README.md'), 'text');
    chmodSync(script, 0o755);

    const byPath = new Map(readSkillPackageDir(root).map((file) => [file.path, file.executable]));
    // NTFS has no execute bits; the flag is only meaningful where the host
    // file system can carry one, so assert the invariant rather than a
    // platform-specific value on Windows.
    if (process.platform === 'win32') {
      expect(byPath.has('run.sh')).toBe(true);
    } else {
      expect(byPath.get('run.sh')).toBe(true);
      expect(byPath.get('README.md')).toBe(false);
    }
  });
});

describe('assertSkillPackageName', () => {
  it('rejects names that would escape the skills root', () => {
    for (const name of ['..', 'a/b', 'a\\b', '.dotfile-skill', '']) {
      expect(() => assertSkillPackageName(name)).toThrow(/Skill package name/);
    }
    expect(() => assertSkillPackageName('my-skill.v2')).not.toThrow();
  });
});

describe('SandboxLifecycle skill package materialization', () => {
  it('writes package files under skills/<name>/ and restores execute bits', async () => {
    const writes: string[] = [];
    const commands: string[] = [];
    const sandbox: SandboxInstance = {
      ...minimalSandbox('sess_skills'),
      async writeFile(path) { writes.push(path); },
      async execute(command) {
        commands.push(command);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const lifecycle = lifecycleWith(sandbox);

    await lifecycle.getOrProvision(session('sess_skills'), {
      skillPackages: [{
        name: 'pdf-tools',
        files: [
          { path: 'SKILL.md', content: Buffer.from('# pdf'), executable: false },
          { path: 'scripts/convert.sh', content: Buffer.from('#!/bin/sh\n'), executable: true },
        ],
      }],
    });

    expect(writes.sort()).toEqual(['skills/pdf-tools/SKILL.md', 'skills/pdf-tools/scripts/convert.sh']);
    expect(commands).toEqual(["chmod +x -- 'skills/pdf-tools/scripts/convert.sh'"]);
    expect(lifecycle.materializedSkillPaths('sess_skills')).toEqual(['skills/pdf-tools']);
  });

  it('fails provisioning loudly on a package name that escapes skills/', async () => {
    let cleaned = 0;
    const sandbox: SandboxInstance = {
      ...minimalSandbox('sess_evil'),
      async cleanup() { cleaned += 1; },
    };
    const lifecycle = lifecycleWith(sandbox);

    await expect(lifecycle.getOrProvision(session('sess_evil'), {
      skillPackages: [{ name: '../escape', files: [{ path: 'SKILL.md', content: Buffer.from('x'), executable: false }] }],
    })).rejects.toThrow(/Skill package name/);
    expect(cleaned).toBe(1);
  });

  it('clears materialized paths on cleanup', async () => {
    const lifecycle = lifecycleWith(minimalSandbox('sess_clear'));
    await lifecycle.getOrProvision(session('sess_clear'), {
      skillPackages: [{ name: 'a', files: [{ path: 'SKILL.md', content: Buffer.from('x'), executable: false }] }],
    });
    await lifecycle.cleanup('sess_clear');
    expect(lifecycle.materializedSkillPaths('sess_clear')).toEqual([]);
  });
});
