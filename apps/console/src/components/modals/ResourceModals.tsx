import { Eye, EyeOff, FileText, Info, Plus, Search, Shield } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { postJson } from '../../api';
import { RequiredMark } from '../Common';
import { Modal } from '../Modal';
import { sandboxProviderForHostingType, splitCsv } from '../pages/EnvironmentPageModel';
import type { CredentialAuthType, EnvironmentHostingType } from '../../types';

export function ResourceModal({ kind, onClose, onSaved }: { kind: 'environment' | 'credential_vault' | 'memory_store'; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hostingType, setHostingType] = useState<EnvironmentHostingType>('local');
  const [dockerImage, setDockerImage] = useState('node:22-slim');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    const path = kind === 'environment' ? '/v1/environments' : kind === 'credential_vault' ? '/v1/credential-vaults' : '/v1/memory_stores';
    try {
      await postJson(path, {
        name,
        ...(kind !== 'credential_vault' ? { description } : {}),
        ...(kind === 'environment' ? {
          config: {
            hosting_type: hostingType,
            sandbox_provider: sandboxProviderForHostingType(hostingType),
            ...(hostingType === 'docker' ? { image: dockerImage.trim() || 'node:22-slim', resources: {} } : {}),
            network: {
              type: 'limited',
              allow_mcp_server_network_access: false,
              allow_package_manager_network_access: false,
              allowed_hosts: [],
            },
            packages: [],
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
      <Modal title="Create environment" onClose={onClose} size="medium">
        <form className="environmentCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner">{error}</div> : null}
          <label className="editField">
            Name
            <input value={name} onChange={(event) => setName(event.target.value.slice(0, 50))} placeholder="E.g. My Environment" required />
            <small>50 characters or fewer.</small>
          </label>
          <label className="editField">
            Hosting type
            <select value={hostingType} onChange={(event) => setHostingType(event.target.value as EnvironmentHostingType)}>
              <option value="local">Local</option>
              <option value="docker">Docker</option>
              <option value="self_hosted">Self-hosted</option>
            </select>
            <small>Cloud hosting is not offered: the runtime has no cloud execution backend and refuses it with `unsupported_hosting_type`.</small>
          </label>
          {hostingType === 'docker' ? (
            <label className="editField">
              Docker image
              <input value={dockerImage} onChange={(event) => setDockerImage(event.target.value)} placeholder="node:22-slim" />
              <small>One Docker container will be created per session.</small>
            </label>
          ) : null}
          <label className="editField">
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description for this environment" />
          </label>
          <div className="modalActions">
            <button className="secondaryButton largeAction" type="button" onClick={onClose}>Cancel</button>
            <button className="darkButton largeAction" type="submit" disabled={saving || !name.trim()}>Create environment</button>
          </div>
        </form>
      </Modal>
    );
  }

  if (kind === 'credential_vault') {
    return (
      <Modal title="Create vault" subtitle="Create a shared boundary for credentials used by your sessions." onClose={onClose} size="default">
        <form className="vaultCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
          <div className="warningNotice">
            <Info size={18} />
            <span>Vaults are shared across this workspace. Anyone with API key access can use credentials added here. <a href="https://github.com/sandbaseai/sandbase-harness/blob/main/docs/usage.md#credential-vaults" target="_blank" rel="noreferrer">Read credential vault guidance</a>.</span>
          </div>
          <label className="editField">
            Name
            <input value={name} onChange={(event) => setName(event.target.value.slice(0, 50))} placeholder="Production vault" required />
            <small>50 characters or fewer.</small>
          </label>
          <div className="modalActions">
            <button className="secondaryButton largeAction" type="button" onClick={onClose}>Cancel</button>
            <button className="darkButton largeAction" type="submit" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create vault'}</button>
          </div>
        </form>
      </Modal>
    );
  }

  if (kind === 'memory_store') {
    return (
      <Modal title="Create memory store" onClose={onClose} size="medium">
        <form className="memoryCreateForm" onSubmit={submit}>
          {error ? <div className="banner error inlineBanner">{error}</div> : null}
          <label className="editField">
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My memory store" required />
          </label>
          <label className="editField">
            Description (optional)
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this store contains and how agents should use it" />
            <small>Name and description are rendered in the agent system prompt when this store is attached.</small>
          </label>
          <div className="modalActions">
            <button className="darkButton largeAction" type="submit" disabled={saving || !name.trim()}>Create memory store</button>
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
    <Modal title="Add credential" subtitle="Add a credential to this vault for agents to use." onClose={onClose} size="medium">
      <form className="credentialForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          <span>Name <small className="optionalPill">Optional</small></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example credential" />
        </label>
        <fieldset className="credentialTypeField">
          <legend>Credential type</legend>
          <div className="credentialTypeGrid" role="radiogroup" aria-label="Credential type">
            <label className={`credentialTypeOption ${authType === 'mcp_oauth' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="mcp_oauth" checked={authType === 'mcp_oauth'} onChange={() => setAuthType('mcp_oauth')} />
              <span><strong>MCP OAuth</strong><small>Connect to an MCP server without storing a raw token.</small></span>
            </label>
            <label className={`credentialTypeOption ${authType === 'bearer_token' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="bearer_token" checked={authType === 'bearer_token'} onChange={() => setAuthType('bearer_token')} />
              <span><strong>Bearer token</strong><small>Send one token with each request.</small></span>
            </label>
            <label className={`credentialTypeOption ${authType === 'environment_variable' ? 'selected' : ''}`}>
              <input type="radio" name="credential-auth-type" value="environment_variable" checked={authType === 'environment_variable'} onChange={() => setAuthType('environment_variable')} />
              <span><strong>Environment variable</strong><small>Expose a named secret to the runtime.</small></span>
            </label>
          </div>
        </fieldset>

        {authType === 'mcp_oauth' ? (
          <div className="mcpRegistryPanel">
            <div className="pickerSearch registrySearch">
              <Search size={18} />
              <input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="Filter curated MCP servers" />
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
              {filteredRegistry.length === 0 ? <p className="registryEmpty">No curated servers match. Enter a custom URL below.</p> : null}
            </div>
            <label className="editField compactField">
              Custom MCP server URL <RequiredMark />
              <input value={mcpServerUrl} onChange={(event) => setMcpServerUrl(event.target.value)} placeholder="https://mcp.example.com" required />
            </label>
          </div>
        ) : null}

        {authType === 'bearer_token' ? (
          <label className="editField">
            Token <RequiredMark />
            <span className="secretField">
              <input type={showValue ? 'text' : 'password'} autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Bearer or personal access token" required />
              <button className="secretToggle" type="button" onClick={() => setShowValue((current) => !current)} aria-label={showValue ? 'Hide token' : 'Show token'} title={showValue ? 'Hide token' : 'Show token'}>
                {showValue ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
          </label>
        ) : null}

        {authType === 'environment_variable' ? (
          <div className="credentialGrid">
            <label className="editField">
              Variable name <RequiredMark />
              <input value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="MY_API_KEY" required />
            </label>
            <label className="editField">
              Value <RequiredMark />
              <span className="secretField">
                <input type={showValue ? 'text' : 'password'} autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} required />
                <button className="secretToggle" type="button" onClick={() => setShowValue((current) => !current)} aria-label={showValue ? 'Hide value' : 'Show value'} title={showValue ? 'Hide value' : 'Show value'}>
                  {showValue ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </label>
          </div>
        ) : null}

        {needsSecretAcknowledgement ? (
          <>
            <div className="credentialSection">
              <h3>Networking</h3>
              <div className="segment credentialSegment">
                <button type="button" className={networkType === 'limited' ? 'active' : ''} aria-pressed={networkType === 'limited'} onClick={() => setNetworkType('limited')}>Limited</button>
                <button type="button" className={networkType === 'unrestricted' ? 'active' : ''} aria-pressed={networkType === 'unrestricted'} onClick={() => setNetworkType('unrestricted')}>Unrestricted</button>
              </div>
              {networkType === 'limited' ? (
                <label className="editField">
                  Allowed hosts
                  <textarea value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} placeholder="api.example.com, *.example.com" />
                  <small>Separate hosts with commas or newlines.</small>
                </label>
              ) : <p className="fieldHint">Requests may reach any host. Use this only when the service requires it.</p>}
            </div>
            <div className="credentialSection">
              <h3>Injection location</h3>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectHeaders} onChange={(event) => setInjectHeaders(event.target.checked)} />
                Request headers
              </label>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectBody} onChange={(event) => setInjectBody(event.target.checked)} />
                Request body
              </label>
              {!hasInjectionLocation ? <p className="fieldError" role="alert">Select at least one injection location.</p> : null}
              <p>Limiting to request headers is recommended unless the service reads the secret from the request body.</p>
            </div>
            <div className="warningNotice">
              <Info size={18} />
              <span>This credential will be shared across this workspace. Anyone with API key access can use it in an agent session. <a href="https://github.com/sandbaseai/sandbase-harness/blob/main/docs/usage.md#credential-vaults" target="_blank" rel="noreferrer">Read credential vault guidance</a>.</span>
            </div>
            <label className="checkboxLine acknowledgement">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              I acknowledge this credential is shared and that I am responsible for its storage and use.
            </label>
          </>
        ) : null}

        <div className="modalActions stickyActions">
          <button className="secondaryButton largeAction" type="button" onClick={onClose}>Cancel</button>
          <button className="darkButton largeAction" type="submit" disabled={saving || !canSubmit}>{saving ? 'Adding…' : 'Add credential'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AddMemoryModal({ storeId, onClose, onSaved }: { storeId: string; onClose: () => void; onSaved: () => void }) {
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
    <Modal title="Add memory" onClose={onClose} size="medium">
      <form className="addMemoryForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          Path
          <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/note/d" required />
          <small>Folders are derived from the slashes in your path.</small>
        </label>
        <label className="editField">
          Content
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <div className="modalActions">
          <button className="darkButton largeAction" type="submit" disabled={saving || !canSubmit}>Add memory</button>
        </div>
      </form>
    </Modal>
  );
}
