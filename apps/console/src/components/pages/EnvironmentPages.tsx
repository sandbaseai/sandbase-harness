import { Archive, Copy, Globe, ListChecks, MoreVertical, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { deleteJson, getJson, postJson, putJson } from '../../api';
import { EmptyState, Kpi, KpiStrip, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { ConfirmDeleteModal } from '../DangerZone';
import { Modal } from '../Modal';
import { ListToolbar, listSummary, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import { copyText, formatDateShort, shortId } from '../../lib/format';
import type { ConsoleData, Environment, EnvironmentDraft, EnvironmentWorkItem, EnvironmentWorkStats, MetadataDraft } from '../../types';
import { CloudEnvironment, ReadonlyTable, SelfHostedEnvironment } from './EnvironmentDetailViews';
import {
  environmentDraftFromApi,
  environmentHostingType,
  environmentPayloadFromDraft,
  PACKAGE_MANAGERS,
} from './EnvironmentPageModel';
import './resources.css';

export function Environments({ data, onNew, onOpenEnvironment }: { data: ConsoleData; onNew: () => void; onOpenEnvironment: (environment: Environment) => void }) {
  const { t } = useTranslation('environments');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const environments = data.environments.filter((environment) => {
    const q = query.toLowerCase();
    const environmentStatus = environment.archived_at ? 'archived' : 'active';
    const matchesStatus = status === 'all' || environmentStatus === status;
    const matchesQuery = environment.id.toLowerCase().includes(q) || environment.name.toLowerCase().includes(q) || (environment.description ?? '').toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const filtering = Boolean(query) || status !== 'all';
  const kindLabel = (environment: Environment) => t(`kind.${environmentHostingType(environment)}`);
  const emptyState = (
    <EmptyState
      icon={Server}
      title={data.environments.length && filtering ? t('list.noMatch') : t('list.empty')}
      action={query ? <button className="button outline" type="button" onClick={() => setQuery('')}>{tCommon('actions.clearSearch')}</button> : null}
    />
  );

  return (
    <section className="page-section console-page environments-list-page" aria-labelledby="environments-heading">
      <PageHeader
        headingId="environments-heading"
        title={tPages('environments.title')}
        help={tPages('environments.description')}
        actions={(
          <button className="button primary" type="button" onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
            {tPages('environments.newEnvironment')}
          </button>
        )}
      />
      <PageBody>
        <ListToolbar
          label={t('list.filterLabel')}
          summary={listSummary(tCommon, environments.length, data.environments.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('list.searchPlaceholder')} label={t('list.filterLabel')} />
          <ConsoleSelect
            label={t('list.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: t('list.statusOptions.all') },
              { value: 'active', label: t('list.statusOptions.active') },
              { value: 'archived', label: t('list.statusOptions.archived') },
            ]}
          />
        </ListToolbar>
        {environments.length ? (
          <div className="table-frame environments-table-frame">
            <table className="data-table" aria-label={tPages('environments.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('list.columns.id')}</th>
                  <th scope="col">{t('list.columns.name')}</th>
                  <th scope="col">{t('list.columns.status')}</th>
                  <th scope="col">{t('list.columns.type')}</th>
                  <th scope="col">{t('list.columns.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {environments.map((environment) => (
                  <tr key={environment.id} className="clickable-row" onClick={() => onOpenEnvironment(environment)}>
                    <td><strong className="monoText">{shortId(environment.id)}</strong></td>
                    <td>{environment.name}</td>
                    <td><StatusDot tone={environment.archived_at ? 'neutral' : 'ok'} label={t(environment.archived_at ? 'list.statusOptions.archived' : 'list.statusOptions.active')} /></td>
                    <td>{kindLabel(environment)}</td>
                    <td>{formatDateShort(environment.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : emptyState}
        <div className="mobileResourceList">
          {environments.map((environment) => (
            <button className="mobileResourceCard" type="button" key={environment.id} onClick={() => onOpenEnvironment(environment)} aria-label={t('list.open', { name: environment.name })}>
              <span className="mobileAgentMain">
                <strong>{environment.name}</strong>
                <small className="monoText">{environment.id}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{kindLabel(environment)}</span>
                <StatusDot tone={environment.archived_at ? 'neutral' : 'ok'} label={t(environment.archived_at ? 'list.statusOptions.archived' : 'list.statusOptions.active')} />
              </span>
            </button>
          ))}
          {environments.length === 0 ? emptyState : null}
        </div>
      </PageBody>
    </section>
  );
}

export function EnvironmentDetail({ environment, data, onBack, onRefresh }: { environment: Environment; data: ConsoleData; onBack: () => void; onRefresh: () => void }) {
  const { t } = useTranslation('environments');
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [workQueueOpen, setWorkQueueOpen] = useState(false);
  const environmentSessions = data.sessions.filter((session) => session.environment_id === environment.id);
  const isSelfHosted = environmentHostingType(environment) === 'self_hosted';

  useEffect(() => {
    setEditing(false);
    setMenuOpen(false);
    setDeleteOpen(false);
    setWorkQueueOpen(false);
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
        data={data}
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
        <button type="button" className="textButton" onClick={onBack}>{t('detail.back')}</button>
        <span>/</span>
        <strong>{environment.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{environment.name}</h1>
            <span className="softChip inlineChip">{t(`kind.${environmentHostingType(environment)}`)}</span>
            <Globe size={19} className="mutedIcon" />
            <button className="iconButton" type="button" title={t('detail.copyId')} aria-label={t('detail.copyId')} onClick={() => void copyText(environment.id)}><Copy size={16} /></button>
          </div>
          <p className="mutedLine"><span className="monoText">{shortId(environment.id)}</span> · {t('detail.updatedAgo', { time: formatDateShort(environment.updated_at) })}</p>
          <p className="agentDescription">{environment.description || t('detail.noDescription')}</p>
        </div>
        <div className="agentHeroActions">
          <button className="button outline largeAction" type="button" onClick={() => setEditing(true)}>
            <Pencil size={15} />
            {t('detail.edit')}
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title={t('detail.actions')}>
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setWorkQueueOpen(true);
                  }}
                >
                  <ListChecks size={18} />{t('detail.workQueue.action')}
                </button>
                <button type="button" onClick={() => void archive()}><Archive size={18} />{t('detail.archive')}</button>
                <button
                  type="button"
                  className="dangerMenuItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 size={18} />{t('detail.delete')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isSelfHosted ? <SelfHostedEnvironment environment={environment} sessions={environmentSessions} /> : <CloudEnvironment environment={environment} />}
      {deleteOpen ? (
        <EnvironmentDeleteModal
          environment={environment}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            onBack();
            onRefresh();
          }}
        />
      ) : null}
      {workQueueOpen ? (
        <EnvironmentWorkQueueModal environment={environment} onClose={() => setWorkQueueOpen(false)} />
      ) : null}
    </section>
  );
}

function workStateTone(state: EnvironmentWorkItem['state']): Tone {
  if (state === 'active') return 'ok';
  if (state === 'queued' || state === 'starting') return 'warning';
  return 'neutral';
}

/**
 * The environment's work queue: the published stats counter row plus the
 * paged item listing. Read-only on purpose — claim/ack/stop stay on the
 * worker side of the protocol; an operator only watches the backlog here.
 */
function EnvironmentWorkQueueModal({ environment, onClose }: { environment: Environment; onClose: () => void }) {
  const { t } = useTranslation('environments');
  const { t: tCommon, i18n } = useTranslation();
  const [stats, setStats] = useState<EnvironmentWorkStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const paged = usePagedCollection<EnvironmentWorkItem>(
    `/v1/x/environments/${encodeURIComponent(environment.id)}/work?limit=50`,
  );

  useEffect(() => {
    let cancelled = false;
    getJson<EnvironmentWorkStats>(`/v1/x/environments/${encodeURIComponent(environment.id)}/work/stats`)
      .then((value) => { if (!cancelled) setStats(value); })
      .catch((err) => { if (!cancelled) setStatsError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [environment.id]);

  return (
    <Modal
      title={t('detail.workQueue.title', { name: environment.name })}
      onClose={onClose}
      footer={paged.hasMore ? (
        <button className="button outline" type="button" onClick={paged.loadMore} disabled={paged.loadingMore}>
          {tCommon('actions.loadMore')}
        </button>
      ) : null}
    >
      <>
        {stats ? (
          <KpiStrip label={t('detail.workQueue.stats')}>
            <Kpi label={t('detail.workQueue.depth')} value={stats.depth} />
            <Kpi label={t('detail.workQueue.pending')} value={stats.pending} />
            <Kpi label={t('detail.workQueue.workers')} value={stats.workers_polling} />
            <Kpi label={t('detail.workQueue.oldest')} value={stats.oldest_queued_at ? formatDateShort(stats.oldest_queued_at) : '—'} />
          </KpiStrip>
        ) : statsError ? (
          <p className="mutedLine" role="alert">{statsError}</p>
        ) : null}
        {paged.error ? <p className="mutedLine" role="alert">{paged.error}</p> : null}
        {paged.items.length ? (
          <div className="table-frame">
            <table className="data-table" aria-label={t('detail.workQueue.title', { name: environment.name })}>
              <thead>
                <tr>
                  <th scope="col">{t('detail.workQueue.columns.id')}</th>
                  <th scope="col">{t('detail.workQueue.columns.session')}</th>
                  <th scope="col">{t('detail.workQueue.columns.state')}</th>
                  <th scope="col">{t('detail.workQueue.columns.created')}</th>
                  <th scope="col">{t('detail.workQueue.columns.heartbeat')}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((item) => (
                  <tr key={item.id}>
                    <td><strong className="monoText">{shortId(item.id)}</strong></td>
                    <td><span className="monoText">{shortId(item.data.id)}</span></td>
                    <td><StatusDot tone={workStateTone(item.state)} label={t(`detail.workQueue.states.${item.state}`)} /></td>
                    <td>{formatDateShort(item.created_at)}</td>
                    <td>{item.latest_heartbeat_at ? formatDateShort(item.latest_heartbeat_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !paged.loading && !paged.error ? (
          <p className="mutedLine">{t('detail.workQueue.empty')}</p>
        ) : null}
      </>
    </Modal>
  );
}

function EnvironmentDeleteModal({ environment, onClose, onDeleted }: { environment: Environment; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation('environments');
  return (
    <ConfirmDeleteModal
      title={t('detail.deleteTitle')}
      subject={environment.name}
      consequence={t('detail.deleteConsequence')}
      confirmLabel={t('detail.deleteConfirm')}
      onClose={onClose}
      onConfirm={async () => {
        await deleteJson(`/v1/environments/${environment.id}`);
        onDeleted();
      }}
    />
  );
}

function EnvironmentEditor({ environment, data, onCancel, onSaved }: { environment: Environment; data: ConsoleData; onCancel: () => void; onSaved: () => void }) {
  const { t } = useTranslation('environments');
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
        <button type="button" className="textButton" onClick={onCancel}>{t('detail.back')}</button>
        <span>/</span>
        <strong>{environment.name}</strong>
      </div>
      {error ? <div className="banner error inlineBanner">{error}</div> : null}
      <div className="resourceHero editHero">
        <div className="editTitleGroup">
          <input className="titleInput" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value.slice(0, 50) })} />
          <span className="softChip inlineChip">{t(`kind.${draft.hostingType}`)}</span>
          <Globe size={19} className="mutedIcon" />
        </div>
        <div className="agentHeroActions">
          <button className="button outline largeAction" type="button" onClick={onCancel}>{t('detail.cancel')}</button>
          <button className="button primary largeAction" type="button" onClick={() => void save()} disabled={saving || !draft.name.trim()}>{t('detail.save')}</button>
        </div>
      </div>

      <label className="editField">
        {t('detail.description')}
        <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={t('detail.descriptionPlaceholder')} />
      </label>

      <div className="environmentBody">
        <EnvironmentExecutionEditor draft={draft} onDraft={setDraft} />
        <EnvironmentPackagesEditor draft={draft} onDraft={setDraft} />
        <EnvironmentMetadataEditor draft={draft} onDraft={setDraft} />
        {draft.hostingType === 'self_hosted' ? <SelfHostedEnvironment environment={environment} sessions={[]} /> : null}
      </div>
    </section>
  );
}

/**
 * One input per package manager — the published `config.packages` object is a
 * `{ type: "packages", apt: [...], ... }` map, so the editor edits each
 * manager's list rather than a flat `{manager, package}` row array.
 */
export function EnvironmentPackagesEditor({ draft, onDraft }: { draft: EnvironmentDraft; onDraft: (draft: EnvironmentDraft) => void }) {
  const { t } = useTranslation('environments');
  return (
    <section className="environmentSection">
      <div>
        <h2>{t('detail.packages.title')}</h2>
        <p>{t('detail.packages.hint')}</p>
      </div>
      <div className="environmentNestedGrid">
        {PACKAGE_MANAGERS.map(({ id, label }) => (
          <label className="editField" key={id}>
            {label}
            <input
              value={draft.packages[id]}
              onChange={(event) => onDraft({ ...draft, packages: { ...draft.packages, [id]: event.target.value } })}
              placeholder={id === 'npm' ? 'tsx, zod' : id === 'pip' ? 'requests' : ''}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function EnvironmentExecutionEditor({ draft, onDraft }: { draft: EnvironmentDraft; onDraft: (draft: EnvironmentDraft) => void }) {
  const { t } = useTranslation('environments');
  return (
    <section className="environmentSection environmentExecutionSection">
      <div>
        <h2>{t('detail.execution.title')}</h2>
        <p>{t('detail.execution.hint')}</p>
      </div>
      <div className="editField">
        <span>{t('detail.execution.hostingType')}</span>
        <ConsoleSelect
          label={t('detail.execution.hostingType')}
          value={draft.hostingType}
          onChange={(value) => onDraft({ ...draft, hostingType: value as EnvironmentDraft['hostingType'] })}
          options={[
            { value: 'cloud', label: t('detail.execution.hostingOptions.cloud') },
            { value: 'local', label: t('detail.execution.hostingOptions.local') },
            { value: 'docker', label: t('detail.execution.hostingOptions.docker') },
            { value: 'kubernetes', label: t('detail.execution.hostingOptions.kubernetes') },
            { value: 'self_hosted', label: t('detail.execution.hostingOptions.self_hosted') },
          ]}
        />
      </div>
      {draft.hostingType === 'cloud' ? (
        <div className="subtleNotice">
          <Trans
            i18nKey="detail.execution.cloudNotice"
            ns="environments"
            components={{ code: <code /> }}
          />
        </div>
      ) : null}
      {draft.hostingType === 'local' ? (
        <div className="warningNotice"><span>{t('detail.execution.localWarning')}</span></div>
      ) : null}
      {draft.hostingType === 'docker' ? (
        <div className="environmentNestedGrid">
          <label className="editField">
            {t('detail.execution.dockerImage')}
            <input
              value={draft.dockerImage}
              onChange={(event) => onDraft({ ...draft, dockerImage: event.target.value })}
              placeholder="ghcr.io/sandbaseai/sandbase-harness-sandbox:latest"
            />
            <small>{t('detail.execution.dockerImageHint')}</small>
          </label>
          <label className="editField">
            {t('detail.execution.memoryLimit')}
            <input
              value={draft.dockerMemory}
              onChange={(event) => onDraft({ ...draft, dockerMemory: event.target.value })}
              placeholder="512m"
            />
            <small>{t('detail.execution.memoryLimitHint')}</small>
          </label>
          <label className="editField">
            {t('detail.execution.cpuLimit')}
            <input
              inputMode="decimal"
              value={draft.dockerCpu}
              onChange={(event) => onDraft({ ...draft, dockerCpu: event.target.value })}
              placeholder="1"
            />
            <small>{t('detail.execution.cpuLimitHint')}</small>
          </label>
        </div>
      ) : null}
      {draft.hostingType === 'self_hosted' ? (
        <div className="subtleNotice">{t('detail.execution.selfHostedNotice')}</div>
      ) : null}
    </section>
  );
}

function EnvironmentMetadataEditor({ draft, onDraft }: { draft: EnvironmentDraft; onDraft: (draft: EnvironmentDraft) => void }) {
  const { t } = useTranslation('environments');
  const updateMetadata = (id: string, patch: Partial<MetadataDraft>) => {
    onDraft({ ...draft, metadata: draft.metadata.map((item) => item.id === id ? { ...item, ...patch } : item) });
  };
  return (
      <section className="environmentSection editableListSection">
        <div className="sectionHeaderRow">
          <div>
            <h2>{t('detail.metadata.title')}</h2>
            <p>{t('detail.metadata.hint')}</p>
          </div>
          <button className="iconButton" type="button" aria-label={t('detail.metadata.add')} onClick={() => onDraft({ ...draft, metadata: [...draft.metadata, { id: newDraftId(), key: '', value: '' }] })}><Plus size={18} /></button>
        </div>
        {draft.metadata.length === 0 ? <ReadonlyTable empty={t('detail.metadata.empty')} rows={[]} columns={[t('detail.metadata.keyColumn'), t('detail.metadata.valueColumn')]} /> : null}
        {draft.metadata.map((item) => (
          <div className="editableRow metadataRow" key={item.id}>
            <input value={item.key} onChange={(event) => updateMetadata(item.id, { key: event.target.value.toLowerCase() })} placeholder={t('detail.metadata.keyPlaceholder')} />
            <input value={item.value} onChange={(event) => updateMetadata(item.id, { value: event.target.value })} placeholder={t('detail.metadata.valuePlaceholder')} />
            <button className="iconButton quiet" type="button" onClick={() => onDraft({ ...draft, metadata: draft.metadata.filter((candidate) => candidate.id !== item.id) })}><Trash2 size={18} /></button>
          </div>
        ))}
      </section>
  );
}

function newDraftId() {
  return `draft_${Math.random().toString(36).slice(2, 10)}`;
}
