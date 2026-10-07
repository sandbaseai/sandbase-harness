import type { ApiReferenceEndpoint } from './apiReferenceTypes';
import sessions from './api-reference/sessions.json';
import runs from './api-reference/runs.json';
import agents from './api-reference/agents.json';
import skills from './api-reference/skills.json';
import files from './api-reference/files.json';
import environments from './api-reference/environments.json';
import credential_vaults from './api-reference/credential-vaults.json';
import memory_stores from './api-reference/memory-stores.json';
import dreams from './api-reference/dreams.json';
import runtime_settings from './api-reference/runtime-settings.json';
import api_keys from './api-reference/api-keys.json';
import operations from './api-reference/operations.json';
import worker from './api-reference/worker.json';
import work from './api-reference/work.json';
import handoff from './api-reference/handoff.json';
import webhooks from './api-reference/webhooks.json';
import scheduled_deployments from './api-reference/scheduled-deployments.json';
import deployment_runs from './api-reference/deployment-runs.json';
import outcomes from './api-reference/outcomes.json';
import unsupported_official from './api-reference/unsupported-official.json';

const CANONICAL_VAULT_PREFIX = '/v1/credential-vaults';
const PUBLISHED_VAULT_PREFIX = '/v1/vaults';
const CANONICAL_DEPLOYMENT_PREFIX = '/v1/scheduled-deployments';
const PUBLISHED_DEPLOYMENT_PREFIX = '/v1/deployments';

/**
 * The published spelling of every route of an aliased resource.
 *
 * `/v1/vaults` and `/v1/credential-vaults` mount one router, and so do
 * `/v1/deployments` and `/v1/scheduled-deployments`. So these are the canonical
 * entries with their paths rewritten rather than a second copy of the same prose.
 * That matters for more than brevity: two hand-maintained copies could describe
 * different behaviour while both looked authoritative, and the guard that the
 * reference matches the mounted surface is an exact set equality in both
 * directions. Deriving the published entries also means a route added later is
 * documented at both prefixes without anyone remembering to add it twice.
 */
function publishedAliasDocs(
  canonical: ApiReferenceEndpoint[],
  from: string,
  to: string,
  group: string,
): ApiReferenceEndpoint[] {
  return canonical.map((endpoint) => ({
    ...endpoint,
    id: `${endpoint.id}-published`,
    group,
    path: endpoint.path.replace(from, to),
  }));
}

export const API_REFERENCE_DOCS: ApiReferenceEndpoint[] = [
  ...(sessions as unknown as ApiReferenceEndpoint[]),
...(runs as unknown as ApiReferenceEndpoint[]),
  ...(agents as unknown as ApiReferenceEndpoint[]),
  ...(skills as unknown as ApiReferenceEndpoint[]),
  ...(files as unknown as ApiReferenceEndpoint[]),
  ...(environments as unknown as ApiReferenceEndpoint[]),
  ...(credential_vaults as unknown as ApiReferenceEndpoint[]),
  ...publishedAliasDocs(credential_vaults as unknown as ApiReferenceEndpoint[], CANONICAL_VAULT_PREFIX, PUBLISHED_VAULT_PREFIX, 'Vaults (published path)'),
  ...(memory_stores as unknown as ApiReferenceEndpoint[]),
  ...(dreams as unknown as ApiReferenceEndpoint[]),
  ...(runtime_settings as unknown as ApiReferenceEndpoint[]),
  ...(api_keys as unknown as ApiReferenceEndpoint[]),
  ...(operations as unknown as ApiReferenceEndpoint[]),
  ...(worker as unknown as ApiReferenceEndpoint[]),
  ...(work as unknown as ApiReferenceEndpoint[]),
  ...(handoff as unknown as ApiReferenceEndpoint[]),
  ...(webhooks as unknown as ApiReferenceEndpoint[]),
  ...(scheduled_deployments as unknown as ApiReferenceEndpoint[]),
  ...publishedAliasDocs(scheduled_deployments as unknown as ApiReferenceEndpoint[], CANONICAL_DEPLOYMENT_PREFIX, PUBLISHED_DEPLOYMENT_PREFIX, 'Deployments (published path)'),
  ...(deployment_runs as unknown as ApiReferenceEndpoint[]),
  ...(outcomes as unknown as ApiReferenceEndpoint[]),
  ...(unsupported_official as unknown as ApiReferenceEndpoint[]),
];
