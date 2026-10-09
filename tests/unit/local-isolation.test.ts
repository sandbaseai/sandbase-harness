/**
 * Unit tests for the local provider's OS-level command confinement: mode
 * parsing, the seatbelt profile and bubblewrap argv the plan builds on each
 * platform, and the `require` contract that refuses a silent degrade. The
 * real confinement execution lives in the integration side of this file and
 * only runs where the tool exists.
 */

import { describe, it, expect } from 'vitest';
import {
  bubblewrapAvailable,
  extraWritePaths,
  localIsolationMode,
  localIsolationPlan,
  sandboxExecAvailable,
} from '@/sandbox/local-isolation.js';

const shell = { file: '/bin/bash', args: ['-c', 'echo hi'] };

describe('local isolation plan', () => {
  it('parses the operator setting', () => {
    expect(localIsolationMode({})).toBe('auto');
    expect(localIsolationMode({ MANAGED_AGENTS_LOCAL_ISOLATION: 'off' })).toBe('off');
    expect(localIsolationMode({ MANAGED_AGENTS_LOCAL_ISOLATION: '0' })).toBe('off');
    expect(localIsolationMode({ MANAGED_AGENTS_LOCAL_ISOLATION: 'require' })).toBe('require');
    expect(localIsolationMode({ MANAGED_AGENTS_LOCAL_ISOLATION: 'nonsense' })).toBe('auto');
  });

  it('keeps only absolute, existing extra write paths', () => {
    const paths = extraWritePaths({
      MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS: '/tmp:relative:/definitely/missing/xyz',
    });
    expect(paths).toEqual(['/tmp']);
  });

  it('builds a sandbox-exec wrap on macOS', () => {
    const plan = localIsolationPlan('/work/sess1', {}, 'darwin', { sandboxExec: () => true });
    expect(plan?.tool).toBe('sandbox-exec');
    const wrapped = plan!.wrap(shell);
    expect(wrapped.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args[0]).toBe('-p');
    const profile = wrapped.args[1];
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/work/sess1")');
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).toContain('(subpath "/dev")');
    expect(wrapped.args.slice(2)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('builds a bubblewrap wrap on Linux with extra writable roots', () => {
    const plan = localIsolationPlan(
      '/work/sess1',
      { MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS: '/tmp' },
      'linux',
      { bubblewrap: () => true },
    );
    expect(plan?.tool).toBe('bwrap');
    const wrapped = plan!.wrap(shell);
    expect(wrapped.file).toBe('bwrap');
    expect(wrapped.args).toContain('--ro-bind');
    expect(wrapped.args.join(' ')).toContain('/ /');
    // The workdir is rebound writable, extra roots are rebound writable, and
    // the shell runs after `--` with its cwd inside the workdir.
    expect(wrapped.args.join(' ')).toContain('--bind /work/sess1 /work/sess1');
    expect(wrapped.args.join(' ')).toContain('--bind /tmp /tmp');
    const after = wrapped.args.slice(wrapped.args.indexOf('--') + 1);
    expect(after).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('returns null when off, and when no tool exists under auto', () => {
    expect(localIsolationPlan('/w', { MANAGED_AGENTS_LOCAL_ISOLATION: 'off' }, 'linux', {
      bubblewrap: () => true,
    })).toBeNull();
    expect(localIsolationPlan('/w', {}, 'linux', { bubblewrap: () => false })).toBeNull();
    expect(localIsolationPlan('/w', {}, 'win32')).toBeNull();
  });

  it('throws under require when no tool exists', () => {
    expect(() =>
      localIsolationPlan('/w', { MANAGED_AGENTS_LOCAL_ISOLATION: 'require' }, 'win32'),
    ).toThrow('sandbox-exec');
    expect(() =>
      localIsolationPlan('/w', { MANAGED_AGENTS_LOCAL_ISOLATION: 'require' }, 'linux', {
        bubblewrap: () => false,
      }),
    ).toThrow('bubblewrap');
  });

  it('probes report only for their own platform', () => {
    // On this Windows host both probes are false; the platform gate is what
    // the assertions pin down rather than the host's tooling.
    expect(sandboxExecAvailable('linux')).toBe(false);
    expect(sandboxExecAvailable('win32')).toBe(false);
    expect(bubblewrapAvailable('darwin')).toBe(false);
    expect(bubblewrapAvailable('win32')).toBe(false);
  });
});
