import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDetail, Agents } from '../../apps/console/src/components/pages/AgentPages.js';
import { Files, Skills } from '../../apps/console/src/components/pages/BuildPages.js';
import { CredentialVaultDetail, CredentialVaults } from '../../apps/console/src/components/pages/CredentialPages.js';
import { EnvironmentDetail, Environments } from '../../apps/console/src/components/pages/EnvironmentPages.js';
import { MemoryStoreDetail, MemoryStores } from '../../apps/console/src/components/pages/MemoryPages.js';
import { OutcomesPage, ScheduledDeploymentsPage, WebhooksPage } from '../../apps/console/src/components/pages/OperationsPages.js';
import { SessionDetail, Sessions } from '../../apps/console/src/components/pages/SessionPages.js';
import { Observability, SettingsLogs } from '../../apps/console/src/components/pages/settings/OperationsSettings.js';
import { SettingsView } from '../../apps/console/src/components/pages/settings/SettingsView.js';
import type { SettingsSection } from '../../apps/console/src/components/pages/settings/navigation.js';
import type { ConsoleData, RuntimeSettings, RuntimeSettingsConfig } from '../../apps/console/src/types.js';

const runtimeSettingsConfig: RuntimeSettingsConfig = {
  schema_version: 1,
  model: { vendor: 'openai', api_key: '********', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
  storage: {
    metadata: { provider: 'sqlite', options: {} },
    artifacts: { provider: 'local', options: { base_path: 'files' } },
  },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
};

const runtimeSettings: RuntimeSettings = {
  schema_version: 1,
  revision: 1,
  effective_revision: 1,
  saved_config: runtimeSettingsConfig,
  effective_config: runtimeSettingsConfig,
  restart_required: false,
  activation_status: 'active',
  activation_errors: [],
  diagnostics: { metadata: { path: '/tmp/data.db', health: 'ok' } },
  secret_states: { model: { api_key: 'configured' } },
  adapters: {
    model: [
      { id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
      { id: 'anthropic', label: 'Anthropic', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
    ],
    loop_engine: [
      { id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
    ],
    storage: {
      metadata: [
        { id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
      ],
      artifacts: [
        { id: 'local', label: 'Local filesystem', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
      ],
    },
    memory: [
      { id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
    ],
    sandbox: [
      { id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} },
    ],
  },
};

function emptyConsoleData(overrides: Partial<ConsoleData> = {}): ConsoleData {
  return {
    agents: [],
    sessions: [],
    environments: [],
    vaults: [],
    memoryStores: [],
    files: [],
    apiKeys: [],
    skills: [],
    templates: [],
    webhooks: [],
    scheduledDeployments: [],
    outcomes: [],
    runtime: {
      status: 'running',
      agents_loaded: 0,
      models: [],
      sandbox_providers: ['local'],
      memory: 'sqlite',
      auth_enabled: false,
    },
    settings: runtimeSettings,
    workspace: {
      type: 'workspace',
      name: 'Default',
      target: 'local',
    },
    ...overrides,
  };
}

const now = '2026-07-23T00:00:00.000Z';

function populatedConsoleData(): ConsoleData {
  const agent = {
    id: 'agent_review',
    type: 'agent' as const,
    name: 'Review Agent',
    description: 'Reviews local dashboard UI.',
    system: 'Review the console.',
    model: 'default',
    tools: [{ type: 'agent_toolset_20260401' as const }],
    skills: [{ type: 'custom' as const, skill_id: 'skill_ui' }],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 3,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  const environment = {
    id: 'env_local',
    type: 'environment' as const,
    name: 'Local sandbox',
    description: 'Local execution template.',
    hosting_type: 'local' as const,
    sandbox_provider: 'local',
    network: { type: 'limited', allow_mcp_server_network_access: false },
    packages: [],
    status: 'active',
    config: {},
    metadata: {},
    worker_keys: [],
    work_queue: { queued: 0 },
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  const session = {
    id: 'sess_review',
    type: 'session' as const,
    title: 'Dashboard pass',
    agent,
    environment_id: environment.id,
    status: 'idle' as const,
    resources: [],
    vault_ids: [],
    usage: { input_tokens: 1200, output_tokens: 450 },
    stats: {},
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  return emptyConsoleData({
    agents: [agent],
    sessions: [session],
    environments: [environment],
    vaults: [{
      id: 'vlt_ui',
      type: 'credential_vault',
      name: 'UI Vault',
      description: 'Credentials used during UI review.',
      status: 'active',
      credential_count: 1,
      credentials: [{
        id: 'vcrd_ui_token',
        type: 'credential',
        vault_id: 'vlt_ui',
        name: 'Runtime token',
        auth_type: 'bearer_token',
        mcp_server_url: '',
        variable_name: '',
        value_hint: 'ma_…token',
        network: {},
        injection_locations: ['request_headers'],
        status: 'active',
        metadata: {},
        created_at: now,
        updated_at: now,
        last_used_at: null,
        archived_at: null,
      }],
      created_at: now,
      updated_at: now,
      archived_at: null,
    }],
    memoryStores: [{
      id: 'memstore_ui',
      type: 'memory_store',
      name: 'UI Memory',
      description: 'Persistent context for UI review.',
      status: 'active',
      memories: [{
        id: 'mem_ui_note',
        type: 'memory',
        path: '/reviews/visual-polish',
        content: 'Keep the dashboard dense, quiet, and inspectable.',
        content_size_bytes: 51,
        content_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        metadata: {},
        created_at: now,
        updated_at: now,
        archived_at: null,
      }],
      created_at: now,
      updated_at: now,
      archived_at: null,
    }],
    files: [{
      id: 'file_notes',
      type: 'file',
      name: 'notes.md',
      media_type: 'text/markdown',
      size_bytes: 512,
      role: 'file',
      session_id: null,
      artifact_path: null,
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      preview: '# Notes',
      preview_truncated: false,
    }],
    skills: [{
      id: 'skill_ui',
      type: 'skill',
      name: 'ui-review',
      display_title: 'UI Review',
      description: 'Checklist for dashboard polish.',
      compatibility: 'Requires git and network access.',
      source: 'custom',
      latest_version: '202607230001',
      versions: [{ id: '202607230001', created_at: now, latest: true }],
      created_at: now,
      updated_at: now,
      file: 'ui-review/SKILL.md',
    }],
    webhooks: [{
      id: 'wh_ui',
      type: 'webhook',
      name: 'UI events',
      url: 'https://example.com/hook',
      events: ['turn_complete'],
      description: '',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
    }],
    scheduledDeployments: [{
      id: 'sched_ui',
      type: 'scheduled_deployment',
      name: 'Nightly review',
      agent_id: agent.id,
      environment_id: environment.id,
      cron: '0 9 * * *',
      payload: {},
      status: 'active',
      last_run_at: null,
      next_run_at: now,
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
    }],
    outcomes: [{
      id: 'out_ui',
      type: 'outcome',
      name: 'Polished UI',
      description: '',
      objective: 'Dashboard is clear and balanced.',
      criteria: ['No fake provider UI', 'Readable tables'],
      pass_threshold: 0.8,
      evaluator: 'deterministic',
      metadata: {},
      status: 'active',
      created_at: now,
      updated_at: now,
      archived_at: null,
    }],
  });
}

describe('Console page static coverage', () => {
  it.skip('keeps core visual CSS guardrails for the Claude-like console skin', () => {
    const css = readFileSync('apps/console/src/styles.css', 'utf8');
    expect(css).toContain('--success:');
    expect(css).toContain('--warning-text:');
    expect(css).not.toContain('.darkButton');
    expect(css).not.toContain('.consoleNotice');
    expect(css).not.toContain('.runtimeConnection');
    expect(css).not.toContain('.modelsProviderTable');
    expect(css).not.toContain('.memoryProviderTable');
    expect(css).not.toContain('.defaultProviderBadge');
    expect(css).not.toContain('.adapterRequiredBadge');
    expect(css).not.toContain('.filesBrowser');
    expect(css).not.toContain('.filePreviewPanel');
    expect(css).not.toContain('.apiDocsCodeRail');
    expect(css).not.toContain('.runtimeStatusDot');
    expect(css).not.toContain('.promptActions');
    expect(css).not.toContain('.templateGrid');
    expect(css).not.toContain('.templateCard');
    expect(css).not.toContain('.codePreview');
    expect(css).not.toContain('.resourceGrid');
    expect(css).not.toContain('.resourceCard');
    expect(css).not.toContain('.resourceIcon');
    expect(css).not.toContain('.formGrid');
    expect(css).not.toContain('.toolGrid');
    expect(css).not.toContain('.skillPicker');
    expect(css).not.toContain('.skillReferenceGrid');
    expect(css).not.toContain('.pluginSettingsGrid');
    expect(css).not.toContain('.pluginSettingsPanel');
    expect(css).not.toContain('.pluginSettingsHeader');
    expect(css).not.toContain('.pluginSelectField');
    expect(css).not.toContain('.checkRow');
    expect(css).not.toContain('.selectCol');
    expect(css).not.toContain('.fitButton');
    expect(css).not.toContain('.multiSelectPanel');
    expect(css).not.toContain('.agentTablePanel');
    expect(css).toContain('.agentsTablePanel');
    expect(css).toMatch(/\.agentsTablePanel,[\s\S]*\.credentialTablePanel\s*\{[^}]*border-radius:\s*var\(--radius\)/s);
    expect(css).toMatch(/\.agentsTablePanel table,[\s\S]*\.credentialTablePanel table\s*\{[^}]*min-width:\s*720px/s);
    expect(css).toMatch(/\.modalHeader\s*\{[^}]*align-items:\s*flex-start/s);
    expect(css.match(/\.modalHeader\s*\{/g)?.length).toBe(1);
    expect(css).toMatch(/\.metricCard strong\s*\{[^}]*font-size:\s*24px/s);
    expect(css).toMatch(/\.metricCard span\s*\{[^}]*font-size:\s*12px/s);
    expect(css).toMatch(/\.summaryStrip\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/s);
    expect(css).toMatch(/th,\s*td\s*\{[^}]*padding:\s*10px 10px/s);
    expect(css).toMatch(/\.tablePanel thead th\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.clickableRow:hover td\s*\{[^}]*color-mix/s);
    expect(css).toMatch(/\.mobileAgentCard,[\s\S]*\.mobileFileCard\s*\{[^}]*min-height:\s*78px/s);
    expect(css).toMatch(/\.resourceBadge\s*\{[^}]*min-height:\s*28px/s);
    expect(css.match(/\.resourceBadge\s*\{/g)?.length).toBe(1);
    expect(css).toMatch(/\.detailCrumb,[\s\S]*\.sessionCrumb\s*\{[^}]*margin-bottom:\s*6px/s);
    expect(css).toMatch(/\.systemPreviewHeader\s*\{[^}]*min-height:\s*38px/s);
    expect(css).toMatch(/\.agentsTablePanel,[\s\S]*\.operationTablePanel,[\s\S]*\.credentialTablePanel\s*\{[^}]*border-color:\s*var\(--border-subtle\)/s);
    expect(css).toMatch(/\.operationGuideCard\s*\{[^}]*min-height:\s*78px/s);
    expect(css).toMatch(/\.eventRow\s*\{[^}]*grid-template-columns:\s*minmax\(124px,\s*160px\) minmax\(0,\s*1fr\) 88px/s);
    expect(css).toMatch(/\.apiSnippet\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(css.match(/\.apiSnippet\s*\{/g)?.length).toBe(1);
    expect(css).toMatch(/\.settingsSearch input\s*\{[^}]*color:\s*var\(--text\)/s);
    expect(css).toMatch(/\.apiDocsSearch input\s*\{[^}]*color:\s*var\(--text\)/s);
    expect(css).toMatch(/select\s*\{[^}]*z-index:\s*4/s);
    expect(css).toMatch(/\.settingsSidebar\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.settingsOverviewCard\s*\{[^}]*align-items:\s*center/s);
    expect(css).toMatch(/\.noticeBox\s*\{[^}]*background:\s*var\(--surface-muted\)/s);
    expect(css).toMatch(/\.noticeBox\.warning\s*\{[^}]*background:\s*var\(--warning-soft\)/s);
    expect(css).toMatch(/\.settingsNotice\.compact\s*\{[^}]*display:\s*inline-flex/s);
    expect(css).toMatch(/\.mutedValue\s*\{[^}]*color:\s*var\(--muted\)/s);
    expect(css).toMatch(/\.agentTable,[\s\S]*\.resourceTable\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.skillsPage,[\s\S]*\.filesView\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.apiDocsShell\s*\{[^}]*max-width:\s*1080px/s);
    expect(css).toMatch(/\.apiDocsArticle\s*\{[^}]*max-width:\s*780px/s);
    expect(css).toContain('.settingsTruthStrip');
    expect(css).toMatch(/\.roadmapAdapterCard\.roadmap\s*\{[^}]*background:\s*var\(--surface-muted\)/s);
    expect(css).toContain('body.modalOpen');
    expect(css).toMatch(/\.readonlyTable \.emptyState\s*\{[^}]*min-height:\s*118px/s);
    expect(css).toContain('.artifactEmptyPreview');
    expect(css).toContain('.emptyRenderedEvent');
    expect(css).toContain('.skillVersionList .emptyState');
    expect(css).toMatch(/\.versionPanel \.emptyState,[\s\S]*\.detailSection \.emptyState/s);
    expect(css).toMatch(/label\.filterSelect\s*\{[^}]*z-index:\s*3/s);
    expect(css).toContain('.ghostButton:hover');
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.resourceTablePanel\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.filesTablePanel\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.operationTablePanel\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.credentialTablePanel\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.agentHeroActions \.largeAction\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.settingsTruthStrip,[\s\S]*\.settingsTwoColumn,[\s\S]*\.roadmapAdapterGrid/s);
    const settingsPage = readFileSync('apps/console/src/components/pages/settings/SettingsPage.tsx', 'utf8');
    expect(settingsPage).not.toContain('className="button secondary"');
    for (const file of [
      'apps/console/src/components/pages/AgentPages.tsx',
      'apps/console/src/components/pages/SessionPages.tsx',
      'apps/console/src/components/pages/EnvironmentPages.tsx',
      'apps/console/src/components/pages/CredentialPages.tsx',
      'apps/console/src/components/pages/MemoryPages.tsx',
      'apps/console/src/components/pages/AgentModals.tsx',
      'apps/console/src/components/pages/SessionModals.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('darkButton');
    }
    expect(settingsPage).not.toContain('placeholder="Search settings..." disabled');
    expect(settingsPage).not.toContain('<span>Search endpoints...</span>');
    expect(settingsPage).not.toContain('Runtime connected');
    expect(settingsPage).toContain('settingsNoResults');
    expect(settingsPage).toContain("aria-current={active === item.id ? 'page' : undefined}");
    expect(settingsPage).toContain('apiDocsNoResults');
    expect(settingsPage).toContain('filteredApiDocs.find((endpoint) => endpoint.id === activeEndpointId)');
    expect(settingsPage).toContain('apiDocsEmptyArticle');
    expect(settingsPage).toContain('apiParamEmpty');
    expect(settingsPage).toContain('unsupported beta features must be rejected or surfaced as warnings');
    expect(settingsPage).toContain('Runtime diagnostics truth model');
    expect(settingsPage).toContain('Model provider status is health metadata, not a model catalog.');
    expect(settingsPage).not.toContain('<div className="emptyValue">No parameters.</div>');
    expect(settingsPage).toContain('browserTokenHeader');
    expect(settingsPage).toContain('Stored locally');
    expect(settingsPage).toContain('data.settings?.model_provider?.vendor');
    expect(settingsPage).toContain('data.settings?.loop_engine?.type');
    expect(settingsPage).toContain('data.settings?.memory?.backend?.type');
    expect(settingsPage).toContain('data.settings?.sandbox?.type');
    expect(settingsPage).not.toContain('model_provider?.provider');
    expect(settingsPage).not.toContain('loop_engine?.provider');
    expect(settingsPage).not.toContain('memory?.provider');
    expect(settingsPage).not.toContain('sandbox?.provider');
    const sessionPage = readFileSync('apps/console/src/components/pages/SessionPages.tsx', 'utf8');
    expect(sessionPage).not.toContain('?? events[0]');
    expect(sessionPage).not.toContain('<div className="emptyValue">No inline preview');
    expect(sessionPage).not.toContain('No rendered content.');
    expect(sessionPage).toContain('artifactEmptyPreview');
    expect(sessionPage).toContain('emptyRenderedEvent');
    expect(sessionPage).toContain('placeholder="Search events"');
    expect(sessionPage).toContain('eventFilterFooter');
    expect(sessionPage).toContain('Reset filters');
    expect(sessionPage).toContain('miniEventEmpty');
    expect(sessionPage).toContain("label: 'Pending actions'");
    expect(sessionPage).toContain("value: formatUsage(session.usage)");
    const routeHook = readFileSync('apps/console/src/hooks/useHashRoute.ts', 'utf8');
    expect(routeHook).toContain("'webhooks'");
    expect(routeHook).toContain("'scheduled-deployments'");
    expect(routeHook).toContain("'outcomes'");
    const appShell = readFileSync('apps/console/src/App.tsx', 'utf8');
    expect(appShell).toContain('aria-label="Primary navigation"');
    expect(appShell).toContain("aria-current={active ? 'page' : undefined}");
    expect(appShell).toContain('ConsoleRouteView');
    expect(appShell).not.toContain('function View(props');
    expect(appShell).not.toContain("case 'agent-detail'");
    const consoleRoutes = readFileSync('apps/console/src/components/ConsoleRoutes.tsx', 'utf8');
    expect(consoleRoutes).toContain('export const NAV_GROUPS');
    expect(consoleRoutes).toContain('export const SETTINGS_VIEW_IDS');
    expect(consoleRoutes).toContain('export function ConsoleRouteView');
    expect(consoleRoutes).toContain("label: 'Advanced'");
    expect(consoleRoutes).toContain("label: 'System'");
    expect(consoleRoutes).toContain("case 'agent-detail'");
    expect(consoleRoutes).toContain("case 'api-reference'");
    const modal = readFileSync('apps/console/src/components/Modal.tsx', 'utf8');
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain("document.body.classList.add('modalOpen')");
    const settingsNavigation = readFileSync('apps/console/src/components/pages/settings/navigation.ts', 'utf8');
    expect(settingsNavigation).toContain("label: 'Setup'");
    expect(settingsNavigation).toContain("label: 'Advanced'");
    expect(settingsNavigation).not.toContain("label: 'Loop engine'");
    expect(settingsNavigation).not.toContain("label: 'Storage'");
    expect(settingsNavigation).not.toContain("label: 'Memory'");
    expect(settingsNavigation).not.toContain("label: 'Sandbox'");
    const settingsAdvanced = readFileSync('apps/console/src/components/pages/settings/SettingsAdvanced.tsx', 'utf8');
    expect(settingsAdvanced).toContain('Runtime defaults');
    expect(settingsAdvanced).toContain('Loop engine editor');
    expect(settingsAdvanced).toContain('Storage editor');
    expect(settingsAdvanced).toContain('Memory editor');
    expect(settingsAdvanced).toContain('Sandbox editor');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).toContain('mobileResourceList');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).toContain('mobileResourceCard');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).toContain('Memory Stores are attachable session resources');
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8')).toContain('mobileResourceList');
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8')).toContain('mobileResourceCard');
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8')).toContain('Stored encrypted');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('Environments describe reusable session policy');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('mobileResourceCard');
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8')).toContain('<th>Credentials</th>');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8').match(/Create agent/g)?.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).toContain('systemPreviewHeader');
    expect(readFileSync('apps/console/src/components/pages/AgentModals.tsx', 'utf8')).toContain("data.runtime?.models[0]?.name ?? 'default'");
    expect(readFileSync('apps/console/src/components/pages/AgentModals.tsx', 'utf8')).not.toContain("?? 'claude-sonnet-5'");
    expect(readFileSync('apps/console/src/components/pages/AgentModals.tsx', 'utf8')).toContain('Validated on save');
    const quickCreateSessionModals = readFileSync('apps/console/src/components/pages/SessionModals.tsx', 'utf8');
    expect(quickCreateSessionModals).toContain('Local is the v1 quick-start path');
    expect(quickCreateSessionModals).not.toContain('<option value="cloud">Cloud</option>');
    expect(quickCreateSessionModals).not.toContain('<option value="self_hosted">Self-hosted</option>');
    expect(css).toMatch(/\.yamlToolbar\s*\{[^}]*border-bottom:\s*1px solid var\(--border-subtle\)/s);
    expect(readFileSync('apps/console/src/components/pages/SessionPages.tsx', 'utf8').match(/Create session/g)?.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8').match(/Create environment/g)?.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8').match(/Create vault/g)?.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8').match(/Add credential/g)?.length).toBeGreaterThanOrEqual(4);
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8').match(/Create memory store/g)?.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).not.toContain('<div className="memoryTreeEmpty">No memories</div>');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).toContain('title="No memories yet"');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain('mobileResourceList');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain('mobileResourceCard');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain('Files truth model');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain('<th>Role</th>');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain("file.role === 'artifact' ? 'Artifact' : 'File'");
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain("label: 'Versions'");
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain("label: 'Latest'");
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).not.toContain('<div className="emptyInline">No versions</div>');
    expect(readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8')).toContain('title="No versions"');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).not.toContain('Memory store actions');
    expect(readFileSync('apps/console/src/components/pages/CredentialPages.tsx', 'utf8')).not.toContain('Vault actions</button>');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).not.toContain('Environment actions</button>');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('setSetupVisible(false)');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).not.toContain('Select all agents');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).not.toContain('Select sessions');
    expect(readFileSync('apps/console/src/components/pages/SessionPages.tsx', 'utf8')).not.toContain('Select all sessions');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).not.toContain('Select all environments');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).not.toContain('<div className="emptyValue">No environment keys</div>');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).not.toContain('<div className="emptyValue">No queued work items</div>');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('title="No environment keys"');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('title="No queued work items"');
    expect(readFileSync('apps/console/src/components/pages/MemoryPages.tsx', 'utf8')).not.toContain('Select memory stores');
    for (const file of [
      'apps/console/src/components/pages/BuildPages.tsx',
      'apps/console/src/components/pages/CredentialPages.tsx',
      'apps/console/src/components/pages/EnvironmentPages.tsx',
      'apps/console/src/components/pages/MemoryPages.tsx',
      'apps/console/src/components/pages/OperationsPages.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('mobileAgentCard');
      expect(readFileSync(file, 'utf8')).toContain('mobileResourceCard');
    }
    expect(readFileSync('apps/console/src/components/pages/AgentModals.tsx', 'utf8')).not.toContain('<button type="button">YAML');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).not.toContain('filterButton" type="button">Version');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).not.toContain('<p className="emptyInline">Select two versions to compare.</p>');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).not.toContain('<p className="emptyInline">No skills attached.</p>');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).toContain('title="Select two versions"');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).toContain('title="No skills attached"');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).toContain('permissionPolicyLabel');
    expect(readFileSync('apps/console/src/components/pages/AgentPages.tsx', 'utf8')).toContain('sessionAgentVersionLabel');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('environmentBackendLabel');
    expect(readFileSync('apps/console/src/components/pages/EnvironmentPages.tsx', 'utf8')).toContain('editorNoticeCard');
    expect(css).toContain('.readonlyFilterBadge');
    expect(css).toContain('.editorModeBadge');
    expect(css).toContain('.browserTokenHeader');
    expect(css).toContain('.clearSearchButton');
    expect(css).toContain('.eventFilterFooter');
    expect(css).toContain('.miniEventEmpty');
    expect(css).toContain('.apiDocsEmptyArticle');
    expect(css).toContain('.apiParamEmpty');
    expect(css).toContain('.operationGuideGrid');
    expect(css).toContain('.operationGuideCard');
    expect(css).toContain('.operationNotice');
    expect(css).toContain('.operationCreateForm');
    expect(css).toContain('.fileUploadDropzone');
    expect(css).toContain('.uploadRequirementGrid');
    expect(css).toContain('.providerStateBadge.ok');
    expect(css).toContain('.settingsValidationItem strong');
    expect(css).toContain('.settingsJsonField');
    expect(css).toMatch(/\.settingsJsonPanel textarea\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(css).toMatch(/\.secretReveal\s*\{[^}]*linear-gradient/s);
    expect(css).toMatch(/\.secretReveal code\s*\{[^}]*font-size:\s*12px/s);
    expect(css).not.toContain('.storageProviderTable');
    expect(css).not.toContain('.storageProviderHeader');
    expect(css).not.toContain('.storageModalGrid');
    expect(css).not.toContain('border: 0;\n  border-radius: 0;\n  background: transparent;\n}\n\n.stack > .tablePanel table');
    expect(css).toContain('.claudeTemplateGrid .emptyState');
    expect(css).toContain('.sessionResourceEmpty');
    expect(css).toContain('.editorNoticeCard');
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.uploadRequirementGrid\s*\{[^}]*grid-template-columns:\s*1fr/s);
    for (const file of [
      'apps/console/src/components/pages/AgentPages.tsx',
      'apps/console/src/components/pages/SessionPages.tsx',
      'apps/console/src/components/pages/EnvironmentPages.tsx',
      'apps/console/src/components/pages/MemoryPages.tsx',
      'apps/console/src/components/pages/CredentialPages.tsx',
      'apps/console/src/components/pages/BuildPages.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).toContain('SummaryStrip');
    }
    const operationsPage = readFileSync('apps/console/src/components/pages/OperationsPages.tsx', 'utf8');
    expect(operationsPage).toContain('operationTablePanel');
    expect(operationsPage).toContain("label: 'Retry mode'");
    expect(operationsPage).toContain("label: 'Runner'");
    expect(operationsPage).toContain("label: 'Evaluator'");
    expect(operationsPage).toContain('OperationGuide');
    expect(operationsPage).toContain('OperationNotice');
    expect(operationsPage).toContain('WebhookCreateModal');
    expect(operationsPage).toContain('ScheduledDeploymentCreateModal');
    expect(operationsPage).toContain('OutcomeCreateModal');
    expect(operationsPage).toContain('Create webhook');
    expect(operationsPage).toContain('Create schedule');
    expect(operationsPage).toContain('Create outcome');
    expect(operationsPage.match(/Create webhook/g)?.length).toBeGreaterThanOrEqual(3);
    expect(operationsPage.match(/Create schedule/g)?.length).toBeGreaterThanOrEqual(3);
    expect(operationsPage.match(/Create outcome/g)?.length).toBeGreaterThanOrEqual(3);
    expect(operationsPage).toContain('parseJsonObject');
    expect(operationsPage).not.toContain('through the API for now');
    expect(operationsPage).not.toContain('Create webhook records with the API or SDK');
    expect(operationsPage).toContain('Create webhook records here');
    expect(operationsPage).not.toContain('{message ? <div className="noticeBox">{message}</div> : null}');
    expect(operationsPage).toContain('disabled={retrying || data.webhooks.length === 0}');
    expect(operationsPage).toContain('disabled={runningDue || data.scheduledDeployments.length === 0}');
    expect(operationsPage.match(/mobileResourceList/g)?.length).toBeGreaterThanOrEqual(3);
    const operationsSettings = readFileSync('apps/console/src/components/pages/settings/OperationsSettings.tsx', 'utf8');
    expect(operationsSettings).toContain('No runtime logs');
    expect(operationsSettings).toContain('Refresh metrics');
    expect(operationsSettings).toContain('loadMetrics');
    expect(operationsSettings).toContain('Logs truth model');
    expect(operationsSettings).toContain('Monitoring truth model');
    expect(operationsSettings).toContain('Monitoring is read-only');
    const buildPages = readFileSync('apps/console/src/components/pages/BuildPages.tsx', 'utf8');
    expect(buildPages).toContain('fileUploadDropzone');
    expect(buildPages).toContain('Drop files here to upload');
    expect(buildPages).toContain('uploadRequirementGrid');
    expect(buildPages.match(/Upload file/g)?.length).toBeGreaterThanOrEqual(3);
    expect(buildPages).toContain('Root SKILL.md required');
    const agentModals = readFileSync('apps/console/src/components/pages/AgentModals.tsx', 'utf8');
    expect(agentModals).toContain('ChevronDown, FileText');
    expect(agentModals).toContain('No templates');
    expect(agentModals).toContain('Saving creates a validated agent version');
    const sessionModals = readFileSync('apps/console/src/components/pages/SessionModals.tsx', 'utf8');
    expect(sessionModals).toContain('ExternalLink');
    expect(sessionModals).toContain('Search');
    expect(sessionModals).toContain('Select a file');
    expect(sessionModals).toContain('formatBytes(file.size_bytes)');
    expect(sessionModals).toContain('formatDateShort');
    expect(sessionModals).toContain('sessionResourceEmpty');
    for (const file of [
      'apps/console/src/components/pages/AgentPages.tsx',
      'apps/console/src/components/pages/SessionPages.tsx',
      'apps/console/src/components/pages/MemoryPages.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('onChange={() => undefined}');
    }
  });

  it('renders core resource pages without crashing', () => {
    const data = emptyConsoleData();
    expect(renderToString(React.createElement(Agents, { data, onNewAgent: () => {}, onOpenAgent: () => {} }))).toContain('No agents');
    expect(renderToString(React.createElement(Sessions, { data, onNewSession: () => {}, onOpenSession: () => {} }))).toContain('No sessions');
    expect(renderToString(React.createElement(Environments, { data, onNew: () => {}, onOpenEnvironment: () => {} }))).toContain('No environments');
    expect(renderToString(React.createElement(Files, { data, onRefresh: () => {} }))).toContain('No files');
  });

  it('renders populated list pages with tables, badges, and actions', () => {
    const data = populatedConsoleData();
    const agentsHtml = renderToString(React.createElement(Agents, { data, onNewAgent: () => {}, onOpenAgent: () => {} }));
    expect(agentsHtml).toContain('Review Agent');
    expect(agentsHtml).toContain('class="stack"');
    expect(agentsHtml).toContain('class="pageIntro"');
    expect(agentsHtml).toContain('agentsTablePanel');
    expect(agentsHtml).toContain('mobileAgentCard');
    expect(agentsHtml).not.toContain('mobileResourceCard');

    const sessionsHtml = renderToString(React.createElement(Sessions, { data, onNewSession: () => {}, onOpenSession: () => {} }));
    expect(sessionsHtml).toContain('Dashboard pass');
    expect(sessionsHtml).toContain('class="stack"');
    expect(sessionsHtml).toContain('class="pageIntro"');
    expect(sessionsHtml).toContain('sessionsTablePanel');
    expect(sessionsHtml).toContain('mobileAgentCard');

    const environmentsHtml = renderToString(React.createElement(Environments, { data, onNew: () => {}, onOpenEnvironment: () => {} }));
    expect(environmentsHtml).toContain('Local sandbox');
    expect(environmentsHtml).toContain('class="stack"');
    expect(environmentsHtml).toContain('class="pageIntro"');
    expect(environmentsHtml).toContain('environmentsTablePanel');
    expect(environmentsHtml).toContain('mobileResourceList');
    expect(environmentsHtml).toContain('mobileResourceList');

    const filesHtml = renderToString(React.createElement(Files, { data, onRefresh: () => {} }));
    expect(filesHtml).toContain('notes.md');
    expect(filesHtml).toContain('class="stack filesView claudeFilesView"');
    expect(filesHtml).toContain('filesTablePanel');

    const webhooksHtml = renderToString(React.createElement(WebhooksPage, { data, onRefresh: () => {} }));
    expect(webhooksHtml).toContain('UI events');
    expect(webhooksHtml).toContain('operationTablePanel');
    expect(webhooksHtml).toContain('mobileResourceList');
    expect(webhooksHtml).toContain('mobileResourceList');

    const schedulesHtml = renderToString(React.createElement(ScheduledDeploymentsPage, { data, onRefresh: () => {} }));
    expect(schedulesHtml).toContain('Nightly review');
    expect(schedulesHtml).toContain('operationTablePanel');
    expect(schedulesHtml).toContain('mobileResourceList');
    expect(schedulesHtml).toContain('mobileResourceList');

    const outcomesHtml = renderToString(React.createElement(OutcomesPage, { data, onRefresh: () => {} }));
    expect(outcomesHtml).toContain('Polished UI');
    expect(outcomesHtml).toContain('operationTablePanel');
    expect(outcomesHtml).toContain('mobileResourceList');
    expect(outcomesHtml).toContain('mobileResourceList');
  });

  it('renders representative detail pages without falling back to empty shells', () => {
    const data = populatedConsoleData();
    expect(renderToString(React.createElement(AgentDetail, {
      agent: data.agents[0],
      data,
      tab: 'agent',
      onTab: () => {},
      onBack: () => {},
      onEdit: () => {},
      onNewSession: () => {},
      onOpenSession: () => {},
      onRefresh: () => {},
    }))).toContain('MCPs and tools');
    expect(renderToString(React.createElement(AgentDetail, {
      agent: data.agents[0],
      data,
      tab: 'agent',
      onTab: () => {},
      onBack: () => {},
      onEdit: () => {},
      onNewSession: () => {},
      onOpenSession: () => {},
      onRefresh: () => {},
    }))).toContain('Version');
    expect(renderToString(React.createElement(EnvironmentDetail, {
      environment: data.environments[0],
      data,
      onBack: () => {},
      onRefresh: () => {},
    }))).toContain('Local execution template.');
    expect(renderToString(React.createElement(EnvironmentDetail, {
      environment: data.environments[0],
      data,
      onBack: () => {},
      onRefresh: () => {},
    }))).toContain('Local');
    expect(renderToString(React.createElement(SessionDetail, {
      session: data.sessions[0],
      data,
      onBack: () => {},
      onRefresh: () => {},
      onOpenAgent: () => {},
    }))).toContain('sess_review');
    expect(renderToString(React.createElement(AgentDetail, {
      agent: data.agents[0],
      data,
      tab: 'deployments',
      onTab: () => {},
      onBack: () => {},
      onEdit: () => {},
      onNewSession: () => {},
      onOpenSession: () => {},
      onRefresh: () => {},
    }))).toContain('Deployments are not configured for this local runtime');
  });

  it('renders Skills as a table-first empty state without a default drawer', () => {
    const html = renderToString(React.createElement(Skills, { data: emptyConsoleData(), onRefresh: () => {} }));
    expect(html).toContain('No skills');
    expect(html).not.toContain('skillsLayout hasDrawer');
  });

  it('renders operations empty states without crashing', () => {
    const data = emptyConsoleData();
    expect(renderToString(React.createElement(WebhooksPage, { data, onRefresh: () => {} }))).toContain('No webhooks');
    expect(renderToString(React.createElement(ScheduledDeploymentsPage, { data, onRefresh: () => {} }))).toContain('No scheduled deployments');
    expect(renderToString(React.createElement(OutcomesPage, { data, onRefresh: () => {} }))).toContain('No outcomes');
  });

  it('renders Memory Stores list and empty detail states', () => {
    const data = emptyConsoleData();
    expect(renderToString(React.createElement(MemoryStores, { data, onNew: () => {}, onOpenMemoryStore: () => {} }))).toContain('No memory stores');
    expect(renderToString(React.createElement(MemoryStoreDetail, {
      store: {
        id: 'memstore_empty',
        type: 'memory_store',
        name: 'Empty store',
        description: '',
        status: 'active',
        memories: [],
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
        archived_at: null,
      },
      onBack: () => {},
      onRefresh: () => {},
      onNewMemory: () => {},
    }))).toContain('No memories yet');
    expect(renderToString(React.createElement(MemoryStoreDetail, {
      store: {
        id: 'memstore_empty',
        type: 'memory_store',
        name: 'Empty store',
        description: '',
        status: 'active',
        memories: [],
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
        archived_at: null,
      },
      onBack: () => {},
      onRefresh: () => {},
      onNewMemory: () => {},
    }))).toContain('No memories yet');
  });

  it('keeps populated Memory Store detail list-first without auto-opening memory content', () => {
    const data = populatedConsoleData();
    const html = renderToString(React.createElement(MemoryStoreDetail, {
      store: data.memoryStores[0],
      onBack: () => {},
      onRefresh: () => {},
      onNewMemory: () => {},
    }));
    expect(html).toContain('visual-polish');
    expect(html).toContain('Stored context');
    expect(html).toContain('Select a memory');
    expect(html).not.toContain('Keep the dashboard dense, quiet, and inspectable.');
  });

  it('renders Credential Vaults list and empty detail states', () => {
    const data = emptyConsoleData();
    expect(renderToString(React.createElement(CredentialVaults, { data, onNew: () => {}, onOpenVault: () => {} }))).toContain('No credential vaults');
    expect(renderToString(React.createElement(CredentialVaultDetail, {
      vault: {
        id: 'vlt_empty',
        type: 'credential_vault',
        name: 'Empty vault',
        description: '',
        status: 'active',
        credentials: [],
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
        archived_at: null,
      },
      onBack: () => {},
      onRefresh: () => {},
      onNewCredential: () => {},
    }))).toContain('No credentials');
  });

  it('renders populated Credential Vault detail with mobile credential fallback', () => {
    const data = populatedConsoleData();
    expect(renderToString(React.createElement(CredentialVaults, {
      data,
      onNew: () => {},
      onOpenVault: () => {},
    }))).toContain('<th>Credentials</th>');
    const html = renderToString(React.createElement(CredentialVaultDetail, {
      vault: data.vaults[0],
      onBack: () => {},
      onRefresh: () => {},
      onNewCredential: () => {},
    }));
    expect(html).toContain('Runtime token');
    expect(html).toContain('Last used');
    expect(html).toContain('credentialTablePanel');
    expect(html).toContain('mobileResourceList');
  });

  it('renders Settings shell as a builder-first setup menu', () => {
    const html = renderToString(React.createElement(SettingsView, { data: emptyConsoleData(), section: 'general', onRefresh: () => {}, setView: () => {} }));
    expect(html).toContain('Setup');
    expect(html).toContain('Model provider');
    expect(html).toContain('Local defaults');
    expect(html).toContain('Advanced');
    expect(html).toContain('API reference');
    expect(html).not.toContain('Loop engine editor');
    expect(html).not.toContain('Storage editor');
    expect(html).not.toContain('Memory editor');
    expect(html).not.toContain('Sandbox editor');
  });

  it('renders every Settings second-level page without route-only blind spots', () => {
    const data = populatedConsoleData();
    const sections: SettingsSection[] = [
      'general',
      'workspace',
      'advanced',
      'models',
      'loop-engine',
      'storage',
      'memory',
      'sandbox',
      'api-keys',
      'api-reference',
      'logs',
      'monitoring',
    ];
    for (const section of sections) {
      expect(renderToString(React.createElement(SettingsView, {
        data,
        section,
        onRefresh: () => {},
        setView: () => {},
      }))).toContain('settingsShell');
    }
    const runtimeHtml = renderToString(React.createElement(SettingsView, {
      data,
      section: 'models',
      onRefresh: () => {},
      setView: () => {},
    }));
    expect(runtimeHtml).toContain('Model');
    expect(runtimeHtml).toContain('Vendor');
    expect(runtimeHtml).not.toContain('Model providers');
    const advancedHtml = renderToString(React.createElement(SettingsView, {
      data,
      section: 'advanced',
      onRefresh: () => {},
      setView: () => {},
    }));
    expect(advancedHtml).toContain('Runtime defaults');
    expect(advancedHtml).toContain('Loop engine editor');
    expect(advancedHtml).toContain('Storage editor');
  });

  it('renders Settings storage honestly as SQLite/local rather than fake provider creation', () => {
    const html = renderToString(React.createElement(SettingsView, { data: emptyConsoleData(), section: 'storage', onRefresh: () => {}, setView: () => {} }));
    expect(html).toContain('Metadata storage');
    expect(html).toContain('Artifact storage');
    expect(html).toContain('Storage adapter availability');
    expect(html).not.toContain('Add provider');
  });

  it('renders Settings API reference, Logs, and Monitoring surfaces', () => {
    const data = populatedConsoleData();
    expect(renderToString(React.createElement(SettingsView, { data, section: 'api-reference', onRefresh: () => {}, setView: () => {} }))).toContain('Copy endpoint');
    expect(renderToString(React.createElement(SettingsLogs, { data }))).toContain('Runtime logs');
    expect(renderToString(React.createElement(Observability, { data }))).toContain('Runtime summary');
  });
});
