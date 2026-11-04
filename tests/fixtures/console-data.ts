import type { ConsoleData } from '../../apps/console/src/types.js';

/** Complete empty Console state; each test supplies the resources it exercises. */
export function consoleDataFixture(overrides: Partial<ConsoleData> = {}): ConsoleData {
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
    runtime: null,
    workspace: null,
    settings: null,
    ...overrides,
  };
}
