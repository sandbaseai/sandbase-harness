import { Eye, EyeOff, Info, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { postJson } from '../../api';
import { RequiredMark } from '../Common';
import { Modal } from '../Modal';
import { ConsoleSelect } from '../console-select';
import { sandboxProviderForHostingType, splitCsv } from '../pages/EnvironmentPageModel';
import type { CredentialAuthType, EnvironmentHostingType } from '../../types';

export function ResourceModal({ kind, onClose, onSaved }: { kind: 'environment' | 'credential_vault' | 'memory_store'; onClose: () => void; onSaved: () => void }) {
  const { t: tEnv } = useTranslation('environments');
  const { t: tCred } = useTranslation('credentials');
  const { t: tMem } = useTranslation('memory');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hostingType, setHostingType] = useState<EnvironmentHostingType>('cloud');
  const [dockerImage, setDockerImage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    const path = kind === 'environment' ? '/v1/environments' : kind === 'credential_vault' ? '/v1/credential-vaults' : '/v1/memory_stores';
    // `cloud` sends no `sandbox_provider`: it is the published "the platform
    // decides" declaration and resolves to the docker backend server-side.
    const sandboxProvider = sandboxProviderForHostingType(hostingType);
    try {
      await postJson(path, {
        name,
        ...(kind !== 'credential_vault' ? { description } : {}),
        ...(kind === 'environment' ? {
          config: {
            hosting_type: hostingType,
            ...(sandboxProvider ? { sandbox_provider: sandboxProvider } : {}),
            // A blank image field omits `image` so the provider's default —
            // the published reference sandbox image — applies.
            ...(hostingType === 'docker' ? { ...(dockerImage.trim() ? { image: dockerImage.trim() } : {}), resources: {} } : {}),
            network: {
              type: 'limited',
              allow_mcp_server_network_access: false,
              allow_package_manager_network_access: false,
              allowed_hosts: [],
            },
            packages: { type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
          },
        } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (kind === 'environment') {
    return (
      <Modal title={tEnv('create.title')} onClose={onClose} size="medium">
        <form className="environmentCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner">{error}</div> : null}
          <label className="editField">
            {tEnv('create.name')}
            <input value={name} onChange={(event) => setName(event.target.value.slice(0, 50))} placeholder={tEnv('create.namePlaceholder')} required />
            <small>{tEnv('create.nameHint')}</small>
          </label>
          <div className="hostingSummary">
            <strong>{tEnv('create.summaryTitle')}</strong>
            <p>
              <Trans
                i18nKey="create.summary"
                ns="environments"
                components={{ code: <code /> }}
              />
            </p>
          </div>
          <details className="advancedSection">
            <summary>{tEnv('create.advanced')}</summary>
            <div className="editField">
              <span>{tEnv('detail.execution.hostingType')}</span>
              <ConsoleSelect
                label={tEnv('detail.execution.hostingType')}
                value={hostingType}
                onChange={(next) => setHostingType(next as EnvironmentHostingType)}
                options={[
                  { value: 'cloud', label: tEnv('detail.execution.hostingOptions.cloud') },
                  { value: 'local', label: tEnv('detail.execution.hostingOptions.local') },
                  { value: 'docker', label: tEnv('detail.execution.hostingOptions.docker') },
                  { value: 'kubernetes', label: tEnv('detail.execution.hostingOptions.kubernetes') },
                  { value: 'self_hosted', label: tEnv('detail.execution.hostingOptions.self_hosted') },
                ]}
              />
            </div>
            {hostingType === 'docker' ? (
              <label className="editField">
                {tEnv('create.dockerImage')}
                <input value={dockerImage} onChange={(event) => setDockerImage(event.target.value)} placeholder="ghcr.io/sandbaseai/sandbase-harness-sandbox:latest" />
                <small>{tEnv('create.dockerImageHint')}</small>
              </label>
            ) : null}
            {hostingType === 'local' ? (
              <div className="warningNotice"><span>{tEnv('detail.execution.localWarning')}</span></div>
            ) : null}
            {hostingType === 'self_hosted' ? (
              <div className="subtleNotice">{tEnv('detail.execution.selfHostedNotice')}</div>
            ) : null}
          </details>
          <label className="editField">
            {tEnv('create.description')}
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={tEnv('create.descriptionPlaceholder')} />
          </label>
          <div className="modalActions">
            <button className="button outline" type="button" onClick={onClose}>{tEnv('create.cancel')}</button>
            <button className="button primary" type="submit" disabled={saving || !name.trim()}>{tEnv('create.submit')}</button>
          </div>
        </form>
      </Modal>
    );
  }

  if (kind === 'credential_vault') {
    return (
      <Modal title={tCred('modals.createTitle')} subtitle={tCred('modals.createSubtitle')} onClose={onClose} size="default">
        <form className="vaultCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
          <div className="warningNotice">
            <Info size={18} />
            <span>{tCred('modals.sharedWarning')} <a href="https://github.com/sandbaseai/sandbase-harness/blob/main/docs/usage.md#credential-vaults" target="_blank" rel="noreferrer">{tCred('modals.readGuidance')}</a>.</span>
          </div>
          <label className="editField">
            {tCred('modals.name')}
            <input value={name} onChange={(event) => setName(event.target.value.slice(0, 50))} placeholder={tCred('modals.namePlaceholder')} required />
            <small>{tCred('modals.nameHint')}</small>
          </label>
          <div className="modalActions">
            <button className="button outline" type="button" onClick={onClose}>{tCred('modals.cancel')}</button>
            <button className="button primary" type="submit" disabled={saving || !name.trim()}>{saving ? tCred('modals.creating') : tCred('modals.createSubmit')}</button>
          </div>
        </form>
      </Modal>
    );
  }

  if (kind === 'memory_store') {
    return (
      <Modal title={tMem('modals.createTitle')} onClose={onClose} size="medium">
        <form className="memoryCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner">{error}</div> : null}
          <label className="editField">
            {tMem('modals.name')}
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={tMem('modals.namePlaceholder')} required />
          </label>
          <label className="editField">
            {tMem('modals.descriptionOptional')}
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={tMem('modals.descriptionPlaceholder')} />
            <small>{tMem('modals.descriptionHint')}</small>
          </label>
          <div className="modalActions">
            <button className="button primary" type="submit" disabled={saving || !name.trim()}>{tMem('modals.submit')}</button>
          </div>
        </form>
      </Modal>
    );
  }

  throw new Error(`Unsupported resource kind: ${kind}`);
}

const MCP_REGISTRY_OPTIONS = [
  { name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
  { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
  { name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
  { name: 'Canva', url: 'https://mcp.canva.com/mcp' },
  { name: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
];

export function AddCredentialModal({ vaultId, onClose, onSaved }: { vaultId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('credentials');
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<CredentialAuthType>('mcp_oauth');
  const [mcpServerUrl, setMcpServerUrl] = useState('');
  const [variableName, setVariableName] = useState('');
  const [value, setValue] = useState('');
  const [networkType, setNetworkType] = useState<'limited' | 'unrestricted'>('limited');
  const [allowedHosts, setAllowedHosts] = useState('');
  const [injectHeaders, setInjectHeaders] = useState(true);
  const [injectBody, setInjectBody] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [registryQuery, setRegistryQuery] = useState('');
  const [showValue, setShowValue] = useState(false);

  const filteredRegistry = MCP_REGISTRY_OPTIONS.filter((option) => {
    const q = registryQuery.toLowerCase();
    return option.name.toLowerCase().includes(q) || option.url.toLowerCase().includes(q);
  });
  const needsSecretAcknowledgement = authType !== 'mcp_oauth';
  const hasInjectionLocation = injectHeaders || injectBody;
  const canSubmit = authType === 'mcp_oauth'
    ? Boolean(mcpServerUrl.trim())
    : authType === 'bearer_token'
      ? Boolean(value.trim() && acknowledged && hasInjectionLocation)
      : Boolean(variableName.trim() && value.trim() && acknowledged && hasInjectionLocation);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials`, {
        name: name.trim() || undefined,
        auth_type: authType,
        ...(authType === 'mcp_oauth' ? { mcp_server_url: mcpServerUrl } : {}),
        ...(authType === 'environment_variable' ? { variable_name: variableName } : {}),
        ...(authType !== 'mcp_oauth' ? {
          value,
          network: {
            type: networkType,
            ...(networkType === 'limited' ? { allowed_hosts: splitCsv(allowedHosts) } : {}),
          },
          injection_locations: [
            ...(injectHeaders ? ['request_headers'] : []),
            ...(injectBody ? ['request_body'] : []),
          ],
        } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.addTitle')} subtitle={t('modals.addSubtitle')} onClose={onClose} size="medium">
      <form className="credentialForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          <span>{t('modals.name')} <small className="optionalPill">{t('modals.optional')}</small></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('modals.namePlaceholderExample')} />
        </label>
        <fieldset className="credentialTypeField">
          <legend>{t('modals.typeLegend')}</legend>
          <div className="credentialTypeGrid" role="radiogroup" aria-label={t('modals.typeLegend')}>
            <label className={`credentialTypeOption ${authType === 'mcp_oauth' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="mcp_oauth" checked={authType === 'mcp_oauth'} onChange={() => setAuthType('mcp_oauth')} />
              <span><strong>{t('authTypes.mcp_oauth')}</strong><small>{t('modals.mcpHint')}</small></span>
            </label>
            <label className={`credentialTypeOption ${authType === 'bearer_token' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="bearer_token" checked={authType === 'bearer_token'} onChange={() => setAuthType('bearer_token')} />
              <span><strong>{t('authTypes.bearer_token')}</strong><small>{t('modals.bearerHint')}</small></span>
            </label>
            <label className={`credentialTypeOption ${authType === 'environment_variable' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="environment_variable" checked={authType === 'environment_variable'} onChange={() => setAuthType('environment_variable')} />
              <span><strong>{t('authTypes.environment_variable')}</strong><small>{t('modals.envVarHint')}</small></span>
            </label>
          </div>
        </fieldset>

        {authType === 'mcp_oauth' ? (
          <div className="mcpRegistryPanel">
            <div className="pickerSearch registrySearch">
              <Search size={18} />
              <input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder={t('modals.registryFilter')} />
            </div>
            <div className="registryList">
              {filteredRegistry.map((option) => (
                <button
                  type="button"
                  key={option.url}
                  className={mcpServerUrl === option.url ? 'selected' : ''}
                  aria-pressed={mcpServerUrl === option.url}
                  onClick={() => {
                    setMcpServerUrl(option.url);
                    if (!name.trim()) setName(option.name);
                  }}
                >
                  <span className="registryIcon">{option.name.slice(0, 1)}</span>
                  <span>
                    <strong>{option.name}</strong>
                    <small>{option.url}</small>
                  </span>
                  <span className="registrySelectionMark" aria-hidden="true">✓</span>
                </button>
              ))}
              {filteredRegistry.length === 0 ? <p className="registryEmpty">{t('modals.registryEmpty')}</p> : null}
            </div>
            <label className="editField compactField">
              {t('modals.customMcpUrl')} <RequiredMark />
              <input value={mcpServerUrl} onChange={(event) => setMcpServerUrl(event.target.value)} placeholder="https://mcp.example.com" required />
            </label>
          </div>
        ) : null}

        {authType === 'bearer_token' ? (
          <label className="editField">
            {t('modals.token')} <RequiredMark />
            <span className="secretField">
              <input type={showValue ? 'text' : 'password'} autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('modals.tokenPlaceholder')} required />
              <button className="secretToggle" type="button" onClick={() => setShowValue((current) => !current)} aria-label={showValue ? t('modals.hideToken') : t('modals.showToken')} title={showValue ? t('modals.hideToken') : t('modals.showToken')}>
                {showValue ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
          </label>
        ) : null}

        {authType === 'environment_variable' ? (
          <div className="credentialGrid">
            <label className="editField">
              {t('modals.variableName')} <RequiredMark />
              <input value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="MY_API_KEY" required />
            </label>
            <label className="editField">
              {t('modals.value')} <RequiredMark />
              <span className="secretField">
                <input type={showValue ? 'text' : 'password'} autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} required />
                <button className="secretToggle" type="button" onClick={() => setShowValue((current) => !current)} aria-label={showValue ? t('modals.hideValue') : t('modals.showValue')} title={showValue ? t('modals.hideValue') : t('modals.showValue')}>
                  {showValue ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </label>
          </div>
        ) : null}

        {needsSecretAcknowledgement ? (
          <>
            <div className="credentialSection">
              <h3>{t('modals.networking')}</h3>
              <div className="segment credentialSegment">
                <button type="button" className={networkType === 'limited' ? 'active' : ''} aria-pressed={networkType === 'limited'} onClick={() => setNetworkType('limited')}>{t('modals.limited')}</button>
                <button type="button" className={networkType === 'unrestricted' ? 'active' : ''} aria-pressed={networkType === 'unrestricted'} onClick={() => setNetworkType('unrestricted')}>{t('modals.unrestricted')}</button>
              </div>
              {networkType === 'limited' ? (
                <label className="editField">
                  {t('modals.allowedHosts')}
                  <textarea value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} placeholder={t('modals.allowedHostsPlaceholder')} />
                  <small>{t('modals.allowedHostsHint')}</small>
                </label>
              ) : <p className="fieldHint">{t('modals.unrestrictedHint')}</p>}
            </div>
            <div className="credentialSection">
              <h3>{t('modals.injection')}</h3>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectHeaders} onChange={(event) => setInjectHeaders(event.target.checked)} />
                {t('modals.requestHeaders')}
              </label>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectBody} onChange={(event) => setInjectBody(event.target.checked)} />
                {t('modals.requestBody')}
              </label>
              {!hasInjectionLocation ? <p className="fieldError" role="alert">{t('modals.injectionRequired')}</p> : null}
              <p>{t('modals.injectionHint')}</p>
            </div>
            <div className="warningNotice">
              <Info size={18} />
              <span>{t('modals.credentialSharedWarning')} <a href="https://github.com/sandbaseai/sandbase-harness/blob/main/docs/usage.md#credential-vaults" target="_blank" rel="noreferrer">{t('modals.readGuidance')}</a>.</span>
            </div>
            <label className="checkboxLine acknowledgement">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              {t('modals.acknowledge')}
            </label>
          </>
        ) : null}

        <div className="modalActions stickyActions">
          <button className="button outline" type="button" onClick={onClose}>{t('modals.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !canSubmit}>{saving ? t('modals.adding') : t('modals.addSubmit')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AddMemoryModal({ storeId, onClose, onSaved }: { storeId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('memory');
  const [path, setPath] = useState('/');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const normalizedPath = path.trim().replace(/\/+/g, '/');
  const canSubmit = normalizedPath.startsWith('/') && normalizedPath.length > 1 && !normalizedPath.endsWith('/');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/memory_stores/${storeId}/memories`, { path: normalizedPath, content });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={t('modals.addTitle')} onClose={onClose} size="medium">
      <form className="addMemoryForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          {t('modals.path')}
          <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('modals.pathPlaceholder')} required />
          <small>{t('modals.pathHint')}</small>
        </label>
        <label className="editField">
          {t('modals.content')}
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <div className="modalActions">
          <button className="button primary" type="submit" disabled={saving || !canSubmit}>{saving ? t('modals.adding') : t('modals.addSubmit')}</button>
        </div>
      </form>
    </Modal>
  );
}
