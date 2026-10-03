import { describe, expect, it } from 'vitest';
import { createManagedAgentsMcpHandlers, type ManagedAgentsMcpClient } from '@/mcp/server.js';

function fakeClient(): ManagedAgentsMcpClient {
  return {
    agents: {
      async list() {
        return { data: [{ id: 'agent_one', name: 'One' }] as any };
      },
    },
    sessions: {
      async create(input) {
        return { id: 'session_one', agent: input.agent, title: input.title } as any;
      },
      async get(id) {
        return { id, type: 'session', status: 'idle' } as any;
      },
      async *chat() {
        yield { type: 'agent.message_chunk', delta: 'Hello' };
        yield { type: 'agent.message_chunk', delta: ' DSH' };
        yield { type: 'session.status_idle' };
      },
      async artifacts() {
        return { data: [{ id: 'artifact_one', filename: 'report.md' }] as any };
      },
      async stop(id) {
        return this.get(id);
      },
    },
  };
}

describe('managed-agents MCP handlers', () => {
  it('returns a resumable session envelope from stop', async () => {
    const handlers = createManagedAgentsMcpHandlers(fakeClient());
    await expect(handlers.stopSession('session_one')).resolves.toEqual({
      id: 'session_one', type: 'session', status: 'idle',
    });
  });

  it('lists agents without exposing transport details', async () => {
    const handlers = createManagedAgentsMcpHandlers(fakeClient());
    expect(await handlers.listAgents()).toEqual([{ id: 'agent_one', name: 'One' }]);
  });

  it('assembles streamed text and terminal metadata', async () => {
    const handlers = createManagedAgentsMcpHandlers(fakeClient());
    await expect(handlers.runSession({ sessionId: 'session_one', message: 'work' })).resolves.toEqual({
      session_id: 'session_one',
      text: 'Hello DSH',
      terminal_event: 'session.status_idle',
      event_count: 3,
    });
  });

  it('maps DSH-friendly session input to the SDK', async () => {
    const handlers = createManagedAgentsMcpHandlers(fakeClient());
    const session = await handlers.createSession({
      agent: 'agent_one',
      environmentId: 'env_local',
      title: 'DSH task',
    });
    expect(session).toMatchObject({ id: 'session_one', agent: 'agent_one', title: 'DSH task' });
  });
});
