import { Activity, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, KeyRound, Pause, Pencil, Play, Plus, RadioTower, Send, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { deleteJson, getJson, postJson, putJson } from '../../api';
import type { ConsoleData, DeploymentRun, Outcome, ScheduledDeployment, Session, Webhook, WebhookDelivery } from '../../types';
import { RequiredMark } from '../Common';
import { ConfirmDeleteModal } from '../DangerZone';
import { Modal } from '../Modal';
import { ConsoleSelect } from '../console-select';
import { EmptyState, Kpi, KpiStrip, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { formatDateShort, truncateMiddle } from '../../lib/format';
import { WEBHOOK_EVENT_GROUPS } from '../../lib/webhook-events';
import './operations.css';

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

function statusTone(status: string): Tone {
  if (status === 'active' || status === 'delivered') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'pending' || status === 'retrying' || status === 'queued') return 'pending';
  return 'neutral';
}

export function WebhooksPage({ data, onRefresh }: OperationsPageProps) {
  const { t } = useTranslation('operations');
  const { t: tPages } = useTranslation('pages');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
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
      setMessage(t('webhooks.notice.tested', { id: truncateMiddle(delivery.id, 18), status: delivery.status_code ?? 'no' }));
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('webhooks.notice.testFailed'));
    } finally {
      setTestingId(null);
    }
  };

  const retryDue = async () => {
    setRetrying(true);
    setMessage('');
    try {
      const page = await postJson<{ data: WebhookDelivery[] }>('/v1/webhooks/retry-due', {});
      setMessage(t('webhooks.notice.retried', { n: page.data.length, count: page.data.length }));
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('webhooks.notice.retryFailed'));
    } finally {
      setRetrying(false);
    }
  };

  const empty = (
    <EmptyState
      icon={RadioTower}
      title={t('webhooks.empty')}
      description={t('webhooks.emptyBody')}
      action={<button className="button primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={15} />{t('webhooks.actions.create')}</button>}
    />
  );

  return (
    <section className="page-section console-page webhooks-list-page" aria-labelledby="webhooks-heading">
      <PageHeader
        headingId="webhooks-heading"
        title={tPages('webhooks.title')}
        help={t('webhooks.description')}
        actions={(
          <>
            <button className="button outline" type="button" onClick={() => void retryDue()} disabled={retrying || data.webhooks.length === 0}>
              <Send size={15} aria-hidden="true" /> {retrying ? t('webhooks.actions.retrying') : t('webhooks.actions.retryDue')}
            </button>
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />{t('webhooks.actions.create')}
            </button>
          </>
        )}
      />
      <PageBody>
        <KpiStrip label={tPages('webhooks.title')}>
          <Kpi label={t('webhooks.kpis.subscriptions')} value={data.webhooks.length} />
          <Kpi label={t('webhooks.kpis.active')} value={data.webhooks.filter((item) => item.status === 'active').length} />
          <Kpi label={t('webhooks.kpis.eventBindings')} value={data.webhooks.reduce((total, item) => total + item.events.length, 0)} />
        </KpiStrip>
        {data.webhooks.length ? (
          <div className="table-frame webhooks-table-frame">
            <table className="data-table" aria-label={tPages('webhooks.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('webhooks.columns.id')}</th>
                  <th scope="col">{t('webhooks.columns.name')}</th>
                  <th scope="col">{t('webhooks.columns.url')}</th>
                  <th scope="col">{t('webhooks.columns.events')}</th>
                  <th scope="col">{t('webhooks.columns.status')}</th>
                  <th scope="col">{t('webhooks.columns.updated')}</th>
                  <th scope="col" className="actionsCol"><span className="visually-hidden">{t('webhooks.columns.action')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.webhooks.map((webhook) => (
                  <WebhookRow
                    key={webhook.id}
                    webhook={webhook}
                    testingId={testingId}
                    expanded={deliveriesId === webhook.id}
                    onToggleDeliveries={() => setDeliveriesId((current) => current === webhook.id ? null : webhook.id)}
                    onTest={testWebhook}
                    onEdit={() => setEditing(webhook)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : empty}
        <div className="mobileResourceList">
          {data.webhooks.map((webhook) => (
            <article className="mobileResourceCard" key={webhook.id}>
              <span className="mobileAgentMain">
                <strong>{webhook.name}</strong>
                <small className="monoText">{truncateMiddle(webhook.url, 42)}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{t('webhooks.mobileEvents', { n: webhook.events.length, count: webhook.events.length })}</span>
                <StatusDot tone={statusTone(webhook.status)} label={webhook.status} />
              </span>
              <button className="button ghost" type="button" onClick={() => void testWebhook(webhook)} disabled={testingId === webhook.id || webhook.status !== 'active'}>
                <Send size={14} aria-hidden="true" /> {testingId === webhook.id ? t('webhooks.actions.testing') : t('webhooks.actions.test')}
              </button>
              <button className="button ghost" type="button" onClick={() => setEditing(webhook)}>
                <Pencil size={14} aria-hidden="true" /> {t('webhooks.actions.edit')}
              </button>
            </article>
          ))}
          {data.webhooks.length === 0 ? empty : null}
        </div>
        {message ? <OperationNotice>{message}</OperationNotice> : null}
      </PageBody>
      {createOpen ? (
        <WebhookCreateModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      ) : null}
      {editing ? (
        <WebhookEditModal
          webhook={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onRefresh();
          }}
          onChanged={onRefresh}
        />
      ) : null}
    </section>
  );
}

export function ScheduledDeploymentsPage({ data, onRefresh }: OperationsPageProps) {
  const { t } = useTranslation('operations');
  const { t: tPages } = useTranslation('pages');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningDue, setRunningDue] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledDeployment | null>(null);
  const [deleting, setDeleting] = useState<ScheduledDeployment | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);
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
        ? t('scheduled.notice.ranSession', { id: truncateMiddle(run.id, 18), session: truncateMiddle(run.session_id, 18) })
        : t('scheduled.notice.ranFailed', { id: truncateMiddle(run.id, 18), error: run.error?.message ?? 'unknown error' }));
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('scheduled.notice.runFailed'));
    } finally {
      setRunningId(null);
    }
  };

  const runDueSchedules = async () => {
    setRunningDue(true);
    setMessage('');
    try {
      const page = await postJson<{ data: ScheduledDeploymentRun[] }>('/v1/scheduled-deployments/run-due', {});
      setMessage(t('scheduled.notice.ranDue', { n: page.data.length, count: page.data.length }));
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('scheduled.notice.runDueFailed'));
    } finally {
      setRunningDue(false);
    }
  };

  // Pause/unpause are dedicated routes rather than a status field on the
  // update verb — they publish the pause transition event the published
  // vocabulary assigns to them.
  const togglePause = async (schedule: ScheduledDeployment) => {
    setPausingId(schedule.id);
    setMessage('');
    try {
      await postJson(`/v1/scheduled-deployments/${encodeURIComponent(schedule.id)}/${schedule.status === 'paused' ? 'unpause' : 'pause'}`, {});
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('scheduled.notice.pauseFailed'));
    } finally {
      setPausingId(null);
    }
  };

  const empty = (
    <EmptyState
      icon={CalendarClock}
      title={t('scheduled.empty')}
      description={t('scheduled.emptyBody')}
      action={<button className="button primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={15} />{t('scheduled.actions.create')}</button>}
    />
  );

  return (
    <section className="page-section console-page schedules-list-page" aria-labelledby="schedules-heading">
      <PageHeader
        headingId="schedules-heading"
        title={tPages('scheduled-deployments.title')}
        help={t('scheduled.description')}
        actions={(
          <>
            <button className="button outline" type="button" onClick={() => void runDueSchedules()} disabled={runningDue || data.scheduledDeployments.length === 0}>
              <Play size={15} aria-hidden="true" /> {runningDue ? t('scheduled.actions.runningDue') : t('scheduled.actions.runDue')}
            </button>
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />{t('scheduled.actions.create')}
            </button>
          </>
        )}
      />
      <PageBody>
        <KpiStrip label={tPages('scheduled-deployments.title')}>
          <Kpi label={t('scheduled.kpis.schedules')} value={data.scheduledDeployments.length} />
          <Kpi label={t('scheduled.kpis.active')} value={data.scheduledDeployments.filter((item) => item.status === 'active').length} />
          <Kpi label={t('scheduled.kpis.dueCandidates')} value={data.scheduledDeployments.filter((item) => item.status === 'active' && item.schedule?.upcoming_runs_at?.[0]).length} />
        </KpiStrip>
        {data.scheduledDeployments.length ? (
          <div className="table-frame schedules-table-frame">
            <table className="data-table" aria-label={tPages('scheduled-deployments.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('scheduled.columns.id')}</th>
                  <th scope="col">{t('scheduled.columns.name')}</th>
                  <th scope="col">{t('scheduled.columns.agent')}</th>
                  <th scope="col">{t('scheduled.columns.environment')}</th>
                  <th scope="col">{t('scheduled.columns.cron')}</th>
                  <th scope="col">{t('scheduled.columns.status')}</th>
                  <th scope="col">{t('scheduled.columns.nextRun')}</th>
                  <th scope="col" className="actionsCol"><span className="visually-hidden">{t('scheduled.columns.action')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.scheduledDeployments.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    runningId={runningId}
                    expanded={runsId === schedule.id}
                    onToggleRuns={() => setRunsId((current) => current === schedule.id ? null : schedule.id)}
                    onRun={runSchedule}
                    pausingId={pausingId}
                    onTogglePause={togglePause}
                    onEdit={() => setEditing(schedule)}
                    onDelete={() => setDeleting(schedule)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : empty}
        <div className="mobileResourceList">
          {data.scheduledDeployments.map((schedule) => (
            <article className="mobileResourceCard" key={schedule.id}>
              <span className="mobileAgentMain">
                <strong>{schedule.name}</strong>
                <small className="monoText">{schedule.schedule?.expression ?? t('scheduled.runsTable.manual')}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{schedule.schedule?.upcoming_runs_at?.[0] ? t('scheduled.mobileNext', { time: formatDateShort(schedule.schedule.upcoming_runs_at[0]) }) : t('scheduled.mobileNoNext')}</span>
                <StatusDot tone={statusTone(schedule.status)} label={schedule.status} />
              </span>
              <button className="button ghost" type="button" onClick={() => void runSchedule(schedule)} disabled={runningId === schedule.id || schedule.status !== 'active'}>
                <Play size={14} aria-hidden="true" /> {runningId === schedule.id ? t('scheduled.actions.running') : t('scheduled.actions.runNow')}
              </button>
              <button className="button ghost" type="button" onClick={() => void togglePause(schedule)} disabled={pausingId === schedule.id}>
                <Pause size={14} aria-hidden="true" /> {schedule.status === 'paused' ? t('scheduled.actions.resume') : t('scheduled.actions.pause')}
              </button>
              <button className="button ghost" type="button" onClick={() => setEditing(schedule)}>
                <Pencil size={14} aria-hidden="true" /> {t('scheduled.actions.edit')}
              </button>
              <button className="button ghost" type="button" onClick={() => setDeleting(schedule)}>
                <Trash2 size={14} aria-hidden="true" /> {t('scheduled.actions.delete')}
              </button>
            </article>
          ))}
          {data.scheduledDeployments.length === 0 ? empty : null}
        </div>
        {message ? <OperationNotice>{message}</OperationNotice> : null}
      </PageBody>
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
      {editing ? (
        <ScheduledDeploymentEditModal
          data={data}
          deployment={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onRefresh();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDeleteModal
          title={t('scheduled.delete.title')}
          subject={deleting.name || deleting.id}
          consequence={t('scheduled.delete.consequence')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteJson(`/v1/scheduled-deployments/${encodeURIComponent(deleting.id)}`);
            setDeleting(null);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

export function OutcomesPage({ data, onRefresh }: OperationsPageProps) {
  const { t } = useTranslation('operations');
  const { t: tPages } = useTranslation('pages');
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
      setMessage(t('outcomes.notice.needSession'));
      return;
    }
    setEvaluatingId(outcome.id);
    setMessage('');
    try {
      const result = await postJson<SessionOutcome>(`/v1/sessions/${selectedSessionId}/outcomes/evaluate`, {
        outcome_id: outcome.id,
      });
      setMessage(t('outcomes.notice.evaluated', {
        id: truncateMiddle(result.id, 18),
        status: result.status,
        score: typeof result.score === 'number' ? t('outcomes.notice.scorePart', { pct: Math.round(result.score * 100) }) : '',
      }));
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('outcomes.notice.failed'));
    } finally {
      setEvaluatingId(null);
    }
  };

  const empty = (
    <EmptyState
      icon={CheckCircle2}
      title={t('outcomes.empty')}
      description={t('outcomes.emptyBody')}
      action={<button className="button primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={15} />{t('outcomes.actions.create')}</button>}
    />
  );

  return (
    <section className="page-section console-page outcomes-list-page" aria-labelledby="outcomes-heading">
      <PageHeader
        headingId="outcomes-heading"
        title={tPages('outcomes.title')}
        actions={(
          <>
            <SessionPicker sessions={data.sessions} selectedSessionId={selectedSessionId} onChange={setSelectedSessionId} />
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />{t('outcomes.actions.create')}
            </button>
          </>
        )}
      />
      <PageBody>
        <p className="console-page-description">
          <Trans i18nKey="outcomes.description" ns="operations" components={{ code: <code /> }} />
        </p>
        <KpiStrip label={tPages('outcomes.title')}>
          <Kpi label={t('outcomes.kpis.definitions')} value={data.outcomes.length} />
          <Kpi label={t('outcomes.kpis.active')} value={data.outcomes.filter((item) => item.status === 'active').length} />
          <Kpi label={t('outcomes.kpis.sessionsAvailable')} value={data.sessions.length} />
        </KpiStrip>
        {data.outcomes.length ? (
          <div className="table-frame outcomes-table-frame">
            <table className="data-table" aria-label={tPages('outcomes.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('outcomes.columns.id')}</th>
                  <th scope="col">{t('outcomes.columns.name')}</th>
                  <th scope="col">{t('outcomes.columns.objective')}</th>
                  <th scope="col">{t('outcomes.columns.criteria')}</th>
                  <th scope="col">{t('outcomes.columns.threshold')}</th>
                  <th scope="col">{t('outcomes.columns.status')}</th>
                  <th scope="col">{t('outcomes.columns.updated')}</th>
                  <th scope="col" className="actionsCol"><span className="visually-hidden">{t('outcomes.columns.action')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.outcomes.map((outcome) => (
                  <tr key={outcome.id}>
                    <td><strong className="monoText">{truncateMiddle(outcome.id, 18)}</strong></td>
                    <td><strong>{outcome.name}</strong></td>
                    <td>{outcome.objective}</td>
                    <td><span className="softChip inlineChip">{t('outcomes.criteriaCount', { n: outcome.criteria.length, count: outcome.criteria.length })}</span></td>
                    <td><span className="softChip inlineChip">{t('outcomes.thresholdBadge', { pct: Math.round((outcome.pass_threshold ?? 0.75) * 100), evaluator: outcome.evaluator ?? 'deterministic' })}</span></td>
                    <td><StatusDot tone={statusTone(outcome.status)} label={outcome.status} /></td>
                    <td>{formatDateShort(outcome.updated_at)}</td>
                    <td className="actionsCol">
                      <button className="button ghost" type="button" onClick={() => void evaluateOutcome(outcome)} disabled={evaluatingId === outcome.id || outcome.status !== 'active' || !selectedSessionId}>
                        <CheckCircle2 size={14} aria-hidden="true" /> {evaluatingId === outcome.id ? t('outcomes.actions.evaluating') : t('outcomes.actions.evaluate')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : empty}
        <div className="mobileResourceList">
          {data.outcomes.map((outcome) => (
            <article className="mobileResourceCard" key={outcome.id}>
              <span className="mobileAgentMain">
                <strong>{outcome.name}</strong>
                <small>{outcome.objective}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{t('outcomes.thresholdBadge', { pct: Math.round((outcome.pass_threshold ?? 0.75) * 100), evaluator: outcome.evaluator ?? 'deterministic' })}</span>
                <StatusDot tone={statusTone(outcome.status)} label={outcome.status} />
              </span>
              <button className="button ghost" type="button" onClick={() => void evaluateOutcome(outcome)} disabled={evaluatingId === outcome.id || outcome.status !== 'active' || !selectedSessionId}>
                <CheckCircle2 size={14} aria-hidden="true" /> {evaluatingId === outcome.id ? t('outcomes.actions.evaluating') : t('outcomes.actions.evaluate')}
              </button>
            </article>
          ))}
          {data.outcomes.length === 0 ? empty : null}
        </div>
        {message ? <OperationNotice>{message}</OperationNotice> : null}
      </PageBody>
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
  pausingId,
  onToggleRuns,
  onRun,
  onTogglePause,
  onEdit,
  onDelete,
}: {
  schedule: ScheduledDeployment;
  runningId: string | null;
  expanded: boolean;
  pausingId: string | null;
  onToggleRuns: () => void;
  onRun: (schedule: ScheduledDeployment) => void;
  onTogglePause: (schedule: ScheduledDeployment) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('operations');
  return (
    <>
      <tr>
        <td><strong className="monoText">{truncateMiddle(schedule.id, 18)}</strong></td>
        <td><strong>{schedule.name}</strong></td>
        <td><span className="monoText">{truncateMiddle(schedule.agent.id, 20)}</span></td>
        <td>{schedule.environment_id ? <span className="monoText">{truncateMiddle(schedule.environment_id, 18)}</span> : <span className="mutedValue">{t('scheduled.runsTable.defaultEnvironment')}</span>}</td>
        <td><span className="monoValue">{schedule.schedule?.expression ?? t('scheduled.runsTable.manual')}</span></td>
        <td><StatusDot tone={statusTone(schedule.status)} label={schedule.status} /></td>
        <td>{schedule.schedule?.upcoming_runs_at?.[0] ? formatDateShort(schedule.schedule.upcoming_runs_at[0]) : '-'}</td>
        <td className="actionsCol">
          <div className="rowActionGroup">
            <button className="button ghost" type="button" onClick={onToggleRuns} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} {t('scheduled.actions.runs')}
            </button>
            <button className="button ghost" type="button" onClick={() => onRun(schedule)} disabled={runningId === schedule.id || schedule.status !== 'active'}>
              <Play size={14} aria-hidden="true" /> {runningId === schedule.id ? t('scheduled.actions.running') : t('scheduled.actions.runNow')}
            </button>
            <button className="button ghost" type="button" onClick={() => onTogglePause(schedule)} disabled={pausingId === schedule.id}>
              <Pause size={14} aria-hidden="true" /> {schedule.status === 'paused' ? t('scheduled.actions.resume') : t('scheduled.actions.pause')}
            </button>
            <button className="button ghost" type="button" onClick={onEdit}>
              <Pencil size={14} aria-hidden="true" /> {t('scheduled.actions.edit')}
            </button>
            <button className="button ghost" type="button" onClick={onDelete}>
              <Trash2 size={14} aria-hidden="true" /> {t('scheduled.actions.delete')}
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
  const { t } = useTranslation('operations');
  const [runs, setRuns] = useState<DeploymentRun[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson<{ data: DeploymentRun[] } | DeploymentRun[]>(`/v1/deployment_runs?deployment_id=${encodeURIComponent(schedule.id)}`)
      .then((page) => {
        if (!active) return;
        setRuns(Array.isArray(page) ? page : page.data ?? []);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : t('scheduled.runsTable.loadError'));
      });
    return () => { active = false; };
  }, [schedule.id, t]);

  const upcoming = schedule.schedule?.upcoming_runs_at ?? [];

  return (
    <div className="deploymentRunsPanel">
      {upcoming.length > 0 ? (
        <p className="mutedValue">
          {schedule.schedule?.timezone
            ? t('scheduled.runsTable.upcoming', { list: upcoming.map((at) => formatDateShort(at)).join(' · '), timezone: schedule.schedule.timezone })
            : t('scheduled.runsTable.upcomingNoTz', { list: upcoming.map((at) => formatDateShort(at)).join(' · ') })}
        </p>
      ) : null}
      {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
      {!error && runs === null ? <p className="mutedValue">{t('scheduled.runsTable.loading')}</p> : null}
      {runs && runs.length === 0 ? <p className="mutedValue">{t('scheduled.runsTable.empty')}</p> : null}
      {runs && runs.length > 0 ? (
        <table className="deliveriesTable">
          <thead>
            <tr>
              <th scope="col">{t('scheduled.runsTable.run')}</th>
              <th scope="col">{t('scheduled.runsTable.trigger')}</th>
              <th scope="col">{t('scheduled.runsTable.session')}</th>
              <th scope="col">{t('scheduled.runsTable.error')}</th>
              <th scope="col">{t('scheduled.runsTable.started')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td><span className="monoText">{truncateMiddle(run.id, 18)}</span></td>
                <td>
                  <span className="monoText">{run.trigger_context?.type ?? '-'}</span>
                  {run.trigger_context?.scheduled_at ? <small className="mutedValue"> {t('scheduled.runsTable.due', { time: formatDateShort(run.trigger_context.scheduled_at) })}</small> : null}
                </td>
                <td>{run.session_id ? <span className="monoText">{truncateMiddle(run.session_id, 18)}</span> : <span className="mutedValue">-</span>}</td>
                <td>{run.error ? <span className="fieldError"><span className="monoText">{run.error.type}</span> {run.error.message}</span> : <span className="mutedValue">-</span>}</td>
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
  onEdit,
}: {
  webhook: Webhook;
  testingId: string | null;
  expanded: boolean;
  onToggleDeliveries: () => void;
  onTest: (webhook: Webhook) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation('operations');
  return (
    <>
      <tr>
        <td><strong className="monoText">{truncateMiddle(webhook.id, 18)}</strong></td>
        <td><strong>{webhook.name}</strong></td>
        <td><span className="monoValue">{truncateMiddle(webhook.url, 42)}</span></td>
        <td><span className="softChip inlineChip">{t('webhooks.mobileEvents', { n: webhook.events.length, count: webhook.events.length })}</span></td>
        <td><StatusDot tone={statusTone(webhook.status)} label={webhook.status} /></td>
        <td>{formatDateShort(webhook.updated_at)}</td>
        <td className="actionsCol">
          <div className="rowActionGroup">
            <button className="button ghost" type="button" onClick={onToggleDeliveries} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} {t('webhooks.actions.deliveries')}
            </button>
            <button className="button ghost" type="button" onClick={() => onTest(webhook)} disabled={testingId === webhook.id || webhook.status !== 'active'}>
              <Send size={14} aria-hidden="true" /> {testingId === webhook.id ? t('webhooks.actions.testing') : t('webhooks.actions.test')}
            </button>
            <button className="button ghost" type="button" onClick={onEdit}>
              <Pencil size={14} aria-hidden="true" /> {t('webhooks.actions.edit')}
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
  const { t } = useTranslation('operations');
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getJson<{ data: WebhookDelivery[] } | WebhookDelivery[]>(`/v1/webhooks/${webhookId}/deliveries`)
      .then((page) => {
        if (!active) return;
        setDeliveries(Array.isArray(page) ? page : page.data ?? []);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : t('webhooks.deliveriesTable.loadError'));
      });
    return () => { active = false; };
  }, [webhookId, t]);

  if (error) return <div className="banner error inlineBanner" role="alert">{error}</div>;
  if (!deliveries) return <p className="mutedValue">{t('webhooks.deliveriesTable.loading')}</p>;
  if (deliveries.length === 0) return <p className="mutedValue">{t('webhooks.deliveriesTable.empty')}</p>;

  return (
    <table className="deliveriesTable">
      <thead>
        <tr>
          <th scope="col">{t('webhooks.deliveriesTable.event')}</th>
          <th scope="col">{t('webhooks.deliveriesTable.subject')}</th>
          <th scope="col">{t('webhooks.deliveriesTable.status')}</th>
          <th scope="col">{t('webhooks.deliveriesTable.attempts')}</th>
          <th scope="col">{t('webhooks.deliveriesTable.created')}</th>
          <th scope="col">{t('webhooks.deliveriesTable.delivered')}</th>
        </tr>
      </thead>
      <tbody>
        {deliveries.map((delivery) => {
          const envelope = delivery.payload ?? {};
          const subject = envelope.data;
          return (
            <tr key={delivery.id}>
              <td><span className="monoText">{delivery.event}</span></td>
              <td>
                {subject?.type ? <span className="monoText">{subject.type}</span> : <span className="mutedValue">-</span>}
                {subject?.id ? <span className="monoText"> {truncateMiddle(subject.id, 18)}</span> : null}
                {subject?.vault_id ? <span className="monoText"> {truncateMiddle(String(subject.vault_id), 14)}</span> : null}
              </td>
              <td>
                <StatusDot tone={statusTone(delivery.status)} label={delivery.status} />
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
  const { t } = useTranslation('operations');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webhooks.create.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('webhooks.create.title')} onClose={onClose} size="medium">
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('webhooks.create.url')} <RequiredMark />
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('webhooks.create.urlPlaceholder')} required />
          <small>{t('webhooks.create.urlHint')}</small>
        </label>
        <label className="editField">
          {t('webhooks.create.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('webhooks.create.namePlaceholder')} />
        </label>
        <fieldset className="webhookEventPicker">
          <legend>{t('webhooks.create.events')} <RequiredMark /></legend>
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
          {selectedEvents.size === 0 ? <p className="fieldHint">{t('webhooks.create.eventsHint')}</p> : null}
        </fieldset>
        <label className="editField">
          {t('webhooks.create.description')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('webhooks.create.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !url.trim() || selectedEvents.size === 0}>{saving ? t('webhooks.create.submitting') : t('webhooks.create.submit')}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Edit a webhook subscription and manage its signing secret. `status` accepts
 * exactly `active`/`disabled` — re-enabling is the published remedy for an
 * endpoint disabled by sustained failures, and clears its reason and failure
 * window server-side. `rotate-secret` answers the new `secret_key` once and
 * never again, so the response is displayed rather than discarded; both
 * secret actions arm first and confirm on a second click.
 */
function WebhookEditModal({
  webhook,
  onClose,
  onSaved,
  onChanged,
}: {
  webhook: Webhook;
  onClose: () => void;
  onSaved: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('operations');
  const [name, setName] = useState(webhook.name);
  const [url, setUrl] = useState(webhook.url);
  const [selectedEvents, setSelectedEvents] = useState<ReadonlySet<string>>(() => new Set(webhook.events));
  const [description, setDescription] = useState(webhook.description);
  const [status, setStatus] = useState(webhook.status === 'disabled' ? 'disabled' : 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState('');
  const [armedAction, setArmedAction] = useState<'rotate' | 'retire' | null>(null);
  const [newSecret, setNewSecret] = useState('');

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
      await putJson<Webhook>(`/v1/webhooks/${encodeURIComponent(webhook.id)}`, {
        name: name || undefined,
        url,
        description,
        events: WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events.filter((name) => selectedEvents.has(name))),
        status,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webhooks.edit.failed'));
    } finally {
      setSaving(false);
    }
  };

  const secretAction = async (action: 'rotate' | 'retire') => {
    if (armedAction !== action) {
      setArmedAction(action);
      return;
    }
    setSecretBusy(true);
    setSecretError('');
    setArmedAction(null);
    try {
      const updated = await postJson<Webhook & { secret_key?: string }>(
        `/v1/webhooks/${encodeURIComponent(webhook.id)}/${action === 'rotate' ? 'rotate-secret' : 'retire-secret'}`,
        {},
      );
      // The rotated secret is shown once in this dialog, so a successful
      // rotate must refresh the row without closing — `onSaved` would take the
      // secret down with the modal.
      if (action === 'rotate' && updated.secret_key) setNewSecret(updated.secret_key);
      onChanged();
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : String(err));
    } finally {
      setSecretBusy(false);
    }
  };

  return (
    <Modal title={t('webhooks.edit.title')} subtitle={webhook.id} onClose={onClose} size="medium">
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('webhooks.create.url')} <RequiredMark />
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('webhooks.create.urlPlaceholder')} required />
          <small>{t('webhooks.create.urlHint')}</small>
        </label>
        <label className="editField">
          {t('webhooks.create.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('webhooks.create.namePlaceholder')} />
        </label>
        <fieldset className="webhookEventPicker">
          <legend>{t('webhooks.create.events')} <RequiredMark /></legend>
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
          {selectedEvents.size === 0 ? <p className="fieldHint">{t('webhooks.create.eventsHint')}</p> : null}
        </fieldset>
        <label className="editField">
          {t('webhooks.create.description')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </label>
        <label className="editField">
          {t('webhooks.edit.status')}
          <ConsoleSelect
            label={t('webhooks.edit.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: t('webhooks.edit.statusActive') },
              { value: 'disabled', label: t('webhooks.edit.statusDisabled') },
            ]}
          />
          <small>{t('webhooks.edit.statusHint')}</small>
        </label>

        <fieldset className="webhookEventPicker">
          <legend>{t('webhooks.edit.secretTitle')}</legend>
          <p className="fieldHint">{t('webhooks.edit.secretHint')}</p>
          {newSecret ? (
            <div className="banner success inlineBanner">
              <strong>{t('webhooks.edit.secretShownOnce')}</strong>
              <code className="monoValue">{newSecret}</code>
            </div>
          ) : null}
          {secretError ? <div className="banner error inlineBanner">{secretError}</div> : null}
          <div className="rowActionGroup">
            <button
              className={`button ${armedAction === 'rotate' ? 'primary' : 'outline'}`}
              type="button"
              disabled={secretBusy}
              onClick={() => void secretAction('rotate')}
            >
              <KeyRound size={14} aria-hidden="true" /> {armedAction === 'rotate' ? t('webhooks.edit.rotateConfirm') : t('webhooks.edit.rotate')}
            </button>
            <button
              className={`button ${armedAction === 'retire' ? 'danger' : 'outline'}`}
              type="button"
              disabled={secretBusy}
              onClick={() => void secretAction('retire')}
            >
              {armedAction === 'retire' ? t('webhooks.edit.retireConfirm') : t('webhooks.edit.retire')}
            </button>
          </div>
        </fieldset>

        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('webhooks.create.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !url.trim() || selectedEvents.size === 0}>{saving ? t('webhooks.edit.submitting') : t('webhooks.edit.submit')}</button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduledDeploymentCreateModal({ data, onClose, onSaved }: { data: ConsoleData; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('operations');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scheduled.create.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('scheduled.create.title')} onClose={onClose}>
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('scheduled.create.name')} <RequiredMark />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('scheduled.create.namePlaceholder')} required />
        </label>
        <div className="editField">
          <span>{t('scheduled.create.agent')} <RequiredMark /></span>
          <ConsoleSelect
            label={t('scheduled.create.agent')}
            value={agentId}
            onChange={setAgentId}
            options={data.agents.length === 0
              ? [{ value: '', label: t('scheduled.create.noAgents') }]
              : data.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          />
        </div>
        <div className="editField">
          <span>{t('scheduled.create.environment')} <RequiredMark /></span>
          <ConsoleSelect
            label={t('scheduled.create.environment')}
            value={environmentId}
            onChange={setEnvironmentId}
            options={[
              { value: 'env_default', label: t('scheduled.create.defaultEnvironment') },
              ...data.environments.map((environment) => ({ value: environment.id, label: environment.name })),
            ]}
          />
        </div>
        <label className="editField">
          {t('scheduled.create.cron')} <RequiredMark />
          <input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder={t('scheduled.create.cronPlaceholder')} required />
        </label>
        <label className="editField">
          {t('scheduled.create.timezone')} <RequiredMark />
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder={t('scheduled.create.timezonePlaceholder')} required />
          <small>{t('scheduled.create.timezoneHint')}</small>
        </label>
        <label className="editField">
          {t('scheduled.create.prompt')} <RequiredMark />
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} spellCheck={false} placeholder={t('scheduled.create.promptPlaceholder')} required />
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('scheduled.create.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !name.trim() || !agentId || !expression.trim() || !timezone.trim() || !prompt.trim()}>{saving ? t('scheduled.create.submitting') : t('scheduled.create.submit')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Pull the editable prompt text out of a stored `user.message` initial event. */
function deploymentPrompt(initialEvents: unknown[]): string {
  const first = initialEvents.find(
    (event): event is { type: string; content: Array<{ type: string; text?: string }> } =>
      typeof event === 'object' && event !== null && (event as { type?: string }).type === 'user.message'
        && Array.isArray((event as { content?: unknown }).content),
  );
  return first?.content.find((block) => block.type === 'text')?.text ?? '';
}

/**
 * Edit a scheduled deployment through the published update verb. An empty
 * cron expression sends `schedule: null` — the published path back to a
 * manual-only deployment — while a filled one submits the cron object the
 * create route accepts. The prompt edits the first `user.message` initial
 * event; deployments whose initial events hold other shapes keep them by
 * omission.
 */
function ScheduledDeploymentEditModal({
  data,
  deployment,
  onClose,
  onSaved,
}: {
  data: ConsoleData;
  deployment: ScheduledDeployment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('operations');
  const [name, setName] = useState(deployment.name);
  const [description, setDescription] = useState(deployment.description ?? '');
  const [agentId, setAgentId] = useState(deployment.agent.id);
  const [environmentId, setEnvironmentId] = useState(deployment.environment_id ?? 'env_default');
  const [expression, setExpression] = useState(deployment.schedule?.expression ?? '');
  const [timezone, setTimezone] = useState(deployment.schedule?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const [prompt, setPrompt] = useState(() => deploymentPrompt(deployment.initial_events));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        name,
        description,
        agent_id: agentId,
        environment_id: environmentId || 'env_default',
        schedule: expression.trim()
          ? { type: 'cron', expression: expression.trim(), timezone: timezone.trim() || 'UTC' }
          : null,
      };
      if (prompt.trim()) {
        body.initial_events = [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }];
      }
      await putJson<ScheduledDeployment>(`/v1/scheduled-deployments/${encodeURIComponent(deployment.id)}`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scheduled.edit.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('scheduled.edit.title')} subtitle={deployment.id} onClose={onClose}>
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('scheduled.create.name')} <RequiredMark />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('scheduled.create.namePlaceholder')} required />
        </label>
        <label className="editField">
          {t('scheduled.create.description')}
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="editField">
          <span>{t('scheduled.create.agent')} <RequiredMark /></span>
          <ConsoleSelect
            label={t('scheduled.create.agent')}
            value={agentId}
            onChange={setAgentId}
            options={data.agents.length === 0
              ? [{ value: '', label: t('scheduled.create.noAgents') }]
              : data.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          />
        </div>
        <div className="editField">
          <span>{t('scheduled.create.environment')} <RequiredMark /></span>
          <ConsoleSelect
            label={t('scheduled.create.environment')}
            value={environmentId}
            onChange={setEnvironmentId}
            options={[
              { value: 'env_default', label: t('scheduled.create.defaultEnvironment') },
              ...data.environments.map((environment) => ({ value: environment.id, label: environment.name })),
            ]}
          />
        </div>
        <label className="editField">
          {t('scheduled.edit.cron')}
          <input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder={t('scheduled.create.cronPlaceholder')} />
          <small>{t('scheduled.edit.cronHint')}</small>
        </label>
        <label className="editField">
          {t('scheduled.create.timezone')} <RequiredMark />
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder={t('scheduled.create.timezonePlaceholder')} required />
          <small>{t('scheduled.create.timezoneHint')}</small>
        </label>
        <label className="editField">
          {t('scheduled.create.prompt')}
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} spellCheck={false} placeholder={t('scheduled.create.promptPlaceholder')} />
          <small>{t('scheduled.edit.promptHint')}</small>
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('scheduled.create.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !name.trim() || !agentId || !timezone.trim()}>{saving ? t('scheduled.edit.submitting') : t('scheduled.edit.submit')}</button>
        </div>
      </form>
    </Modal>
  );
}

function OutcomeCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('operations');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t('outcomes.create.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('outcomes.create.title')} onClose={onClose}>
      <form className="modalForm operationCreateForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('outcomes.create.name')} <RequiredMark />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('outcomes.create.namePlaceholder')} required />
        </label>
        <label className="editField">
          {t('outcomes.create.objective')} <RequiredMark />
          <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={3} required />
        </label>
        <label className="editField">
          {t('outcomes.create.criteria')}
          <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={4} placeholder={t('outcomes.create.criteriaPlaceholder')} />
        </label>
        <label className="editField">
          {t('outcomes.create.threshold')}
          <input value={threshold} onChange={(event) => setThreshold(event.target.value)} inputMode="decimal" />
        </label>
        <label className="editField">
          {t('outcomes.create.description')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('outcomes.create.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !name.trim() || !objective.trim()}>{saving ? t('outcomes.create.submitting') : t('outcomes.create.submit')}</button>
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

function SessionPicker({ sessions, selectedSessionId, onChange }: { sessions: Session[]; selectedSessionId: string; onChange: (value: string) => void }) {
  const { t } = useTranslation('operations');
  return (
    <span className="inlineSelectControl">
      <ConsoleSelect
        label={t('outcomes.evaluateSession')}
        value={selectedSessionId}
        onChange={onChange}
        options={sessions.length === 0
          ? [{ value: '', label: t('outcomes.noSessions') }]
          : sessions.map((session) => ({ value: session.id, label: session.title || truncateMiddle(session.id, 18) }))}
      />
    </span>
  );
}

function splitLines(value: string) {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
