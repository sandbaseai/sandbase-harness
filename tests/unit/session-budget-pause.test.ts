/**
 * Budget pause: a turn whose spend crosses the session's ceiling stops after
 * the step that crossed it and the session idles with
 * `stop_reason: {type: 'budget_reached'}`; an accepted budget update then
 * re-enters the turn loop on an internal trigger — no `user.message` is
 * appended for it.
 *
 * The fake executor stands in for the strategy's `stopWhen` loop: it records
 * the spend a step would have committed and then honours the `budgetExhausted`
 * callback exactly the way `DefaultStrategy`'s `stopWhen` reads it after each
 * `onStepFinish`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import type { ExecuteOptions, SessionExecutor } from '@/core/session/session-manager.js';
import type { Session, SessionEvent, TurnTrigger } from '@/types/session.js';
import type { CostProfile } from '@/core/session/cost-profile.js';

const PROFILE: CostProfile = {
  id: 'test',
  models: {
    'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 },
  },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

describe('SessionManager budget pause', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-budget-pause-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_priced',
      'priced-agent',
      JSON.stringify({ name: 'priced-agent', model: 'model-priced', system: 'You are a test agent.' }),
    );
    manager = new SessionManager(db);
    manager.setCostProfile(PROFILE);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const events = (sessionId: string) => manager.getEventLogger().getEvents(sessionId);
  const idleEvents = (sessionId: string) =>
    events(sessionId).filter((event) => event.type === 'session.status_idle');
  const lastIdleReason = (sessionId: string) =>
    (idleEvents(sessionId).at(-1)?.metadata as { stop_reason?: { type?: string } } | undefined)?.stop_reason?.type;

  /** The spend a step commits, written the same way `onStepFinish` records it. */
  function recordStepSpend(sessionId: string, tokens: number): void {
    manager.getEventLogger().append(sessionId, {
      type: 'span.model_request_end',
      modelUsed: 'model-priced',
      tokensIn: tokens,
      tokensOut: 0,
    });
  }

  async function waitForIdleReason(sessionId: string): Promise<void> {
    await vi.waitFor(() => expect(lastIdleReason(sessionId)).toBeTruthy());
  }

  it('idles a turn that crosses the ceiling on budget_reached, usage immediately before', async () => {
    const execute = vi.fn(async function* (_session: Session, _event: TurnTrigger, options?: ExecuteOptions) {
      // One model request's worth of spend: 10 cents at 1c/1000 tokens.
      recordStepSpend(_session.id, 10_000);
      // What streamText's stopWhen does after onStepFinish commits the step.
      if (options?.budgetExhausted?.()) return;
      yield { type: 'agent.message', content: [{ type: 'text', text: 'past the cap' }] } as SessionEvent;
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend' }] });
    await waitForIdleReason(session.id);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(manager.get(session.id)!.status).toBe('paused');
    expect(lastIdleReason(session.id)).toBe('budget_reached');
    const log = events(session.id);
    const idleIndex = log.findIndex((event) => event.type === 'session.status_idle');
    expect(log[idleIndex - 1]?.type).toBe('session.usage');
  });

  it('prefers requires_action over budget_reached when a call is still parked at the cap', async () => {
    const execute = vi.fn(async function* (session: Session, _event: TurnTrigger, options?: ExecuteOptions) {
      recordStepSpend(session.id, 10_000);
      options?.onRequiresAction?.();
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend and park' }] });
    await waitForIdleReason(session.id);

    expect(manager.get(session.id)!.status).toBe('requires_action');
    expect(lastIdleReason(session.id)).toBe('requires_action');
  });

  it('resumes on the internal trigger after the ceiling is raised — no user.message appended', async () => {
    const execute = vi.fn(async function* (session: Session, event: TurnTrigger, options?: ExecuteOptions) {
      if (event.type === 'internal.resume_after_budget') return;
      recordStepSpend(session.id, 10_000);
      if (options?.budgetExhausted?.()) return;
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend' }] });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('budget_reached'));

    await manager.updateSession(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('end_turn'));

    const triggers = execute.mock.calls.map(([, event]) => event.type);
    expect(triggers).toEqual(['user.message', 'internal.resume_after_budget']);
    // The resume never invents an utterance: the log gains lifecycle events only.
    expect(events(session.id).filter((event) => event.type === 'user.message')).toHaveLength(1);
    expect(events(session.id).filter((event) => event.type === 'session.status_running')).toHaveLength(2);
  });

  it('resumes when the budget is removed outright', async () => {
    const execute = vi.fn(async function* (session: Session, event: TurnTrigger, options?: ExecuteOptions) {
      if (event.type === 'internal.resume_after_budget') return;
      recordStepSpend(session.id, 10_000);
      if (options?.budgetExhausted?.()) return;
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend' }] });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('budget_reached'));

    await manager.updateSession(session.id, { budget: null });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('end_turn'));
  });

  it('does not resume on an update that leaves the ceiling standing, or twice on two updates', async () => {
    const execute = vi.fn(async function* (session: Session, event: TurnTrigger, options?: ExecuteOptions) {
      if (event.type === 'internal.resume_after_budget') return;
      recordStepSpend(session.id, 10_000);
      if (options?.budgetExhausted?.()) return;
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend' }] });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('budget_reached'));

    // A title-only update is not a budget change: no resume.
    await manager.updateSession(session.id, { title: 'renamed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execute).toHaveBeenCalledTimes(1);

    // Raising resumes once; a second accepted raise after the session already
    // settled on end_turn queues nothing.
    await manager.updateSession(session.id, { budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } } });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('end_turn'));
    await manager.updateSession(session.id, { budget: { type: 'limit', max_list_cost: { amount: '60', currency: 'USD' } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('settles a tool call the ceiling stranded so the resume sees a paired transcript', async () => {
    const execute = vi.fn(async function* (session: Session, event: TurnTrigger, options?: ExecuteOptions) {
      if (event.type === 'internal.resume_after_budget') return;
      recordStepSpend(session.id, 10_000);
      // The step that crossed the cap also dispatched a call the loop never got
      // to run: stopWhen ends the turn before the tool executes, leaving
      // `agent.tool_use` without a result.
      manager.getEventLogger().append(session.id, {
        type: 'agent.tool_use',
        content: [{ type: 'tool_use', id: 'call_stranded', name: 'bash', input: { command: 'echo hi' } }],
      });
      if (options?.budgetExhausted?.()) return;
    });
    manager.setExecutor({ execute } as unknown as SessionExecutor);
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'spend' }] });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('budget_reached'));

    // The stranded call is closed before the idle, not left for the resume to
    // project as an unpaired tool call.
    const log = events(session.id);
    const idleIndex = log.findIndex((event) => event.type === 'session.status_idle');
    const result = log.slice(0, idleIndex).find((event) => event.type === 'agent.tool_result');
    expect(result?.content?.[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_stranded', is_error: true });

    await manager.updateSession(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } },
    });
    await vi.waitFor(() => expect(lastIdleReason(session.id)).toBe('end_turn'));
  });

  it('still refuses a work-starting event at the cap and names the settlement events', async () => {
    manager.setExecutor({ async *execute() {} });
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '1', currency: 'USD' } },
    });
    recordStepSpend(session.id, 2_000);
    db.prepare(`UPDATE sessions SET status = 'paused' WHERE id = ?`).run(session.id);

    await expect(manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'more work' }],
    })).rejects.toThrow(/reached its budget.*user\.tool_confirmation, user\.custom_tool_result, user\.interrupt/);
  });
});
