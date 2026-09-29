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

## 从使用场景开始

参见[场景展示](docs/showcase.zh-CN.md)，了解可审计 Coding Agent、以 DeepSeek
Harness 为交互前端，以及 Local、Docker、Kubernetes、自托管沙箱的受控代码执行。

社区实践讨论：

- [Codex、Claude Code 与 DSH 的 Memory 迁移](https://github.com/deepseek-ai/deepseek-harness/discussions/14#discussioncomment-18202967)
- [第三方插件的沙箱与文件系统防护](https://github.com/deepseek-ai/deepseek-harness/discussions/5068#discussioncomment-18202943)

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

## 发现 SandBase Harness

项目也可以通过以下独立生态目录发现：

- [官方 MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
- [deepseek-plugin.org](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness)
- [DeepseekPlugin](https://deepseekplugin.org/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dshplugin.app/plugins/sandbase-harness)
- [DSH Plugin Hub](https://dshpluginhub.dev/en/plugins/sandbaseai/sandbase-harness)
- [DSH Directory](https://dsh.directory/plugins/sandbaseai/sandbase-harness)
- [DSH Harness](https://dsharness.io/en/plugins?search=sandbase-harness)
- [DSH Plugin](https://dshplugin.me/?q=sandbase-harness)
- [DSH Plugin](https://dsh-plugin.org/plugins/sandbaseai/sandbase-harness)
- [dsh.so 信任与发现目录](https://www.dsh.so/zh/artifact/sandbase-harness/)
- [DeepSeek Harness Hub](https://deepseek-harness-hub.com/plugins/sandbase-harness/) — 社区发现页面；当前元数据仍为过期的 v0.3.4，请以[官方安装文档](https://github.com/sandbaseai/sandbase-harness/blob/main/docs/installation.md)为准
- [Duink DSH Universe](https://duink.com/plugins/1297278222/)
- [DSH Plugin Leaderboard](https://dshpluginleaderboard.com/)
- [Awesome 仓库索引](https://awesome.lvtd.dev/repos/?topic=dsh-plugin)
- [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness)
- [Awesome DeepSeek Harness — 生态列表](https://github.com/fendouai/awesome-deepseek-harness)
- [DSHarness 101 插件雷达](https://dsharness101.com/plugins/)
- [DeepSeekDocs 生态目录](https://deepseekdocs.com/en/ecosystem)
- [Awesome Agents](https://github.com/kyrolabs/awesome-agents)
- [Sifted Awesome AI Agents — 已验证 Agent Runtime 收录](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/Agent%20Runtime.md)
- [Arnon-hs Open Source / AtlasRepo — 已验证 MCP 收录](https://github.com/Arnon-hs/open-source/blob/main/mcp/sandbaseai-sandbase-harness.md)
- [Sagargupta16 Awesome MCP Servers — 已合并收录](https://github.com/Sagargupta16/awesome-mcp-servers/pull/79)
- [Adventure Wave Awesome Agent Security — 已合并收录](https://github.com/adventurewave-labs/awesome-agent-security/pull/2)
- [Arnon-hs Open Source — MCP 项目](https://github.com/Arnon-hs/open-source/blob/main/mcp/README.md)
- [SandBase Awesome Agent Runtime](https://github.com/sandbaseai/awesome-agent-runtime)
- [WalkingLabs Awesome Harness Engineering — 已合并收录](https://github.com/walkinglabs/awesome-harness-engineering/pull/76)
- [Awesome Native Agent Platforms — 已合并 Harness 条目](https://github.com/sandbaseai/awesome-native-agent-platforms/pull/1)
- [Yenanjing Awesome Harness Engineering PR #6 — 等待审核](https://github.com/yenanjing/awesome-harness-engineering/pull/6)
- [abordage/awesome-mcp](https://github.com/abordage/awesome-mcp)
- [cccakeee/awesome-dsh-plugins](https://github.com/cccakeee/awesome-dsh-plugins)
- [anbeime/skill — Skills 索引](https://github.com/anbeime/skill)
- [Awesome DeepSeek Harness Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)
- [Hermes Ecosystem — SandBase 技术栈](https://github.com/ksimback/hermes-ecosystem/blob/main/projects/sandbaseai/cli.html)
- [AgentStack](https://www.agentstack.live/mcp/io.github.sandbaseai/sandbase-harness)
- [HVTracker](https://hvtracker.net/agents/sandbase-harness/)：独立自动生成的 Agent Frameworks 项目档案与排名快照，不代表维护者审核或安全认证。
- [MCP Servers Live](https://linny006.github.io/mcp-servers-live/r/sandbaseai/sandbase-harness/)
- [DSH X-Ray](https://unstone.github.io/dsh-xray/p/sandbaseai__sandbase-harness.html)
- [DSH Plugins](https://github.com/HackSing/dsh-plugins)
- [Awesome DSH Hub](https://github.com/ukinch605/awesome-dsh-hub)
- [Awesome DSH Plugins 2026](https://github.com/Herdeny/awesome-dsh-plugins-2026)
- [MCP Repository](https://mcprepository.com/sandbaseai/sandbase-harness)
- [MCP Server Hub](https://mcpserver.dev/s/sandbase-harness_4o5awxb)：MCP Server Hub 已公开展示 SandBase Harness 条目。
- [MCPFly 提交](https://mcpserver.so/submit)：仓库已被接口接受并等待审核，尚未宣称已有公开 listing
- [MCP Central API](https://mcpcentral.io/api/servers?search=sandbase)：公开的 MCP Registry 下游镜像，返回状态为 active 的 `io.github.sandbaseai/sandbase-harness` 条目；版本快照可能滞后于当前 release。
- [MCPVault](https://mcpvault.io/servers/sandbase-harness)
- [F8W 中文项目档案](https://www.f8w.com/github/sandbaseai__sandbase-harness/)
- [RepoRank 俄语项目档案](https://reporank.net/ru/repo/sandbaseai-sandbase-harness.html)
- [Agent Plugins Hub — 旧版本快照](https://agentplugin.net/dsh/plugins/managed-agents)
- [MCP Market](https://mcpmarket.com/server/sandbase-harness)
- [OpenAgentSkill — code-review](https://www.openagentskill.com/skills/sandbaseai-sandbase-harness-code-review)
- [PluginBench](https://pluginbench.com/mcp/io.github.sandbaseai/sandbase-harness)
- [DSH Plugin Store](https://www.dshplugin.store/plugin/sandbaseai/sandbase-harness)
- [DSH Hub](https://dshhub.dev/plugins/sandbase-harness)
- [dshbase](https://dshbase.com/plugins/sandbase-harness/)
- [FindHarness](https://findharness.com/plugins/sandbaseai-sandbase-harness)
- [DSH Market](https://dshmarket.com/p/sandbaseai/sandbase-harness/)
- [DSH Plugins](https://dshplugins.cc/en/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dsh-plugin.github.io/directory.html)
- [DSH Plugin Registry](https://github.com/dshplugin-app/deepseek-harness-plugins)
- [dsh-market](https://dshmarket.com/p/sandbaseai/sandbase-harness/)
- [dshplugin.dev](https://dshplugin.dev/plugins/sandbaseai-sandbase-harness)

近期已核验的社区引用：

- [dshbase 已核验插件页](https://dshbase.com/plugins/sandbase-harness/)
- [MCP Repository — 已核验项目页](https://mcprepository.com/sandbaseai/sandbase-harness)
- [DSHarness 101 — 已核验插件雷达条目](https://dsharness101.com/plugins/)
- [DSH Plugin Leaderboard — 已核验安装条目](https://dshpluginleaderboard.com/)
- [awesome-agent-runtime — 已合并条目](https://github.com/sandbaseai/awesome-agent-runtime/pull/15)
- [Awesome Agent Cortex — 已合并条目](https://github.com/0xNyk/awesome-agent-cortex/pull/72)
- [Awesome AI Devtools — 已合并条目](https://github.com/yeaight7/awesome-ai-devtools/pull/33)
- [Awesome Agent Skills — 已合并条目](https://github.com/VoltAgent/awesome-agent-skills/pull/946)
- [WalkingLabs Awesome Harness Engineering — 已合并条目](https://github.com/walkinglabs/awesome-harness-engineering/pull/76)
- [awesome-mcp-servers — 已合并 MCP 条目](https://github.com/mcpHQ/awesome-mcp-servers/pull/45)
- [Awesome Coding Agents — 已合并 Harness 条目](https://github.com/kailiu42/awesome-coding-agents/pull/41)
- [Agent Framework Radar — 已核验自动收录](https://github.com/linny006/agent-framework-radar)
- [LLM Agents Radar — 已核验自动收录](https://github.com/linny006/llm-agents-radar)
- [Awesome DSH Plugin — 已核验条目](https://github.com/Anil-matcha/awesome-dsh-plugin)
- [Awesome DeepSeek Harness — 已核验条目](https://github.com/awesome-deepseekharness/awesome-deepseek-harness)
- [Dominic789654 Awesome DeepSeek Harness — 已核验公开条目](https://github.com/Dominic789654/awesome-deepseek-harness)
- [Zhiyuan-Fan Awesome DeepSeek Harness Plugins — 已核验 Runtime 条目](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)
- [Herdeny Awesome DSH Plugins 2026 — 已核验公开条目](https://github.com/Herdeny/awesome-dsh-plugins-2026)
- [HackSing DSH Plugins — 已核验公开条目](https://github.com/HackSing/dsh-plugins)
- [white0dew Awesome DSH Plugins — 已核验生成条目](https://github.com/white0dew/awesome-dsh-plugins)
- [saltbo Awesome Stars — 已核验公开条目](https://github.com/saltbo/awesome-stars)
- [GitHub Insight Radar — 已核验公开推荐](https://github.com/LeombE/github-insight-radar/blob/main/reports/daily/2026-08-30-action-list.md)
- [Blue-Whale-Harness — 已核验公开目录条目](https://github.com/leenkcool/Blue-Whale-Harness/blob/main/repos.json)
- [DSH Plugin Radar — 已核验自动收录](https://github.com/AdamPlatin123/dsh-plugin-radar)
- [Awesome DSH Plugin — 已合并 Harness 条目](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1879)
- [Awesome DeepSeek Harness — 已合并 Runtime 条目](https://github.com/0xsline/awesome-deepseek-harness/pull/141)
- [Awesome Agents — 已合并 Harness 条目](https://github.com/kyrolabs/awesome-agents/pull/707)
- [Awesome AI Engineering — 已合并 Harness 条目](https://github.com/Eric-LLMs/Awesome-AI-Engineering/pull/4)
- [abordage/awesome-mcp — 已合并 Harness 条目](https://github.com/abordage/awesome-mcp/pull/95)
- [Awesome DSH Plugin — 已合并 Harness 条目](https://github.com/Anil-matcha/awesome-dsh-plugin/pull/47)
- [Awesome DeepSeek Harness — 已合并 Harness 条目](https://github.com/Dominic789654/awesome-deepseek-harness/pull/182)
- [DeepSeek Harness Handbook — 已合并 v0.3.8 bridge 指南](https://github.com/sandbaseai/deepseek-harness-handbook/pull/291)

正在等待社区审核：

- [NeuraLiying Awesome Agent Harnesses Issue #4](https://github.com/NeuraLiying/Awesome-Agent-Harnesses/issues/4) — 建议加入 Production Harnesses、SDKs & Frameworks，已补充 v0.3.8、安装/MCP 来源、可选后端及依赖部署的隔离边界核验（[核验说明](https://github.com/NeuraLiying/Awesome-Agent-Harnesses/issues/4#issuecomment-5473588176)）
- [Acuvity MCP Servers Registry Issue #18](https://github.com/acuvity/mcp-servers-registry/issues/18) — 建议收录 v0.3.8 GHCR stdio Bridge、六个工具及运行时环境变量，已补充维护者核验与依赖后端的隔离边界（[核验说明](https://github.com/acuvity/mcp-servers-registry/issues/18#issuecomment-5473588201)）
- [Nexu Harness Engineering Guide Issue #70](https://github.com/nexu-io/harness-engineering-guide/issues/70) — 建议作为有来源依据的 Runtime 资源，覆盖会话、工具治理、审批、凭证、Memory、产物、审计/回放及可选后端（[核验说明](https://github.com/nexu-io/harness-engineering-guide/issues/70#issuecomment-5473588182)）
- [EvoMap Awesome Agent Evolution Issue #53](https://github.com/EvoMap/awesome-agent-evolution/issues/53) — 已按 Agent Development Platforms 提交，附 v0.3.8、安装、MCP、有状态 Runtime 及依赖后端的隔离证据（[核验说明](https://github.com/EvoMap/awesome-agent-evolution/issues/53#issuecomment-5473603962)）
- [Awesome DeepSeek Harness Top 500 Issue #3](https://github.com/weekend-project-space/awesome-deepseek-harness-top-500/issues/3) — 建议作为 DSH Runtime/Integration 条目，已补充当前版本、Registry、安装及后端隔离边界证据（[核验说明](https://github.com/weekend-project-space/awesome-deepseek-harness-top-500/issues/3#issuecomment-5473603971)）
- [Libukai Awesome DeepSeek Harness Issue #94](https://github.com/libukai/awesome-deepseek-harness/issues/94) — 建议作为区别于 SandBase CLI 的独立 DSH Runtime 条目，已补充 v0.3.8 安装/MCP 及后端证据（[核验说明](https://github.com/libukai/awesome-deepseek-harness/issues/94#issuecomment-5473606895)）
- [E2B Awesome AI SDKs PR #344](https://github.com/e2b-dev/awesome-ai-sdks/pull/344) — 已有 canonical Harness 条目，当前可合并；CLA 检查仍需贡献者账号完成
- [Awesome MCP Servers PR #13240](https://github.com/punkpeye/awesome-mcp-servers/pull/13240) — canonical MCP 目录条目的 `check-submission` 已通过，等待维护者/Glama 审核；旧重复 PR #13188 已关闭
- [Sunrisepeak dsh-index PR #43](https://github.com/Sunrisepeak/dsh-index/pull/43) — 将 SandBase Harness descriptor 从 v0.3.7 更新至 v0.3.8，提交版本的构建与 boot 检查已通过，但当前 PR 需要 rebase
- [Awesome AI Agents 2026 PR #240](https://github.com/ARUNAGIRINATHAN-K/awesome-ai-agents-2026/pull/240) — 已在 Agent Tooling and Infrastructure 中将 SandBase Harness runtime 与现有 CLI 条目区分收录，等待维护者审核；失败的链接检查仅涉及 PR 之外既有的 `ofekron/better-agent` 404
- [E2B Awesome AI Agents Issue #1468](https://github.com/e2b-dev/awesome-ai-agents/issues/1468) — 请求将 SandBase Harness 与已关闭的 CLI 提交区分，已补充来源证据，等待目录确认范围
- [NipunaRanasinghe Awesome AI Agents PR #184](https://github.com/NipunaRanasinghe/awesome-ai-agents/pull/184) — 使用目录的动态 star badge 将 SandBase Harness 加入 Core Frameworks，等待维护者审核
- [Zients Awesome Agent Harness PR #10](https://github.com/zients/awesome-agent-harness/pull/10) — 已将 SandBase Harness 加入 Agent Systems & Harnesses，等待维护者审核
- [McpMux Server Registry PR #286](https://github.com/mcpmux/mcp-servers/pull/286)
- [Mctrinh Awesome MCP Servers PR #105](https://github.com/mctrinh/awesome-mcp-servers/pull/105)
- [Docker MCP Registry PR #4841](https://github.com/docker/mcp-registry/pull/4841) — 已完成验证，等待维护者审核
- [HabitoAI Awesome MCP Servers PR #37](https://github.com/habitoai/Awesome-MCP-Servers-directory/pull/37) — 已加入 Developer Tools，PR 状态干净，等待维护者审核
- [MCP Hub / mcpdir issue #20](https://github.com/eL1fe/mcpdir/issues/20) — 与已有 CLI 条目分开的 Harness 收录申请，等待目录审核
- [MCP Server Finder evaluation issue #4](https://github.com/ModelContextProtocol-Security/mcpserver-finder/issues/4) — 已申请独立 MCP bridge 评估，不宣称评分或安全认证
- [TensorBlock Awesome MCP Servers issue #2067](https://github.com/TensorBlock/awesome-mcp-servers/issues/2067) — issue 与自动 PR #2068 已关闭，并由已合并的 PR #2060 取代；应使用已合并条目/profile，不要使用不完整的自动元数据（[历史修正](https://github.com/TensorBlock/awesome-mcp-servers/issues/2067#issuecomment-5473393345)）
- [Awesome Agent-Native Services PR #116](https://github.com/haoruilee/awesome-agent-native-services/pull/116) — 已获策展批准并提交 v0.3.8 runtime、MCP、session、approval、credential、audit/replay 证据；PR 可合并但被仓库 gate 阻塞，等待策展方合并（[核验说明](https://github.com/haoruilee/awesome-agent-native-services/pull/116#issuecomment-5473455471)）
- [ToolSDK MCP Registry PR #488](https://github.com/toolsdk-ai/toolsdk-mcp-registry/pull/488) — Schema 与 Biome 检查通过，等待维护者审核
- [MCP.Directory 提交](https://mcp.directory/submit) — 已提交，等待目录审核
- [Hugging Face agent-harness 注册 PR #2432](https://github.com/huggingface/huggingface.js/pull/2432) — 已修正不应将 `MANAGED_AGENTS_HOME` 当作身份标记的问题，检查通过，等待维护者合并
- [Agent Switchboard 收录 PR #44](https://github.com/assafbar2/agentswitchboard.dev/pull/44) — 已提交 v0.3.8 更新条目，等待维护者验证
- [Awesome AI Agents 2026 PR #16](https://github.com/Supersynergy/awesome-ai-agents-2026/pull/16) — 已将 SandBase Harness 加入 Agent Runtimes and Platforms，等待维护者审核
- [Awesome AI Agent Engineering PR #1](https://github.com/sspoisk/awesome-ai-agent-engineering/pull/1) — 已将 SandBase Harness 加入 Deployment，等待维护者审核
- [AI Native Landscape 提交 #18](https://github.com/rootsongjc/ai-native-landscape/issues/18) — 已提交至 `platform-infra` / `sandboxes-runtimes`，等待策展审核
- [Agentic Community Landscape PR #2](https://github.com/agentic-community/agentic-landscape/pull/2) — 已将 SandBase Harness 加入 Agentic → Runtime，等待维护者审核
- [MyMCPTools 目录 Issue #8](https://github.com/shibley/mymcptools/issues/8) — 已提交 v0.3.8 MCP bridge 目录申请，等待维护者审核
- [mcp.so/mcpso 提交线程](https://github.com/chatmcp/mcpso/issues/1#issuecomment-5471477016) — 已通过公开 GitHub Issue 流程提交 v0.3.8 MCP bridge，等待目录审核
- [Collective AI Tools Issue #332](https://github.com/hanishrao/collective-ai-tools/issues/332) — 已与现有 CLI 条目分开提交 SandBase Harness，等待目录审核
- [Awesome Agent Skills PR #79](https://github.com/philipbankier/awesome-agent-skills/pull/79) — 已将 SandBase Harness 加入 MCP runtime 与 infrastructure，等待维护者审核
- [Awesome MCP List PR #409](https://github.com/MobinX/awesome-mcp-list/pull/409) — 已将 SandBase Harness 加入 AI Agents & Frameworks，等待维护者审核
- [Best-of MCP Servers Issue #370](https://github.com/tolkonepiu/best-of-mcp-servers/issues/370) — 已提交至 MCP 服务器排行榜，已补充 v0.3.8 bridge 和当前安装元数据，收录/排名仍待审核
- [Awesome Agent Runtimes PR #4](https://github.com/beejmaxx/awesome-agent-runtimes/pull/4) — 已按成熟度门槛提交至 watchlist，并在[维护者核验](https://github.com/beejmaxx/awesome-agent-runtimes/pull/4#issuecomment-5473692077)中补充当前 v0.3.8、安装、MCP 和 API 证据，等待审核
- [DeepYard 提交](https://deepyard.dev/submit) — 已通过公开审核表单提交至 `Frameworks & SDKs` 分类，等待审核，尚未宣称公开收录
- [BotMarket MCP 记录](https://botmarket.bot/v1/mcp/io-github-sandbaseai-sandbase-harness) — 公开 API 当前报告一个来自官方 MCP Registry 的 active 记录（`102971`）；人工提交队列 `4` 仍单独跟踪
- [Awesome Agent Sandbox PR #2](https://github.com/yanmxa/awesome-agent-sandbox/pull/2) — 已将 SandBase Harness 加入 Related Projects；Sourcery、GitGuardian 和可合并性检查已通过，仍等待维护者合并（[交接说明](https://github.com/yanmxa/awesome-agent-sandbox/pull/2#issuecomment-5473182863)）
- [Awesome Agent Infra PR #6](https://github.com/shenli/awesome-agent-infra/pull/6) — 已将 SandBase Harness 加入 Runtime and Control Plane，等待维护者审核
- [Awesome CLI Coding Agents PR #314](https://github.com/bradAGI/awesome-cli-coding-agents/pull/314) — 已将 SandBase Harness 加入 Runtime & execution backends，等待维护者审核
- [Awesome AI Developer Stack PR #2](https://github.com/masrisystems/awesome-ai-developer-stack/pull/2) — 已将 SandBase Harness 加入 MCP Servers 表格，等待维护者审核
- [Awesome Agent Cortex PR #74](https://github.com/0xNyk/awesome-agent-cortex/pull/74) — 已将 SandBase Harness 加入 Agent Runtime Infrastructure，等待维护者审核
- [Awesome Agent Harness PR #29](https://github.com/mahonzhan/awesome-agent-harness/pull/29) — 已将 SandBase Harness 加入 Agent Harness 时间线，PR 状态 clean 且可合并，等待维护者审核（[核验说明](https://github.com/mahonzhan/awesome-agent-harness/pull/29#issuecomment-5473355320)）
- [AutoJunjie Awesome Agent Harness issue #59](https://github.com/AutoJunjie/awesome-agent-harness/issues/59) — 已申请将 SandBase Harness 加入 Agent Runtimes，已提供当前版本、API、DeepSeek 示例、MCP 镜像及后端依赖隔离说明，等待策展审核（[核验说明](https://github.com/AutoJunjie/awesome-agent-harness/issues/59#issuecomment-5473368720)）
- [AgentSpot submission #1](https://github.com/agentspot/agentspot-submissions/issues/1) — 已提交 GitHub 源码/发布版本及 GHCR MCP bridge 分发信息，并提供 v0.3.8 安装、MCP、DeepSeek 证据，等待免费目录审核（[核验说明](https://github.com/agentspot/agentspot-submissions/issues/1#issuecomment-5473380420)）
- [Awesome Loop Engineering resource suggestion #23](https://github.com/ChaoYue0307/awesome-loop-engineering/issues/23) — 已提交基于源码证据的学习资源建议，覆盖 session、工具治理、approval 与 audit/replay，等待维护者策展（[核验说明](https://github.com/ChaoYue0307/awesome-loop-engineering/issues/23#issuecomment-5473407275)）
- [Best of Agent Harnesses PR #99](https://github.com/RyanAlberts/best-of-Agent-Harnesses/pull/99) — 已按生成式排行目录规范提交 v0.3.8 Harness 条目，PR 可合并，等待维护者审核（[核验说明](https://github.com/RyanAlberts/best-of-Agent-Harnesses/pull/99#issuecomment-5470293386)）
- [Awesome Agent Harnesses PR #5](https://github.com/Anandesh-Sharma/awesome-agent-harnesses/pull/5) — 已将 SandBase Harness 加入 coding-agent harness 目录，PR 状态 clean 且可合并，CodeRabbit 检查成功，等待维护者审核（[核验说明](https://github.com/Anandesh-Sharma/awesome-agent-harnesses/pull/5#issuecomment-5473341966)）
- [Awesome Agentic AI 中文 Stage 7 PR #228](https://github.com/WenyuChiou/awesome-agentic-ai-zh/pull/228) — 已于 `1cb0406` 合并，作为 #213 的无冲突整合版本；三语条目及 1,036 个脚本/31 个定向检查已通过
- [Awesome Terminal Agents PR #5](https://github.com/EnigmaYYYY/awesome-terminal-agents/pull/5) — 已将 SandBase Harness 作为 Engineering-Practice-Tool 加入终端 Agent 专题，等待维护者审核
- [Awesome MCP DevTools PR #13](https://github.com/Epistates/awesome-mcp-devtools/pull/13) — 已加入 Proxies and Gateways，并在[核验说明](https://github.com/Epistates/awesome-mcp-devtools/pull/13#issuecomment-5473780943)补充当前 v0.3.8 与安装/MCP 来源，等待审核
- [Awesome MCP Collection PR #39](https://github.com/JustInCache/awesome-mcp-collection/pull/39) — 已将 SandBase Harness 加入 Development & Version Control，等待维护者审核
- [Awesome MCP Issue #99](https://github.com/abordage/awesome-mcp/issues/99) — 已请求加入 Aggregators & Gateways，等待维护者审核
- [Awesome MCP Gateways PR #77](https://github.com/e2b-dev/awesome-mcp-gateways/pull/77) — 已将 SandBase Harness 加入 Open-source MCP Gateways，等待维护者审核及 CLA 检查
- [Awesome AI Harness PR #4](https://github.com/weiwei966/awesome-ai-harness/pull/4) — 已将 SandBase Harness 加入 SDKs & runtimes，等待维护者审核
- [Awesome AI Coding Sandboxes PR #15](https://github.com/fhiltscher/awesome-ai-coding-sandboxes/pull/15) — 已将 SandBase Harness 加入 Adjacent runtimes，等待维护者审核
- [Awesome Agent Infrastructure PR #23](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/23) — 已将 SandBase Harness 加入 Execution Sandboxes，等待维护者审核
- [Awesome Agent Sandboxing PR #2](https://github.com/IronSecCo/awesome-agent-sandboxing/pull/2) — 已将 SandBase Harness 加入 Self-hosted Agent Runtimes，等待维护者审核
- [Awesome Sandbox PR #27](https://github.com/restyler/awesome-sandbox/pull/27) — 已新增 SandBase Harness runtime/sandbox 专题章节，等待维护者审核
- [Awesome AI Agents Security PR #107](https://github.com/ProjectRecon/awesome-ai-agents-security/pull/107) — 已加入 Sandboxing & Isolation Environments，已发布[核验跟进](https://github.com/ProjectRecon/awesome-ai-agents-security/pull/107#issuecomment-5473074958)，PR 可合并，等待维护者审核
- [UCSB Awesome Agent Security PR #16](https://github.com/ucsb-mlsec/Awesome-Agent-Security/pull/16) — 已将 SandBase Harness 加入 System-level Runtime Defense，PR 可合并，等待维护者审核
- [Awesome DevOps MCP Servers PR #327](https://github.com/rohitg00/awesome-devops-mcp-servers/pull/327) — 已加入 Code Execution，已发布[核验跟进](https://github.com/rohitg00/awesome-devops-mcp-servers/pull/327#issuecomment-5473090598)，PR 可合并，等待维护者审核
- [EverWorks Awesome MCP Servers PR #161](https://github.com/ever-works/awesome-mcp-servers/pull/161) — 已加入 Code Execution & Automation，并在[核验说明](https://github.com/ever-works/awesome-mcp-servers/pull/161#issuecomment-5473781279)修正过期文档路径，等待审核
- [AIAnytime Awesome MCP Server PR #78](https://github.com/AIAnytime/Awesome-MCP-Server/pull/78) — 已独立于 SandBase CLI 加入 MCP bridge 条目，并在[维护者核验](https://github.com/AIAnytime/Awesome-MCP-Server/pull/78#issuecomment-5473797072)修正过期文档路径，等待审核
- [Collabnix Awesome MCP Lists PR #105](https://github.com/collabnix/awesome-mcp-lists/pull/105) — 已加入 DevOps & Infrastructure，并在[核验说明](https://github.com/collabnix/awesome-mcp-lists/pull/105#issuecomment-5473781090)修正过期文档路径，等待审核
- [MCP Finder Awesome MCP Servers PR #9](https://github.com/mcp-finder/awesome-mcp-servers/pull/9) — 已加入 Cloud and DevOps，并在[维护者核验](https://github.com/mcp-finder/awesome-mcp-servers/pull/9#issuecomment-5473796953)确认当前来源与后端依赖隔离，等待审核
- [Awesome AI Agent Tools PR #27](https://github.com/michielhdoteth/awesome-ai-agent-tools/pull/27) — 已合并独立的 SandBase Harness MCP 目录条目和 Docker stdio 安装元数据
- [Enterprise AI Atlas Awesome MCP Servers PR #10](https://github.com/Enterprise-AI-Atlas/awesome-mcp-servers/pull/10) — 已将 SandBase Harness 加入 Developer Tools，并添加 Docker stdio 安装元数据，PR 可合并，等待维护者审核
- [Awesome-MCP PR #36](https://github.com/Albertchamberlain/Awesome-MCP/pull/36) — 已新增带 stdio transport 的结构化 SandBase Harness `server` 条目，PR 可合并，CI 已通过
- [Awesome-MCP PR #36 核验](https://github.com/Albertchamberlain/Awesome-MCP/pull/36#issuecomment-5473810768) — 已确认当前 v0.3.8、Registry、运行中 API 与后端隔离边界
- [bgizdov Awesome MCP Servers PR #17](https://github.com/bgizdov/awesome-mcp-servers/pull/17) — 已在 DevOps 分类新增 JSON 条目及 Docker stdio bridge，PR 可合并，等待维护者审核
- [Awesome AI Coding Tools PR #665](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/665) — 已加入 MCP Servers and Directories，已发布[核验跟进](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/665#issuecomment-5473061822)，PR 可合并，等待维护者审核
- [Awesome AI Developer Tools PR #11](https://github.com/ayushrajdev9-cmyk/awesome-ai-developer-tools/pull/11) — 已将 SandBase Harness 加入 DevOps & Deployment，PR 可合并，等待维护者审核
- [Pipedream Awesome MCP Servers PR #111](https://github.com/PipedreamHQ/awesome-mcp-servers/pull/111) — 已加入 Artificial Intelligence MCP server 列表，已发布[核验跟进](https://github.com/PipedreamHQ/awesome-mcp-servers/pull/111#issuecomment-5473048884)，PR 可合并，等待维护者审核
- [Awesome AI & Developer Tools PR #5](https://github.com/guojianrong/awesome-ai-developer-tools/pull/5) — 已将 SandBase Harness 加入 CI/CD & DevOps，PR 可合并，等待维护者审核
- [Awesome AI & Developer Tools PR #5 核验](https://github.com/guojianrong/awesome-ai-developer-tools/pull/5#issuecomment-5473810596) — 已确认当前版本、bridge 镜像、项目范围与后端隔离边界
- [LaunchApp Awesome AI Coding Tools PR #34](https://github.com/launchapp-dev/awesome-ai-coding-tools/pull/34) — 已将 SandBase Harness 加入 MCP 分类，并标注 self-hosted 与 free/open-source，PR 可合并，等待维护者审核
- [LaunchApp Awesome AI Coding Tools PR #34 核验](https://github.com/launchapp-dev/awesome-ai-coding-tools/pull/34#issuecomment-5473974225) — 已确认当前 v0.3.8、Registry/镜像引用与依赖后端的 sandbox 边界
- [AI Agent Sandboxes PR #3](https://github.com/pjlsergeant/ai-sandboxes/pull/3) — 已加入带证据链接的结构化 SandBase Harness 元数据，等待维护者审核
- [Awesome Agent Sandbox PR #2](https://github.com/vivy-yi/awesome-agent-sandbox/pull/2) — 已将 SandBase Harness 加入 Self-hosted / Open Source 沙箱表格，等待维护者审核
- [Awesome Agent Sandboxes PR #9](https://github.com/dloss/awesome-agent-sandboxes/pull/9) — 已将 SandBase Harness 加入 Containers，等待维护者审核
- [Awesome Agent Sandboxes PR #9 核验](https://github.com/dloss/awesome-agent-sandboxes/pull/9#issuecomment-5473974508) — 已确认当前 v0.3.8 来源与依赖后端的隔离边界
- [Awesome Agent Sandbox PR #4](https://github.com/fishman/awesome-agent-sandbox/pull/4) — 已将 SandBase Harness 加入 Container Sandboxes 及对比表，等待维护者审核
- [Awesome Agent Sandboxes PR #59](https://github.com/msyvr/awesome-agent-sandboxes/pull/59) — 已加入结构化 SandBase Harness 沙箱元数据并重新生成目录文件，等待维护者审核
- [MeshKore 目录提交](https://meshkore.com/submit) — 已接受审核，提交编号 #14，公开档案待生成
- [Awesome Agentic Open-Source Tools PR #1](https://github.com/samaybhavsar/awesome-agentic-opensource-tools/pull/1) — 已加入 Agent Frameworks & Orchestration，等待维护者审核
- [awesome-ai-agents-2026 PR #2](https://github.com/Dehar624/awesome-ai-agents-2026/pull/2) — 已加入 Local Runtimes & LLM Management，等待维护者审核
- [AgentFirst 目录 PR #46](https://github.com/bradvin/agentfirst.directory/pull/46) — 已加入 Compute & Sandboxes，enrichment 检查通过，等待维护者审核
- [AI Agent Tools 提交](https://aiagenttools.dev/submit) — 已提交至 MCP Servers 分类，等待目录审核
- [MCP Server Finder 评估 Issue #4](https://github.com/ModelContextProtocol-Security/mcpserver-finder/issues/4) — 已请求对 MCP bridge 进行独立质量与安全评估，等待审核
- [Agentic DevOps MCP PR #42](https://github.com/agenticdevops/awesome-devops-mcp/pull/42) — 已加入 Kubernetes & Containers，等待维护者审核
- [Awesome DevOps AI PR #54](https://github.com/hammadhaqqani/awesome-devops-ai/pull/54) — 已加入 MCP Servers for DevOps，等待维护者审核
- [Awesome Platform Engineering PR #63](https://github.com/shospodarets/awesome-platform-engineering/pull/63) — 已加入 Internal Developer Platforms，等待维护者审核
- [Awesome DevOps Platform PR #4](https://github.com/tysoncung/awesome-devops-platform/pull/4) — 已加入 AI & Automation in DevOps，等待维护者审核
- [Awesome Platform Engineering PR #11](https://github.com/ShakedBraimok/awesome-platform-engineering/pull/11) — 已加入 AI Platform Engineering & LLMOps，等待维护者审核
- [Awesome LLMOps PR #539](https://github.com/InftyAI/Awesome-LLMOps/pull/539) — 由项目申请 #538 自动生成，已加入 Runtime / AI Agent，构建通过，等待维护者审核
- [TensorChord Awesome LLMOps PR #785](https://github.com/tensorchord/Awesome-LLMOps/pull/785) — 已将 SandBase Harness 加入 LLMOps 目录，DCO 已通过，等待维护者审核
- [Awesome-LLMSecOps PR #66](https://github.com/wearetyomsmnv/Awesome-LLMSecOps/pull/66) — 已将带来源链接的 SandBase Harness 条目加入 Agentic security，PR 状态干净且可合并，等待维护者审核
- [Awesome Agent Runtime Security PR #30](https://github.com/bureado/awesome-agent-runtime-security/pull/30) — 已将 SandBase Harness 加入 Sandboxing & Isolation，并明确部署/后端限制，PR 状态干净且可合并，等待维护者审核
- [Awesome LLM Security PR #313](https://github.com/corca-ai/awesome-llm-security/pull/313) — 已将 SandBase Harness 作为运行时治理参考加入 Tools，PR 状态干净且可合并，等待维护者审核
- [Awesome AI Agents PR #467](https://github.com/jim-schwoebel/awesome_ai_agents/pull/467) — 现有 AI Agent 资源目录收录申请，已添加单行 SandBase Harness 条目，PR 状态干净且可合并，等待维护者审核
- [Jenqyang Awesome AI Agents PR #460](https://github.com/Jenqyang/Awesome-AI-Agents/pull/460) — 按该目录的开源与中性描述规范，将 SandBase Harness 加入 Applications → Tools，PR 状态干净且可合并，等待维护者审核
- [Slava Awesome AI Agents PR #403](https://github.com/slavakurilyak/awesome-ai-agents/pull/403) — AI Agent 目录中已有 SandBase Harness 收录申请，PR 状态干净且可合并，等待维护者审核
- [Scottcjn Awesome Agents PR #59](https://github.com/Scottcjn/awesome-agents/pull/59) — Agent 平台/框架目录中已有 SandBase Harness 收录申请，PR 状态干净且可合并，等待维护者审核
- [Awesome Agent Infrastructure PR #21](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/21) — 已加入 Execution Sandboxes，条目已更新至当前 MCP 安装文档，等待维护者审核
- [Awesome DevOps PR #30](https://github.com/nirgeier/awesome-devops/pull/30) — 已将 SandBase Harness 加入 MCP 工具目录，DCO 已通过，等待维护者审核
- [Awesome Self-Hosted Agents PR #6](https://github.com/arcane-bear/awesome-self-hosted-agents/pull/6) — 已将 SandBase Harness 加入 self-hosted agent frameworks 列表，PR 状态 clean，等待维护者审核
- [Awesome Agent Infra PR #2](https://github.com/jovial-liu/awesome-agent-infra/pull/2) — 已将 SandBase Harness 加入机器可读的 runtime catalog，校验、测试和 lint 均通过，等待维护者审核
- [Awesome AI Agents PR #1](https://github.com/tioraicom/awesome-ai-agents/pull/1) — 已将 SandBase Harness 加入 Agent infrastructure，PR 状态 clean，等待维护者审核
- [Awesome Agent Operating Systems PR #13](https://github.com/frankxai/awesome-agent-operating-systems/pull/13) — 已将 SandBase Harness 合并加入 Agent Runtimes，并添加日期验证链接
- [Awesome Agent Services PR #8](https://github.com/farol-team/awesome-agent-services/pull/8) — 已将 SandBase Harness 加入 Sandboxes & Compute，PR 状态 clean，等待维护者审核
- [Awesome AI Automation PR #3](https://github.com/minhazda/awesome-ai-automation/pull/3) — 已将 SandBase Harness 加入 AI agents & LLM automation，PR 状态 clean，等待维护者审核
- [Awesome Best Open Source AI Agents 2026 PR #1](https://github.com/GagnDeep/awesome-best-open-source-ai-agents-2026/pull/1) — 已加入包含许可证、语言、Stars、活跃度和 Best-for 元数据的 GitHub 验证条目，PR 状态 clean，等待维护者审核
- [Awesome AI Agents — Agent Playbook PR #1](https://github.com/agentplaybook-io/awesome-ai-agents/pull/1) — 已将 SandBase Harness 加入 self-hosted frameworks 列表，PR 状态 clean，等待维护者审核
- [Discussion #116](https://github.com/sandbaseai/sandbase-harness/discussions/116) — 官方 DevOps runtime 与 MCP bridge 推广介绍
- [DeepSeek Harness Showcase 更新](https://github.com/deepseek-ai/deepseek-harness/discussions/1918#discussioncomment-18212204) — 双语介绍 gVisor 集成路径与 Hugging Face 归因修复审核状态
- [Cline MCP Marketplace Issue #2364](https://github.com/cline/mcp-marketplace/issues/2364) — v0.3.8 MCP bridge 提交，正在审核；参见[维护者核验说明](https://github.com/cline/mcp-marketplace/issues/2364#issuecomment-5473147267)和[官方双语更新](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212395)
- [MCPSo 提交 Issue #3834](https://github.com/chatmcp/mcpso/issues/3834)
- [Awesome Agent Frameworks 架构提案 #6](https://github.com/subinium/awesome-agent-frameworks/issues/6)
- [Agent Sandbox Taxonomy 档案提案 #5](https://github.com/kajogo777/the-agent-sandbox-taxonomy/issues/5)
- [Open-Kairox Awesome Agent Harnesses Issue #1](https://github.com/open-kairox/awesome-agent-harnesses/issues/1) — 建议加入双语 Agent Harness 列表，已补充 v0.3.8、安装/MCP、Runtime 控制及依赖后端的隔离核验（[核验说明](https://github.com/open-kairox/awesome-agent-harnesses/issues/1#issuecomment-5473624141)）
- [Awesome Agent Sandboxes PR #9](https://github.com/arjan/awesome-agent-sandboxes/pull/9)
- [Mossaka Awesome Agent Sandboxes PR #1](https://github.com/Mossaka/awesome-agent-sandboxes/pull/1)
- [dsh-index PR #43](https://github.com/Sunrisepeak/dsh-index/pull/43) — 已提交当前 SandBase Harness 描述；提交版本检查通过，但 PR 当前需要 rebase
- [AgentIndex issue #3](https://github.com/agentidx/agentindex/issues/3) — 提议加入有来源依据的运行时索引，已补充 v0.3.8、安装/MCP、会话治理、审计/回放及依赖后端的隔离范围（[核验说明](https://github.com/agentidx/agentindex/issues/3#issuecomment-5473643330)）
- [Agent Harness MCP preset issue #47](https://github.com/madebywild/agent-harness/issues/47) — 提议基于已发布 bridge 镜像和六个工具增加 MCP preset，等待项目维护者审核（[核验说明](https://github.com/madebywild/agent-harness/issues/47#issuecomment-5473643364)）
- [Discussion #116 更新](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212016) — 发布 v0.3.8 安装与已合并集成状态，邀请用户反馈
- [Discussion #116 最新更新](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212677) — 公布 Awesome Coding Agents 已合并收录，并重申当前安装入口与 TensorBlock 元数据问题
- [Discussion #116 推广更新](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213014) — 双语汇总 DeepYard 审核提交与 BotMarket 人工审核队列状态
- [Discussion #116 BotMarket 状态修正](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213051) — 记录来自官方 Registry 的 active MCP 条目，并与人工队列 `4` 分开说明
- [Discussion #116 TensorBlock 更新](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213205) — 公布 TensorBlock MCP 条目已合并及公开 profile，并标注当前 v0.3.8 bridge
- [AAE Agent Engineering issue #1](https://github.com/Lxcardoza993/AAE/issues/1) — 已提交至精选 Agent Harness 分类，等待策展审核
- [HKUST-KnowComp Awesome Agent Harness Issue #8](https://github.com/HKUST-KnowComp/Awesome-Agent-Harness/issues/8) — 已提交为源链接 runtime 资源，已补充当前 v0.3.8 证据及依赖后端的隔离边界，等待策展审核
- [Picrew Awesome Agent Harness issue #82](https://github.com/Picrew/awesome-agent-harness/issues/82) — 已在 `ddbf183` 准备 handbook 条目；因现有 fork 历史不相关，等待维护者应用变更
- [Awesome AI Engineering PR #4](https://github.com/Eric-LLMs/awesome-ai-engineering/pull/4) — 已于 `0a308b0` 合并，SandBase Harness 已加入开源 Agent Engineering 项目表
- [TensorBlock Awesome MCP Servers PR #2060](https://github.com/TensorBlock/awesome-mcp-servers/pull/2060) — 已于 `c88cedf` 合并，当前 v0.3.8 bridge 条目可通过 [TensorBlock profile](https://tensorblock.co/mcp/servers/github-sandbaseai-sandbase-harness-7a5986ca) 查看
- [MCPVault 提交](https://mcpvault.io/submit) — 公开提交流程需要 GitHub 登录；正常提交返回 `401 not_signed_in`，因此当前不宣称已有收录
- [Awesome Agentic MCP Security PR #28](https://github.com/mcp-security-project/awesome-agentic-mcp-security/pull/28) — 已加入 MCP hosting/runtime，完成 v0.3.8 核验；GitHub 当前为 `UNSTABLE`
- [RoyalPinto Awesome MCP Security PR #4](https://github.com/royalpinto007/awesome-mcp-security/pull/4) — 已加入 permission 分类，完成 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核
- [Awesome AI Developer Tools PR #11](https://github.com/ayushrajdev9-cmyk/awesome-ai-developer-tools/pull/11) — 已加入 DevOps & Deployment，并核验当前 Registry/GHCR 与 v0.3.8，等待维护者审核
- [LAS-WG Awesome Agent Infrastructure PR #10](https://github.com/las-wg/awesome-agent-infrastructure/pull/10) — 已加入 Open-Source Projects，并完成 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核
- [Awesome Agent Skills PR #79](https://github.com/philipbankier/awesome-agent-skills/pull/79) — 已加入 MCP runtime/infrastructure，完成 v0.3.8 核验；GitHub 当前为 `UNSTABLE`
- [Awesome MCP List PR #409](https://github.com/MobinX/awesome-mcp-list/pull/409) — 已加入 AI Agents & Frameworks，完成 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核
- [Awesome Agent Sandboxes PR #59](https://github.com/msyvr/awesome-agent-sandboxes/pull/59) — 已加入生成式 sandbox 目录并刷新输出，明确非普适、依赖后端的隔离范围，等待维护者审核
- [Awesome Agent Sandbox PR #2](https://github.com/vivy-yi/awesome-agent-sandbox/pull/2) — 已加入 self-hosted sandbox 条目并完成 v0.3.8 来源核验，等待维护者审核
- [Awesome Agent Sandbox PR #4](https://github.com/fishman/awesome-agent-sandbox/pull/4) — 已加入容器 sandbox 条目并核验依赖后端的隔离边界，等待维护者审核
- [Awesome CLI Coding Agents PR #314](https://github.com/bradAGI/awesome-cli-coding-agents/pull/314) — 已加入 Runtime & execution backends，完成 v0.3.8 来源核验，等待维护者审核
- [Awesome Terminal Agents PR #5](https://github.com/EnigmaYYYY/awesome-terminal-agents/pull/5) — 已加入 Engineering-Practice-Tool runtime 参考，完成 v0.3.8 核验，等待维护者审核
- [Awesome AI Agents 2026 PR #16](https://github.com/Supersynergy/awesome-ai-agents-2026/pull/16) — 已加入 agent runtimes/platforms，完成 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核
- [Awesome Agent Infra PR #6](https://github.com/shenli/awesome-agent-infra/pull/6) — 已加入 Runtime and Control Plane，完成 v0.3.8 来源核验；GitHub 当前为 `UNSTABLE`，等待维护者审核
- [Curated MCP Servers PR #9](https://github.com/oxbshw/curated_mcp_servers/pull/9) — 已加入 Developer Tools & Infrastructure，并完成 v0.3.8 来源核验，等待维护者审核
- [Awesome Agent Runtimes PR #1](https://github.com/dz3ai/awesome-agent-runtimes/pull/1) — 已加入 runtime 对比表，补充 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核
- [AI Agent Infrastructure List PR #4](https://github.com/chgaowei/ai-agent-infra-list/pull/4) — 已新增中英文 Runtime 条目并核验当前 v0.3.8，等待维护者审核
- [Skyming Awesome AI Agent PR #19](https://github.com/skyming/awesome-ai-agent/pull/19) — 已新增中文 runtime 条目并补充 v0.3.8 来源核验，等待维护者审核
- [Awesome Agent Harness PR #58](https://github.com/AutoJunjie/awesome-agent-harness/pull/58) — 已加入 Agent Runtimes，披露维护者关系并完成事实核验，等待维护者审核
- [Awesome Agent Security PR #10](https://github.com/authora-dev/awesome-agent-security/pull/10) — 已加入 Sandboxed Execution，并明确目录收录不等于安全认证，等待维护者审核
- [DevInsight Awesome MCP PR #6](https://github.com/devinsightdotio/awesome_mcp/pull/6) — 已加入 MCP Servers，补充当前 v0.3.8 与依赖后端的隔离边界核验，等待维护者审核

这些页面由独立目录维护；仓库源码和 release metadata 仍是项目事实来源。

### 在 Codespaces 中试用

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sandbaseai/sandbase-harness?quickstart=1)

仓库内置的开发容器会自动安装依赖并构建运行时。终端准备完成后，在转发端口上启动服务：

```bash
node dist/index.js start --host 0.0.0.0
```

打开转发的 **SandBase Harness Console** 端口，然后在 **Settings > Setup**
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

打开 http://127.0.0.1:3000/dashboard，在 **Settings > Setup** 上完成两步：
先在提供者表单里保存 API Key，页面提示保存的配置尚未生效时重启 Runtime，
再在 **Agent models** 面板里把每个 Agent 的模型 ID 改成你的提供者实际提供的
那个（例如 DeepSeek 用 `deepseek-chat`）。模型 ID 属于 Agent 本身，`init`
写入的 `gpt-4o` 并非每个提供者都能用。

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

引用信息见 [Citation metadata](./CITATION.cff)。推广入口和审核状态见[推广状态台账](./docs/promotion.md)；可复用的事实型
[推广联系模板](./docs/promotion-outreach.md)供维护者发送给人工审核渠道。
