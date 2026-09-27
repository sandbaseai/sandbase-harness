import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mountedRouteKeys, routeKey } from './support/route-table';
import { API_REFERENCE_DOCS } from '../../apps/console/src/components/pages/settings/apiReferenceDocs';
import {
  DEFAULT_API_REFERENCE_ENDPOINT_ID,
  SettingsApiReference,
} from '../../apps/console/src/components/pages/settings/SettingsApiReference';
import {
  buildApiEndpointExample,
  type ApiReferenceExampleContext,
} from '../../apps/console/src/components/pages/settings/apiReferenceExamples';
import {
  buildDefaultHeaders,
  getEndpointGroups,
  getVisibleApiEndpoints,
  selectVisibleApiEndpoint,
} from '../../apps/console/src/components/pages/settings/apiReferenceSelectors';
import type { ApiReferenceEndpoint } from '../../apps/console/src/components/pages/settings/apiReferenceTypes';
import type { ConsoleData } from '../../apps/console/src/types';

const context: ApiReferenceExampleContext = {
  baseUrl: 'http://127.0.0.1:3000',
  authEnabled: true,
  firstAgentId: 'agent_test',
  firstEnvironmentId: 'env_test',
  firstSessionId: 'sess_test',
};

describe('API reference docs', () => {
  it('documents every mounted backend route', () => {
    const mounted = mountedRouteKeys();
    const documented = new Set(API_REFERENCE_DOCS.map((endpoint) => routeKey(endpoint.method, endpoint.path)));

    expect([...mounted].sort()).toEqual([...documented].sort());
  });

  it('loads a broad endpoint set instead of only create endpoints', () => {
    const methods = new Set(API_REFERENCE_DOCS.map((endpoint) => endpoint.method));
    const ids = new Set(API_REFERENCE_DOCS.map((endpoint) => endpoint.id));
    const groups = new Set(API_REFERENCE_DOCS.map((endpoint) => endpoint.group));

    expect(API_REFERENCE_DOCS.length).toBeGreaterThan(35);
    expect(ids.size).toBe(API_REFERENCE_DOCS.length);
    expect(Array.from(groups)).toEqual(expect.arrayContaining([
      'Sessions',
      'Agents',
      'Skills',
      'Files',
      'Runtime settings',
      'Operations',
      'Worker',
    ]));
    expect(Array.from(methods)).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']));
    expect(API_REFERENCE_DOCS.some((endpoint) => !endpoint.id.includes('create'))).toBe(true);
    expect(API_REFERENCE_DOCS.some((endpoint) => endpoint.id.includes('delete'))).toBe(true);
    expect(API_REFERENCE_DOCS.some((endpoint) => endpoint.id === 'settings-validate')).toBe(true);
    expect(API_REFERENCE_DOCS.some((endpoint) => endpoint.path === '/v1/x/metrics/summary')).toBe(true);
    expect(ids.has(DEFAULT_API_REFERENCE_ENDPOINT_ID)).toBe(true);
  });

  it('documents the full Runtime Settings response shape used by the Console', () => {
    const getSettings = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'settings-get');
    const saveSettings = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'settings-save');
    const restartRuntime = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'runtime-restart');
    const expectedStateFields = [
      'schema_version',
      'revision',
      'effective_revision',
      'saved_config',
      'effective_config',
      'restart_required',
      'activation_status',
      'activation_errors',
      'diagnostics',
      'secret_states',
    ];

    expect(getSettings).toBeDefined();
    expect(saveSettings).toBeDefined();
    expect(getSettings?.response.map((field) => field.name)).toEqual(expect.arrayContaining([
      ...expectedStateFields,
      'adapters',
    ]));
    expect(saveSettings?.response.map((field) => field.name)).toEqual(expect.arrayContaining(expectedStateFields));
    expect(restartRuntime?.response.map((field) => field.name)).toEqual(['restarting', 'status']);
  });

  it('keeps self-hosted worker endpoint docs aligned with request bodies', () => {
    const claim = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'worker-claim');
    const accept = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'worker-accept');
    const complete = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'worker-complete');

    expect(claim?.parameters?.map((field) => field.name)).toEqual(expect.arrayContaining(['worker_id', 'session_id']));
    // The confirmation that authorizes running a claimed item, documented with the same
    // body as the route reads: an id and the worker that owns the claim.
    expect(accept?.path).toBe('/v1/x/worker/accept');
    expect(accept?.parameters?.map((field) => field.name)).toEqual(['id', 'worker_id']);
    expect(complete?.parameters?.map((field) => field.name)).toEqual(expect.arrayContaining(['id', 'worker_id', 'result', 'failed']));
    expect(complete?.parameters?.map((field) => field.name)).not.toContain('status');
    expect(complete?.parameters?.map((field) => field.name)).not.toContain('error');
  });

  it('documents session raw event append as an events batch', () => {
    const appendEvents = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'sessions-events-create');
    const message = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'sessions-message');
    const stop = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'sessions-stop');

    expect(appendEvents?.parameters?.map((field) => field.name)).toEqual(['events']);
    // The batch reply carries the steer receipt beside `accepted`, because a
    // rejected or conflicting steer was not delivered and `accepted` alone cannot
    // say what the engine did with it.
    expect(appendEvents?.response.map((field) => field.name)).toEqual(['accepted', 'steer']);
    expect(appendEvents?.summary).toContain('user.* events');
    expect(appendEvents?.summary).toContain('user.steer');
    expect(message?.response.map((field) => field.name)).toEqual(expect.arrayContaining(['event', 'accepted']));
    expect(message?.response.map((field) => field.name)).not.toContain('session');
    expect(stop?.response.map((field) => field.name)).toEqual(['id', 'status']);
  });

  it('keeps every endpoint schema complete and route identity unique', () => {
    const routeKeys = new Set<string>();

    for (const endpoint of API_REFERENCE_DOCS) {
      expect(endpoint.id, 'id').toMatch(/^[a-z0-9-]+$/);
      expect(endpoint.group, endpoint.id).toBeTruthy();
      expect(endpoint.title, endpoint.id).toBeTruthy();
      expect(endpoint.summary, endpoint.id).toBeTruthy();
      expect(endpoint.path, endpoint.id).toMatch(/^\/v1\//);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(endpoint.method);
      expect(Array.isArray(endpoint.response), endpoint.id).toBe(true);

      for (const field of [...(endpoint.headers ?? []), ...(endpoint.parameters ?? []), ...endpoint.response]) {
        expect(field.name, endpoint.id).toBeTruthy();
        expect(field.type, `${endpoint.id}.${field.name}`).toBeTruthy();
        expect(field.description, `${endpoint.id}.${field.name}`).toBeTruthy();
      }

      const routeKey = `${endpoint.method} ${endpoint.path}`;
      expect(routeKeys.has(routeKey), routeKey).toBe(false);
      routeKeys.add(routeKey);
    }
  });

  it('builds auth-aware examples for known endpoints', () => {
    const sessionsCreate = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'sessions-create');
    const skillsCreate = API_REFERENCE_DOCS.find((endpoint) => endpoint.id === 'skills-create');
    expect(sessionsCreate).toBeDefined();
    expect(skillsCreate).toBeDefined();

    const sessionExample = buildApiEndpointExample(sessionsCreate!, context);
    expect(sessionExample).toContain("-H 'Authorization: Bearer ma_...'");
    expect(sessionExample).toContain('"agent":"agent_test"');
    expect(sessionExample).toContain('/v1/sessions/sess_test/messages');

    const skillExample = buildApiEndpointExample(skillsCreate!, context);
    expect(skillExample).toContain('zip -r code-review-assistant.zip');
    expect(skillExample).toContain("-F 'files=@code-review-assistant.zip'");
  });

  it('builds method-correct fallback examples for non-specialized endpoints', () => {
    const putEndpoint: ApiReferenceEndpoint = {
      id: 'custom-put',
      group: 'Test',
      title: 'Update custom resource',
      method: 'PUT',
      path: '/v1/custom/custom_123',
      summary: 'Update a custom resource.',
      response: [],
    };
    const deleteEndpoint: ApiReferenceEndpoint = {
      ...putEndpoint,
      id: 'custom-delete',
      title: 'Delete custom resource',
      method: 'DELETE',
    };
    const getEndpoint: ApiReferenceEndpoint = {
      ...putEndpoint,
      id: 'custom-get',
      title: 'Get custom resource',
      method: 'GET',
    };

    expect(buildApiEndpointExample(putEndpoint, context)).toContain("curl -sS -X PUT 'http://127.0.0.1:3000/v1/custom/custom_123'");
    expect(buildApiEndpointExample(putEndpoint, context)).toContain("-d '{}'");
    expect(buildApiEndpointExample(deleteEndpoint, context)).toContain("curl -sS -X DELETE 'http://127.0.0.1:3000/v1/custom/custom_123'");
    expect(buildApiEndpointExample(getEndpoint, context)).toBe("curl -sS 'http://127.0.0.1:3000/v1/custom/custom_123'");
  });

  it('selects the active endpoint from visible search results only', () => {
    const docs: ApiReferenceEndpoint[] = [
      { id: 'sessions-create', group: 'Sessions', title: 'Create session', method: 'POST', path: '/v1/sessions', summary: 'Create.', response: [] },
      { id: 'agents-list', group: 'Agents', title: 'List agents', method: 'GET', path: '/v1/agents', summary: 'List.', response: [] },
    ];

    expect(selectVisibleApiEndpoint(docs, 'agents-list')?.id).toBe('agents-list');
    expect(selectVisibleApiEndpoint([docs[1]], 'sessions-create')?.id).toBe('agents-list');
    expect(selectVisibleApiEndpoint([], 'sessions-create')).toBeUndefined();
  });

  it('filters, groups, and derives default headers for endpoint docs', () => {
    const visible = getVisibleApiEndpoints(API_REFERENCE_DOCS, 'check settings area');

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((endpoint) => [
      endpoint.group,
      endpoint.title,
      endpoint.method,
      endpoint.path,
      endpoint.summary,
    ].join(' ').toLowerCase().includes('runtime settings'))).toBe(true);
    expect(getEndpointGroups(visible)).toEqual(['Runtime settings']);

    const getEndpoint = API_REFERENCE_DOCS.find((endpoint) => endpoint.method === 'GET');
    expect(getEndpoint).toBeDefined();
    expect(buildDefaultHeaders(getEndpoint!, true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Content-Type', required: false }),
      expect.objectContaining({ name: 'Authorization', description: expect.stringContaining('Required') }),
    ]));
  });

  it('renders empty parameter states and reusable example cards', () => {
    const docs: ApiReferenceEndpoint[] = [{
      id: 'custom-get',
      group: 'Custom',
      title: 'Get custom resource',
      method: 'GET',
      path: '/v1/custom/custom_123',
      summary: 'Fetch a custom resource.',
      parameters: [],
      response: [{ name: 'id', type: 'string', description: 'Resource id.' }],
    }];
    const data = {
      runtime: { auth_enabled: false },
      agents: [],
      environments: [],
      sessions: [],
    } as unknown as ConsoleData;

    const html = renderToStaticMarkup(<SettingsApiReference data={data} docs={docs} />);

    expect(html).toContain('No query parameters.');
    expect(html).toContain('class="apiEmptyState"');
    expect(html).toContain('class="secondaryButton"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Example request');
    expect(html).toContain('TypeScript SDK');
    expect(html).toContain('Skill JSON upload');
    expect(html).toContain('Agent skill reference');
    expect(html).toContain("curl -sS &#x27;http://127.0.0.1:3000/v1/custom/custom_123&#x27;");
  });
});
