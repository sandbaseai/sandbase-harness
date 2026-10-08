import { ChevronDown, Download, KeyRound, Plus, Shield, Trash2 } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteJson, getCursorPage, postJson } from '../../api';
import { RequiredMark } from '../Common';
import { ConsoleSelect } from '../console-select';
import { EquivalentRequestPanel } from '../EquivalentRequestPanel';
import { KvRowEditor, kvRowsFromObject, type KvRow } from '../kit';
import { Modal } from '../Modal';
import { MultiResourcePicker, ResourcePicker } from '../ResourcePicker';
import { environmentKind } from '../pages/EnvironmentPageModel';
import { formatDateShort } from '../../lib/format';
import type { ConsoleData, Session, SessionArtifact, SessionResourceDraft, SessionResourceInstance, ViewId } from '../../types';

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
  const { t } = useTranslation('sessions');
  const { t: tCommon } = useTranslation();
  const [agent, setAgent] = useState(initialAgentId ?? '');
  const [environment, setEnvironment] = useState('');
  const [engine, setEngine] = useState('');
  const [title, setTitle] = useState('');
  const [vaultIds, setVaultIds] = useState<Set<string>>(new Set());
  const [resources, setResources] = useState<SessionResourceDraft[]>([]);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const [budget, setBudget] = useState('');
  const [outcomeDescription, setOutcomeDescription] = useState('');
  const [outcomeRubric, setOutcomeRubric] = useState('');
  const [outcomeMaxIterations, setOutcomeMaxIterations] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The published budget is cents written as a string; the field takes a
  // dollar amount. `undefined` omits the key, `null` marks "typed but not a
  // valid amount" so submit can refuse instead of sending a broken shape.
  const budgetCents = useMemo(() => {
    const trimmed = budget.trim();
    if (!trimmed) return undefined;
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    const cents = Math.round(Number(trimmed) * 100);
    return cents > 0 ? String(cents) : null;
  }, [budget]);

  // An outcome needs both halves — a description to work toward and a rubric
  // to grade against. Sending one without the other would be rejected by the
  // API anyway, so the submit check below catches it first.
  const outcomeEntered = Boolean(outcomeDescription.trim() || outcomeRubric.trim() || outcomeMaxIterations.trim());
  const outcomeComplete = Boolean(outcomeDescription.trim() && outcomeRubric.trim());
  const outcomeMax = outcomeMaxIterations.trim() ? Number(outcomeMaxIterations) : undefined;

  // One body object feeds both the submit below and the equivalent-request
  // panel — the panel is only honest if it cannot drift from what is sent.
  const createBody = useMemo(() => ({
    agent,
    environment_id: environment,
    title: title || undefined,
    ...(engine ? { loop_engine: engine } : {}),
    ...(budgetCents ? { budget: { type: 'limit', max_list_cost: { amount: budgetCents, currency: 'USD' } } } : {}),
    ...(outcomeComplete ? {
      initial_events: [{
        type: 'user.define_outcome',
        description: outcomeDescription.trim(),
        rubric: { type: 'text', content: outcomeRubric.trim() },
        ...(outcomeMax !== undefined ? { max_iterations: outcomeMax } : {}),
      }],
    } : {}),
    resources: resources.map(toSessionResourcePayload),
    vault_ids: Array.from(vaultIds),
  }), [agent, environment, engine, title, budgetCents, outcomeComplete, outcomeDescription, outcomeRubric, outcomeMax, resources, vaultIds]);

  // Only engines the runtime can execute are offered; roadmap adapters carry
  // status 'unavailable' and stay out of the picker entirely.
  const executableEngines = (data.settings?.adapters.loop_engine ?? []).filter(
    (adapter) => adapter.status === 'available',
  );
  const defaultEngine = data.settings?.saved_config.loop_engine.provider ?? 'builtin';
  const engineNeedsLocalSandbox = executableEngines
    .find((adapter) => adapter.id === engine)
    ?.requirements?.includes('local sandbox provider') ?? false;
  const sandboxIsLocal = data.settings?.saved_config.sandbox.provider === 'local';
  const createRequest = useMemo(
    () => ({ method: 'POST' as const, path: '/v1/sessions', body: createBody }),
    [createBody],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (budgetCents === null) {
      setError(t('modal.limits.errorBudget'));
      return;
    }
    if (outcomeEntered && !outcomeComplete) {
      setError(t('modal.limits.errorOutcomeIncomplete'));
      return;
    }
    if (outcomeComplete && outcomeMax !== undefined && (!Number.isInteger(outcomeMax) || outcomeMax < 1 || outcomeMax > 20)) {
      setError(t('modal.outcome.errorMaxIterations'));
      return;
    }
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
    <Modal title={t('modal.createTitle')} subtitle={t('modal.createSubtitle')} onClose={onClose} size="medium">
      <form className="sessionForm sessionCreateForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <div className="sessionCreateMain">
            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">1</span>
                <div><h3>{t('modal.details.title')}</h3><p>{t('modal.details.hint')}</p></div>
              </div>
              <label className="sessionField">
                <span>{t('modal.details.sessionTitle')} <small className="optionalPill">{t('modal.details.optional')}</small></span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('modal.details.titlePlaceholder')} />
              </label>
              <div className="sessionPickerGrid">
                <ResourcePicker
                  label={t('modal.details.agent')}
                  placeholder={t('modal.details.agentPlaceholder')}
                  searchPlaceholder={t('modal.details.agentSearch')}
                  manageLabel={t('modal.details.agentManage')}
                  onManage={() => onNavigate('agents')}
                  value={agent}
                  onValue={setAgent}
                  options={data.agents.map((item) => ({ id: item.id, title: item.name, subtitle: formatDateShort(item.created_at) }))}
                />
                <ResourcePicker
                  label={t('modal.details.environment')}
                  placeholder={t('modal.details.environmentPlaceholder')}
                  searchPlaceholder={t('modal.details.environmentSearch')}
                  manageLabel={t('modal.details.environmentManage')}
                  onManage={() => onNavigate('environments')}
                  value={environment}
                  onValue={setEnvironment}
                  options={data.environments.map((item) => ({ id: item.id, title: item.name, subtitle: formatDateShort(item.created_at), badge: environmentKind(item) }))}
                />
              </div>
              <label className="sessionField">
                <span>{t('modal.details.engine')}</span>
                <ConsoleSelect
                  label={t('modal.details.engine')}
                  value={engine}
                  onChange={setEngine}
                  options={[
                    { value: '', label: t('modal.details.engineDefault', { engine: defaultEngine }) },
                    ...executableEngines.map((adapter) => ({ value: adapter.id, label: adapter.label })),
                  ]}
                />
                {engineNeedsLocalSandbox && !sandboxIsLocal && data.settings ? (
                  <small>{t('modal.details.engineLocalSandbox')}</small>
                ) : null}
              </label>
            </section>

            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">2</span>
                <div><h3>{t('modal.credentials.title')}</h3><p>{t('modal.credentials.hint')}</p></div>
              </div>
              <MultiResourcePicker
                label={t('modal.credentials.label')}
                searchPlaceholder={t('modal.credentials.search')}
                placeholder={t('modal.credentials.placeholder')}
                manageLabel={t('modal.credentials.manage')}
                onManage={() => onNavigate('credential-vaults')}
                options={data.vaults.map((vault) => ({ id: vault.id, title: vault.name, subtitle: t('modal.credentials.addedAt', { time: formatDateShort(vault.created_at) }), icon: <Shield size={16} /> }))}
                selected={vaultIds}
                onToggle={(id, checked) => toggleSet(id, checked, setVaultIds)}
              />
            </section>

            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">3</span>
                <div><h3>{t('modal.resources.title')}</h3><p>{t('modal.resources.hint')}</p></div>
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
                <button className="button secondary resourceAddButton" type="button" onClick={() => setResourceMenuOpen((open) => !open)}>
                  <Plus size={18} /> {t('modal.resources.add')} <ChevronDown size={16} />
                </button>
                {resourceMenuOpen ? (
                  <div className="resourceMenu">
                    <button type="button" onClick={() => addResource('github_repository')}>{t('modal.resources.repository')}</button>
                    <button type="button" onClick={() => addResource('file')}>{t('modal.resources.file')}</button>
                    <button type="button" onClick={() => addResource('memory_store')}>{t('modal.resources.memoryStore')}</button>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="sessionSectionCard">
              <div className="sessionSectionHeader">
                <span className="sessionSectionNumber">4</span>
                <div><h3>{t('modal.limits.title')}</h3><p>{t('modal.limits.hint')}</p></div>
              </div>
              <label className="sessionField">
                <span>{t('modal.limits.budget')} <small className="optionalPill">{t('modal.details.optional')}</small></span>
                <input
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                  inputMode="decimal"
                  placeholder={t('modal.limits.budgetPlaceholder')}
                  aria-label={t('modal.limits.budget')}
                />
                <small>{t('modal.limits.budgetHint')}</small>
              </label>
              <label className="sessionField">
                <span>{t('modal.limits.outcomeDescription')} <small className="optionalPill">{t('modal.details.optional')}</small></span>
                <textarea
                  value={outcomeDescription}
                  onChange={(event) => setOutcomeDescription(event.target.value)}
                  rows={2}
                  placeholder={t('modal.limits.outcomeDescriptionPlaceholder')}
                  aria-label={t('modal.limits.outcomeDescription')}
                />
              </label>
              {outcomeEntered ? (
                <>
                  <label className="sessionField">
                    <span>{t('modal.limits.outcomeRubric')} <small className="optionalPill">{t('modal.details.optional')}</small></span>
                    <textarea
                      value={outcomeRubric}
                      onChange={(event) => setOutcomeRubric(event.target.value)}
                      rows={3}
                      spellCheck={false}
                      placeholder={t('modal.limits.outcomeRubricPlaceholder')}
                      aria-label={t('modal.limits.outcomeRubric')}
                    />
                    <small>{t('modal.limits.outcomeRubricHint')}</small>
                  </label>
                  <label className="sessionField">
                    <span>{t('modal.outcome.maxIterations')} <small className="optionalPill">{t('modal.outcome.maxIterationsOptional')}</small></span>
                    <input
                      value={outcomeMaxIterations}
                      onChange={(event) => setOutcomeMaxIterations(event.target.value)}
                      inputMode="numeric"
                      placeholder="3"
                      aria-label={t('modal.outcome.maxIterations')}
                    />
                  </label>
                </>
              ) : null}
            </section>
        </div>

        <details className="requestFold">
          <summary>{tCommon('configDrawer.equivalentRequest')}</summary>
          <EquivalentRequestPanel request={createRequest} bare />
        </details>

        <div className="modalActions stickyActions">
          <button
            className="button primary"
            type="submit"
            disabled={saving || !agent || !environment}
            title={!agent || !environment ? t('modal.pickFirst') : undefined}
          >
            {saving ? t('modal.creating') : t('modal.create')}
          </button>
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
  const { t } = useTranslation('sessions');
  if (resource.type === 'file') {
    return (
      <div className="resourceEditor">
        <ResourceEditorHeader title={t('modal.resources.file')} onRemove={onRemove} />
        <ResourcePicker
          label={t('modal.resources.fileLabel')}
          placeholder={t('modal.resources.filePlaceholder')}
          searchPlaceholder={t('modal.resources.fileSearch')}
          manageLabel={t('modal.resources.fileManage')}
          onManage={() => onNavigate('files')}
          value={resource.file_id}
          onValue={(file_id) => onChange({ ...resource, file_id })}
          options={data.files.map((file) => ({ id: file.id, title: file.name, subtitle: formatDateShort(file.created_at) }))}
        />
        <label>
          {t('modal.resources.mountPath')} <RequiredMark />
          <input value={resource.mount_path} onChange={(event) => onChange({ ...resource, mount_path: event.target.value })} placeholder="/uploads/myfile.txt" required />
          <small>{t('modal.resources.mountHelper')}</small>
        </label>
      </div>
    );
  }

  if (resource.type === 'github_repository') {
    return (
      <div className="resourceEditor">
        <ResourceEditorHeader title={t('modal.resources.repository')} onRemove={onRemove} />
        <label>
          {t('modal.resources.repoUrl')} <RequiredMark />
          <input value={resource.url} onChange={(event) => onChange({ ...resource, url: event.target.value })} placeholder={t('modal.resources.repoUrlPlaceholder')} required />
        </label>
        <label>
          {t('modal.resources.repoToken')} <RequiredMark />
          <input type="password" autoComplete="off" value={resource.authorization_token} onChange={(event) => onChange({ ...resource, authorization_token: event.target.value })} placeholder={t('modal.resources.repoTokenPlaceholder')} required />
          <small>{t('modal.resources.repoTokenHelper')}</small>
        </label>
        <label className="shortField">
          {t('modal.resources.checkout')}
          <ConsoleSelect
            label={t('modal.resources.checkout')}
            value={resource.checkout.mode}
            onChange={(mode) => onChange({ ...resource, checkout: { ...resource.checkout, mode: mode as 'default' | 'branch' | 'commit' } })}
            options={[
              { value: 'default', label: t('modal.resources.checkoutDefault') },
              { value: 'branch', label: t('modal.resources.checkoutBranch') },
              { value: 'commit', label: t('modal.resources.checkoutCommit') },
            ]}
          />
        </label>
        {resource.checkout.mode === 'branch' ? (
          <label className="shortField">
            {t('modal.resources.branchName')} <RequiredMark />
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
            {t('modal.resources.commitSha')} <RequiredMark />
            <input
              value={resource.checkout.value}
              onChange={(event) => onChange({ ...resource, checkout: { ...resource.checkout, value: event.target.value } })}
              placeholder="9fca646b4a4ce9cdd3e1e8b3cd20e7b7c5e4b0c3"
              pattern="[0-9a-fA-F]{7,40}"
              title={t('modal.resources.shaTitle')}
              required
            />
            <small>{t('modal.resources.shaHint')}</small>
          </label>
        ) : null}
        <label>
          {t('modal.resources.mountPath')}
          <input value={resource.mount_path} onChange={(event) => onChange({ ...resource, mount_path: event.target.value })} placeholder={t('modal.resources.mountDefault')} />
        </label>
      </div>
    );
  }

  return (
    <div className="resourceEditor">
      <ResourceEditorHeader title={t('modal.resources.memoryStore')} onRemove={onRemove} />
      <ResourcePicker
        label={t('modal.resources.storeLabel')}
        placeholder={t('modal.resources.storePlaceholder')}
        searchPlaceholder={t('modal.resources.storeSearch')}
        manageLabel={t('modal.resources.storeManage')}
        onManage={() => onNavigate('memory-stores')}
        value={resource.memory_store_id}
        onValue={(memory_store_id) => onChange({ ...resource, memory_store_id })}
        options={data.memoryStores.map((store) => ({ id: store.id, title: store.name, subtitle: formatDateShort(store.created_at) }))}
      />
      <label>
        {t('modal.resources.access')}
        <ConsoleSelect
          label={t('modal.resources.access')}
          value={resource.access}
          onChange={(access) => onChange({ ...resource, access: access as 'read_write' | 'read_only' })}
          options={[
            { value: 'read_write', label: t('modal.resources.accessRw') },
            { value: 'read_only', label: t('modal.resources.accessRo') },
          ]}
        />
      </label>
      <label>
        {t('modal.resources.instructions')}
        <textarea value={resource.instructions} onChange={(event) => onChange({ ...resource, instructions: event.target.value })} placeholder={t('modal.resources.instructionsPlaceholder')} />
      </label>
    </div>
  );
}

function ResourceEditorHeader({ title, onRemove }: { title: string; onRemove: () => void }) {
  const { t } = useTranslation('sessions');
  return (
    <div className="resourceEditorHeader">
      <strong>{title}</strong>
      <button className="iconButton quiet" type="button" onClick={onRemove} aria-label={t('modal.resources.remove', { title })}>
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
  const { t } = useTranslation('sessions');
  const { t: tCommon } = useTranslation();
  const [title, setTitle] = useState(session.title ?? '');
  const [metadataRows, setMetadataRows] = useState<KvRow[]>(() => kvRowsFromObject(session.metadata));
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
      setError(t('modal.errors.jsonInvalid', { label }));
      return { ok: false };
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    const body: Record<string, unknown> = {};
    const nextTitle = title.trim();
    if (nextTitle !== (session.title ?? '')) body.title = nextTitle || null;

    {
      const edited: Record<string, unknown> = {};
      const seenKeys = new Set<string>();
      let invalid = false;
      for (const row of metadataRows) {
        const key = row.key.trim();
        if (!key) continue;
        if (seenKeys.has(key)) {
          setError(t('modal.errors.metadataDuplicate', { key }));
          invalid = true;
          break;
        }
        seenKeys.add(key);
        try {
          edited[key] = JSON.parse(row.value);
        } catch {
          edited[key] = row.value;
        }
      }
      if (invalid) return;
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
          setError(t('modal.errors.budgetInvalid'));
          return;
        }
        body.budget = {
          type: 'limit',
          max_list_cost: { amount: String(Math.round(usd * 100)), currency: 'USD' },
        };
      }
    }

    const agentPatch: Record<string, unknown> = {};
    const tools = parseJsonField(toolsText, t('modal.errors.tools'));
    if (!tools.ok) return;
    if (tools.value !== undefined) agentPatch.tools = tools.value;
    const mcp = parseJsonField(mcpText, t('modal.errors.mcp'));
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
    <Modal title={t('modal.settings.title')} subtitle={`${session.title || session.id}`} onClose={onClose} size="medium">
      <form className="sessionForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <label className="sessionField">
          <span>{t('modal.settings.fieldTitle')}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('modal.settings.titlePlaceholder')}
          />
        </label>
        <label className="sessionField">
          <span>{t('modal.settings.metadata')} <small className="optionalPill">{t('modal.settings.metadataOptional')}</small></span>
          <KvRowEditor rows={metadataRows} onChange={setMetadataRows} addLabel={t('modal.settings.metadataAdd')} />
        </label>
        <label className="sessionField">
          <span>{t('modal.settings.budget')} <small className="optionalPill">{t('modal.settings.budgetOptional')}</small></span>
          <input
            value={budgetUsd}
            onChange={(event) => setBudgetUsd(event.target.value)}
            placeholder={session.budget ? currentBudgetUsd : t('modal.settings.noBudget')}
            inputMode="decimal"
          />
        </label>
        {!idle ? (
          <p className="banner">{t('modal.settings.idleBanner')}</p>
        ) : null}
        <details className="advancedFold">
          <summary>{t('modal.settings.advanced')}</summary>
          <label className="sessionField">
            <span>{t('modal.settings.toolsOverride')} <small className="optionalPill">{t('modal.settings.toolsOptional')}</small></span>
            <textarea
              value={toolsText}
              onChange={(event) => setToolsText(event.target.value)}
              placeholder={'[{"type": "agent_toolset_20260401", "configs": {}}]'}
              disabled={!idle}
              spellCheck={false}
            />
          </label>
          <label className="sessionField">
            <span>{t('modal.settings.mcpOverride')} <small className="optionalPill">{t('modal.settings.mcpOptional')}</small></span>
            <textarea
              value={mcpText}
              onChange={(event) => setMcpText(event.target.value)}
              placeholder={'[{"type": "stdio", "name": "server", "command": "…"}]'}
              disabled={!idle}
              spellCheck={false}
            />
          </label>
        </details>
        <div className="modalActions">
          <button className="button secondary" type="button" onClick={onClose}>{tCommon('actions.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving}>{saving ? t('modal.settings.saving') : t('modal.settings.save')}</button>
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
  const { t } = useTranslation('sessions');
  const { t: tCommon } = useTranslation();
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
      setError(t('modal.outcome.errorDescription'));
      return;
    }
    // The published contract requires a rubric: inline text or a reference to
    // an uploaded file — both spellings are validated server-side too.
    let rubric: Record<string, unknown>;
    if (rubricMode === 'file') {
      if (!rubricFileId) {
        setError(t('modal.outcome.errorRubricFile'));
        return;
      }
      rubric = { type: 'file', file_id: rubricFileId };
    } else {
      if (!rubricText.trim()) {
        setError(t('modal.outcome.errorRubricText'));
        return;
      }
      rubric = { type: 'text', content: rubricText.trim() };
    }
    let max: number | undefined;
    if (maxIterations.trim()) {
      const parsed = Number(maxIterations);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        setError(t('modal.outcome.errorMaxIterations'));
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
    <Modal title={t('modal.outcome.title')} subtitle={session.title || session.id} onClose={onClose} size="medium">
      <form className="sessionForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        <p className="modalBody">
          {t('modal.outcome.body')}
        </p>
        <label className="sessionField">
          <span>{t('modal.outcome.description')} <RequiredMark /></span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder={t('modal.outcome.descriptionPlaceholder')}
          />
        </label>
        <label className="sessionField">
          <span>{t('modal.outcome.rubric')} <RequiredMark /></span>
          <div className="segment compactSegment">
            <button type="button" className={rubricMode === 'text' ? 'active' : ''} onClick={() => setRubricMode('text')}>{t('modal.outcome.rubricModeText')}</button>
            <button type="button" className={rubricMode === 'file' ? 'active' : ''} onClick={() => setRubricMode('file')}>{t('modal.outcome.rubricModeFile')}</button>
          </div>
        </label>
        {rubricMode === 'text' ? (
          <label className="sessionField">
            <span>{t('modal.outcome.rubricText')}</span>
            <textarea
              value={rubricText}
              onChange={(event) => setRubricText(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={t('modal.outcome.rubricTextPlaceholder')}
            />
          </label>
        ) : (
          <label className="sessionField">
            <span>{t('modal.outcome.rubricFile')}</span>
            <ConsoleSelect
              label={t('modal.outcome.rubricFile')}
              value={rubricFileId}
              onChange={setRubricFileId}
              options={[
                { value: '', label: t('modal.outcome.chooseFile') },
                ...data.files.map((file) => ({ value: file.id, label: file.name })),
              ]}
            />
          </label>
        )}
        <label className="sessionField">
          <span>{t('modal.outcome.maxIterations')} <small className="optionalPill">{t('modal.outcome.maxIterationsOptional')}</small></span>
          <input
            value={maxIterations}
            onChange={(event) => setMaxIterations(event.target.value)}
            inputMode="numeric"
            placeholder="3"
          />
        </label>
        <div className="modalActions">
          <button className="button secondary" type="button" onClick={onClose}>{tCommon('actions.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving}>{saving ? t('modal.outcome.defining') : t('modal.outcome.define')}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Post-creation session resources and artifacts. The live instance listing —
 * not the creation-time `session.resources` projection — is the source of
 * truth here: attaches, detaches, and token rotations only ever show up in
 * `GET /v1/sessions/{id}/resources`. `memory_store` is deliberately not
 * offered post-creation because the route refuses it, and token rotation —
 * the only published in-place update — is offered only on non-terminal
 * sessions for the same reason.
 */
export function SessionResourcesModal({
  session,
  data,
  onClose,
  onChanged,
}: {
  session: Session;
  data: ConsoleData;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('sessions');
  const { t: tCommon } = useTranslation();
  const [instances, setInstances] = useState<SessionResourceInstance[] | null>(null);
  const [artifacts, setArtifacts] = useState<SessionArtifact[] | null>(null);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachDraft, setAttachDraft] = useState<SessionResourceDraft | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateToken, setRotateToken] = useState('');

  const readOnly = session.archived_at !== null;
  const terminal = readOnly || session.status === 'terminated';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resourcesPage, artifactsPage] = await Promise.all([
          getCursorPage<SessionResourceInstance>(`/v1/sessions/${encodeURIComponent(session.id)}/resources`),
          getCursorPage<SessionArtifact>(`/v1/sessions/${encodeURIComponent(session.id)}/artifacts`),
        ]);
        if (!cancelled) {
          setInstances(resourcesPage.data);
          setArtifacts(artifactsPage.data);
        }
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const reload = async () => {
    const [resourcesPage, artifactsPage] = await Promise.all([
      getCursorPage<SessionResourceInstance>(`/v1/sessions/${encodeURIComponent(session.id)}/resources`),
      getCursorPage<SessionArtifact>(`/v1/sessions/${encodeURIComponent(session.id)}/artifacts`),
    ]);
    setInstances(resourcesPage.data);
    setArtifacts(artifactsPage.data);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError('');
    try {
      await action();
      await reload();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const instanceLabel = (instance: SessionResourceInstance): string => {
    if (instance.type === 'file') {
      return data.files.find((file) => file.id === instance.file_id)?.name ?? instance.file_id ?? instance.id;
    }
    if (instance.type === 'github_repository') {
      return instance.url ?? instance.repository_id ?? instance.id;
    }
    return data.memoryStores.find((store) => store.id === instance.memory_store_id)?.name ?? instance.memory_store_id ?? instance.id;
  };

  const startAttach = (type: 'file' | 'github_repository') => {
    setAttachMenuOpen(false);
    setRotatingId(null);
    setAttachDraft(
      type === 'file'
        ? { type: 'file', file_id: '', mount_path: '' }
        : { type: 'github_repository', url: '', authorization_token: '', checkout: { mode: 'default', value: '' }, mount_path: '' },
    );
  };

  const attachReady = attachDraft !== null && (
    attachDraft.type === 'file'
      ? attachDraft.file_id.trim() !== '' && attachDraft.mount_path.trim() !== ''
      : attachDraft.type === 'github_repository' &&
        attachDraft.url.trim() !== '' && attachDraft.authorization_token.trim() !== '' &&
        (attachDraft.checkout.mode === 'default' || attachDraft.checkout.value.trim() !== '')
  );

  return (
    <Modal title={t('modal.resourcesManager.title')} subtitle={session.title ?? session.id} onClose={onClose} size="wide">
      {listError ? <div className="banner error inlineBanner">{listError}</div> : null}

      <section className="sessionResourcesSection">
        <div className="sessionResourcesHead">
          <h3>{t('modal.resourcesManager.attached')}</h3>
          {!readOnly ? (
            <div className="menuWrap resourceAddWrap">
              <button className="button secondary resourceAddButton" type="button" onClick={() => setAttachMenuOpen((open) => !open)}>
                <Plus size={18} /> {t('modal.resourcesManager.attach')} <ChevronDown size={16} />
              </button>
              {attachMenuOpen ? (
                <div className="resourceMenu resourceMenuDown">
                  <button type="button" onClick={() => startAttach('file')}>{t('modal.resources.file')}</button>
                  <button type="button" onClick={() => startAttach('github_repository')}>{t('modal.resources.repository')}</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {instances === null ? (
          <p className="mutedLine">{t('modal.resourcesManager.loading')}</p>
        ) : instances.length === 0 ? (
          <p className="mutedLine">{t('modal.resourcesManager.empty')}</p>
        ) : (
          <ul className="sessionResourcesList">
            {instances.map((instance) => (
              <li key={instance.id} className="sessionResourceRow">
                <div className="sessionResourceMeta">
                  <strong>{instanceLabel(instance)}</strong>
                  <span className="sessionResourceBadge">{t(`modal.resourcesManager.type.${instance.type}`)}</span>
                  {instance.mount_path ? <code>{instance.mount_path}</code> : null}
                  {instance.type === 'github_repository' && instance.checkout?.type === 'branch' ? (
                    <span>{t('modal.resourcesManager.checkoutBranch', { value: instance.checkout.name ?? '' })}</span>
                  ) : null}
                  {instance.type === 'github_repository' && instance.checkout?.type === 'commit' ? (
                    <span>{t('modal.resourcesManager.checkoutCommit', { value: instance.checkout.sha ?? '' })}</span>
                  ) : null}
                </div>
                {!readOnly ? (
                  <div className="sessionResourceActions">
                    {instance.type === 'github_repository' && !terminal ? (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRotatingId((current) => (current === instance.id ? null : instance.id));
                          setRotateToken('');
                        }}
                      >
                        <KeyRound size={15} /> {t('modal.resourcesManager.rotate')}
                      </button>
                    ) : null}
                    <button
                      className="button secondary danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await deleteJson(`/v1/sessions/${encodeURIComponent(session.id)}/resources/${encodeURIComponent(instance.id)}`);
                      })}
                    >
                      <Trash2 size={15} /> {t('modal.resourcesManager.detach')}
                    </button>
                  </div>
                ) : null}
                {rotatingId === instance.id ? (
                  <form
                    className="sessionResourceRotate"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const token = rotateToken.trim();
                      if (!token) return;
                      void run(async () => {
                        await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/resources/${encodeURIComponent(instance.id)}`, { authorization_token: token });
                        setRotatingId(null);
                        setRotateToken('');
                      });
                    }}
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      value={rotateToken}
                      onChange={(event) => setRotateToken(event.target.value)}
                      placeholder={t('modal.resources.repoTokenPlaceholder')}
                      aria-label={t('modal.resourcesManager.rotate')}
                      required
                    />
                    <button className="button primary" type="submit" disabled={busy || !rotateToken.trim()}>
                      {t('modal.resourcesManager.rotateConfirm')}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {attachDraft ? (
          <form
            className="resourceEditor"
            onSubmit={(event) => {
              event.preventDefault();
              if (!attachDraft || !attachReady) return;
              void run(async () => {
                await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/resources`, toSessionResourcePayload(attachDraft));
                setAttachDraft(null);
              });
            }}
          >
            <div className="sessionResourcesHead">
              <h3>{attachDraft.type === 'file' ? t('modal.resources.file') : t('modal.resources.repository')}</h3>
              <button className="iconButton" type="button" onClick={() => setAttachDraft(null)} aria-label={tCommon('actions.cancel')}>
                <Trash2 size={15} />
              </button>
            </div>
            {attachDraft.type === 'file' ? (
              <>
                <ResourcePicker
                  label={t('modal.resources.fileLabel')}
                  placeholder={t('modal.resources.filePlaceholder')}
                  searchPlaceholder={t('modal.resources.fileSearch')}
                  value={attachDraft.file_id}
                  onValue={(file_id) => setAttachDraft({ ...attachDraft, file_id })}
                  options={data.files.map((file) => ({ id: file.id, title: file.name, subtitle: formatDateShort(file.created_at) }))}
                />
                <label>
                  {t('modal.resources.mountPath')} <RequiredMark />
                  <input
                    value={attachDraft.mount_path}
                    onChange={(event) => setAttachDraft({ ...attachDraft, mount_path: event.target.value })}
                    placeholder="/uploads/myfile.txt"
                    required
                  />
                  <small>{t('modal.resources.mountHelper')}</small>
                </label>
              </>
            ) : null}
            {attachDraft.type === 'github_repository' ? (
              <>
                <label>
                  {t('modal.resources.repoUrl')} <RequiredMark />
                  <input
                    value={attachDraft.url}
                    onChange={(event) => setAttachDraft({ ...attachDraft, url: event.target.value })}
                    placeholder={t('modal.resources.repoUrlPlaceholder')}
                    required
                  />
                </label>
                <label>
                  {t('modal.resources.repoToken')} <RequiredMark />
                  <input
                    type="password"
                    autoComplete="off"
                    value={attachDraft.authorization_token}
                    onChange={(event) => setAttachDraft({ ...attachDraft, authorization_token: event.target.value })}
                    placeholder={t('modal.resources.repoTokenPlaceholder')}
                    required
                  />
                  <small>{t('modal.resources.repoTokenHelper')}</small>
                </label>
                <label className="shortField">
                  {t('modal.resources.checkout')}
                  <ConsoleSelect
                    label={t('modal.resources.checkout')}
                    value={attachDraft.checkout.mode}
                    onChange={(mode) => setAttachDraft({ ...attachDraft, checkout: { ...attachDraft.checkout, mode: mode as 'default' | 'branch' | 'commit' } })}
                    options={[
                      { value: 'default', label: t('modal.resources.checkoutDefault') },
                      { value: 'branch', label: t('modal.resources.checkoutBranch') },
                      { value: 'commit', label: t('modal.resources.checkoutCommit') },
                    ]}
                  />
                </label>
                {attachDraft.checkout.mode === 'branch' ? (
                  <label className="shortField">
                    {t('modal.resources.branchName')} <RequiredMark />
                    <input
                      value={attachDraft.checkout.value}
                      onChange={(event) => setAttachDraft({ ...attachDraft, checkout: { ...attachDraft.checkout, value: event.target.value } })}
                      placeholder="release-1.2"
                      required
                    />
                  </label>
                ) : null}
                {attachDraft.checkout.mode === 'commit' ? (
                  <label className="shortField">
                    {t('modal.resources.commitSha')} <RequiredMark />
                    <input
                      value={attachDraft.checkout.value}
                      onChange={(event) => setAttachDraft({ ...attachDraft, checkout: { ...attachDraft.checkout, value: event.target.value } })}
                      placeholder="9fca646b4a4ce9cdd3e1e8b3cd20e7b7c5e4b0c3"
                      pattern="[0-9a-fA-F]{7,40}"
                      title={t('modal.resources.shaTitle')}
                      required
                    />
                    <small>{t('modal.resources.shaHint')}</small>
                  </label>
                ) : null}
                <label>
                  {t('modal.resources.mountPath')}
                  <input
                    value={attachDraft.mount_path}
                    onChange={(event) => setAttachDraft({ ...attachDraft, mount_path: event.target.value })}
                    placeholder={t('modal.resources.mountDefault')}
                  />
                </label>
              </>
            ) : null}
            <div className="modalActions">
              <button className="button secondary" type="button" onClick={() => setAttachDraft(null)}>{tCommon('actions.cancel')}</button>
              <button className="button primary" type="submit" disabled={busy || !attachReady}>
                {busy ? t('modal.resourcesManager.attaching') : t('modal.resourcesManager.attachSubmit')}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="sessionResourcesSection">
        <div className="sessionResourcesHead">
          <h3>{t('modal.resourcesManager.artifacts')}</h3>
        </div>
        {artifacts === null ? (
          <p className="mutedLine">{t('modal.resourcesManager.loading')}</p>
        ) : artifacts.length === 0 ? (
          <p className="mutedLine">{t('modal.resourcesManager.noArtifacts')}</p>
        ) : (
          <ul className="sessionResourcesList">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className="sessionResourceRow">
                <div className="sessionResourceMeta">
                  <strong>{artifact.name}</strong>
                  {artifact.artifact_path ? <code>{artifact.artifact_path}</code> : null}
                  <span>{formatDateShort(artifact.created_at)}</span>
                </div>
                <div className="sessionResourceActions">
                  <a
                    className="button secondary"
                    href={`/v1/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(artifact.id)}/content`}
                    download={artifact.name}
                    aria-label={t('modal.resourcesManager.download')}
                  >
                    <Download size={15} /> {t('modal.resourcesManager.download')}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {actionError ? <div className="banner error inlineBanner">{actionError}</div> : null}
      <div className="modalActions">
        <button className="button secondary" type="button" onClick={onClose}>{tCommon('actions.close')}</button>
      </div>
    </Modal>
  );
}
