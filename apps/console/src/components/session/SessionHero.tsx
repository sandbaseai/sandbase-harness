import { Archive, ChevronDown, Clock, Cloud, Cpu, Monitor, Paperclip, PauseCircle, Settings, Square, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceBadge } from '../Common';
import { StatusDot, type Tone } from '../console-ui';
import { formatDuration, relativeDate, shortId } from '../../lib/format';
import type { Agent, Session } from '../../types';
import type { SessionDisplayStatus } from './conversation';

export type SessionUsageReceipt = {
  inputTokens: number;
  outputTokens: number;
  /** List cost amount in cents, when the runtime reports one. */
  costAmount?: string;
  costCurrency?: string;
};

function statusTone(displayStatus: SessionDisplayStatus): Tone {
  if (displayStatus === 'running') return 'ok';
  if (displayStatus === 'awaiting_action' || displayStatus === 'rescheduling') return 'warning';
  return 'neutral';
}

/**
 * The session header: breadcrumb, title/status pill, agent and environment
 * badges, and the Actions menu (settings, define outcome, resources,
 * interrupt, archive, delete). While a turn is live the run-state strip below keeps the one
 * action that matters — Interrupt — resident instead of buried in the menu.
 */
export function SessionHero({
  session,
  displayStatus,
  agent,
  environmentName,
  usage,
  onBack,
  onOpenAgent,
  onSettings,
  onDefineOutcome,
  onResources,
  onInterrupt,
  onArchive,
  onDelete,
}: {
  session: Session;
  displayStatus: SessionDisplayStatus;
  agent: Agent | undefined;
  environmentName?: string;
  usage?: SessionUsageReceipt;
  onBack: () => void;
  onOpenAgent: (agent: Agent) => void;
  onSettings: () => void;
  onDefineOutcome: () => void;
  onResources: () => void;
  onInterrupt: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('sessions');
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <>
      <div className="sessionCrumb">
        <button type="button" className="linkButton" onClick={onBack}>{t('detail.backToSessions')}</button>
        <span>/</span>
        <strong>{shortId(session.id)}</strong>
      </div>

      <div className="sessionHero">
        <div className="sessionHeroMain">
          <div className="titleLine">
            <h1>{session.id}</h1>
            <StatusDot tone={statusTone(displayStatus)} label={displayStatus} />
          </div>
          <div className="sessionMetaRow">
            <button className="resourceBadge" type="button" onClick={() => agent ? onOpenAgent(agent) : undefined}>
              <Monitor size={15} />
              {session.agent.name}
            </button>
            <ResourceBadge icon={<Cloud size={15} />} label={environmentName ?? session.environment_id} />
            <ResourceBadge icon={<Cpu size={15} />} label={session.loop_engine ?? 'builtin'} />
            <span className="sessionTimeMeta"><Clock size={15} /><span>{relativeDate(session.created_at)} · {formatDuration(session.created_at, session.updated_at)}</span></span>
          </div>
        </div>
        <div className="sessionHeroActions">
          <div className="menuWrap">
            <button className="button outline largeAction" type="button" onClick={() => setActionsOpen((open) => !open)}>
              {t('detail.actions')} <ChevronDown size={16} />
            </button>
            {actionsOpen ? (
              <div className="agentMenu sessionActionsMenu">
                <button type="button" onClick={() => { setActionsOpen(false); onSettings(); }}><Settings size={18} />{t('detail.menu.settings')}</button>
                {displayStatus !== 'terminated' && displayStatus !== 'archived' ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onDefineOutcome(); }}><Target size={18} />{t('detail.menu.defineOutcome')}</button>
                ) : null}
                <button type="button" onClick={() => { setActionsOpen(false); onResources(); }}><Paperclip size={18} />{t('detail.menu.resources')}</button>
                <button type="button" onClick={() => { setActionsOpen(false); onInterrupt(); }}><Square size={18} />{t('detail.menu.interrupt')}</button>
                {!session.archived_at ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onArchive(); }}><Archive size={18} />{t('detail.menu.archive')}</button>
                ) : null}
                <button type="button" className="dangerMenuItem" onClick={() => { setActionsOpen(false); onDelete(); }}><Trash2 size={18} />{t('detail.menu.delete')}</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <RunStateStrip displayStatus={displayStatus} usage={usage} onInterrupt={onInterrupt} />
    </>
  );
}

/**
 * The live-run readout: what the session is doing right now, what it has
 * cost so far, and — while it is doing something — the always-visible
 * Interrupt. An idle, finished session renders nothing here.
 */
function RunStateStrip({
  displayStatus,
  usage,
  onInterrupt,
}: {
  displayStatus: SessionDisplayStatus;
  usage?: SessionUsageReceipt;
  onInterrupt: () => void;
}) {
  const { t } = useTranslation('sessions');
  const live = displayStatus === 'running' || displayStatus === 'awaiting_action' || displayStatus === 'rescheduling';
  const receipt = usage ? formatUsageReceipt(usage) : '';
  if (!live && !receipt) return null;
  return (
    <div className="runStateStrip" role="status">
      {live ? (
        <span className="runStatePill">
          {displayStatus === 'awaiting_action' ? (
            <><PauseCircle size={15} /> {t('detail.run.needsApproval')}</>
          ) : displayStatus === 'rescheduling' ? (
            <><Clock size={15} /> {t('detail.run.rescheduling')}</>
          ) : (
            <><span className="runDot" aria-hidden="true" /> {t('detail.run.running')}</>
          )}
        </span>
      ) : null}
      {receipt ? <span className="costReceipt">{receipt}</span> : null}
      <span className="spacer" />
      {live ? (
        <button className="button danger compactButton" type="button" onClick={onInterrupt}>
          <Square size={13} /> {t('detail.run.interrupt')}
        </button>
      ) : null}
    </div>
  );
}

function formatUsageReceipt(usage: SessionUsageReceipt): string {
  const parts = [`${formatTokenCount(usage.inputTokens)} in`, `${formatTokenCount(usage.outputTokens)} out`];
  if (usage.costAmount !== undefined) {
    const usd = Number(usage.costAmount) / 100;
    if (Number.isFinite(usd)) parts.push(`$${usd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
