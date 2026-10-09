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

![SandBase Harness 架构](docs/assets/sandbase-harness-architecture.svg)

## 为什么需要它

模型 SDK 负责调用模型，但生产 Agent 还需要解决另一组问题：会话和产物如何
持久化、工具在哪个沙箱中执行、敏感动作如何经过权限与审批、出错后如何回放
现场、不同模型如何通过同一运行时接入。SandBase Harness 提供这层运行时
基础设施——它不是可视化工作流编辑器，也不替代模型 SDK。

| 需求 | Harness 提供的能力 |
| --- | --- |
| 安全运行生成的代码 | Local、Docker、Kubernetes、自托管 Worker 沙箱 |
| 检查长时间运行的 Agent | 持久化会话、可恢复事件流、审计与回放 |
| 控制工具访问 | MCP Toolset、凭证保管库、权限策略与审批 |
| 接入任意模型 | OpenAI、Anthropic、MiniMax、OpenAI-compatible，含 DeepSeek V4 |
| 基础设施归自己 | 本地优先的 SQLite 与文件存储，无需托管控制面 |

## 核心能力

- Claude Managed Agents 风格的 /v1 API 和本地 Console
- SQLite 会话、Agent、Memory、Skill、文件、凭证和 API Key 元数据
- 可恢复的 Server-Sent Events 与会话事件回放
- Local、Docker、Kubernetes 和自托管 Worker 沙箱
- MCP Toolset、权限策略、内置工具和 Skill Package
- TypeScript SDK：managed-agents/sdk
- 发布门禁：npm run release:check

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
[CLI](#cli)。

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

## 界面截图

| Console 总览 | 设置 | API 参考 |
| --- | --- | --- |
| ![overview](docs/assets/dashboard-overview.png) | ![settings](docs/assets/dashboard-settings-models.png) | ![api-ref](docs/assets/dashboard-api-reference.png) |

## 使用官方 SDK

运行时的 `/v1` API 就在同一个端口上，官方 Anthropic TypeScript SDK 客户端可以
原样驱动它：把客户端的 `baseURL` 指向运行时、填上运行时 API Key，
[`examples/official-sdk`](examples/official-sdk/README.md) 里的快速开始就会跑完
一个完整回合——发消息、工具调用、工具结果、最终回复。该示例由
`tests/conformance/official-sdk-quickstart.test.ts` 在每次 PR 上真实执行，
所以这里描述的是被测试过的兼容性，而不是声明出来的兼容性。

同一套接口的规范见 [docs/api.md](docs/api.md)；本仓库自带的 TypeScript SDK 见下文
[SDK](#sdk)。

## CMA 兼容性

运行时对已发布 Claude Managed Agents 契约的覆盖逐条记录在
[`src/core/capabilities/matrix.ts`](src/core/capabilities/matrix.ts) 中：
官方 SDK 路由面中 76 条已挂载、29 条按名拒绝、5 条（多智能体 Thread 面）
延期到受跟踪的 Issue。`Partial` 与 `Unsupported` 条目必须写明原因。

下表由 `npm run docs:compat` 从该矩阵生成，contract-honesty 测试会在表与
矩阵不一致时失败。

<details>
<summary><strong>完整兼容性表（生成）</strong></summary>

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
| sessions | `session-update` | Supported |  |
| budget | `session-budget` | Partial | Consumption is priced in integer microcents from the append-only log, and a session may declare a max_list_cost ceiling at creation. The builtin loop checks the ceiling inside a turn: the step that crossed the cap is the last one, the session idles with stop_reason budget_reached and a session.usage immediately before it, and an accepted budget update or removal resumes the session on its own — a tool call the ceiling stranded is settled so the resumed turn sees a paired transcript. At the ceiling the next work-starting event is refused with budget_reached while events that settle work already in flight are still accepted, so the next model request does not start; a declared outcome's revision loop reads the same spend and stops at the ceiling too, closing the outcome with result budget_reached rather than starting another grading pass or turn, because the loop's turns are internal to an event that was already admitted. Two deviations are deliberate: prices come from an operator-supplied cost profile rather than official list prices, so a session whose model the profile cannot price is refused a budget and usage.list_cost is withheld while any used model is unpriced; and the pause is reported on the session's own status_idle only, because the published thread-level budget_reached signal belongs to the thread surface, which this runtime does not implement. |
| events | `append-only-event-log` | Supported |  |
| events | `processed-at-lifecycle` | Supported |  |
| events | `session-error-structure` | Supported |  |
| events | `error-enum-completeness` | Supported |  |
| events | `model-request-span-pair` | Supported |  |
| streaming | `resumable-sse` | Supported |  |
| streaming | `agent-message-stream-preview` | Supported |  |
| tools | `builtin-tool-execution` | Supported |  |
| tools | `web-fetch-execution` | Partial | WebFetch executes over HTTP/HTTPS with domain policy, per-redirect revalidation, private-address rejection, timeout and byte caps, HTML text extraction, and a max_content_tokens budget; it converts text-like content only (no image or PDF rendering), the token budget is a character estimate, and TLS hostnames are verified but content is not sandboxed beyond redaction. |
| tools | `web-tool-domain-policy` | Supported |  |
| tools | `tool-output-overflow` | Supported |  |
| tools | `mcp-tool-approval-gate` | Supported |  |
| tools | `auto-permission-policy` | Supported |  |
| custom-tools | `custom-tool-declaration` | Supported |  |
| custom-tools | `custom-tool-worker-execution` | Supported |  |
| system-message | `system-message-events` | Supported |  |
| memory-stores | `memory-crud` | Supported |  |
| memory-stores | `memory-limits-and-preconditions` | Supported |  |
| memory-stores | `memory-version-audit` | Supported |  |
| memory-stores | `memory-multi-mount` | Supported |  |
| memory-stores | `memory-worker-materialization` | Supported |  |
| github-repository | `github-repository-materialization` | Supported |  |
| github-repository | `github-repository-identity-freeze` | Supported |  |
| files | `file-resources` | Supported |  |
| files | `file-mount-path` | Supported |  |
| credentials | `canonical-credential-wire-profile` | Supported |  |
| credentials | `credential-rotation` | Supported |  |
| credentials | `credential-injection-execution` | Supported |  |
| credentials | `oauth-refresh` | Supported |  |
| credentials | `mcp-oauth-validation` | Supported |  |
| operations | `webhook-subscriptions` | Partial | Locally implemented, but the delivery behaviour is not the published contract. Subscriptions are managed over REST under /v1/webhooks (with the /v1/x mirror) and delivery runs from a bridge the runtime composes at startup: each durable event is projected as it is broadcast and a 60-second tick retries due deliveries and runs due deployments, while POST /v1/webhooks/dispatch and POST /v1/webhooks/retry-due remain for on-demand passes. Every attempt carries the published header names and a Standard Webhooks v1 signature over id.timestamp.body — a retry keeps the event id and signs with its own timestamp, and each subscription holds its own whsec_ secret that is returned once at creation, and a rotation window keeps the previous secret valid in a second webhook-signature entry until it is retired — manually by retire-secret, or automatically once the window has been open for the duration the deployment set (24 hours by default, settable with MANAGED_AGENTS_WEBHOOK_ROTATION_WINDOW_SECONDS and recorded at startup as webhook_rotation_window; expiry drops the previous columns, enforced where a signature is produced and swept on the retry tick, while a window opened before the since timestamp existed keeps manual-retire behaviour) — the payload is the published {type: "event", id, created_at, data: {type, id, organization_id, workspace_id}} reference envelope with webhook-id equal to the event id and local constant org/workspace values, subscriptions may only name events from the official catalog — *, prefix.*, and unknown names are refused at write time — and the session stream reaches subscribers only through the published-name projection (status events mapped, budget_reached deduplicated per session and ceiling, internal events dropped) while resource routes publish the lifecycle events for sessions, agents, environments, vaults and credentials, memory stores, and deployments; every catalog name has a producer (the coarse session lifecycle names ride the same transitions: pending at creation, running/idled/requires_action through the stream projection), the published names with no producing surface (session.thread_*, agent.deleted) are refused at subscription like any unknown name, of the three published auto-disable cases all three exist, two unconditionally and one opt-in (an attempt that observes a redirect disables the endpoint with the published disabled_reason and is never retried; an attempt whose host is an internal name or resolves to a private address is refused before any connection with its own published reason but only when the deployment sets MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES, off by default because loopback is private and a self-hosted receiver normally shares the host; and an endpoint failing without interruption for at least a window is disabled with the published sustained-failure reason, where the contract publishes the trigger shape — duration, not attempt count, with a 2xx resetting it — but no length, so the window is a local parameter: it defaults to 10 minutes, a deployment sets its own with MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS, and the runtime records the window in force at startup because a deployment variable has no write path of its own). Retries follow the published jittered 5-120s exponential backoff: the ceiling doubles from 60s to 120s and each delay is drawn uniformly between 5s and that ceiling. |
| operations | `scheduled-deployment-timers` | Partial | The published deployment surface end to end: the object answers with type deployment, a depl_ id, a pinned {type, id, version} agent, environment_id, a required non-empty initial_events list (the session admission plus the deployment-only system.message), resources, vault_ids, budget, metadata, and a schedule object with last_run_at and the next three upcoming_runs_at — null for a manual-only deployment, because cron is nullable since M052. Both mount spellings serve create/read/update (POST the published verb, PUT the local one)/archive/pause/unpause/run/run-due from one router, and the local flat aliases (agent_id, cron, timezone, payload) remain accepted. Each run creates its session through createWithInitialEvents and records a drun_ run readable at /v1/deployment_runs (deployment_id, has_error, trigger_type, created_at filters) with trigger_context carrying scheduled_at for a timed run. Failure is asymmetric per the published contract: a missing or archived bound agent archives the deployment with no run, a recoverable session_rate_limited_error records a failed run only, and other classified failures record the run and auto-pause the deployment with paused_reason.error mirroring the run's classified error.type. Manual pause and unpause exist and a paused deployment still accepts a manual run; timed runs publish deployment_run.started/.succeeded/.failed and manual runs publish none, while deployment.created/.updated/.paused/.unpaused/.archived publish on their transitions including the agent-gone cascade, and DELETE removes the deployment and its run records in one transaction then publishes deployment.deleted. The runtime's 60-second tick runs due deployments and startup re-arms their forward schedule without replaying a missed trigger. Remaining gap: mcp_egress_blocked_error has no producing path because MCP egress is not gated. |
| operations | `outcome-grading` | Supported |  |
| operations | `outcome-evaluation` | Supported |  |
| capabilities | `capability-inventory-endpoint` | Supported |  |
| capabilities | `capability-status-truthfulness` | Supported |  |
| environments | `environment-hosting-config` | Supported |  |
| environments | `environment-network-policy` | Partial | The published config.networking object is accepted in its own vocabulary (limited/unrestricted, allowed_hosts, allow_mcp_servers, allow_package_managers) and normalized into the recorded local config.network spelling by one normalizer, with fail-closed defaults for an unrecognized type and for an unset permission, and a request declaring both spellings inconsistently refused. A limited policy is now applied: every limited sandbox gets a per-session loopback egress proxy that speaks CONNECT and absolute-URI HTTP and admits only the effective allowlist (allowed_hosts plus, when the package-manager flag is set, the curated public registry endpoints). The docker provider attaches the session container to an --internal network whose only permitted peer is a relay sidecar forwarding to the proxy, so the boundary is enforced rather than advisory; the local provider injects the proxy variables into every sandbox subprocess and stdio MCP server, which is advisory by construction — a process that ignores proxy variables egresses freely — and reports best_effort rather than claiming enforcement. The MCP connect boundary refuses a url server whose host the policy does not cover (unless allow_mcp_servers is set), web_fetch intersects the declared allowlist with its existing domain and SSRF guards at every redirect hop, and the Environment read projects networking_enforcement (enforced / best_effort / unsupported / not_applicable) from the effective backend's declared capability. It remains partial because the kubernetes and self-hosted providers install no egress boundary — a limited policy on them is reported as unsupported rather than applied — and because the local provider's enforcement is advisory by nature. |
| environments | `environment-work` | Partial | The entire published Work API is mounted over the local tool-execution queue. The data plane: poll claims the oldest claimable item scoped to the calling credential's environment and returns it in the published BetaSelfHostedWork shape with a per-claim secret (base64url JSON carrying a sessions_token minted for that claim, plus api_base_url); ack commits the claim, heartbeat renews the heartbeat lease with the published NO_HEARTBEAT first-claim sentinel and expected_last_heartbeat optimistic-concurrency check (412 carrying the server's current_state), update merges a metadata patch, and stop records the queue's stop marker. The management plane: list pages items newest-first under a keyset page cursor, retrieve answers one item through the same item-scope fence as the item verbs, and stats reports the published work_queue_stats fields computed from the lease model (depth = claimable now, pending = claimed inside its lease, workers_polling = identities seen on poll in 30s). The sessions_token is also the worker's session-level credential beyond the work family: it retrieves its own session (the resources list is how the worker discovers attached stores), lists and streams its events, posts only the tool-answer event types, and reads or writes the memories of stores the session attached — with access: "read_only" attachments refusing writes with 403 and every other route answering 401. The projection is honest about its edges: data is always {type: "session", id} because every local item belongs to a session, per-item desired_ttl_seconds is reported back rather than applied, force-stop has no distinct local mode, and result reporting stays on the local /v1/x/worker channel. Remains partial for those semantic deltas — not for missing routes; nothing in the family is a refusal. |
| routes | `documented-route-surface` | Supported |  |
| dreams | `dreams` | Supported |  |
| threads | `threads-and-coordinator` | Unsupported | Not implemented: there is no thread resource, no thread lifecycle or per-thread event isolation, no coordinator or advisor role, and no thread-scoped budget event. The five published thread routes are mounted `unsupported_capability` refusals naming this capability, so an SDK caller decodes a 400 rather than hitting a 404. A request carrying a `multiagent` roster is refused by name rather than silently stripped. Delegation exists only as the local single-level `delegations` / `enable_general_subagent` extension, which is not this surface. |
| unsupported | `session-budget-alerts` | Unsupported | (not_applicable) Budget notification is a hosted billing feature: it needs an outbound channel to a party who pays for the account, and SandBase is single-tenant and local, so the operator is already the only party to notify. |
| unsupported | `mcp-tunnel` | Unsupported | (not_applicable) MCP tunnel is a hosted connectivity feature outside the local-first scope. |
| tools | `web-search-execution` | Supported |  |
<!-- compat-table:end -->

</details>

## CLI

```bash
managed-agents init
managed-agents start [--host 127.0.0.1] [--port 3000]
managed-agents list
managed-agents reload
managed-agents chat <agent-id> --message "你好" [--tool-approval ask|allow|deny]
managed-agents template list | install <name> | create <name>
```

需要审批的工具调用会挂起而不是失败：`chat` 先询问、确认后让运行时继续同一回合。
`--tool-approval allow` 预先授权全部此类调用（脚本和 CI 用它），`deny` 则拒绝。
没有终端可询问时，默认的 `ask` 不作答并以非零退出、列明等待中的调用，让脚本
显式表达策略而不是继承默认行为。自定义工具例外：只有你的客户端能给出结果，
`chat` 会说明并以非零退出。详见 [usage](docs/usage.md#cli-commands)。

## SDK

```typescript
import { ManagedAgentsClient } from 'managed-agents/sdk';

const client = new ManagedAgentsClient({
  baseUrl: 'http://127.0.0.1:3000',
});

const session = await client.sessions.create({
  agent: 'agent_...',
  environment_id: 'env_...',
});

for await (const event of client.sessions.chat(session.id, 'Hello')) {
  if (event.type === 'agent.message_chunk') {
    process.stdout.write(event.delta ?? '');
  }
}
```

`/v1` API 遵循 Claude Managed Agents 的资源形状，因此也可以直接把 Anthropic
SDK 指向本地运行时：

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.MANAGED_AGENTS_API_KEY ?? 'local-dev-key',
  baseURL: 'http://127.0.0.1:3000',
});

const session = await client.beta.sessions.create({
  agent: 'agent_...',
  environment_id: 'env_...',
});
```

## 认证

默认开放。存在至少一个 API Key 时认证自动生效：

```bash
# 通过环境变量提供静态 Key
export MANAGED_AGENTS_API_KEY=sk-local-example

# 或创建一个受管 Key
curl -X POST http://127.0.0.1:3000/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "Local Console" }'
```

客户端通过 `Authorization: Bearer <key>` 发送凭证。

## 集成与示例

- **DeepSeek Harness 插件**——把本运行时作为 DSH 插件通过 MCP stdio 接入：

  ~~~bash
  export MANAGED_AGENTS_URL=http://127.0.0.1:3000
  dsh plugin --profile web add -w ../sandbase-harness
  dsh web
  ~~~

  DSH 项目还可以从 GitHub 源码安装可移植 Skill：
  `npx --yes github:sandbaseai/sandbase-skills add multi-source-search`
  会写入 `.dsh/skills/multi-source-search`。预检、工具列表与故障排查见
  [`examples/deepseek-harness`](examples/deepseek-harness/README.md)。
- **Agent Plugins 1.0 客户端**（Copilot CLI、VS Code）与独立的
  **MCP Bridge 容器**——见 [`agent-plugin/PLUGIN.md`](agent-plugin/PLUGIN.md)。
- **使用场景**——[场景展示](docs/showcase.zh-CN.md) 包含可审计 Coding Agent、
  以 DSH 为交互前端，以及 Local、Docker、Kubernetes、自托管沙箱的受控代码执行。
- **Agent 配置**——YAML Agent 定义、`config.yaml` 与工作区结构见
  [使用指南](docs/usage.md)；各资源的 curl 示例见 [docs/api.md](docs/api.md)。

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
- [DeepSeek Harness 集成](./examples/deepseek-harness/README.md)

## 安全边界

- API Key 只通过环境变量或受控配置传入，不要写入 Prompt 或提交到 Git。
- 默认 Local Sandbox 以当前操作系统用户执行命令，适合可信开发环境；
  需要更强隔离时使用 Docker 或 Kubernetes Sandbox。

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

生态目录、社区指南与相关项目见 [docs/ecosystem.md](docs/ecosystem.md)。社区实践讨论：
[Codex、Claude Code 与 DSH 的 Memory 迁移](https://github.com/deepseek-ai/deepseek-harness/discussions/14#discussioncomment-18202967)、
[第三方插件的沙箱与文件系统防护](https://github.com/deepseek-ai/deepseek-harness/discussions/5068#discussioncomment-18202943)。
