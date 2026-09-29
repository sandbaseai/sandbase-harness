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
