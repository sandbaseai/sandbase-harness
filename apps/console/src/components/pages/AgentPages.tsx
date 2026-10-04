import { Box, Check, ChevronDown, Copy, FlaskConical, Lock, MessageSquare, Monitor, MoreVertical, Pencil, Play, Plus, Server, Sparkles, Zap } from 'lucide-react';
import { useState } from 'react';
import { postJson } from '../../api';
import { EmptyState, FilterSelect, MetricCard, StatusPill, Toolbar } from '../Common';
import { formatDate, formatDateShort, formatUsage, shortId } from '../../lib/format';
import { diffAgentVersions, type AgentFieldDiff } from '../../lib/agentVersionDiff';
import { useAgentVersions } from '../../useAgentVersions';
import {
  selectEnabledCapabilities,
  useRuntimeCapabilities,
  type RuntimeCapability,
} from '../../useRuntimeCapabilities';
import type { Agent, AgentTab, AgentToolset, ConsoleData, McpToolset, Session, ToolPermission } from '../../types';

export function Agents({ data, onNewAgent, onOpenAgent }: { data: ConsoleData; onNewAgent: () => void; onOpenAgent: (agent: Agent) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const agents = data.agents.filter((agent) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || (status === 'active' ? !agent.archived_at : status === 'archived' ? !!agent.archived_at : agent.status === status);
    const matchesQuery = agent.id.toLowerCase().includes(q) || agent.name.toLowerCase().includes(q) || agent.description.toLowerCase().includes(q) || agent.model.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Agents</h1>
          <p>Create and manage autonomous agents.</p>
        </div>
        <button className="darkButton" type="button" onClick={onNewAgent}>
          <Plus size={18} />
          Create agent
        </button>
      </div>
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by name or exact ID"
        actions={(
          <>
            <FilterSelect label="Created" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All time' }]} />
            <FilterSelect
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'all', label: 'All' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </>
        )}
      />
      <div className="tablePanel agentsTablePanel">
        <table className="agentTable">
          <thead>
            <tr>
              <th className="selectCol"><input type="checkbox" aria-label="Select all agents" /></th>
              <th>ID</th>
              <th>Name</th>
              <th>Model</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id} className="clickableRow" onClick={() => onOpenAgent(agent)}>
                <td className="selectCol" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${agent.name}`} /></td>
                <td className="monoCell">{shortId(agent.id)}</td>
                <td>
                  <strong>{agent.name}</strong>
                  <span>{agent.description || agent.id}</span>
                </td>
                <td>{agent.model}</td>
                <td><StatusPill status={agent.status} /></td>
                <td>{formatDate(agent.created_at)}</td>
                <td>{formatDate(agent.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {agents.length === 0 ? <EmptyState icon={<Monitor size={22} />} title="No agents" /> : null}
      </div>
      <div className="mobileAgentList">
        {agents.map((agent) => (
          <button className="mobileAgentCard" type="button" key={agent.id} onClick={() => onOpenAgent(agent)}>
            <span className="mobileAgentMain">
              <strong>{agent.name}</strong>
              <small className="monoText">{agent.id}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{agent.model}</span>
              <StatusPill status={agent.status} />
            </span>
          </button>
        ))}
        {agents.length === 0 ? <EmptyState icon={<Monitor size={22} />} title="No agents" /> : null}
      </div>
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
        <button type="button" className="textButton" onClick={onBack}>Agents</button>
        <span>/</span>
        <strong>{agent.name}</strong>
      </div>

      <div className="agentHero">
        <div>
          <div className="titleLine">
            <h1>{agent.name}</h1>
            <StatusPill status={agent.status} />
          </div>
          <p className="mutedLine"><span className="monoText">{agent.id}</span> · Last updated {formatDate(agent.updated_at)}</p>
          <p className="agentDescription">{agent.description || 'No description.'}</p>
        </div>
        <div className="agentHeroActions">
          <button className="secondaryButton largeAction" type="button" onClick={() => onEdit()}>
            <Pencil size={18} />
            Edit
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title="Agent actions">
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button type="button" onClick={onNewSession}><Play size={18} />Start session</button>
                <button type="button" onClick={() => onEdit()}><Sparkles size={18} />Guided edit</button>
                <button type="button" className="dangerMenuItem" onClick={() => void archive()}><Lock size={18} />Archive</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="detailTabs">
        {(['agent', 'sessions', 'deployments', 'observability'] as AgentTab[]).map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? 'active' : ''}
            onClick={() => onTab(item)}
          >
            {item === 'agent' ? 'Agent' : item[0].toUpperCase() + item.slice(1)}
            {item === 'observability' ? <span className="newPill">New</span> : null}
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
      {tab === 'deployments' ? <EmptyState icon={<Server size={22} />} title="Deployments are not configured for this local runtime" /> : null}
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
  if (!toolset) return 'always_allow';
  return toolset.default_config?.permission_policy?.type
    ?? (toolset.type === 'agent_toolset_20260401' ? 'always_allow' : 'always_ask');
}

const PERMISSION_LABELS: Record<ToolPermission, string> = {
  always_allow: 'Always allow',
  always_ask: 'Always ask',
  never_allow: 'Never allow',
};

/** Compact badge for the effective policy, read-only in this view. */
export function PermissionBadge({ policy }: { policy: ToolPermission }) {
  return (
    <span className={`permissionBadge permission-${policy}`}>{PERMISSION_LABELS[policy]}</span>
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
  const builtinPolicy = effectiveToolsetPermission(
    agent.tools.find((toolset) => toolset.type === 'agent_toolset_20260401'),
  );
  return (
    <div className="detailStack">
      <div className="versionRow">
        <button className="filterButton" type="button" aria-expanded={versionsOpen} onClick={() => setVersionsOpen((open) => !open)}>
          Version <strong>v{agent.version}</strong> <ChevronDown size={15} />
        </button>
        <button className="textButton" type="button" onClick={onTestAgent}>
          <Play size={15} />
          Test this agent
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
        <h2>MCPs and tools</h2>
        <div className="toolsetCard">
          <div className="toolsetHeader">
            <div className="toolsetIcon"><Box size={22} /></div>
            <div>
              <strong>Built-in tools</strong>
              <span>agent_toolset_20260401</span>
            </div>
            <PermissionBadge policy={builtinPolicy} />
          </div>
          {capabilitiesError ? (
            <div className="toolsetRow">
              <span><ChevronDown size={16} />Tool permissions <b>{builtinToolCount}</b></span>
              <span>Capability status unavailable</span>
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
      </section>

      <section className="detailSection">
        <h2>Skills</h2>
        {agent.skills.length ? (
          <div className="chipRow">{agent.skills.map((skill) => <span className="softChip" key={skill.skill_id}>{skill.skill_id}</span>)}</div>
        ) : <p className="emptyInline">No skills attached.</p>}
      </section>
    </div>
  );
}

function AgentSessionsTab({ sessions, onOpenSession }: { sessions: Session[]; onOpenSession: (session: Session) => void }) {
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
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by session ID"
        actions={(
          <>
            <FilterSelect label="Created" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All time' }]} />
            <FilterSelect label="Version" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All' }]} />
            <FilterSelect label="Deployment" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All' }]} />
            <FilterSelect
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All' },
                { value: 'idle', label: 'Idle' },
                { value: 'running', label: 'Running' },
                { value: 'rescheduling', label: 'Rescheduling' },
                { value: 'terminated', label: 'Terminated' },
              ]}
            />
          </>
        )}
      />
      <div className="tablePanel">
        <table>
          <thead><tr><th className="selectCol"><input type="checkbox" aria-label="Select sessions" /></th><th>ID</th><th>Name</th><th>Status</th><th>Version</th><th>Tokens in / out</th><th>Created</th></tr></thead>
          <tbody>
            {filtered.map((session) => (
              <tr key={session.id} className="clickableRow" onClick={() => onOpenSession(session)}>
                <td className="selectCol" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${session.id}`} /></td>
                <td className="monoCell">{shortId(session.id)}</td>
                <td>{session.title || '-'}</td>
                <td><StatusPill status={session.status} /></td>
                <td>v1</td>
                <td>{formatUsage(session.usage)}</td>
                <td>{formatDateShort(session.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? <EmptyState icon={<MessageSquare size={22} />} title="No sessions" /> : null}
      </div>
    </div>
  );
}

function AgentObservability({ sessions, tokenIn, tokenOut }: { sessions: Session[]; tokenIn: number; tokenOut: number }) {
  // Internal failures project to `terminated`; that is the error rate's axis.
  const terminated = sessions.filter((session) => session.status === 'terminated').length;
  const errorRate = sessions.length ? Math.round((terminated / sessions.length) * 100) : 0;
  return (
    <div className="detailStack">
      <div className="metricGrid">
        <MetricCard title="Sessions" value={sessions.length} subtitle="in total" />
        <MetricCard title="Error rate" value={`${errorRate}%`} />
        <MetricCard title="Total input tokens" value={tokenIn} />
        <MetricCard title="Total output tokens" value={tokenOut} />
      </div>
      <div className="panel sessionActivity">
        <div className="panelHeader">
          <h2>Session activity</h2>
          <button className="filterButton" type="button">Version <strong>All</strong> <ChevronDown size={15} /></button>
        </div>
      </div>
    </div>
  );
}

function toolNames(agent: Pick<Agent, 'tools'>): string[] {
  const names = new Set<string>();
  for (const toolset of agent.tools ?? []) {
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
  if (capability.status === 'available') {
    return <span className="allowText"><Check size={16} />Available</span>;
  }
  return (
    <span className="status unavailable" title={capability.reason ?? undefined}>
      Unavailable
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
      {loading ? <p className="emptyInline">Loading stored versions…</p> : null}
      {!loading && !error && sorted.length === 0 ? (
        <p className="emptyInline">No stored versions yet. Saving an edit records one automatically.</p>
      ) : null}

      {sorted.length > 0 ? (
        <div className="versionList">
          {sorted.map((version) => (
            <div className={`versionItem ${version.version === agent.version ? 'current' : ''}`} key={version.version}>
              <strong>v{version.version}</strong>
              <span>{formatDate(version.created_at)}{version.version === agent.version ? ' · current' : ''}</span>
              <button
                className="textButton"
                type="button"
                disabled={version.version === agent.version}
                title={version.version === agent.version ? 'The current version is already live' : 'Open this definition in the edit modal as a draft'}
                onClick={() => onRestore(version)}
              >
                <Copy size={14} />
                Restore as draft
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {base && next ? (
        <>
          <div className="diffControls">
            <FilterSelect
              label="Base"
              value={String(base.version)}
              onChange={(value) => setBaseVersion(Number(value))}
              options={sorted.map((item) => ({ value: String(item.version), label: `v${item.version}` }))}
            />
            <FilterSelect
              label="Compare"
              value={String(next.version)}
              onChange={(value) => setNextVersion(Number(value))}
              options={sorted.map((item) => ({ value: String(item.version), label: `v${item.version}` }))}
            />
            <label>
              <input type="checkbox" checked={!onlyChanges} onChange={(event) => setOnlyChanges(!event.target.checked)} />
              Show unchanged fields
            </label>
          </div>
          <div className="diffTable">
            <div className="diffHead">
              <span>Field</span>
              <span>v{base.version}{base.version === agent.version ? ' · current' : ''}</span>
              <span>v{next.version}{next.version === agent.version ? ' · current' : ''}</span>
            </div>
            {diffs.map((diff) => (
              <DiffRow diff={diff} key={diff.field} />
            ))}
            {diffs.length === 0 ? (
              <div className="diffRow">
                <span className="diffField">No differences</span>
                <pre className="diffValue">The two versions are identical.</pre>
                <pre className="diffValue"> </pre>
              </div>
            ) : null}
          </div>
          <div className="modalActions">
            <button className="textButton" type="button" onClick={() => onRestore(base)} disabled={base.version === agent.version}>
              <Copy size={15} />
              Restore v{base.version} as draft
            </button>
            <button className="textButton" type="button" onClick={() => onRestore(next)} disabled={next.version === agent.version}>
              <Copy size={15} />
              Restore v{next.version} as draft
            </button>
            <button className="secondaryButton" type="button" onClick={onTest}>
              <FlaskConical size={15} />
              Test this agent
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
