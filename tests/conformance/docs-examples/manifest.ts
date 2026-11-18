import type { StubModelServerOptions } from '../support/stub-model-server.js';

export type DocsExampleStatus = 'enabled' | { pending: string } | { excluded: string };
export type DocsExampleFixture = 'agent' | 'environment' | 'file' | 'github_repository' | 'mcp_server' | 'webhook_receiver';

/**
 * The verdict a selected snippet is asserted against.
 *
 * - `conforms` — the runtime is expected to reproduce the published behaviour;
 *   the test asserts the documented call succeeds and the response carries the
 *   documented shape.
 * - `deviation` — the runtime intentionally diverges, and the contract records
 *   the difference by name (the `contract` field points at the §4 row). The
 *   test asserts the *recorded* deviation, never conformance.
 */
export type DocsExampleVerdict =
  | { kind: 'conforms' }
  | { kind: 'deviation'; contract: string };

export interface DocsExampleReplacement {
  from: string | RegExp;
  to: string;
  why: string;
}

export interface DocsExamplePage {
  id: string;
  /** Path inside `contracts/anthropic-cma/official-docs/`. */
  doc: string;
  status: DocsExampleStatus;
  /**
   * Which extracted TypeScript snippets run, and against which verdict. Every
   * selected snippet is executed; each asserts either upstream behaviour or
   * the §4-recorded deviation it names. A snippet with no `verdict` conforms.
   */
  snippets?: Array<number | { index: number; verdict: DocsExampleVerdict }>;
  selectionReason?: string;
  replacements?: DocsExampleReplacement[];
  model?: StubModelServerOptions;
  fixtures?: DocsExampleFixture[];
}

export const docsExamplePages: readonly DocsExamplePage[] = [
  {
    id: 'console-build',
    doc: 'onboarding.md',
    status: 'enabled',
    snippets: [0],
    selectionReason: 'The onboarding page creates a session with existing agent and environment ids.',
    fixtures: ['agent', 'environment'],
    replacements: [
      {
        from: '"agent_01J8XkN5uT3vHpLqRfWdY2"',
        to: 'fixtureAgent.id',
        why: 'The documentation uses an illustrative agent id; the harness creates a local agent for the session request.',
      },
      {
        from: '"env_01K2mPsT7hNwR4jXuLvCqD8"',
        to: 'fixtureEnvironment.id',
        why: 'The documentation uses an illustrative environment id; the harness creates a local environment for the session request.',
      },
    ],
  },
  {
    id: 'tools',
    doc: 'tools.md',
    status: 'enabled',
    // [0] enables the toolset with a per-tool disable; [1] creates a custom
    // tool but declares `const agent` again — both can't run in one script, so
    // the second shape is a separate acceptance.
    snippets: [
      { index: 0, verdict: { kind: 'conforms' } },
    ],
    selectionReason: 'The first example configures a built-in toolset; the custom-tool example is a separate snippet selection.',
  },
  {
    id: 'permission-policies',
    doc: 'permission-policies.md',
    status: 'enabled',
    // [0] sets always_ask on the agent toolset. The other snippets need an MCP
    // server fixture, a `satisfies`-only type example, or a parked tool call
    // the stub does not produce, so they stay unselected.
    snippets: [
      { index: 0, verdict: { kind: 'conforms' } },
    ],
    selectionReason: 'The first example configures approval policy; the confirmation lifecycle is a separate acceptance.',
  },
  { id: 'quickstart', doc: 'quickstart.md', status: { pending: 'Enable the complete quickstart workflow in a follow-up.' } },
  { id: 'migration', doc: 'migration.md', status: { excluded: 'Compares the Messages API and migration steps rather than a standalone managed-agent workflow.' } },
  { id: 'agent-setup', doc: 'agent-setup.md', status: { pending: 'Review the complete agent-configuration examples and model profile assertions.' } },
  { id: 'mcp-connectors', doc: 'mcp-connector.md', status: { pending: 'Requires a local MCP server fixture.' } },
  { id: 'skills', doc: 'skills.md', status: { pending: 'Requires runnable skill fixtures and skill mount verification.' } },
  { id: 'session-events', doc: 'events-and-streaming.md', status: { pending: 'Requires canonical session status and error events.' } },
  { id: 'session-operations', doc: 'session-operations.md', status: { pending: 'Requires the complete interrupt/archive/update workflow.' } },
  { id: 'session-budgets', doc: 'budgets.md', status: { pending: 'Requires budget pause and resume semantics.' } },
  { id: 'vault-auth', doc: 'vaults.md', status: { pending: 'Requires vault authentication and credential injection coverage.' } },
  { id: 'start-session', doc: 'sessions.md', status: { pending: 'Requires complete session object compatibility.' } },
  { id: 'outcomes', doc: 'define-outcomes.md', status: { pending: 'Requires outcome evaluation compatibility.' } },
  { id: 'webhooks', doc: 'webhooks.md', status: { pending: 'Requires a local webhook receiver fixture.' } },
  { id: 'memory', doc: 'memory.md', status: { pending: 'Requires memory API and persistence assertions.' } },
  { id: 'github', doc: 'github.md', status: { pending: 'Requires a local repository fixture.' } },
  { id: 'files', doc: 'files.md', status: { pending: 'Inspect the complete file workflow before enabling.' } },
  { id: 'dreams', doc: 'dreams.md', status: { excluded: 'Hosted Dreams are outside the local runtime scope.' } },
  { id: 'environments', doc: 'environments.md', status: { pending: 'Requires canonical local environment object coverage.' } },
  { id: 'cloud-sandbox', doc: 'cloud-sandboxes-reference.md', status: { excluded: 'Hosted cloud sandbox behavior is outside the local runtime scope.' } },
  { id: 'self-hosted-sandbox', doc: 'self-hosted-sandboxes.md', status: { excluded: 'The official Work API is outside the local runtime scope.' } },
  { id: 'multiagent', doc: 'multiagent-orchestration.md', status: { pending: 'Coordinator threads require a separately scoped follow-up.' } },
  { id: 'scheduled-deployments', doc: 'scheduled-deployments.md', status: { pending: 'Requires local trigger and scheduler contract coverage.' } },
];

export function getDocsExamplePage(id: string): DocsExamplePage {
  const page = docsExamplePages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown docs example page: ${id}`);
  if (page.status !== 'enabled') throw new Error(`Docs example page is not enabled: ${id}`);
  return page;
}

/**
 * Resolve a page's selected snippets to `[index, verdict]` pairs. A bare
 * number is a `conforms` selection — the suite asserts upstream behaviour for
 * it. A `{index, verdict}` entry can mark a snippet `deviation` and point the
 * assertion at the §4 row it records.
 */
export function resolveSnippetSelections(page: DocsExamplePage): Array<{ index: number; verdict: DocsExampleVerdict }> {
  return (page.snippets ?? []).map((entry) =>
    typeof entry === 'number'
      ? { index: entry, verdict: { kind: 'conforms' } as const }
      : entry,
  );
}
