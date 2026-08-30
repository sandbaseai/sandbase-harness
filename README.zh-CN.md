# SandBase Harness

[English](./README.md) | 中文

[![GitHub stars](https://img.shields.io/github/stars/sandbaseai/sandbase-harness?style=social)](https://github.com/sandbaseai/sandbase-harness/stargazers)

一个本地优先、可自托管的 AI Agent Runtime。它把持久化会话、沙箱工具、
Memory、凭证、审计日志、事件回放和可视化 Console 放在同一个运行时边界中，
并提供原生 DeepSeek Harness stdio MCP 插件。

> 正在使用 DeepSeek Harness 构建 Agent？可查看独立的 [DeepSeek Harness Handbook](https://github.com/sandbaseai/deepseek-harness-handbook)，其中包含有来源依据的运行时指南、多语言故障排查，以及持续更新的 [Agent-first 资源地图](https://sandbaseai.github.io/deepseek-harness-handbook/awesome-deepseek-harness-resources.html)。

![SandBase Harness 架构](docs/assets/sandbase-harness-architecture.svg)

> 当前稳定版本：[v0.3.8](https://github.com/sandbaseai/sandbase-harness/releases/tag/v0.3.8)

> 官方 MCP Registry：[io.github.sandbaseai/sandbase-harness](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)（状态：`active`）

> 如果只需要轻量接入而不需要完整 Runtime，可使用 [SandBase CLI](https://github.com/sandbaseai/cli)：
> 它通过本地 stdio MCP Bridge，将 25 个 AI 客户端目标连接到 2,000+ 模型与 API。
> 如果它适合你的工作流，欢迎[为 SandBase CLI 点个 Star](https://github.com/sandbaseai/cli/stargazers)，
> 帮助更多 Agent 用户发现它。

## 为什么需要它

模型 SDK 负责调用模型，但生产 Agent 还需要解决另一组问题：

- 会话和产物如何持久化？
- 工具在哪个沙箱中执行？
- 敏感动作如何经过权限与审批？
- 出错后如何查看事件、回放并恢复？
- 不同模型如何通过同一运行时接入？

SandBase Harness 提供这层运行时基础设施。它不是可视化工作流编辑器，
也不替代模型 SDK。

如果它解决了你的真实 Agent 基础设施问题，欢迎
[为仓库点 Star](https://github.com/sandbaseai/sandbase-harness)，帮助更多开发者发现它。

### 在 Codespaces 中试用

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sandbaseai/sandbase-harness?quickstart=1)

仓库内置的开发容器会自动安装依赖并构建运行时。终端准备完成后，在转发端口上启动服务：

```bash
node dist/index.js start --host 0.0.0.0
```

打开转发的 **SandBase Harness Console** 端口，然后在 **Settings > Models**
中配置模型。GitHub 可能会对 Codespaces 用量计费；下方的本地快速开始仍然免费，
并会把全部运行时数据保存在你的机器上。

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

## 从源码启动

npm 上未加 scope 的 managed-agents **不是**本项目。请使用带标签的
GitHub 源码，不要运行 npx managed-agents 或 npm install managed-agents。

~~~bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build

mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
~~~

打开 http://127.0.0.1:3000/dashboard，进入 **Settings > Models**，
配置模型 API Key 后即可创建 Agent 和会话。

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

## 文档

- [安装](./docs/installation.md)
- [使用指南](./docs/usage.md)
- [API](./docs/api.md)
- [Skill](./docs/skills.md)
- [部署示例](./docs/deployment.md)
- [DeepSeek V4](./docs/deepseek-v4.md)
- [MiniMax](./docs/minimax.md)
- [系统设计](./docs/spec/design.md)

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
