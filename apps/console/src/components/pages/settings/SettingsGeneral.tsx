import { useEffect, useState } from 'react';
import { Bot, Box, CheckCircle2, KeyRound, Layers, Play, Terminal } from 'lucide-react';
import { putJson } from '../../../api';
import { pathName, workspaceConfigDir } from '../../../lib/format';
import { KeyValuePanel, SummaryStrip } from '../../Common';
import { FormField } from '../../FormPrimitives';
import type { ConsoleData, RuntimeSettings, RuntimeSettingsConfig, ViewId, Workspace } from '../../../types';

export function SettingsGeneral({ data, setView }: { data: ConsoleData; setView: (view: ViewId) => void }) {
  const workspaceLabel = data.workspace?.name && data.workspace.name !== 'managed-agents'
    ? data.workspace.name
    : 'Default';
  const settings = data.settings;
  const savedModel = settings?.saved_config.model;
  const [vendor, setVendor] = useState<RuntimeSettingsConfig['model']['vendor']>(savedModel?.vendor ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(savedModel?.base_url ?? defaultModelBaseUrl(savedModel?.vendor));
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const baseUrlVendor = vendor === 'openai_compatible' || vendor === 'minimax';

  useEffect(() => {
    setVendor(savedModel?.vendor ?? 'openai');
    setBaseUrl(savedModel?.base_url ?? defaultModelBaseUrl(savedModel?.vendor));
    setApiKey('');
  }, [savedModel?.vendor, savedModel?.base_url, settings?.revision]);

  const apiKeyConfigured = settings?.secret_states.model.api_key === 'configured';
  const canSave = Boolean(settings) && !saving;

  async function saveModelProvider() {
    if (!settings) return;
    setSaving(true);
    setMessage(null);
    try {
      const trimmedKey = apiKey.trim();
      const nextConfig: RuntimeSettingsConfig = {
        ...settings.saved_config,
        model: {
          ...settings.saved_config.model,
          vendor,
          base_url: baseUrlVendor ? baseUrl.trim() || defaultModelBaseUrl(vendor) || undefined : undefined,
          api_key: trimmedKey || (apiKeyConfigured ? settings.saved_config.model.api_key : undefined),
        },
      };
      await putJson<RuntimeSettings>('/v1/x/settings', { revision: settings.revision, config: nextConfig });
      setMessage('Model provider saved. You can now create an agent or start a session.');
      setApiKey('');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save model provider');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Setup</h1>
          <p>Configure the one thing a builder needs first: which model provider this local agent console should use.</p>
        </div>
      </div>
      <SummaryStrip items={[
        { label: 'Workspace', value: workspaceLabel, icon: <Box size={18} /> },
        { label: 'Target', value: data.workspace?.target ?? 'local', icon: <Layers size={18} /> },
        { label: 'Runtime', value: data.runtime?.status ?? 'starting', icon: <Terminal size={18} /> },
        { label: 'Auth', value: data.runtime?.auth_enabled ? 'enabled' : 'disabled', icon: <KeyRound size={18} /> },
      ]} />
      <div className="builderSetupGrid">
        <div className="panel subtlePanel builderSetupPanel">
          <div className="builderSetupHeader">
            <span className="softIcon"><Bot size={18} /></span>
            <div>
              <h2>Model provider</h2>
              <p>Choose the vendor once. Agents can use the provider without asking every builder to understand runtime internals.</p>
            </div>
          </div>
          {settings ? (
            <form className="builderProviderForm" onSubmit={(event) => {
              event.preventDefault();
              void saveModelProvider();
            }}>
              <FormField label="Provider" description="Keep this simple: OpenAI, Anthropic, MiniMax, or an OpenAI-compatible endpoint.">
                <select value={vendor} onChange={(event) => {
                  const nextVendor = event.target.value as RuntimeSettingsConfig['model']['vendor'];
                  setVendor(nextVendor);
                  setBaseUrl(defaultModelBaseUrl(nextVendor));
                }}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="minimax">MiniMax</option>
                  <option value="openai_compatible">OpenAI-compatible</option>
                </select>
              </FormField>
              {baseUrlVendor ? (
                <FormField label="Base URL" description="Use the default endpoint or point to a compatible gateway.">
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
                </FormField>
              ) : null}
              <FormField
                label="API key"
                description={apiKeyConfigured ? 'Already configured. Leave blank to keep the current key.' : 'Stored locally in the runtime settings secret store.'}
              >
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={apiKeyConfigured ? 'Configured — leave blank to keep it' : 'Paste API key'}
                  type="password"
                  autoComplete="off"
                />
              </FormField>
              {message ? <div className="inlineStatus neutral">{message}</div> : null}
              <div className="formActions">
                <button className="primaryButton" type="submit" disabled={!canSave}>{saving ? 'Saving...' : 'Save provider'}</button>
              </div>
            </form>
          ) : (
            <p className="mutedText">Runtime settings are still loading. The console can run with local defaults once the server is ready.</p>
          )}
        </div>
        <div className="stack">
          <div className="panel subtlePanel">
            <h2>Project</h2>
            <p>Workspace config, metadata, logs, and runtime files live under the workspace state directory.</p>
            <KeyValuePanel rows={[
              ['Workspace', workspaceLabel],
              ['Root folder', pathName(data.workspace?.root) || data.workspace?.name],
              ['Configuration folder', workspaceConfigDir(data.workspace)],
            ]} />
          </div>
          <div className="panel subtlePanel">
            <div className="builderSetupHeader compact">
              <span className="softIcon success"><CheckCircle2 size={18} /></span>
              <div>
                <h2>Local defaults</h2>
                <p>These are active defaults, not a list of fake providers.</p>
              </div>
            </div>
            <KeyValuePanel rows={[
              ['Agent runtime', settings?.saved_config.loop_engine.provider ?? 'builtin'],
              ['Metadata', metadataStorageLabel(settings, data.workspace)],
              ['Artifacts', artifactStorageLabel(settings, data.workspace)],
              ['Memory', memoryLabel(settings, data.runtime?.memory)],
              ['Sandbox', settings?.saved_config.sandbox.provider ?? data.runtime?.sandbox_providers[0] ?? 'local'],
            ]} />
            <button className="secondaryButton fitButton" type="button" onClick={() => setView('advanced')}>Advanced runtime settings</button>
          </div>
          <div className="panel subtlePanel">
            <div className="builderSetupHeader compact">
              <span className="softIcon"><Play size={18} /></span>
              <div>
                <h2>Next step</h2>
                <p>Create an agent, then start a session. The rest of the console is organized around that builder loop.</p>
              </div>
            </div>
            <div className="buttonRow">
              <button className="primaryButton" type="button" onClick={() => setView('agents')}>Create agent</button>
              <button className="secondaryButton" type="button" onClick={() => setView('sessions')}>Start session</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function runtimeDatabasePath(workspace: Workspace | null) {
  return workspace?.databasePath
    ?? workspace?.directories?.database
    ?? (workspace?.dataDir ? `${workspace.dataDir.replace(/\/$/, '')}/data.db` : undefined);
}

function defaultModelBaseUrl(vendor: RuntimeSettingsConfig['model']['vendor'] | undefined): string {
  if (vendor === 'minimax') return 'https://api.minimax.io/v1';
  return '';
}

function metadataStorageLabel(settings: RuntimeSettings | null, workspace: Workspace | null) {
  const provider = settings?.saved_config.storage.metadata.provider ?? 'sqlite';
  const path = runtimeDatabasePath(workspace) ?? settings?.diagnostics.metadata.path;
  return path ? `${provider} · ${pathName(path)}` : provider;
}

function artifactStorageLabel(settings: RuntimeSettings | null, workspace: Workspace | null) {
  const provider = settings?.saved_config.storage.artifacts.provider ?? 'local';
  const root = workspace?.directories?.data ?? workspace?.dataDir;
  return root ? `${provider} · ${pathName(root)}` : provider;
}

function memoryLabel(settings: RuntimeSettings | null, runtimeMemory?: string) {
  if (!settings) return runtimeMemory ?? 'sqlite';
  return settings.saved_config.memory.enabled ? settings.saved_config.memory.provider : 'off';
}
