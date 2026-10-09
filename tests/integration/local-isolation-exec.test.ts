/**
 * Integration test: the local provider's bubblewrap confinement actually
 * confines — a command inside the sandbox can write into the workdir but not
 * outside it. Runs only on a Linux host with `bwrap` installed (skipped
 * elsewhere); the argv/profile construction is covered by unit tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { bubblewrapAvailable } from '@/sandbox/local-isolation.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

const canRun = process.platform === 'linux' && bubblewrapAvailable('linux');
const itBwrap = it.skipIf(!canRun);

describe('local provider bubblewrap confinement', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const provision = async () => {
    dir = mkdtempSync(join(tmpdir(), 'ma-iso-'));
    const provider = new LocalSandboxProvider(dir);
    return provider.provision('sess_iso', {
      name: 'local',
      sandbox_provider: 'local',
    } as EnvironmentConfig);
  };

  itBwrap('writes inside the workdir succeed and writes outside it fail', async () => {
    const sandbox = await provision();

    const inside = await sandbox.execute('mkdir -p a/b && echo ok > a/b/f.txt && cat a/b/f.txt');
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout.trim()).toBe('ok');

    // The host filesystem is read-only inside the namespace: a write that
    // lands outside the workdir is refused by the kernel.
    const outside = await sandbox.execute('echo x > "$HOME/bwrap-escape-test"');
    expect(outside.exitCode).not.toBe(0);
    expect(existsSync(join(process.env.HOME ?? '', 'bwrap-escape-test'))).toBe(false);
  });
});
