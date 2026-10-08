import { ChangeEvent, DragEvent, FormEvent, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, FileText, Plus, Trash2, Upload, X, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deleteJson, postForm } from '../../api';
import type { ConsoleData, Skill, WorkspaceFile } from '../../types';
import { ConfirmDeleteModal } from '../DangerZone';
import { EmptyState, PageBody, PageHeader } from '../console-ui';
import { ListToolbar, listSummary, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { Modal } from '../Modal';
import { formatBytes, formatDateShort, formatDateWithYear, shortId } from '../../lib/format';
import './build.css';

export function Skills({ data, onRefresh }: { data: ConsoleData; onRefresh: () => void }) {
  const { t } = useTranslation('skills');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | Skill['source']>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.skills.filter((skill) => {
      const sourceMatches = source === 'all' || skill.source === source;
      const queryMatches = !q
        || skill.id.toLowerCase().includes(q)
        || skill.name.toLowerCase().includes(q)
        || skillDisplayName(skill).toLowerCase().includes(q)
        || skill.description.toLowerCase().includes(q)
        || skill.compatibility?.toLowerCase().includes(q);
      return sourceMatches && queryMatches;
    });
  }, [data.skills, query, source]);
  const selected = selectedId ? filtered.find((skill) => skill.id === selectedId) ?? null : null;

  return (
    <section className="page-section console-page skills-page" aria-labelledby="skills-heading">
      <PageHeader
        headingId="skills-heading"
        title={tPages('skills.title')}
        help={tPages('skills.description')}
        actions={(
          <>
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />
              {tPages('skills.newSkill')}
            </button>
            <a className="icon-button" href="https://github.com/sandbaseai/managed-agents/blob/main/docs/skills.md" target="_blank" rel="noreferrer" title={t('view.docs')} aria-label={t('view.docs')}>
              <FileText size={17} aria-hidden="true" />
            </a>
          </>
        )}
      />
      <PageBody>
        <ListToolbar
          label={t('view.filterLabel')}
          summary={listSummary(tCommon, filtered.length, data.skills.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('view.searchPlaceholder')} label={t('view.filterLabel')} />
          <ConsoleSelect
            label={t('view.source')}
            value={source}
            onChange={(value) => setSource(value as 'all' | Skill['source'])}
            options={[
              { value: 'all', label: t('view.sourceOptions.all') },
              { value: 'anthropic', label: t('view.sourceOptions.anthropic') },
              { value: 'custom', label: t('view.sourceOptions.custom') },
            ]}
          />
        </ListToolbar>

        <div className={`skillsLayout${selected ? ' hasDrawer' : ''}`}>
          {filtered.length ? (
            <div className="table-frame skill-table-frame">
              <table className="data-table" aria-label={tPages('skills.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('view.columns.id')}</th>
                    <th scope="col">{t('view.columns.name')}</th>
                    <th scope="col">{t('view.columns.source')}</th>
                    <th scope="col">{t('view.columns.latestVersion')}</th>
                    <th scope="col">{t('view.columns.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((skill) => (
                    <tr
                      key={skill.id}
                      className={`clickable-row ${selected?.id === skill.id ? 'selected-row' : ''}`}
                      onClick={() => setSelectedId(skill.id)}
                    >
                      <td><code>{skill.id}</code></td>
                      <td><strong>{skillDisplayName(skill)}</strong></td>
                      <td><SourceBadge source={skill.source} /></td>
                      <td>{formatSkillLatestVersion(skill)}</td>
                      <td>{formatDateShort(skill.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Zap} title={t('view.noSkills')} />
          )}

          {selected ? (
            <SkillDetailsDrawer
              skill={selected}
              onClose={() => setSelectedId(null)}
              onChanged={onRefresh}
              onDeleted={() => {
                setSelectedId(null);
                onRefresh();
              }}
            />
          ) : null}
        </div>
      </PageBody>

      {createOpen ? (
        <CreateSkillModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function SkillDetailsDrawer({ skill, onClose, onChanged, onDeleted }: { skill: Skill; onClose: () => void; onChanged: () => void; onDeleted: () => void }) {
  const { t } = useTranslation('skills');
  const [deleteSkillOpen, setDeleteSkillOpen] = useState(false);
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  // Built-in skills ship with the catalog; the route refuses their deletion,
  // so the drawer never offers the affordance for them.
  const deletable = skill.source === 'custom';
  return (
    <aside className="skillDrawer">
      <div className="drawerHeader">
        <div>
          <div className="titleLine compact">
            <h2>{skillDisplayName(skill)}</h2>
            <SourceBadge source={skill.source} />
          </div>
          <p>{formatDateShort(skill.updated_at)} · <code>{skill.id}</code></p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} title={t('detail.close')} aria-label={t('detail.close')}><X size={17} aria-hidden="true" /></button>
      </div>
      <div className="drawerBody">
        <p>{skill.description}</p>
        {skill.compatibility ? (
          <div className="infoBanner">
            <strong>{t('detail.compatibility')}</strong>
            <span>{skill.compatibility}</span>
          </div>
        ) : null}
        <dl className="drawerMetaGrid">
          <dt>{t('detail.source')}</dt>
          <dd>{skill.source === 'anthropic' ? t('view.sourceOptions.anthropic') : t('view.sourceOptions.custom')}</dd>
          <dt>{t('detail.latestVersion')}</dt>
          <dd>{formatSkillLatestVersion(skill)}</dd>
          <dt>{t('detail.package')}</dt>
          <dd><code>{skillPackageName(skill) ?? '-'}</code></dd>
          <dt>{t('detail.file')}</dt>
          <dd><code>{skill.file ?? '-'}</code></dd>
        </dl>
        <div className="skillVersionSection">
          <h3>{t('detail.versions')}</h3>
          <div className="skillVersionList">
            {skill.versions.map((version) => (
              <div className="skillVersionRow" key={version.id}>
                <code>{version.id}</code>
                <small>{formatDateShort(version.created_at)}</small>
                {version.latest ? <b>{t('detail.latest')}</b> : null}
                {deletable ? (
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => setDeletingVersionId(version.id)}
                    title={t('detail.deleteVersion')}
                    aria-label={t('detail.deleteVersion')}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
            {skill.versions.length === 0 ? <div className="emptyInline">{t('detail.noVersions')}</div> : null}
          </div>
        </div>
        {deletable ? (
          <div className="drawerActions">
            <button className="button outline danger" type="button" onClick={() => setDeleteSkillOpen(true)}>
              <Trash2 size={14} aria-hidden="true" /> {t('detail.deleteSkill')}
            </button>
          </div>
        ) : null}
      </div>
      {deleteSkillOpen ? (
        <ConfirmDeleteModal
          title={t('detail.deleteSkillTitle')}
          subject={skillDisplayName(skill)}
          consequence={t('detail.deleteSkillConsequence')}
          onClose={() => setDeleteSkillOpen(false)}
          onConfirm={async () => {
            await deleteJson(`/v1/skills/${encodeURIComponent(skill.id)}`);
            onDeleted();
          }}
        />
      ) : null}
      {deletingVersionId ? (
        <ConfirmDeleteModal
          title={t('detail.deleteVersionTitle')}
          subject={deletingVersionId}
          consequence={t('detail.deleteVersionConsequence')}
          onClose={() => setDeletingVersionId(null)}
          onConfirm={async () => {
            await deleteJson(`/v1/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(deletingVersionId)}`);
            setDeletingVersionId(null);
            onChanged();
          }}
        />
      ) : null}
    </aside>
  );
}

function CreateSkillModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('skills');
  const packageInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Array<{ file: File; path: string }>>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = selectedFiles.length > 0;

  const pickFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setSelectedFiles(files.map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })));
    setError('');
  };

  const onPackageChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    pickFiles(event.dataTransfer.files);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const body = new FormData();
      for (const item of selectedFiles) {
        body.append('files', item.file, item.path);
      }
      await postForm('/v1/skills', body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('create.title')} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? (
          <div className="formAlert error" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        <input
          ref={packageInputRef}
          className="hiddenFileInput"
          type="file"
          accept=".zip,.skill,application/zip"
          onChange={onPackageChange}
        />
        <div
          className={`skillUploadDropzone ${dragActive ? 'dragActive' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          <Upload size={24} aria-hidden="true" />
          <strong>{t('create.dropTitle')}</strong>
          <span>{t('create.dropHint')}</span>
          <div className="skillUploadActions">
            <button className="button outline" type="button" onClick={() => packageInputRef.current?.click()}>
              {t('create.selectFile')}
            </button>
          </div>
        </div>
        {selectedFiles.length > 0 ? (
          <div className="skillUploadFile">
            <FileText size={18} aria-hidden="true" />
            <div>
              <strong>{selectedFiles[0].path}</strong>
              <span>{t('create.fileCount', { count: selectedFiles.length })} · {formatBytes(selectedFiles.reduce((total, item) => total + item.file.size, 0))}</span>
            </div>
            <button className="icon-button" type="button" onClick={() => setSelectedFiles([])} title={t('create.removeUpload')} aria-label={t('create.removeUpload')}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="modalActions">
          <button className="button primary" type="submit" disabled={!canSave || saving}>
            {saving ? t('create.creating') : t('create.continue')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SourceBadge({ source }: { source: Skill['source'] }) {
  const { t } = useTranslation('skills');
  return <span className={`sourceBadge ${source}`}>{source === 'anthropic' ? t('view.sourceOptions.anthropic') : t('view.sourceOptions.custom')}</span>;
}

function skillDisplayName(skill: Skill): string {
  return skill.display_title || skill.name || skillPackageName(skill) || skill.id;
}

function skillPackageName(skill: Skill): string | null {
  if (!skill.file) return null;
  return skill.file.split('/').filter(Boolean)[0] ?? null;
}

function formatSkillLatestVersion(skill: Skill): string {
  const version = skill.latest_version;
  if (!version) return '-';
  if (/^\d{8}$/.test(version)) {
    return formatDateWithYear(`${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T00:00:00.000Z`);
  }
  if (/^\d{12,}$/.test(version)) {
    const timestamp = Number(version);
    if (Number.isFinite(timestamp)) return formatDateWithYear(new Date(timestamp).toISOString());
  }
  return skill.updated_at ? formatDateWithYear(skill.updated_at) : version;
}

export function Files({ data, onRefresh }: { data: ConsoleData; onRefresh: () => void }) {
  const { t } = useTranslation('files');
  const { t: tPages } = useTranslation('pages');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [archiving, setArchiving] = useState<WorkspaceFile | null>(null);
  const files = useMemo(() => [...data.files].sort((a, b) => b.created_at.localeCompare(a.created_at)), [data.files]);

  const uploadFiles = async (fileList: FileList | null) => {
    const uploads = Array.from(fileList ?? []);
    if (uploads.length === 0) return;
    setUploading(true);
    setError('');
    try {
      for (const file of uploads) {
        const body = new FormData();
        body.append('file', file, file.name);
        await postForm<WorkspaceFile>('/v1/files', body);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const onUploadChange = (event: ChangeEvent<HTMLInputElement>) => {
    void uploadFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  };

  return (
    <section className="page-section console-page files-page" aria-labelledby="files-heading">
      <PageHeader
        headingId="files-heading"
        title={tPages('files.title')}
        help={tPages('files.description')}
        actions={(
          <>
            <input ref={inputRef} className="hiddenFileInput" type="file" multiple onChange={onUploadChange} />
            <button className="button primary" type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
              <Upload size={15} aria-hidden="true" />
              {uploading ? t('view.uploading') : t('view.upload')}
            </button>
            <a className="icon-button" href="https://github.com/sandbaseai/managed-agents/blob/main/docs/api.md#files" target="_blank" rel="noreferrer" title={t('view.docs')} aria-label={t('view.docs')}>
              <FileText size={17} aria-hidden="true" />
            </a>
          </>
        )}
      />
      <PageBody>
        {error ? (
          <div className="formAlert error fileUploadError" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {files.length ? (
          <div className="table-frame files-table-frame">
            <table className="data-table" aria-label={tPages('files.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('view.columns.id')}</th>
                  <th scope="col">{t('view.columns.name')}</th>
                  <th scope="col">{t('view.columns.size')}</th>
                  <th scope="col">{t('view.columns.created')}</th>
                  <th scope="col"><span className="visually-hidden">{t('view.columns.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td><code>{shortId(file.id)}</code></td>
                    <td><strong>{file.name}</strong></td>
                    <td>{formatBytes(file.size_bytes)}</td>
                    <td>{formatDateShort(file.created_at)}</td>
                    <td className="row-actions-cell">
                      <a className="icon-button" href={`/v1/files/${encodeURIComponent(file.id)}/content`} download={file.name} title={t('view.download')} aria-label={t('view.download')}>
                        <Download size={15} aria-hidden="true" />
                      </a>
                      <button className="icon-button" type="button" onClick={() => setArchiving(file)} title={t('view.archive')} aria-label={t('view.archive')}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={FileText} title={t('view.noFiles')} />
        )}
      </PageBody>
      {archiving ? (
        <ConfirmDeleteModal
          title={t('view.archiveTitle')}
          subject={archiving.name}
          consequence={t('view.archiveConsequence')}
          verb={t('view.archiveVerb')}
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            await deleteJson(`/v1/files/${encodeURIComponent(archiving.id)}`);
            setArchiving(null);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}
