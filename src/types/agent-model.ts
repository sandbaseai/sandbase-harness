/** Public agent model projection. Unset effort keeps the runtime/provider default. */
export interface AgentModelResponse {
  id: string;
  speed: 'standard' | 'fast' | 'extended';
  effort?: { type: string };
}
