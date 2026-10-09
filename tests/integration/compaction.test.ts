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
import { CompactionStore } from '@/core/session/compaction-store.js';
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

function fakeModel(provider = 'test', modelId = 'test'): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
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
      compactor: new ContextCompactor({ contextWindowTokens: 50, triggerFraction: 0.5 }),
      compactionStore: new CompactionStore(db),
    });
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a boundary row and a content-free notification when history is large', async () => {
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
    // The official notification shape carries no content.
    expect(boundary!.content ?? []).toHaveLength(0);

    const row = db
      .prepare('SELECT * FROM compaction_boundaries WHERE session_id = ?')
      .get(session.id) as
      | { summary: string; event_seq_before: number; compacted_event_id: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.summary).toContain('SUMMARY');
    expect(row!.compacted_event_id).toBe(boundary!.id);

    // The summarize call is a model request like any other: it leaves an
    // auxiliary-marked end span and lands in the session aggregate.
    const auxSpan = events.find(
      (e) => e.type === 'span.model_request_end' && e.metadata?.auxiliary === 'context_compaction',
    );
    expect(auxSpan).toBeDefined();
    const usageRow = db
      .prepare('SELECT usage_tokens_in AS i, usage_tokens_out AS o FROM sessions WHERE id = ?')
      .get(session.id) as { i: number; o: number };
    expect(usageRow.i).toBe(auxSpan!.tokensIn);
    expect(usageRow.o).toBe(auxSpan!.tokensOut);

    // The preserved tail survives: the projection the strategy received is
    // summary + the newest group only.
    expect(strategy.lastMessageCount).toBe(2);
  });

  it('keeps tool calls paired with results in the preserved tail', async () => {
    // Wider preserve budget so the recent tool-call group survives verbatim.
    const wideCompactor = new ContextCompactor({
      contextWindowTokens: 50,
      triggerFraction: 0.5,
      preserveBudgetTokens: 200,
    });
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{ name: 'big', model: 'm', system: 'p' }],
      modelRegistry: { createModel: () => fakeModel() } as any,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy,
      eventLogger: manager.getEventLogger(),
      compactor: wideCompactor,
      compactionStore: new CompactionStore(db),
    }));

    const session = manager.create({ agent: 'agent_big' });
    const logger = manager.getEventLogger();

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
    // The most recent turn: a tool call and its result, split by a confirmation.
    logger.append(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'run ls please' }],
    });
    logger.append(session.id, {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'ls' } } as any],
    });
    logger.append(session.id, { type: 'user.tool_confirmation' });
    logger.append(session.id, {
      type: 'agent.tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt' } as any],
    });
    logger.append(session.id, {
      type: 'agent.message',
      content: [{ type: 'text', text: 'listed' }],
    });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'trigger' }],
    } as any);
    await new Promise((r) => setTimeout(r, 80));

    const row = db
      .prepare('SELECT summary, event_seq_before FROM compaction_boundaries WHERE session_id = ?')
      .get(session.id) as { summary: string; event_seq_before: number } | undefined;
    expect(row).toBeDefined();

    const messages = eventsToMessages(logger.getEvents(session.id), {
      summary: row!.summary,
      eventSeqBefore: row!.event_seq_before,
    });
    const calls = messages.flatMap((m: any) =>
      m.role === 'assistant' ? m.content.filter((p: any) => p.type === 'tool-call') : [],
    );
    const results = messages.flatMap((m: any) => (m.role === 'tool' ? m.content : []));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(results.length);
    for (const call of calls) {
      expect(results.some((r: any) => r.toolCallId === call.toolCallId)).toBe(true);
    }
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

  describe('model-aware context window and measured usage', () => {
    function executorFor(
      compactor: ContextCompactor,
      model: LanguageModel,
    ): DefaultSessionExecutor {
      return new DefaultSessionExecutor({
        agents: [{ name: 'big', model: 'm', system: 'p' }],
        modelRegistry: { createModel: () => model } as any,
        sandboxProvider: new LocalSandboxProvider(tmpDir),
        strategy,
        eventLogger: manager.getEventLogger(),
        compactor,
        compactionStore: new CompactionStore(db),
      });
    }

    async function boundaryRow(sessionId: string) {
      await new Promise((r) => setTimeout(r, 80));
      return db
        .prepare('SELECT summary FROM compaction_boundaries WHERE session_id = ?')
        .get(sessionId) as { summary: string } | undefined;
    }

    it('uses the capability-table window for a known Anthropic model', async () => {
      // claude-opus-4-5's window is 200k — the trigger sits at 160k, so a
      // measured 130k stays under it.
      manager.setExecutor(executorFor(
        new ContextCompactor(),
        fakeModel('anthropic.messages', 'claude-opus-4-5'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 100_000,
        cacheReadTokens: 30_000,
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeUndefined();
    });

    it('falls back to the default window for a model id the table does not know', async () => {
      // An unrecognized id keeps the 128k default — trigger at 102.4k, so the
      // same measured 130k exceeds it. The tiny preserve budget keeps an
      // early group outside the tail so there is something to summarize.
      manager.setExecutor(executorFor(
        new ContextCompactor({ preserveBudgetTokens: 15 }),
        fakeModel('anthropic.messages', 'claude-future-9000'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'old ' + 'x'.repeat(200) }],
      });
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 100_000,
        cacheReadTokens: 30_000,
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeDefined();
    });

    it('lets an explicit contextWindowTokens config win over the table', async () => {
      // Explicit 150k — trigger at 120k — beats the model's 200k table value.
      manager.setExecutor(executorFor(
        new ContextCompactor({ contextWindowTokens: 150_000, preserveBudgetTokens: 15 }),
        fakeModel('anthropic.messages', 'claude-opus-4-5'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'old ' + 'x'.repeat(200) }],
      });
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 100_000,
        cacheReadTokens: 30_000,
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeDefined();
    });

    it('measures an Anthropic context from the last request usage instead of estimating', async () => {
      // The chars/4 estimate of this log is ~1000 tokens, over the 800-token
      // trigger — but the provider reported 100, so nothing compacts.
      manager.setExecutor(executorFor(
        new ContextCompactor({ contextWindowTokens: 1000, triggerFraction: 0.8 }),
        fakeModel('anthropic.messages', 'claude-opus-4-5'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'x'.repeat(4000) }],
      });
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 100,
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeUndefined();
    });

    it('never measures context from an auxiliary request span', async () => {
      // The 100-token turn end is the only eligible anchor: if the 999,999-token
      // auxiliary span after it could anchor, the measurement would sit far over
      // the 800-token trigger and compact history that fits.
      manager.setExecutor(executorFor(
        new ContextCompactor({ contextWindowTokens: 1000, triggerFraction: 0.8, preserveBudgetTokens: 15 }),
        fakeModel('anthropic.messages', 'claude-opus-4-5'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'old ' + 'x'.repeat(200) }],
      });
      logger.append(session.id, { type: 'span.model_request_end', tokensIn: 100 });
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 999_999,
        metadata: { auxiliary: 'context_compaction' },
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeUndefined();
    });

    it('keeps the chars/4 estimate for a provider that reports no usage baseline', async () => {
      // Same log and same compactor, but a non-Anthropic model — the seeded
      // span is not a usage baseline it trusts, so the ~1000-token estimate
      // crosses the 800-token trigger.
      manager.setExecutor(executorFor(
        new ContextCompactor({ contextWindowTokens: 1000, triggerFraction: 0.8 }),
        fakeModel('test', 'test'),
      ));
      const session = manager.create({ agent: 'agent_big' });
      const logger = manager.getEventLogger();
      logger.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'x'.repeat(4000) }],
      });
      logger.append(session.id, {
        type: 'span.model_request_end',
        tokensIn: 100,
      });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'next' }],
      } as any);
      expect(await boundaryRow(session.id)).toBeDefined();
    });
  });
});
