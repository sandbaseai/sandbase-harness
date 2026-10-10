/**
 * External authorization freshness — the #812 pilot shape, end to end.
 *
 * One live session makes two calls to a governed tool. The authorizer admits
 * the first (policy v1), then rolls its policy forward and answers
 * `reauthorize` for the second — the stale authorization must not carry the
 * call across the execution boundary: the tool's `execute` never runs, the
 * model sees a synthetic error result, and an `agent.external_authorization`
 * audit event binds the refusal to the invocation without secrets.
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
import type { EnvironmentConfig } from '@/types/sandbox.js';
import type { LanguageModel } from 'ai';
import type {
  ExternalAuthorizationHook,
  ExternalAuthorizationRequest,
} from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

type Turn =
  | { call: { id: string; toolName: string; input: string } }
  | { text: string };

/** A model that replays a fixed script, one turn per `doStream`. */
function scriptedModel(turns: Turn[]): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-external-authorization',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      const script = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if ('call' in script) {
              controller.enqueue({ type: 'tool-input-start', id: script.call.id, toolName: script.call.toolName });
              controller.enqueue({ type: 'tool-input-delta', id: script.call.id, delta: script.call.input });
              controller.enqueue({ type: 'tool-input-end', id: script.call.id });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: script.call.id,
                toolName: script.call.toolName,
                input: script.call.input,
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: script.text });
              controller.enqueue({ type: 'text-end', id: 'text_1' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: 'call' in script ? TOOL_CALLS : STOP,
              usage: USAGE,
            });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function toolResultText(event: SessionEvent): string {
  return typeof event.content?.[0] === 'object' && event.content[0] !== null
    ? JSON.stringify(event.content[0])
    : String(event.content ?? '');
}

describe('external authorization freshness', () => {
  let db: Database | undefined;
  let workspace: string | undefined;
  let manager: SessionManager | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ma-ext-authz-'));
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    manager = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  async function setUp(turns: Turn[], authorizeExternal?: ExternalAuthorizationHook) {
    db = new Database(join(workspace!, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_reader', 'reader', '{}')");

    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const model = scriptedModel(turns);
    (registry as any).createModel = () => model;
    const executor = new DefaultSessionExecutor({
      agents: [{
        name: 'reader',
        model: 'scripted',
        system: 'Read the file.',
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
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(workspace!),
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
      ...(authorizeExternal ? { authorizeExternal } : {}),
    });
    manager.setExecutor(executor);
    return manager;
  }

  async function runTurn(mgr: SessionManager): Promise<SessionEvent[]> {
    const session = mgr.create({ agent: 'agent_reader' });
    await mgr.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'read it' }],
    } as any);
    await waitFor(
      () => {
        const status = mgr.get(session.id)?.status;
        return status === 'paused' || status === 'completed' || status === 'requires_action' ? status : undefined;
      },
      'the turn to settle',
    );
    return mgr.getEventLogger().getEvents(session.id);
  }

  it('blocks a stale authorization before the second execution and audits it', async () => {
    const consulted: ExternalAuthorizationRequest[] = [];
    // The authorizer admits call 1 under policy v1, then rolls to v2: the same
    // session's next call is answered `reauthorize` — the stale verdict must
    // not carry the second execution.
    let policyVersion = 'v1';
    const hook: ExternalAuthorizationHook = async (request) => {
      consulted.push(request);
      if (policyVersion === 'v1') {
        policyVersion = 'v2'; // the external policy rolls forward mid-session
        return { type: 'allow' };
      }
      return { type: 'refuse', reasonCode: 'reauthorize', reason: 'stale_policy', policy_version: 'v2' };
    };
    const mgr = await setUp([
      { call: { id: 'call_1', toolName: 'read', input: JSON.stringify({ path: 'note.txt' }) } },
      { call: { id: 'call_2', toolName: 'read', input: JSON.stringify({ path: 'note.txt' }) } },
      { text: 'done' },
    ], hook);

    const events = await runTurn(mgr);

    // The hook saw both invocations, bound to their tool-call ids.
    expect(consulted.map((r) => r.invocation_id)).toEqual(['call_1', 'call_2']);
    expect(consulted[0]?.capability).toBe('tool.execute');
    expect(consulted[0]?.target).toBe('read');
    expect(consulted[0]?.digest_schema).toBe('sandbase.digest/v1');

    const results = events.filter((e) => e.type === 'agent.tool_result');
    expect(results).toHaveLength(2);
    // The admitted call produced an ordinary result; the stale call was
    // refused before `execute` — the model reads a synthetic error result.
    expect(toolResultText(results[0]!)).not.toContain('refused by external authorization');
    expect(toolResultText(results[1]!)).toContain('refused by external authorization (reauthorize)');
    expect(results[1]!.isError).toBe(true);

    // The refusal is the auditable record, bound to the invocation and
    // carrying digests only — no raw arguments, no secrets.
    const audits = events.filter((e) => e.type === 'agent.external_authorization');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      invocation_id: 'call_2',
      capability: 'tool.execute',
      target: 'read',
      reason_code: 'reauthorize',
      reason: 'stale_policy',
      policy_version: 'v2',
    });
    expect(typeof audits[0]!.metadata?.arguments_digest).toBe('string');
    expect(typeof audits[0]!.metadata?.policy_context_digest).toBe('string');
  });

  it('changes nothing when the hook is not configured', async () => {
    const mgr = await setUp([
      { call: { id: 'call_1', toolName: 'read', input: JSON.stringify({ path: 'note.txt' }) } },
      { text: 'done' },
    ]);

    const events = await runTurn(mgr);

    expect(events.filter((e) => e.type === 'agent.external_authorization')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'agent.tool_result')).toHaveLength(1);
  });
});
