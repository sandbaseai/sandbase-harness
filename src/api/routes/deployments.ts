import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { collectionPager } from '../standard.js';
import { armDeploymentDueAt, nextCronRun, runDueScheduledDeployments, runSchedule } from '@/core/operations/scheduler.js';
import { isValidTimeZone } from '@/core/operations/cron.js';
import {
  archiveById,
  equalJsonObject,
  equalJsonValue,
  invalid,
  notFound,
  now,
  objectField,
  parseObject,
  readObjectBody,
  readOptionalObjectBody,
  stringField,
  type JsonObject,
  type OperationMountOptions,
} from './operation-helpers.js';
import { rejectUnexpectedQueryParams, parseIncludeArchived } from './query-params.js';
import { publishOperationEvent, publishPauseTransition } from './operation-events.js';
import {
  normalizeAgentRef,
  normalizeEnvironmentId,
  normalizeResources,
  normalizeVaultIds,
} from './session-normalizers.js';
import { normalizeInitialEvents } from './initial-events.js';
import { parseSessionBudget, BUDGET_ERROR_CODES, type SessionBudget } from '@/core/session/session-budget.js';
import { toDeploymentRun, RUN_VIEW_SELECT, type DeploymentRunViewRow } from './deployment-runs.js';

/**
 * Scheduled deployments, addressed at two prefixes.
 *
 * The published contract calls this resource a *deployment* and addresses it at
 * `/v1/deployments*`; this runtime has always called it a *scheduled deployment*
 * and served it at `/v1/scheduled-deployments*`. Both spellings are served.
 *
 * The routes are declared **relative to the mount** and `operations.ts` mounts
 * this one factory at `/scheduled-deployments` and at `/deployments`, so there is
 * one registration list and the two prefixes cannot drift route by route. A
 * curated per-route alias list is exactly the thing that drifts, leaving a route
 * that answers for one caller and 404s for another on the same resource.
 *
 * Two constraints shape this file, and both are load-bearing:
 *
 * 1. The paths must stay **literals**, and the aliasing must happen at
 *    `app.route()`. `tests/unit/support/route-table.ts` expands
 *    `app.<method>('<literal>'` and `app.route('<prefix>', factory)` statically
 *    from source text, so a path built from a base-path variable would make these
 *    routes invisible to the Console's API-reference guard and to
 *    `contract-honesty` while they kept working — a guard reporting green over a
 *    real divergence.
 * 2. This factory must live in its **own module** and be imported by
 *    `operations.ts`, because that parser only follows a mount whose factory is
 *    an imported identifier. Defining it in the same file as the mount would
 *    leave it unresolved and drop every deployment route from the table.
 *
 * `operations.ts` serves four resource families from one router mounted at `/v1`
 * and mirrored at `/v1/x`. That is why the deployments were **extracted** rather
 * than aliased in place: making that router's paths relative and remounting it
 * would have put `/webhooks` and `/outcomes` under `/v1/deployments/` as well.
 * Mounting this factory inside `operationsRoutes` (rather than in `server.ts`)
 * deliberately preserves the existing `/v1/x/scheduled-deployments` mirror, which
 * `tests/integration/operations-collection-envelope.test.ts` asserts, and gives
 * `/v1/x/deployments` the same legacy envelope as its canonical-prefix twin.
 */
export function deploymentRoutes(deps: ServerDeps, options: OperationMountOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  app.get('/', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, DEPLOYMENT_LIST_PARAMS);
    if (rejected) return rejected;
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;
    const status = c.req.query('status');
    if (status !== undefined && status !== 'active' && status !== 'paused') {
      return invalid(c, 'status must be "active" or "paused"');
    }
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (!includeArchived.value) conditions.push('d.archived_at IS NULL');
    if (status) {
      conditions.push('d.status = ?');
      parameters.push(status);
    }
    const agentId = c.req.query('agent_id');
    if (agentId !== undefined) {
      conditions.push('d.agent_id = ?');
      parameters.push(agentId);
    }
    const createdGte = c.req.query('created_at[gte]');
    if (createdGte !== undefined) {
      conditions.push('d.created_at >= ?');
      parameters.push(createdGte);
    }
    const createdLte = c.req.query('created_at[lte]');
    if (createdLte !== undefined) {
      conditions.push('d.created_at <= ?');
      parameters.push(createdLte);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = deps.db.prepare(`${DEPLOYMENT_SELECT} ${where} ORDER BY d.created_at DESC`).all(...parameters) as DeploymentViewRow[];
    return collections.json(c, rows.map(toApiDeployment));
  });

  app.post('/', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const resolved = resolveDeploymentWrite(deps, body.value, null);
    if (resolved instanceof Response) return resolved;
    if (!resolved.name) return invalid(c, 'name is required');
    if (!resolved.agent) return invalid(c, 'agent is required');
    if (!resolved.environmentId) return invalid(c, 'environment_id is required');
    if (!resolved.initialEvents || resolved.initialEvents.length === 0) {
      return badRequest('initial_events is required', 'invalid_initial_events');
    }
    const id = `depl_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO scheduled_deployments (
        id, name, description, agent_id, agent_version, environment_id, cron, timezone,
        payload, status, paused_reason, next_run_at,
        initial_events, resources, vault_ids, budget, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      resolved.name!,
      resolved.description ?? null,
      resolved.agent!.id,
      resolved.agent!.version,
      resolved.environmentId!,
      resolved.cron ?? null,
      resolved.timezone ?? 'UTC',
      JSON.stringify(objectField(body.value.payload)),
      resolved.status,
      pauseReasonFor(resolved.status),
      resolved.nextRunAt ?? null,
      JSON.stringify(resolved.initialEvents),
      JSON.stringify(resolved.resources ?? []),
      JSON.stringify(resolved.vaultIds ?? []),
      resolved.budget === undefined ? null : JSON.stringify(resolved.budget),
      // The published metadata bag is string-valued; normalize on the way in so
      // a create and a later merge-patch agree on what is stored.
      JSON.stringify(mergeMetadataPatch(null, body.value.metadata ?? {})),
      now(),
      now(),
    );
    // The scheduled instant is armed with its jittered fire time here, from the
    // row just written — the interval for a first run measures from now, since
    // there is no `last_run_at` yet.
    armDeploymentDueAt(deps.db, deploymentRow(deps, id)!);
    const row = deploymentRow(deps, id)!;
    // Published after the row exists, so a receiver that follows the reference
    // immediately finds the deployment rather than a 404. A create that failed
    // validation returned above this point and publishes nothing, for the same
    // reason: there is no id to name.
    //
    // A deployment created already `paused` publishes only this event. The pause
    // events report a transition, and nothing moved here — there was no unpaused
    // state before it — so publishing `deployment.paused` would assert a
    // transition that did not happen. The receiver learns the status by resolving
    // this reference, which is the mechanism the published contract supplies.
    await publishOperationEvent(deps, {
      type: 'deployment.created',
      subjectId: id,
    });
    return c.json(toApiDeployment(row), 201);
  });

  app.post('/run-due', async (c) => {
    const runs = await runDueScheduledDeployments(deps.db, deps.sessionManager, {
      // This route is one of the two doors onto the timed path, so a run it
      // triggers is a timed run and reports like one. The manual route below is
      // the other door onto `runSchedule` and deliberately reports nothing.
      onEvent: (event) => publishOperationEvent(deps, event),
    });
    return collections.json(c, runs.map((run) => deploymentRunById(deps, run.id)!).map(toDeploymentRun), 202);
  });

  app.get('/:id', (c) => {
    // Retrieve reports an archived deployment: the published object carries
    // `archived_at` beside its pause state, so hiding the row would leave
    // `include_archived` list entries that cannot be fetched.
    const row = deps.db.prepare(`${DEPLOYMENT_SELECT} WHERE d.id = ?`).get(c.req.param('id')) as DeploymentViewRow | undefined;
    return row ? c.json(toApiDeployment(row)) : notFound(c, 'Deployment not found');
  });

  const updateDeployment = async (c: any) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare(`${DEPLOYMENT_SELECT} WHERE d.id = ? AND d.archived_at IS NULL`).get(id) as DeploymentViewRow | undefined;
    if (!existing) return notFound(c, 'Deployment not found');
    const resolved = resolveDeploymentWrite(deps, body.value, existing);
    if (resolved instanceof Response) return resolved;
    deps.db.prepare(`
      UPDATE scheduled_deployments
      SET name = ?, description = ?, agent_id = ?, agent_version = ?, environment_id = ?,
          cron = ?, timezone = ?, payload = ?, status = ?, paused_reason = ?, next_run_at = ?,
          initial_events = ?, resources = ?, vault_ids = ?, budget = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      resolved.name ?? existing.name,
      resolved.description === undefined ? existing.description : resolved.description,
      resolved.agent?.id ?? existing.agent_id,
      resolved.agent === undefined ? existing.agent_version : resolved.agent.version,
      resolved.environmentId === undefined ? existing.environment_id : resolved.environmentId,
      resolved.cron === undefined ? existing.cron : resolved.cron,
      resolved.timezone ?? existing.timezone ?? 'UTC',
      JSON.stringify(body.value.payload === undefined ? parseObject(existing.payload) : objectField(body.value.payload)),
      resolved.status,
      resolved.pausedReason === undefined ? existing.paused_reason : resolved.pausedReason,
      resolved.nextRunAt === undefined ? existing.next_run_at : resolved.nextRunAt,
      JSON.stringify(resolved.initialEvents ?? parseJsonArray(existing.initial_events)),
      JSON.stringify(resolved.resources ?? parseJsonArray(existing.resources)),
      JSON.stringify(resolved.vaultIds ?? parseJsonArray(existing.vault_ids)),
      resolved.budget === undefined ? existing.budget : resolved.budget === null ? null : JSON.stringify(resolved.budget),
      JSON.stringify(resolved.metadata ?? parseObject(existing.metadata)),
      now(),
      id,
    );
    // Re-arm the fire instant from the stored row whenever `next_run_at` could
    // have moved — a cadence change, an explicit `next_run_at`, or a status
    // write — so `due_at` never trails the schedule it fires against.
    armDeploymentDueAt(deps.db, deploymentRow(deps, id)!);
    const row = deploymentRow(deps, id)!;
    // Every comparison below is structural because the stored columns are
    // serializations: a text comparison would report a change for the same
    // object re-sent with its keys in another order. `status` and
    // `paused_reason` are deliberately absent — they belong to the pause
    // transition, which has dedicated events — and `updated_at` moves on every
    // write by construction.
    const fieldsChanged = (
      (resolved.name ?? existing.name) !== existing.name
      || (resolved.description === undefined ? existing.description : resolved.description) !== existing.description
      || (resolved.agent?.id ?? existing.agent_id) !== existing.agent_id
      || (resolved.agent === undefined ? existing.agent_version : resolved.agent.version) !== existing.agent_version
      || (resolved.environmentId === undefined ? existing.environment_id : resolved.environmentId) !== existing.environment_id
      || (resolved.cron === undefined ? existing.cron : resolved.cron) !== existing.cron
      || (resolved.timezone ?? existing.timezone ?? 'UTC') !== (existing.timezone || 'UTC')
      || (resolved.nextRunAt === undefined ? existing.next_run_at : resolved.nextRunAt) !== existing.next_run_at
      || !equalJsonValue(parseJsonArray(existing.initial_events), resolved.initialEvents ?? parseJsonArray(existing.initial_events))
      || !equalJsonValue(parseJsonArray(existing.resources), resolved.resources ?? parseJsonArray(existing.resources))
      || !equalJsonValue(parseJsonArray(existing.vault_ids), resolved.vaultIds ?? parseJsonArray(existing.vault_ids))
      || (resolved.budget === undefined ? existing.budget : resolved.budget === null ? null : JSON.stringify(resolved.budget)) !== existing.budget
      || !equalJsonObject(existing.metadata, resolved.metadata ?? parseObject(existing.metadata))
      || !equalJsonObject(existing.payload, body.value.payload === undefined ? parseObject(existing.payload) : objectField(body.value.payload))
    );
    if (fieldsChanged) {
      await publishOperationEvent(deps, {
        type: 'deployment.updated',
        subjectId: id,
      });
    }
    // The update can change the pause state through its `status` field, which
    // is a third door onto the same state. Publishing from here is what keeps
    // the event tied to the transition rather than to the route that caused it.
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), resolved.status);
    return c.json(toApiDeployment(row));
  };
  // `POST` is the published update verb; `PUT` remains mounted as the local
  // alias it has always been, running the identical handler.
  app.post('/:id', updateDeployment);
  app.put('/:id', updateDeployment);

  app.post('/:id/pause', async (c) => {
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT id, status FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as { id: string; status: string } | undefined;
    if (!existing) return notFound(c, 'Deployment not found');
    // Idempotent: pausing a paused deployment re-records the same reason rather
    // than erroring, because the caller's intent is already satisfied and a 409
    // would make a retried request fail for no reason.
    deps.db.prepare('UPDATE scheduled_deployments SET status = ?, paused_reason = ?, updated_at = ? WHERE id = ?')
      .run('paused', pauseReasonFor('paused'), now(), id);
    // A paused deployment keeps its `next_run_at` — resume needs it to detect a
    // schedule that elapsed while paused — but its fire instant is disarmed, so
    // `due_at` only ever names a fire that can happen.
    armDeploymentDueAt(deps.db, deploymentRow(deps, id)!);
    const row = deploymentRow(deps, id)!;
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), 'paused');
    return c.json(toApiDeployment(row));
  });

  app.post('/:id/unpause', async (c) => {
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as ScheduledDeploymentRow | undefined;
    if (!existing) return notFound(c, 'Deployment not found');
    const resumeAt = nextRunAfterResume(existing);
    deps.db.prepare('UPDATE scheduled_deployments SET status = ?, paused_reason = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run('active', null, resumeAt, now(), id);
    // Resuming re-arms the fire instant for the schedule it just restored.
    armDeploymentDueAt(deps.db, deploymentRow(deps, id)!);
    const row = deploymentRow(deps, id)!;
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), 'active');
    return c.json(toApiDeployment(row));
  });

  app.post('/:id/archive', async (c) => {
    const outcome = archiveById(c, deps, 'scheduled_deployments', toApiDeployment, 'Deployment not found');
    // Published only when the archive actually happened. A repeat archive is a
    // 404 from the shared guard, not a second archive, so it publishes nothing —
    // which is the rule the published table states for the sibling resource
    // ("对已归档的环境再次归档不会发出任何事件", `订阅Webhook.md:79`).
    //
    // Published after the write, so a receiver that resolves the reference at
    // delivery time sees `archived_at` set rather than an unarchived deployment.
    if (outcome.archived) {
      await publishOperationEvent(deps, {
        type: 'deployment.archived',
        subjectId: outcome.row.id,
      });
    }
    return outcome.response;
  });

  app.get('/:id/runs', (c) => {
    const schedule = deps.db.prepare('SELECT id FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!schedule) return notFound(c, 'Deployment not found');
    const rows = deps.db.prepare(`${RUN_VIEW_SELECT} WHERE r.schedule_id = ? ORDER BY r.started_at DESC`).all(c.req.param('id')) as unknown as DeploymentRunViewRow[];
    return collections.json(c, rows.map(toDeploymentRun));
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    // Archived or not, the row either exists or the answer is the same 404 —
    // delete is the permanent form of archive and does not exclude it.
    const existing = deps.db.prepare('SELECT id FROM scheduled_deployments WHERE id = ?').get(id);
    if (!existing) return notFound(c, 'Deployment not found');
    // The run rows are deployment-owned records: `schedule_id` is a hard
    // foreign key, so they leave in the same transaction rather than orphan.
    // The sessions a run materialized are independent resources and survive —
    // their link to this deployment was the run row.
    deps.db.transaction(() => {
      deps.db.prepare('DELETE FROM scheduled_deployment_runs WHERE schedule_id = ?').run(id);
      deps.db.prepare('DELETE FROM scheduled_deployments WHERE id = ?').run(id);
    });
    // Published after the write: the event is the final result, because after
    // this point there is no object to fetch.
    await publishOperationEvent(deps, { type: 'deployment.deleted', subjectId: id });
    return c.json({ id, type: 'deployment_deleted' });
  });

  app.post('/:id/run', async (c) => {
    const body = await readOptionalObjectBody(c);
    if (!body.ok) return body.response;
    const schedule = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as ScheduleRow | undefined;
    if (!schedule) return notFound(c, 'Deployment not found');
    // A paused deployment is still runnable by hand. The published contract says
    // so outright — "暂停期间仍允许通过 `run` 端点进行手动运行" (`定时部署.md:490`) —
    // because pause suppresses the *scheduler*, not the endpoint. This route used
    // to refuse any status other than `active`, which made pause mean "cannot be
    // run at all" and left an operator with no way to drain a paused deployment.
    //
    // The refusal is removed rather than narrowed to `paused` alone, because the
    // guard was unreachable for every other value: the query above already
    // excludes archived rows, and `normalizeScheduleStatus` maps everything that
    // is not `paused` to `active`. So the only status it could ever have seen
    // besides `active` is the one the contract says must be allowed, and an
    // `=== 'archived'` check here would be dead code asserting nothing.
    try {
      const outcome = runSchedule(
        deps.db,
        deps.sessionManager,
        schedule as never,
        stringField(body.value.trigger_type) ?? 'manual',
      );
      // A manual trigger can still trip the two deployment-level transitions:
      // an agent that no longer exists archives the deployment, and an
      // unrecoverable creation failure pauses it. `deployment_run.*` events
      // stay silent here by contract — only the timed path raises them.
      if (outcome.archivedDeployment) {
        await publishOperationEvent(deps, { type: 'deployment.archived', subjectId: schedule.id });
        return c.json({ error: { type: 'conflict', message: 'Deployment was archived: its agent no longer exists' } }, 409);
      }
      if (outcome.pausedDeployment) {
        await publishOperationEvent(deps, { type: 'deployment.paused', subjectId: schedule.id });
      }
      return c.json(toDeploymentRun(deploymentRunById(deps, outcome.run!.id)!), 201);
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err?.message ?? String(err) } }, 500);
    }
  });

  return app;
}

/**
 * Query parameters `GET /v1/deployments` accepts: the published filter set
 * plus the local pagination trio.
 */
const DEPLOYMENT_LIST_PARAMS = [
  'agent_id',
  'created_at[gte]',
  'created_at[lte]',
  'include_archived',
  'status',
  'limit',
  'page',
] as const;

/**
 * The deployment read view: the stored row plus the agent's current version,
 * so a deployment written before `agent_version` existed still projects the
 * concrete version the published `agent` reference requires.
 */
const DEPLOYMENT_SELECT = `
  SELECT d.*, a.version AS resolved_agent_version
  FROM scheduled_deployments d
  LEFT JOIN agents a ON a.id = d.agent_id
`;

type DeploymentViewRow = ScheduledDeploymentRow & { resolved_agent_version: number | null };

function deploymentRow(deps: ServerDeps, id: string): DeploymentViewRow | undefined {
  return deps.db.prepare(`${DEPLOYMENT_SELECT} WHERE d.id = ?`).get(id) as DeploymentViewRow | undefined;
}

function deploymentRunById(deps: ServerDeps, id: string): DeploymentRunViewRow | undefined {
  return deps.db.prepare(`${RUN_VIEW_SELECT} WHERE r.id = ?`).get(id) as DeploymentRunViewRow | undefined;
}

/**
 * The published deployment object.
 *
 * `agent.version` is the version the deployment pins — resolved at create —
 * falling back to the agent's current version for rows that predate pinning.
 * `schedule` is the published `cron` object: `upcoming_runs_at` lists the next
 * three fire instants while the deployment lives and is empty once archived,
 * and `last_run_at` is the most recent *scheduled* start, which manual runs
 * deliberately do not move. A deployment with no schedule is manual-only and
 * reports `schedule: null`.
 */
function toApiDeployment(row: DeploymentViewRow) {
  const archived = row.archived_at !== null;
  return {
    id: row.id,
    type: 'deployment',
    name: row.name,
    description: row.description || null,
    agent: {
      type: 'agent',
      id: row.agent_id,
      version: row.agent_version ?? row.resolved_agent_version ?? null,
    },
    environment_id: row.environment_id ?? null,
    initial_events: parseJsonArray(row.initial_events),
    resources: parseJsonArray(row.resources),
    vault_ids: parseJsonArray(row.vault_ids).map(String),
    budget: row.budget ? parseObject(row.budget) : null,
    metadata: parseObject(row.metadata),
    schedule: row.cron
      ? {
        type: 'cron',
        expression: row.cron,
        timezone: row.timezone || 'UTC',
        last_run_at: row.last_run_at ?? null,
        upcoming_runs_at: archived ? [] : upcomingRunsAt(row.cron, row.timezone || 'UTC'),
      }
      : null,
    // The pause axis and the archive axis are independent in the published
    // shape: an archived deployment keeps reporting whether it was paused.
    status: normalizeScheduleStatus(row.status),
    paused_reason: row.paused_reason ? parseObject(row.paused_reason) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

/** The next `count` fire instants of a cron expression, in its zone. */
function upcomingRunsAt(cron: string, timezone: string, count = 3): string[] {
  const runs: string[] = [];
  let after = new Date();
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRun(cron, after, timezone);
    if (!next) break;
    runs.push(next.toISOString());
    after = new Date(next.getTime() + 1000);
  }
  return runs;
}

/**
 * Resolve every writable field of a deployment create/update into one shape,
 * or a `Response` when the request cannot be honoured.
 *
 * The same resolver serves both routes so the two cannot disagree about what
 * a field means. `existing` distinguishes them: `null` is a create, where
 * omitted required fields surface as `undefined` for the caller to refuse;
 * a row is an update, where omission preserves.
 */
function resolveDeploymentWrite(
  deps: ServerDeps,
  value: Record<string, unknown>,
  existing: DeploymentViewRow | null,
): DeploymentWrite | Response {
  const out: DeploymentWrite = { status: 'active' };

  const name = stringField(value.name);
  if (value.name !== undefined && !name) return badRequest('name must be a non-empty string');
  if (name) out.name = name;

  if (value.agent !== undefined || value.agent_id !== undefined) {
    const agentRef = normalizeAgentRef(value.agent ?? value.agent_id);
    if (!agentRef.ok) return badRequest(agentRef.message, agentRef.code);
    if (agentRef.ref.kind === 'overrides') {
      return badRequest('agent overrides are not supported on a deployment', 'invalid_agent_ref');
    }
    const agentRow = deps.db.prepare('SELECT id, version, status, archived_at FROM agents WHERE id = ?').get(agentRef.ref.id) as { id: string; version: number; status: string; archived_at: string | null } | undefined;
    if (!agentRow || agentRow.status === 'archived' || agentRow.archived_at) {
      return badRequest(`Agent not found: ${agentRef.ref.id}`, 'agent_not_found');
    }
    if (agentRef.ref.kind === 'pinned') {
      const pinned = deps.db.prepare('SELECT 1 FROM agent_versions WHERE agent_id = ? AND version = ?').get(agentRef.ref.id, agentRef.ref.version);
      // An agent that was never republished keeps its first version on the
      // `agents` row rather than in `agent_versions` — the same fallback the
      // session runner applies when it resolves a pinned snapshot.
      if (!pinned && agentRow.version !== agentRef.ref.version) {
        return badRequest(`Agent ${agentRef.ref.id} has no version ${agentRef.ref.version}`, 'agent_not_found');
      }
    }
    out.agent = {
      id: agentRef.ref.id,
      version: agentRef.ref.kind === 'pinned' ? agentRef.ref.version! : agentRow.version,
    };
  }

  if (value.environment_id !== undefined) {
    if (value.environment_id === null) return badRequest('environment_id cannot be cleared');
    const environment = normalizeEnvironmentId(deps, value.environment_id);
    if (!environment.ok) return badRequest(environment.message);
    out.environmentId = environment.value;
  }

  if (value.initial_events !== undefined) {
    if (value.initial_events === null) return badRequest('initial_events cannot be cleared', 'invalid_initial_events');
    const initialEvents = normalizeInitialEvents(value.initial_events, { allowSystemMessage: true });
    if (!initialEvents.ok) return badRequest(initialEvents.message ?? 'initial_events is invalid', initialEvents.code ?? 'invalid_initial_events');
    if (initialEvents.events!.length === 0) {
      return badRequest('initial_events must contain at least one event', 'invalid_initial_events');
    }
    out.initialEvents = initialEvents.events!;
  }

  if (value.resources !== undefined) {
    if (value.resources === null) {
      out.resources = [];
    } else {
      const resources = normalizeResources(deps, value.resources);
      if (!resources.ok) return badRequest(resources.message);
      out.resources = resources.value;
    }
  }

  if (value.vault_ids !== undefined) {
    if (value.vault_ids === null) {
      out.vaultIds = [];
    } else {
      const vaultIds = normalizeVaultIds(deps, value.vault_ids);
      if (!vaultIds.ok) return badRequest(vaultIds.message);
      out.vaultIds = vaultIds.value;
    }
  }

  if (value.budget !== undefined) {
    const budget = parseSessionBudget(value.budget);
    if (!budget.ok) return badRequest(budget.message ?? 'budget is invalid', budget.code ?? BUDGET_ERROR_CODES.invalidShape);
    out.budget = budget.remove ? null : budget.budget ?? null;
  }

  if (value.description !== undefined) {
    out.description = descriptionPatch(value.description, existing?.description ?? null);
  }

  if (value.metadata !== undefined && value.metadata !== null) {
    out.metadata = mergeMetadataPatch(existing?.metadata, value.metadata);
  }

  // The cadence resolves from the published `schedule` object or the legacy
  // flat `cron`/`timezone` pair. `schedule: null` reverts to manual-only.
  if (value.schedule !== undefined || value.cron !== undefined || value.timezone !== undefined) {
    if (value.schedule === null) {
      out.cron = null;
      out.timezone = existing?.timezone ?? 'UTC';
      out.nextRunAt = null;
    } else {
      const schedule = parseScheduleFields({
        cron: value.cron ?? existing?.cron,
        timezone: value.timezone ?? existing?.timezone ?? 'UTC',
        schedule: value.schedule,
      });
      if (!schedule.ok) return badRequest(schedule.message);
      out.cron = schedule.expression;
      out.timezone = schedule.timezone;
      const cadenceChanged = schedule.expression !== existing?.cron || schedule.timezone !== (existing?.timezone || 'UTC');
      out.nextRunAt = existing === null || cadenceChanged
        ? nextCronRun(schedule.expression, new Date(), schedule.timezone)?.toISOString() ?? null
        : existing.next_run_at;
    }
  }

  // `next_run_at` stays caller-settable as a local extension.
  if (value.next_run_at !== undefined) {
    const explicit = stringField(value.next_run_at);
    if (explicit) out.nextRunAt = explicit;
  }

  if (value.status !== undefined) {
    out.status = normalizeScheduleStatus(value.status);
    out.pausedReason = pauseReasonFor(out.status);
  } else {
    out.status = existing ? normalizeScheduleStatus(existing.status) : 'active';
    if (value.schedule !== undefined || value.cron !== undefined) {
      // Keep the stored paused_reason in step with a status the caller did not
      // touch: an active deployment never carries a stale reason.
      out.pausedReason = out.status === 'paused' ? existing!.paused_reason : null;
    }
  }

  return out;
}

function badRequest(message: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { type: 'invalid_request_error', ...(code ? { code } : {}), message } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

type DeploymentWrite = {
  name?: string;
  description?: string | null;
  agent?: { id: string; version: number | null };
  environmentId?: string;
  initialEvents?: unknown[];
  resources?: Array<Record<string, unknown>>;
  vaultIds?: string[];
  budget?: SessionBudget | null;
  metadata?: Record<string, unknown>;
  cron?: string | null;
  timezone?: string;
  nextRunAt?: string | null;
  status: 'active' | 'paused';
  pausedReason?: string | null;
};

type ScheduledDeploymentRow = {
  id: string;
  name: string;
  description: string | null;
  agent_id: string;
  agent_version: number | null;
  environment_id: string | null;
  cron: string | null;
  timezone: string;
  payload: string;
  status: string;
  paused_reason: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  /** Jittered fire instant for `next_run_at`; NULL until armed. */
  due_at?: string | null;
  initial_events: string;
  resources: string;
  vault_ids: string;
  budget: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ScheduleRow = ScheduledDeploymentRow;

function parseJsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The reason recorded for a status, or `null` when the status has none.
 *
 * Every write path derives the reason from the status it is writing rather than
 * setting the two fields separately, so `status` and `paused_reason` cannot
 * disagree — a paused deployment always carries a reason, and an active one never
 * carries a stale one. The same reasoning that put the parked-wait timestamp
 * beside the parked call rather than in a second place.
 *
 * `manual` is the only reason the routes record. The contract's other kind —
 * an automatic pause after a non-recoverable trigger failure, whose `error.type`
 * is copied from the failed run — is written by the scheduler, which owns the
 * run-failure taxonomy.
 */
function pauseReasonFor(status: 'active' | 'paused'): string | null {
  return status === 'paused' ? JSON.stringify({ type: 'manual' }) : null;
}

/**
 * The instant an unpaused deployment should next run.
 *
 * The contract is explicit that unpausing resumes "from the next scheduled
 * instant" and that missed triggers are **not** caught up (`定时部署.md:535`).
 * Those two sentences are one rule: while a deployment is paused nothing advances
 * `next_run_at`, so a paused deployment whose slots elapsed still holds a past
 * instant, and leaving it there would make the next due pass fire every missed run
 * — the catch-up the contract forbids.
 *
 * A stored instant that is still in the future is kept as-is. It is already the
 * next scheduled instant, and recomputing it would discard a `next_run_at` the
 * caller set explicitly through the update route.
 *
 * The stored value is parsed rather than compared as a string, because
 * `next_run_at` is caller-supplied and need not carry the same precision or
 * form as `new Date().toISOString()`. A manual-only deployment has no cadence
 * to resume, so it stays unarmed.
 */
function nextRunAfterResume(row: ScheduledDeploymentRow): string | null {
  if (!row.cron) return null;
  const stored = row.next_run_at;
  const storedMs = stored ? Date.parse(stored) : Number.NaN;
  if (Number.isFinite(storedMs) && storedMs > Date.now()) return stored;
  return nextCronRun(row.cron, new Date(), row.timezone || 'UTC')?.toISOString() ?? null;
}

function looksLikeCron(value: string) {
  return value.trim().split(/\s+/).length === 5;
}

type ScheduleFieldsResult =
  | { ok: true; expression: string; timezone: string }
  | { ok: false; message: string };

/**
 * Read the cadence and its zone from either the flat local fields or the
 * canonical object.
 *
 * The published deployments API takes `schedule: { type: 'cron', expression,
 * timezone }`, while this runtime has always taken a flat `cron` string. Both
 * are accepted and resolved to one pair, so a canonical client and an existing
 * local one cannot disagree about what a deployment's cadence is.
 *
 * The zone is validated rather than defaulted: an unknown name would make
 * `nextCronRun` return `null`, and a deployment whose cadence silently stopped
 * resolving looks identical to one that simply has not come due yet.
 */
function parseScheduleFields(value: Record<string, unknown>): ScheduleFieldsResult {
  const nested = value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)
    ? value.schedule as Record<string, unknown>
    : undefined;
  const expression = stringField(nested?.expression) ?? stringField(value.cron);
  if (!expression) return { ok: false, message: 'cron is required' };
  if (!looksLikeCron(expression)) return { ok: false, message: 'cron must contain five fields' };
  const timezone = stringField(nested?.timezone) ?? stringField(value.timezone) ?? 'UTC';
  if (!isValidTimeZone(timezone)) {
    return { ok: false, message: `timezone must be an IANA time zone identifier (got "${timezone}")` };
  }
  return { ok: true, expression, timezone };
}

function normalizeScheduleStatus(value: unknown): 'active' | 'paused' {
  return value === 'paused' ? 'paused' : 'active';
}

/**
 * The published `description` patch: omitted preserves the stored value,
 * `null` clears it, and an empty or whitespace-only string is stored as an
 * empty string — which the read shape projects back to `null`.
 */
function descriptionPatch(incoming: unknown, stored: string | null): string {
  if (incoming === undefined) return stored ?? '';
  if (incoming === null) return '';
  return stringField(incoming) ?? '';
}

/**
 * Merge a `metadata` patch onto the stored bag. The published contract deletes
 * a key on a `null` **or** empty-string value; an omitted or whole `null`
 * field preserves the bag unchanged.
 */
function mergeMetadataPatch(stored: string | null | undefined, patch: unknown): Record<string, unknown> {
  const merged = parseObject(stored ?? null);
  if (patch === undefined || patch === null) return merged;
  for (const [key, value] of Object.entries(objectField(patch))) {
    if (value === null || value === '') delete merged[key];
    else merged[key] = String(value);
  }
  return merged;
}

// The helpers below keep their unused-import suppressions close: `JsonObject`
// is part of the operation-helper vocabulary this file shares even where the
// current routes do not need the alias.
export type { JsonObject };
