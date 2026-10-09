import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { collectionPager } from '../standard.js';
import {
  dispatchWebhookEvent,
  LOCAL_ORGANIZATION_ID,
  LOCAL_WORKSPACE_ID,
  retryDueWebhookDeliveries,
} from '@/core/operations/webhook-dispatcher.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';
import { invalidWebhookEventNames } from '@/core/operations/webhook-events.js';
import {
  mintAndStoreWebhookSecret,
  resolveWebhookSigningSecret,
  retireWebhookSecret,
  rotateWebhookSecret,
  type StoredWebhookSecret,
} from '@/core/operations/webhook-secrets.js';
import { nextCronRun, runDueScheduledDeployments, runSchedule, type ScheduleRow } from '@/core/operations/scheduler.js';
import { isValidTimeZone } from '@/core/operations/cron.js';
import { evaluateDeterministicOutcome, type OutcomeEvaluationInput, type OutcomeEvaluationResult } from '@/core/operations/outcome-evaluator.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { archiveById, invalid, notFound, now, objectField, parseObject, readObjectBody, stringField, type OperationMountOptions } from './operation-helpers.js';
import { deploymentRoutes } from './deployments.js';
import { webhookSigningSecret } from './operation-events.js';
import { deploymentRunsRoutes } from './deployment-runs.js';

/**
 * Which envelope this mount serves.
 *
 * The same router is mounted twice, and the contract makes the two prefixes
 * different on purpose: canonical `/v1` collections carry `{data, prev_page,
 * next_page}` while `/v1/x` is the local surface with existing consumers and keeps
 * `{data, has_more, first_id, last_id}`. Choosing it per mount rather than per
 * handler is what stops one response from carrying both spellings.
 */
export type OperationsRoutesOptions = OperationMountOptions;

export function operationsRoutes(deps: ServerDeps, options: OperationsRoutesOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  // Deployments are their own module so they can be mounted at two prefixes.
  // The mount lives here rather than in `server.ts` on purpose: this router is
  // itself mounted at `/v1` and `/v1/x`, so mounting here keeps
  // `/v1/x/scheduled-deployments` working exactly as before and gives
  // `/v1/x/deployments` the same legacy envelope as its canonical twin.
  app.route('/scheduled-deployments', deploymentRoutes(deps, options));
  app.route('/deployments', deploymentRoutes(deps, options));

  // A deployment's *runs* are their own top-level resource in the published
  // contract, addressable by their own id, so they cannot be a path alias of the
  // nested `/{id}/runs` route: that route answers a different question (this one
  // deployment's runs) at a different path, and a path alias cannot express a
  // top-level collection filtered by a query parameter. Mounted here for the same
  // reason the deployment router is — this router is mounted at `/v1` and `/v1/x`,
  // so one registration yields the canonical route and the legacy mirror with the
  // correct per-mount envelope.
  app.route('/deployment_runs', deploymentRunsRoutes(deps, options));

  app.get('/webhooks', (c) => {
    const rows = deps.db.prepare('SELECT * FROM webhooks WHERE archived_at IS NULL ORDER BY created_at DESC').all() as WebhookRow[];
    return collections.json(c, rows.map(toWebhook));
  });

  app.post('/webhooks', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const url = stringField(body.value.url);
    if (!url || !isHttpUrl(url)) return invalid(c, 'url must be an https:// URL, or an http:// loopback URL (localhost, 127.0.0.1, or ::1)');
    const events = stringArray(body.value.events);
    if (events.length === 0) return invalid(c, 'events must contain at least one event name');
    const invalidNames = invalidWebhookEventNames(events);
    if (invalidNames.length > 0) {
      return invalid(c, `unknown event name(s): ${invalidNames.join(', ')}`);
    }
    const id = `wh_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO webhooks (id, name, url, events, description, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      stringField(body.value.name) ?? new URL(url).host,
      url,
      JSON.stringify(events),
      stringField(body.value.description) ?? '',
      JSON.stringify(objectField(body.value.metadata)),
      now(),
      now(),
    );
    // The secret is returned by this response and by nothing else. The row keeps
    // an encrypted copy for signing, and every read path omits it.
    const secretKey = mintAndStoreWebhookSecret(deps.db, id, deps.workspace?.dataDir);
    const row = deps.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow;
    return c.json({ ...toWebhook(row), secret_key: secretKey }, 201);
  });

  app.post('/webhooks/dispatch', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const event = stringField(body.value.event);
    if (!event) return invalid(c, 'event is required');
    const data = objectField(body.value.data);
    // The envelope's own fields are set from the event, not from the caller's
    // bag — a `data.id` here names the subject once, not twice.
    const { id: _subjectIdFromData, type: _typeFromData, ...extra } = data;
    const deliveries = await dispatchWebhookEvent(deps.db, {
      type: event,
      subjectId: stringField(body.value.subject_id) ?? stringField(data.id) ?? 'manual',
      extra,
      id: stringField(body.value.id),
    }, { secret: webhookSigningSecret(deps), dataDir: deps.workspace?.dataDir });
    return collections.json(c, deliveries, 202);
  });

  app.post('/webhooks/retry-due', async (c) => {
    const deliveries = await retryDueWebhookDeliveries(deps.db, {
      secret: webhookSigningSecret(deps),
      dataDir: deps.workspace?.dataDir,
    });
    return collections.json(c, deliveries, 202);
  });

  app.get('/webhooks/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM webhooks WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as WebhookRow | undefined;
    return row ? c.json(toWebhook(row)) : notFound(c, 'Webhook not found');
  });

  app.put('/webhooks/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM webhooks WHERE id = ? AND archived_at IS NULL').get(id) as WebhookRow | undefined;
    if (!existing) return notFound(c, 'Webhook not found');
    const url = body.value.url === undefined ? existing.url : stringField(body.value.url);
    if (!url || !isHttpUrl(url)) return invalid(c, 'url must be an https:// URL, or an http:// loopback URL (localhost, 127.0.0.1, or ::1)');
    const events = body.value.events === undefined ? parseArray(existing.events) : stringArray(body.value.events);
    if (events.length === 0) return invalid(c, 'events must contain at least one event name');
    const invalidNames = invalidWebhookEventNames(events);
    if (invalidNames.length > 0) {
      return invalid(c, `unknown event name(s): ${invalidNames.join(', ')}`);
    }
    // The published delivery behaviour sets an endpoint to `disabled` and states that the
    // disable is reversible by re-enabling it; until this route wrote `status`, nothing
    // could re-enable one — the dispatcher already selected `status = 'active'`, so a
    // disabled endpoint stayed silent forever. The vocabulary is the published one, and an
    // unrecognised value is refused rather than ignored, because a silently ignored status
    // reads as a successful re-enable on an endpoint that never comes back.
    const status = body.value.status === undefined ? existing.status : stringField(body.value.status);
    if (status !== 'active' && status !== 'disabled') {
      return invalid(c, 'status must be one of: active, disabled');
    }
    // Re-enabling resolves whatever disabled the endpoint, so the reason goes with the
    // state rather than outliving it. A caller who leaves the endpoint `disabled` keeps
    // the existing reason: setting the same state is not resolving anything.
    const disabledReason = status === 'active' ? null : existing.disabled_reason;
    // Re-enabling also restarts the sustained-failure window. Without this the endpoint
    // would come back already overdue and be disabled again by its next failure, which is
    // the opposite of what the published "re-enable to recover" remedy promises.
    const failingSince = status === 'active' ? null : existing.failing_since;
    deps.db.prepare(`
      UPDATE webhooks
      SET name = ?, url = ?, events = ?, description = ?, metadata = ?, status = ?,
          disabled_reason = ?, failing_since = ?, updated_at = ?
      WHERE id = ?
    `).run(
      stringField(body.value.name) ?? existing.name,
      url,
      JSON.stringify(events),
      stringField(body.value.description) ?? existing.description,
      JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : objectField(body.value.metadata)),
      status,
      disabledReason,
      failingSince,
      now(),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow;
    return c.json(toWebhook(row));
  });

  // Archiving a webhook publishes nothing: only deployments have a published
  // archived event. The response is built by the helper, so this caller is
  // unchanged in behaviour, not merely in intent.
  app.post('/webhooks/:id/archive', (c) => archiveById(c, deps, 'webhooks', toWebhook, 'Webhook not found').response);

  // --- Signing-secret rotation window -------------------------------------
  //
  // The published scheme expresses a rotation window as a space-separated
  // `webhook-signature` list, so a rotation can keep the previous secret valid
  // while receivers migrate. Rotating a subscription that had no stored secret
  // is also the call that takes it off the legacy derivation, which is why the
  // new secret is returned here and nowhere else.

  app.post('/webhooks/:id/rotate-secret', (c) => {
    const row = deps.db.prepare('SELECT * FROM webhooks WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as WebhookRow | undefined;
    if (!row) return notFound(c, 'Webhook not found');
    const secretKey = rotateWebhookSecret(deps.db, row.id, deps.workspace?.dataDir);
    const updated = deps.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(row.id) as WebhookRow;
    return c.json({ ...toWebhook(updated), secret_key: secretKey });
  });

  app.post('/webhooks/:id/retire-secret', (c) => {
    const row = deps.db.prepare('SELECT * FROM webhooks WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as WebhookRow | undefined;
    if (!row) return notFound(c, 'Webhook not found');
    retireWebhookSecret(deps.db, row.id);
    const updated = deps.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(row.id) as WebhookRow;
    return c.json(toWebhook(updated));
  });

  app.get('/webhooks/:id/deliveries', (c) => {
    const webhook = deps.db.prepare('SELECT id FROM webhooks WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!webhook) return notFound(c, 'Webhook not found');
    const rows = deps.db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC').all(c.req.param('id')) as WebhookDeliveryRow[];
    return collections.json(c, rows.map(toWebhookDelivery));
  });

  app.post('/webhooks/:id/test', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const webhook = deps.db.prepare('SELECT * FROM webhooks WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as WebhookRow | undefined;
    if (!webhook) return notFound(c, 'Webhook not found');
    const event = stringField(body.value.event) ?? parseArray(webhook.events)[0] ?? 'test';
    const simulatedAt = now();
    const payload = {
      type: 'event',
      id: `whe_${nanoid(18)}`,
      created_at: simulatedAt,
      data: {
        type: event,
        id: webhook.id,
        organization_id: LOCAL_ORGANIZATION_ID,
        workspace_id: LOCAL_WORKSPACE_ID,
        ...objectField(body.value.payload),
      },
    };
    const payloadJson = JSON.stringify(payload);
    // The same derivation a real delivery uses. The raw secret is not the HMAC
    // key of a `whsec_` value, so signing it directly would produce a signature
    // the receiver cannot verify.
    const signature = signWebhookDelivery({
      secret: resolveWebhookSigningSecret(webhook, webhookSigningSecret(deps), deps.workspace?.dataDir),
      id: String(payload.id),
      timestamp: String(Math.floor(new Date(simulatedAt).getTime() / 1000)),
      body: payloadJson,
    });
    const id = `whd_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhook_id, event, payload, status, status_code, error, signature, created_at, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      webhook.id,
      event,
      payloadJson,
      'simulated',
      202,
      null,
      signature,
      now(),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as WebhookDeliveryRow;
    return c.json(toWebhookDelivery(row), 202);
  });

  app.get('/outcomes', (c) => {
    const rows = deps.db.prepare('SELECT * FROM outcomes WHERE archived_at IS NULL ORDER BY created_at DESC').all() as OutcomeRow[];
    return collections.json(c, rows.map(toOutcome));
  });

  app.post('/outcomes', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    const objective = stringField(body.value.objective);
    if (!name) return invalid(c, 'name is required');
    if (!objective) return invalid(c, 'objective is required');
    const metadata = {
      ...objectField(body.value.metadata),
      ...(body.value.pass_threshold !== undefined ? { pass_threshold: thresholdField(body.value.pass_threshold) } : {}),
      ...(body.value.evaluator !== undefined ? { evaluator: stringField(body.value.evaluator) ?? 'deterministic_transcript_matcher' } : {}),
    };
    const id = `out_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO outcomes (id, name, description, objective, criteria, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      stringField(body.value.description) ?? '',
      objective,
      JSON.stringify(stringArray(body.value.criteria)),
      JSON.stringify(metadata),
      now(),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM outcomes WHERE id = ?').get(id) as OutcomeRow;
    return c.json(toOutcome(row), 201);
  });

  app.get('/outcomes/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM outcomes WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as OutcomeRow | undefined;
    return row ? c.json(toOutcome(row)) : notFound(c, 'Outcome not found');
  });

  app.put('/outcomes/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM outcomes WHERE id = ? AND archived_at IS NULL').get(id) as OutcomeRow | undefined;
    if (!existing) return notFound(c, 'Outcome not found');
    const name = stringField(body.value.name) ?? existing.name;
    const objective = stringField(body.value.objective) ?? existing.objective;
    const existingMetadata = parseObject(existing.metadata);
    const nextMetadata = body.value.metadata === undefined ? existingMetadata : objectField(body.value.metadata);
    if (body.value.pass_threshold !== undefined) nextMetadata.pass_threshold = thresholdField(body.value.pass_threshold);
    if (body.value.evaluator !== undefined) nextMetadata.evaluator = stringField(body.value.evaluator) ?? existingMetadata.evaluator ?? 'deterministic_transcript_matcher';
    deps.db.prepare(`
      UPDATE outcomes
      SET name = ?, description = ?, objective = ?, criteria = ?, metadata = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      stringField(body.value.description) ?? existing.description,
      objective,
      JSON.stringify(body.value.criteria === undefined ? parseArray(existing.criteria) : stringArray(body.value.criteria)),
      JSON.stringify(nextMetadata),
      normalizeOutcomeStatus(body.value.status ?? existing.status),
      now(),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM outcomes WHERE id = ?').get(id) as OutcomeRow;
    return c.json(toOutcome(row));
  });

  // Same as the webhook archive above: no published archived event exists for an
  // outcome, so nothing is published and the helper's response is returned as-is.
  app.post('/outcomes/:id/archive', (c) => archiveById(c, deps, 'outcomes', toOutcome, 'Outcome not found').response);

  app.get('/sessions/:id/outcomes', (c) => {
    const session = deps.db.prepare('SELECT id FROM sessions WHERE id = ?').get(c.req.param('id'));
    if (!session) return notFound(c, 'Session not found');
    const rows = deps.db.prepare('SELECT * FROM session_outcomes WHERE session_id = ? ORDER BY created_at DESC').all(c.req.param('id')) as SessionOutcomeRow[];
    return collections.json(c, rows.map(toSessionOutcome));
  });

  app.post('/sessions/:id/outcomes', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const sessionId = c.req.param('id');
    const session = deps.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const outcomeId = stringField(body.value.outcome_id);
    if (outcomeId) {
      const outcome = deps.db.prepare('SELECT id FROM outcomes WHERE id = ? AND archived_at IS NULL').get(outcomeId);
      if (!outcome) return notFound(c, 'Outcome not found');
    }
    const status = normalizeSessionOutcomeStatus(body.value.status);
    const id = `sout_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO session_outcomes (id, session_id, outcome_id, status, score, summary, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      outcomeId ?? null,
      status,
      numberField(body.value.score),
      stringField(body.value.summary) ?? '',
      JSON.stringify(objectField(body.value.details)),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM session_outcomes WHERE id = ?').get(id) as SessionOutcomeRow;
    return c.json(toSessionOutcome(row), 201);
  });

  app.post('/sessions/:id/outcomes/evaluate', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const sessionId = c.req.param('id');
    const session = deps.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const outcomeId = stringField(body.value.outcome_id);
    if (!outcomeId) return invalid(c, 'outcome_id is required');
    const outcome = deps.db.prepare('SELECT * FROM outcomes WHERE id = ? AND archived_at IS NULL').get(outcomeId) as OutcomeRow | undefined;
    if (!outcome) return notFound(c, 'Outcome not found');
    const transcript = sessionTranscript(deps, sessionId);
    const criteria = parseArray(outcome.criteria);
    const result = await evaluateOutcome(deps, {
      transcript,
      criteria,
      objective: outcome.objective,
      passThreshold: outcomeThreshold(outcome),
      evaluator: outcomeEvaluator(outcome),
    });
    persistEvaluatedUsage(deps, sessionId, result);
    const id = `sout_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO session_outcomes (id, session_id, outcome_id, status, score, summary, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      outcomeId,
      result.status,
      result.score,
      result.summary,
      JSON.stringify(result.details),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM session_outcomes WHERE id = ?').get(id) as SessionOutcomeRow;
    return c.json(toSessionOutcome(row), 201);
  });

  return app;
}

function toWebhook(row: WebhookRow) {
  return {
    id: row.id,
    type: 'webhook',
    name: row.name,
    url: row.url,
    events: parseArray(row.events),
    description: row.description,
    status: row.archived_at ? 'archived' : row.status,
    // The reason describes why the endpoint is *currently* disabled, so it is reported
    // only while it is: an endpoint an operator has re-enabled must not still advertise
    // the redirect that once switched it off, or a caller would act on a state that has
    // already been resolved. This is the wire rule regardless of what a stored row holds,
    // which is what makes it safe against a row edited outside the API.
    disabled_reason: row.status === 'disabled' ? row.disabled_reason ?? null : null,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function toWebhookDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    type: 'webhook_delivery',
    webhook_id: row.webhook_id,
    event: row.event,
    payload: parseObject(row.payload),
    status: row.status,
    status_code: row.status_code,
    error: row.error ?? null,
    signature: row.signature,
    attempt_count: row.attempt_count ?? 0,
    next_retry_at: row.next_retry_at ?? null,
    created_at: row.created_at,
    delivered_at: row.delivered_at ?? null,
  };
}

function toOutcome(row: OutcomeRow) {
  const metadata = parseObject(row.metadata);
  return {
    id: row.id,
    type: 'outcome',
    name: row.name,
    description: row.description,
    objective: row.objective,
    criteria: parseArray(row.criteria),
    pass_threshold: outcomeThreshold(row),
    evaluator: typeof metadata.evaluator === 'string' ? metadata.evaluator : 'deterministic_transcript_matcher',
    metadata,
    status: row.archived_at ? 'archived' : row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function toSessionOutcome(row: SessionOutcomeRow) {
  return {
    id: row.id,
    type: 'session_outcome',
    session_id: row.session_id,
    outcome_id: row.outcome_id ?? null,
    status: row.status,
    score: row.score,
    summary: row.summary,
    details: parseObject(row.details),
    created_at: row.created_at,
  };
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function thresholdField(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return 0.75;
  return Math.min(1, Math.max(0, number));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function parseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return stringArray(parsed);
  } catch {
    return [];
  }
}

/**
 * The endpoint-address rule, wider than the published HTTPS-on-443 one for a
 * documented reason: this runtime is local-first, so the receiver a webhook
 * exists to talk to is usually on the same host. `https://` is accepted
 * everywhere; `http://` is accepted for loopback names only, since an
 * `http://` endpoint anywhere else would carry signed payloads over a network
 * in cleartext.
 */
function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function normalizeOutcomeStatus(value: unknown): 'active' | 'disabled' {
  return value === 'disabled' ? 'disabled' : 'active';
}

function normalizeSessionOutcomeStatus(value: unknown): 'passed' | 'failed' | 'inconclusive' {
  if (value === 'passed' || value === 'failed' || value === 'inconclusive') return value;
  return 'inconclusive';
}

function sessionTranscript(deps: ServerDeps, sessionId: string): string {
  const rows = deps.db.prepare('SELECT content FROM events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as Array<{ content: string | null }>;
  return rows
    .flatMap((row) => textBlocks(parseUnknownArray(row.content)))
    .join('\n')
    .toLowerCase();
}

function outcomeThreshold(row: OutcomeRow): number {
  const metadata = parseObject(row.metadata);
  return thresholdField(metadata.pass_threshold);
}

function outcomeEvaluator(row: OutcomeRow): string {
  const metadata = parseObject(row.metadata);
  return typeof metadata.evaluator === 'string' && metadata.evaluator.trim()
    ? metadata.evaluator.trim()
    : 'deterministic_transcript_matcher';
}

async function evaluateOutcome(deps: ServerDeps, input: OutcomeEvaluationInput): Promise<OutcomeEvaluationResult> {
  if (input.evaluator === 'model_assisted' || input.evaluator === 'model_assisted_json') {
    if (deps.evaluateOutcome) return deps.evaluateOutcome(input);
    return {
      status: 'inconclusive',
      score: 0,
      summary: 'Model-assisted evaluation is not configured for this runtime.',
      details: {
        evaluator: input.evaluator,
        pass_threshold: input.passThreshold,
        unsupported: true,
        reason: 'No model-assisted evaluator is registered.',
      },
    };
  }
  return evaluateDeterministicOutcome(input);
}

/**
 * The evaluator's scoring call is a model request like any other, so it
 * records the same canonical pair a turn-end span does: the
 * `span.model_request_end` event for the request plus the session-aggregate
 * update. The details' `model_usage` already carries the split buckets; the
 * map back into `inputTokenDetails` keeps `recordAuxiliaryModelUsage` the
 * single splitter.
 */
function persistEvaluatedUsage(deps: ServerDeps, sessionId: string, result: OutcomeEvaluationResult): void {
  const usage = result.details.model_usage;
  if (!usage || typeof usage !== 'object') return;
  const buckets = usage as Record<string, unknown>;
  const input = typeof buckets.input_tokens === 'number' ? buckets.input_tokens : 0;
  const cacheRead = typeof buckets.cache_read_input_tokens === 'number' ? buckets.cache_read_input_tokens : 0;
  const cacheWrite = typeof buckets.cache_creation_input_tokens === 'number' ? buckets.cache_creation_input_tokens : 0;
  new EventLogger(deps.db).recordAuxiliaryModelUsage(sessionId, {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens: typeof buckets.output_tokens === 'number' ? buckets.output_tokens : 0,
  }, {
    purpose: 'outcome_evaluation',
    modelUsed: typeof result.details.model === 'string' ? result.details.model : undefined,
  });
}

function parseUnknownArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function textBlocks(blocks: unknown[]): string[] {
  const output: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') output.push(record.text);
    if (typeof record.content === 'string') output.push(record.content);
    if (Array.isArray(record.content)) output.push(...textBlocks(record.content));
  }
  return output;
}

type WebhookRow = StoredWebhookSecret & {
  id: string;
  name: string;
  url: string;
  events: string;
  description: string;
  status: string;
  /** Why the endpoint is disabled, when a rule rather than an operator disabled it. */
  disabled_reason: string | null;
  /**
   * When the endpoint's current run of uninterrupted failures began, or `null` when it is
   * not failing. Read on the update path only so that re-enabling can restart the window;
   * it is not part of the wire projection, because no published field carries it.
   */
  failing_since: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status: string;
  status_code: number | null;
  error: string | null;
  signature: string;
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
  delivered_at: string | null;
};

type OutcomeRow = {
  id: string;
  name: string;
  description: string;
  objective: string;
  criteria: string;
  metadata: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type SessionOutcomeRow = {
  id: string;
  session_id: string;
  outcome_id: string | null;
  status: string;
  score: number | null;
  summary: string;
  details: string;
  created_at: string;
};
