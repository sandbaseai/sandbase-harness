/**
 * Exercise the real Anthropic adapter and session loop with a clean SSE EOF.
 * A complete tool-input block is not sufficient authority: message_stop must
 * complete the provider stream before a confirmation can authorize its call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toApiEvent } from '@/api/standard.js';
import { Database } from '@/core/db/database.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';

const CALL_ID = 'toolu_write_1';
const FILE_NAME = 'approved.txt';
const FILE_CONTENT = 'approved exactly once';
const PARTIAL_TEXT = 'I will write the file.';

function responseBody(complete: boolean, withTool: boolean): string {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', content: [],
        model: 'claude-sonnet-4-5', stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: withTool ? PARTIAL_TEXT : 'Done.' },
    },
    { type: 'content_block_stop', index: 0 },
  ];
  if (withTool) {
    events.push(
      {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: CALL_ID, name: 'write', input: {} },
      },
      {
        type: 'content_block_delta', index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ path: FILE_NAME, content: FILE_CONTENT }),
        },
      },
      { type: 'content_block_stop', index: 1 },
    );
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: withTool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  if (complete) events.push({ type: 'message_stop' });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('Anthropic stream completion and confirmation authority', () => {
  let workspace: string;
  let db: Database;
  let manager: SessionManager;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ma-anthropic-interruption-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_write', 'write-agent', '{}')");
    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({
      name: 'default', provider: 'anthropic', api_key: 'test-key',
      base_url: 'https://anthropic.invalid/v1', is_default: true,
    });
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{
        name: 'write-agent', model: 'claude-sonnet-4-5', system: 'Use the write tool.',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: { enabled: false, permission_policy: { type: 'always_ask' } },
          configs: [{ name: 'write', enabled: true }],
        }],
      }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(workspace),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it.each([false, true])('requires message_stop for approval authority (complete=%s)', async (complete) => {
    const fetch = vi.fn(async () => new Response(responseBody(complete, true), {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetch);
    const session = manager.create({ agent: 'agent_write' });
    await manager.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'write the file' }],
    });
    await vi.waitFor(() => {
      expect(manager.get(session.id)?.status).toBe(complete ? 'requires_action' : 'paused');
    });

    const events = manager.getEventLogger().getEvents(session.id);
    const message = events.find((event) => event.type === 'agent.message');
    expect(message).toBeDefined();
    expect(toApiEvent(message!)).toMatchObject({
      content: [{ type: 'text', text: PARTIAL_TEXT }],
      stop_reason: complete ? 'tool-calls' : 'interrupted',
    });
    expect(events.filter((event) => event.type === 'span.model_request_end')).toEqual([
      expect.objectContaining({ stopReason: complete ? 'tool-calls' : 'interrupted', isError: false }),
    ]);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(events.filter((event) => event.type === 'agent.tool_use')).toHaveLength(complete ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const outputPath = join(workspace, 'sandbox', session.id, FILE_NAME);
    expect(existsSync(outputPath)).toBe(false);

    const confirmation = { type: 'user.tool_confirmation', tool_use_id: CALL_ID, result: 'allow' } as const;
    if (complete) {
      fetch.mockImplementation(async () => new Response(responseBody(true, false), {
        headers: { 'content-type': 'text/event-stream' },
      }));
      await manager.sendEvent(session.id, confirmation);
      await vi.waitFor(() => expect(manager.get(session.id)?.status).toBe('paused'));
      expect(readFileSync(outputPath, 'utf8')).toBe(FILE_CONTENT);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    await expect(manager.sendEvent(session.id, confirmation)).rejects.toThrow('not awaiting approval');
    if (!complete) {
      expect(existsSync(outputPath)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(manager.getEventLogger().getEvents(session.id)).toEqual(events);
    }
  });
});
