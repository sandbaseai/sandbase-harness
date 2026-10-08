/**
 * Tests for the sandbox provider registry and Docker provider (R12.3, R12.4).
 *
 * Registry tests always run. Real container execution tests run only when the
 * `docker` CLI is available (skipped otherwise).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxProviderRegistry } from '@/sandbox/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DockerSandboxProvider, dockerWorkspacePath, isDockerAvailable } from '@/sandbox/docker-provider.js';

/**
 * Find a locally-cached Docker image so tests don't require registry access.
 *
 * The provider provisions every sandbox as `--entrypoint sleep … infinity`,
 * so the chosen image must actually carry a `sleep` binary — a scratch image
 * like `hello-world` or a single-binary tool image cannot host a session, and
 * whichever image `docker images` happens to list first is arbitrary. Each
 * candidate gets a sub-second probe run rather than a name allowlist, because
 * the runner's cached set is not under this repository's control.
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

describe('SandboxProviderRegistry', () => {
  it('registers and resolves a provider by type', () => {
    const reg = new SandboxProviderRegistry();
    const local = new LocalSandboxProvider(tmpdir());
    reg.register(local);
    expect(reg.has('local')).toBe(true);
    expect(reg.get('local')).toBe(local);
    expect(reg.listTypes()).toContain('local');
  });

  it('throws a descriptive error with install hint for a missing provider', () => {
    const reg = new SandboxProviderRegistry();
    reg.register(new LocalSandboxProvider(tmpdir()));
    expect(() => reg.get('docker')).toThrow(/not available/);
    expect(() => reg.get('docker')).toThrow(/Docker/);
  });

  it('has() returns false for unregistered types', () => {
    const reg = new SandboxProviderRegistry();
    expect(reg.has('e2b')).toBe(false);
  });
});

describe('DockerSandboxProvider', () => {
  it('reports the correct type', () => {
    expect(new DockerSandboxProvider().type).toBe('docker');
  });

  it('keeps file paths inside the container workspace', () => {
    expect(dockerWorkspacePath('src/index.ts')).toBe('/workspace/src/index.ts');
    expect(dockerWorkspacePath('')).toBe('/workspace');
    expect(() => dockerWorkspacePath('../etc/passwd')).toThrow(/inside \/workspace/);
    expect(() => dockerWorkspacePath('/etc/passwd')).toThrow(/inside \/workspace/);
  });

  it('serves the canonical in-sandbox roots as literal container paths', () => {
    // A container's filesystem is the sandbox, so a published absolute path is
    // the path the bytes land at — the same spelling the resource contract and
    // the agent's instructions name.
    expect(dockerWorkspacePath('/mnt/session/uploads/notes/input.txt'))
      .toBe('/mnt/session/uploads/notes/input.txt');
    expect(dockerWorkspacePath('/mnt/session/outputs/report.md'))
      .toBe('/mnt/session/outputs/report.md');
    expect(dockerWorkspacePath('/workspace/widget')).toBe('/workspace/widget');
    expect(dockerWorkspacePath('/mnt/session')).toBe('/mnt/session');
    // The boundary is whole-segment: a lookalike prefix and a `..` that climbs
    // out of a canonical root stay refused.
    expect(() => dockerWorkspacePath('/mnt/session/../../etc/passwd')).toThrow();
    expect(() => dockerWorkspacePath('/mnt/sessionx/file')).toThrow(/inside \/workspace/);
    expect(() => dockerWorkspacePath('/mnt/other')).toThrow(/inside \/workspace/);
  });

  const localImage = isDockerAvailable() ? findLocalImage() : undefined;
  const dockerTests = localImage ? describe : describe.skip;
  dockerTests('with a running Docker daemon + cached image', () => {
    let tmpDir: string;
    let provider: DockerSandboxProvider;

    it('provisions, executes, writes/reads files, and cleans up', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ma-docker-'));
      provider = new DockerSandboxProvider();
      const sandbox = await provider.provision('sess_docker_test', {
        name: 'docker',
        sandbox_provider: 'docker',
        timeout: 60,
        image: localImage,
      });
      try {
        const r = await sandbox.execute('echo hello-docker');
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe('hello-docker');

        await sandbox.writeFile('test.txt', 'in container');
        const content = await sandbox.readFile('test.txt');
        expect(content).toBe('in container');

        const files = await sandbox.listFiles('.');
        expect(files).toContain('test.txt');

        // A mounted file resource lands at its canonical absolute path inside
        // the container — the same spelling the agent's instructions publish.
        await sandbox.writeFile('/mnt/session/uploads/notes/input.txt', 'mounted bytes');
        const mounted = await sandbox.execute('cat /mnt/session/uploads/notes/input.txt');
        expect(mounted.exitCode).toBe(0);
        expect(mounted.stdout.trim()).toBe('mounted bytes');
        expect(await sandbox.readFile('/mnt/session/uploads/notes/input.txt')).toBe('mounted bytes');
        expect(await sandbox.listFiles('/mnt/session/uploads'))
          .toContain('mnt/session/uploads/notes/input.txt');
      } finally {
        await sandbox.cleanup();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
