/**
 * Declared package installation for Environment `config.packages`.
 *
 * The published contract preinstalls declared packages before the agent
 * starts, running each manager in alphabetical order (apt, cargo, gem, go,
 * npm, pip) with optional version pins, and requires
 * `networking.allow_package_managers` under a `limited` policy. This module
 * is the runtime's execution side of that declaration: the Environment write
 * path validates and stores it, and session provisioning runs each
 * manager's install through the sandbox's own `execute` channel — which is
 * what makes the same declaration work on a container backend (an exec
 * inside it), the local backend (a subprocess), and a self-hosted worker
 * (an `exec` work item on the queue).
 *
 * Three rules are deliberate, not incidental:
 *
 * - **Install runs inside the sandbox, not on the host.** A package list is
 *   operator-declared content; piping it through a host shell would install
 *   software on the runtime host for a declaration that was meant for the
 *   sandbox. Every command goes through `SandboxInstance.execute`, so the
 *   install lands wherever the session's commands do.
 * - **A failed install fails provisioning.** A session that silently starts
 *   without a declared package runs against a different contract than the
 *   caller asked for, and a later tool failure would read as a tool bug
 *   rather than the missing install it is. The caller sees the manager's
 *   own error.
 * - **Package strings are passed positionally, never interpolated into
 *   another command's text.** Each manager invocation is a fixed argv whose
 *   only variable part is the package list; a package name is shell-quoted
 *   before it reaches the command string, so `;`, `|`, or whitespace inside
 *   a pin can never become a second command.
 *
 * Caching (the published "sessions sharing an environment share installed
 * packages") is deliberately not reproduced: this runtime provisions one
 * fresh sandbox per session, so there is no shared image layer to cache
 * into. Install order still follows the published alphabetical rule so a
 * caller reading the contract sees the same execution order.
 */

import type { SandboxInstance, EnvironmentConfig, ExecResult } from '@/types/sandbox.js';
import {
  environmentNetworkPolicyOf,
  type EnvironmentNetworkPolicy,
} from '@/core/config/environment-network.js';

/** The managers the published `packages` object names, in install order. */
const MANAGER_ORDER = ['apt', 'cargo', 'gem', 'go', 'npm', 'pip'] as const;
type PackageManager = (typeof MANAGER_ORDER)[number];

/** One manager's install command, built per package list. */
const MANAGER_INSTALL: Record<PackageManager, (pkgs: string[]) => string> = {
  apt: (pkgs) => `apt-get install -y --no-install-recommends ${pkgs.map(shellQuote).join(' ')}`,
  cargo: (pkgs) => pkgs.map((p) => `cargo install ${shellQuote(p)}`).join(' && '),
  gem: (pkgs) => `gem install ${pkgs.map(shellQuote).join(' ')}`,
  go: (pkgs) => pkgs.map((p) => `go install ${shellQuote(p)}@latest`).join(' && '),
  npm: (pkgs) => `npm install -g ${pkgs.map(shellQuote).join(' ')}`,
  pip: (pkgs) => `pip install ${pkgs.map(shellQuote).join(' ')}`,
};

/**
 * Read the declared package lists off a resolved EnvironmentConfig.
 *
 * Two spellings reach storage: the published per-manager object
 * (`{ pip: [...] }`) and the local `{manager, package}` array. Both are
 * normalized here into `manager → package[]`; anything that does not fit is
 * dropped rather than guessed at, because the Environment write path is the
 * validation boundary and this reader only sees what was stored.
 *
 * Returns `undefined` when the config declares no packages, so callers can
 * skip the install phase entirely without an empty-manager walk.
 */
export function declaredEnvironmentPackages(
  config: EnvironmentConfig | undefined,
): Partial<Record<PackageManager, string[]>> | undefined {
  const declared = config?.packages;
  if (!declared) return undefined;

  const byManager: Partial<Record<PackageManager, string[]>> = {};
  const add = (manager: unknown, pkg: unknown): void => {
    if (typeof manager !== 'string' || typeof pkg !== 'string' || !pkg.trim()) return;
    const key = manager.trim() as PackageManager;
    if (!MANAGER_ORDER.includes(key)) return; // unknown manager: the write path already refused it
    (byManager[key] ??= []).push(pkg);
  };

  if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        add((entry as Record<string, unknown>).manager, (entry as Record<string, unknown>).package);
      }
    }
  } else if (typeof declared === 'object') {
    for (const [manager, list] of Object.entries(declared)) {
      if (manager === 'type' || !Array.isArray(list)) continue;
      for (const pkg of list) add(manager, pkg);
    }
  }

  return Object.keys(byManager).length > 0 ? byManager : undefined;
}

/**
 * Refuse a `packages` declaration the sandbox's declared network policy
 * cannot serve, before any install command runs.
 *
 * The published contract refuses a `limited` environment that names packages
 * without `allow_package_managers: true` with a 400 at write time; the write
 * path enforces that on the Environment row. This is the runtime-side second
 * check — an Environment written before that rule, or one whose stored
 * policy was repaired to `limited` after the fact, must still not silently
 * reach registries its policy does not open. The message names the field the
 * operator changes, not the internal key name.
 */
export const PACKAGE_MANAGER_ACCESS_REQUIRED_CODE = 'package_manager_access_required';
export const PACKAGE_INSTALL_FAILED_CODE = 'package_install_failed';

export function assertPackagesAdmitted(
  packages: Partial<Record<PackageManager, string[]>>,
  policy: EnvironmentNetworkPolicy | undefined,
): void {
  if (!packages) return;
  if (policy?.type === 'limited' && policy.allow_package_manager_network_access !== true) {
    throw new PackageInstallError(
      PACKAGE_MANAGER_ACCESS_REQUIRED_CODE,
      'config.packages cannot run under a limited network policy unless '
        + 'config.networking.allow_package_managers is true — the declared '
        + 'managers would be refused egress to their registries.',
    );
  }
}

/**
 * Install a config's declared packages into a provisioned sandbox.
 *
 * Managers run in the published alphabetical order; each manager's install
 * is one `execute` call so a self-hosted worker sees it as a single work
 * item. A nonzero exit — or a backend that cannot execute — stops the
 * remaining managers and fails the provisioning pass, because a half-
 * installed environment is worse than a failed one.
 */
export async function installDeclaredPackages(
  packages: Partial<Record<PackageManager, string[]>>,
  sandbox: SandboxInstance,
): Promise<void> {
  for (const manager of MANAGER_ORDER) {
    const pkgs = packages[manager];
    if (!pkgs || pkgs.length === 0) continue;
    const command = MANAGER_INSTALL[manager](pkgs);
    const result: ExecResult = await sandbox.execute(command);
    if (result.exitCode !== 0) {
      throw new PackageInstallError(
        PACKAGE_INSTALL_FAILED_CODE,
        `${manager} install failed (exit ${result.exitCode}): `
          + (result.stderr || result.stdout || 'no output').trim().slice(0, 500),
      );
    }
  }
}

export class PackageInstallError extends Error {
  constructor(
    readonly code:
      | typeof PACKAGE_MANAGER_ACCESS_REQUIRED_CODE
      | typeof PACKAGE_INSTALL_FAILED_CODE,
    message: string,
  ) {
    super(message);
    this.name = 'PackageInstallError';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
