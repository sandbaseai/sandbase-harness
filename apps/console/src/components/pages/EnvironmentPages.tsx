import { Archive, FileText, Globe, MoreVertical, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { postJson, putJson } from '../../api';
import { EmptyState, FilterSelect, StatusPill, Toolbar } from '../Common';
import { formatDateShort, shortId } from '../../lib/format';
import type { ConsoleData, Environment, EnvironmentDraft, MetadataDraft } from '../../types';
import { CloudEnvironment, ReadonlyTable, SelfHostedEnvironment } from './EnvironmentDetailViews';
import {
  environmentDraftFromApi,
  environmentHostingType,
  environmentKind,
  environmentPayloadFromDraft,
  hostingLabel,
} from './EnvironmentPageModel';

export function Environments({ data, onNew, onOpenEnvironment }: { data: ConsoleData; onNew: () => void; onOpenEnvironment: (environment: Environment) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const environments = data.environments.filter((environment) => {
    const q = query.toLowerCase();
    const environmentStatus = environment.archived_at ? 'archived' : 'active';
    const matchesStatus = status === 'all' || environmentStatus === status;
    const matchesQuery = environment.id.toLowerCase().includes(q) || environment.name.toLowerCase().includes(q) || (environment.description ?? '').toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });

  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Environments</h1>
          <p>Configuration template for containers, such as sessions or code execution.</p>
        </div>
        <div className="toolbarActions">
          <button className="darkButton" type="button" onClick={onNew}>
            <Plus size={18} />
            Create environment
          </button>
          <button className="iconButton" type="button" title="Documentation">
            <FileText size={18} />
          </button>
        </div>
      </div>
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by name or exact ID"
        actions={(
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        )}
      />
      <div className="tablePanel environmentsTablePanel">
        <table className="resourceTable">
          <thead>
            <tr>
              <th className="selectCol"><input type="checkbox" aria-label="Select all environments" /></th>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Type</th>
              <th>Updated at</th>
              <th className="actionsCol" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {environments.map((environment) => (
              <tr key={environment.id} className="clickableRow" onClick={() => onOpenEnvironment(environment)}>
                <td className="selectCol" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${environment.id}`} /></td>
                <td><strong className="monoText">{shortId(environment.id)}</strong></td>
                <td>{environment.name}</td>
                <td><StatusPill status={environment.archived_at ? 'archived' : 'active'} /></td>
                <td><span className="softChip inlineChip">{environmentKind(environment)}</span></td>
                <td>{formatDateShort(environment.updated_at)}</td>
                <td className="actionsCol" onClick={(event) => event.stopPropagation()}>
                  <button className="iconButton quiet" type="button" title="Environment actions"><MoreVertical size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {environments.length === 0 ? <EmptyState icon={<Server size={22} />} title="No environments" /> : null}
      </div>
      <div className="mobileResourceList">
        {environments.map((environment) => (
          <button className="mobileAgentCard" type="button" key={environment.id} onClick={() => onOpenEnvironment(environment)}>
            <span className="mobileAgentMain">
              <strong>{environment.name}</strong>
              <small className="monoText">{environment.id}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{environmentKind(environment)}</span>
              <StatusPill status={environment.archived_at ? 'archived' : 'active'} />
            </span>
          </button>
        ))}
        {environments.length === 0 ? <EmptyState icon={<Server size={22} />} title="No environments" /> : null}
      </div>
    </section>
  );
}

export function EnvironmentDetail({ environment, data, onBack, onRefresh }: { environment: Environment; data: ConsoleData; onBack: () => void; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const environmentSessions = data.sessions.filter((session) => session.environment_id === environment.id);
  const isSelfHosted = environmentHostingType(environment) === 'self_hosted';

  useEffect(() => {
    setEditing(false);
    setMenuOpen(false);
  }, [environment.id]);

  const archive = async () => {
    await postJson(`/v1/environments/${environment.id}/archive`, {});
    setMenuOpen(false);
    onBack();
    onRefresh();
  };

  if (editing) {
    return (
      <EnvironmentEditor
        environment={environment}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onRefresh();
        }}
      />
    );
  }

  return (
    <section className="environmentDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>Environments</button>
        <span>/</span>
        <strong>{environment.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{environment.name}</h1>
            <span className="softChip inlineChip">{environmentKind(environment)}</span>
            <Globe size={19} className="mutedIcon" />
          </div>
          <p className="mutedLine"><span className="monoText">{shortId(environment.id)}</span> · Last updated {formatDateShort(environment.updated_at)}</p>
          <p className="agentDescription">{environment.description || 'No description.'}</p>
        </div>
        <div className="agentHeroActions">
          <button className="secondaryButton largeAction" type="button" onClick={() => setEditing(true)}>
            <Pencil size={18} />
            Edit
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title="Environment actions">
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button type="button" className="dangerMenuItem" onClick={() => void archive()}><Archive size={18} />Archive</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isSelfHosted ? <SelfHostedEnvironment environment={environment} sessions={environmentSessions} /> : <CloudEnvironment environment={environment} />}
    </section>
  );
}

function EnvironmentEditor({ environment, onCancel, onSaved }: { environment: Environment; onCancel: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<EnvironmentDraft>(() => environmentDraftFromApi(environment));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(environmentDraftFromApi(environment));
  }, [environment.id]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await putJson(`/v1/environments/${environment.id}`, environmentPayloadFromDraft(draft));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="environmentDetail editingEnvironment">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onCancel}>Environments</button>
        <span>/</span>
        <strong>{environment.name}</strong>
      </div>
      {error ? <div className="banner error inlineBanner">{error}</div> : null}
      <div className="resourceHero editHero">
        <div className="editTitleGroup">
          <input className="titleInput" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value.slice(0, 50) })} />
          <span className="softChip inlineChip">{hostingLabel(draft.hostingType)}</span>
          <Globe size={19} className="mutedIcon" />
        </div>
        <div className="agentHeroActions">
          <button className="secondaryButton largeAction" type="button" onClick={onCancel}>Cancel</button>
          <button className="darkButton largeAction" type="button" onClick={() => void save()} disabled={saving || !draft.name.trim()}>Save</button>
        </div>
      </div>

      <label className="editField">
        Description
        <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Add a description for this environment (optional)" />
      </label>

      <div className="environmentBody">
        <EnvironmentExecutionEditor draft={draft} onDraft={setDraft} />
        <EnvironmentMetadataEditor draft={draft} onDraft={setDraft} />
        {draft.hostingType === 'self_hosted' ? <SelfHostedEnvironment environment={environment} sessions={[]} /> : null}
      </div>
    </section>
  );
}

function EnvironmentExecutionEditor({ draft, onDraft }: { draft: EnvironmentDraft; onDraft: (draft: EnvironmentDraft) => void }) {
  return (
    <section className="environmentSection environmentExecutionSection">
      <div>
        <h2>Execution</h2>
        <p>Choose where sessions for this environment execute. Docker runs one isolated container per session.</p>
      </div>
      <label className="editField">
        Sandbox provider
        <select value={draft.hostingType} onChange={(event) => onDraft({ ...draft, hostingType: event.target.value as EnvironmentDraft['hostingType'] })}>
          <option value="local">Local process</option>
          <option value="docker">Docker container</option>
          <option value="self_hosted">Self-hosted worker</option>
        </select>
      </label>
      {draft.hostingType === 'docker' ? (
        <div className="environmentNestedGrid">
          <label className="editField">
            Docker image
            <input
              value={draft.dockerImage}
              onChange={(event) => onDraft({ ...draft, dockerImage: event.target.value })}
              placeholder="node:22-slim"
            />
            <small>Must already be pullable or cached by the local Docker daemon.</small>
          </label>
          <label className="editField">
            Memory limit
            <input
              value={draft.dockerMemory}
              onChange={(event) => onDraft({ ...draft, dockerMemory: event.target.value })}
              placeholder="512m"
            />
            <small>Optional Docker memory value, for example 512m or 2g.</small>
          </label>
          <label className="editField">
            CPU limit
            <input
              inputMode="decimal"
              value={draft.dockerCpu}
              onChange={(event) => onDraft({ ...draft, dockerCpu: event.target.value })}
              placeholder="1"
            />
            <small>Optional number of CPUs available to the container.</small>
          </label>
        </div>
      ) : null}
      {draft.hostingType === 'self_hosted' ? (
        <div className="subtleNotice">Self-hosted sessions are pulled by an external worker. Save this environment, then use the setup instructions on the detail page.</div>
      ) : null}
    </section>
  );
}

function EnvironmentMetadataEditor({ draft, onDraft }: { draft: EnvironmentDraft; onDraft: (draft: EnvironmentDraft) => void }) {
  const updateMetadata = (id: string, patch: Partial<MetadataDraft>) => {
    onDraft({ ...draft, metadata: draft.metadata.map((item) => item.id === id ? { ...item, ...patch } : item) });
  };
  return (
      <section className="environmentSection editableListSection">
        <div className="sectionHeaderRow">
          <div>
            <h2>Metadata</h2>
            <p>Add custom key-value pairs to tag and organize this environment. Keys must be lowercase.</p>
          </div>
          <button className="iconButton" type="button" onClick={() => onDraft({ ...draft, metadata: [...draft.metadata, { id: newDraftId(), key: '', value: '' }] })}><Plus size={18} /></button>
        </div>
        {draft.metadata.length === 0 ? <ReadonlyTable empty="No metadata" rows={[]} columns={['Key', 'Value']} /> : null}
        {draft.metadata.map((item) => (
          <div className="editableRow metadataRow" key={item.id}>
            <input value={item.key} onChange={(event) => updateMetadata(item.id, { key: event.target.value.toLowerCase() })} placeholder="client_key..." />
            <input value={item.value} onChange={(event) => updateMetadata(item.id, { value: event.target.value })} placeholder="Value" />
            <button className="iconButton quiet" type="button" onClick={() => onDraft({ ...draft, metadata: draft.metadata.filter((candidate) => candidate.id !== item.id) })}><Trash2 size={18} /></button>
          </div>
        ))}
      </section>
  );
}

function newDraftId() {
  return `draft_${Math.random().toString(36).slice(2, 10)}`;
}
