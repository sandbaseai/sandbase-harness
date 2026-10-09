/**
 * Which backends can serve a session's mounted resources, and what a refusal says.
 *
 * The refusals are the whole point of the unit under test: a `file` resource is
 * written to `/mnt/session/uploads/...` and a repository is copied to
 * `/workspace/<repo>`, so a backend that refuses those roots can never serve
 * them, and the session has to be refused when it is created rather than
 * accepted and then failed at provisioning.
 *
 * The opposite direction is asserted just as deliberately. `local` serves both
 * and `docker` takes both roots verbatim inside the container — files and
 * repositories alike — and a backend this runtime does not ship is left alone:
 * refusing on a guess would reject a provider that works.
 */

import { describe, expect, it } from 'vitest';
import {
  RESOURCE_NOT_MOUNTABLE_CODE,
  SANDBOX_MOUNTED_RESOURCE_TYPES,
  assertResourcesMountable,
  isResourceNotMountableError,
  unmountableResourceTypes,
} from '@/core/resources/resource-mountability.js';

const FILE = { type: 'file', file_id: 'file_1', mount_path: '/notes/input.txt' };
const REPO = { type: 'github_repository', url: 'https://github.com/example/widget', mount_path: '/workspace/widget' };

describe('resource mountability', () => {
  it('names only the resource types a backend cannot serve', () => {
    // `docker` serves both roots verbatim inside the container, so nothing is
    // refused on it; kubernetes keeps its per-type refusals, and self_hosted
    // serves files through its worker but still cannot promise a clone.
    expect(unmountableResourceTypes([FILE, REPO], 'docker')).toEqual([]);
    expect(unmountableResourceTypes([REPO], 'kubernetes')).toEqual(['github_repository']);
    // Both, in the order the runtime materializes them, when both are declared.
    expect(unmountableResourceTypes([REPO, FILE], 'kubernetes')).toEqual(['file', 'github_repository']);
    expect(unmountableResourceTypes([REPO, FILE], 'self_hosted')).toEqual(['github_repository']);
    expect(unmountableResourceTypes([FILE], 'self_hosted')).toEqual([]);
  });

  it('leaves a backend that can serve the canonical roots alone', () => {
    // `local` maps both canonical roots into its sandbox directory, and a
    // container holds them verbatim.
    expect(unmountableResourceTypes([FILE, REPO], 'local')).toEqual([]);
    expect(unmountableResourceTypes([FILE, REPO], 'docker')).toEqual([]);
    // No resolved backend is not a refusal: the caller has nothing to change yet.
    expect(unmountableResourceTypes([FILE, REPO], undefined)).toEqual([]);
    // A backend this runtime does not ship keeps its previous behaviour.
    expect(unmountableResourceTypes([FILE, REPO], 'firecracker')).toEqual([]);
    // Including a name that collides with an object prototype's own property: the
    // refusal table is keyed by exact provider name, not by property lookup.
    expect(unmountableResourceTypes([FILE], 'toString')).toEqual([]);
    expect(unmountableResourceTypes([FILE], 'constructor')).toEqual([]);
    expect(unmountableResourceTypes(undefined, 'docker')).toEqual([]);
    expect(unmountableResourceTypes([], 'docker')).toEqual([]);
  });

  it('does not treat memory stores or unknown types as mounted resources', () => {
    // A memory store has its own mount mechanism and its own heading, and an
    // unrecognized type is not this module's decision to make.
    expect(unmountableResourceTypes([{ type: 'memory_store', memory_store_id: 'mem_1' }], 'docker')).toEqual([]);
    expect(unmountableResourceTypes([{ type: 'something_else' }, {}], 'docker')).toEqual([]);
    expect([...SANDBOX_MOUNTED_RESOURCE_TYPES]).toEqual(['file', 'github_repository']);
  });

  it('throws the dedicated code, naming the backend and the resource', () => {
    let thrown: unknown;
    try {
      assertResourcesMountable([FILE], 'kubernetes');
    } catch (error) {
      thrown = error;
    }
    expect(isResourceNotMountableError(thrown)).toBe(true);
    const error = thrown as Error & { code: string };
    expect(error.code).toBe(RESOURCE_NOT_MOUNTABLE_CODE);
    // The message has to be actionable: which backend refused, what it refuses,
    // and what the caller can do instead.
    expect(error.message).toContain('kubernetes');
    expect(error.message).toContain('a file resource');
    expect(error.message).toContain('upload root');
    expect(error.message).toContain('local');

    // The plural reads as a sentence rather than a list of words.
    let both: unknown;
    try {
      assertResourcesMountable([FILE, REPO], 'kubernetes');
    } catch (error) {
      both = error;
    }
    const bothError = both as Error;
    expect(bothError.message).toContain('cannot mount file and github_repository resources');
    expect(bothError.message).toContain('without those resources');
    // The self-hosted repository reason states what the runtime cannot promise,
    // not that the worker refuses the path: cloning belongs to the operator's
    // process and its credentials.
    let repoOnly: unknown;
    try {
      assertResourcesMountable([REPO], 'self_hosted');
    } catch (error) {
      repoOnly = error;
    }
    expect((repoOnly as Error).message).toContain('maps the path into its own root');
  });

  it('returns instead of throwing where the backend serves the resource', () => {
    expect(() => assertResourcesMountable([FILE, REPO], 'local')).not.toThrow();
    expect(() => assertResourcesMountable([FILE], 'docker')).not.toThrow();
    expect(() => assertResourcesMountable([FILE], undefined)).not.toThrow();
    expect(() => assertResourcesMountable([{ type: 'memory_store' }], 'docker')).not.toThrow();
    expect(() => assertResourcesMountable(undefined, 'docker')).not.toThrow();
  });

  it('is not confused with another module\'s coded refusal', () => {
    const budgetish = Object.assign(new Error('budget'), { code: 'budget_invalid_shape' });
    expect(isResourceNotMountableError(budgetish)).toBe(false);
    expect(isResourceNotMountableError(new Error('plain'))).toBe(false);
    expect(isResourceNotMountableError(undefined)).toBe(false);
    expect(isResourceNotMountableError('resource_not_mountable')).toBe(false);
  });
});
