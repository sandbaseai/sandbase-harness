import { Check, ChevronDown, Database, FileText, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { postJson } from '../../api';
import { EmptyState, FilterSelect, StatusPill, SummaryStrip, Toolbar } from '../Common';
import { formatBytes, formatDateShort, shortId, truncateMiddle } from '../../lib/format';
import type { ConsoleData, MemoryRecord, MemoryStore } from '../../types';

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
  }, [selected?.id]);

  const save = async () => {
    if (!selected) return;
    await postJson(`/v1/memory_stores/${store.id}/memories/${selected.id}`, { content });
    setEditing(false);
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
        <button className="primaryButton largeAction" type="button" onClick={onNewMemory}>
          <Plus size={18} />
          Add memory
        </button>
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
                {editing ? (
                  <div className="toolbarActions">
                    <button className="secondaryButton" type="button" onClick={() => { setEditing(false); setContent(selected.content ?? ''); }}><X size={16} />Cancel</button>
                    <button className="primaryButton" type="button" onClick={() => void save()}><Check size={16} />Save</button>
                  </div>
                ) : (
                  <button className="secondaryButton" type="button" onClick={() => setEditing(true)}><Pencil size={18} />Edit</button>
                )}
              </div>
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
    </section>
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
