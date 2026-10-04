import { Archive, FileText, Info, KeyRound, Lock, MoreVertical, Pencil, Plus, RefreshCw, Search, Shield, Trash2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { deleteJson, postJson } from '../../api';
import { EmptyState, FilterSelect, KeyValuePanel, RequiredMark, StatusPill, SummaryStrip, Toolbar } from '../Common';
import { Modal } from '../Modal';
import { formatDateShort, relativeDate, shortId } from '../../lib/format';
import type { ConsoleData, CredentialAuthType, Vault, VaultCredential } from '../../types';

const MCP_REGISTRY_OPTIONS = [
  { name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
  { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
  { name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
  { name: 'Canva', url: 'https://mcp.canva.com/mcp' },
  { name: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
];

export function CredentialVaults({ data, onNew, onOpenVault }: { data: ConsoleData; onNew: () => void; onOpenVault: (vault: Vault) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const vaults = data.vaults.filter((vault) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || vault.status === status;
    const matchesQuery = vault.id.toLowerCase().includes(q) || vault.name.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const activeVaults = data.vaults.filter((vault) => vault.status === 'active').length;
  const totalCredentials = data.vaults.reduce((sum, vault) => sum + vault.credentials.length, 0);
  const activeCredentials = data.vaults.reduce((sum, vault) => sum + vault.credentials.filter((credential) => credential.status === 'active').length, 0);
  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Credential vaults</h1>
          <p>Store scoped credentials for sessions without exposing raw secrets in API responses.</p>
        </div>
        <div className="toolbarActions">
          <button className="primaryButton" type="button" onClick={onNew}>
            <Plus size={18} />
            Create vault
          </button>
          <a className="iconButton" href="https://github.com/sandbaseai/managed-agents/blob/main/docs/usage.md#credential-vaults" target="_blank" rel="noreferrer" title="Documentation">
            <FileText size={18} />
          </a>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Vaults', value: data.vaults.length, icon: <Lock size={18} /> },
        { label: 'Active vaults', value: activeVaults, icon: <Shield size={18} /> },
        { label: 'Credentials', value: totalCredentials, icon: <KeyRound size={18} /> },
        { label: 'Active credentials', value: activeCredentials, icon: <RefreshCw size={18} /> },
      ]} />
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by name or exact ID"
        actions={(
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        )}
      />
      <div className="tablePanel resourceTablePanel">
        <table className="resourceTable">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Credentials</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {vaults.map((vault) => (
              <tr key={vault.id} className="clickableRow" onClick={() => onOpenVault(vault)}>
                <td><strong className="monoText">{shortId(vault.id)}</strong></td>
                <td>{vault.name}</td>
                <td>{vault.credentials.length}</td>
                <td><StatusPill status={vault.status} /></td>
                <td>{formatDateShort(vault.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {vaults.length === 0 ? (
          <EmptyState
            icon={<Lock size={22} />}
            title="No credential vaults"
            body="Create a vault to attach scoped secrets to sessions without returning raw values through the API."
            action={<button className="primaryButton" type="button" onClick={onNew}><Plus size={16} />Create vault</button>}
          />
        ) : null}
      </div>
      <div className="mobileResourceList">
        {vaults.map((vault) => (
          <button className="mobileResourceCard" type="button" key={vault.id} onClick={() => onOpenVault(vault)}>
            <span className="mobileAgentMain">
              <strong>{vault.name}</strong>
              <small className="monoText">{vault.id}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{vault.credentials.length} credentials</span>
              <StatusPill status={vault.status} />
            </span>
          </button>
        ))}
        {vaults.length === 0 ? (
          <EmptyState
            icon={<Lock size={22} />}
            title="No credential vaults"
            body="Create a vault to attach scoped secrets to sessions without returning raw values through the API."
            action={<button className="primaryButton" type="button" onClick={onNew}><Plus size={16} />Create vault</button>}
          />
        ) : null}
      </div>
    </section>
  );
}

export function CredentialVaultDetail({
  vault,
  onBack,
  onRefresh,
  onNewCredential,
}: {
  vault: Vault;
  onBack: () => void;
  onRefresh: () => void;
  onNewCredential: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [credentialMenuId, setCredentialMenuId] = useState<string | null>(null);
  const [rotatingCredential, setRotatingCredential] = useState<VaultCredential | null>(null);
  const [editingCredential, setEditingCredential] = useState<VaultCredential | null>(null);
  const [editVaultOpen, setEditVaultOpen] = useState(false);
  const [deleteVaultOpen, setDeleteVaultOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const credentials = vault.credentials.filter((credential) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || credential.status === status;
    const matchesQuery = credential.id.toLowerCase().includes(q)
      || credential.name.toLowerCase().includes(q)
      || credentialAuthLabel(credential.auth_type).toLowerCase().includes(q)
      || credential.mcp_server_url.toLowerCase().includes(q)
      || credential.variable_name.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const activeCredentials = vault.credentials.filter((credential) => credential.status === 'active').length;
  const lastUsedCredential = vault.credentials
    .filter((credential) => credential.last_used_at)
    .sort((left, right) => String(right.last_used_at).localeCompare(String(left.last_used_at)))[0];

  const archiveVault = async () => {
    await postJson(`/v1/credential-vaults/${vault.id}/archive`, {});
    setMenuOpen(false);
    onBack();
    onRefresh();
  };
  const archiveCredential = async (credential: VaultCredential) => {
    await postJson(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}/archive`, {});
    setCredentialMenuId(null);
    onRefresh();
  };
  const deleteCredential = async (credential: VaultCredential) => {
    await deleteJson(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}`);
    setCredentialMenuId(null);
    onRefresh();
  };

  return (
    <section className="environmentDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>Credential vaults</button>
        <span>/</span>
        <strong>{vault.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{vault.name}</h1>
            <StatusPill status={vault.status} />
          </div>
          <p className="mutedLine"><span className="monoText">{vault.id}</span> · Created {formatDateShort(vault.created_at)} · Updated {formatDateShort(vault.updated_at)}</p>
        </div>
        <div className="agentHeroActions">
          <button className="primaryButton largeAction" type="button" onClick={onNewCredential}>
            <Plus size={18} />
            Add credential
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title="Vault actions">
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditVaultOpen(true);
                  }}
                >
                  <Pencil size={18} />Edit
                </button>
                <button type="button" className="dangerMenuItem" onClick={() => void archiveVault()}><Archive size={18} />Archive</button>
                <button
                  type="button"
                  className="dangerMenuItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteVaultOpen(true);
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
        { label: 'Credentials', value: vault.credentials.length, icon: <KeyRound size={18} /> },
        { label: 'Active', value: activeCredentials, icon: <Shield size={18} /> },
        { label: 'Last used', value: lastUsedCredential?.last_used_at ? relativeDate(lastUsedCredential.last_used_at) : 'Never', icon: <RefreshCw size={18} /> },
      ]} />
      <div className="resourceTruthStrip" aria-label="Credential vault truth model">
        <div><span>Stored encrypted</span><strong>Raw secret values are never returned after create or rotation.</strong></div>
        <div><span>Scoped injection</span><strong>Attach vaults to sessions before tools can request credential material.</strong></div>
        <div><span>Runtime policy</span><strong>Allowed hosts and injection locations must be enforced at execution boundaries.</strong></div>
      </div>
      <div className="detailStack wideDetailStack">
        <Toolbar
          query={query}
          onQuery={setQuery}
          placeholder="Search credentials"
          actions={(
            <FilterSelect
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          )}
        />
        <div className="tablePanel credentialTablePanel">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Auth</th>
                <th>Status</th>
                <th>Last used</th>
                <th>Updated</th>
                <th className="actionsCol" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.id}>
                  <td><strong className="monoText">{shortId(credential.id)}</strong></td>
                  <td>{credential.name || credentialAuthLabel(credential.auth_type)}</td>
                  <td><CredentialAuthCell credential={credential} /></td>
                  <td><StatusPill status={credential.status} /></td>
                  <td>{credential.last_used_at ? relativeDate(credential.last_used_at) : 'Never'}</td>
                  <td>{formatDateShort(credential.updated_at)}</td>
                  <td className="actionsCol">
                    <div className="menuWrap">
                      <button className="iconButton quiet" type="button" title="Credential actions" onClick={() => setCredentialMenuId((current) => current === credential.id ? null : credential.id)}>
                        <MoreVertical size={18} />
                      </button>
                      {credentialMenuId === credential.id ? (
                        <div className="agentMenu rowMenu">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCredential(credential);
                              setCredentialMenuId(null);
                            }}
                          >
                            <Pencil size={18} />Edit
                          </button>
                          {credential.auth_type !== 'mcp_oauth' ? (
                            <button
                              type="button"
                              onClick={() => {
                                setRotatingCredential(credential);
                                setCredentialMenuId(null);
                              }}
                            >
                              <RefreshCw size={18} />Rotate secret
                            </button>
                          ) : null}
                          <button type="button" onClick={() => void archiveCredential(credential)}><Archive size={18} />Archive</button>
                          <button type="button" className="dangerMenuItem" onClick={() => void deleteCredential(credential)}><Trash2 size={18} />Delete</button>
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {credentials.length === 0 ? (
            <EmptyState
              icon={<Shield size={22} />}
              title="No credentials"
              body="Add an OAuth, bearer token, or environment-variable credential to make this vault useful in sessions."
              action={<button className="primaryButton" type="button" onClick={onNewCredential}><Plus size={16} />Add credential</button>}
            />
          ) : null}
        </div>
        <div className="mobileResourceList">
          {credentials.map((credential) => (
            <article className="mobileResourceCard" key={credential.id}>
              <span className="mobileAgentMain">
                <strong>{credential.name || credentialAuthLabel(credential.auth_type)}</strong>
                <small className="monoText">{credential.id}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{credentialAuthLabel(credential.auth_type)}</span>
                <StatusPill status={credential.status} />
              </span>
              <span className="mobileAgentMeta">
                <span>{credential.last_used_at ? `Used ${relativeDate(credential.last_used_at)}` : 'Never used'}</span>
                <button className="ghostButton compactButton" type="button" onClick={() => setCredentialMenuId((current) => current === credential.id ? null : credential.id)}>
                  Actions
                </button>
              </span>
              {credentialMenuId === credential.id ? (
                <div className="mobileActionMenu">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCredential(credential);
                      setCredentialMenuId(null);
                    }}
                  >
                    <Pencil size={16} />Edit
                  </button>
                  {credential.auth_type !== 'mcp_oauth' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setRotatingCredential(credential);
                        setCredentialMenuId(null);
                      }}
                    >
                      <RefreshCw size={16} />Rotate secret
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void archiveCredential(credential)}><Archive size={16} />Archive</button>
                  <button type="button" className="dangerMenuItem" onClick={() => void deleteCredential(credential)}><Trash2 size={16} />Delete</button>
                </div>
              ) : null}
            </article>
          ))}
          {credentials.length === 0 ? (
            <EmptyState
              icon={<Shield size={22} />}
              title="No credentials"
              body="Add an OAuth, bearer token, or environment-variable credential to make this vault useful in sessions."
              action={<button className="primaryButton" type="button" onClick={onNewCredential}><Plus size={16} />Add credential</button>}
            />
          ) : null}
        </div>
      </div>
      {rotatingCredential ? (
        <RotateCredentialModal
          vaultId={vault.id}
          credential={rotatingCredential}
          onClose={() => setRotatingCredential(null)}
          onSaved={() => {
            setRotatingCredential(null);
            onRefresh();
          }}
        />
      ) : null}
      {editingCredential ? (
        <EditCredentialModal
          vaultId={vault.id}
          credential={editingCredential}
          onClose={() => setEditingCredential(null)}
          onSaved={() => {
            setEditingCredential(null);
            onRefresh();
          }}
        />
      ) : null}
      {editVaultOpen ? (
        <VaultEditModal
          vault={vault}
          onClose={() => setEditVaultOpen(false)}
          onSaved={() => {
            setEditVaultOpen(false);
            onRefresh();
          }}
        />
      ) : null}
      {deleteVaultOpen ? (
        <VaultDeleteModal
          vault={vault}
          onClose={() => setDeleteVaultOpen(false)}
          onDeleted={() => {
            setDeleteVaultOpen(false);
            onBack();
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function VaultEditModal({ vault, onClose, onSaved }: { vault: Vault; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(vault.name);
  const [description, setDescription] = useState(vault.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // `display_name` is the published field; the update is a patch, so
      // fields the operator did not touch keep their stored values.
      await postJson(`/v1/credential-vaults/${vault.id}`, { display_name: name, description });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit vault" onClose={onClose}>
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

function VaultDeleteModal({ vault, onClose, onDeleted }: { vault: Vault; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteJson(`/v1/credential-vaults/${vault.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete vault" onClose={onClose}>
      <div className="modalForm">
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <div className="warningNotice">
          <Info size={18} />
          <span>Deleting removes the vault and every credential it holds. A vault referenced by an active session is refused.</span>
        </div>
        <p>Permanently delete <strong>{vault.name}</strong> and its {vault.credentials.length} {vault.credentials.length === 1 ? 'credential' : 'credentials'}?</p>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="dangerButton" type="button" onClick={() => void remove()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete vault'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Edit one credential. The published patch takes `display_name` plus an
 * `auth` object in the credential's existing `auth.type` — the type itself is
 * immutable — and the write-only secret field differs per type: `token` for
 * bearer, `access_token` for MCP OAuth, `secret_value` for environment
 * variables. Structural fields (`mcp_server_url`, `secret_name`) are locked
 * after creation, so the form shows them read-only.
 */
function EditCredentialModal({ vaultId, credential, onClose, onSaved }: { vaultId: string; credential: VaultCredential; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(credential.name);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const publishedType = credential.auth_type === 'bearer_token' ? 'static_bearer' : credential.auth_type;
  const secretField = credential.auth_type === 'environment_variable' ? 'secret_value' : credential.auth_type === 'mcp_oauth' ? 'access_token' : 'token';
  const secretLabel = credential.auth_type === 'environment_variable' ? 'New value' : credential.auth_type === 'mcp_oauth' ? 'New access token' : 'New token';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials/${credential.id}`, {
        display_name: name,
        auth: {
          type: publishedType,
          // The secret field is write-only: leaving it blank keeps the stored
          // secret; a non-empty value rotates it in place.
          ...(secret.trim() ? { [secretField]: secret } : {}),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit credential" subtitle={`${credentialAuthLabel(credential.auth_type)} credential`} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {credential.auth_type === 'mcp_oauth' ? (
          <label className="editField">
            MCP server URL
            <input value={credential.mcp_server_url} disabled />
            <small>Server URL is locked after creation; archive and recreate the credential to change it.</small>
          </label>
        ) : null}
        {credential.auth_type === 'environment_variable' ? (
          <label className="editField">
            Variable name
            <input value={credential.variable_name} disabled />
            <small>Variable name is locked after creation; archive and recreate the credential to change it.</small>
          </label>
        ) : null}
        <label className="editField">
          {secretLabel}
          <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={credential.value_hint || 'Leave blank to keep the stored secret'} />
          <small>Write-only: the stored value is never shown. Leave blank to keep it.</small>
        </label>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>Cancel</button>
          <button className="darkButton largeAction" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

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

  const filteredRegistry = MCP_REGISTRY_OPTIONS.filter((option) => {
    const q = registryQuery.toLowerCase();
    return option.name.toLowerCase().includes(q) || option.url.toLowerCase().includes(q);
  });
  const needsSecretAcknowledgement = authType !== 'mcp_oauth';
  const canSubmit = authType === 'mcp_oauth'
    ? Boolean(mcpServerUrl.trim())
    : authType === 'bearer_token'
      ? Boolean(value.trim() && acknowledged)
      : Boolean(variableName.trim() && value.trim() && acknowledged);

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
          network: { type: networkType, allowed_hosts: splitCsv(allowedHosts) },
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
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <label className="editField">
          <span>Name <small className="optionalPill">Optional</small></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example credential" />
        </label>
        <label className="editField">
          Type
          <select value={authType} onChange={(event) => setAuthType(event.target.value as CredentialAuthType)}>
            <option value="mcp_oauth">MCP OAuth</option>
            <option value="bearer_token">Bearer token</option>
            <option value="environment_variable">Environment variable</option>
          </select>
        </label>

        {authType === 'mcp_oauth' ? (
          <div className="mcpRegistryPanel">
            <div className="pickerSearch registrySearch">
              <Search size={18} />
              <input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="Search Anthropic's MCP registry or enter a custom URL" />
            </div>
            <div className="registryList">
              {filteredRegistry.map((option) => (
                <button
                  type="button"
                  key={option.url}
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
                </button>
              ))}
            </div>
            <label className="editField compactField">
              MCP server URL <RequiredMark />
              <input value={mcpServerUrl} onChange={(event) => setMcpServerUrl(event.target.value)} placeholder="https://mcp.example.com" required />
            </label>
          </div>
        ) : null}

        {authType === 'bearer_token' ? (
          <label className="editField">
            Token <RequiredMark />
            <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Bearer or personal access token" required />
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
              <input value={value} onChange={(event) => setValue(event.target.value)} required />
            </label>
          </div>
        ) : null}

        {needsSecretAcknowledgement ? (
          <>
            <div className="credentialSection">
              <h3>Networking</h3>
              <div className="segment credentialSegment">
                <button type="button" className={networkType === 'limited' ? 'active' : ''} onClick={() => setNetworkType('limited')}>Limited</button>
                <button type="button" className={networkType === 'unrestricted' ? 'active' : ''} onClick={() => setNetworkType('unrestricted')}>Unrestricted</button>
              </div>
              <label className="editField">
                Allowed hosts
                <textarea value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} placeholder="api.example.com, *.example.com" />
                <small>Separate hosts with commas or newlines.</small>
              </label>
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
              <p>Limiting to request headers is recommended unless the service reads the secret from the request body.</p>
            </div>
            <div className="warningNotice">
              <Info size={18} />
              <span>This credential is shared across this workspace. Anyone with API key access can use it in an agent session, including reading data and taking actions on behalf of the credential owner. Review access controls in <a href="#api-keys">API keys</a>.</span>
            </div>
            <label className="checkboxLine acknowledgement">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              I acknowledge this credential is shared and that I am responsible for its storage and use.
            </label>
          </>
        ) : null}

        <div className="modalActions stickyActions">
          <button className="primaryButton largeAction" type="submit" disabled={saving || !canSubmit}>Add credential</button>
        </div>
      </form>
    </Modal>
  );
}

function CredentialAuthCell({ credential }: { credential: VaultCredential }) {
  const secondary = credential.auth_type === 'mcp_oauth'
    ? credential.mcp_server_url
    : credential.auth_type === 'environment_variable'
      ? credential.variable_name
      : credential.value_hint;
  return (
    <span className="authCell">
      <strong>{credentialAuthLabel(credential.auth_type)}</strong>
      {secondary ? <small>{secondary}</small> : null}
    </span>
  );
}

function RotateCredentialModal({
  vaultId,
  credential,
  onClose,
  onSaved,
}: {
  vaultId: string;
  credential: VaultCredential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canSubmit = value.trim().length > 0 && acknowledged && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials/${credential.id}/rotate`, {
        value,
        actor: 'console',
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Rotate credential" subtitle="Replace the stored secret without changing credential id or injection metadata." onClose={onClose} size="medium">
      <form className="credentialForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <KeyValuePanel rows={[
          ['Credential', credential.name || credential.id],
          ['Type', credentialAuthLabel(credential.auth_type)],
          ['Current hint', credential.value_hint || 'not set'],
        ]} />
        <label className="editField">
          New secret value <RequiredMark />
          <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Paste the replacement secret" type="password" required />
        </label>
        <label className="checkboxLine">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I understand the raw secret is stored encrypted and will not be shown again.</span>
        </label>
        <div className="modalActions">
          <button className="secondaryButton largeAction" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton largeAction" type="submit" disabled={!canSubmit}>{saving ? 'Rotating…' : 'Rotate secret'}</button>
        </div>
      </form>
    </Modal>
  );
}

function credentialAuthLabel(type: CredentialAuthType) {
  if (type === 'mcp_oauth') return 'MCP OAuth';
  if (type === 'bearer_token') return 'Bearer token';
  return 'Environment variable';
}

function splitCsv(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}
