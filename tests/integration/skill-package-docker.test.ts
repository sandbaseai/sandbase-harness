import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import { readSkillPackageDir } from '@/core/skills/package-files.js';
import { DockerSandboxProvider, isDockerAvailable } from '@/sandbox/docker-provider.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';

/**
 * The container half of skill package materialization: a package read off the
 * host must land at `/workspace/skills/<name>/` inside a real container, with
 * scripts runnable through the sandbox's own command channel — the parity
 * contract a self-hosted worker's `<workdir>/skills/<name>/` mirrors.
 */

function findLocalImage(): string | undefined {
  try {
    const r = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (r.status !== 0) return undefined;
    const images = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.includes('<none>') && !l.includes(':<none>'));
    for (const image of images) {
      const probe = spawnSync(
        'docker',
        ['run', '--rm', '--entrypoint', 'sleep', image, '0'],
        { stdio: 'ignore', timeout: 15_000 },
      );
      if (probe.status === 0) return image;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const dockerImage = isDockerAvailable() ? findLocalImage() : undefined;
const dockerSuite = dockerImage ? describe : describe.skip;

dockerSuite('skill package materialization into a real docker sandbox', { timeout: 180_000 }, () => {
  let root: string;
  let sandbox: SandboxInstance;
  let lifecycle: SandboxLifecycle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ma-skill-docker-'));
    const pkgDir = join(root, 'pkg');
    mkdirSync(join(pkgDir, 'scripts'), { recursive: true });
    writeFileSync(join(pkgDir, 'SKILL.md'), '# pdf tools\n');
    writeFileSync(join(pkgDir, 'scripts', 'hello.sh'), '#!/bin/sh\necho skill-ran\n');
    chmodSync(join(pkgDir, 'scripts', 'hello.sh'), 0o755);

    const provider = new DockerSandboxProvider();
    lifecycle = new SandboxLifecycle({
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({
        name: 'docker',
        sandbox_provider: 'docker',
        timeout: 60,
        image: dockerImage,
      }),
    });
    sandbox = await lifecycle.getOrProvision(
      {
        id: 'sess_skill_docker',
        agentId: 'agent_x',
        agentName: 'agent',
        environmentId: 'env_docker',
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Session,
      { skillPackages: [{ name: 'pdf-tools', files: readSkillPackageDir(pkgDir) }] },
    );
  }, 120_000);

  afterEach(async () => {
    await lifecycle?.cleanup('sess_skill_docker');
    rmSync(root, { recursive: true, force: true });
  });

  it('materializes the package at /workspace/skills/<name>/ and runs its script', async () => {
    expect((await sandbox.readFile('/workspace/skills/pdf-tools/SKILL.md')).trim())
      .toBe('# pdf tools');

    const listing = await sandbox.listFiles('/workspace/skills');
    expect(listing.sort()).toEqual(['skills/pdf-tools/SKILL.md', 'skills/pdf-tools/scripts/hello.sh']);

    // The host execute bit was restored in the container, so the script runs
    // directly — the reason packages ship as files and not only prompt text.
    const run = await sandbox.execute('sh skills/pdf-tools/scripts/hello.sh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('skill-ran');

    expect(lifecycle.materializedSkillPaths('sess_skill_docker')).toEqual(['skills/pdf-tools']);
  });
});
