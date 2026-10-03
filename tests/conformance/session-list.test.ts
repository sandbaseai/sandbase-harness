/**
 * `GET /v1/sessions` parameters end to end, through the official SDK.
 *
 * The official `sessions.list` sends `statuses[]`, `order`,
 * `include_archived`, `agent_id`, and cursor `page`s; this suite asserts the
 * runtime answers all of them and that SDK auto-pagination walks both pages
 * without repeats or gaps.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK sessions.list over HTTP', () => {
  it('honours the published filters and paginates both directions', async () => {
    const stub = await startStubModelServer();
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const agentId = agents.data[0]!.id;
      const environmentId = environments.data[0]!.id;

      const created = [];
      for (let index = 0; index < 3; index += 1) {
        created.push(await client.beta.sessions.create({ agent: agentId, environment_id: environmentId }));
      }
      const archived = await client.beta.sessions.archive(created[2]!.id);
      expect(archived.archived_at).not.toBeNull();

      // The default page excludes the archived session entirely.
      const first = await client.beta.sessions.list({ limit: 2 });
      expect(first.data).toHaveLength(2);
      expect(first.data.map((session) => session.id)).not.toContain(created[2]!.id);
      expect(first.next_page).toBeNull();

      // `include_archived` plus `order` over two pages: every session exactly
      // once, oldest first.
      const seen: string[] = [];
      const createdAt: string[] = [];
      for await (const session of client.beta.sessions.list({ limit: 2, order: 'asc', include_archived: true })) {
        seen.push(session.id);
        createdAt.push(session.created_at);
      }
      expect(new Set(seen).size).toBe(3);
      expect([...createdAt].sort()).toEqual(createdAt);

      // `statuses[]` projects onto the internal grouping: the two live
      // sessions are idle, the archived one terminated.
      const idleIds = (await client.beta.sessions.list({ statuses: ['idle'] })).data.map((session) => session.id);
      expect(idleIds).toHaveLength(2);
      expect(idleIds).not.toContain(created[2]!.id);

      const terminatedIds = (await client.beta.sessions.list({ statuses: ['terminated'], include_archived: true }))
        .data.map((session) => session.id);
      expect(terminatedIds).toEqual([created[2]!.id]);

      // The remaining filters answer against the same list.
      expect((await client.beta.sessions.list({ agent_id: agentId })).data).toHaveLength(2);
      expect((await client.beta.sessions.list({ 'created_at[gte]': createdAt[0]! })).data).toHaveLength(2);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);
});
