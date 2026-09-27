/**
 * Integration test: every failure path through a turn produces a `session.error`
 * carrying the documented structured payload.
 *
 * The unit test in `tests/unit/cma-event-contract.test.ts` pins the projection
 * (`toApiEvent` turns metadata into a top-level `error`), but a projection test
 * cannot prove the runtime actually emits the payload — the metadata carrier
 * could just as easily be left empty. These tests drive `SessionManager.runTurn`
 * with executors that fail the way real components fail (a provider error, a
 * tool error, a sandbox error, an aborted turn) and assert on what lands in the
 * event log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { toApiEvent } from '@/api/standard.js';
import type { Session, SessionEvent } from '@/types/session.js';

/** An executor that throws a specific error, optionally after yielding events. */
class FailingExecutor implements SessionExecutor {
  cleanups = 0;
  constructor(
    private readonly failure: () => unknown,
    private readonly before: SessionEvent[] = [],
  ) {}

  async *execute(session: Session): AsyncIterable<SessionEvent> {
    for (const event of this.before) yield event;
    throw this.failure();
  }

  async cleanupSession(): Promise<void> {
    this.cleanups++;
  }
}

/** Build a coded error the way the runtime's own guards do. */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('session.error production paths', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-sesserr-'));
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

  /** Run one turn against a failing executor and return the projected error event. */
  async function errorEventFor(failure: () => unknown) {
    const executor = new FailingExecutor(failure);
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_x' });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'go' }],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logged = manager.getEventLogger().getEvents(session.id);
    const raw = logged.find((event) => event.type === 'session.error');
    expect(raw, 'no session.error was appended').toBeDefined();
    return {
      session,
      raw: raw!,
      projected: toApiEvent(raw!),
      status: manager.get(session.id)!.status,
      executor,
    };
  }

  it('reports a provider/model failure with the code the runtime attached', async () => {
    const { projected, status } = await errorEventFor(() => coded('model_error', '401 unauthorized'));

    expect(projected.error).toEqual({
      type: 'model_error',
      message: '401 unauthorized',
      retry_status: 'unknown',
    });
    // The published shape requires the three keys to be present; `unknown` is a
    // value, not an omission.
    expect(Object.keys(projected.error!).sort()).toEqual(['message', 'retry_status', 'type']);
    expect(status).toBe('failed');
  });

  it('reports a tool failure distinctly from a model failure', async () => {
    const { projected } = await errorEventFor(() => coded('tool_error', 'tool "read" failed'));

    expect(projected.error?.type).toBe('tool_error');
    expect(projected.error?.message).toContain('read');
  });

  it('reports a sandbox failure and still releases the sandbox', async () => {
    const { projected, executor } = await errorEventFor(
      () => coded('sandbox_error', 'sandbox provisioning failed'),
    );

    expect(projected.error?.type).toBe('sandbox_error');
    // A failed turn must not leak the sandbox it may have provisioned.
    expect(executor.cleanups).toBe(1);
  });

  it('marks a busy session retryable', async () => {
    const { projected, status } = await errorEventFor(() => coded('pi_session_busy', 'session is busy'));

    expect(projected.error?.retry_status).toBe('retryable');
    // A busy session is a transient condition, so it must not be terminal.
    expect(status).toBe('paused');
  });

  it('marks a timed-out turn not retryable', async () => {
    const { projected, status } = await errorEventFor(() => coded('pi_timed_out', 'pi turn timed out'));

    expect(projected.error?.retry_status).toBe('not_retryable');
    expect(status).toBe('timed_out');
  });

  it('marks an unsupported capability not retryable rather than unknown', async () => {
    const { projected } = await errorEventFor(
      () => coded('unsupported_capability', 'web_search is not executable'),
    );

    expect(projected.error?.retry_status).toBe('not_retryable');
  });

  it('classifies every admission refusal as not retryable', async () => {
    // These are the codes the runtime actually raises for a request it will
    // always refuse. Two of them were previously spelled `..._unsupported` in
    // the classification table while the errors publish `..._not_supported`, so
    // a client was told `unknown` and might retry a permanent failure.
    const permanent = [
      'pi_always_ask_not_supported',
      'pi_tool_policy_not_supported',
      'pi_sandbox_provider_not_supported',
      'pi_user_event_not_supported',
      'pi_message_content_not_supported',
      'pi_cleanup_pending',
      'loop_engine_not_supported',
      'loop_engine_invalid',
    ];

    for (const code of permanent) {
      const { projected } = await errorEventFor(() => coded(code, `${code} refused`));
      expect(projected.error?.retry_status, `${code} should be not_retryable`).toBe('not_retryable');
      // The code must also survive into `type`; a classification that only
      // works because the code was dropped would report `internal_error`.
      expect(projected.error?.type, `${code} should be reported as itself`).toBe(code);
    }
  });

  it('leaves the two mixed-case transport codes at unknown on purpose', async () => {
    // `pi_rpc_closed` and `pi_rpc_command_rejected` each cover sub-cases whose
    // correct dispositions are opposite, so `unknown` is the answer rather than an
    // omission. This case exists to make a future symmetry-driven edit fail: a
    // `not_retryable` or `retryable` entry added for either code tells a client
    // something the code cannot support, because the code alone cannot distinguish
    // a session that was already closing from a transport that died mid-command,
    // or a refusal the engine will repeat forever from a transient one.
    const mixed = ['pi_rpc_closed', 'pi_rpc_command_rejected'];

    for (const code of mixed) {
      const { projected } = await errorEventFor(() => coded(code, `${code} arrived`));
      expect(projected.error?.retry_status, `${code} should stay unknown`).toBe('unknown');
      expect(projected.error?.type, `${code} should be reported as itself`).toBe(code);
    }
  });

  it('marks the two Pi failures the transport calls unretryable as not retryable', async () => {
    // The transport's own contract, above `send()`: `PiRpcTimeoutError` and
    // `PiRpcOutcomeUnknownError` "both carry `outcomeUnknown`, meaning the command
    // must not be retried blindly". Reporting `unknown` here is worse than vague:
    // it invites a client to retry precisely the two failures the transport
    // forbids retrying, where the bytes may already have reached the engine.
    const unretryable = ['pi_rpc_timeout', 'pi_rpc_outcome_unknown'];

    for (const code of unretryable) {
      const { projected } = await errorEventFor(() => coded(code, `${code} left the outcome unknown`));
      expect(projected.error?.retry_status, `${code} should be not_retryable`).toBe('not_retryable');
      // The code must survive into `type`; a classification that only worked
      // because the code was dropped would report `internal_error`.
      expect(projected.error?.type, `${code} should be reported as itself`).toBe(code);
    }
  });

  it('classifies each way a self-hosted wait can give up by what it proves', async () => {
    // The disposition follows from which failure it is, not from the fact that a deadline
    // passed. Only the unclaimed case proves that nothing ran, so only that one is safe to
    // submit again; an item an executor held may already have had its effect on the
    // operator's machine, and an item the session stopped is not wanted at all. Leaving
    // these to fall through to `unknown` would invite a client to replay precisely the two
    // failures that must not be replayed.
    const { projected: retryable } = await errorEventFor(
      () => coded('work_queue_timeout', 'no worker ever claimed the item'),
    );
    expect(retryable.error?.retry_status).toBe('retryable');
    expect(retryable.error?.type).toBe('work_queue_timeout');

    for (const code of ['work_outcome_unknown', 'work_lease_lost']) {
      const { projected } = await errorEventFor(() => coded(code, `${code} ended the wait`));
      expect(projected.error?.retry_status, `${code} should be not_retryable`).toBe('not_retryable');
      // The code must survive into `type`; a classification that only worked because the
      // code was dropped would report `internal_error`.
      expect(projected.error?.type, `${code} should be reported as itself`).toBe(code);
    }
  });

  it('marks an untrusted Pi frame not retryable rather than unknown', async () => {
    // A protocol error is raised from the read loop, so the command may already
    // have reached the engine: the transport's own comment for that situation is
    // that the bytes "may or may not have reached the engine" and "the caller
    // must not retry the command". Reporting `unknown` there tells a client the
    // opposite of what the transport requires, and the alternative failure mode
    // is a transport built without a writable stdin, which a retry cannot fix.
    const { projected } = await errorEventFor(
      () => coded('pi_rpc_protocol_error', 'Pi RPC frame 7 is not valid JSON'),
    );

    expect(projected.error?.retry_status).toBe('not_retryable');
    // The code must survive into `type`; a classification that only worked
    // because the code was dropped would report `internal_error`.
    expect(projected.error?.type).toBe('pi_rpc_protocol_error');
  });

  it('does not guess a retry disposition for an unrecognized code', async () => {
    // Claiming `not_retryable` for an unknown failure would tell a client to
    // abandon work that might succeed, so `unknown` is the honest answer.
    const { projected } = await errorEventFor(() => coded('some_new_failure', 'unexpected'));

    expect(projected.error?.retry_status).toBe('unknown');
  });

  it('falls back to internal_error when the failure carries no code', async () => {
    const { projected } = await errorEventFor(() => new Error('plain failure'));

    expect(projected.error?.type).toBe('internal_error');
    expect(projected.error?.message).toBe('plain failure');
  });

  it('keeps the text content so a Console that only renders content still shows the failure', async () => {
    const { projected } = await errorEventFor(() => coded('model_error', 'boom'));

    expect(projected.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('records no session.error when the turn is aborted', async () => {
    const controller = new AbortController();
    const executor: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(_session: Session, _event, options): AsyncIterable<SessionEvent> {
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        void options;
        throw err;
      },
    };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_x' });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'go' }],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logged = manager.getEventLogger().getEvents(session.id);
    // A user-initiated abort is not a failure, so it must not be reported as one.
    expect(logged.some((event) => event.type === 'session.error')).toBe(false);
  });
});
