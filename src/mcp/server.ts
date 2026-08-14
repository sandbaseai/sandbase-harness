import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ManagedAgentsClient,
  type AgentSummary,
  type SessionArtifactSummary,
  type SessionSummary,
  type StreamedEvent,
} from '../sdk/client.js';

export interface ManagedAgentsMcpClient {
  agents: {
    list(): Promise<{ data: AgentSummary[] }>;
  };
  sessions: {
    create(input: {
      agent: string;
      environment_id?: string;
      title?: string;
    }): Promise<SessionSummary>;
    get(id: string): Promise<SessionSummary>;
    chat(id: string, text: string): AsyncIterable<StreamedEvent>;
    artifacts(id: string): Promise<{ data: SessionArtifactSummary[] }>;
    stop(id: string): Promise<{ id: string; status: 'terminated' }>;
  };
}

export function createManagedAgentsMcpHandlers(client: ManagedAgentsMcpClient) {
  return {
    async listAgents() {
      return (await client.agents.list()).data;
    },
    async createSession(input: { agent: string; environmentId?: string; title?: string }) {
      return client.sessions.create({
        agent: input.agent,
        ...(input.environmentId ? { environment_id: input.environmentId } : {}),
        ...(input.title ? { title: input.title } : {}),
      });
    },
    async runSession(input: { sessionId: string; message: string }) {
      const events: StreamedEvent[] = [];
      let text = '';
      for await (const event of client.sessions.chat(input.sessionId, input.message)) {
        events.push(event);
        if (typeof event.delta === 'string') text += event.delta;
      }
      return {
        session_id: input.sessionId,
        text,
        terminal_event: events.at(-1)?.type ?? null,
        event_count: events.length,
      };
    },
    async getSession(sessionId: string) {
      return client.sessions.get(sessionId);
    },
    async listArtifacts(sessionId: string) {
      return (await client.sessions.artifacts(sessionId)).data;
    },
    async stopSession(sessionId: string) {
      return client.sessions.stop(sessionId);
    },
  };
}

export function createManagedAgentsMcpServer(options: {
  client?: ManagedAgentsMcpClient;
  baseUrl?: string;
  apiKey?: string;
} = {}): McpServer {
  const client = options.client ?? new ManagedAgentsClient({
    baseUrl: options.baseUrl ?? process.env.MANAGED_AGENTS_URL ?? 'http://127.0.0.1:3000',
    apiKey: options.apiKey ?? process.env.MANAGED_AGENTS_API_KEY,
  });
  const handlers = createManagedAgentsMcpHandlers(client);
  const server = new McpServer({ name: 'sandbase-harness', version: '0.1.0' });

  server.registerTool('list_agents', {
    description: 'List agents available in the connected SandBase managed-agents runtime.',
  }, async () => result(await handlers.listAgents()));

  server.registerTool('create_session', {
    description: 'Create a SandBase managed-agents session for an agent.',
    inputSchema: {
      agent: z.string().describe('Agent id, for example agent_assistant'),
      environment_id: z.string().optional().describe('Optional environment id'),
      title: z.string().optional().describe('Optional session title'),
    },
  }, async ({ agent, environment_id, title }) => result(await handlers.createSession({
    agent,
    environmentId: environment_id,
    title,
  })));

  server.registerTool('run_session', {
    description: 'Send a message to a session and wait until its streamed turn becomes idle.',
    inputSchema: {
      session_id: z.string().describe('Session id'),
      message: z.string().min(1).describe('User message to run'),
    },
  }, async ({ session_id, message }) => result(await handlers.runSession({
    sessionId: session_id,
    message,
  })));

  server.registerTool('get_session', {
    description: 'Get the current state and usage of a managed-agents session.',
    inputSchema: { session_id: z.string().describe('Session id') },
  }, async ({ session_id }) => result(await handlers.getSession(session_id)));

  server.registerTool('list_artifacts', {
    description: 'List artifacts produced by a managed-agents session.',
    inputSchema: { session_id: z.string().describe('Session id') },
  }, async ({ session_id }) => result(await handlers.listArtifacts(session_id)));

  server.registerTool('stop_session', {
    description: 'Stop a running managed-agents session.',
    inputSchema: { session_id: z.string().describe('Session id') },
  }, async ({ session_id }) => result(await handlers.stopSession(session_id)));

  return server;
}

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: asStructuredContent(value),
  };
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value };
}
