/**
 * Integration test: tool confirmation flow (A5, R requires_action).
 *
 * Verifies:
 * - a strategy signalling onRequiresAction transitions the session to requires_action
 * - user.tool_confirmation(allow) executes the pending tool and appends a result
 * - user.tool_confirmation(deny) appends an error result
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
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

describe('Tool confirmation — requires_action transition', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-confirm-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transitions to requires_action when the strategy signals it', async () => {
    const strat: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(_session, _event, options) {
        options?.onRequiresAction?.();
        return;
      },
    };
    manager.setExecutor(strat);

    const session = manager.create({ agent: 'agent_x' });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);
    await new Promise((r) => setTimeout(r, 60));

    expect(manager.get(session.id)!.status).toBe('requires_action');
  });

  it('accepts a follow-up event after requires_action', async () => {
    let turns = 0;
    const strat: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(_session, _event, options) {
        turns++;
        if (turns === 1) options?.onRequiresAction?.();
        return;
      },
    };
    manager.setExecutor(strat);

    const session = manager.create({ agent: 'agent_x' });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);
    await new Promise((r) => setTimeout(r, 40));
    expect(manager.get(session.id)!.status).toBe('requires_action');

    // Confirm — a second turn runs and completes (idle)
    await manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: 'c1', result: 'allow' } as any);
    await new Promise((r) => setTimeout(r, 40));
    expect(turns).toBe(2);
    expect(manager.get(session.id)!.status).toBe('paused');
  });
});

describe('Tool confirmation — execute/deny pending tool', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  /** Noop strategy so the model turn after confirmation is a no-op. */
  class NoopStrategy implements AgentStrategy {
    readonly name = 'noop';
    // eslint-disable-next-line require-yield
    async *execute(_ctx: StrategyContext) { return; }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-confirm2-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_bash', 'bash-agent', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => fakeModel();
    const executor = new DefaultSessionExecutor({
      agents: [{
        name: 'bash-agent',
        model: 'm',
        system: 'p',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          configs: [
            {
              name: 'bash',
              enabled: true,
              permission_policy: { type: 'always_ask' },
            },
          ],
        }],
      }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new NoopStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPendingToolUse(sessionId: string) {
    manager.getEventLogger().append(sessionId, {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'echo confirmed' } }],
    });
  }

  it('executes the pending tool on allow and appends the result', async () => {
    const session = manager.create({ agent: 'agent_bash' });
    // Simulate the prior turn left it awaiting confirmation
    db.prepare(`UPDATE sessions SET status='requires_action' WHERE id=?`).run(session.id);
    seedPendingToolUse(session.id);

    await manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: 'call_1', result: 'allow' } as any);
    await new Promise((r) => setTimeout(r, 80));

    const events = manager.getEventLogger().getEvents(session.id);
    const result = events.find((e) => e.type === 'agent.tool_result' && (e.content?.[0] as any)?.tool_use_id === 'call_1');
    expect(result).toBeDefined();
    expect((result!.content![0] as any).content).toContain('confirmed');
    expect((result!.content![0] as any).is_error).toBeFalsy();
  });

  it('appends an error result on deny', async () => {
    const session = manager.create({ agent: 'agent_bash' });
    db.prepare(`UPDATE sessions SET status='requires_action' WHERE id=?`).run(session.id);
    seedPendingToolUse(session.id);

    await manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: 'call_1', result: 'deny', deny_message: 'nope' } as any);
    await new Promise((r) => setTimeout(r, 80));

    const events = manager.getEventLogger().getEvents(session.id);
    const result = events.find((e) => e.type === 'agent.tool_result' && (e.content?.[0] as any)?.tool_use_id === 'call_1');
    expect(result).toBeDefined();
    expect((result!.content![0] as any).is_error).toBe(true);
    expect((result!.content![0] as any).content).toContain('nope');
  });
});
