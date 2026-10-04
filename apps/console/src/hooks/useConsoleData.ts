import { useCallback, useEffect, useState } from 'react';
import { getCursorPage, getJson, getPage } from '../api';
import type {
  Agent,
  ApiKey,
  ConsoleData,
  Environment,
  MemoryStore,
  Outcome,
  Runtime,
  RuntimeSettings,
  ScheduledDeployment,
  Session,
  Skill,
  Template,
  Vault,
  Webhook,
  Workspace,
  WorkspaceFile,
} from '../types';

function emptyConsoleData(): ConsoleData {
  return {
    agents: [], sessions: [], environments: [], vaults: [], memoryStores: [],
    files: [], apiKeys: [], skills: [], templates: [],
    webhooks: [], scheduledDeployments: [], outcomes: [],
    runtime: null, workspace: null, settings: null,
  };
}

async function loadBuildDomain(): Promise<Pick<ConsoleData, 'agents' | 'sessions' | 'files' | 'skills' | 'templates'>> {
  const [agents, sessions, files, skills, templates] = await Promise.all([
    getCursorPage<Agent>('/v1/agents'),
    getCursorPage<Session>('/v1/sessions?limit=100&include_archived=true'),
    getCursorPage<WorkspaceFile>('/v1/files'),
    getCursorPage<Skill>('/v1/skills'),
    getPage<Template>('/v1/x/templates'),
  ]);
  return {
    agents: agents.data,
    sessions: sessions.data,
    files: files.data,
    skills: skills.data,
    templates: templates.data,
  };
}

async function loadResourceDomain(): Promise<Pick<ConsoleData, 'environments' | 'vaults' | 'memoryStores'>> {
  const [environments, vaults, memoryStores] = await Promise.all([
    getCursorPage<Environment>('/v1/environments'),
    // The listing pages under the published default of 20, so the Console asks for the
    // published maximum explicitly — the same way the session list above does. The
    // Console reads one page and does not follow `next_page`, so a workspace with more
    // than 100 vaults or stores is still shown its first 100; that limit is the
    // Console's, not the endpoint's, and it applies to the session list already.
    getCursorPage<Vault>('/v1/credential-vaults?limit=100'),
    getCursorPage<MemoryStore>('/v1/memory_stores?limit=100'),
  ]);
  return {
    environments: environments.data,
    vaults: vaults.data,
    memoryStores: memoryStores.data,
  };
}

async function loadAccessDomain(): Promise<Pick<ConsoleData, 'apiKeys'>> {
  const apiKeys = await getCursorPage<ApiKey>('/v1/api-keys');
  return { apiKeys: apiKeys.data };
}

async function loadOperationsDomain(): Promise<Pick<ConsoleData, 'webhooks' | 'scheduledDeployments' | 'outcomes'>> {
  const [webhooks, scheduledDeployments, outcomes] = await Promise.all([
    getCursorPage<Webhook>('/v1/webhooks'),
    getCursorPage<ScheduledDeployment>('/v1/scheduled-deployments'),
    getCursorPage<Outcome>('/v1/outcomes'),
  ]);
  return {
    webhooks: webhooks.data,
    scheduledDeployments: scheduledDeployments.data,
    outcomes: outcomes.data,
  };
}

async function loadRuntimeDomain(): Promise<Pick<ConsoleData, 'runtime' | 'workspace' | 'settings'>> {
  const [runtime, workspace, settings] = await Promise.all([
    getJson<Runtime>('/v1/x/runtime'),
    getJson<Workspace>('/v1/x/workspace'),
    getJson<RuntimeSettings>('/v1/x/settings'),
  ]);
  return { runtime, workspace, settings };
}

/** Shared Console bootstrap data and refresh lifecycle. */
export function useConsoleData() {
  const [data, setData] = useState<ConsoleData>(emptyConsoleData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    // Only the initial bootstrap should replace the whole Console with a
    // loading state. In-page actions (especially Session SSE/message updates)
    // refresh data in the background so the current view stays mounted.
    if (!silent) setLoading(true);
    setError('');
    try {
      const [build, resources, access, operations, runtime] = await Promise.all([
        loadBuildDomain(),
        loadResourceDomain(),
        loadAccessDomain(),
        loadOperationsDomain(),
        loadRuntimeDomain(),
      ]);
      setData({
        ...emptyConsoleData(),
        ...build,
        ...resources,
        ...access,
        ...operations,
        ...runtime,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { data, loading, error, refresh };
}
