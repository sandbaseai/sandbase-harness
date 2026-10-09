import { Copy, Plus, TriangleAlert, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCursorPage, postJson } from '../../api';
import { Kpi, KpiStrip } from '../console-ui';
import { Modal } from '../Modal';
import { RequiredMark } from '../Common';
import { copyText, formatDateShort, relativeDate } from '../../lib/format';
import type { Environment, Session } from '../../types';
import {
  declaredHostingType,
  effectiveSandboxProvider,
  environmentHostingType,
  environmentMetadataEntries,
  environmentNetwork,
  environmentNetworkEnforcement,
} from './EnvironmentPageModel';

export function CloudEnvironment({ environment }: { environment: Environment }) {
  const { t } = useTranslation('environments');
  const metadata = environmentMetadataEntries(environment);
  const executionType = environmentHostingType(environment);
  const effectiveProvider = effectiveSandboxProvider(environment);
  const network = environmentNetwork(environment);
  const networkEnforcement = environmentNetworkEnforcement(environment);
  const resources = environment.config.resources && typeof environment.config.resources === 'object' && !Array.isArray(environment.config.resources)
    ? environment.config.resources as Record<string, unknown>
    : {};
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>{t('detail.execution.title')}</h2>
        <p>{t('detail.execution.readonlyHint')}</p>
        {effectiveProvider === 'local' ? (
          <div className="warningNotice" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>{t('detail.execution.readonlyWarning')}</span>
          </div>
        ) : null}
        <div className="readonlyFields">
          <ReadonlyField label={t('detail.execution.fields.hostingType')} value={t(`kind.${declaredHostingType(environment)}`)} />
          <ReadonlyField label={t('detail.execution.fields.effectiveBackend')} value={effectiveProvider} />
          {executionType === 'docker' ? <ReadonlyField label={t('detail.execution.fields.dockerImage')} value={String(environment.config.image ?? 'node:22-slim')} /> : null}
          {executionType === 'docker' && resources.memory ? <ReadonlyField label={t('detail.execution.fields.memoryLimit')} value={String(resources.memory)} /> : null}
          {executionType === 'docker' && resources.cpu ? <ReadonlyField label={t('detail.execution.fields.cpuLimit')} value={String(resources.cpu)} /> : null}
        </div>
      </section>
      <section className="environmentSection">
        <h2>{t('detail.network.title')}</h2>
        <p>{t('detail.network.hint')}</p>
        {network.type === 'limited' && networkEnforcement === 'best_effort' ? (
          <div className="warningNotice" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>{t('detail.network.bestEffortHint')}</span>
          </div>
        ) : null}
        {network.type === 'limited' && networkEnforcement === 'unsupported' ? (
          <div className="warningNotice" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>{t('detail.network.unsupportedHint')}</span>
          </div>
        ) : null}
        <div className="readonlyFields">
          <ReadonlyField label={t('detail.network.fields.policy')} value={network.type === 'limited' ? t('detail.network.policyLimited') : t('detail.network.policyUnrestricted')} />
          {network.type === 'limited' ? <ReadonlyField label={t('detail.network.fields.allowedHosts')} value={network.allowedHosts.join(', ') || t('detail.network.noAllowedHosts')} wide /> : null}
          {network.type === 'limited' ? <ReadonlyField label={t('detail.network.fields.mcpAccess')} value={network.allowMcp ? t('detail.network.flagAllowed') : t('detail.network.flagPolicyBound')} /> : null}
          {network.type === 'limited' ? <ReadonlyField label={t('detail.network.fields.packageManagerAccess')} value={network.allowPackageManager ? t('detail.network.flagAllowed') : t('detail.network.flagDenied')} /> : null}
          <ReadonlyField label={t('detail.network.fields.enforcement')} value={t(`detail.network.enforcementLabels.${networkEnforcement}`)} />
        </div>
      </section>
      <section className="environmentSection">
        <h2>{t('detail.metadata.title')}</h2>
        <p>{t('detail.metadata.hint')}</p>
        <ReadonlyTable
          empty={t('detail.metadata.empty')}
          rows={metadata}
          columns={[t('detail.metadata.keyColumn'), t('detail.metadata.valueColumn')]}
        />
      </section>
    </div>
  );
}

/**
 * A row of `GET /v1/environments/:id/worker-keys`: the secret is only ever
 * present on the creation response, so listed keys carry `key_prefix` alone.
 */
interface EnvironmentWorkerKey {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export function SelfHostedEnvironment({ environment, sessions }: { environment: Environment; sessions: Session[] }) {
  const { t } = useTranslation('environments');
  const [keys, setKeys] = useState<EnvironmentWorkerKey[] | null>(null);
  const [keysError, setKeysError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const page = await getCursorPage<EnvironmentWorkerKey>(`/v1/environments/${environment.id}/worker-keys`);
      setKeys(page.data);
      setKeysError('');
    } catch (error) {
      setKeysError(error instanceof Error ? error.message : String(error));
    }
  }, [environment.id]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const idleSessions = sessions.filter((session) => session.status === 'idle');
  const runningSessions = sessions.filter((session) => session.status === 'running');
  const completedSessions = sessions.filter((session) => session.status === 'terminated');
  const oldestActiveSession = [...idleSessions, ...runningSessions].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>{t('detail.selfHosted.overviewTitle')}</h2>
        <p>{t('detail.selfHosted.overviewHint')}</p>
        <KpiStrip label={t('detail.selfHosted.overviewTitle')}>
          <Kpi label={t('detail.selfHosted.idle')} value={idleSessions.length} />
          <Kpi label={t('detail.selfHosted.running')} value={runningSessions.length} />
          <Kpi label={t('detail.selfHosted.completed')} value={completedSessions.length} />
          <Kpi label={t('detail.selfHosted.oldestActive')} value={oldestActiveSession ? relativeDate(oldestActiveSession.created_at) : t('detail.selfHosted.none')} />
        </KpiStrip>
      </section>
      <div className="selfHostedGrid">
        <section className="environmentSection">
          <div className="sectionHeaderRow">
            <div>
              <h2>{t('detail.selfHosted.keysTitle')}</h2>
              <p>{t('detail.selfHosted.keysHint')}</p>
            </div>
            <button className="primaryButton" type="button" onClick={() => setModalOpen(true)}>
              <Plus size={16} />{t('detail.selfHosted.createKey')}
            </button>
          </div>
          {keysError ? <div className="banner error inlineBanner">{keysError}</div> : null}
          <ReadonlyTable
            empty={keys === null ? t('detail.selfHosted.keysLoading') : t('detail.selfHosted.keysEmpty')}
            rows={(keys ?? []).map((key) => [key.name, key.key_prefix, formatDateShort(key.created_at), formatDateShort(key.expires_at)])}
            columns={[t('detail.selfHosted.columns.name'), t('detail.selfHosted.columns.prefix'), t('detail.selfHosted.columns.created'), t('detail.selfHosted.columns.expires')]}
          />
        </section>
        <section className="setupCard">
          <div className="setupHeader">
            <h2>{t('detail.selfHosted.setupTitle')}</h2>
            <button className="iconButton quiet" type="button" title={t('detail.selfHosted.dismiss')}><X size={18} /></button>
          </div>
          <p>{t('detail.selfHosted.setupHint')}</p>
          <SetupStep index={1} title={t('detail.selfHosted.step1Title')} body={t('detail.selfHosted.step1Body')} />
          <SetupStep index={2} title={t('detail.selfHosted.step2Title')} body={t('detail.selfHosted.step2Body')} code={`export MANAGED_AGENTS_ENVIRONMENT_KEY='env-key-...'`} />
          <SetupStep index={3} title={t('detail.selfHosted.step3Title')} body={t('detail.selfHosted.step3Body')} code={`npm install -g managed-agents`} />
          <SetupStep index={4} title={t('detail.selfHosted.step4Title')} body={t('detail.selfHosted.step4Body')} code={`managed-agents worker poll \\\n  --environment-id "${environment.id}" \\\n  --workdir "/workspace"`} />
        </section>
      </div>
      {modalOpen ? (
        <WorkerKeyModal
          environmentId={environment.id}
          onClose={() => setModalOpen(false)}
          onSaved={() => void loadKeys()}
        />
      ) : null}
    </div>
  );
}

/**
 * The one-time-secret flow for `POST /v1/environments/:id/worker-keys`: the
 * `secret_key` exists only on the creation response, so the modal reveals it
 * in place — matching the API-key modal — before the keys table refreshes.
 */
function WorkerKeyModal({ environmentId, onClose, onSaved }: { environmentId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('environments');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<(EnvironmentWorkerKey & { secret_key: string }) | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (created) {
      onClose();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await postJson<EnvironmentWorkerKey & { secret_key: string }>(
        `/v1/environments/${encodeURIComponent(environmentId)}/worker-keys`,
        { name: name.trim() },
      );
      setCreated(response);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('detail.selfHosted.modal.title')} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        {!created ? (
          <>
            <label>
              <span>{t('detail.selfHosted.modal.name')} <RequiredMark /></span>
              <input value={name} onChange={(event) => setName(event.target.value.slice(0, 80))} placeholder={t('detail.selfHosted.modal.namePlaceholder')} required />
            </label>
            <p className="formHint">{t('detail.selfHosted.modal.hint')}</p>
          </>
        ) : (
          <div className="secretReveal">
            <div>
              <strong>{created.name}</strong>
              <span>{created.key_prefix}</span>
            </div>
            <code>{created.secret_key}</code>
            <p className="formHint">{t('detail.selfHosted.modal.secretHint')}</p>
            <button type="button" className="secondaryButton" onClick={() => void copyText(created.secret_key)}>
              <Copy size={16} />{t('detail.selfHosted.modal.copyKey')}
            </button>
          </div>
        )}
        <div className="modalActions">
          <button type="button" className="secondaryButton" onClick={onClose}>{created ? t('detail.selfHosted.modal.done') : t('detail.selfHosted.modal.cancel')}</button>
          {!created ? <button className="primaryButton" type="submit" disabled={saving || !name.trim()}>{saving ? t('detail.selfHosted.modal.creating') : t('detail.selfHosted.modal.submit')}</button> : null}
        </div>
      </form>
    </Modal>
  );
}

export function ReadonlyTable({ columns, rows, empty }: { columns: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="readonlyTable">
      {rows.length === 0 ? <div className="emptyValue">{empty}</div> : (
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.join('-')}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReadonlyField({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`readonlyField ${wide ? 'wide' : ''}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function SetupStep({ index, title, body, code }: { index: number; title: string; body: string; code?: string }) {
  return (
    <div className="setupStep">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {code ? <pre>{code}</pre> : null}
      </div>
    </div>
  );
}
