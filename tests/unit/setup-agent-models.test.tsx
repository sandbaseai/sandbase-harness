/**
 * The Setup step that names each agent's model.
 *
 * Saving a provider completes nothing on its own: the model id belongs to the
 * agent, so the Setup page has to say so and offer the edit. These cases pin the
 * two halves of that — the guidance the page renders, and the request the inline
 * save produces (a partial update, guarded by the published precondition).
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupAgentModels } from '../../apps/console/src/components/pages/settings/SetupAgentModels';
import {
  agentModelFieldHint,
  agentModelUpdateBody,
  pendingRestartNote,
  providerSavedMessage,
  referencedVariables,
  setupModelProvider,
  suggestedModelId,
} from '../../apps/console/src/lib/modelSetupGuidance';
import type { Agent, ConsoleData, RuntimeSettings, RuntimeSettingsConfig } from '../../apps/console/src/types';

const now = '2026-09-29T00:00:00.000Z';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_assistant',
    type: 'agent',
    name: 'assistant',
    description: 'Seeded by init.',
    system: 'You are a helpful assistant.',
    model: 'gpt-4o',
    tools: [{ type: 'agent_toolset_20260401' }],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    archived_at: null,
    ...overrides,
  };
}

const openaiConfig: RuntimeSettingsConfig = {
  schema_version: 1,
  model: { vendor: 'openai', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
  storage: { metadata: { provider: 'sqlite', options: {} }, artifacts: { provider: 'local', options: {} } },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
};

function settings(overrides: {
  model?: Partial<RuntimeSettingsConfig['model']>;
  keyState?: RuntimeSettings['secret_states']['model']['api_key'];
} = {}): RuntimeSettings {
  return {
    schema_version: 1,
    revision: 2,
    effective_revision: 2,
    saved_config: { ...openaiConfig, model: { ...openaiConfig.model, ...overrides.model } },
    effective_config: { ...openaiConfig, model: { ...openaiConfig.model, ...overrides.model } },
    restart_required: false,
    activation_status: 'active',
    activation_errors: [],
    diagnostics: { metadata: { path: '/tmp/data.db', health: 'ok' } },
    secret_states: { model: { api_key: overrides.keyState ?? 'not_set' } },
    adapters: {
      model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      storage: { metadata: [], artifacts: [] },
      memory: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
    },
  };
}

function consoleData(agents: Agent[], runtimeSettings: RuntimeSettings): ConsoleData {
  return {
    agents,
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
    runtime: null,
    workspace: null,
    settings: runtimeSettings,
  };
}

describe('Setup agent models panel', () => {
  it('lists each agent with its current model and an editable field', () => {
    const data = consoleData(
      [agent(), agent({ id: 'agent_reviewer', name: 'reviewer', model: 'gpt-4o-mini', version: 3 })],
      settings(),
    );

    const html = renderToStaticMarkup(
      <SetupAgentModels data={data} provider={setupModelProvider(data.settings)} onRefresh={() => {}} />,
    );

    expect(html).toContain('Agent models');
    expect(html).toContain('assistant');
    expect(html).toContain('reviewer');
    // The current value is what the field starts from, so a single-word edit is
    // the whole interaction.
    expect(html).toContain('value="gpt-4o"');
    expect(html).toContain('value="gpt-4o-mini"');
    expect(html).toContain('Save model');
    // The vendor's own id is named, because this provider is one this project
    // configures and documents.
    expect(html).toContain('gpt-4o`');
  });

  it('names the variable when the saved provider key cannot resolve', () => {
    const data = consoleData(
      [agent()],
      settings({ model: { vendor: 'openai_compatible', base_url: 'https://api.deepseek.com/v1', api_key: '${OPENAI_API_KEY}' }, keyState: 'missing_env' }),
    );

    const html = renderToStaticMarkup(
      <SetupAgentModels data={data} provider={setupModelProvider(data.settings)} onRefresh={() => {}} />,
    );

    expect(html).toContain('OPENAI_API_KEY');
    // The rendered HTML escapes the apostrophe, so assert the fragment before it.
    expect(html).toContain('has no value in the runtime');
    // The example the official-SDK walkthrough uses, so the guidance matches the
    // documented DeepSeek configuration, with the endpoint's own ids named rather
    // than an OpenAI id that this endpoint does not serve.
    expect(html).toContain('deepseek-chat');
    expect(html).toContain('the model id this endpoint serves');
  });

  it('says what is missing when there are no agents yet', () => {
    const data = consoleData([], settings());

    const html = renderToStaticMarkup(
      <SetupAgentModels data={data} provider={setupModelProvider(data.settings)} onRefresh={() => {}} />,
    );

    expect(html).toContain('No agents yet');
  });

  it('warns while a saved provider is not the runtime\'s effective one yet', () => {
    // A settings write is `restart_required` until the next start, so a model id
    // set here is correct while the request still goes to the previous provider.
    const pending = consoleData([agent()], { ...settings(), restart_required: true, activation_status: 'pending' });
    const pendingHtml = renderToStaticMarkup(
      <SetupAgentModels data={pending} provider={setupModelProvider(pending.settings)} restartRequired onRefresh={() => {}} />,
    );
    expect(pendingHtml).toContain('not active yet');
    expect(pendingHtml).toContain('Restart the runtime once');

    const active = consoleData([agent()], settings());
    const activeHtml = renderToStaticMarkup(
      <SetupAgentModels data={active} provider={setupModelProvider(active.settings)} onRefresh={() => {}} />,
    );
    expect(activeHtml).not.toContain('not active yet');
  });
});

describe('providerSavedMessage', () => {
  it('names the restart before the remaining step', () => {
    expect(providerSavedMessage).toContain('Restart the runtime once');
    expect(providerSavedMessage.indexOf('Restart')).toBeLessThan(providerSavedMessage.indexOf('set the model'));
  });

  it('reports the pending restart only while the runtime says one is required', () => {
    expect(pendingRestartNote(true, 'pending')).toContain('Restart the runtime once');
    expect(pendingRestartNote(false, 'active')).toBeUndefined();
    expect(pendingRestartNote(undefined, undefined)).toBeUndefined();
  });

  it('asks for the repair, not a restart, when activation failed', () => {
    // A failed activation keeps `restart_required` set, so restarting alone leaves
    // the user exactly where they were; the runtime names the offending path and
    // that is what has to be fixed first.
    const note = pendingRestartNote(true, 'failed');

    expect(note).toContain('could not be activated');
    expect(note).toContain('Settings > Models');
    expect(note).not.toContain('Restart the runtime once, then send');
  });
});

describe('agentModelUpdateBody', () => {
  it('sends the model and the published precondition, and nothing else', () => {
    const update = agentModelUpdateBody(agent({ version: 4 }), 'deepseek-chat');

    expect(update).toEqual({ ok: true, body: { model: 'deepseek-chat', version: 4 } });
  });

  it('trims what the user typed', () => {
    const update = agentModelUpdateBody(agent(), '  deepseek-chat  ');

    expect(update).toEqual({ ok: true, body: { model: 'deepseek-chat', version: 1 } });
  });

  it('refuses an empty model id instead of clearing the agent', () => {
    const update = agentModelUpdateBody(agent(), '   ');

    expect(update.ok).toBe(false);
    expect(update.ok === false && update.error).toContain('assistant');
  });

  it('refuses a save that changes nothing, so no empty version is recorded', () => {
    // `PUT /v1/agents/{id}` writes a new immutable version for a real change and
    // answers the stored agent unchanged for a no-op; asking for the no-op only
    // hides which of the two the user is looking at.
    const update = agentModelUpdateBody(agent({ model: 'gpt-4o' }), 'gpt-4o');

    expect(update.ok).toBe(false);
  });
});

describe('model setup derivations', () => {
  it('reads every referenced variable, without duplicates', () => {
    expect(referencedVariables('${A} and ${B}')).toEqual(['A', 'B']);
    expect(referencedVariables('${A}-${A}')).toEqual(['A']);
    expect(referencedVariables('literal-key')).toEqual([]);
    expect(referencedVariables(undefined)).toEqual([]);
  });

  it('reports the missing variable only when the runtime said the key is missing', () => {
    const missing = setupModelProvider(settings({ model: { api_key: '${OPENAI_API_KEY}' }, keyState: 'missing_env' }));
    expect(missing?.missingKeyVariables).toEqual(['OPENAI_API_KEY']);

    // A reference the runtime resolved is not a problem to report, even though
    // the stored spelling still carries the placeholder.
    const configured = setupModelProvider(settings({ model: { api_key: '${OPENAI_API_KEY}' }, keyState: 'configured' }));
    expect(configured?.missingKeyVariables).toEqual([]);
    expect(configured?.keyVariables).toEqual(['OPENAI_API_KEY']);
  });

  it('suggests only ids this project already names, and none for an unknown gateway', () => {
    expect(suggestedModelId('openai')).toBe('gpt-4o');
    expect(suggestedModelId('anthropic')).toBe('claude-sonnet-4');
    expect(suggestedModelId('minimax')).toBe('MiniMax-M3');
    expect(suggestedModelId('openai_compatible', 'https://api.deepseek.com/v1')).toBe('deepseek-chat');
    expect(suggestedModelId('openai_compatible', 'https://gateway.example.test/v1')).toBeUndefined();
    expect(suggestedModelId('openai_compatible', 'not a url')).toBeUndefined();
  });

  it('describes the field in terms of what the configured provider knows', () => {
    expect(agentModelFieldHint(setupModelProvider(settings({ model: { vendor: 'openai' } })))).toContain('gpt-4o');
    expect(agentModelFieldHint(setupModelProvider(settings({ model: { vendor: 'openai_compatible' } }))))
      .toContain('forwards it unchanged');
  });
});
