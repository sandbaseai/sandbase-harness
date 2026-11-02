import { agentModelId } from '../../../lib/agentModelConfig';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, CheckCircle2, KeyRound } from 'lucide-react';
import { putJson } from '../../../api';
import { agentModelFieldHint, agentModelUpdateBody, pendingRestartNote, type SetupModelProvider } from '../../../lib/modelSetupGuidance';
import type { ConsoleData } from '../../../types';
import { ModelConnectionTest } from './ModelConnectionTest';

type RowState = { kind: 'ok' | 'error'; text: string };

/**
 * The step between "the provider is saved" and "the agent can answer".
 *
 * The model id belongs to the agent, not to the workspace, so saving a provider
 * completes nothing on its own: an agent still carries whatever id it was created
 * with — `init` writes `gpt-4o` — and the first message fails against a provider
 * that does not serve it. This panel is that missing step, kept on the Setup page
 * because it is part of setup rather than agent authoring.
 *
 * The edit is deliberately a single field sent to `PUT /v1/agents/{id}` (a
 * partial update, so nothing else on the agent is rewritten) rather than a form
 * that posts the whole definition back.
 */
export function SetupAgentModels({
  data,
  provider,
  emphasize = false,
  restartRequired = false,
  onRefresh,
}: {
  data: ConsoleData;
  provider: SetupModelProvider | null;
  emphasize?: boolean;
  restartRequired?: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');
  const agents = data.agents.filter((agent) => !agent.archived_at);
  const restartNote = pendingRestartNote(restartRequired, data.settings?.activation_status, t);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const storedModels = useRef<Record<string, string>>({});

  // What the field shows: whatever the user typed, otherwise the model the agent
  // already carries. Reading the stored value as the fallback rather than copying
  // it into state means the first paint shows the current model instead of an
  // empty box that fills in after an effect.
  const draftFor = (agentId: string, stored: string) => drafts[agentId] ?? stored;

  // A refresh only discards a draft where the runtime's own value moved — this
  // panel's save, or an edit made elsewhere — so an unrelated background refresh
  // cannot throw away what the user is typing.
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const agent of data.agents) {
        const stored = agentModelId(agent.model) ?? '';
        const previous = storedModels.current[agent.id];
        if (previous !== undefined && previous !== stored && next[agent.id] !== undefined) {
          delete next[agent.id];
          changed = true;
        }
        storedModels.current[agent.id] = stored;
      }
      return changed ? next : current;
    });
  }, [data.agents]);

  const setRowState = (id: string, state: RowState | undefined) => {
    setRowStates((current) => {
      const next = { ...current };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  };

  const save = async (agentId: string) => {
    const agent = data.agents.find((item) => item.id === agentId);
    if (!agent) return;
    const update = agentModelUpdateBody(agent, draftFor(agent.id, agentModelId(agent.model) ?? ''), t);
    if (!update.ok) {
      setRowState(agentId, { kind: 'error', text: update.error });
      return;
    }
    setSavingId(agentId);
    setRowState(agentId, undefined);
    try {
      await putJson(`/v1/agents/${encodeURIComponent(agentId)}`, update.body);
      setRowState(agentId, { kind: 'ok', text: t('setupModels.savedOk', { name: agent.name, model: update.body.model }) });
      onRefresh();
    } catch (error) {
      setRowState(agentId, {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
      // A `409` is the stored `version` having moved since this page was
      // rendered, and this page does not poll: without a refresh the draft stays
      // pinned to the stale version and the same conflict repeats forever. A
      // refetch re-reads the agent, so the next save carries the current one.
      onRefresh();
    } finally {
      setSavingId(null);
    }
  };

  const placeholder = provider?.vendor === 'openai_compatible'
    ? t('setupModels.placeholderCompatible')
    : t('setupModels.placeholder');

  return (
    <div className={`panel subtlePanel setupAgentModels${emphasize ? ' setupAgentModelsNext' : ''}`}>
      <div className="builderSetupHeader">
        <span className="softIcon"><Bot size={18} /></span>
        <div>
          <h2>{t('setupModels.title')}</h2>
          <p>{t('setupModels.description')}</p>
        </div>
      </div>
      <p className="setupAgentHint">{agentModelFieldHint(provider, t)}</p>
      <p className="setupAgentHint">{t('setupModels.connection.hint')}</p>
      {restartNote ? (
        <div className="setupProviderWarning">
          <AlertTriangle size={15} />
          <span>{restartNote}</span>
        </div>
      ) : null}
      {provider?.missingKeyVariables.length ? (
        <div className="setupProviderWarning">
          <AlertTriangle size={15} />
          <span>
            {t('setupModels.missingKey', {
              vars: provider.missingKeyVariables.map((name) => `\`${name}\``).join(', '),
            })}
          </span>
        </div>
      ) : null}
      {agents.length ? (
        <ul className="setupAgentList">
          {agents.map((agent) => {
            const draft = draftFor(agent.id, agentModelId(agent.model) ?? '');
            const state = rowStates[agent.id];
            const saving = savingId === agent.id;
            return (
              <li key={agent.id} className="setupAgentRow">
                <div className="setupAgentIdentity">
                  <strong>{agent.name}</strong>
                  <span><KeyRound size={13} />{agentModelId(agent.model) || t('setupModels.noModel')}</span>
                </div>
                <form
                  className="setupAgentForm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(agent.id);
                  }}
                >
                  <label className="srOnly" htmlFor={`agent-model-${agent.id}`}>{t('setupModels.fieldLabel', { name: agent.name })}</label>
                  <input
                    id={`agent-model-${agent.id}`}
                    value={draft}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((current) => ({ ...current, [agent.id]: value }));
                      setRowState(agent.id, undefined);
                    }}
                  />
                  <button className="secondaryButton" type="submit" disabled={saving}>
                    {saving ? t('setupModels.saving') : t('setupModels.save')}
                  </button>
                </form>
                <ModelConnectionTest model={draft} agentName={agent.name} revision={data.settings?.revision}
                  disabled={saving} onRefresh={onRefresh} />
                {state ? (
                  <div className={`inlineStatus ${state.kind === 'error' ? 'error' : 'neutral'}`}>
                    {state.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    <span>{state.kind === 'ok' ? t('setupModels.savedTag') : t('setupModels.notSavedTag')}</span>
                    <span>{state.text}</span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mutedText">{t('setupModels.empty')}</p>
      )}
    </div>
  );
}
