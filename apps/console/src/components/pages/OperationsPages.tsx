import { Activity, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Play, Plus, RadioTower, Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../../api';
import type { ConsoleData, DeploymentRun, Outcome, ScheduledDeployment, Session, Webhook, WebhookDelivery } from '../../types';
import { EmptyState, RequiredMark, ResourceBadge, StatusPill, SummaryStrip } from '../Common';
import { Modal } from '../Modal';
import { formatDateShort, truncateMiddle } from '../../lib/format';
import { WEBHOOK_EVENT_GROUPS } from '../../lib/webhook-events';

type ScheduledDeploymentRun = DeploymentRun;

type SessionOutcome = {
  id: string;
  session_id: string;
  outcome_id: string | null;
  status: string;
  score: number | null;
  summary: string;
};

type OperationsPageProps = {
  data: ConsoleData;
  onRefresh: () => void;
};

export function WebhooksPage({ data, onRefresh }: OperationsPageProps) {
  const [testingId, setTestingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deliveriesId, setDeliveriesId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const testWebhook = async (webhook: Webhook) => {
    setTestingId(webhook.id);
    setMessage('');
    try {
      const delivery = await postJson<WebhookDelivery>(`/v1/webhooks/${webhook.id}/test`, {
        event: webhook.events[0] ?? 'session.created',
        payload: { source: 'console', dry_run: true },
      });
      setMessage(`Test delivery ${truncateMiddle(delivery.id, 18)} recorded with ${delivery.status_code ?? 'no'} status.`);
      onRefresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'Could not test webhook');
    } finally {
      setTestingId(null);
    }
  };

  const retryDue = async () => {
    setRetrying(true);
    setMessage('');
    try {
      const page = await postJson<{ data: WebhookDelivery[] }>('/v1/webhooks/retry-due', {});
      setMessage(`Retried ${page.data.length} due webhook deliver${page.data.length === 1 ? 'y' : 'ies'}.`);
      onRefresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'Could not retry webhooks');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Webhooks</h1>
          <p>Persist callback subscriptions for session lifecycle, turn, and operations events. Test records a signed local delivery; Retry due dispatches queued retries.</p>
        </div>
        <div className="toolbarActions">
          <button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />Create webhook
          </button>
          <button className="secondaryButton" type="button" onClick={() => void retryDue()} disabled={retrying || data.webhooks.length === 0}>
            <Send size={16} /> {retrying ? 'Retrying...' : 'Retry due'}
          </button>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Subscriptions', value: data.webhooks.length, icon: <RadioTower size={18} /> },
        { label: 'Active', value: data.webhooks.filter((item) => item.status === 'active').length, icon: <Activity size={18} /> },
        { label: 'Event bindings', value: data.webhooks.reduce((total, item) => total + item.events.length, 0), icon: <Send size={18} /> },
        { label: 'Retry mode', value: 'manual', icon: <Send size={18} /> },
      ]} />
      <OperationGuide items={[
        { icon: <RadioTower size={17} />, title: 'Define subscriptions', body: 'Create webhook records here, then keep delivery operations visible and safe from the same Console page.' },
        { icon: <Send size={17} />, title: 'Test delivery', body: 'Send a signed dry-run payload before wiring the endpoint into a real workflow.' },
        { icon: <Activity size={17} />, title: 'Retry queue', body: 'Process due retries from here while delivery history remains in the local runtime.' },
      ]} />
      <div className="tablePanel operationTablePanel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>URL</th><th>Events</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead>
          <tbody>
            {data.webhooks.map((webhook) => (
              <WebhookRow
                key={webhook.id}
                webhook={webhook}
                testingId={testingId}
                expanded={deliveriesId === webhook.id}
                onToggleDeliveries={() => setDeliveriesId((current) => current === webhook.id ? null : webhook.id)}
                onTest={testWebhook}
              />
            ))}
          </tbody>
        </table>
        {data.webhooks.length === 0 ? (
          <EmptyState
            icon={<RadioTower size={22} />}
            title="No webhooks"
            body="Create webhook subscriptions here, then test deliveries and retry due attempts from the same page."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create webhook</button>}
          />
        ) : null}
      </div>
      <div className="mobileResourceList">
        {data.webhooks.map((webhook) => (
          <article className="mobileResourceCard" key={webhook.id}>
            <span className="mobileAgentMain">
              <strong>{webhook.name}</strong>
              <small className="monoText">{truncateMiddle(webhook.url, 42)}</small>
            </span>
            <span className="mobileAgentMeta">
              <ResourceBadge>{webhook.events.length} events</ResourceBadge>
              <StatusPill status={webhook.status} />
            </span>
            <button className="ghostButton compactButton" type="button" onClick={() => testWebhook(webhook)} disabled={testingId === webhook.id || webhook.status !== 'active'}>
              <Send size={14} /> {testingId === webhook.id ? 'Testing...' : 'Test'}
            </button>
          </article>
        ))}
        {data.webhooks.length === 0 ? (
          <EmptyState
            icon={<RadioTower size={22} />}
            title="No webhooks"
            body="Create webhook subscriptions here, then test deliveries and retry due attempts from the same page."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create webhook</button>}
          />
        ) : null}
      </div>
      {message ? <OperationNotice>{message}</OperationNotice> : null}
      {createOpen ? (
        <WebhookCreateModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

export function ScheduledDeploymentsPage({ data, onRefresh }: OperationsPageProps) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningDue, setRunningDue] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [runsId, setRunsId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const runSchedule = async (schedule: ScheduledDeployment) => {
    setRunningId(schedule.id);
    setMessage('');
    try {
      const run = await postJson<ScheduledDeploymentRun>(`/v1/scheduled-deployments/${schedule.id}/run`, {
        trigger_type: 'manual',
      });
      setMessage(run.session_id
        ? `Run ${truncateMiddle(run.id, 18)} created session ${truncateMiddle(run.session_id, 18)}.`
        : `Run ${truncateMiddle(run.id, 18)} failed: ${run.error?.message ?? 'unknown error'}.`);
      onRefresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'Could not run schedule');
    } finally {
      setRunningId(null);
    }
  };

  const runDueSchedules = async () => {
    setRunningDue(true);
    setMessage('');
    try {
      const page = await postJson<{ data: ScheduledDeploymentRun[] }>('/v1/scheduled-deployments/run-due', {});
      setMessage(`Ran ${page.data.length} due scheduled deployment${page.data.length === 1 ? '' : 's'}.`);
      onRefresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'Could not run due schedules');
    } finally {
      setRunningDue(false);
    }
  };

  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Scheduled deployments</h1>
          <p>Persist cron-style run plans for agents and environments. Run due executes all active schedules whose next run has arrived.</p>
        </div>
        <div className="toolbarActions">
          <button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />Create schedule
          </button>
          <button className="secondaryButton" type="button" onClick={() => void runDueSchedules()} disabled={runningDue || data.scheduledDeployments.length === 0}>
            <Play size={16} /> {runningDue ? 'Running due...' : 'Run due'}
          </button>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Schedules', value: data.scheduledDeployments.length, icon: <CalendarClock size={18} /> },
        { label: 'Active', value: data.scheduledDeployments.filter((item) => item.status === 'active').length, icon: <Activity size={18} /> },
        { label: 'Due candidates', value: data.scheduledDeployments.filter((item) => item.status === 'active' && item.schedule?.upcoming_runs_at?.[0]).length, icon: <Play size={18} /> },
        { label: 'Runner', value: 'manual', icon: <Play size={18} /> },
      ]} />
      <OperationGuide items={[
        { icon: <CalendarClock size={17} />, title: 'Cron plans', body: 'Schedules bind an agent, environment, payload, and next-run timestamp into a replayable plan.' },
        { icon: <Play size={17} />, title: 'Manual run', body: 'Run one schedule immediately without waiting for the due-run loop.' },
        { icon: <Activity size={17} />, title: 'Due-run sweep', body: 'Process every active schedule whose next run is ready, then refresh local state.' },
      ]} />
      <div className="tablePanel operationTablePanel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Agent</th><th>Environment</th><th>Cron</th><th>Status</th><th>Next run</th><th>Action</th></tr></thead>
          <tbody>
            {data.scheduledDeployments.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                runningId={runningId}
                expanded={runsId === schedule.id}
                onToggleRuns={() => setRunsId((current) => current === schedule.id ? null : schedule.id)}
                onRun={runSchedule}
              />
            ))}
          </tbody>
        </table>
        {data.scheduledDeployments.length === 0 ? (
          <EmptyState
            icon={<CalendarClock size={22} />}
            title="No scheduled deployments"
            body="Create schedules here, then run one schedule or process all due runs from the same page."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create schedule</button>}
          />
        ) : null}
      </div>
      <div className="mobileResourceList">
        {data.scheduledDeployments.map((schedule) => (
          <article className="mobileResourceCard" key={schedule.id}>
            <span className="mobileAgentMain">
              <strong>{schedule.name}</strong>
              <small className="monoText">{schedule.schedule?.expression ?? 'manual'}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{schedule.schedule?.upcoming_runs_at?.[0] ? `Next ${formatDateShort(schedule.schedule.upcoming_runs_at[0])}` : 'No next run'}</span>
              <StatusPill status={schedule.status} />
            </span>
            <button className="ghostButton compactButton" type="button" onClick={() => runSchedule(schedule)} disabled={runningId === schedule.id || schedule.status !== 'active'}>
              <Play size={14} /> {runningId === schedule.id ? 'Running...' : 'Run now'}
            </button>
          </article>
        ))}
        {data.scheduledDeployments.length === 0 ? (
          <EmptyState
            icon={<CalendarClock size={22} />}
            title="No scheduled deployments"
            body="Create schedules here, then run one schedule or process all due runs from the same page."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create schedule</button>}
          />
        ) : null}
      </div>
      {message ? <OperationNotice>{message}</OperationNotice> : null}
      {createOpen ? (
        <ScheduledDeploymentCreateModal
          data={data}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

export function OutcomesPage({ data, onRefresh }: OperationsPageProps) {
  const latestSessionId = useMemo(() => data.sessions[0]?.id ?? '', [data.sessions]);
  const [selectedSessionId, setSelectedSessionId] = useState(latestSessionId);
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!selectedSessionId && latestSessionId) setSelectedSessionId(latestSessionId);
  }, [latestSessionId, selectedSessionId]);

  const evaluateOutcome = async (outcome: Outcome) => {
    if (!selectedSessionId) {
      setMessage('Create a session before evaluating outcomes.');
      return;
    }
    setEvaluatingId(outcome.id);
    setMessage('');
    try {
      const result = await postJson<SessionOutcome>(`/v1/sessions/${selectedSessionId}/outcomes/evaluate`, {
        outcome_id: outcome.id,
      });
      setMessage(`Evaluation ${truncateMiddle(result.id, 18)}: ${result.status}${typeof result.score === 'number' ? ` (${Math.round(result.score * 100)}%)` : ''}.`);
      onRefresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'Could not evaluate outcome');
    } finally {
      setEvaluatingId(null);
    }
  };

  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Outcome templates (local)</h1>
          <p>
            Local reusable outcome definitions — a SandBase extension, not part of the published
            event protocol. The official flow declares an outcome inside a session by sending a
            <code> user.define_outcome </code> event (Session page → Actions → Define outcome);
            its evaluations surface on the session's <code>outcome_evaluations</code>.
          </p>
        </div>
        <div className="toolbarActions">
          <button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />Create outcome
          </button>
          <SessionPicker sessions={data.sessions} selectedSessionId={selectedSessionId} onChange={setSelectedSessionId} />
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Definitions', value: data.outcomes.length, icon: <CheckCircle2 size={18} /> },
        { label: 'Active', value: data.outcomes.filter((item) => item.status === 'active').length, icon: <Activity size={18} /> },
        { label: 'Sessions available', value: data.sessions.length, icon: <Play size={18} /> },
        { label: 'Evaluator', value: 'deterministic', icon: <CheckCircle2 size={18} /> },
      ]} />
      <OperationGuide items={[
        { icon: <CheckCircle2 size={17} />, title: 'Define criteria', body: 'Outcome definitions capture objective, criteria, threshold, and evaluator policy.' },
        { icon: <Play size={17} />, title: 'Evaluate a run', body: 'Pick a real session, evaluate it against one definition, and record the result.' },
        { icon: <Activity size={17} />, title: 'Use as evidence', body: 'Treat session outcomes as deployment-quality evidence for FDE handoffs.' },
      ]} />
      <div className="tablePanel operationTablePanel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Objective</th><th>Criteria</th><th>Threshold</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead>
          <tbody>
            {data.outcomes.map((outcome) => (
              <tr key={outcome.id}>
                <td><code>{truncateMiddle(outcome.id, 18)}</code></td>
                <td><strong>{outcome.name}</strong></td>
                <td>{outcome.objective}</td>
                <td><ResourceBadge>{outcome.criteria.length} criteria</ResourceBadge></td>
                <td><ResourceBadge>{Math.round((outcome.pass_threshold ?? 0.75) * 100)}% · {outcome.evaluator ?? 'deterministic'}</ResourceBadge></td>
                <td><StatusPill status={outcome.status} /></td>
                <td>{formatDateShort(outcome.updated_at)}</td>
                <td>
                  <button className="ghostButton compactButton" type="button" onClick={() => evaluateOutcome(outcome)} disabled={evaluatingId === outcome.id || outcome.status !== 'active' || !selectedSessionId}>
                    <CheckCircle2 size={14} /> {evaluatingId === outcome.id ? 'Evaluating...' : 'Evaluate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.outcomes.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={22} />}
            title="No outcomes"
            body="Create outcome definitions here; local deterministic evaluation is available after a definition exists."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create outcome</button>}
          />
        ) : null}
      </div>
      <div className="mobileResourceList">
        {data.outcomes.map((outcome) => (
          <article className="mobileResourceCard" key={outcome.id}>
            <span className="mobileAgentMain">
              <strong>{outcome.name}</strong>
              <small>{outcome.objective}</small>
            </span>
            <span className="mobileAgentMeta">
              <ResourceBadge>{Math.round((outcome.pass_threshold ?? 0.75) * 100)}% · {outcome.evaluator ?? 'deterministic'}</ResourceBadge>
              <StatusPill status={outcome.status} />
            </span>
            <button className="ghostButton compactButton" type="button" onClick={() => evaluateOutcome(outcome)} disabled={evaluatingId === outcome.id || outcome.status !== 'active' || !selectedSessionId}>
              <CheckCircle2 size={14} /> {evaluatingId === outcome.id ? 'Evaluating...' : 'Evaluate'}
            </button>
          </article>
        ))}
        {data.outcomes.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={22} />}
            title="No outcomes"
            body="Create outcome definitions here; local deterministic evaluation is available after a definition exists."
            action={<button className="primaryButton" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />Create outcome</button>}
          />
        ) : null}
      </div>
      {message ? <OperationNotice>{message}</OperationNotice> : null}
      {createOpen ? (
        <OutcomeCreateModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ScheduleRow({
  schedule,
  runningId,
  expanded,
  onToggleRuns,
  onRun,
}: {
  schedule: ScheduledDeployment;
  runningId: string | null;
  expanded: boolean;
  onToggleRuns: () => void;
  onRun: (schedule: ScheduledDeployment) => void;
}) {
  return (
    <>
      <tr>
        <td><code>{truncateMiddle(schedule.id, 18)}</code></td>
        <td><strong>{schedule.name}</strong></td>
        <td><code>{truncateMiddle(schedule.agent.id, 20)}</code></td>
        <td>{schedule.environment_id ? <code>{truncateMiddle(schedule.environment_id, 18)}</code> : <span className="mutedValue">default</span>}</td>
        <td><span className="monoValue">{schedule.schedule?.expression ?? 'manual'}</span></td>
        <td><StatusPill status={schedule.status} /></td>
        <td>{schedule.schedule?.upcoming_runs_at?.[0] ? formatDateShort(schedule.schedule.upcoming_runs_at[0]) : '-'}</td>
        <td>
          <div className="rowActionGroup">
            <button className="ghostButton compactButton" type="button" onClick={onToggleRuns} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Runs
            </button>
            <button className="ghostButton compactButton" type="button" onClick={() => onRun(schedule)} disabled={runningId === schedule.id || schedule.status !== 'active'}>
              <Play size={14} /> {runningId === schedule.id ? 'Running...' : 'Run now'}
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="expansionRow">
          <td colSpan={8}><DeploymentRuns schedule={schedule} /></td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * One deployment's runs plus the full upcoming-run projection. Each run is
 * the published `deployment_run` object: `trigger_context` reports how the
 * run fired (`schedule` carries the matched `scheduled_at`), and a failed
 * run's `error.type` is the classified vocabulary the scheduler wrote.
 */
function DeploymentRuns({ schedule }: { schedule: ScheduledDeployment }) {
  const [runs, setRuns] = useState<DeploymentRun[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson<{ data: DeploymentRun[] } | DeploymentRun[]>(`/v1/deployment_runs?deployment_id=${encodeURIComponent(schedule.id)}`)
      .then((page) => {
        if (!active) return;
        setRuns(Array.isArray(page) ? page : page.data ?? []);
      })
      .catch((err: any) => {
        if (active) setError(err?.message ?? 'Could not load runs');
      });
    return () => { active = false; };
  }, [schedule.id]);

  const upcoming = schedule.schedule?.upcoming_runs_at ?? [];

  return (
    <div className="deploymentRunsPanel">
      {upcoming.length > 0 ? (
        <p className="mutedValue">
          Upcoming runs: {upcoming.map((at) => formatDateShort(at)).join(' · ')}
          {schedule.schedule?.timezone ? ` (${schedule.schedule.timezone})` : ''}
        </p>
      ) : null}
      {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
      {!error && runs === null ? <p className="mutedValue">Loading runs…</p> : null}
      {runs && runs.length === 0 ? <p className="mutedValue">No runs recorded.</p> : null}
      {runs && runs.length > 0 ? (
        <table className="deliveriesTable">
          <thead>
            <tr><th>Run</th><th>Trigger</th><th>Session</th><th>Error</th><th>Started</th></tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td><code>{truncateMiddle(run.id, 18)}</code></td>
                <td>
                  <code>{run.trigger_context?.type ?? '-'}</code>
                  {run.trigger_context?.scheduled_at ? <small className="mutedValue"> due {formatDateShort(run.trigger_context.scheduled_at)}</small> : null}
                </td>
                <td>{run.session_id ? <code>{truncateMiddle(run.session_id, 18)}</code> : <span className="mutedValue">-</span>}</td>
                <td>{run.error ? <span className="fieldError"><code>{run.error.type}</code> {run.error.message}</span> : <span className="mutedValue">-</span>}</td>
                <td>{formatDateShort(run.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function WebhookRow({
  webhook,
  testingId,
  expanded,
  onToggleDeliveries,
  onTest,
}: {
  webhook: Webhook;
  testingId: string | null;
  expanded: boolean;
  onToggleDeliveries: () => void;
  onTest: (webhook: Webhook) => void;
}) {
  return (
    <>
      <tr>
        <td><code>{truncateMiddle(webhook.id, 18)}</code></td>
        <td><strong>{webhook.name}</strong></td>
        <td><span className="monoValue">{truncateMiddle(webhook.url, 42)}</span></td>
        <td><ResourceBadge>{webhook.events.length} events</ResourceBadge></td>
        <td><StatusPill status={webhook.status} /></td>
        <td>{formatDateShort(webhook.updated_at)}</td>
        <td>
          <div className="rowActionGroup">
            <button className="ghostButton compactButton" type="button" onClick={onToggleDeliveries} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Deliveries
            </button>
            <button className="ghostButton compactButton" type="button" onClick={() => onTest(webhook)} disabled={testingId === webhook.id || webhook.status !== 'active'}>
              <Send size={14} /> {testingId === webhook.id ? 'Testing...' : 'Test'}
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="expansionRow">
          <td colSpan={7}><WebhookDeliveries webhookId={webhook.id} /></td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * One webhook's delivery records, fetched on expand. Each delivery carries
 * the published envelope `{ type: "event", id, created_at, data: { type, id,
 * vault_id? } }` — the resource row the event refers to lives in `data`.
 */
function WebhookDeliveries({ webhookId }: { webhookId: string }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson<{ data: WebhookDelivery[] } | WebhookDelivery[]>(`/v1/webhooks/${webhookId}/deliveries`)
      .then((page) => {
        if (!active) return;
        setDeliveries(Array.isArray(page) ? page : page.data ?? []);
      })
      .catch((err: any) => {
        if (active) setError(err?.message ?? 'Could not load deliveries');
      });
    return () => { active = false; };
  }, [webhookId]);

  if (error) return <div className="banner error inlineBanner" role="alert">{error}</div>;
  if (!deliveries) return <p className="mutedValue">Loading deliveries…</p>;
  if (deliveries.length === 0) return <p className="mutedValue">No deliveries recorded.</p>;

  return (
    <table className="deliveriesTable">
      <thead>
        <tr><th>Event</th><th>Subject</th><th>Status</th><th>Attempts</th><th>Created</th><th>Delivered</th></tr>
      </thead>
      <tbody>
        {deliveries.map((delivery) => {
          const envelope = delivery.payload ?? {};
          const subject = envelope.data;
          return (
            <tr key={delivery.id}>
              <td><code>{delivery.event}</code></td>
              <td>
                {subject?.type ? <code>{subject.type}</code> : <span className="mutedValue">-</span>}
                {subject?.id ? <code>{truncateMiddle(subject.id, 18)}</code> : null}
                {subject?.vault_id ? <code>{truncateMiddle(String(subject.vault_id), 14)}</code> : null}
              </td>
              <td>
                <StatusPill status={delivery.status} />
                {delivery.status_code !== null ? <small className="mutedValue"> {delivery.status_code}</small> : null}
                {delivery.error ? <small className="fieldError"> {delivery.error}</small> : null}
              </td>
              <td>{delivery.attempt_count}</td>
              <td>{envelope.created_at ? formatDateShort(envelope.created_at) : formatDateShort(delivery.created_at)}</td>
              <td>{delivery.delivered_at ? formatDateShort(delivery.delivered_at) : '-'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WebhookCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<ReadonlySet<string>>(new Set());
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleEvent = (eventName: string) => {
    setSelectedEvents((current) => {
      const next = new Set(current);
      if (next.has(eventName)) next.delete(eventName);
      else next.add(eventName);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson<Webhook>('/v1/webhooks', {
        name: name || undefined,
        url,
        description,
        // Selection order is catalog order, not click order, so a subscription
        // reads the same regardless of how the operator picked the events.
        events: WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events.filter((name) => selectedEvents.has(name))),
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not create webhook');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create webhook" onClose={onClose} size="medium">
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <label>
          <span>Endpoint URL <RequiredMark /></span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/managed-agents/webhook" required />
          <small>HTTPS endpoints, or http://localhost for a local receiver.</small>
        </label>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Production callback" />
        </label>
        <fieldset className="webhookEventPicker">
          <legend>Events <RequiredMark /></legend>
          {WEBHOOK_EVENT_GROUPS.map((group) => (
            <div className="webhookEventGroup" key={group.category}>
              <strong>{group.category}</strong>
              <div className="webhookEventOptions">
                {group.events.map((eventName) => (
                  <label className="checkboxLine" key={eventName}>
                    <input
                      type="checkbox"
                      checked={selectedEvents.has(eventName)}
                      onChange={() => toggleEvent(eventName)}
                    />
                    <code>{eventName}</code>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {selectedEvents.size === 0 ? <p className="fieldHint">Select at least one event. Wildcards are not part of the published catalog.</p> : null}
        </fieldset>
        <label>
          <span>Description</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={saving || !url.trim() || selectedEvents.size === 0}>{saving ? 'Creating...' : 'Create webhook'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduledDeploymentCreateModal({ data, onClose, onSaved }: { data: ConsoleData; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState(data.agents[0]?.id ?? '');
  const [environmentId, setEnvironmentId] = useState(data.environments[0]?.id ?? 'env_default');
  const [expression, setExpression] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // The published create shape: `schedule` is a cron object and
      // `initial_events` carries at least one `user.message` text event —
      // the flat `cron` field this form used to send is the legacy alias.
      await postJson<ScheduledDeployment>('/v1/scheduled-deployments', {
        name,
        agent_id: agentId,
        environment_id: environmentId || 'env_default',
        schedule: { type: 'cron', expression: expression.trim(), timezone: timezone.trim() || 'UTC' },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not create schedule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create scheduled deployment" onClose={onClose}>
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <label>
          <span>Name <RequiredMark /></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily review run" required />
        </label>
        <label>
          <span>Agent <RequiredMark /></span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
            {data.agents.length === 0 ? <option value="">No agents available</option> : null}
            {data.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label>
          <span>Environment <RequiredMark /></span>
          <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} required>
            <option value="env_default">Default</option>
            {data.environments.map((environment) => <option value={environment.id} key={environment.id}>{environment.name}</option>)}
          </select>
        </label>
        <label>
          <span>Cron expression <RequiredMark /></span>
          <input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder="0 9 * * *" required />
        </label>
        <label>
          <span>Timezone <RequiredMark /></span>
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="UTC" required />
          <small>An IANA zone name such as America/Los_Angeles; the schedule fires in this zone.</small>
        </label>
        <label>
          <span>Prompt <RequiredMark /></span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} spellCheck={false} placeholder="The user message each scheduled run starts the session with" required />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={saving || !name.trim() || !agentId || !expression.trim() || !timezone.trim() || !prompt.trim()}>{saving ? 'Creating...' : 'Create schedule'}</button>
        </div>
      </form>
    </Modal>
  );
}

function OutcomeCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [threshold, setThreshold] = useState('0.8');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson<Outcome>('/v1/outcomes', {
        name,
        objective,
        description,
        criteria: splitLines(criteria),
        pass_threshold: Number(threshold),
        evaluator: 'deterministic',
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not create outcome');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create outcome" onClose={onClose}>
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <label>
          <span>Name <RequiredMark /></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Deployment-quality response" required />
        </label>
        <label>
          <span>Objective <RequiredMark /></span>
          <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={3} required />
        </label>
        <label>
          <span>Criteria</span>
          <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={4} placeholder="One criterion per line" />
        </label>
        <label>
          <span>Pass threshold</span>
          <input value={threshold} onChange={(event) => setThreshold(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>Description</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={saving || !name.trim() || !objective.trim()}>{saving ? 'Creating...' : 'Create outcome'}</button>
        </div>
      </form>
    </Modal>
  );
}

function OperationNotice({ children }: { children: ReactNode }) {
  return (
    <div className="operationNotice" role="status">
      {children}
    </div>
  );
}

function OperationGuide({ items }: { items: Array<{ icon: ReactNode; title: string; body: string }> }) {
  return (
    <div className="operationGuideGrid">
      {items.map((item) => (
        <article className="operationGuideCard" key={item.title}>
          <span>{item.icon}</span>
          <div>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function SessionPicker({ sessions, selectedSessionId, onChange }: { sessions: Session[]; selectedSessionId: string; onChange: (value: string) => void }) {
  return (
    <label className="inlineSelectControl">
      <span>Evaluate session</span>
      <select value={selectedSessionId} onChange={(event) => onChange(event.target.value)} disabled={sessions.length === 0}>
        {sessions.length === 0 ? <option value="">No sessions</option> : null}
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.title || truncateMiddle(session.id, 18)}
          </option>
        ))}
      </select>
    </label>
  );
}

function splitLines(value: string) {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function parseJsonObject(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON payload must be an object');
  }
  return parsed;
}
