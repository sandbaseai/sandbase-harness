/**
 * Doc-example oracle — the published curl bodies replayed verbatim.
 *
 * Every cURL example in `contracts/anthropic-cma/official-docs/` sends its
 * request the same way: `?beta=true` on the URL, the `anthropic-version` and
 * `anthropic-beta` headers, and a JSON body. A reader who copies the docs
 * verbatim must get a response shaped like the documented object — not a 404
 * for the query spelling, and not a refusal for a documented field. This
 * suite replays a representative set of those bodies through the real router
 * and asserts the published envelope on the way out.
 *
 * It is deliberately not a copy of the SDK suites next to it: those exercise
 * `client.beta.*` and cover what the SDK sends. This one covers what the docs
 * *print* — including the `?beta=true` compatibility spelling the SDK never
 * produces — so a doc drift that breaks the verbatim request lands here even
 * when the SDK path still works.
 *
 * The bodies are transcribed from the docs with only the `$VAR` substitutions
 * resolved (agent/environment ids the flow created a moment earlier, or
 * `conformance-*` stand-ins). They are kept visually close to the source so a
 * reader can match each request to the page it came from.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeConformanceContexts,
  makeConformanceApp,
  type ConformanceContext,
} from './support/app.js';

const VERSION = '2023-06-01';
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

const contexts: ConformanceContext[] = [];

function app() {
  const ctx = makeConformanceApp('ma-conformance-docs-');
  contexts.push(ctx);
  return ctx;
}

/** Send a doc curl request: path already carries `?beta=true`, body is JSON. */
async function doc(
  ctx: ConformanceContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await ctx.app.request(path, {
    method,
    headers: {
      'anthropic-version': VERSION,
      'anthropic-beta': MANAGED_AGENTS_BETA,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

describe('doc cURL examples replayed verbatim', () => {
  afterEach(() => {
    disposeConformanceContexts(contexts);
  });

  it('creates an agent from the agent-setup body and reads back the published object', async () => {
    const ctx = app();
    // official-docs/agent-setup.md — "Create an agent".
    const created = await doc(ctx, 'POST', '/v1/agents?beta=true', {
      name: 'Coding Assistant',
      model: 'claude-opus-5-5',
      system: 'You are a helpful coding agent.',
      tools: [{ type: 'agent_toolset_20260401' }],
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      type: 'agent',
      name: 'Coding Assistant',
      model: 'claude-opus-5-5',
      system: 'You are a helpful coding agent.',
    });
    expect(created.body.id).toMatch(/^agent_/);
    expect(created.body.version).toBe(1);
  });

  it('refuses the doc inference_geo pin by name rather than silently storing it', async () => {
    const ctx = app();
    // official-docs/agent-setup.md — "Geo-pinned assistant". The doc's response
    // echoes `inference_geo`; this runtime has no inference-geography control,
    // so the field is refused by name (agents.md §4) rather than honoured or
    // dropped. The oracle value is the refusal itself: a doc reader must get a
    // decodable error naming the field, not a 201 on a stored no-op.
    const refused = await doc(ctx, 'POST', '/v1/agents?beta=true', {
      name: 'Geo-pinned assistant',
      model: { id: 'claude-opus-5-5', inference_geo: 'us' },
      system: 'You are a helpful assistant.',
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    expect(JSON.stringify(refused.body)).toContain('inference_geo');
  });

  it('creates a vault from the vaults body and reads back the published object', async () => {
    const ctx = app();
    // official-docs/vaults.md — "Create a vault".
    const created = await doc(ctx, 'POST', '/v1/vaults?beta=true', {
      display_name: 'Alice',
      metadata: { external_user_id: 'usr_abc123' },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      // The doc's response carries `"type": "vault"`; this runtime answers
      // `credential_vault`, the resource kind its Console and stored
      // references already read. That divergence is recorded in
      // credentials.md §4 rather than renamed, so the oracle asserts the
      // actual value and the field stays pinned by name.
      type: 'credential_vault',
      display_name: 'Alice',
      metadata: { external_user_id: 'usr_abc123' },
    });
    expect(created.body.id).toMatch(/^vlt_/);
  });

  it('creates a deployment from the scheduled-deployments body and reports the cron schedule', async () => {
    const ctx = app();
    // An agent and an environment must exist for the doc's `$AGENT_ID` /
    // `$ENVIRONMENT_ID` substitutions; create them the way the docs' own
    // quickstart does.
    const agent = await doc(ctx, 'POST', '/v1/agents?beta=true', {
      name: 'Doc agent',
      model: 'claude-opus-5-5',
      system: 'Doc agent.',
    });
    expect(agent.status).toBe(201);
    const environments = await doc(ctx, 'GET', '/v1/environments?beta=true');
    const environmentId = environments.body.data[0].id;

    // official-docs/scheduled-deployments.md — "Create a deployment".
    const deployment = await doc(ctx, 'POST', '/v1/deployments?beta=true', {
      name: 'Weekly compliance scan',
      agent: agent.body.id,
      environment_id: environmentId,
      initial_events: [
        { type: 'user.message', content: [{ type: 'text', text: 'Run the weekly compliance scan.' }] },
      ],
      schedule: {
        type: 'cron',
        expression: '0 20 * * 5',
        timezone: 'America/New_York',
      },
    });

    expect(deployment.status).toBe(201);
    expect(deployment.body).toMatchObject({
      type: 'deployment',
      name: 'Weekly compliance scan',
      status: 'active',
      schedule: { type: 'cron', expression: '0 20 * * 5', timezone: 'America/New_York' },
    });
    expect(deployment.body.id).toMatch(/^depl_/);
    // upcoming_runs_at is the exact schedule — the doc's jitter rule is an
    // execution detail that must not leak into the read projection. The
    // instants are zoned (America/New_York), so 20:00 local lands on a UTC
    // clock reading; assert the recurring pattern rather than a wall-clock
    // hour, and that the three instants step the cron's weekly cadence.
    expect(Array.isArray(deployment.body.schedule.upcoming_runs_at)).toBe(true);
    expect(deployment.body.schedule.upcoming_runs_at.length).toBeGreaterThan(0);
    const instants = deployment.body.schedule.upcoming_runs_at.map((s: string) => Date.parse(s));
    for (const ms of instants) {
      // Every listed instant falls on the same minute-of-hour a 20:00 cron
      // names, in whichever zone the schedule was written.
      expect(new Date(ms).getUTCMinutes()).toBe(0);
      expect(new Date(ms).getUTCSeconds()).toBe(0);
    }
    for (let i = 1; i < instants.length; i += 1) {
      expect(instants[i]! - instants[i - 1]!).toBe(7 * 24 * 60 * 60 * 1000); // 0 20 * * 5 → weekly
    }
  });

  it('updates a deployment budget from the doc body and lists its runs through the published filters', async () => {
    const ctx = app();
    const agent = await doc(ctx, 'POST', '/v1/agents?beta=true', {
      name: 'Doc agent', model: 'claude-opus-5-5', system: 'Doc agent.',
    });
    const environments = await doc(ctx, 'GET', '/v1/environments?beta=true');
    const deployment = await doc(ctx, 'POST', '/v1/deployments?beta=true', {
      name: 'Run-filter deployment',
      agent: agent.body.id,
      environment_id: environments.body.data[0].id,
      initial_events: [
        { type: 'user.message', content: [{ type: 'text', text: 'run' }] },
      ],
    });
    const deploymentId = deployment.body.id;

    // official-docs/scheduled-deployments.md — the update body (POST verb, no
    // -X) that sets a budget.
    const updated = await doc(ctx, 'POST', `/v1/deployments/${deploymentId}?beta=true`, {
      budget: { type: 'limit', max_list_cost: { amount: '2000', currency: 'USD' } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.budget).toMatchObject({
      type: 'limit',
      max_list_cost: { amount: '2000', currency: 'USD' },
    });

    // The doc's list call spells the filter as ?deployment_id=...&has_error=...
    // beside ?beta=true — exactly what the published example sends.
    const runs = await doc(
      ctx, 'GET', `/v1/deployment_runs?beta=true&deployment_id=${deploymentId}&has_error=true`,
    );
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body.data)).toBe(true);
    // A freshly created deployment has produced no runs; the filter still has
    // to be honoured rather than refused.
    expect(runs.body.data).toHaveLength(0);
  });
});
