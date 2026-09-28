import { ChevronDown, FileText } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { postJson, putJson } from '../../api';
import { sendsModelConfig } from '../../lib/agentModelConfig';
import { Modal } from '../Modal';
import { EmptyState } from '../Common';
import type { Agent, AgentToolset, ConsoleData, SkillRef, Template } from '../../types';

export function AgentModal({ template, data, onClose, onSaved }: { template?: Template; data: ConsoleData; onClose: () => void; onSaved: () => void }) {
  const initialTemplate = template ?? data.templates[0];
  const [selected, setSelected] = useState<Template | undefined>(initialTemplate);
  const [yaml, setYaml] = useState(agentDefinitionYaml(initialTemplate?.agent ?? defaultAgentDraft(data)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const chooseTemplate = (next: Template) => {
    setSelected(next);
    setYaml(agentDefinitionYaml(next.agent));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson('/v1/agents', parseYaml(yaml));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create agent" subtitle="Start from a template and edit the YAML config." onClose={onClose} size="wide">
      <form className="agentComposer" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <section className="composerSection">
          <div className="sectionTitle"><ChevronDown size={18} /><strong>Starting point</strong>{selected ? <span>· {selected.name}</span> : null}</div>
          <div className="claudeTemplateGrid">
            {data.templates.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`claudeTemplateCard ${selected?.id === item.id ? 'selected' : ''}`}
                onClick={() => chooseTemplate(item)}
              >
                <strong>{item.name}</strong>
                <span>{item.description}</span>
                {item.tags.length ? <small>{item.tags.slice(0, 4).join(' · ')}</small> : null}
              </button>
            ))}
            {data.templates.length === 0 ? (
              <EmptyState icon={<FileText size={22} />} title="No templates" body="Start from the default YAML draft below, then save it as a versioned agent." />
            ) : null}
          </div>
        </section>

        <section className="composerSection">
          <div>
            <h2>Agent config</h2>
            <p className="mutedLine">Saving creates a validated agent version; raw YAML is kept visible so the Console does not hide runtime behavior.</p>
          </div>
          <YamlEditor value={yaml} onChange={setYaml} minRows={18} />
        </section>

        <div className="modalActions stickyActions">
          <button className="primaryButton" type="submit" disabled={saving}>Create agent</button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentEditModal({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const [yaml, setYaml] = useState(agentDefinitionYaml(agentDraftFromApi(agent)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await putJson(`/v1/agents/${agent.id}`, { ...parseYaml(yaml), expected_version: agent.version });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit agent" onClose={onClose} size="medium">
      <form className="agentComposer" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <YamlEditor value={yaml} onChange={setYaml} minRows={16} />
        <div className="modalActions stickyActions">
          <button className="primaryButton" type="submit" disabled={saving}>Save new version</button>
        </div>
      </form>
    </Modal>
  );
}

type AgentDraft = {
  name: string;
  description?: string;
  model: string;
  model_config?: { id?: string; speed: string; effort?: string };
  system: string;
  mcp_servers?: Array<Record<string, unknown>>;
  tools?: AgentToolset[];
  skills?: SkillRef[];
  metadata?: Record<string, unknown>;
};

function YamlEditor({ value, onChange, minRows }: { value: string; onChange: (value: string) => void; minRows: number }) {
  return (
    <div className="yamlShell">
      <div className="yamlToolbar">
        <div>
          <span className="editorModeBadge">YAML</span>
          <small>Validated on save</small>
        </div>
        <FileText size={17} />
      </div>
      <textarea
        className="yamlTextarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={minRows}
        spellCheck={false}
      />
    </div>
  );
}

function defaultAgentDraft(data: ConsoleData): AgentDraft {
  return {
    name: 'Untitled agent',
    description: 'A blank starting point with the core toolset.',
    model: data.runtime?.models[0]?.name ?? 'default',
    system: 'You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user\'s task end to end.',
    mcp_servers: [],
    tools: [{ type: 'agent_toolset_20260401' }],
    skills: [],
    metadata: {},
  };
}

function agentDraftFromApi(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    model: agent.model,
    model_config: agent.model_config,
    description: agent.description,
    system: agent.system,
    mcp_servers: agent.mcp_servers,
    tools: agent.tools,
    skills: agent.skills,
    metadata: agent.metadata ?? {},
  };
}

function agentDefinitionYaml(agent: AgentDraft): string {
  return stringifyYaml({
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    model: agent.model,
    ...(sendsModelConfig(agent.model_config) ? { model_config: agent.model_config } : {}),
    system: agent.system,
    mcp_servers: agent.mcp_servers ?? [],
    tools: agent.tools ?? [{ type: 'agent_toolset_20260401' }],
    skills: agent.skills ?? [],
    metadata: agent.metadata ?? {},
  }, { blockQuote: 'literal', lineWidth: 100 });
}

function agentPayloadFromApi(agent: Agent) {
  return {
    name: agent.name,
    description: agent.description,
    model: agent.model,
    system: agent.system,
    mcp_servers: agent.mcp_servers,
    tools: agent.tools,
    skills: agent.skills,
    metadata: agent.metadata,
  };
}

function agentVersionDiff(base: Agent, compare: Agent) {
  const fields: Array<[string, string, string]> = [
    ['Name', base.name, compare.name],
    ['Description', base.description, compare.description],
    ['Model', base.model, compare.model],
    ['System', base.system, compare.system],
    ['Tools', JSON.stringify(base.tools, null, 2), JSON.stringify(compare.tools, null, 2)],
    ['MCP servers', JSON.stringify(base.mcp_servers, null, 2), JSON.stringify(compare.mcp_servers, null, 2)],
    ['Skills', JSON.stringify(base.skills, null, 2), JSON.stringify(compare.skills, null, 2)],
  ];
  return fields.map(([field, before, after]) => ({
    field,
    before: before || '-',
    after: after || '-',
    changed: before !== after,
  }));
}
