/**
 * Integration test: model/provider errors surface as a failed turn (not a
 * silent idle). Covers the fullStream 'error' part handling in DefaultStrategy.
 */

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

/** A model whose stream throws — simulates a provider/auth/network failure. */
function throwingModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'boom',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('401 unauthorized');
    },
    async doStream() {
      throw new Error('401 unauthorized');
    },
  } as unknown as LanguageModel;
}

describe('Model error → failed turn', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-strerr-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_b', 'b', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => throwingModel();
    const executor = new DefaultSessionExecutor({
      agents: [{ name: 'b', model: 'm', system: 'p' }],
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

  it('transitions to failed and records a session.error (not silent idle)', async () => {
    const session = manager.create({ agent: 'agent_b' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as any);

    // Wait for the turn to fail
    await new Promise((r) => setTimeout(r, 200));

    const status = manager.get(session.id)!.status;
    expect(status).toBe('failed');

    const events = manager.getEventLogger().getEvents(session.id);
    const errEvent = events.find((e) => e.type === 'session.error');
    expect(errEvent).toBeDefined();
  });

  it('accepts a new message on a failed session and resumes the turn', async () => {
    const session = manager.create({ agent: 'agent_b' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as any);
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.get(session.id)!.status).toBe('failed');

    // A failed session is recoverable: sending another message must be
    // accepted (not rejected as terminal) and must re-run the turn.
    const result = await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'retry please' }],
    } as any);
    expect(result.accepted).toBe(true);

    // The resume runs a fresh turn. Its status_running event proves the
    // failed → running transition was allowed. (This model always throws, so
    // it lands back in failed — the point is the turn was re-entered.)
    await new Promise((r) => setTimeout(r, 200));
    const events = manager.getEventLogger().getEvents(session.id);
    const runningEvents = events.filter((e) => e.type === 'session.status_running');
    expect(runningEvents.length).toBe(2);
    const userMessages = events.filter((e) => e.type === 'user.message');
    expect(userMessages.length).toBe(2);
  });
});
