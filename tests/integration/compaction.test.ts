/**
 * Integration test: compaction boundary is written during execution and
 * honored by the next projection (R9.15).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { ContextCompactor } from '@/core/session/context-compactor.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

// Strategy that just records the message count it was handed and emits nothing.
class NoopStrategy implements AgentStrategy {
  readonly name = 'noop';
  lastMessageCount = 0;
  // eslint-disable-next-line require-yield
  async *execute(ctx: StrategyContext) {
    this.lastMessageCount = ctx.messages.length;
    return;
  }
}

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text: 'SUMMARY: prior conversation compacted' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as any;
    },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

describe('Compaction during execution', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let strategy: NoopStrategy;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-comp-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_big', 'big', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    // Register model resolves to our fake via a stub provider path — but the
    // executor calls modelRegistry.createModel which needs a registered entry.
    // Simplest: monkeypatch createModel to return the fake model.
    (modelRegistry as any).createModel = () => fakeModel();

    strategy = new NoopStrategy();
    const executor = new DefaultSessionExecutor({
      agents: [{ name: 'big', model: 'm', system: 'p' }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy,
      eventLogger: manager.getEventLogger(),
      // Aggressive compactor: tiny window so it always triggers
      compactor: new ContextCompactor({ contextWindowTokens: 50, triggerFraction: 0.5, preserveTailMessages: 1 }),
    });
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a compaction boundary event when history is large', async () => {
    const session = manager.create({ agent: 'agent_big' });
    const logger = manager.getEventLogger();

    // Seed a large history directly
    for (let i = 0; i < 6; i++) {
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'x'.repeat(200) }],
      });
      logger.append(session.id, {
        type: 'agent.message',
        content: [{ type: 'text', text: 'y'.repeat(200) }],
      });
    }

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'trigger' }],
    } as any);

    // Let the async turn run
    await new Promise((r) => setTimeout(r, 80));

    const events = logger.getEvents(session.id);
    const boundary = events.find((e) => e.type === 'agent.thread_context_compacted');
    expect(boundary).toBeDefined();
    expect((boundary!.content![0] as any).text).toContain('SUMMARY');
  });

  it('projection after boundary includes the summary and drops old messages', async () => {
    const session = manager.create({ agent: 'agent_big' });
    const logger = manager.getEventLogger();

    logger.append(session.id, { type: 'user.message', content: [{ type: 'text', text: 'ancient history' }] });
    logger.append(session.id, { type: 'agent.thread_context_compacted', content: [{ type: 'text', text: 'the summary' }] });
    logger.append(session.id, { type: 'user.message', content: [{ type: 'text', text: 'fresh question' }] });

    const msgs = eventsToMessages(logger.getEvents(session.id));
    const joined = msgs.flatMap((m: any) =>
      typeof m.content === 'string' ? [m.content] : m.content.map((p: any) => p.text ?? ''),
    ).join(' ');

    expect(joined).toContain('the summary');
    expect(joined).toContain('fresh question');
    expect(joined).not.toContain('ancient history');
  });
});
