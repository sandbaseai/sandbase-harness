import type { StubModelServerOptions } from '../support/stub-model-server.js';

export type DocsExampleStatus = 'enabled' | { pending: string } | { excluded: string };
export type DocsExampleFixture = 'agent' | 'environment' | 'file' | 'github_repository' | 'mcp_server' | 'webhook_receiver';

export interface DocsExampleReplacement {
  from: string | RegExp;
  to: string;
  why: string;
}

export interface DocsExamplePage {
  id: string;
  doc: string;
  status: DocsExampleStatus;
  snippets?: number[];
  selectionReason?: string;
  replacements?: DocsExampleReplacement[];
  model?: StubModelServerOptions;
  fixtures?: DocsExampleFixture[];
}

export const docsExamplePages: readonly DocsExamplePage[] = [
  {
    id: 'console-build',
    doc: '入门/在Console中构建.md',
    status: 'enabled',
    snippets: [0],
    selectionReason: 'The initial acceptance covers creating a session with existing Console agent and environment ids.',
    fixtures: ['agent', 'environment'],
    replacements: [
      {
        from: '"agent_01J8XkN5uT3vHpLqRfWdY2"',
        to: 'fixtureAgent.id',
        why: 'The documentation uses an illustrative Console agent id; the harness creates a local agent for the session request.',
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
    doc: '定义您的智能体/工具.md',
    status: 'enabled',
    snippets: [0],
    selectionReason: 'The first example configures a built-in toolset; later examples exercise separate tool execution flows.',
  },
  {
    id: 'permission-policies',
    doc: '定义您的智能体/权限策略.md',
    status: 'enabled',
    snippets: [0],
    selectionReason: 'The first example configures approval policy; the confirmation lifecycle is a separate acceptance.',
  },
  { id: 'quickstart', doc: '入门/快速开始.md', status: { pending: 'Enable the complete quickstart workflow in a follow-up.' } },
  { id: 'migration', doc: '入门/迁移.md', status: { excluded: 'Compares the Messages API and migration steps rather than a standalone managed-agent workflow.' } },
  { id: 'agent-setup', doc: '定义您的智能体/智能体设置.md', status: { pending: 'Review the complete agent-configuration examples and model profile assertions.' } },
  { id: 'mcp-connectors', doc: '定义您的智能体/MCP连接器.md', status: { pending: 'Requires a local MCP server fixture.' } },
  { id: 'skills', doc: '定义您的智能体/智能体技能.md', status: { pending: 'Requires runnable skill fixtures and skill mount verification.' } },
  { id: 'session-events', doc: '将工作委派给智能体/会话事件流.md', status: { pending: 'Requires canonical session status and error events.' } },
  { id: 'session-operations', doc: '将工作委派给智能体/会话操作.md', status: { pending: 'Requires the complete interrupt/archive/update workflow.' } },
  { id: 'session-budgets', doc: '将工作委派给智能体/会话预算.md', status: { pending: 'Requires budget pause and resume semantics.' } },
  { id: 'vault-auth', doc: '将工作委派给智能体/使用保管库进行身份验证.md', status: { pending: 'Requires vault authentication and credential injection coverage.' } },
  { id: 'start-session', doc: '将工作委派给智能体/启动会话.md', status: { pending: 'Requires complete session object compatibility.' } },
  { id: 'outcomes', doc: '将工作委派给智能体/定义结果.md', status: { pending: 'Requires outcome evaluation compatibility.' } },
  { id: 'webhooks', doc: '将工作委派给智能体/订阅Webhook.md', status: { pending: 'Requires a local webhook receiver fixture.' } },
  { id: 'memory', doc: '管理智能体上下文/记忆存储.md', status: { pending: 'Requires memory API and persistence assertions.' } },
  { id: 'github', doc: '管理智能体上下文/访问GitHub.md', status: { pending: 'Requires a local repository fixture.' } },
  { id: 'files', doc: '管理智能体上下文/附加和下载文件.md', status: { pending: 'Inspect the complete file workflow before enabling.' } },
  { id: 'dreams', doc: '管理智能体上下文/Dreams.md', status: { excluded: 'Hosted Dreams are outside the local runtime scope.' } },
  { id: 'environments', doc: '配置智能体环境/云环境设置.md', status: { pending: 'Requires canonical local environment object coverage.' } },
  { id: 'cloud-sandbox', doc: '配置智能体环境/云沙箱参考.md', status: { excluded: 'Hosted cloud sandbox behavior is outside the local runtime scope.' } },
  { id: 'self-hosted-sandbox', doc: '配置智能体环境/自托管沙箱.md', status: { excluded: 'The official Work API is outside the local runtime scope.' } },
  { id: 'multiagent', doc: '高级编排/多智能体编排.md', status: { pending: 'Coordinator threads require a separately scoped follow-up.' } },
  { id: 'scheduled-deployments', doc: '高级编排/定时部署.md', status: { pending: 'Requires local trigger and scheduler contract coverage.' } },
];

export function getDocsExamplePage(id: string): DocsExamplePage {
  const page = docsExamplePages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown docs example page: ${id}`);
  if (page.status !== 'enabled') throw new Error(`Docs example page is not enabled: ${id}`);
  return page;
}
