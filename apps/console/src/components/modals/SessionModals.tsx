import { ChevronDown, Database, ExternalLink, FileText, Plus, Shield, Trash2 } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useMemo, useState } from 'react';
import { postJson } from '../../api';
import { EmptyState, RequiredMark } from '../Common';
import { EquivalentRequestPanel } from '../EquivalentRequestPanel';
import { Modal } from '../Modal';
import { MultiResourcePicker, ResourcePicker } from '../ResourcePicker';
import { environmentKind } from '../pages/EnvironmentPageModel';
import { formatDateShort } from '../../lib/format';
import type { ConsoleData, Session, SessionResourceDraft, ViewId } from '../../types';

export function SessionModal({
  data,
  initialAgentId,
  onClose,
  onSaved,
  onNavigate,
}: {
  data: ConsoleData;
  initialAgentId?: string;
  onClose: () => void;
  onSaved: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  const [agent, setAgent] = useState(initialAgentId ?? '');
  const [environment, setEnvironment] = useState('');
  const [title, setTitle] = useState('');
  const [vaultIds, setVaultIds] = useState<Set<string>>(new Set());
  const [resources, setResources] = useState<SessionResourceDraft[]>([]);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // One body object feeds both the submit below and the equivalent-request
  // panel — the panel is only honest if it cannot drift from what is sent.
  const createBody = useMemo(() => ({
    agent,
    environment_id: environment,
    title: title || undefined,
    resources: resources.map(toSessionResourcePayload),
    vault_ids: Array.from(vaultIds),
  }), [agent, environment, title, resources, vaultIds]);
  const createRequest = useMemo(
    () => ({ method: 'POST' as const, path: '/v1/sessions', body: createBody }),
    [createBody],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson('/v1/sessions', createBody);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addResource = (type: SessionResourceDraft['type']) => {
    setResources((current) => [...current, createResourceDraft(type)]);
    setResourceMenuOpen(false);
  };

  const updateResource = (index: number, resource: SessionResourceDraft) => {
    setResources((current) => current.map((item, itemIndex) => itemIndex === index ? resource : item));
  };

  const removeResource = (index: number) => {
    setResources((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <Modal title="Create session" subtitle="Set up an instance of your agent in its environment." onClose={onClose} size="medium">
      <form className="sessionForm sessionCreateForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <div className="sessionCreateMain">
            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">1</span>
                <div><h3>Session details</h3><p>Choose the agent and environment for this run.</p></div>
              </div>
              <label className="sessionField">
                <span>Title <small className="optionalPill">Optional</small></span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name this run" />
              </label>
              <div className="sessionPickerGrid">
                <ResourcePicker
                  label="Agent"
                  placeholder="Select an agent"
                  searchPlaceholder="Search agents by name or exact ID"
                  manageLabel="Manage agents"
                  onManage={() => onNavigate('agents')}
                  value={agent}
                  onValue={setAgent}
                  options={data.agents.map((item) => ({ id: item.id, title: item.name, subtitle: formatDateShort(item.created_at) }))}
                />
                <ResourcePicker
                  label="Environment"
                  placeholder="Select an environment"
                  searchPlaceholder="Search environments by name or exact ID"
                  manageLabel="Manage environments"
                  onManage={() => onNavigate('environments')}
                  value={environment}
                  onValue={setEnvironment}
                  options={data.environments.map((item) => ({ id: item.id, title: item.name, subtitle: formatDateShort(item.created_at), badge: environmentKind(item) }))}
                />
              </div>
            </section>

            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">2</span>
                <div><h3>Credential access</h3><p>Attach only the vaults this session needs.</p></div>
              </div>
              <MultiResourcePicker
                label="Credential vaults"
                searchPlaceholder="Search vaults by name or exact ID"
                placeholder="Select one or more vaults"
                manageLabel="Manage credential vaults"
                onManage={() => onNavigate('credential-vaults')}
                options={data.vaults.map((vault) => ({ id: vault.id, title: vault.name, subtitle: `Added ${formatDateShort(vault.created_at)}`, icon: <Shield size={16} /> }))}
                selected={vaultIds}
                onToggle={(id, checked) => toggleSet(id, checked, setVaultIds)}
              />
            </section>

            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">3</span>
                <div><h3>Resources</h3><p>Mount files, repositories, or memory stores into the session.</p></div>
              </div>
              {resources.map((resource, index) => (
                <SessionResourceEditor
                  key={`${resource.type}-${index}`}
                  resource={resource}
                  data={data}
                  onChange={(next) => updateResource(index, next)}
                  onRemove={() => removeResource(index)}
                  onNavigate={onNavigate}
                />
              ))}
              <div className="menuWrap resourceAddWrap">
                <button className="secondaryButton resourceAddButton" type="button" onClick={() => setResourceMenuOpen((open) => !open)}>
                  <Plus size={18} /> Add resource <ChevronDown size={16} />
                </button>
                {resourceMenuOpen ? (
                  <div className="resourceMenu">
                    <button type="button" onClick={() => addResource('github_repository')}>GitHub repository</button>
                    <button type="button" onClick={() => addResource('file')}>File</button>
                    <button type="button" onClick={() => addResource('memory_store')}>Memory store</button>
                  </div>
                ) : null}
              </div>
            </section>
        </div>

        <EquivalentRequestPanel request={createRequest} />

        <div className="modalActions stickyActions">
          <button className="darkButton" type="submit" disabled={saving || !agent || !environment}>{saving ? 'Creating…' : 'Create session'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SessionResourceEditor({
  resource,
  data,
  onChange,
  onRemove,
  onNavigate,
}: {
  resource: SessionResourceDraft;
  data: ConsoleData;
  onChange: (resource: SessionResourceDraft) => void;
  onRemove: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  if (resource.type === 'file') {
    return (
      <div className="resourceEditor">
        <ResourceEditorHeader title="File" onRemove={onRemove} />
        <label>
          <span className="fieldHeader">
            File ID <RequiredMark />
            <button className="linkButton" type="button" onClick={() => onNavigate('files')}>Manage files <ExternalLink size={15} /></button>
          </span>
          <input value={resource.file_id} onChange={(event) => onChange({ ...resource, file_id: event.target.value })} placeholder="file_abc123..." required />
        </label>
        <label>
          Mount path <RequiredMark />
          <input value={resource.mount_path} onChange={(event) => onChange({ ...resource, mount_path: event.target.value })} placeholder="/uploads/myfile.txt" required />
          <small>Must start with /uploads/</small>
        </label>
      </div>
    );
  }

  if (resource.type === 'github_repository') {
    return (
      <div className="resourceEditor">
        <ResourceEditorHeader title="GitHub repository" onRemove={onRemove} />
        <label>
          URL <RequiredMark />
          <input value={resource.url} onChange={(event) => onChange({ ...resource, url: event.target.value })} placeholder="https://github.com/owner/repo" required />
        </label>
        <label>
          Authorization token <RequiredMark />
          <input value={resource.authorization_token} onChange={(event) => onChange({ ...resource, authorization_token: event.target.value })} placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" required />
        </label>
        <label className="shortField">
          Checkout
          <select value={resource.checkout.mode} onChange={(event) => onChange({ ...resource, checkout: { ...resource.checkout, mode: event.target.value as 'default' | 'branch' | 'commit' } })}>
            <option value="default">Default branch</option>
            <option value="branch">Branch</option>
            <option value="commit">Commit SHA</option>
          </select>
        </label>
        {resource.checkout.mode === 'branch' ? (
          <label className="shortField">
            Branch name <RequiredMark />
            <input
              value={resource.checkout.value}
              onChange={(event) => onChange({ ...resource, checkout: { ...resource.checkout, value: event.target.value } })}
              placeholder="release-1.2"
              required
            />
          </label>
        ) : null}
        {resource.checkout.mode === 'commit' ? (
          <label className="shortField">
            Commit SHA <RequiredMark />
            <input
              value={resource.checkout.value}
              onChange={(event) => onChange({ ...resource, checkout: { ...resource.checkout, value: event.target.value } })}
              placeholder="9fca646b4a4ce9cdd3e1e8b3cd20e7b7c5e4b0c3"
              pattern="[0-9a-fA-F]{7,40}"
              title="A commit SHA is 7 to 40 hexadecimal characters."
              required
            />
            <small>7–40 hexadecimal characters</small>
          </label>
        ) : null}
        <label>
          Mount path
          <input value={resource.mount_path} onChange={(event) => onChange({ ...resource, mount_path: event.target.value })} placeholder="/workspace/repo-name (default)" />
        </label>
      </div>
    );
  }

  return (
    <div className="resourceEditor">
      <ResourceEditorHeader title="Memory store" onRemove={onRemove} />
      <label>
        <span className="fieldHeader">
          Memory store <RequiredMark />
          <button className="linkButton" type="button" onClick={() => onNavigate('memory-stores')}>Manage memory stores <ExternalLink size={15} /></button>
        </span>
        <select value={resource.memory_store_id} onChange={(event) => onChange({ ...resource, memory_store_id: event.target.value })} required>
          <option value="">Select a memory store</option>
          {data.memoryStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
        </select>
      </label>
      <label>
        Access
        <select value={resource.access} onChange={(event) => onChange({ ...resource, access: event.target.value as 'read_write' | 'read_only' })}>
          <option value="read_write">Read & write</option>
          <option value="read_only">Read only</option>
        </select>
      </label>
      <label>
        Instructions (optional)
        <textarea value={resource.instructions} onChange={(event) => onChange({ ...resource, instructions: event.target.value })} placeholder="Tell the agent what this store contains and when to use it." />
      </label>
    </div>
  );
}

function ResourceEditorHeader({ title, onRemove }: { title: string; onRemove: () => void }) {
  return (
    <div className="resourceEditorHeader">
      <strong>{title}</strong>
      <button className="iconButton quiet" type="button" onClick={onRemove} aria-label={`Remove ${title}`}>
        <Trash2 size={19} />
      </button>
    </div>
  );
}

function createResourceDraft(type: SessionResourceDraft['type']): SessionResourceDraft {
  if (type === 'file') return { type, file_id: '', mount_path: '' };
  if (type === 'github_repository') return { type, url: '', authorization_token: '', checkout: { mode: 'default', value: '' }, mount_path: '' };
  return { type, memory_store_id: '', access: 'read_write', instructions: '' };
}

export function toSessionResourcePayload(resource: SessionResourceDraft): Record<string, unknown> {
  if (resource.type === 'file') {
    return {
      type: 'file',
      file_id: resource.file_id,
      mount_path: resource.mount_path,
    };
  }
  if (resource.type === 'github_repository') {
    const checkout =
      resource.checkout.mode === 'branch' ? { type: 'branch', name: resource.checkout.value.trim() } :
      resource.checkout.mode === 'commit' ? { type: 'commit', sha: resource.checkout.value.trim() } :
      undefined;
    return {
      type: 'github_repository',
      url: resource.url,
      authorization_token: resource.authorization_token,
      ...(checkout ? { checkout } : {}),
      ...(resource.mount_path ? { mount_path: resource.mount_path } : {}),
    };
  }
  return {
    type: 'memory_store',
    memory_store_id: resource.memory_store_id,
    access: resource.access,
    ...(resource.instructions ? { instructions: resource.instructions } : {}),
  };
}

function toggleSet<T>(value: T, checked: boolean, setter: Dispatch<SetStateAction<Set<T>>>) {
  setter((current) => {
    const next = new Set(current);
    if (checked) next.add(value);
    else next.delete(value);
    return next;
  });
}

/**
 * Settings editor for a live session: title, metadata, budget, and the
 * agent's tools/MCP toolsets. The agent fields ride the update route's
 * `agent` object — the only named fields it accepts beside `effort`'s
 * refusal — and require an idle session, so they are disabled with the
 * interrupt hint the API's `session_not_idle` answer would otherwise carry.
 */
export function SessionSettingsModal({
  session,
  idle,
  onClose,
  onSaved,
}: {
  session: Session;
  idle: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(session.title ?? '');
  const [metadataText, setMetadataText] = useState(JSON.stringify(session.metadata ?? {}, null, 2));
  const currentBudgetUsd = session.budget
    ? (Number(session.budget.max_list_cost.amount) / 100).toFixed(2)
    : '';
  const [budgetUsd, setBudgetUsd] = useState(currentBudgetUsd);
  const [toolsText, setToolsText] = useState('');
  const [mcpText, setMcpText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parseJsonField = (text: string, label: string): { ok: true; value: unknown } | { ok: false } => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      setError(`${label} is not valid JSON.`);
      return { ok: false };
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    const body: Record<string, unknown> = {};
    const nextTitle = title.trim();
    if (nextTitle !== (session.title ?? '')) body.title = nextTitle || null;

    const metadata = parseJsonField(metadataText, 'Metadata');
    if (!metadata.ok) return;
    if (metadata.value !== undefined) {
      if (typeof metadata.value !== 'object' || metadata.value === null || Array.isArray(metadata.value)) {
        setError('Metadata must be a JSON object.');
        return;
      }
      const edited = metadata.value as Record<string, unknown>;
      const patch: Record<string, unknown> = { ...edited };
      for (const key of Object.keys(session.metadata ?? {})) {
        if (!(key in edited)) patch[key] = null; // removed key → patch delete
      }
      const changed = Object.keys(patch).some(
        (key) => patch[key] === null || !Object.is(session.metadata?.[key], edited[key]),
      );
      if (changed) body.metadata = patch;
    }

    if (budgetUsd.trim() !== currentBudgetUsd) {
      if (!budgetUsd.trim()) {
        body.budget = null;
      } else {
        const usd = Number(budgetUsd);
        if (!Number.isFinite(usd) || usd < 0) {
          setError('Budget must be a non-negative USD amount.');
          return;
        }
        body.budget = {
          type: 'limit',
          max_list_cost: { amount: String(Math.round(usd * 100)), currency: 'USD' },
        };
      }
    }

    const agentPatch: Record<string, unknown> = {};
    const tools = parseJsonField(toolsText, 'Tools');
    if (!tools.ok) return;
    if (tools.value !== undefined) agentPatch.tools = tools.value;
    const mcp = parseJsonField(mcpText, 'MCP servers');
    if (!mcp.ok) return;
    if (mcp.value !== undefined) agentPatch.mcp_servers = mcp.value;
    if (Object.keys(agentPatch).length > 0) body.agent = agentPatch;

    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Session settings" subtitle={`${session.title || session.id}`} onClose={onClose} size="medium">
      <form className="sessionForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <label className="sessionField">
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Name this session"
          />
        </label>
        <label className="sessionField">
          <span>Metadata <small className="optionalPill">JSON object; a removed key is deleted</small></span>
          <textarea
            value={metadataText}
            onChange={(event) => setMetadataText(event.target.value)}
            rows={Math.min(8, metadataText.split('\n').length + 1)}
            spellCheck={false}
          />
        </label>
        <label className="sessionField">
          <span>Budget <small className="optionalPill">USD; empty removes the ceiling</small></span>
          <input
            value={budgetUsd}
            onChange={(event) => setBudgetUsd(event.target.value)}
            placeholder={session.budget ? currentBudgetUsd : 'No budget'}
            inputMode="decimal"
          />
        </label>
        {!idle ? (
          <p className="banner">Tools and MCP servers can only change while the session is idle — send an interrupt and wait for it to settle first.</p>
        ) : null}
        <label className="sessionField">
          <span>Tools override <small className="optionalPill">JSON array; empty keeps current, null clears</small></span>
          <textarea
            value={toolsText}
            onChange={(event) => setToolsText(event.target.value)}
            placeholder={'[{"type": "agent_toolset_20260401", "configs": []}]'}
            disabled={!idle}
            spellCheck={false}
          />
        </label>
        <label className="sessionField">
          <span>MCP servers override <small className="optionalPill">JSON array; empty keeps current, null clears</small></span>
          <textarea
            value={mcpText}
            onChange={(event) => setMcpText(event.target.value)}
            placeholder={'[{"type": "stdio", "name": "server", "command": "…"}]'}
            disabled={!idle}
            spellCheck={false}
          />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function DefineOutcomeModal({
  session,
  data,
  onClose,
  onSaved,
}: {
  session: Session;
  data: ConsoleData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState('');
  const [rubricMode, setRubricMode] = useState<'text' | 'file'>('text');
  const [rubricText, setRubricText] = useState('');
  const [rubricFileId, setRubricFileId] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setError('Description is required.');
      return;
    }
    // The published contract requires a rubric: inline text or a reference to
    // an uploaded file — both spellings are validated server-side too.
    let rubric: Record<string, unknown>;
    if (rubricMode === 'file') {
      if (!rubricFileId) {
        setError('Choose an uploaded file for the rubric.');
        return;
      }
      rubric = { type: 'file', file_id: rubricFileId };
    } else {
      if (!rubricText.trim()) {
        setError('Rubric text is required.');
        return;
      }
      rubric = { type: 'text', content: rubricText.trim() };
    }
    let max: number | undefined;
    if (maxIterations.trim()) {
      const parsed = Number(maxIterations);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        setError('Max iterations must be an integer between 1 and 20.');
        return;
      }
      max = parsed;
    }
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/events`, {
        events: [{
          type: 'user.define_outcome',
          description: trimmedDescription,
          rubric,
          ...(max !== undefined ? { max_iterations: max } : {}),
        }],
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Define outcome" subtitle={session.title || session.id} onClose={onClose} size="medium">
      <form className="sessionForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <p className="modalBody">
          Sends a <code>user.define_outcome</code> event: the agent works toward the
          description and a grader scores each iteration against the rubric.
        </p>
        <label className="sessionField">
          <span>Description <RequiredMark /></span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="What a successful session looks like"
          />
        </label>
        <label className="sessionField">
          <span>Rubric <RequiredMark /></span>
          <div className="segment compactSegment">
            <button type="button" className={rubricMode === 'text' ? 'active' : ''} onClick={() => setRubricMode('text')}>Text</button>
            <button type="button" className={rubricMode === 'file' ? 'active' : ''} onClick={() => setRubricMode('file')}>File</button>
          </div>
        </label>
        {rubricMode === 'text' ? (
          <label className="sessionField">
            <span>Rubric text</span>
            <textarea
              value={rubricText}
              onChange={(event) => setRubricText(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="Criteria the grader scores against"
            />
          </label>
        ) : (
          <label className="sessionField">
            <span>Rubric file</span>
            <select value={rubricFileId} onChange={(event) => setRubricFileId(event.target.value)}>
              <option value="">Choose an uploaded file…</option>
              {data.files.map((file) => (
                <option key={file.id} value={file.id}>{file.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="sessionField">
          <span>Max iterations <small className="optionalPill">1-20; empty uses the default of 3</small></span>
          <input
            value={maxIterations}
            onChange={(event) => setMaxIterations(event.target.value)}
            inputMode="numeric"
            placeholder="3"
          />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={saving}>{saving ? 'Defining…' : 'Define outcome'}</button>
        </div>
      </form>
    </Modal>
  );
}
