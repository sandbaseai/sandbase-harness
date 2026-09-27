/**
 * Self-Hosted Worker Routes (R9.14)
 *
 * A user-run Worker polls these endpoints to claim pending tool-execution work
 * items and post results back. The Worker executes the actual commands on the
 * user's own infrastructure — the server never runs them.
 *
 *   POST /v1/x/worker/claim     { worker_id, session_id? } → work item | 204
 *   POST /v1/x/worker/accept    { id, worker_id } → { ok: true } | 409
 *   POST /v1/x/worker/heartbeat { id, worker_id } → { ok: true }
 *   POST /v1/x/worker/complete  { id, worker_id, result, failed? } → { ok: true }
 *
 * A worker running an item that outlives the claim lease renews it with
 * `heartbeat`; otherwise the item is treated as abandoned and handed to another
 * worker while the first one is still executing it. A renewal on work whose session
 * has ended answers 409 with the engine-neutral `work_lease_lost` code, which is the
 * runtime's way of telling a worker that is already executing something to stop: the
 * stop marker is persisted server-side, and this is the only channel through which
 * the process holding the command ever learns about it.
 *
 * `accept` closes the other half of the same race, at the opposite end: a claim is a
 * lease on running an item, and the window can pass between claiming and starting, so
 * the claim alone does not authorize execution. A worker confirms with `accept`
 * immediately before it starts, and only `{ ok: true }` authorizes running the item.
 * A refusal is never a completion - the worker must not run it and must not report a
 * result, which would assert an effect that never happened.
 */

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { Database } from '@/core/db/database.js';
import type { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { validateEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';

export function workerRoutes(queue: WorkQueue, db?: Database) {
  const app = new Hono();

  app.post('/claim', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workerId = body.worker_id;
    if (!workerId || typeof workerId !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'worker_id is required' } }, 400);
    }
    const auth = db ? validateEnvironmentWorkerKey(db, body.environment_key) : { ok: true as const, environmentId: undefined };
    if (!auth.ok) return c.json({ error: { type: 'unauthorized', message: auth.message } }, 401);
    const requestedEnvironmentId = typeof body.environment_id === 'string' ? body.environment_id : undefined;
    if (auth.environmentId && requestedEnvironmentId && requestedEnvironmentId !== auth.environmentId) {
      return c.json({ error: { type: 'invalid_request_error', message: 'environment_id does not match environment_key scope' } }, 400);
    }
    const item = queue.claim(
      workerId,
      typeof body.session_id === 'string' ? body.session_id : undefined,
      auth.environmentId ?? requestedEnvironmentId,
    );
    if (!item) return c.body(null, 204);
    return c.json(item);
  });

  app.post('/heartbeat', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.heartbeat(body.id, body.worker_id);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'work_lease_lost') {
      // The code, not the message, is what a caller acts on: a worker that reads prose
      // would keep executing a command the session has already stopped. The status stays
      // 409 because the request conflicts with the row's current state; the code says
      // which conflict, and this one is about the work rather than about the caller.
      return c.json({
        error: {
          type: 'conflict',
          code: 'work_lease_lost',
          message: 'this work was stopped because the session that queued it has ended',
        },
      }, 409);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/accept', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.accept(body.id, body.worker_id);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'work_lease_lost') {
      // One code for both the stopped item and the lapsed lease, because the instruction
      // to the worker is the same either way - do not run it - while the message says
      // which of the two it was. A worker that cannot tell them apart still does the
      // right thing, and one that reads the message knows whether to resubmit.
      return c.json({
        error: {
          type: 'conflict',
          code: 'work_lease_lost',
          message: 'this work cannot be accepted: it was stopped, or its claim lease has run out',
        },
      }, 409);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/complete', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.complete(body.id, body.worker_id, body.result, body.failed === true);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  return app;
}
