import { Archive, ChevronDown, Clock, Cloud, Monitor, Settings, Square, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResourceBadge, StatusPill } from '../Common';
import { formatDuration, relativeDate, shortId } from '../../lib/format';
import type { Agent, Session } from '../../types';
import type { SessionDisplayStatus } from './conversation';

/**
 * The session header: breadcrumb, title/status pill, agent and environment
 * badges, and the Actions menu (settings, define outcome, interrupt, archive,
 * delete). Action handlers live on the page; this component only owns whether
 * the menu is open.
 */
export function SessionHero({
  session,
  displayStatus,
  agent,
  environmentName,
  onBack,
  onOpenAgent,
  onSettings,
  onDefineOutcome,
  onInterrupt,
  onArchive,
  onDelete,
}: {
  session: Session;
  displayStatus: SessionDisplayStatus;
  agent: Agent | undefined;
  environmentName?: string;
  onBack: () => void;
  onOpenAgent: (agent: Agent) => void;
  onSettings: () => void;
  onDefineOutcome: () => void;
  onInterrupt: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <>
      <div className="sessionCrumb">
        <button type="button" className="textButton" onClick={onBack}>Sessions</button>
        <span>/</span>
        <strong>{shortId(session.id)}</strong>
      </div>

      <div className="sessionHero">
        <div className="sessionHeroMain">
          <div className="titleLine">
            <h1>{session.id}</h1>
            <StatusPill status={displayStatus} />
          </div>
          <div className="sessionMetaRow">
            <button className="resourceBadge" type="button" onClick={() => agent ? onOpenAgent(agent) : undefined}>
              <Monitor size={15} />
              {session.agent.name}
            </button>
            <ResourceBadge icon={<Cloud size={15} />} label={environmentName ?? session.environment_id} />
            <span className="sessionTimeMeta"><Clock size={15} /><span>{relativeDate(session.created_at)} · {formatDuration(session.created_at, session.updated_at)}</span></span>
          </div>
        </div>
        <div className="sessionHeroActions">
          <div className="menuWrap">
            <button className="secondaryButton largeAction" type="button" onClick={() => setActionsOpen((open) => !open)}>
              Actions <ChevronDown size={16} />
            </button>
            {actionsOpen ? (
              <div className="agentMenu sessionActionsMenu">
                <button type="button" onClick={() => { setActionsOpen(false); onSettings(); }}><Settings size={18} />Session settings</button>
                {displayStatus !== 'terminated' && displayStatus !== 'archived' ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onDefineOutcome(); }}><Target size={18} />Define outcome</button>
                ) : null}
                <button type="button" onClick={() => { setActionsOpen(false); onInterrupt(); }}><Square size={18} />Send interrupt</button>
                {!session.archived_at ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onArchive(); }}><Archive size={18} />Archive session</button>
                ) : null}
                <button type="button" className="dangerMenuItem" onClick={() => { setActionsOpen(false); onDelete(); }}><Trash2 size={18} />Delete session</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
