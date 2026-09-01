/**
 * Integration test: memory injection + extraction through the executor (R9.18).
 *
 * Verifies that when a session has a context_id and a memory provider is wired:
 * - the user message is extracted into memory after the turn
 * - a subsequent session with the same context_id sees it injected into the
 *   system prompt handed to the strategy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SqliteMemoryProvider } from '@/core/memory/sqlite-memory-provider.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't',
    supportedUrls: {},
    async doGenerate() { return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any; },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

class CapturingStrategy implements AgentStrategy {
  readonly name = 'capture';
  lastSystemPrompt = '';
  // eslint-disable-next-line require-yield
  async *execute(ctx: StrategyContext) {
    this.lastSystemPrompt = ctx.systemPrompt;
    return;
  }
}

describe('Memory wiring', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let strategy: CapturingStrategy;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memw-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_m', 'm', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => fakeModel();
    strategy = new CapturingStrategy();
    const executor = new DefaultSessionExecutor({
      agents: [{ name: 'm', model: 'm', system: 'base prompt' }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy,
      eventLogger: manager.getEventLogger(),
      memory: new SqliteMemoryProvider(db),
    });
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts the user message into memory and injects it into a later session', async () => {
    // Session 1 with context_id — records a preference
    const s1 = manager.create({ agent: 'agent_m', contextId: 'user_42' });
    await manager.sendEvent(s1.id, { type: 'user.message', content: [{ type: 'text', text: 'I strongly prefer Rust for systems code' }] } as any);
    await new Promise((r) => setTimeout(r, 60));

    // Session 2, same context_id — memory should be injected into the prompt
    const s2 = manager.create({ agent: 'agent_m', contextId: 'user_42' });
    await manager.sendEvent(s2.id, { type: 'user.message', content: [{ type: 'text', text: 'What language should I use for Rust systems work' }] } as any);
    await new Promise((r) => setTimeout(r, 60));

    expect(strategy.lastSystemPrompt).toContain('Relevant Memory');
    expect(strategy.lastSystemPrompt).toContain('prefer Rust');
  });

  it('does not inject memory when the session has no context_id', async () => {
    const s = manager.create({ agent: 'agent_m' }); // no contextId
    await manager.sendEvent(s.id, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] } as any);
    await new Promise((r) => setTimeout(r, 60));
    expect(strategy.lastSystemPrompt).not.toContain('Relevant Memory');
    expect(strategy.lastSystemPrompt).toBe('base prompt');
  });
});
