import { titleCase } from '../../lib/format';
import type {
  Environment,
  EnvironmentDraft,
  EnvironmentHostingType,
  EnvironmentNetworkType,
  EnvironmentPackageManager,
  EnvironmentPackagesDraft,
} from '../../types';

/** The six package managers the published `config.packages` object names. */
export const PACKAGE_MANAGERS: Array<{ id: EnvironmentPackageManager; label: string }> = [
  { id: 'apt', label: 'apt' },
  { id: 'cargo', label: 'Cargo' },
  { id: 'gem', label: 'RubyGems' },
  { id: 'go', label: 'Go modules' },
  { id: 'npm', label: 'npm' },
  { id: 'pip', label: 'pip' },
];

export function environmentKind(environment: Environment) {
  return hostingLabel(environmentHostingType(environment));
}

export function hostingLabel(type: EnvironmentHostingType) {
  if (type === 'self_hosted') return 'Self-hosted';
  if (type === 'docker') return 'Docker';
  if (type === 'kubernetes') return 'Kubernetes';
  if (type === 'local') return 'Local';
  return 'Cloud';
}

/**
 * The hosting type a session on this environment actually provisions — for a
 * `cloud` declaration that is the docker backend, so the effective
 * provider wins when the API reports it.
 */
export function environmentHostingType(environment: Environment): EnvironmentHostingType {
  const effective = environment.effective_sandbox_provider;
  const provider = typeof effective === 'string' && effective ? effective : environment.config.sandbox_provider;
  const hostingType = environment.config.hosting_type;
  if (provider === 'self_hosted' || hostingType === 'self_hosted') return 'self_hosted';
  if (provider === 'docker' || hostingType === 'docker') return 'docker';
  if (provider === 'kubernetes' || hostingType === 'kubernetes') return 'kubernetes';
  if (provider === 'local' || hostingType === 'local') return 'local';
  return 'cloud';
}

/**
 * The hosting type the stored config *declares*, independent of what it
 * resolves to. An editor drafts from the declaration: a `cloud` environment
 * whose effective backend is docker must still edit as `cloud`.
 */
export function declaredHostingType(environment: Environment): EnvironmentHostingType {
  const declared = environment.config.hosting_type ?? environment.config.type;
  if (declared === 'self_hosted' || declared === 'docker' || declared === 'kubernetes' || declared === 'cloud' || declared === 'local') {
    return declared;
  }
  const provider = environment.config.sandbox_provider;
  if (provider === 'self_hosted' || provider === 'docker' || provider === 'kubernetes' || provider === 'local') return provider;
  return 'cloud';
}

/**
 * The backend sessions on this environment provision on, as the API reports
 * it — `effective_sandbox_provider` answers "where does this actually run"
 * for a `cloud` declaration; the declared provider is the fallback.
 */
export function effectiveSandboxProvider(environment: Environment): string {
  const effective = environment.effective_sandbox_provider;
  if (typeof effective === 'string' && effective) return effective;
  const provider = environment.config.sandbox_provider;
  return typeof provider === 'string' && provider ? provider : 'local';
}

export function environmentNetwork(environment: Environment) {
  // `network` is the stored local spelling; `networking` is the published
  // projection of the same policy with the published key names.
  const network = objectValue(environment.config.network);
  const networking = objectValue(environment.config.networking);
  const declared = Object.keys(network).length > 0 ? network : networking;
  const allowedHosts = arrayOfStrings(declared.allowed_hosts);
  return {
    type: (declared.type === 'unrestricted' ? 'unrestricted' : 'limited') as EnvironmentNetworkType,
    label: titleCase(String(declared.type ?? 'limited').replace('_', ' ')),
    allowMcp: Boolean(declared.allow_mcp_server_network_access ?? declared.allow_mcp_servers),
    allowPackageManager: Boolean(declared.allow_package_manager_network_access ?? declared.allow_package_managers),
    allowedHosts,
  };
}

export type NetworkEnforcement = 'enforced' | 'best_effort' | 'unsupported' | 'not_applicable';

/**
 * How a `limited` network policy is applied by the effective backend, as the
 * API reports it. A response that predates the field is inferred from the
 * effective provider so an older server does not silently render a limited
 * policy as enforced — the local backend is advisory by construction.
 */
export function environmentNetworkEnforcement(environment: Environment): NetworkEnforcement {
  const reported = environment.networking_enforcement;
  if (reported === 'enforced' || reported === 'best_effort' || reported === 'unsupported' || reported === 'not_applicable') {
    return reported;
  }
  if (environmentNetwork(environment).type !== 'limited') return 'not_applicable';
  const provider = effectiveSandboxProvider(environment);
  if (provider === 'local') return 'best_effort';
  if (provider === 'docker') return 'enforced';
  return 'unsupported';
}

export function emptyPackagesDraft(): EnvironmentPackagesDraft {
  return { apt: '', cargo: '', gem: '', go: '', npm: '', pip: '' };
}

/**
 * Read the declared package set into one raw text value per manager.
 *
 * The published projection is `{ type: 'packages', npm: [...], ... }`; older
 * rows store the local array spelling `[{ manager, package }]`. Both read
 * into the same draft, and a package under a manager the published object
 * does not name is preserved in place rather than dropped.
 */
export function environmentPackages(environment: Environment): EnvironmentPackagesDraft {
  const draft = emptyPackagesDraft();
  const add = (manager: string, packages: string[]) => {
    if (!packages.length) return;
    const key = (PACKAGE_MANAGERS.some(({ id }) => id === manager) ? manager : 'npm') as EnvironmentPackageManager;
    draft[key] = [...splitCsv(draft[key]), ...packages].join(', ');
  };
  const declared = environment.config.packages;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    for (const [manager, list] of Object.entries(declared as Record<string, unknown>)) {
      if (manager === 'type' || !Array.isArray(list)) continue;
      add(manager, arrayOfStrings(list));
    }
    return draft;
  }
  const packages = Array.isArray(declared) ? declared : [];
  for (const item of packages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const manager = typeof record.manager === 'string' ? record.manager : '';
    const packageName = typeof record.package === 'string' ? record.package : '';
    if (packageName) add(manager, [packageName]);
  }
  return draft;
}

export function environmentMetadataEntries(environment: Environment): string[][] {
  return Object.entries(environment.metadata ?? {}).map(([key, value]) => [key, String(value)]);
}

export function environmentKeys(environment: Environment): Array<{ id: string; name: string; created_at: string; expires_at: string }> {
  const raw = environment.metadata.environment_keys;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.name !== 'string') return [];
      return [{
        id: record.id,
        name: record.name,
        created_at: typeof record.created_at === 'string' ? record.created_at : environment.created_at,
        expires_at: typeof record.expires_at === 'string' ? record.expires_at : environment.updated_at,
      }];
    });
  } catch {
    return [];
  }
}

export function environmentDraftFromApi(environment: Environment): EnvironmentDraft {
  const network = environmentNetwork(environment);
  const resources = objectValue(environment.config.resources);
  return {
    name: environment.name,
    description: environment.description ?? '',
    hostingType: declaredHostingType(environment),
    dockerImage: stringValue(environment.config.image) ?? 'node:22-slim',
    dockerMemory: stringValue(resources.memory) ?? '',
    dockerCpu: numberOrStringValue(resources.cpu) ?? '',
    networkType: network.type,
    allowMcpServerNetworkAccess: network.allowMcp,
    allowPackageManagerNetworkAccess: network.allowPackageManager,
    allowedHosts: network.allowedHosts.join(', '),
    packages: environmentPackages(environment),
    metadata: environmentMetadataEntries(environment)
      .filter(([key]) => key !== 'environment_keys')
      .map(([key, value]) => ({ id: newDraftId(), key, value })),
    preservedMetadata: Object.fromEntries(
      Object.entries(environment.metadata ?? {}).filter(([key]) => key === 'environment_keys'),
    ),
  };
}

export function environmentPayloadFromDraft(draft: EnvironmentDraft) {
  const editableMetadata = Object.fromEntries(
    draft.metadata
      .map((item) => [item.key.trim().toLowerCase(), item.value.trim()])
      .filter(([key]) => key),
  );
  const metadata = { ...draft.preservedMetadata, ...editableMetadata };
  // `cloud` deliberately sends no `sandbox_provider`: it is the published
  // "the platform decides" declaration and resolves to the docker backend
  // server-side, not to a name the Console picks.
  const provider = sandboxProviderForHostingType(draft.hostingType);
  const config: Record<string, unknown> = {
    hosting_type: draft.hostingType,
    ...(provider ? { sandbox_provider: provider } : {}),
    network: {
      type: draft.networkType,
      allow_mcp_server_network_access: draft.allowMcpServerNetworkAccess,
      allow_package_manager_network_access: draft.allowPackageManagerNetworkAccess,
      allowed_hosts: splitCsv(draft.allowedHosts),
    },
    packages: {
      type: 'packages',
      ...Object.fromEntries(
        PACKAGE_MANAGERS.map(({ id }) => [id, splitCsv(draft.packages[id])]),
      ),
    },
  };
  if (draft.hostingType === 'docker') {
    // A blank image field omits `image` so the provider's default — the
    // published reference sandbox image — applies rather than an override.
    const image = draft.dockerImage.trim();
    const memory = draft.dockerMemory.trim();
    const cpu = Number(draft.dockerCpu);
    if (image) config.image = image;
    config.resources = {
      ...(memory ? { memory } : {}),
      ...(Number.isFinite(cpu) && cpu > 0 ? { cpu } : {}),
    };
  }

  return {
    name: draft.name.trim(),
    description: draft.description,
    config,
    metadata,
  };
}

/**
 * The backend a hosting declaration names, or `undefined` for `cloud` —
 * "the platform decides" carries no backend name and resolves to `docker`
 * server-side at run time.
 */
export function sandboxProviderForHostingType(hostingType: EnvironmentHostingType): string | undefined {
  if (hostingType === 'self_hosted') return 'self_hosted';
  if (hostingType === 'docker') return 'docker';
  if (hostingType === 'kubernetes') return 'kubernetes';
  if (hostingType === 'local') return 'local';
  return undefined;
}

export function splitCsv(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberOrStringValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function newDraftId() {
  return `draft_${Math.random().toString(36).slice(2, 10)}`;
}
