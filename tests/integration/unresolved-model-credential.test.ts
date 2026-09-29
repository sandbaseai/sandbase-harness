/**
 * A turn whose provider credential is an unset `${VAR}`.
 *
 * `init` writes `api_key: ${OPENAI_API_KEY}` into the workspace config, so this
 * is the shape a new user starts from. Resolving it leniently left the
 * placeholder in place and sent `${OPENAI_API_KEY}` to the provider as the
 * credential, which answers 401 — an error that names neither the variable nor
 * the field, and invites the operator to look at the model id instead.
 *
 * The contract asserted here is the whole first-run story: the failing turn
 * names the variable and does not call the provider at all, the session stays
 * usable, and the *same* session completes once the variable exists. A test that
 * only checked the message wording would pass on a runtime that had already sent
 * the placeholder upstream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { STUB_REPLY_TEXT, startStubModelServer, type StubModelServer } from '../conformance/support/stub-model-server.js';

const CREDENTIAL_VAR = 'SANDBASE_TEST_UNRESOLVED_CREDENTIAL';

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the turn to settle');
}

describe('A turn whose provider credential variable is not set', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let stub: StubModelServer;

  beforeEach(async () => {
    vi.stubEnv(CREDENTIAL_VAR, undefined as unknown as string);
    delete process.env[CREDENTIAL_VAR];
    stub = await startStubModelServer();

    tmpDir = mkdtempSync(join(tmpdir(), 'ma-unresolved-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_b', 'b', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    // A real registry, deliberately: the point of the test is the resolution
    // path, so `createModel` must not be stubbed out.
    modelRegistry.register({
      name: 'deepseek',
      provider: 'openai_compatible',
      base_url: stub.baseUrl,
      api_key: `\${${CREDENTIAL_VAR}}`,
      is_default: true,
    });
    const executor = new DefaultSessionExecutor({
      agents: [{ name: 'b', model: 'deepseek-chat', system: 'p' }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    await stub.close();
  });

  it('names the variable, calls no provider, and resumes once it is set', async () => {
    const session = manager.create({ agent: 'agent_b' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);

    await waitFor(() => manager.get(session.id)!.status === 'paused');
    const events = manager.getEventLogger().getEvents(session.id);
    const errorEvent = events.find((event) => event.type === 'session.error');
    expect(errorEvent).toBeDefined();
    const error = (errorEvent!.metadata as { error: { type: string; message: string } }).error;

    expect(error.type).toBe('model_config_invalid');
    expect(error.message).toContain(CREDENTIAL_VAR);
    expect(error.message).toContain('api_key');
    // The refusal happens before the request, so the placeholder never reaches
    // the provider as a credential.
    expect(stub.requests).toHaveLength(0);

    // Resumable, not terminal: a repairable configuration mistake must not end
    // the session.
    expect(manager.get(session.id)!.status).toBe('paused');

    // Fix the environment the way the error says to, then continue the same
    // session. This is the second half of the first-run story, and it fails if
    // the refusal above was really a dead end.
    process.env[CREDENTIAL_VAR] = 'resolved-test-credential';
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi again' }],
    } as never);

    await waitFor(() => stub.requests.length > 0);
    await waitFor(() => manager.getEventLogger().getEvents(session.id).some((event) => event.type === 'agent.message'));

    const resumed = manager.getEventLogger().getEvents(session.id);
    const messages = resumed.filter((event) => event.type === 'agent.message');
    expect(JSON.stringify(messages)).toContain(STUB_REPLY_TEXT);
  });

  it('refuses a variable that is set to the empty string, which no longer reaches the provider', async () => {
    // `KEY=""` resolves, so a lenient reading built a client with an empty
    // credential and the provider's 401 named nothing — the same misdirection as
    // the placeholder, one step quieter. The settings layer calls the state
    // `missing_env`; this asserts the turn does too, and that nothing is sent.
    process.env[CREDENTIAL_VAR] = '';
    const session = manager.create({ agent: 'agent_b' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);

    await waitFor(() => manager.get(session.id)!.status === 'paused');
    const errorEvent = manager
      .getEventLogger()
      .getEvents(session.id)
      .find((event) => event.type === 'session.error');
    expect(errorEvent).toBeDefined();
    const error = (errorEvent!.metadata as { error: { type: string; message: string } }).error;

    expect(error.type).toBe('model_config_invalid');
    expect(error.message).toContain(CREDENTIAL_VAR);
    expect(error.message).toContain('empty value');
    expect(stub.requests).toHaveLength(0);
  });
});
