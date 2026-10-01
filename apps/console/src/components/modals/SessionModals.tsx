import { ChevronDown, Database, ExternalLink, FileText, Plus, Shield, Trash2 } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useState } from 'react';
import { postJson } from '../../api';
import { EmptyState, RequiredMark } from '../Common';
import { Modal } from '../Modal';
import { MultiResourcePicker, ResourcePicker } from '../ResourcePicker';
import { environmentKind } from '../pages/EnvironmentPageModel';
import { formatDateShort } from '../../lib/format';
import type { ConsoleData, SessionResourceDraft, ViewId } from '../../types';

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson('/v1/sessions', {
        agent,
        environment_id: environment,
        title: title || undefined,
        resources: resources.map(toSessionResourcePayload),
        vault_ids: Array.from(vaultIds),
      });
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
