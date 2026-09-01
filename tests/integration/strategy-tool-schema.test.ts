import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import type { LanguageModel } from 'ai';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;

function streamingTextModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'streaming-text',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: STOP,
        usage: USAGE,
        warnings: [],
      } as any;
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'txt_1' });
            controller.enqueue({ type: 'text-delta', id: 'txt_1', delta: 'ok' });
            controller.enqueue({ type: 'text-end', id: 'txt_1' });
            controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

describe('DefaultStrategy tool schemas', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-tool-schema-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_tool_user', 'tool-user', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => streamingTextModel();
    const executor = new DefaultSessionExecutor({
      agents: [{
        name: 'tool-user',
        model: 'm',
        system: 'p',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          configs: [
            { name: 'read', enabled: true },
          ],
        }],
      }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts runtime JSON Schema tool definitions when streaming', async () => {
    const session = manager.create({ agent: 'agent_tool_user' });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(manager.get(session.id)!.status).toBe('paused');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(events.some((event) => event.type === 'agent.message')).toBe(true);
  });
});
