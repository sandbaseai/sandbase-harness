/**
 * Guard: Environment backend resolution stays in one module.
 *
 * The bug this pins was not a wrong mapping — it was the same mapping written
 * four times. Each copy interpreted an unusable Environment declaration as
 * "nothing was declared" and answered `local`, so an Environment that asked for
 * an isolated backend ran on the runtime host with no error. A call site that
 * grows its own copy of the vocabulary is how that returns, so the call sites
 * are asserted to delegate instead of translate.
 *
 * These are source assertions rather than behavior assertions on purpose: the
 * failure mode is a *new* copy of the mapping, and no runtime behavior test can
 * observe a copy that happens to agree with the shared one today.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Modules that must translate an Environment declaration through the boundary. */
const RESOLUTION_CALL_SITES = [
  'src/core/runtime/composition.ts',
  'src/core/session/session-manager.ts',
  'src/core/settings/store.ts',
  'src/api/routes/environments.ts',
];

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Environment provider translation boundary', () => {
  it('routes every resolution call site through provider-names', () => {
    for (const path of RESOLUTION_CALL_SITES) {
      expect(source(path), path).toContain('@/sandbox/provider-names.js');
    }
    expect(source('src/core/runtime/composition.ts')).toContain('sandboxProviderForEnvironmentConfig');
    expect(source('src/core/session/session-manager.ts')).toContain('sandboxProviderForEnvironmentConfig');
    expect(source('src/core/settings/store.ts')).toContain('workspaceDefaultSettingForEnvironmentConfig');
    expect(source('src/api/routes/environments.ts')).toContain('hostingTypeError');
  });

  it('keeps the hosting vocabulary out of the call sites', () => {
    // `self_hosted` is the value this boundary translates; a call site naming it
    // is a call site that has started translating for itself.
    for (const path of RESOLUTION_CALL_SITES) {
      expect(source(path), path).not.toContain("'self_hosted'");
    }
  });

  it('has no local fallback left in the resolution paths', () => {
    const composition = source('src/core/runtime/composition.ts');
    const sessionManager = source('src/core/session/session-manager.ts');
    const settings = source('src/core/settings/store.ts');

    // The three shapes the old copies used to answer `local` with.
    expect(composition).not.toMatch(/return \{\};/);
    expect(composition).not.toMatch(/\?\? 'local'/);
    expect(sessionManager).not.toMatch(/catch \{[\s\S]{0,80}return 'local'/);
    expect(sessionManager).not.toContain("hosting_type === 'self_hosted'");
    expect(settings).not.toMatch(/sandboxSettingForProvider\([^)]*\) \?\? 'local'/);
  });

  it('reports an unreadable Environment without claiming a backend', () => {
    // `local` here is what let an operator read a damaged record as local, save
    // the form, and store it as one. `effective_sandbox_provider` reporting
    // `null` for a record no session could provision on is what marks it.
    const routes = source('src/api/routes/environments.ts');
    expect(routes).toContain('effective_sandbox_provider');
    expect(routes).toContain('sandboxProviderForEnvironmentConfig');
    expect(routes).not.toContain("'local'");
  });

  it('keeps self_hosted readable as the public name for a caller-owned host', () => {
    const boundary = source('src/sandbox/provider-names.ts');
    expect(boundary).toContain('EXECUTABLE_HOSTING_PROVIDERS');
    expect(boundary).toMatch(/self_hosted: 'self_hosted'/);
    // Settings V2 keeps its persisted `remote` spelling; the alias is the only
    // provider difference between the two vocabularies.
    expect(boundary).toMatch(/provider === 'remote' \? 'self_hosted'/);
  });
});
