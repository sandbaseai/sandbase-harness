/**
 * Which sandbox backends can serve a session's mounted resources.
 *
 * A `file` resource is written to `/mnt/session/uploads/...` and a
 * `github_repository` is copied to `/workspace/<repo>`: both are absolute
 * in-sandbox paths the runtime publishes, and the reader and materializer call
 * the sandbox with exactly those paths. A backend that does not adopt the
 * canonical roots therefore cannot serve either resource.
 *
 * Before this refusal existed, a session that declared one was accepted with a
 * `201` and failed later, at provisioning, with a path error the caller had no
 * way to connect to the environment they chose. The answer belongs at admission,
 * before any record is written, and it has to say which backend refused and why.
 *
 * The backends named below are the ones this runtime ships that cannot serve a
 * canonical root for a given resource type, each for its own reason — a backend
 * may serve one resource and not the other. A backend this module does not name
 * keeps its previous behaviour: the runtime cannot know what a backend it does
 * not ship serves, and refusing on a guess would reject a provider that works.
 */

/** The `code` a caller receives when its session's backend cannot mount a resource. */
export const RESOURCE_NOT_MOUNTABLE_CODE = 'resource_not_mountable';

/** Resource types the runtime materializes into the sandbox filesystem. */
export const SANDBOX_MOUNTED_RESOURCE_TYPES = ['file', 'github_repository'] as const;

export type SandboxMountedResourceType = (typeof SANDBOX_MOUNTED_RESOURCE_TYPES)[number];

/**
 * Why a shipped backend cannot serve a resource type at the canonical roots.
 *
 * Each entry is the reason the refusal is not a policy choice: the backend
 * cannot be held to the path the runtime publishes. The map is keyed by
 * backend and then resource type, because a backend that serves one canonical
 * root may still not serve the other — `docker` takes both roots verbatim
 * inside the container, so it mounts a file, but its repository
 * materialization has not been exercised and stays refused. `kubernetes`
 * resolves an absolute path inside its own `/workspace` and refuses the
 * upload root, and its acceptance of the repository root was never exercised
 * against a cluster — a backend that can serve one of the two resources is
 * not a backend that can serve a session's resources.
 *
 * `self_hosted` is listed on the same "not the runtime's to promise" reasoning,
 * not because its worker refuses the path. The shipped worker maps an absolute
 * path into its own root (`/mnt/session/uploads/x` becomes `<worker root>/mnt/
 * session/uploads/x`), so the operator's process decides where bytes land and the
 * runtime cannot verify or enforce that it is the canonical root the resources,
 * the Files API, and the agent's instructions all name; no worker-side mount was
 * ever exercised. `tests/integration/resource-admission-refusal.test.ts` records
 * that measurement next to the refusal, so the wording is evidence rather than
 * an assumption.
 *
 * `Map`s rather than object literals: a provider name is caller-supplied
 * configuration, and `'toString' in {}` is true, which would turn an unknown
 * name into a refusal naming `Object.prototype.toString`.
 */
const UNSERVING_BACKENDS = new Map<string, ReadonlyMap<SandboxMountedResourceType, string>>([
  [
    'docker',
    new Map<SandboxMountedResourceType, string>([
      [
        'github_repository',
        'its repository materialization — a host-side clone copied in file by file — has not been exercised against a container, so the mount cannot be promised',
      ],
    ]),
  ],
  [
    'kubernetes',
    new Map<SandboxMountedResourceType, string>([
      ['file', 'it resolves an absolute path inside its own /workspace and refuses the upload root'],
      [
        'github_repository',
        'it resolves an absolute path inside its own /workspace and refuses the upload root, and its repository root was never verified against a cluster',
      ],
    ]),
  ],
  [
    'self_hosted',
    new Map<SandboxMountedResourceType, string>([
      ['file', 'the worker maps the path into its own root, which the runtime cannot hold to the canonical roots'],
      ['github_repository', 'the worker maps the path into its own root, which the runtime cannot hold to the canonical roots'],
    ]),
  ],
]);

/** A resource declaration as it reaches this module, from a request or a stored row. */
export type DeclaredResource = Record<string, unknown>;

/**
 * The mounted resource types a backend cannot serve, in declaration order.
 *
 * Empty means the backend can serve everything the session declared — including
 * the case of a backend this runtime does not ship, which is left alone.
 */
export function unmountableResourceTypes(
  resources: ReadonlyArray<DeclaredResource> | undefined,
  sandboxProvider: string | undefined,
): SandboxMountedResourceType[] {
  const unserving = sandboxProvider ? UNSERVING_BACKENDS.get(sandboxProvider) : undefined;
  if (!unserving) return [];

  const declared = new Set(
    (resources ?? [])
      .map((resource) => resource.type)
      .filter((type): type is SandboxMountedResourceType =>
        SANDBOX_MOUNTED_RESOURCE_TYPES.includes(type as SandboxMountedResourceType)),
  );
  return SANDBOX_MOUNTED_RESOURCE_TYPES.filter((type) => declared.has(type) && unserving.has(type));
}

/** Attach the code to a refusal, the way the other admission refusals do. */
export function resourceNotMountableError(
  resourceTypes: ReadonlyArray<SandboxMountedResourceType>,
  sandboxProvider: string,
): Error & { code: string } {
  const names = resourceTypes.join(' and ');
  const many = resourceTypes.length > 1;
  const subject = many ? `${names} resources` : `a ${names} resource`;
  const without = many ? 'without those resources' : 'without that resource';
  const reasons = [
    ...new Set(
      resourceTypes
        .map((type) => UNSERVING_BACKENDS.get(sandboxProvider)?.get(type))
        .filter((reason): reason is string => Boolean(reason)),
    ),
  ].join('; ');
  const error = new Error(
    `A session cannot mount ${subject} on the ${sandboxProvider} sandbox backend: `
    + `${reasons}. Use an environment whose sandbox_provider can serve the canonical roots `
    + `(local serves both resources, docker serves files), or create the session ${without}.`,
  ) as Error & { code: string };
  error.code = RESOURCE_NOT_MOUNTABLE_CODE;
  return error;
}

/**
 * Whether a thrown value is this module's refusal.
 *
 * The routes use it to answer `400` with the code instead of `500`: the request
 * was well formed and asked for a session its own environment cannot serve.
 */
export function isResourceNotMountableError(error: unknown): error is Error & { code: string } {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return (error as { code?: unknown }).code === RESOURCE_NOT_MOUNTABLE_CODE;
}

/**
 * Refuse a resource the session's backend cannot serve.
 *
 * Called before anything is stored, so a refused session leaves no session row,
 * no resource instance, and no event behind.
 */
export function assertResourcesMountable(
  resources: ReadonlyArray<DeclaredResource> | undefined,
  sandboxProvider: string | undefined,
): void {
  const unmountable = unmountableResourceTypes(resources, sandboxProvider);
  if (unmountable.length === 0 || !sandboxProvider) return;
  throw resourceNotMountableError(unmountable, sandboxProvider);
}
