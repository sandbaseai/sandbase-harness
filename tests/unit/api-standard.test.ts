import { describe, expect, it } from 'vitest';
import { toApiEvent, toApiSession, toApiSessionStatus } from '@/api/standard.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session, SessionEvent } from '@/types/session.js';

/**
 * The published key set of `BetaManagedAgentsSession`, transcribed from
 * `@anthropic-ai/sdk@0.129.0`
 * (`resources/beta/sessions/sessions.d.ts`). Two fields are intentionally out
 * of the expected set: `deployment_id` (optional upstream; this runtime has no
 * deployments) and `outcome_evaluations` (required upstream, but its
 * derivation is a separate work item — see the session-lifecycle design).
 * `loop_engine` is the only permitted extra: a local extension the upstream
 * shape has no equivalent for.
 */
const OFFICIAL_SESSION_KEYS = [
  'id',
  'agent',
  'archived_at',
  'budget',
  'created_at',
  'environment_id',
  'metadata',
  'outcome_evaluations',
  'resources',
  'stats',
  'status',
  'title',
  'type',
  'updated_at',
  'usage',
  'vault_ids',
] as const;
const LOCAL_SESSION_EXTENSIONS = ['loop_engine'] as const;

const agent: AgentDefinition = { name: 'assistant', model: 'test-model', system: 'Be brief.' };

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_1',
    agentId: 'assistant',
    agentName: 'assistant',
    agentVersion: 3,
    environmentId: 'local',
    status: 'completed',
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T00:00:10.000Z'),
    ...overrides,
  };
}

describe('standard API event serialization', () => {
  it('exposes sequence, immutable metadata, and model attribution', () => {
    const event: SessionEvent = {
      id: 'sevt_1',
      sessionId: 'sess_1',
      seq: 7,
      type: 'agent.message',
      content: [{ type: 'text', text: 'done' }],
      metadata: { request_id: 'req_1' },
      modelUsed: 'test-model',
      tokensIn: 11,
      tokensOut: 13,
      stopReason: 'stop',
      durationMs: 21,
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
    };

    expect(toApiEvent(event)).toMatchObject({
      id: 'sevt_1',
      seq: 7,
      metadata: { request_id: 'req_1' },
      model_used: 'test-model',
      tokens_in: 11,
      tokens_out: 13,
      stop_reason: 'stop',
      duration_ms: 21,
    });
  });

  it('projects a durable confirmation target and idle status while awaiting approval', () => {
    const event: SessionEvent = {
      id: 'sevt_2',
      sessionId: 'sess_1',
      seq: 8,
      type: 'user.tool_confirmation',
      metadata: { tool_use_id: 'tool_1', result: 'allow', confirmation_group_id: 'confirm_1' },
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
    };

    expect(toApiEvent(event)).toMatchObject({
      seq: 8,
      tool_use_id: 'tool_1',
      metadata: { result: 'allow', confirmation_group_id: 'confirm_1' },
    });
    expect(toApiSessionStatus('requires_action')).toBe('idle');
  });
});

describe('standard API session serialization', () => {
  it('emits exactly the official session keys plus the loop_engine extension', () => {
    const api = toApiSession(session(), agent);
    const allowed = new Set<string>([...OFFICIAL_SESSION_KEYS, ...LOCAL_SESSION_EXTENSIONS]);

    expect(Object.keys(api).every((key) => allowed.has(key))).toBe(true);
    for (const key of OFFICIAL_SESSION_KEYS) {
      expect(api, `missing official key ${key}`).toHaveProperty(key);
    }
  });

  it('always carries budget, reporting null when the session has none', () => {
    expect(toApiSession(session(), agent).budget).toBeNull();
    // A removed budget and a never-set budget publish identically: both null.
    expect(toApiSession(session({ budget: null }), agent).budget).toBeNull();
    expect(
      toApiSession(
        session({ budget: { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } } }),
        agent,
      ).budget,
    ).toEqual({ type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } });
  });

  it('reports agent.multiagent as null and pins agent.version to the session snapshot', () => {
    const api = toApiSession(session({ agentVersion: 3 }), agent);
    expect(api.agent).toMatchObject({ version: 3, multiagent: null });
  });

  it('keeps version and multiagent on the fallback agent reference', () => {
    const api = toApiSession(session({ agentVersion: 7, agentDefinition: undefined }));
    expect(api.agent).toMatchObject({ id: 'assistant', version: 7, multiagent: null });
  });

  it('reports stats.active_seconds from the caller and duration since creation', () => {
    const api = toApiSession(session({ status: 'running' }), agent, {
      activeSeconds: 42.5,
      now: new Date('2026-09-14T00:00:30.000Z'),
    });
    expect(api.stats).toEqual({ active_seconds: 42.5, duration_seconds: 30 });
  });

  it('freezes duration_seconds at the last update once the session is terminal', () => {
    const api = toApiSession(session({ status: 'failed' }), agent, {
      activeSeconds: 4,
      now: new Date('2026-09-15T00:00:00.000Z'),
    });
    // updatedAt - createdAt = 10s; the read time (a day later) must not extend it.
    expect(api.stats).toEqual({ active_seconds: 4, duration_seconds: 10 });
  });

  it('freezes duration_seconds at the last update once the session is archived', () => {
    const api = toApiSession(session({ status: 'running', archivedAt: new Date('2026-09-14T00:01:00.000Z') }), agent, {
      activeSeconds: 0,
      now: new Date('2026-09-15T00:00:00.000Z'),
    });
    expect(api.stats.duration_seconds).toBe(10);
  });

  it('defaults stats.active_seconds to 0 for a session without event input', () => {
    expect(toApiSession(session(), agent).stats.active_seconds).toBe(0);
  });
});
