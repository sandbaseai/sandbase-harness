import { describe, expect, it } from 'vitest';
import { extractOfficialRoutes } from '../conformance/support/official-routes.js';

describe('official SDK route extraction', () => {
  it('does not treat the SDK timeout calculator as an HTTP request', () => {
    expect(extractOfficialRoutes('this._client.calculateNonstreamingTimeout(1000, {});')).toEqual([]);
  });

  it('extracts literal paths, tagged template paths, all supported verbs, and pagination', () => {
    const source = [
      "this._client.post('/v1/agents?beta=true', {});",
      'this._client.get((0, path_1.path) `/v1/agents/${agentID}?beta=true`, {});',
      'this._client.getAPIList("/v1/files?beta=true", PageCursor, {});',
      'this._client.put((0, path_2.path) `/v1/vaults/${vaultID}/credentials/${credentialID}`, {});',
      "this._client.patch('/v1/sessions?beta=true', {});",
      "this._client.delete('/v1/skills?beta=true', {});",
    ].join('\n');
    expect(extractOfficialRoutes(source)).toEqual([
      { method: 'POST', path: '/v1/agents' },
      { method: 'GET', path: '/v1/agents/:id' },
      { method: 'GET', path: '/v1/files' },
      { method: 'PUT', path: '/v1/vaults/:id/credentials/:id' },
      { method: 'PATCH', path: '/v1/sessions' },
      { method: 'DELETE', path: '/v1/skills' },
    ]);
  });

  it('excludes messages, models, and singular/plural organization administration only', () => {
    expect(extractOfficialRoutes([
      "this._client.post('/v1/messages?beta=true', {});",
      "this._client.get('/v1/models', {});",
      "this._client.get('/v1/organization/users', {});",
      "this._client.get('/v1/organizations/users', {});",
      "this._client.get('/v1/user_profiles', {});",
    ].join('\n'))).toEqual([{ method: 'GET', path: '/v1/user_profiles' }]);
  });

  it.each([
    'this._client.get(makePath(id), {});',
    'this._client.get((0, path_1.path) `/v1/agents/${encodeURIComponent(id)}`, {});',
    "this._client.head('/v1/agents', {});",
  ])('fails loudly for an unrecognized SDK call: %s', (source) => {
    expect(() => extractOfficialRoutes(source)).toThrow('Unrecognized SDK route');
  });
});
