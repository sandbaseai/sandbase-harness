import { agentModelId } from '../../lib/agentModelConfig';
import { Box, Check, ChevronDown, Copy, FlaskConical, Lock, MessageSquare, Monitor, MoreVertical, Pencil, Play, Plus, Server, Sparkles, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { postJson } from '../../api';
import { EmptyState, Kpi, KpiStrip, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { CopyableId, ListToolbar, listSummary, NameCell, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { copyText, formatDate, formatDateShort, formatUsage, shortId } from '../../lib/format';
import { diffAgentVersions, type AgentFieldDiff } from '../../lib/agentVersionDiff';
import { useAgentVersions } from '../../useAgentVersions';
import {
  selectEnabledCapabilities,
  useRuntimeCapabilities,
  type RuntimeCapability,
} from '../../useRuntimeCapabilities';
import type { Agent, AgentTab, AgentToolset, ConsoleData, CustomToolEntry, McpToolset, Session, ToolPermission } from '../../types';
import './agents.css';

function agentTone(agent: Agent): Tone {
  if (agent.archived_at) return 'neutral';
  return agent.status === 'active' ? 'ok' : 'pending';
}

function agentStatusLabel(agent: Agent): string {
  return agent.archived_at ? 'archived' : agent.status;
}

export function Agents({ data, onNewAgent, onOpenAgent }: { data: ConsoleData; onNewAgent: () => void; onOpenAgent: (agent: Agent) => void }) {
  const { t } = useTranslation('agents');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const agents = data.agents.filter((agent) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || (status === 'active' ? !agent.archived_at : status === 'archived' ? !!agent.archived_at : agent.status === status);
    const matchesQuery = agent.id.toLowerCase().includes(q) || agent.name.toLowerCase().includes(q) || agent.description.toLowerCase().includes(q) || agentModelId(agent.model).toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  return (
    <section className="page-section console-page agents-list-page" aria-labelledby="agents-heading">
      <PageHeader
        headingId="agents-heading"
        title={tPages('agents.title')}
        help={tPages('agents.description')}
        actions={(
          <button className="button primary" type="button" onClick={onNewAgent}>
            <Plus size={15} aria-hidden="true" />
            {tPages('agents.newAgent')}
          </button>
        )}
      />
      <PageBody>
        <ListToolbar
          label={t('view.filterLabel')}
          summary={listSummary(tCommon, agents.length, data.agents.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('view.searchPlaceholder')} label={t('view.filterLabel')} />
          <ConsoleSelect
            label={t('view.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: t('view.statusOptions.active') },
              { value: 'all', label: t('view.statusOptions.all') },
              { value: 'archived', label: t('view.statusOptions.archived') },
            ]}
          />
        </ListToolbar>
        {agents.length ? (
          <div className="table-frame agents-table-frame">
            <table className="data-table" aria-label={tPages('agents.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('view.columns.agent')}</th>
                  <th scope="col">{t('view.columns.model')}</th>
                  <th scope="col">{t('view.columns.status')}</th>
                  <th scope="col">{t('view.columns.created')}</th>
                  <th scope="col">{t('view.columns.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className="clickable-row" onClick={() => onOpenAgent(agent)}>
                    <th scope="row">
                      <NameCell
                        name={agent.name}
                        id={agent.id}
                        fallback={t('list.untitled')}
                        onOpen={() => onOpenAgent(agent)}
                        openLabel={t('view.open', { name: agent.name })}
                      />
                    </th>
                    <td><code title={agentModelId(agent.model)}>{agentModelId(agent.model)}</code></td>
                    <td><StatusDot tone={agentTone(agent)} label={agentStatusLabel(agent)} /></td>
                    <td>{formatDate(agent.created_at)}</td>
                    <td>{formatDate(agent.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Monitor}
            title={data.agents.length && (query || status !== 'all') ? t('list.noMatch') : t('list.noAgents')}
            action={query ? <button className="button outline" type="button" onClick={() => setQuery('')}>{tCommon('actions.clearSearch')}</button> : null}
          />
        )}
        <div className="agent-card-list">
          {agents.map((agent) => (
            <div className="agent-card" key={agent.id}>
              <button className="agent-card-open" type="button" onClick={() => onOpenAgent(agent)} aria-label={t('view.open', { name: agent.name })}>
                <strong>{agent.name}</strong>
                <span className="agent-card-meta">
                  <code>{agentModelId(agent.model)}</code>
                  <StatusDot tone={agentTone(agent)} label={agentStatusLabel(agent)} />
                </span>
              </button>
              <CopyableId id={agent.id} compact />
            </div>
          ))}
        </div>
      </PageBody>
    </section>
  );
}

export function AgentDetail({
  agent,
  data,
  tab,
  onTab,
  onBack,
  onEdit,
  onNewSession,
  onOpenSession,
  onRefresh,
}: {
  agent: Agent;
  data: ConsoleData;
  tab: AgentTab;
  onTab: (tab: AgentTab) => void;
  onBack: () => void;
  onEdit: (draft?: Agent) => void;
  onNewSession: () => void;
  onOpenSession: (session: Session) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('agents');
  const [menuOpen, setMenuOpen] = useState(false);
  const agentSessions = data.sessions.filter((session) => session.agent.id === agent.id);
  const tokenIn = agentSessions.reduce((sum, session) => sum + session.usage.input_tokens, 0);
  const tokenOut = agentSessions.reduce((sum, session) => sum + session.usage.output_tokens, 0);

  const archive = async () => {
    await postJson(`/v1/agents/${agent.id}/archive`, {});
    setMenuOpen(false);
    onRefresh();
  };

  return (
    <section className="agentDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>{t('detail.back')}</button>
        <span>/</span>
        <strong>{agent.name}</strong>
      </div>

      <div className="agentHero">
        <div>
          <div className="titleLine">
            <h1>{agent.name}</h1>
            <StatusDot tone={agentTone(agent)} label={agentStatusLabel(agent)} />
            <button className="iconButton" type="button" title={t('detail.copyId')} aria-label={t('detail.copyId')} onClick={() => void copyText(agent.id)}><Copy size={16} /></button>
          </div>
          <p className="mutedLine"><span className="monoText">{agent.id}</span> · {t('detail.lastUpdated', { date: formatDate(agent.updated_at) })}</p>
          <p className="agentDescription">{agent.description || t('detail.noDescription')}</p>
        </div>
        <div className="agentHeroActions">
          <button className="secondaryButton largeAction" type="button" onClick={() => onEdit()}>
            <Pencil size={18} />
            {t('detail.edit')}
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title={t('detail.actions')} aria-label={t('detail.actions')}>
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button type="button" onClick={onNewSession}><Play size={18} />{t('detail.startSession')}</button>
                <button type="button" onClick={() => onEdit()}><Sparkles size={18} />{t('detail.guidedEdit')}</button>
                <button type="button" className="dangerMenuItem" onClick={() => void archive()}><Lock size={18} />{t('detail.archive')}</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="detailTabs" role="tablist">
        {(['agent', 'sessions', 'deployments', 'observability'] as AgentTab[]).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'active' : ''}
            onClick={() => onTab(item)}
          >
            {t(`detail.tabs.${item}`)}
            {item === 'observability' ? <span className="newPill">{t('detail.tabs.new')}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'agent' ? (
        <AgentConfigTab
          agent={agent}
          onRestoreVersion={(version) => onEdit(version)}
          onTestAgent={onNewSession}
        />
      ) : null}
      {tab === 'sessions' ? <AgentSessionsTab sessions={agentSessions} onOpenSession={onOpenSession} /> : null}
      {tab === 'deployments' ? <EmptyState icon={Server} title={t('detail.noDeployments')} /> : null}
      {tab === 'observability' ? (
        <AgentObservability sessions={agentSessions} tokenIn={tokenIn} tokenOut={tokenOut} />
      ) : null}
    </section>
  );
}

/**
 * The policy that actually governs a toolset.
 *
 * Explicit configuration always wins. When nothing is configured the toolset
 * kind supplies the default — `agent_toolset_20260401` allows by default,
 * `mcp_toolset` asks by default — so showing "not configured" would understate
 * what the runtime enforces. Third-party MCP servers being gated by default is
 * the fact an operator most needs to see here, which is why the kind default is
 * rendered rather than left blank.
 *
 * Derived locally rather than imported from the runtime so the Console bundle
 * stays free of the server's dependency graph.
 */
export function effectiveToolsetPermission(toolset: AgentToolset | undefined): ToolPermission {
  // Custom tools are caller-executed — no policy governs them at all.
  if (!toolset || toolset.type === 'custom') return 'always_allow';
  return toolset.default_config?.permission_policy?.type
    ?? (toolset.type === 'agent_toolset_20260401' ? 'always_allow' : 'always_ask');
}

/** Compact badge for the effective policy, read-only in this view. */
export function PermissionBadge({ policy }: { policy: ToolPermission }) {
  const { t } = useTranslation('agents');
  return (
    <span className={`permissionBadge permission-${policy}`}>{t(`detail.permission.${policy}`)}</span>
  );
}

function AgentConfigTab({
  agent,
  onRestoreVersion,
  onTestAgent,
}: {
  agent: Agent;
  onRestoreVersion: (version: Agent) => void;
  onTestAgent: () => void;
}) {
  const { t } = useTranslation('agents');
  const [versionsOpen, setVersionsOpen] = useState(false);
  // The request is deferred until the operator opens the panel; agentId=null
  // while collapsed keeps the tab free of speculative fetches.
  const { versions, loading: versionsLoading, error: versionsError } = useAgentVersions(versionsOpen ? agent.id : null);
  // Capability status comes from the runtime's registry, not from copy here:
  // this build cannot know which built-in tools the local machine can execute.
  const { capabilities, error: capabilitiesError } = useRuntimeCapabilities();
  const enabledCapabilities = selectEnabledCapabilities(capabilities, new Set(toolNames(agent)));
  const builtinToolCount = toolNames(agent).length;
  const mcpToolsets = agent.tools.filter((toolset): toolset is McpToolset => toolset.type === 'mcp_toolset');
  const customTools = agent.tools.filter((toolset): toolset is CustomToolEntry => toolset.type === 'custom');
  const builtinPolicy = effectiveToolsetPermission(
    agent.tools.find((toolset) => toolset.type === 'agent_toolset_20260401'),
  );
  return (
    <div className="detailStack">
      <div className="versionRow">
        <button className="filterButton" type="button" aria-expanded={versionsOpen} onClick={() => setVersionsOpen((open) => !open)}>
          {t('detail.version')} <strong>v{agent.version}</strong> <ChevronDown size={15} />
        </button>
        <button className="textButton" type="button" onClick={onTestAgent}>
          <Play size={15} />
          {t('detail.testAgent')}
        </button>
      </div>
      {versionsOpen ? (
        <AgentVersionsPanel
          agent={agent}
          versions={versions}
          loading={versionsLoading}
          error={versionsError}
          onRestore={onRestoreVersion}
          onTest={onTestAgent}
        />
      ) : null}
      <div className="systemPreview">
        <pre>{agent.system}</pre>
      </div>

      <section className="detailSection">
        <h2>{t('detail.mcpTools')}</h2>
        <div className="toolsetCard">
          <div className="toolsetHeader">
            <div className="toolsetIcon"><Box size={22} /></div>
            <div>
              <strong>{t('detail.builtinTools')}</strong>
              <span>{t('detail.builtinToolset')}</span>
            </div>
            <PermissionBadge policy={builtinPolicy} />
          </div>
          {capabilitiesError ? (
            <div className="toolsetRow">
              <span><ChevronDown size={16} />{t('detail.toolPermissions')} <b>{builtinToolCount}</b></span>
              <span>{t('detail.capabilityUnavailable')}</span>
            </div>
          ) : enabledCapabilities.map((capability) => (
            <div className="toolsetRow" key={capability.id}>
              <span><ChevronDown size={16} />{capability.id}</span>
              <CapabilityStatus capability={capability} />
            </div>
          ))}
        </div>
        {mcpToolsets.map((toolset) => (
          <div className="toolsetCard" key={toolset.mcp_server_name}>
            <div className="toolsetHeader">
              <div className="toolsetIcon"><Zap size={22} /></div>
              <div>
                <strong>{toolset.mcp_server_name}</strong>
                <span>mcp_toolset</span>
              </div>
              <PermissionBadge policy={effectiveToolsetPermission(toolset)} />
            </div>
          </div>
        ))}
        {customTools.map((tool) => (
          <div className="toolsetCard" key={tool.name}>
            <div className="toolsetHeader">
              <div className="toolsetIcon"><FlaskConical size={22} /></div>
              <div>
                <strong>{tool.name}</strong>
                <span>custom</span>
              </div>
            </div>
            <div className="toolsetRow">
              <span><ChevronDown size={16} />{t('detail.callerExecuted')}</span>
              <span>{tool.description}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="detailSection">
        <h2>{t('detail.skills')}</h2>
        {agent.skills.length ? (
          <div className="chipRow">{agent.skills.map((skill) => <span className="softChip" key={skill.skill_id}>{skill.skill_id}</span>)}</div>
        ) : <p className="emptyInline">{t('detail.noSkills')}</p>}
      </section>
    </div>
  );
}

function sessionTone(status: Session['status']): Tone {
  if (status === 'running') return 'ok';
  if (status === 'terminated') return 'danger';
  if (status === 'idle') return 'neutral';
  return 'pending';
}

function AgentSessionsTab({ sessions, onOpenSession }: { sessions: Session[]; onOpenSession: (session: Session) => void }) {
  const { t } = useTranslation('agents');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = sessions.filter((session) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || session.status === status;
    const matchesQuery = session.id.toLowerCase().includes(q) || (session.title ?? '').toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  return (
    <div className="detailStack">
      <ListToolbar
        label={t('detail.sessions.filterLabel')}
        summary={listSummary(tCommon, filtered.length, sessions.length, { locale: i18n.resolvedLanguage })}
      >
        <SearchField value={query} onChange={setQuery} placeholder={t('detail.sessions.searchPlaceholder')} label={t('detail.sessions.filterLabel')} />
        <ConsoleSelect
          label={t('detail.sessions.status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: t('detail.sessions.statusOptions.all') },
            { value: 'idle', label: t('detail.sessions.statusOptions.idle') },
            { value: 'running', label: t('detail.sessions.statusOptions.running') },
            { value: 'rescheduling', label: t('detail.sessions.statusOptions.rescheduling') },
            { value: 'terminated', label: t('detail.sessions.statusOptions.terminated') },
          ]}
        />
      </ListToolbar>
      {filtered.length ? (
        <div className="table-frame">
          <table className="data-table" aria-label={t('detail.tabs.sessions')}>
            <thead>
              <tr>
                <th scope="col">{t('detail.sessions.columns.id')}</th>
                <th scope="col">{t('detail.sessions.columns.name')}</th>
                <th scope="col">{t('detail.sessions.columns.status')}</th>
                <th scope="col">{t('detail.sessions.columns.version')}</th>
                <th scope="col">{t('detail.sessions.columns.tokens')}</th>
                <th scope="col">{t('detail.sessions.columns.created')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((session) => (
                <tr key={session.id} className="clickable-row" onClick={() => onOpenSession(session)}>
                  <td><code>{shortId(session.id)}</code></td>
                  <td>{session.title || '-'}</td>
                  <td><StatusDot tone={sessionTone(session.status)} label={session.status} /></td>
                  <td>v1</td>
                  <td>{formatUsage(session.usage)}</td>
                  <td>{formatDateShort(session.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={MessageSquare} title={t('detail.sessions.noSessions')} />
      )}
    </div>
  );
}

function AgentObservability({ sessions, tokenIn, tokenOut }: { sessions: Session[]; tokenIn: number; tokenOut: number }) {
  const { t } = useTranslation('agents');
  // Internal failures project to `terminated`; that is the error rate's axis.
  const terminated = sessions.filter((session) => session.status === 'terminated').length;
  const errorRate = sessions.length ? Math.round((terminated / sessions.length) * 100) : 0;
  return (
    <div className="detailStack">
      <KpiStrip label={t('detail.tabs.observability')}>
        <Kpi label={t('detail.observability.sessions')} value={sessions.length} help={t('detail.observability.sessionsHelp')} />
        <Kpi label={t('detail.observability.errorRate')} value={`${errorRate}%`} tone={errorRate > 0 ? 'danger' : 'ok'} />
        <Kpi label={t('detail.observability.inputTokens')} value={tokenIn} />
        <Kpi label={t('detail.observability.outputTokens')} value={tokenOut} />
      </KpiStrip>
      <div className="panel sessionActivity">
        <div className="panelHeader">
          <h2>{t('detail.observability.sessionActivity')}</h2>
          <button className="filterButton" type="button">{t('detail.version')} <strong>{t('detail.observability.allVersions')}</strong> <ChevronDown size={15} /></button>
        </div>
      </div>
    </div>
  );
}

function toolNames(agent: Pick<Agent, 'tools'>): string[] {
  const names = new Set<string>();
  for (const toolset of agent.tools ?? []) {
    if (toolset.type === 'custom') continue;
    for (const [name, config] of Object.entries(toolset.configs ?? {})) {
      if (config.enabled !== false && config.permission_policy?.type !== 'never_allow') names.add(name);
    }
  }
  return [...names];
}

/**
 * One registry entry as a status row.
 *
 * `reason` is rendered as the tooltip rather than as body text: the runtime
 * writes it for an operator diagnosing a capability, and a row that carried a
 * paragraph would bury the status it belongs to.
 */
export function CapabilityStatus({ capability }: { capability: RuntimeCapability }) {
  const { t } = useTranslation('agents');
  if (capability.status === 'available') {
    return <StatusDot tone="ok" label={t('detail.capability.available')} />;
  }
  return (
    <span title={capability.reason ?? undefined}>
      <StatusDot tone="neutral" label={t('detail.capability.unavailable')} />
    </span>
  );
}

/**
 * Side-by-side version diff for one agent. All data comes from the stored
 * `agent_versions` rows via `GET /v1/agents/:id/versions` — nothing is
 * inferred from the live agent beyond which version is current. Restoring
 * hands the old definition back to the edit modal as a draft; testing starts
 * a session that exercises the currently deployed version.
 */
export function AgentVersionsPanel({
  agent,
  versions,
  loading,
  error,
  onRestore,
  onTest,
}: {
  agent: Agent;
  versions: Agent[];
  loading: boolean;
  error: string;
  onRestore: (version: Agent) => void;
  onTest: () => void;
}) {
  const { t } = useTranslation('agents');
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [nextVersion, setNextVersion] = useState<number | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);

  const base = sorted.find((item) => item.version === baseVersion) ?? sorted[0];
  const next = sorted.find((item) => item.version === nextVersion)
    ?? [...sorted].reverse().find((item) => item.version === agent.version)
    ?? sorted[sorted.length - 1];
  const allDiffs = base && next ? diffAgentVersions(base, next) : [];
  const diffs = onlyChanges ? allDiffs.filter((diff) => diff.kind !== 'unchanged') : allDiffs;

  return (
    <div className="versionsPanel">
      {error ? <div className="banner error inlineBanner">{error}</div> : null}
      {loading ? <p className="emptyInline">{t('detail.versions.loading')}</p> : null}
      {!loading && !error && sorted.length === 0 ? (
        <p className="emptyInline">{t('detail.versions.empty')}</p>
      ) : null}

      {sorted.length > 0 ? (
        <div className="versionList">
          {sorted.map((version) => (
            <div className={`versionItem ${version.version === agent.version ? 'current' : ''}`} key={version.version}>
              <strong>v{version.version}</strong>
              <span>{formatDate(version.created_at)}{version.version === agent.version ? ` · ${t('detail.versions.current')}` : ''}</span>
              <button
                className="textButton"
                type="button"
                disabled={version.version === agent.version}
                title={version.version === agent.version ? t('detail.versions.currentTitle') : t('detail.versions.restoreTitle')}
                onClick={() => onRestore(version)}
              >
                <Copy size={14} />
                {t('detail.versions.restoreDraft')}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {base && next ? (
        <>
          <div className="diffControls">
            <ConsoleSelect
              label={t('detail.versions.base')}
              value={String(base.version)}
              onChange={(value) => setBaseVersion(Number(value))}
              options={sorted.map((item) => ({ value: String(item.version), label: `v${item.version}` }))}
            />
            <ConsoleSelect
              label={t('detail.versions.compare')}
              value={String(next.version)}
              onChange={(value) => setNextVersion(Number(value))}
              options={sorted.map((item) => ({ value: String(item.version), label: `v${item.version}` }))}
            />
            <label>
              <input type="checkbox" checked={!onlyChanges} onChange={(event) => setOnlyChanges(!event.target.checked)} />
              {t('detail.versions.showUnchanged')}
            </label>
          </div>
          <div className="diffTable">
            <div className="diffHead">
              <span>{t('detail.versions.field')}</span>
              <span>v{base.version}{base.version === agent.version ? ` · ${t('detail.versions.current')}` : ''}</span>
              <span>v{next.version}{next.version === agent.version ? ` · ${t('detail.versions.current')}` : ''}</span>
            </div>
            {diffs.map((diff) => (
              <DiffRow diff={diff} key={diff.field} />
            ))}
            {diffs.length === 0 ? (
              <div className="diffRow">
                <span className="diffField">{t('detail.versions.noDifferences')}</span>
                <pre className="diffValue">{t('detail.versions.identical')}</pre>
                <pre className="diffValue"> </pre>
              </div>
            ) : null}
          </div>
          <div className="modalActions">
            <button className="textButton" type="button" onClick={() => onRestore(base)} disabled={base.version === agent.version}>
              <Copy size={15} />
              {t('detail.versions.restoreVersionDraft', { version: base.version })}
            </button>
            <button className="textButton" type="button" onClick={() => onRestore(next)} disabled={next.version === agent.version}>
              <Copy size={15} />
              {t('detail.versions.restoreVersionDraft', { version: next.version })}
            </button>
            <button className="secondaryButton" type="button" onClick={onTest}>
              <FlaskConical size={15} />
              {t('detail.testAgent')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function DiffRow({ diff }: { diff: AgentFieldDiff }) {
  return (
    <div className={`diffRow ${diff.kind}`}>
      <span className="diffField">
        {diff.label}
        <em className={`diffBadge ${diff.kind}`}>{diff.kind}</em>
      </span>
      <pre className="diffValue">{diff.base || '—'}</pre>
      <pre className="diffValue">{diff.next || '—'}</pre>
    </div>
  );
}
