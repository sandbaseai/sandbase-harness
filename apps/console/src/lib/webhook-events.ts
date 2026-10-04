/**
 * The event names a webhook subscription may name, grouped the way the
 * published documentation groups them.
 *
 * Transcribed from `src/core/operations/webhook-events.ts`
 * (`OFFICIAL_WEBHOOK_EVENTS`), which pins the catalog against the SDK's
 * `BetaWebhook*EventData.type` union. Keep the two in sync: a name that is
 * not in the catalog is refused at write time, and `*` / `prefix.*`
 * wildcards are not part of the contract, so the picker offers no way to
 * enter them.
 */
export const WEBHOOK_EVENT_GROUPS: Array<{ category: string; events: string[] }> = [
  {
    category: 'Sessions',
    events: [
      'session.created',
      'session.pending',
      'session.running',
      'session.idled',
      'session.requires_action',
      'session.archived',
      'session.deleted',
      'session.updated',
      'session.status_run_started',
      'session.status_idled',
      'session.status_rescheduled',
      'session.status_terminated',
      'session.budget_reached',
      'session.outcome_evaluation_ended',
      'session.thread_created',
      'session.thread_idled',
      'session.thread_terminated',
    ],
  },
  {
    category: 'Vaults and credentials',
    events: [
      'vault.created',
      'vault.archived',
      'vault.deleted',
      'vault_credential.created',
      'vault_credential.archived',
      'vault_credential.deleted',
      'vault_credential.refresh_failed',
    ],
  },
  {
    category: 'Agents',
    events: [
      'agent.created',
      'agent.updated',
      'agent.archived',
      'agent.deleted',
    ],
  },
  {
    category: 'Deployments',
    events: [
      'deployment.created',
      'deployment.updated',
      'deployment.paused',
      'deployment.unpaused',
      'deployment.archived',
      'deployment.deleted',
    ],
  },
  {
    category: 'Deployment runs',
    events: [
      'deployment_run.started',
      'deployment_run.succeeded',
      'deployment_run.failed',
    ],
  },
  {
    category: 'Environments',
    events: [
      'environment.created',
      'environment.updated',
      'environment.archived',
      'environment.deleted',
    ],
  },
  {
    category: 'Memory stores',
    events: [
      'memory_store.created',
      'memory_store.archived',
      'memory_store.deleted',
    ],
  },
];

export const ALL_WEBHOOK_EVENTS: string[] = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events);
