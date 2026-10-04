import { useEffect, useState } from 'react';
import type { ViewId } from '../types';

export type HashRoute = {
  view: ViewId;
  agentId?: string;
  sessionId?: string;
  environmentId?: string;
  vaultId?: string;
  memoryStoreId?: string;
};

export function useHashRoute(): [HashRoute, (view: ViewId, id?: string) => void] {
  const [route, setRouteState] = useState<HashRoute>(() => parseHashRoute());
  useEffect(() => {
    const onHash = () => {
      setRouteState(parseHashRoute());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setRoute = (view: ViewId, id?: string) => {
    const next = view === 'agent-detail' && id
      ? `agents/${encodeURIComponent(id)}`
      : view === 'session-detail' && id
        ? `sessions/${encodeURIComponent(id)}`
        : view === 'environment-detail' && id
          ? `environments/${encodeURIComponent(id)}`
          : view === 'credential-vault-detail' && id
            ? `credential-vaults/${encodeURIComponent(id)}`
            : view === 'memory-store-detail' && id
              ? `memory-stores/${encodeURIComponent(id)}`
              : view;
    window.location.hash = next;
    setRouteState(parseHashRoute(next));
  };

  return [route, setRoute];
}

function parseHashRoute(hash = window.location.hash.replace(/^#/, '')): HashRoute {
  const value = hash || 'agents';
  if (value.startsWith('agents/')) {
    const agentId = decodeURIComponent(value.slice('agents/'.length));
    return agentId ? { view: 'agent-detail', agentId } : { view: 'agents' };
  }
  if (value.startsWith('sessions/')) {
    const sessionId = decodeURIComponent(value.slice('sessions/'.length));
    return sessionId ? { view: 'session-detail', sessionId } : { view: 'sessions' };
  }
  if (value.startsWith('environments/')) {
    const environmentId = decodeURIComponent(value.slice('environments/'.length));
    return environmentId ? { view: 'environment-detail', environmentId } : { view: 'environments' };
  }
  if (value.startsWith('credential-vaults/')) {
    const vaultId = decodeURIComponent(value.slice('credential-vaults/'.length));
    return vaultId ? { view: 'credential-vault-detail', vaultId } : { view: 'credential-vaults' };
  }
  if (value.startsWith('memory-stores/')) {
    const memoryStoreId = decodeURIComponent(value.slice('memory-stores/'.length));
    return memoryStoreId ? { view: 'memory-store-detail', memoryStoreId } : { view: 'memory-stores' };
  }
  if (value === 'agent-detail') return { view: 'agent-detail' };
  if (value === 'session-detail') return { view: 'session-detail' };
  if (value === 'environment-detail') return { view: 'environment-detail' };
  if (value === 'credential-vault-detail') return { view: 'credential-vault-detail' };
  if (value === 'memory-store-detail') return { view: 'memory-store-detail' };
  return { view: isView(value) ? value : 'agents' };
}

function isView(value: string): value is ViewId {
  return [
    'agents',
    'agent-detail',
    'sessions',
    'session-detail',
    'environments',
    'environment-detail',
    'credential-vaults',
    'credential-vault-detail',
    'memory-stores',
    'memory-store-detail',
    'skills',
    'files',
    'webhooks',
    'scheduled-deployments',
    'outcomes',
    'workspace',
    'models',
    'loop-engine',
    'storage',
    'memory',
    'sandbox',
    'logs',
    'monitoring',
    'api-reference',
    'api-keys',
    'advanced',
    'settings',
  ].includes(value);
}
