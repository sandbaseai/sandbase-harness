import { Archive, Check, ChevronDown, Database, FileText, History, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { deleteJson, getJson, postJson } from '../../api';
import { EmptyState, FilterSelect, StatusPill, SummaryStrip, Toolbar } from '../Common';
import { Modal } from '../Modal';
import { formatBytes, formatDateShort, shortId, truncateMiddle } from '../../lib/format';
import type { ConsoleData, MemoryRecord, MemoryStore, MemoryVersion } from '../../types';

export function MemoryStores({ data, onNew, onOpenMemoryStore }: { data: ConsoleData; onNew: () => void; onOpenMemoryStore: (store: MemoryStore) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const stores = data.memoryStores.filter((store) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || (status === 'active' ? !store.archived_at : status === 'archived' ? !!store.archived_at : store.status === status);
    const matchesQuery = store.id.toLowerCase().includes(q) || store.name.toLowerCase().includes(q) || store.description.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const activeStores = data.memoryStores.filter((store) => store.status === 'active').length;
  const totalMemories = data.memoryStores.reduce((sum, store) => sum + store.memories.length, 0);
  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Memory stores</h1>
          <p>Manage attachable memory stores that provide persistent context to sessions.</p>
        </div>
        <div className="toolbarActions">
          <button className="primaryButton" type="button" onClick={onNew}>
            <Plus size={18} />
            Create memory store
          </button>
          <a className="iconButton" href="https://github.com/sandbaseai/managed-agents/blob/main/docs/usage.md#memory-stores" target="_blank" rel="noreferrer" title="Documentation">
            <FileText size={18} />
          </a>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Stores', value: data.memoryStores.length, icon: <Database size={18} /> },
        { label: 'Active', value: activeStores, icon: <Check size={18} /> },
        { label: 'Memories', value: totalMemories, icon: <FileText size={18} /> },
      ]} />
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by name or exact ID"
        actions={(
          <>
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
      <div className="tablePanel resourceTablePanel">
        <table className="resourceTable">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => (
              <tr key={store.id} className="clickableRow" onClick={() => onOpenMemoryStore(store)}>
                <td><strong className="monoText">{shortId(store.id)}</strong></td>
                <td>{store.name}</td>
                <td><StatusPill status={store.status} /></td>
                <td>{formatDateShort(store.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {stores.length === 0 ? (
          <EmptyState
            icon={<Database size={22} />}
            title="No memory stores"
            body="Create a store to persist reusable context and mount it into future sessions."
            action={<button className="primaryButton" type="button" onClick={onNew}><Plus size={16} />Create memory store</button>}
          />
        ) : null}
      </div>
      <div className="mobileResourceList">
        {stores.map((store) => (
          <button className="mobileResourceCard" type="button" key={store.id} onClick={() => onOpenMemoryStore(store)}>
            <span className="mobileAgentMain">
              <strong>{store.name}</strong>
              <small className="monoText">{store.id}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{store.memories.length} memories</span>
              <StatusPill status={store.status} />
            </span>
          </button>
        ))}
        {stores.length === 0 ? (
          <EmptyState
            icon={<Database size={22} />}
            title="No memory stores"
            body="Create a store to persist reusable context and mount it into future sessions."
            action={<button className="primaryButton" type="button" onClick={onNew}><Plus size={16} />Create memory store</button>}
          />
        ) : null}
      </div>
    </section>
  );
}

export function MemoryStoreDetail({
  store,
  onBack,
  onRefresh,
  onNewMemory,
}: {
  store: MemoryStore;
  onBack: () => void;
  onRefresh: () => void;
  onNewMemory: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editStoreOpen, setEditStoreOpen] = useState(false);
  const [deleteStoreOpen, setDeleteStoreOpen] = useState(false);
  const selected = selectedId ? store.memories.find((memory) => memory.id === selectedId) ?? null : null;
  const [content, setContent] = useState(selected?.content ?? '');
  const totalBytes = store.memories.reduce((sum, memory) => sum + memory.content_size_bytes, 0);
  const latestMemory = [...store.memories].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];

  useEffect(() => {
    setSelectedId((current) => current && store.memories.some((memory) => memory.id === current) ? current : null);
  }, [store.id, store.memories]);

  useEffect(() => {
    setContent(selected?.content ?? '');
    setEditing(false);
    setVersionsFor(null);
  }, [selected?.id]);

  const save = async () => {
    if (!selected) return;
    await postJson(`/v1/memory_stores/${store.id}/memories/${selected.id}`, { content });
    setEditing(false);
    onRefresh();
  };

  const archiveStore = async () => {
    await postJson(`/v1/memory_stores/${store.id}/archive`, {});
    setMenuOpen(false);
    onBack();
    onRefresh();
  };

  return (
    <section className="environmentDetail memoryStoreDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>Memory stores</button>
        <span>/</span>
        <strong>{store.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{store.name}</h1>
            <StatusPill status={store.status} />
          </div>
          <p className="mutedLine"><span className="monoText">{shortId(store.id)}</span> · Created {formatDateShort(store.created_at)}</p>
          {store.description ? <p className="agentDescription">{store.description}</p> : null}
        </div>
        <div className="agentHeroActions">
          <button className="primaryButton largeAction" type="button" onClick={onNewMemory}>
            <Plus size={18} />
            Add memory
          </button>
          <button className="secondaryButton largeAction" type="button" onClick={() => setEditStoreOpen(true)}>
            <Pencil size={18} />
            Edit
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title="Store actions">
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button type="button" onClick={() => void archiveStore()}><Archive size={18} />Archive</button>
                <button
                  type="button"
                  className="dangerMenuItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteStoreOpen(true);
                  }}
                >
                  <Trash2 size={18} />Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Memories', value: store.memories.length, icon: <FileText size={18} /> },
        { label: 'Stored context', value: formatBytes(totalBytes), icon: <Database size={18} /> },
        { label: 'Last update', value: latestMemory ? formatDateShort(latestMemory.updated_at) : 'No memories', icon: <Check size={18} /> },
      ]} />
      <div className="resourceTruthStrip" aria-label="Memory store truth model">
        <div><span>Resource layer</span><strong>Memory Stores are attachable session resources, not the backend setting.</strong></div>
        <div><span>Content integrity</span><strong>Each record exposes size and SHA-256 metadata for review.</strong></div>
        <div><span>Mount semantics</span><strong>Sessions decide whether a store is read-only or read-write when mounted.</strong></div>
      </div>

      <div className="memoryBrowser tablePanel">
        <div className="memoryTree">
          <MemoryTree memories={store.memories} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        </div>
        <div className="memoryContent">
          {selected ? (
            <>
              <div className="memoryContentHeader">
                <div>
                  <h2>{selected.path}</h2>
                  <p>
                    <span className="monoText">{shortId(selected.id)}</span>
                    {' '}· {selected.content_size_bytes} B · sha256:{truncateMiddle(selected.content_sha256, 18)}
                    {' '}· Updated {formatDateShort(selected.updated_at)}
                  </p>
                </div>
                <div className="toolbarActions">
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => setVersionsFor((current) => current === selected.id ? null : selected.id)}
                    aria-expanded={versionsFor === selected.id}
                  >
                    <History size={16} />Versions
                  </button>
                  {editing ? (
                    <>
                      <button className="secondaryButton" type="button" onClick={() => { setEditing(false); setContent(selected.content ?? ''); }}><X size={16} />Cancel</button>
                      <button className="primaryButton" type="button" onClick={() => void save()}><Check size={16} />Save</button>
                    </>
                  ) : (
                    <button className="secondaryButton" type="button" onClick={() => setEditing(true)}><Pencil size={18} />Edit</button>
                  )}
                </div>
              </div>
              {versionsFor === selected.id ? (
                <MemoryVersionsPanel
                  storeId={store.id}
                  memory={selected}
                  onRedacted={onRefresh}
                />
              ) : null}
              {editing ? (
                <textarea className="memoryEditor" value={content} onChange={(event) => setContent(event.target.value)} />
              ) : (
                <pre className="memoryPreview">{selected.content}</pre>
              )}
            </>
          ) : store.memories.length === 0 ? (
            <EmptyState
              icon={<FileText size={24} />}
              title="No memories yet"
              body="Add the first memory entry to make this store useful when mounted into a session."
              action={<button className="secondaryButton" type="button" onClick={onNewMemory}><Plus size={16} />Add memory</button>}
            />
          ) : (
            <EmptyState icon={<Database size={24} />} title="Select a memory" body="Choose an entry from the left to inspect its content, hash, and update history." />
          )}
        </div>
      </div>
      {editStoreOpen ? (
        <MemoryStoreEditModal
          store={store}
          onClose={() => setEditStoreOpen(false)}
          onSaved={() => {
            setEditStoreOpen(false);
            onRefresh();
          }}
        />
      ) : null}
      {deleteStoreOpen ? (
        <MemoryStoreDeleteModal
          store={store}
          onClose={() => setDeleteStoreOpen(false)}
          onDeleted={() => {
            setDeleteStoreOpen(false);
            onBack();
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function MemoryStoreEditModal({ store, onClose, onSaved }: { store: MemoryStore; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // The published update verb is POST with patch semantics: only the
      // fields the operator changed are merged server-side.
      await postJson(`/v1/memory_stores/${store.id}`, { name, description });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit memory store" onClose={onClose} size="medium">
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
          <small>1-255 characters.</small>
        </label>
        <label className="editField">
          Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="darkButton largeAction" type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

function MemoryStoreDeleteModal({ store, onClose, onDeleted }: { store: MemoryStore; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteJson(`/v1/memory_stores/${store.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete memory store" onClose={onClose}>
      <div className="modalForm">
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <p>
          Permanently delete <strong>{store.name}</strong> and its {store.memories.length} {store.memories.length === 1 ? 'memory' : 'memories'}?
          A store mounted by an active session cannot be deleted.
        </p>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="dangerButton" type="button" onClick={() => void remove()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete memory store'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The version history of one memory. Every write records a version, so this
 * panel is where the published redaction action lives: redacting clears the
 * recorded payload while keeping the version listable — except the head
 * version, whose redaction would orphan the memory's current content and is
 * refused with `memory_version_is_head`.
 */
function MemoryVersionsPanel({ storeId, memory, onRedacted }: { storeId: string; memory: MemoryRecord; onRedacted: () => void }) {
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [error, setError] = useState('');
  const [redactingId, setRedactingId] = useState<string | null>(null);

  const load = () => {
    getJson<{ data: MemoryVersion[] } | MemoryVersion[]>(
      `/v1/memory_stores/${storeId}/memory_versions?memory_id=${encodeURIComponent(memory.id)}`,
    )
      .then((page) => setVersions(Array.isArray(page) ? page : page.data ?? []))
      .catch((err: any) => setError(err?.message ?? 'Could not load versions'));
  };

  useEffect(load, [storeId, memory.id]);

  const redact = async (version: MemoryVersion) => {
    setRedactingId(version.id);
    setError('');
    try {
      await postJson(`/v1/memory_stores/${storeId}/memory_versions/${version.id}/redact`, {});
      load();
      onRedacted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRedactingId(null);
    }
  };

  if (error && !versions) return <div className="banner error inlineBanner" role="alert">{error}</div>;
  if (!versions) return <p className="mutedValue">Loading versions…</p>;
  if (versions.length === 0) return <p className="mutedValue">No versions recorded.</p>;

  return (
    <div className="memoryVersions">
      {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
      <table className="deliveriesTable">
        <thead>
          <tr><th>Version</th><th>Operation</th><th>Size</th><th>Created</th><th>Redacted</th><th>Action</th></tr>
        </thead>
        <tbody>
          {versions.map((version) => {
            const isHead = version.id === memory.memory_version_id;
            return (
              <tr key={version.id}>
                <td><code>{truncateMiddle(version.id, 18)}</code>{isHead ? <small className="mutedValue"> (current)</small> : null}</td>
                <td><code>{version.operation}</code></td>
                <td>{version.content_size_bytes !== null ? `${version.content_size_bytes} B` : '-'}</td>
                <td>{formatDateShort(version.created_at)}</td>
                <td>{version.redacted_at ? formatDateShort(version.redacted_at) : '-'}</td>
                <td>
                  <button
                    className="ghostButton compactButton"
                    type="button"
                    disabled={isHead || Boolean(version.redacted_at) || redactingId === version.id}
                    title={isHead ? 'Cannot redact the current version' : version.redacted_at ? 'Already redacted' : 'Redact this version'}
                    onClick={() => void redact(version)}
                  >
                    {redactingId === version.id ? 'Redacting…' : 'Redact'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MemoryTree({ memories, selectedId, onSelect }: { memories: MemoryRecord[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const groups = useMemo(() => groupMemoriesByFolder(memories), [memories]);
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={22} />}
        title="No memories"
        body="Entries will appear here grouped by path after you add them."
      />
    );
  }
  return (
    <>
      {groups.map((group) => (
        <div className="memoryFolder" key={group.folder}>
          <div className="memoryFolderTitle">
            <ChevronDown size={16} />
            <Database size={16} />
            <span>{group.folder}</span>
          </div>
          {group.items.map((memory) => (
            <button
              type="button"
              key={memory.id}
              className={`memoryNode ${selectedId === memory.id ? 'active' : ''}`}
              onClick={() => onSelect(memory.id)}
            >
              <FileText size={15} />
              <span>{memoryName(memory.path)}</span>
              <small>{memory.content_size_bytes} B</small>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function groupMemoriesByFolder(memories: MemoryRecord[]): Array<{ folder: string; items: MemoryRecord[] }> {
  const folders = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const segments = memory.path.split('/').filter(Boolean);
    const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : 'root';
    const items = folders.get(folder) ?? [];
    items.push(memory);
    folders.set(folder, items);
  }
  return [...folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([folder, items]) => ({ folder, items: items.sort((left, right) => left.path.localeCompare(right.path)) }));
}

function memoryName(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
