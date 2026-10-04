# SandBase Harness

[English](./README.md) | 中文

[![GitHub stars](https://img.shields.io/github/stars/sandbaseai/sandbase-harness?style=social)](https://github.com/sandbaseai/sandbase-harness/stargazers)
[![已收录于 deepseek-plugin.org](https://img.shields.io/badge/listed_on-deepseek--plugin.org-007EC6)](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness)
[![Release](https://img.shields.io/github/v/release/sandbaseai/sandbase-harness)](https://github.com/sandbaseai/sandbase-harness/releases/latest)
[![Official MCP Registry](https://img.shields.io/badge/Official_MCP_Registry-active-2ea44f)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
[![Discussions](https://img.shields.io/github/discussions/sandbaseai/sandbase-harness)](https://github.com/sandbaseai/sandbase-harness/discussions)
[![CodeQL](https://github.com/sandbaseai/sandbase-harness/actions/workflows/codeql.yml/badge.svg)](https://github.com/sandbaseai/sandbase-harness/actions/workflows/codeql.yml)
[![License](https://img.shields.io/github/license/sandbaseai/sandbase-harness)](LICENSE)

面向 AI Agent 的项目元数据：[llms.txt](./llms.txt) · [安装指南](./llms-install.md)

一个本地优先、可自托管的 AI Agent Runtime。它把持久化会话、沙箱工具、
Memory、凭证、审计日志、事件回放和可视化 Console 放在同一个运行时边界中，
并提供原生 DeepSeek Harness stdio MCP 插件。

> 正在使用 DeepSeek Harness 构建 Agent？可查看独立的 [DeepSeek Harness Handbook](https://github.com/sandbaseai/deepseek-harness-handbook)，其中包含有来源依据的运行时指南、多语言故障排查，以及持续更新的 [Agent-first 资源地图](https://sandbaseai.github.io/deepseek-harness-handbook/awesome-deepseek-harness-resources.html)。

![SandBase Harness 架构](docs/assets/sandbase-harness-architecture.svg)

> 当前稳定版本：[v0.3.8](https://github.com/sandbaseai/sandbase-harness/releases/tag/v0.3.8)

MCP Bridge 容器镜像：[GitHub Container Registry](https://github.com/orgs/sandbaseai/packages/container/package/sandbase-harness-mcp)。

## 五分钟快速开始

要求：Node.js 22+、npm 10+，以及一个模型提供者 API Key（OpenAI、Anthropic、
MiniMax 或任意 OpenAI-compatible 端点）。Docker 可选，只有使用 Docker 沙箱时
才需要。

~~~bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build

mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
~~~

`init` 会在你执行命令的目录里生成工作区：一个 Agent、一个 Skill 目录，以及
把提供者写成 `${OPENAI_API_KEY}` 引用的 `config.yaml`。`start` 在
<http://127.0.0.1:3000> 上同时提供 API 和 Console。

打开 <http://127.0.0.1:3000/dashboard>，在 **Settings > Setup** 上完成两步：

1. **提供者。** 在提供者表单里粘贴 API Key 并保存。页面随后会提示保存的配置尚未
   生效：用 Ctrl+C 停掉运行时、再执行一次 `start`，或者用页面上的重启按钮。
   保存的设置只在启动时生效。如果列表里没有你的提供者，选择
   OpenAI-compatible，并填上它的 base URL。
2. **模型。** 在 **Agent models** 面板里填你的提供者真正提供的模型 ID（例如
   DeepSeek 用 `deepseek-chat`）。模型 ID 属于 Agent 本身，`init` 写入的
   `gpt-4o` 并非每个提供者都能用；ID 不对时该回合会以 `model_not_found` 失败。

发第一条消息：打开 **Sessions**，为这个 Agent 新建会话，在输入框里发消息。也可以
在终端里用一条命令：

~~~bash
node ../sandbase-harness/dist/index.js chat agent_assistant --message "你好" --tool-approval allow
~~~

`chat` 发完这一条消息、回合结束就退出；不带 `--message` 时才会保持会话打开，
持续输出直到你按 Ctrl+C。`--tool-approval allow` 事先授权 Agent
可能发起的工具调用；`init` 模板默认会把这些调用挂起等待人工确认。其余命令见
[CLI](README.md#cli)。

npm 上未加 scope 的 managed-agents **不是**本项目。在本仓库公布官方 scoped 包之前，
请只使用上面带标签的 GitHub 源码安装。不要运行 npx managed-agents 或
npm install managed-agents。

### 在 Codespaces 中试用

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sandbaseai/sandbase-harness?quickstart=1)

仓库内置的开发容器会自动安装依赖并构建运行时。终端准备完成后，在转发端口上启动服务：

```bash
node dist/index.js start --host 0.0.0.0
```

打开转发的 **SandBase Harness Console** 端口，然后在 **Settings > Setup**
中配置模型。GitHub 可能会对 Codespaces 用量计费；上方的本地快速开始仍然免费，
并会把全部运行时数据保存在你的机器上。

## 使用官方 SDK

运行时的 `/v1` API 就在同一个端口上，官方 Anthropic TypeScript SDK 客户端可以
原样驱动它：把客户端的 `baseURL` 指向运行时、填上运行时 API Key，
[`examples/official-sdk`](examples/official-sdk/README.md) 里的快速开始就会跑完
一个完整回合——发消息、工具调用、工具结果、最终回复。该示例由
`tests/conformance/official-sdk-quickstart.test.ts` 在每次 PR 上真实执行，
所以这里描述的是被测试过的兼容性，而不是声明出来的兼容性。

同一套接口的规范见 [docs/api.md](docs/api.md)；本仓库自带的 TypeScript SDK 见下文
[SDK](#使用官方-sdk)。

## CMA 兼容性

运行时对已发布 Claude Managed Agents 契约的覆盖逐条记录在
[`src/core/capabilities/matrix.ts`](src/core/capabilities/matrix.ts) 中；下表由
`npm run docs:compat` 从该文件生成，contract-honesty 测试会在表与矩阵不一致时
失败，因此本节内容不手工编写。`Partial` 与 `Unsupported` 行必须写明原因；
矩阵中更细的状态（`unavailable`、`planned`、`not_applicable`、`unverified`）
在此表中归为 `Unsupported`，并在备注中保留精确状态。

<!-- compat-table:start -->
| Area | Official capability | Status | Notes |
| --- | --- | --- | --- |
| headers | `compatibility-header-admission` | Partial | Version, beta, and mutual-exclusion rules are enforced for any request that carries a compatibility header. A request with no compatibility header is accepted as a local caller, which the published contract does not define; this header-free path is a deliberate local-first extension for a self-hosted single-tenant runtime, recorded as such in the headers contract §4, and it is why this entry stays partial. |
| headers | `extension-namespace-exclusion` | Supported |  |
| pagination | `opaque-cursors` | Partial | A collection's envelope follows the mount: the operations router serves `/v1` with `{data, prev_page, next_page}` and its `/v1/x` mirror with the local `{data, has_more, first_id, last_id}`, chosen through one pager so no handler emits both spellings, and cursors that are readable base64url JSON rather than opaque binary. Every canonical `/v1` collection serves the canonical envelope, with no exceptions: the complete-set listings carry `{data, prev_page: null, next_page: null}` and the windowed ones carry a followable cursor — `/v1/sessions` pages by number under `{order, created_at bounds, page}` and rejects a cursor replayed under another ordering or creation window, `/v1/sessions/{id}/events` carries `{order, filter, after_id}`, `/v1/skills` and the credential audit listings use `{offset, filter}` — so a cut page says so instead of looking complete. The one listing that is neither shape is `/v1/environments/{id}/work-items`, a windowed extension that adds a `counts` object and is named in the contract. |
| pagination | `cursor-query-binding` | Supported |  |
| errors | `structured-error-envelope` | Supported |  |
| agents | `agent-crud` | Supported |  |
| agents | `model-object-profile` | Partial | String and object model forms parse field by field. `effort` and `speed` are stored, returned by the read projection (the agent read, the version read, and the session snapshot), and executed on the Anthropic provider under a model capability table — `effort` becomes `output_config.effort`, `fast` becomes `speed: "fast"` with the fast-mode beta, and adaptive-thinking models receive `thinking: {type: "adaptive", display: "omitted"}`; a listed model refused a level or speed it cannot take fails admission, an unknown model id or non-Anthropic provider sends nothing, and a deployment's own `reasoning_effort` model setting is operator-level and separate. `inference_geo` is refused by name with `unsupported_model_field` because this runtime has no inference-geography control; and a canonical `multiagent` roster is refused by name rather than executed. |
| agents | `multiagent-roster` | Unsupported | A canonical `multiagent` roster is refused by name on both agent create and agent update, because no thread, coordinator, or advisor surface exists to honour it; accepting it would let a caller believe delegation by roster is in effect. Local delegation is registered separately as an extension. |
| agents | `local-delegation-subagent` | Supported |  |
| sessions | `session-lifecycle` | Supported |  |
| sessions | `initial-events` | Supported |  |
| sessions | `prompt-caching` | Supported |  |
| sessions | `session-update` | Partial | `POST /v1/sessions/{id}` applies `agent` limited to `tools`/`mcp_servers` (merged onto the resolved definition, validated like creation, and materialized as `agent_definition` without touching the agent row), a `metadata` merge patch (`null` per key removes, `null` field is no change), a `title` replace (`null` clears), and a `budget` move under the budget contract's rules (`budget_create_only`, `budget_not_raised`, `model_not_budgetable`, `budget_invalid_*`). An agent change requires an externally idle session (`session_not_idle` while running); title, metadata, and budget move in any non-terminal state, and a terminated or archived session is `session_terminated`. One `session.updated` event carries only the changed fields — the full agent snapshot, the new ceiling or `null`, the whole post-update metadata bag, the new title — and a no-op emits none. `vault_ids` is refused with `vault_ids_not_updatable`, which is why the capability is partial rather than supported. |
| budget | `session-budget` | Partial | Consumption is priced in integer microcents from the append-only log, and a session may declare a max_list_cost ceiling at creation. The builtin loop checks the ceiling inside a turn: the step that crossed the cap is the last one, the session idles with stop_reason budget_reached and a session.usage immediately before it, and an accepted budget update or removal resumes the session on its own — a tool call the ceiling stranded is settled so the resumed turn sees a paired transcript. At the ceiling the next work-starting event is refused with budget_reached while events that settle work already in flight are still accepted, so the next model request does not start; a declared outcome's revision loop reads the same spend and stops at the ceiling too, closing the outcome with result budget_reached rather than starting another grading pass or turn, because the loop's turns are internal to an event that was already admitted. Two deviations are deliberate: prices come from an operator-supplied cost profile rather than official list prices, so a session whose model the profile cannot price is refused a budget and usage.list_cost is withheld while any used model is unpriced; and the pause is reported on the session's own status_idle only, because the published thread-level budget_reached signal belongs to the thread surface, which this runtime does not implement. |
| events | `append-only-event-log` | Supported |  |
| events | `processed-at-lifecycle` | Supported |  |
| events | `session-error-structure` | Supported |  |
| events | `error-enum-completeness` | Supported |  |
| events | `model-request-span-pair` | Supported |  |
| streaming | `resumable-sse` | Supported |  |
| streaming | `agent-message-stream-preview` | Supported |  |
| tools | `builtin-tool-execution` | Partial | File, shell, search, and web_fetch tools execute; web_search accepts configuration but has no search provider and fails admission before execution. |
| tools | `web-fetch-execution` | Partial | WebFetch executes over HTTP/HTTPS with domain policy, per-redirect revalidation, private-address rejection, timeout and byte caps, HTML text extraction, and a max_content_tokens budget; it converts text-like content only (no image or PDF rendering), the token budget is a character estimate, and TLS hostnames are verified but content is not sandboxed beyond redaction. |
| tools | `web-tool-domain-policy` | Supported |  |
| tools | `tool-output-overflow` | Partial | Overflow has one unified contract (spill path, preview, marker, retrieval), but the local threshold is 50,000 chars rather than the published 100,000. |
| tools | `mcp-tool-approval-gate` | Supported |  |
| custom-tools | `custom-tool-declaration` | Supported |  |
| system-message | `system-message-events` | Supported |  |
| memory-stores | `memory-crud` | Supported |  |
| memory-stores | `memory-limits-and-preconditions` | Supported |  |
| memory-stores | `memory-version-audit` | Supported |  |
| memory-stores | `memory-multi-mount` | Supported |  |
| github-repository | `github-repository-materialization` | Supported |  |
| github-repository | `github-repository-identity-freeze` | Supported |  |
| files | `file-resources` | Supported |  |
| files | `file-mount-path` | Supported |  |
| credentials | `canonical-credential-wire-profile` | Supported |  |
| credentials | `credential-rotation` | Supported |  |
| credentials | `credential-injection-execution` | Partial | A turn on a session that attaches a vault injects its unrestricted environment variables as plaintext into the sandbox command environment and into any stdio MCP server the agent declares (a vault value wins over the value the agent configured), hands a url-transport server the credentials scoped to its own `mcp_server_url` (a `static_bearer` or `mcp_oauth` credential is attached only to the endpoint it names, on the SSE request and on every message POST), redacts every value a sandbox tool hands back and every value an MCP tool returns, and clears the retained values when the turn ends. The runtime composition supplies the resolver, so a CLI-started runtime resolves the session vault while an embedder that omits it runs sessions with no vault. Three deviations: the secret itself enters the child process environment, with no opaque placeholder and no substitution at the network egress, so any command the agent runs can read it and send it out — the published model keeps the credential out of the process and replaces a placeholder on the outbound request; the delegated child path builds its own sandbox tools and does not thread credentials, so a sub-agent receives no vault environment; and nothing is injected into model requests, so a credential authenticates an outbound call rather than a completion. |
| credentials | `oauth-refresh` | Unsupported | No refresh loop or refresh-failure event exists, and none is scheduled. The official MCP OAuth validation endpoint explicitly refuses the capability with unsupported_capability. A supplied refresh block is parsed, stored, and answered with an explicit warning that it will not be executed, so a caller never assumes a token was renewed. |
| operations | `webhook-subscriptions` | Partial | Locally implemented, but the delivery behaviour is not the published contract. Subscriptions are managed over REST under /v1/webhooks (with the /v1/x mirror) and delivery runs from a bridge the runtime composes at startup: each durable event is projected as it is broadcast and a 60-second tick retries due deliveries and runs due deployments, while POST /v1/webhooks/dispatch and POST /v1/webhooks/retry-due remain for on-demand passes. Every attempt carries the published header names and a Standard Webhooks v1 signature over id.timestamp.body — a retry keeps the event id and signs with its own timestamp, and each subscription holds its own whsec_ secret that is returned once at creation, and a rotation window keeps the previous secret valid in a second webhook-signature entry until it is retired — the payload is the published {type: "event", id, created_at, data: {type, id, organization_id, workspace_id}} reference envelope with webhook-id equal to the event id and local constant org/workspace values, subscriptions may only name events from the official catalog — *, prefix.*, and unknown names are refused at write time — and the session stream reaches subscribers only through the published-name projection (status events mapped, budget_reached deduplicated per session and ceiling, internal events dropped) while resource routes publish the lifecycle events for sessions, agents, environments, vaults and credentials, memory stores, and deployments; the catalog names with no producing surface (session.pending/running/idled/requires_action, session.thread_*, agent.deleted, vault_credential.refresh_failed, deployment.deleted) stay subscribable-but-silent, nothing retires the previous secret automatically, of the three published auto-disable cases all three exist, two unconditionally and one opt-in (an attempt that observes a redirect disables the endpoint with the published disabled_reason and is never retried; an attempt whose host is an internal name or resolves to a private address is refused before any connection with its own published reason but only when the deployment sets MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES, off by default because loopback is private and a self-hosted receiver normally shares the host; and an endpoint failing without interruption for at least a window is disabled with the published sustained-failure reason, where the contract publishes the trigger shape — duration, not attempt count, with a 2xx resetting it — but no length, so the window is a local parameter: it defaults to 10 minutes, a deployment sets its own with MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS, and the runtime records the window in force at startup because a deployment variable has no write path of its own). Retries follow the published jittered 5-120s exponential backoff: the ceiling doubles from 60s to 120s and each delay is drawn uniformly between 5s and that ceiling. |
| operations | `scheduled-deployment-timers` | Partial | The published deployment surface end to end: the object answers with type deployment, a depl_ id, a pinned {type, id, version} agent, environment_id, a required non-empty initial_events list (the session admission plus the deployment-only system.message), resources, vault_ids, budget, metadata, and a schedule object with last_run_at and the next three upcoming_runs_at — null for a manual-only deployment, because cron is nullable since M052. Both mount spellings serve create/read/update (POST the published verb, PUT the local one)/archive/pause/unpause/run/run-due from one router, and the local flat aliases (agent_id, cron, timezone, payload) remain accepted. Each run creates its session through createWithInitialEvents and records a drun_ run readable at /v1/deployment_runs (deployment_id, has_error, trigger_type, created_at filters) with trigger_context carrying scheduled_at for a timed run. Failure is asymmetric per the published contract: a missing or archived bound agent archives the deployment with no run, a recoverable session_rate_limited_error records a failed run only, and other classified failures record the run and auto-pause the deployment with paused_reason.error mirroring the run's classified error.type. Manual pause and unpause exist and a paused deployment still accepts a manual run; timed runs publish deployment_run.started/.succeeded/.failed and manual runs publish none, while deployment.created/.updated/.paused/.unpaused/.archived publish on their transitions including the agent-gone cascade. The runtime's 60-second tick runs due deployments and startup re-arms their forward schedule without replaying a missed trigger. Remaining gaps: deployment.deleted has no producer because no delete route exists, and mcp_egress_blocked_error has no producing path because MCP egress is not gated. |
| operations | `outcome-grading` | Supported |  |
| operations | `outcome-evaluation` | Supported |  |
| capabilities | `capability-inventory-endpoint` | Supported |  |
| capabilities | `capability-status-truthfulness` | Supported |  |
| environments | `environment-hosting-config` | Supported |  |
| environments | `environment-network-policy` | Partial | The published config.networking object is accepted in its own vocabulary (limited/unrestricted, allowed_hosts, allow_mcp_servers, allow_package_managers) and normalized into the recorded local config.network spelling by one normalizer, with fail-closed defaults for an unrecognized type and for an unset permission, and a request declaring both spellings inconsistently refused. It is partial because nothing enforces it: no sandbox provider shipped in this runtime reads an environment network policy, so a declared limited policy with an empty allowed_hosts grants the same egress as unrestricted, which the contract file, docs/api.md, and the Console API reference state plainly. The status becomes supported when a provider applies the policy it is given. |
| routes | `documented-route-surface` | Supported |  |
| unsupported | `dreams` | Unsupported | Dreams are a memory-consolidation pipeline: they read memory stores and historical sessions and produce new, reorganized stores. This phase deliberately does not implement it; official SDK routes explicitly refuse it with unsupported_capability. Unavailable rather than not_applicable because the feature belongs in a local-first runtime — what it needs is a scheduled background worker and archived-session corpora, not a hosted service. |
| threads | `threads-and-coordinator` | Unsupported | Not implemented: there is no thread resource, no thread lifecycle or per-thread event isolation, no coordinator or advisor role, no /threads route, and no thread-scoped budget event. A request carrying a `multiagent` roster is refused by name rather than silently stripped. Delegation exists only as the local single-level `delegations` / `enable_general_subagent` extension, which is not this surface. |
| unsupported | `session-budget-alerts` | Unsupported | (not_applicable) Budget notification is a hosted billing feature: it needs an outbound channel to a party who pays for the account, and SandBase is single-tenant and local, so the operator is already the only party to notify. |
| unsupported | `mcp-tunnel` | Unsupported | (not_applicable) MCP tunnel is a hosted connectivity feature outside the local-first scope. |
| unsupported | `web-search-execution` | Unsupported | No search provider is bundled or configured, and search-engine HTML scraping is not an accepted substitute; enabling web_search fails admission before a session is persisted. WebFetch execution is a separate, implemented capability. |
<!-- compat-table:end -->

## 文档

- [机器可读项目元数据](./llms.txt)
- [Agent / MCP 安装指南](./llms-install.md)
- [安装](./docs/installation.md)
- [使用指南](./docs/usage.md)
- [API](./docs/api.md)
- [Skill](./docs/skills.md)
- [部署示例](./docs/deployment.md)
- [DeepSeek V4](./docs/deepseek-v4.md)
- [MiniMax](./docs/minimax.md)
- [系统设计](./docs/spec/design.md)

## 为什么需要它

模型 SDK 负责调用模型，但生产 Agent 还需要解决另一组问题：

- 会话和产物如何持久化？
- 工具在哪个沙箱中执行？
- 敏感动作如何经过权限与审批？
- 出错后如何查看事件、回放并恢复？
- 不同模型如何通过同一运行时接入？

SandBase Harness 提供这层运行时基础设施。它不是可视化工作流编辑器，
也不替代模型 SDK。

## 核心能力

- Claude Managed Agents 风格的 /v1 API 和本地 Console
- SQLite 会话、Agent、Memory、Skill、文件、凭证和 API Key 元数据
- 可恢复的 Server-Sent Events 与会话事件回放
- OpenAI、Anthropic、MiniMax 和 OpenAI-compatible 模型边界
- Local、Docker、Kubernetes 和自托管 Worker 沙箱
- MCP Toolset、权限策略、内置工具和 Skill Package
- DeepSeek Harness 原生 stdio MCP Bridge
- TypeScript SDK：managed-agents/sdk
- 发布门禁：npm run release:check

## 从使用场景开始

参见[场景展示](docs/showcase.zh-CN.md)，了解可审计 Coding Agent、以 DeepSeek
Harness 为交互前端，以及 Local、Docker、Kubernetes、自托管沙箱的受控代码执行。

社区实践讨论：

- [Codex、Claude Code 与 DSH 的 Memory 迁移](https://github.com/deepseek-ai/deepseek-harness/discussions/14#discussioncomment-18202967)
- [第三方插件的沙箱与文件系统防护](https://github.com/deepseek-ai/deepseek-harness/discussions/5068#discussioncomment-18202943)

## 接入 DeepSeek Harness

先构建固定版本源码并启动 Runtime：

~~~bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build:runtime

mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
~~~

另开终端，把插件安装到 DSH Web Profile：

~~~bash
export MANAGED_AGENTS_URL=http://127.0.0.1:3000
# 仅在 Runtime 开启认证时设置 MANAGED_AGENTS_API_KEY
# 从上面创建的 my-agents 目录运行，直接安装固定源码，不解析 npm 同名包
dsh plugin --profile web add -w ../sandbase-harness
# Git URL 备选。保持 HTTPS，不要改成 SSH。
# dsh plugin --profile web add git+https://github.com/sandbaseai/sandbase-harness.git
dsh web
~~~

如果 Plugin Hub 在重复或半途失败的安装后提示
`already installed: managed-agents`，请先更新 Hub，再只移除已显示的
`managed-agents` 插件条目，然后使用带标签的 HTTPS Git 源重试：

~~~bash
dsh plugin --profile web update dsh-plugin
dsh plugin --profile web remove managed-agents
dsh plugin --profile web add git+https://github.com/sandbaseai/sandbase-harness.git
~~~

这是 Plugin Hub 的重复安装路径问题，不是 npm 安装路径。如果已安装列表
显示了不同的目标标识，就只移除列表中显示的精确标识。运行成功前请保留
profile 目录和诊断证据；详见[已报告的恢复 Issue](https://github.com/sandbaseai/sandbase-harness/issues/78)。

Git 安装需要额外一步 pnpm 构建白名单。第一次 add 会以
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败，并打印对应的精确 key；把该 key
加到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 下，然后重新运行同一条
add 命令。裸包名无法匹配 git-hosted 解析：

~~~yaml
allowBuilds:
  "managed-agents@https://codeload.github.com/sandbaseai/sandbase-harness/tar.gz/<commit>": true
~~~

第二次运行会通过 `prepare` 构建 `dist/`，创建 `managed-agents` /
`managed-agents-mcp` 可执行入口，并挂载 Bundle 层。

DSH 随后可以通过原生 MCP Namespace：

- 列出 Agent
- 创建和运行持久化会话
- 读取会话状态和产物
- 停止正在运行的任务

完整工具列表、兼容性证据、权限边界和卸载方法见
[DeepSeek Harness 集成指南](./examples/deepseek-harness/README.md)。

如果希望从 DSH 开始，按步骤加入这个第三方 Runtime 插件，请阅读
[DeepSeek Harness 开发者指南](https://blog.sandbase.ai/zh-CN/deepseek-harness-developer-preview-2026/#接入一个真实的第三方-runtime-插件)。

官方社区展示：
[DeepSeek Harness Discussion #1918](https://github.com/deepseek-ai/deepseek-harness/discussions/1918)。

也可以直接阅读 Handbook 的 [SandBase Harness bridge 专题](https://sandbaseai.github.io/deepseek-harness-handbook/sandbase-harness-bridge.html)，
查看 DSH 集成契约、验证步骤和常见故障边界。

相关实践：[构建可审计的 Research Agent：证据账本、沙箱与回放](https://blog.sandbase.ai/zh-CN/auditable-research-agent-evidence-ledger-sandbox-replay/)。
文章展示如何将证据账本、沙箱执行、凭证、审计和回放组合到 SandBase Harness 工作流中。

该文档之外，也可以阅读已更新到 v0.3.8 的[中文 DeepSeek Harness 开发者指南](https://blog.sandbase.ai/zh-CN/deepseek-harness-developer-preview-2026/#接入一个真实的第三方-runtime-插件)，以及[英文版本](https://blog.sandbase.ai/deepseek-harness-developer-preview-2026/#add-a-real-third-party-runtime-plugin)。

## 添加可移植研究 Skill

在同一个 DSH 项目根目录安装无需 SandBase 账号的 multi-source-search：

~~~bash
npx --yes github:sandbaseai/sandbase-skills add multi-source-search
dsh web
~~~

安装器会把完整 Skill 写入 DSH 的项目级发现目录
.dsh/skills/multi-source-search。当 DSH 已提供网页搜索和页面读取工具时，
该 Skill 不需要 SandBase API。

## 工作区结构

~~~text
my-agents/
├── agents/                  # YAML Agent 定义
├── skills/                  # 启动时导入的 Skill
└── .managed-agents/         # Runtime 状态（应加入 gitignore）
    ├── config.yaml
    ├── data.db
    ├── logs/
    ├── files/
    ├── skills/
    ├── snapshots/
    └── sandbox/
~~~

## 安全边界

- API Key 应只通过环境变量或受控配置传入，不要写入 Prompt 或提交到 Git。
- 默认 Local Sandbox 以当前操作系统用户执行命令，适合可信开发环境。
- 需要更强隔离时使用 Docker 或 Kubernetes Sandbox。
- DSH MCP 子进程只连接 MANAGED_AGENTS_URL，有效权限由
  MANAGED_AGENTS_API_KEY 决定，Bridge 不持久化凭证。

安全问题请使用仓库的
[Security 页面](https://github.com/sandbaseai/sandbase-harness/security)，
不要在公开 Issue 中附带 API Key、工作区数据或会话产物。

## 开发与验证

~~~bash
npm ci
npm run typecheck
npm test
npm run build
npm run release:check
~~~

项目采用 [Apache-2.0](./LICENSE) 许可证。欢迎通过
[Issues](https://github.com/sandbaseai/sandbase-harness/issues) 和
[Discussions](https://github.com/sandbaseai/sandbase-harness/discussions)
反馈问题、分享集成经验或参与贡献。

## 点 Star 与分享

如果它解决了你的真实 Agent 基础设施问题，欢迎
[为仓库点 Star](https://github.com/sandbaseai/sandbase-harness)，帮助更多开发者发现它。

生态目录、社区指南与相关项目见 [docs/ecosystem.md](docs/ecosystem.md)。
