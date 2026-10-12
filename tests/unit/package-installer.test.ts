/**
 * Unit tests for the declared-package install phase.
 *
 * The install is the provisioning-side half of `config.packages`: it runs
 * the Environment's declared managers through the sandbox's own `execute`
 * channel, in the published alphabetical order, and fails the session's
 * provisioning when a manager fails. These tests cover the shape
 * normalization, the alphabetical order, the `limited`-policy admission
 * rule, and the failure propagation — everything a caller can observe
 * without standing up a real package registry.
 */

import { describe, expect, it } from 'vitest';
import type { ExecResult, SandboxInstance } from '@/types/sandbox.js';
import {
  assertPackagesAdmitted,
  declaredEnvironmentPackages,
  installDeclaredPackages,
  PackageInstallError,
} from '@/core/sandbox/package-installer.js';

function fakeSandbox(run?: (command: string) => ExecResult): SandboxInstance & { commands: string[] } {
  const commands: string[] = [];
  return {
    sessionId: 'sess_test',
    commands,
    async execute(command: string) {
      commands.push(command);
      return run?.(command) ?? { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeFile() {},
    async readFile() {
      return '';
    },
    async listFiles() {
      return [];
    },
    async cleanup() {},
  };
}

describe('declaredEnvironmentPackages', () => {
  it('reads the published per-manager object', () => {
    expect(
      declaredEnvironmentPackages({
        name: 'env',
        sandbox_provider: 'docker',
        packages: { pip: ['pandas', 'numpy'], npm: ['express'] },
      }),
    ).toEqual({ pip: ['pandas', 'numpy'], npm: ['express'] });
  });

  it('reads the local {manager, package} array spelling', () => {
    expect(
      declaredEnvironmentPackages({
        name: 'env',
        sandbox_provider: 'local',
        packages: [
          { manager: 'pip', package: 'pandas' },
          { manager: 'pip', package: 'numpy' },
          { manager: 'npm', package: 'express@4.18.0' },
        ],
      }),
    ).toEqual({ pip: ['pandas', 'numpy'], npm: ['express@4.18.0'] });
  });

  it('returns undefined for an absent or empty declaration', () => {
    expect(declaredEnvironmentPackages(undefined)).toBeUndefined();
    expect(
      declaredEnvironmentPackages({ name: 'env', sandbox_provider: 'local', packages: {} }),
    ).toBeUndefined();
    expect(
      declaredEnvironmentPackages({ name: 'env', sandbox_provider: 'local', packages: [] }),
    ).toBeUndefined();
  });

  it('drops entries outside the published manager vocabulary', () => {
    expect(
      declaredEnvironmentPackages({
        name: 'env',
        sandbox_provider: 'local',
        packages: { pip: ['pandas'], brew: ['wget'], yarn: [] },
      }),
    ).toEqual({ pip: ['pandas'] });
  });

  it('ignores the spelling marker key in the published object', () => {
    expect(
      declaredEnvironmentPackages({
        name: 'env',
        sandbox_provider: 'docker',
        packages: { type: 'packages', pip: ['pandas'] },
      }),
    ).toEqual({ pip: ['pandas'] });
  });
});

describe('assertPackagesAdmitted', () => {
  const packages = { pip: ['pandas'] };

  it('accepts an unrestricted or absent policy', () => {
    expect(() => assertPackagesAdmitted(packages, undefined)).not.toThrow();
    expect(() =>
      assertPackagesAdmitted(packages, {
        type: 'unrestricted',
        allowed_hosts: [],
        allow_mcp_server_network_access: false,
        allow_package_manager_network_access: false,
      }),
    ).not.toThrow();
  });

  it('accepts limited with package-manager egress opened', () => {
    expect(() =>
      assertPackagesAdmitted(packages, {
        type: 'limited',
        allowed_hosts: [],
        allow_mcp_server_network_access: false,
        allow_package_manager_network_access: true,
      }),
    ).not.toThrow();
  });

  it('refuses limited without allow_package_managers', () => {
    expect(() =>
      assertPackagesAdmitted(packages, {
        type: 'limited',
        allowed_hosts: [],
        allow_mcp_server_network_access: false,
        allow_package_manager_network_access: false,
      }),
    ).toThrowError(/allow_package_managers/);
  });
});

describe('installDeclaredPackages', () => {
  it('runs managers in alphabetical order, one execute call each', async () => {
    const sandbox = fakeSandbox();
    await installDeclaredPackages(
      { pip: ['pandas'], npm: ['express'], apt: ['graphviz'] },
      sandbox,
    );
    // apt before npm before pip regardless of insertion order.
    expect(sandbox.commands.map((cmd) => cmd.split(' ')[0])).toEqual([
      'apt-get',
      'npm',
      'pip',
    ]);
  });

  it('skips managers with an empty list', async () => {
    const sandbox = fakeSandbox();
    await installDeclaredPackages({ pip: ['pandas'], npm: [] }, sandbox);
    expect(sandbox.commands).toHaveLength(1);
    expect(sandbox.commands[0]).toContain('pip');
  });

  it('shell-quotes package names so a pin cannot inject a second command', async () => {
    const sandbox = fakeSandbox();
    await installDeclaredPackages({ npm: [`evil'; rm -rf / #`] }, sandbox);
    // The whole pin is one quoted argv word; the literal `'` is escaped, and
    // nothing after it can read as a new command.
    expect(sandbox.commands[0]).toBe(`npm install -g 'evil'\\''; rm -rf / #'`);
  });

  it('fails the provisioning pass on a nonzero exit', async () => {
    const sandbox = fakeSandbox(() => ({
      exitCode: 3,
      stdout: '',
      stderr: 'E: Unable to locate package nope',
      timedOut: false,
    }));
    await expect(
      installDeclaredPackages({ apt: ['nope'], pip: ['pandas'] }, sandbox),
    ).rejects.toThrowError(PackageInstallError);
    // The failing manager stopped the rest.
    expect(sandbox.commands).toHaveLength(1);
  });
});
