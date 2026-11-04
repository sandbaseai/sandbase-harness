import type { Agent, AgentModel } from '../types';

/** Accept older servers while using the canonical model object on new ones. */
export function agentModelId(model: AgentModel): string {
  return typeof model === 'string' ? model : model.id;
}

/** Convert the response profile to the editable local form without losing effort. */
export function agentModelConfig(agent: Pick<Agent, 'model' | 'model_config'>): Agent['model_config'] {
  if (typeof agent.model === 'string') return agent.model_config;
  return {
    id: agent.model.id,
    speed: agent.model.speed ?? 'standard',
    ...(agent.model.effort ? { effort: agent.model.effort.type } : {}),
  };
}

/** Forms sending a string model must carry any non-default profile alongside it. */
export function sendsModelConfig(config: Agent['model_config'] | undefined): boolean {
  if (!config) return false;
  return config.speed !== 'standard' || Boolean(config.effort);
}
