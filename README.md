# SandBase Harness

[English](./README.md) | [中文](./README.zh-CN.md)

[![GitHub stars](https://img.shields.io/github/stars/sandbaseai/sandbase-harness?style=social)](https://github.com/sandbaseai/sandbase-harness/stargazers)
[![Listed on deepseek-plugin.org](https://img.shields.io/badge/listed_on-deepseek--plugin.org-007EC6)](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness)
[![Release](https://img.shields.io/github/v/release/sandbaseai/sandbase-harness)](https://github.com/sandbaseai/sandbase-harness/releases/latest)
[![Official MCP Registry](https://img.shields.io/badge/Official_MCP_Registry-active-2ea44f)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
[![Discussions](https://img.shields.io/github/discussions/sandbaseai/sandbase-harness)](https://github.com/sandbaseai/sandbase-harness/discussions)
[![CodeQL](https://github.com/sandbaseai/sandbase-harness/actions/workflows/codeql.yml/badge.svg)](https://github.com/sandbaseai/sandbase-harness/actions/workflows/codeql.yml)
[![License](https://img.shields.io/github/license/sandbaseai/sandbase-harness)](LICENSE)

AI-readable project metadata: [llms.txt](./llms.txt) · [installation guide](./llms-install.md)

A local-first runtime for AI agents. Sessions, sandboxed tools, memory,
credentials, audit trails, and a built-in Console — all running on your
machine or in your own infrastructure.

> Building with DeepSeek Harness? The independent [DeepSeek Harness Handbook](https://github.com/sandbaseai/deepseek-harness-handbook) provides source-backed runtime guides, multilingual troubleshooting, and a regularly updated [Agent-first resource map](https://sandbaseai.github.io/deepseek-harness-handbook/awesome-deepseek-harness-resources.html).

![SandBase Harness architecture](docs/assets/sandbase-harness-architecture.svg)

> Looking for a lightweight bridge instead of a full runtime? [SandBase CLI](https://github.com/sandbaseai/cli)
> connects 25 AI client targets to 2,000+ models and APIs through a local stdio MCP bridge.
> If it fits your workflow, [star SandBase CLI](https://github.com/sandbaseai/cli/stargazers)
> so other agent users can discover it.

> Need hosted model and media APIs instead? SandBase provides one interface for
> [LLM, image, and video generation APIs](https://blog.sandbase.ai/unified-ai-api-llm-image-video-2026/),
> with the [API quickstart](https://www.sandbase.ai/docs/getting-started/) covering keys and first calls.

```bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
# open http://127.0.0.1:3000/dashboard
```

Choose SandBase Harness when you need more than a model loop:

| Need | What Harness provides |
| --- | --- |
| Run generated code safely | Local, Docker, Kubernetes, and self-hosted worker sandboxes |
| Inspect long-running agents | Persistent sessions, resumable event streams, audit, and replay |
| Control tool access | MCP toolsets, credential vaults, permission policies, and approvals |
| Operate any model | OpenAI, Anthropic, MiniMax, and OpenAI-compatible providers, including DeepSeek V4 |
| Keep infrastructure yours | Local-first SQLite and file storage with no required hosted control plane |

If this runtime solves a real agent-infrastructure problem for you,
[star the repository](https://github.com/sandbaseai/sandbase-harness) so other builders can find it.

## Find SandBase Harness

The project is also discoverable through these independent ecosystem directories:

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
- [deepseek-plugin.org](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness)
- [DeepseekPlugin](https://deepseekplugin.org/en/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dshplugin.app/plugins/sandbase-harness)
- [DSH Plugin Hub](https://dshpluginhub.dev/en/plugins/sandbaseai/sandbase-harness)
- [DSH Directory](https://dsh.directory/plugins/sandbaseai/sandbase-harness)
- [DSH Harness](https://dsharness.io/en/plugins?search=sandbase-harness)
- [DSH Plugin](https://dshplugin.me/?q=sandbase-harness)
- [DSH Plugin](https://dsh-plugin.org/plugins/sandbaseai/sandbase-harness)
- [dsh.so Trust & Discovery Registry](https://www.dsh.so/artifact/sandbase-harness/)
- [DeepSeek Harness Hub](https://deepseek-harness-hub.com/plugins/sandbase-harness/) — community discovery page; its metadata is currently stale at v0.3.4, so use the current official installation guide
- [Duink DSH Universe](https://duink.com/plugins/1297278222/)
- [DSH Plugin Leaderboard](https://dshpluginleaderboard.com/)
- [Awesome repository index](https://awesome.lvtd.dev/repos/?topic=dsh-plugin)
- [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness)
- [Awesome DeepSeek Harness — ecosystem list](https://github.com/fendouai/awesome-deepseek-harness)
- [DSHarness 101 Plugin Radar](https://dsharness101.com/plugins/)
- [DeepSeekDocs Ecosystem](https://deepseekdocs.com/en/ecosystem)
- [Awesome Agents](https://github.com/kyrolabs/awesome-agents)
- [Sifted Awesome AI Agents — Agent Runtime Top 100](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/Agent%20Runtime.md)
- [Arnon-hs Open Source — MCP projects](https://github.com/Arnon-hs/open-source/blob/main/mcp/README.md)
- [SandBase Awesome Agent Runtime](https://github.com/sandbaseai/awesome-agent-runtime)
- [abordage/awesome-mcp](https://github.com/abordage/awesome-mcp)
- [cccakeee/awesome-dsh-plugins](https://github.com/cccakeee/awesome-dsh-plugins)
- [anbeime/skill — Skills index](https://github.com/anbeime/skill)
- [Awesome DeepSeek Harness Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)
- [Hermes Ecosystem — SandBase stack](https://github.com/ksimback/hermes-ecosystem/blob/main/projects/sandbaseai/cli.html)
- [AgentStack](https://www.agentstack.live/mcp/io.github.sandbaseai/sandbase-harness)
- [HVTracker](https://hvtracker.net/agents/sandbase-harness/): independent automated Agent Frameworks profile and ranking snapshot; not a maintainer review or security certification.
- [MCP Servers Live](https://linny006.github.io/mcp-servers-live/r/sandbaseai/sandbase-harness/)
- [DSH X-Ray](https://unstone.github.io/dsh-xray/p/sandbaseai__sandbase-harness.html)
- [DSH Plugins](https://github.com/HackSing/dsh-plugins)
- [Awesome DSH Hub](https://github.com/ukinch605/awesome-dsh-hub)
- [Awesome DSH Plugins 2026](https://github.com/Herdeny/awesome-dsh-plugins-2026)
- [MCP Repository](https://mcprepository.com/sandbaseai/sandbase-harness)
- [MCP Server Hub](https://mcpserver.dev/s/sandbase-harness_4o5awxb): public MCP Server Hub listing for SandBase Harness.
- [MCPFly submission](https://mcpserver.so/submit): repository submission accepted and pending approval; no public listing is claimed yet
- [MCP Central API](https://mcpcentral.io/api/servers?search=sandbase): public downstream registry mirror returning the active `io.github.sandbaseai/sandbase-harness` entry; its version snapshot may lag the current release.
- [MCPVault](https://mcpvault.io/servers/sandbase-harness)
- [F8W 中文项目档案](https://www.f8w.com/github/sandbaseai__sandbase-harness/)
- [RepoRank Русский профиль](https://reporank.net/ru/repo/sandbaseai-sandbase-harness.html)
- [Agent Plugins Hub — legacy snapshot](https://agentplugin.net/dsh/plugins/managed-agents)
- [MCP Market](https://mcpmarket.com/server/sandbase-harness)
- [OpenAgentSkill — code-review](https://www.openagentskill.com/skills/sandbaseai-sandbase-harness-code-review)
- [PluginBench](https://pluginbench.com/mcp/io.github.sandbaseai/sandbase-harness)
- [DSH Plugin Store](https://www.dshplugin.store/plugin/sandbaseai/sandbase-harness)
- [DSH Hub](https://dshhub.dev/plugins/sandbase-harness)
- [DSH Packs](https://www.dshpacks.com/plugins/sandbaseai-sandbase-harness/)
- [dshbase](https://dshbase.com/plugins/sandbase-harness/)
- [FindHarness](https://findharness.com/plugins/sandbaseai-sandbase-harness)
- [DSH Market](https://dshmarket.com/p/sandbaseai/sandbase-harness/)
- [DSH Plugins](https://dshplugins.cc/en/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dsh-plugin.github.io/directory.html)
- [DSH Plugin Registry](https://github.com/dshplugin-app/deepseek-harness-plugins)
- [dsh-market](https://dshmarket.com/p/sandbaseai/sandbase-harness/)
- [dshplugin.dev](https://dshplugin.dev/plugins/sandbaseai-sandbase-harness)

Recently verified community references:

- [dshbase verified plugin page](https://dshbase.com/plugins/sandbase-harness/)
- [MCP Repository — verified project page](https://mcprepository.com/sandbaseai/sandbase-harness)
- [DSHarness 101 — verified plugin radar entry](https://dsharness101.com/plugins/)
- [DSH Plugin Leaderboard — install-verified entry](https://dshpluginleaderboard.com/)
- [awesome-agent-runtime — merged entry](https://github.com/sandbaseai/awesome-agent-runtime/pull/15)
- [Awesome Agent Cortex — merged entry](https://github.com/0xNyk/awesome-agent-cortex/pull/72)
- [Awesome AI Devtools — merged entry](https://github.com/yeaight7/awesome-ai-devtools/pull/33)
- [Awesome Agent Skills — merged entry](https://github.com/VoltAgent/awesome-agent-skills/pull/946)
- [WalkingLabs Awesome Harness Engineering — merged entry](https://github.com/walkinglabs/awesome-harness-engineering/pull/76)
- [Adventure Wave Awesome Agent Security — merged entry](https://github.com/adventurewave-labs/awesome-agent-security/pull/2)
- [Awesome Native Agent Platforms — merged Harness entry](https://github.com/sandbaseai/awesome-native-agent-platforms/pull/1)
- [awesome-mcp-servers — merged MCP entry](https://github.com/mcpHQ/awesome-mcp-servers/pull/45)
- [Awesome Coding Agents — merged Harness entry](https://github.com/kailiu42/awesome-coding-agents/pull/41)
- [Sifted Awesome AI Agents — verified Agent Runtime entry](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/Agent%20Runtime.md)
- [Agent Framework Radar — verified automatic entry](https://github.com/linny006/agent-framework-radar)
- [LLM Agents Radar — verified automatic entry](https://github.com/linny006/llm-agents-radar)
- [Awesome DSH Plugin — verified entry](https://github.com/Anil-matcha/awesome-dsh-plugin)
- [Awesome DeepSeek Harness — verified entry](https://github.com/awesome-deepseekharness/awesome-deepseek-harness)
- [Dominic789654 Awesome DeepSeek Harness — verified public entry](https://github.com/Dominic789654/awesome-deepseek-harness)
- [Zhiyuan-Fan Awesome DeepSeek Harness Plugins — verified runtime entry](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)
- [Herdeny Awesome DSH Plugins 2026 — verified public entry](https://github.com/Herdeny/awesome-dsh-plugins-2026)
- [HackSing DSH Plugins — verified public entry](https://github.com/HackSing/dsh-plugins)
- [white0dew Awesome DSH Plugins — verified generated entry](https://github.com/white0dew/awesome-dsh-plugins)
- [saltbo Awesome Stars — verified public entry](https://github.com/saltbo/awesome-stars)
- [GitHub Insight Radar — verified public recommendation](https://github.com/LeombE/github-insight-radar/blob/main/reports/daily/2026-08-30-action-list.md)
- [Blue-Whale-Harness — verified public directory entry](https://github.com/leenkcool/Blue-Whale-Harness/blob/main/repos.json)
- [DSH Plugin Radar — verified automatic entry](https://github.com/AdamPlatin123/dsh-plugin-radar)
- [Awesome DSH Plugin — merged Harness entry](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1879)
- [Awesome DeepSeek Harness — merged runtime entry](https://github.com/0xsline/awesome-deepseek-harness/pull/141)
- [Arnon-hs Open Source / AtlasRepo — verified MCP entry](https://github.com/Arnon-hs/open-source/blob/main/mcp/sandbaseai-sandbase-harness.md)
- [Sagargupta16 Awesome MCP Servers — merged entry](https://github.com/Sagargupta16/awesome-mcp-servers/pull/79)
- [Awesome Agents — merged Harness entry](https://github.com/kyrolabs/awesome-agents/pull/707)
- [Awesome AI Engineering — merged Harness entry](https://github.com/Eric-LLMs/Awesome-AI-Engineering/pull/4)
- [abordage/awesome-mcp — merged Harness entry](https://github.com/abordage/awesome-mcp/pull/95)
- [Awesome DSH Plugin — merged Harness entry](https://github.com/Anil-matcha/awesome-dsh-plugin/pull/47)
- [Awesome DeepSeek Harness — merged Harness entry](https://github.com/Dominic789654/awesome-deepseek-harness/pull/182)
- [DeepSeek Harness Handbook — merged v0.3.8 bridge guide](https://github.com/sandbaseai/deepseek-harness-handbook/pull/291)

Pending community review:

- [NeuraLiying Awesome Agent Harnesses Issue #4](https://github.com/NeuraLiying/Awesome-Agent-Harnesses/issues/4) — proposed for Production Harnesses, SDKs & Frameworks; maintainer verification covers v0.3.8, installation/MCP sources, selectable backends, and the deployment-dependent isolation boundary ([verification](https://github.com/NeuraLiying/Awesome-Agent-Harnesses/issues/4#issuecomment-5473588176))
- [Acuvity MCP Servers Registry Issue #18](https://github.com/acuvity/mcp-servers-registry/issues/18) — proposed the v0.3.8 GHCR stdio bridge with six tools and runtime environment variables; maintainer verification and backend-dependent isolation qualification supplied ([verification](https://github.com/acuvity/mcp-servers-registry/issues/18#issuecomment-5473588201))
- [Nexu Harness Engineering Guide Issue #70](https://github.com/nexu-io/harness-engineering-guide/issues/70) — proposed as a source-backed runtime resource covering sessions, tool governance, approvals, credentials, memory, artifacts, audit/replay, and selectable backends ([verification](https://github.com/nexu-io/harness-engineering-guide/issues/70#issuecomment-5473588182))
- [EvoMap Awesome Agent Evolution Issue #53](https://github.com/EvoMap/awesome-agent-evolution/issues/53) — submitted under Agent Development Platforms with v0.3.8 release, installation, MCP, stateful-runtime, and backend-dependent isolation evidence ([verification](https://github.com/EvoMap/awesome-agent-evolution/issues/53#issuecomment-5473603962))
- [Awesome DeepSeek Harness Top 500 Issue #3](https://github.com/weekend-project-space/awesome-deepseek-harness-top-500/issues/3) — proposed as a DSH runtime/integration entry with current release, Registry, installation, and backend-boundary evidence ([verification](https://github.com/weekend-project-space/awesome-deepseek-harness-top-500/issues/3#issuecomment-5473603971))
- [Libukai Awesome DeepSeek Harness Issue #94](https://github.com/libukai/awesome-deepseek-harness/issues/94) — proposed as a distinct DSH runtime entry from SandBase CLI, with v0.3.8 installation/MCP and backend evidence ([verification](https://github.com/libukai/awesome-deepseek-harness/issues/94#issuecomment-5473606895))
- [E2B Awesome AI SDKs PR #344](https://github.com/e2b-dev/awesome-ai-sdks/pull/344) — existing canonical Harness entry, currently mergeable; CLA verification still requires contributor action
- [Awesome MCP Servers PR #13240](https://github.com/punkpeye/awesome-mcp-servers/pull/13240) — canonical MCP directory entry with passed `check-submission`; maintainer/Glama review remains pending; superseded duplicate #13188 is closed
- [Sunrisepeak dsh-index PR #43](https://github.com/Sunrisepeak/dsh-index/pull/43) — updates the SandBase Harness descriptor from v0.3.7 to v0.3.8; build and boot checks passed at the submitted revision, but the PR currently needs a rebase
- [Awesome AI Agents 2026 PR #240](https://github.com/ARUNAGIRINATHAN-K/awesome-ai-agents-2026/pull/240) — added the distinct SandBase Harness runtime beside the existing CLI entry under Agent Tooling and Infrastructure; maintainer review pending. The failed link check reports only a pre-existing `ofekron/better-agent` 404 outside this PR.
- [E2B Awesome AI Agents Issue #1468](https://github.com/e2b-dev/awesome-ai-agents/issues/1468) — requested review of SandBase Harness as a distinct runtime entry from the closed CLI submission; follow-up evidence posted, scope decision pending
- [NipunaRanasinghe Awesome AI Agents PR #184](https://github.com/NipunaRanasinghe/awesome-ai-agents/pull/184) — added SandBase Harness to Core Frameworks using the directory's dynamic stars badge; maintainer review pending
- [Zients Awesome Agent Harness PR #10](https://github.com/zients/awesome-agent-harness/pull/10) — added SandBase Harness to Agent Systems & Harnesses; maintainer review pending
- [McpMux Server Registry PR #286](https://github.com/mcpmux/mcp-servers/pull/286)
- [Mctrinh Awesome MCP Servers PR #105](https://github.com/mctrinh/awesome-mcp-servers/pull/105)
- [Docker MCP Registry PR #4841](https://github.com/docker/mcp-registry/pull/4841) — validation complete; maintainer review pending
- [HabitoAI Awesome MCP Servers PR #37](https://github.com/habitoai/Awesome-MCP-Servers-directory/pull/37) — added to Developer Tools; PR is clean and maintainer review pending
- [MCP Hub / mcpdir issue #20](https://github.com/eL1fe/mcpdir/issues/20) — separate Harness listing request from the existing CLI entry; directory review pending
- [MCP Server Finder evaluation issue #4](https://github.com/ModelContextProtocol-Security/mcpserver-finder/issues/4) — independent MCP bridge evaluation requested; no score or certification claimed
- [TensorBlock Awesome MCP Servers issue #2067](https://github.com/TensorBlock/awesome-mcp-servers/issues/2067) — issue and automated PR #2068 were closed as superseded by merged PR #2060; use the merged entry/profile rather than the incomplete generated metadata ([historical correction](https://github.com/TensorBlock/awesome-mcp-servers/issues/2067#issuecomment-5473393345))
- [Awesome Agent-Native Services PR #116](https://github.com/haoruilee/awesome-agent-native-services/pull/116) — curator-approved dossier with v0.3.8 runtime, MCP, session, approval, credential, and audit/replay evidence; merged by the directory maintainer ([verification](https://github.com/haoruilee/awesome-agent-native-services/pull/116#issuecomment-5473455471))
- [ToolSDK MCP Registry PR #488](https://github.com/toolsdk-ai/toolsdk-mcp-registry/pull/488) — schema and Biome checks pass; maintainer review pending
- [MCP.Directory submission](https://mcp.directory/submit) — already submitted; directory review pending
- [Hugging Face agent-harness registry PR #2432](https://github.com/huggingface/huggingface.js/pull/2432) — registry entry corrected to avoid treating `MANAGED_AGENTS_HOME` as an identity marker; checks pass, maintainer merge pending
- [Agent Switchboard listing PR #44](https://github.com/assafbar2/agentswitchboard.dev/pull/44) — refreshed v0.3.8 listing; maintainer verification pending
- [Awesome AI Agents 2026 PR #16](https://github.com/Supersynergy/awesome-ai-agents-2026/pull/16) — added SandBase Harness to Agent Runtimes and Platforms; maintainer review pending
- [Awesome AI Agent Engineering PR #1](https://github.com/sspoisk/awesome-ai-agent-engineering/pull/1) — added SandBase Harness to Deployment; maintainer review pending
- [AI Native Landscape submission #18](https://github.com/rootsongjc/ai-native-landscape/issues/18) — submitted under `platform-infra` / `sandboxes-runtimes`; curator review pending
- [Agentic Community Landscape PR #2](https://github.com/agentic-community/agentic-landscape/pull/2) — added SandBase Harness under Agentic → Runtime; maintainer review pending
- [MyMCPTools directory issue #8](https://github.com/shibley/mymcptools/issues/8) — proposed the v0.3.8 MCP bridge for directory review; maintainer review pending
- [mcp.so/mcpso submission thread](https://github.com/chatmcp/mcpso/issues/1#issuecomment-5471477016) — submitted the v0.3.8 MCP bridge through the public GitHub Issue workflow; directory review pending
- [Collective AI Tools Issue #332](https://github.com/hanishrao/collective-ai-tools/issues/332) — submitted SandBase Harness separately from the existing CLI entry; directory review pending
- [Awesome Agent Skills PR #79](https://github.com/philipbankier/awesome-agent-skills/pull/79) — added SandBase Harness to MCP runtime and infrastructure; maintainer review pending
- [Awesome MCP List PR #409](https://github.com/MobinX/awesome-mcp-list/pull/409) — added SandBase Harness to AI Agents & Frameworks; maintainer review pending
- [Best-of MCP Servers issue #370](https://github.com/tolkonepiu/best-of-mcp-servers/issues/370) — proposed for the ranked MCP server list; v0.3.8 bridge and current installation metadata were supplied in a maintainer update, with inclusion/ranking still pending
- [Awesome Agent Runtimes PR #4](https://github.com/beejmaxx/awesome-agent-runtimes/pull/4) — proposed SandBase Harness for the maturity-gated watchlist; current v0.3.8 release, installation, MCP, and API evidence supplied in the [maintainer verification](https://github.com/beejmaxx/awesome-agent-runtimes/pull/4#issuecomment-5473692077); review pending
- [DeepYard submission](https://deepyard.dev/submit) — submitted to the `Frameworks & SDKs` category through the public review form; review pending and no public listing claimed
- [BotMarket MCP record](https://botmarket.bot/v1/mcp/io-github-sandbaseai-sandbase-harness) — public API reports an active record (`102971`) sourced from the official MCP Registry; manual submission queue `4` remains separately tracked
- [Awesome Agent Sandbox PR #2](https://github.com/yanmxa/awesome-agent-sandbox/pull/2) — added SandBase Harness to Related Projects; Sourcery review, GitGuardian, and mergeability checks passed, while maintainer merge remains pending ([handoff](https://github.com/yanmxa/awesome-agent-sandbox/pull/2#issuecomment-5473182863))
- [Awesome Agent Infra PR #6](https://github.com/shenli/awesome-agent-infra/pull/6) — added SandBase Harness to Runtime and Control Plane; maintainer review pending
- [Awesome CLI Coding Agents PR #314](https://github.com/bradAGI/awesome-cli-coding-agents/pull/314) — added SandBase Harness to Runtime & execution backends; maintainer review pending
- [Awesome AI Developer Stack PR #2](https://github.com/masrisystems/awesome-ai-developer-stack/pull/2) — added SandBase Harness to the MCP Servers table; maintainer review pending
- [Awesome Agent Cortex PR #74](https://github.com/0xNyk/awesome-agent-cortex/pull/74) — added SandBase Harness to Agent Runtime Infrastructure; maintainer review pending
- [Awesome Agent Harness PR #29](https://github.com/mahonzhan/awesome-agent-harness/pull/29) — added SandBase Harness to the Agent Harness timeline; PR is clean and mergeable, maintainer review pending ([verification](https://github.com/mahonzhan/awesome-agent-harness/pull/29#issuecomment-5473355320))
- [AutoJunjie Awesome Agent Harness issue #59](https://github.com/AutoJunjie/awesome-agent-harness/issues/59) — proposed SandBase Harness for Agent Runtimes; current release, API, DeepSeek example, MCP image, and backend-dependent isolation notes supplied for curator review ([verification](https://github.com/AutoJunjie/awesome-agent-harness/issues/59#issuecomment-5473368720))
- [AgentSpot submission #1](https://github.com/agentspot/agentspot-submissions/issues/1) — submitted the GitHub-source/release and GHCR MCP distribution; v0.3.8 installation, MCP, and DeepSeek evidence supplied, awaiting free directory review ([verification](https://github.com/agentspot/agentspot-submissions/issues/1#issuecomment-5473380420))
- [Awesome Loop Engineering resource suggestion #23](https://github.com/ChaoYue0307/awesome-loop-engineering/issues/23) — proposed SandBase Harness as a source-backed learning reference for sessions, tool governance, approvals, and audit/replay; maintainer curation pending ([verification](https://github.com/ChaoYue0307/awesome-loop-engineering/issues/23#issuecomment-5473407275))
- [Best of Agent Harnesses PR #99](https://github.com/RyanAlberts/best-of-Agent-Harnesses/pull/99) — submitted the v0.3.8 Harness entry to the generated ranked catalog; PR is mergeable and maintainer review pending ([verification](https://github.com/RyanAlberts/best-of-Agent-Harnesses/pull/99#issuecomment-5470293386))
- [Awesome Agent Harnesses PR #5](https://github.com/Anandesh-Sharma/awesome-agent-harnesses/pull/5) — added SandBase Harness to the coding-agent harness map; PR is clean and mergeable, CodeRabbit status is successful, and maintainer review is pending ([verification](https://github.com/Anandesh-Sharma/awesome-agent-harnesses/pull/5#issuecomment-5473341966))
- [Awesome Agentic AI 中文 Stage 7 PR #228](https://github.com/WenyuChiou/awesome-agentic-ai-zh/pull/228) — merged at `1cb0406` as the conflict-free integration for #213; trilingual entries and 1,036 script/31 targeted checks passed
- [Awesome Terminal Agents PR #5](https://github.com/EnigmaYYYY/awesome-terminal-agents/pull/5) — added SandBase Harness as an Engineering-Practice-Tool reference; maintainer review pending
- [Awesome MCP DevTools PR #13](https://github.com/Epistates/awesome-mcp-devtools/pull/13) — added SandBase Harness to Proxies and Gateways; current v0.3.8 and installation/MCP evidence supplied in the [verification comment](https://github.com/Epistates/awesome-mcp-devtools/pull/13#issuecomment-5473780943); maintainer review pending
- [Awesome MCP Collection PR #39](https://github.com/JustInCache/awesome-mcp-collection/pull/39) — added SandBase Harness to Development & Version Control; maintainer review pending
- [Awesome MCP Issue #99](https://github.com/abordage/awesome-mcp/issues/99) — requested addition to Aggregators & Gateways; maintainer review pending
- [Awesome MCP Gateways PR #77](https://github.com/e2b-dev/awesome-mcp-gateways/pull/77) — added SandBase Harness to Open-source MCP Gateways; maintainer review and CLA check pending
- [Awesome AI Harness PR #4](https://github.com/weiwei966/awesome-ai-harness/pull/4) — added SandBase Harness to SDKs & runtimes; maintainer review pending
- [Awesome AI Coding Sandboxes PR #15](https://github.com/fhiltscher/awesome-ai-coding-sandboxes/pull/15) — added SandBase Harness to Adjacent runtimes; maintainer review pending
- [Awesome Agent Infrastructure PR #23](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/23) — added SandBase Harness to Execution Sandboxes; maintainer review pending
- [Awesome Agent Sandboxing PR #2](https://github.com/IronSecCo/awesome-agent-sandboxing/pull/2) — added SandBase Harness to Self-hosted Agent Runtimes; maintainer review pending
- [Awesome Sandbox PR #27](https://github.com/restyler/awesome-sandbox/pull/27) — added a dedicated SandBase Harness runtime/sandbox guide section; maintainer review pending
- [Awesome AI Agents Security PR #107](https://github.com/ProjectRecon/awesome-ai-agents-security/pull/107) — added SandBase Harness to Sandboxing & Isolation Environments; [verification follow-up](https://github.com/ProjectRecon/awesome-ai-agents-security/pull/107#issuecomment-5473074958) posted, PR is mergeable and maintainer review pending
- [UCSB Awesome Agent Security PR #16](https://github.com/ucsb-mlsec/Awesome-Agent-Security/pull/16) — added SandBase Harness to System-level Runtime Defense; PR is mergeable and maintainer review pending
- [Awesome DevOps MCP Servers PR #327](https://github.com/rohitg00/awesome-devops-mcp-servers/pull/327) — added SandBase Harness to Code Execution; [verification follow-up](https://github.com/rohitg00/awesome-devops-mcp-servers/pull/327#issuecomment-5473090598) posted, PR is mergeable and maintainer review pending
- [EverWorks Awesome MCP Servers PR #161](https://github.com/ever-works/awesome-mcp-servers/pull/161) — added SandBase Harness to Code Execution & Automation; current installation/MCP paths and stale-link correction are in the [verification comment](https://github.com/ever-works/awesome-mcp-servers/pull/161#issuecomment-5473781279); maintainer review pending
- [AIAnytime Awesome MCP Server PR #78](https://github.com/AIAnytime/Awesome-MCP-Server/pull/78) — added SandBase Harness separately from SandBase CLI; the stale documentation path correction is in the [maintainer comment](https://github.com/AIAnytime/Awesome-MCP-Server/pull/78#issuecomment-5473797072); review pending
- [Collabnix Awesome MCP Lists PR #105](https://github.com/collabnix/awesome-mcp-lists/pull/105) — added SandBase Harness to DevOps & Infrastructure; current installation/MCP paths and stale-link correction are in the [verification comment](https://github.com/collabnix/awesome-mcp-lists/pull/105#issuecomment-5473781090); maintainer review pending
- [MCP Finder Awesome MCP Servers PR #9](https://github.com/mcp-finder/awesome-mcp-servers/pull/9) — added SandBase Harness to Cloud and DevOps; current source and backend verification is in the [maintainer comment](https://github.com/mcp-finder/awesome-mcp-servers/pull/9#issuecomment-5473796953); review pending
- [Awesome AI Agent Tools PR #27](https://github.com/michielhdoteth/awesome-ai-agent-tools/pull/27) — merged a separate SandBase Harness MCP catalog entry with Docker stdio installation metadata
- [Enterprise AI Atlas Awesome MCP Servers PR #10](https://github.com/Enterprise-AI-Atlas/awesome-mcp-servers/pull/10) — added SandBase Harness to Developer Tools with Docker stdio installation metadata; PR is mergeable and maintainer review pending
- [Awesome-MCP PR #36](https://github.com/Albertchamberlain/Awesome-MCP/pull/36) — added a structured SandBase Harness `server` entry with stdio transport; PR is mergeable and CI passed
- [Awesome-MCP PR #36 verification](https://github.com/Albertchamberlain/Awesome-MCP/pull/36#issuecomment-5473810768) — current v0.3.8, Registry, running-API, and backend boundary confirmed
- [bgizdov Awesome MCP Servers PR #17](https://github.com/bgizdov/awesome-mcp-servers/pull/17) — added a JSON contribution under DevOps with the published Docker stdio bridge; PR is mergeable and maintainer review pending
- [Awesome AI Coding Tools PR #665](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/665) — added SandBase Harness to MCP Servers and Directories; [verification follow-up](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/665#issuecomment-5473061822) posted, PR is mergeable and maintainer review pending
- [Awesome AI Developer Tools PR #11](https://github.com/ayushrajdev9-cmyk/awesome-ai-developer-tools/pull/11) — added SandBase Harness to DevOps & Deployment; PR is mergeable and maintainer review pending
- [Pipedream Awesome MCP Servers PR #111](https://github.com/PipedreamHQ/awesome-mcp-servers/pull/111) — added SandBase Harness to the Artificial Intelligence MCP server list; verification follow-up is [posted](https://github.com/PipedreamHQ/awesome-mcp-servers/pull/111#issuecomment-5473048884), PR is mergeable, maintainer review pending
- [Awesome AI & Developer Tools PR #5](https://github.com/guojianrong/awesome-ai-developer-tools/pull/5) — added SandBase Harness to CI/CD & DevOps; PR is mergeable and maintainer review pending
- [Awesome AI & Developer Tools PR #5 verification](https://github.com/guojianrong/awesome-ai-developer-tools/pull/5#issuecomment-5473810596) — current release, bridge image, scope, and backend boundary confirmed
- [LaunchApp Awesome AI Coding Tools PR #34](https://github.com/launchapp-dev/awesome-ai-coding-tools/pull/34) — added SandBase Harness to the MCP section with self-hosted and free/open-source tags; PR is mergeable and maintainer review pending
- [LaunchApp Awesome AI Coding Tools PR #34 verification](https://github.com/launchapp-dev/awesome-ai-coding-tools/pull/34#issuecomment-5473974225) — current v0.3.8, Registry/image references, and backend-dependent sandbox boundary confirmed
- [AI Agent Sandboxes PR #3](https://github.com/pjlsergeant/ai-sandboxes/pull/3) — added evidence-linked structured SandBase Harness metadata; maintainer review pending
- [Awesome Agent Sandbox PR #2](https://github.com/vivy-yi/awesome-agent-sandbox/pull/2) — added SandBase Harness to the Self-hosted / Open Source sandbox table; maintainer review pending
- [Awesome Agent Sandboxes PR #9](https://github.com/dloss/awesome-agent-sandboxes/pull/9) — added SandBase Harness to Containers; maintainer review pending
- [Awesome Agent Sandboxes PR #9 verification](https://github.com/dloss/awesome-agent-sandboxes/pull/9#issuecomment-5473974508) — current v0.3.8 sources and backend-dependent isolation confirmed
- [Awesome Agent Sandbox PR #4](https://github.com/fishman/awesome-agent-sandbox/pull/4) — added SandBase Harness to Container Sandboxes and the comparison table; maintainer review pending
- [Awesome Agent Sandboxes PR #59](https://github.com/msyvr/awesome-agent-sandboxes/pull/59) — added structured SandBase Harness sandbox metadata and regenerated catalog outputs; maintainer review pending
- [MeshKore directory submission](https://meshkore.com/directory) — accepted for review as submission #15; public profile pending
- [Awesome Agentic Open-Source Tools PR #1](https://github.com/samaybhavsar/awesome-agentic-opensource-tools/pull/1) — added to Agent Frameworks & Orchestration; maintainer review pending
- [awesome-ai-agents-2026 PR #2](https://github.com/Dehar624/awesome-ai-agents-2026/pull/2) — added to Local Runtimes & LLM Management; maintainer review pending
- [AgentFirst directory PR #46](https://github.com/bradvin/agentfirst.directory/pull/46) — added to Compute & Sandboxes; enrichment check passed, maintainer review pending
- [AI Agent Tools submission](https://aiagenttools.dev/submit) — accepted as open-source infrastructure submission `mtgu4e78fw1ja`; directory review pending
- [AgentVerse-5K PR #3](https://github.com/mrahm65/AgentVerse-5K/pull/3) — added SandBase Harness to Coding Agents and MCP Servers; PR is clean and mergeable, maintainer review pending
- [AI Agent Marketplace PR #36](https://github.com/aiagenta2z/ai-agent-marketplace/pull/36) — added SandBase Harness to the marketplace `AGENT.md` using official installation, MCP, deployment, and issue links; maintainer review pending
- [Awesome AI Agents PR #4](https://github.com/asdfgh12345123/awesome-ai-agents/pull/4) — added SandBase Harness to Agent Tools with a canonical repository link and factual runtime description; maintainer review pending
- [中文 Awesome AI Agents PR #13](https://github.com/Uky0Yang/awesome-ai-agents-zh/pull/13) — added SandBase Harness to MCP 生态 with generated catalog data and passing validation; maintainer review pending
- [MCP Server Finder evaluation issue #4](https://github.com/ModelContextProtocol-Security/mcpserver-finder/issues/4) — requested an independent quality and security assessment of the MCP bridge; review pending
- [Agentic DevOps MCP PR #42](https://github.com/agenticdevops/awesome-devops-mcp/pull/42) — added to Kubernetes & Containers; maintainer review pending
- [Awesome DevOps AI PR #54](https://github.com/hammadhaqqani/awesome-devops-ai/pull/54) — added to MCP Servers for DevOps; maintainer review pending
- [Awesome Platform Engineering PR #63](https://github.com/shospodarets/awesome-platform-engineering/pull/63) — added to Internal Developer Platforms; maintainer review pending
- [Awesome DevOps Platform PR #4](https://github.com/tysoncung/awesome-devops-platform/pull/4) — added to AI & Automation in DevOps; maintainer review pending
- [Awesome Platform Engineering PR #11](https://github.com/ShakedBraimok/awesome-platform-engineering/pull/11) — added to AI Platform Engineering & LLMOps; maintainer review pending
- [Awesome LLMOps PR #539](https://github.com/InftyAI/Awesome-LLMOps/pull/539) — generated from project request #538 under Runtime / AI Agent; build passed, maintainer review pending
- [TensorChord Awesome LLMOps PR #785](https://github.com/tensorchord/Awesome-LLMOps/pull/785) — added SandBase Harness to the LLMOps catalog; DCO now passes and maintainer review is pending
- [Awesome-LLMSecOps PR #66](https://github.com/wearetyomsmnv/Awesome-LLMSecOps/pull/66) — added a source-linked SandBase Harness entry under Agentic security; PR is clean and mergeable, maintainer review pending
- [Awesome Agent Runtime Security PR #30](https://github.com/bureado/awesome-agent-runtime-security/pull/30) — added SandBase Harness to Sandboxing & Isolation with explicit deployment/backend limits; PR is clean and mergeable, maintainer review pending
- [Awesome LLM Security PR #313](https://github.com/corca-ai/awesome-llm-security/pull/313) — added SandBase Harness to Tools as a runtime-governance reference; PR is clean and mergeable, maintainer review pending
- [Awesome AI Agents PR #467](https://github.com/jim-schwoebel/awesome_ai_agents/pull/467) — existing single-line SandBase Harness entry in the AI-agent resources list; PR is clean and mergeable, maintainer review pending
- [Jenqyang Awesome AI Agents PR #460](https://github.com/Jenqyang/Awesome-AI-Agents/pull/460) — added SandBase Harness to Applications → Tools under the repository's OSS and neutral-description rules; PR is clean and mergeable, maintainer review pending
- [Slava Awesome AI Agents PR #403](https://github.com/slavakurilyak/awesome-ai-agents/pull/403) — existing SandBase Harness entry in the AI Agents list; PR is clean and mergeable, maintainer review pending
- [Scottcjn Awesome Agents PR #59](https://github.com/Scottcjn/awesome-agents/pull/59) — existing SandBase Harness entry in an Agent platforms/frameworks directory; PR is clean and mergeable, maintainer review pending
- [Awesome Agent Infrastructure PR #21](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/21) — added to Execution Sandboxes; entry refreshed to the current MCP installation guide, maintainer review pending
- [Awesome DevOps PR #30](https://github.com/nirgeier/awesome-devops/pull/30) — added SandBase Harness to the MCP tools catalog; DCO passed, maintainer review pending
- [Awesome Self-Hosted Agents PR #6](https://github.com/arcane-bear/awesome-self-hosted-agents/pull/6) — added SandBase Harness to the self-hosted agent frameworks list; PR is clean and maintainer review pending
- [Awesome Agent Infra PR #2](https://github.com/jovial-liu/awesome-agent-infra/pull/2) — added SandBase Harness to the machine-readable runtime catalog; validation, tests, and lint pass, maintainer review pending
- [Awesome AI Agents PR #1](https://github.com/tioraicom/awesome-ai-agents/pull/1) — added SandBase Harness to Agent infrastructure; PR is clean and maintainer review pending
- [Awesome Agent Operating Systems PR #13](https://github.com/frankxai/awesome-agent-operating-systems/pull/13) — merged SandBase Harness into Agent Runtimes with a dated verification link
- [Awesome Agent Services PR #8](https://github.com/farol-team/awesome-agent-services/pull/8) — added SandBase Harness to Sandboxes & Compute; PR is clean and maintainer review pending
- [Awesome AI Automation PR #3](https://github.com/minhazda/awesome-ai-automation/pull/3) — added SandBase Harness to AI agents & LLM automation; PR is clean and maintainer review pending
- [Awesome Best Open Source AI Agents 2026 PR #1](https://github.com/GagnDeep/awesome-best-open-source-ai-agents-2026/pull/1) — added a GitHub-verified runtime entry with license, language, Stars, activity, and Best-for metadata; PR is clean and maintainer review pending
- [Awesome AI Agents — Agent Playbook PR #1](https://github.com/agentplaybook-io/awesome-ai-agents/pull/1) — added SandBase Harness to the self-hosted frameworks list; PR is clean and maintainer review pending
- [Discussion #116](https://github.com/sandbaseai/sandbase-harness/discussions/116) — official DevOps runtime and MCP bridge discovery post
- [DeepSeek Harness Showcase update](https://github.com/deepseek-ai/deepseek-harness/discussions/1918#discussioncomment-18212204) — bilingual update covering the gVisor integration path and corrected Hugging Face attribution review
- [Cline MCP Marketplace issue #2364](https://github.com/cline/mcp-marketplace/issues/2364) — v0.3.8 MCP bridge submission under review; see the [maintainer verification note](https://github.com/cline/mcp-marketplace/issues/2364#issuecomment-5473147267) and [official bilingual update](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212395)
- [MCPSo submission issue #3834](https://github.com/chatmcp/mcpso/issues/3834)
- [Awesome Agent Frameworks architecture proposal #6](https://github.com/subinium/awesome-agent-frameworks/issues/6)
- [Agent Sandbox Taxonomy profile proposal #5](https://github.com/kajogo777/the-agent-sandbox-taxonomy/issues/5)
- [Open-Kairox Awesome Agent Harnesses Issue #1](https://github.com/open-kairox/awesome-agent-harnesses/issues/1) — suggested for the bilingual Agent Harness list; maintainer verification covers v0.3.8, installation/MCP, runtime controls, and backend-dependent isolation ([verification](https://github.com/open-kairox/awesome-agent-harnesses/issues/1#issuecomment-5473624141))
- [Awesome Agent Sandboxes PR #9](https://github.com/arjan/awesome-agent-sandboxes/pull/9)
- [Mossaka Awesome Agent Sandboxes PR #1](https://github.com/Mossaka/awesome-agent-sandboxes/pull/1)
- [Yenanjing Awesome Harness Engineering PR #6](https://github.com/yenanjing/awesome-harness-engineering/pull/6)
- [Awesome Harness Engineering 中文版 PR #6](https://github.com/whobot-ai/awesome-harness-engineering-zh/pull/6)
- [Awesome Agent Architecture issue #90](https://github.com/hardness1020/awesome-agent-architecture/issues/90) — proposed as a source-backed system under study, with architecture/runtime evidence and maintainer verification ([verification](https://github.com/hardness1020/awesome-agent-architecture/issues/90#issuecomment-5473624085))
- [AgentIndex issue #3](https://github.com/agentidx/agentindex/issues/3) — proposed a source-backed runtime index entry; maintainer verification covers v0.3.8, installation/MCP, session governance, audit/replay, and backend-dependent isolation ([verification](https://github.com/agentidx/agentindex/issues/3#issuecomment-5473643330))
- [Agent Harness MCP preset issue #47](https://github.com/madebywild/agent-harness/issues/47) — proposed a source-backed MCP preset using the published bridge image and six tools; maintainer review is pending ([verification](https://github.com/madebywild/agent-harness/issues/47#issuecomment-5473643364))
- [dsh-index PR #43](https://github.com/Sunrisepeak/dsh-index/pull/43) — proposed the current SandBase Harness descriptor; checks passed at submission but the PR currently needs a rebase
- [Discussion #116 update](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212016) — v0.3.8 安装与已合并集成状态（中文更新）；欢迎用户反馈
- [Discussion #116 latest update](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18212677) — announced the merged Awesome Coding Agents listing and reiterated the current installation source plus the TensorBlock metadata caveat
- [Discussion #116 promotion update](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213014) — bilingual checkpoint for the DeepYard review submission and BotMarket manual-review queue
- [Discussion #116 BotMarket status correction](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213051) — records the active Registry-sourced BotMarket MCP entry and separates it from manual queue `4`
- [Discussion #116 TensorBlock update](https://github.com/sandbaseai/sandbase-harness/discussions/116#discussioncomment-18213205) — announces the merged TensorBlock MCP entry and public profile with the current v0.3.8 bridge reference
- [AAE Agent Engineering issue #1](https://github.com/Lxcardoza993/AAE/issues/1) — proposed for the curated Agent Harness category; curator review pending
- [HKUST-KnowComp Awesome Agent Harness issue #8](https://github.com/HKUST-KnowComp/Awesome-Agent-Harness/issues/8) — proposed as a source-linked runtime resource; current v0.3.8 evidence and backend-dependent isolation scope were supplied for curator review
- [Picrew Awesome Agent Harness issue #82](https://github.com/Picrew/awesome-agent-harness/issues/82) — handbook entry prepared in commit `ddbf183`; waiting for the maintainer to apply it because the available fork has unrelated history
- [Awesome AI Engineering PR #4](https://github.com/Eric-LLMs/awesome-ai-engineering/pull/4) — merged at `0a308b0`, adding SandBase Harness to the open-source agent-engineering project table
- [TensorBlock Awesome MCP Servers PR #2060](https://github.com/TensorBlock/awesome-mcp-servers/pull/2060) — merged at `c88cedf`; the current v0.3.8 bridge entry is now available through the [TensorBlock profile](https://tensorblock.co/mcp/servers/github-sandbaseai-sandbase-harness-7a5986ca)
- [MCPVault submission](https://mcpvault.io/submit) — public submit flow requires GitHub sign-in; normal submission returned `401 not_signed_in`, so no listing is claimed
- [Awesome Agentic MCP Security PR #28](https://github.com/mcp-security-project/awesome-agentic-mcp-security/pull/28) — MCP hosting/runtime entry with v0.3.8 verification; GitHub reports `UNSTABLE`
- [RoyalPinto Awesome MCP Security PR #4](https://github.com/royalpinto007/awesome-mcp-security/pull/4) — permission-category entry with v0.3.8 and backend-boundary verification; maintainer review pending
- [Awesome AI Developer Tools PR #11](https://github.com/ayushrajdev9-cmyk/awesome-ai-developer-tools/pull/11) — DevOps & Deployment entry with current Registry/GHCR and v0.3.8 verification; maintainer review pending
- [LAS-WG Awesome Agent Infrastructure PR #10](https://github.com/las-wg/awesome-agent-infrastructure/pull/10) — Open-Source Projects entry with v0.3.8 and backend-boundary verification; maintainer review pending
- [Awesome Agent Skills PR #79](https://github.com/philipbankier/awesome-agent-skills/pull/79) — MCP runtime/infrastructure entry with v0.3.8 verification; GitHub reports `UNSTABLE`
- [Awesome MCP List PR #409](https://github.com/MobinX/awesome-mcp-list/pull/409) — AI Agents & Frameworks entry with v0.3.8 and backend-boundary verification; maintainer review pending
- [Awesome Agent Sandboxes PR #59](https://github.com/msyvr/awesome-agent-sandboxes/pull/59) — generated sandbox catalog entry with refreshed outputs and non-universal isolation scope; maintainer review pending
- [Awesome Agent Sandbox PR #2](https://github.com/vivy-yi/awesome-agent-sandbox/pull/2) — self-hosted sandbox entry with v0.3.8 source verification; maintainer review pending
- [Awesome Agent Sandbox PR #4](https://github.com/fishman/awesome-agent-sandbox/pull/4) — container sandbox entry with backend-dependent isolation verification; maintainer review pending
- [Awesome CLI Coding Agents PR #314](https://github.com/bradAGI/awesome-cli-coding-agents/pull/314) — Runtime & execution backends entry with v0.3.8 source verification; maintainer review pending
- [Awesome Terminal Agents PR #5](https://github.com/EnigmaYYYY/awesome-terminal-agents/pull/5) — Engineering-Practice-Tool runtime reference with v0.3.8 verification; maintainer review pending
- [Awesome AI Agents 2026 PR #16](https://github.com/Supersynergy/awesome-ai-agents-2026/pull/16) — agent runtimes/platforms entry with v0.3.8 and backend-boundary verification; maintainer review pending
- [Awesome Agent Infra PR #6](https://github.com/shenli/awesome-agent-infra/pull/6) — Runtime and Control Plane entry with v0.3.8 source verification; GitHub reports `UNSTABLE`, maintainer review pending
- [Curated MCP Servers PR #9](https://github.com/oxbshw/curated_mcp_servers/pull/9) — Developer Tools & Infrastructure entry with v0.3.8 source verification; maintainer review pending
- [Awesome Agent Runtimes PR #1](https://github.com/dz3ai/awesome-agent-runtimes/pull/1) — runtime comparison entry with v0.3.8 and backend-boundary verification; maintainer review pending
- [AI Agent Infrastructure List PR #4](https://github.com/chgaowei/ai-agent-infra-list/pull/4) — English/Chinese runtime entries with current v0.3.8 evidence; verification posted, maintainer review pending
- [Skyming Awesome AI Agent PR #19](https://github.com/skyming/awesome-ai-agent/pull/19) — concise Chinese runtime entry with v0.3.8 source verification; maintainer review pending
- [Awesome Agent Harness PR #58](https://github.com/AutoJunjie/awesome-agent-harness/pull/58) — Agent Runtimes entry with maintainer disclosure and verification; maintainer review pending
- [Awesome Agent Security PR #10](https://github.com/authora-dev/awesome-agent-security/pull/10) — Sandboxed Execution entry with explicit non-certification scope; maintainer review pending
- [DevInsight Awesome MCP PR #6](https://github.com/devinsightdotio/awesome_mcp/pull/6) — MCP Servers entry with current v0.3.8 and backend-boundary verification; maintainer review pending

These listings are independent directories; the repository and its release metadata
remain the source of truth.

### Try it in Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sandbaseai/sandbase-harness?quickstart=1)

The included development container installs dependencies and builds the runtime.
When the terminal is ready, start the server on the forwarded port:

```bash
node dist/index.js start --host 0.0.0.0
```

Open the forwarded **SandBase Harness Console** port, then configure a model in
**Settings > Models**. Codespaces usage may be billed by GitHub; the local
quick start below remains free and keeps all runtime data on your machine.

## Why

Agent SDKs handle the model loop. Production agents need more: persistent
sessions, tool governance, sandbox boundaries, credential handling, memory,
auditability, and a UI for humans to inspect what happened. `managed-agents`
is that runtime layer — not a visual workflow builder and not another model SDK.

## Features

- Claude Managed Agents-style `/v1` API and local Console
- SQLite-backed agents, sessions, environments, credential vaults, memory
  stores, files, skills, and API keys — SQLite metadata by default
- local file/skill bytes stored in the workspace state directory
- Resumable Server-Sent Events for session replay and debugging
- One active model provider boundary configured through Settings V2
- Sandbox backends: local process, Docker (per-session containers), Kubernetes
  (kubectl exec/cp), self-hosted worker queue
- Settings V2: one workspace model vendor, loop engine, storage, memory,
  sandbox — with validation, form/JSON modes, and restart flow
- MCP toolsets, permission policies, built-in tools, and skill packages
- DeepSeek Harness bridge over MCP stdio for agents, sessions, streamed turns,
  artifacts, and cancellation
- TypeScript SDK at `managed-agents/sdk`
- Release gate: `npm run release:check`

## Screenshots

| Console overview | Settings | API reference |
| --- | --- | --- |
| ![overview](docs/assets/dashboard-overview.png) | ![settings](docs/assets/dashboard-settings-models.png) | ![api-ref](docs/assets/dashboard-api-reference.png) |

## Start with a use case

See the [Showcase](docs/showcase.md) for three practical paths: an auditable
coding agent, DeepSeek Harness as an interactive front end, and controlled code
execution across Local, Docker, Kubernetes, and self-hosted sandboxes.

For client-specific setup, see the [installation guide](llms-install.md),
including the pinned Cline CLI command and the Docker MCP Bridge configuration.

Community use-case discussions:

- [Memory migration between Codex, Claude Code, and DSH](https://github.com/deepseek-ai/deepseek-harness/discussions/14#discussioncomment-18202967)
- [Sandbox and filesystem protection for third-party plugins](https://github.com/deepseek-ai/deepseek-harness/discussions/5068#discussioncomment-18202943)

## Requirements

- Node.js 22+
- npm 10+
- A model provider API key (OpenAI, Anthropic, MiniMax, or an OpenAI-compatible endpoint)
- Docker (optional, for Docker-backed sandboxes)

## DeepSeek Harness

Run this project as a DSH plugin instead of treating `dsh-plugin` as discovery
metadata only. Install the bundle into a DSH profile, start `managed-agents`,
then boot that profile:

```bash
export MANAGED_AGENTS_URL=http://127.0.0.1:3000
# Preferred: install a local source checkout after `npm run build`.
dsh plugin --profile web add -w ../sandbase-harness
# Git URL fallback. Keep HTTPS; do not convert the spec to SSH.
# dsh plugin --profile web add git+https://github.com/sandbaseai/sandbase-harness.git
dsh web
```

If Plugin Hub reports `already installed: managed-agents` after a partial or
repeated install, update the Hub first, then remove only the displayed
`managed-agents` plugin entry and retry from the tagged HTTPS Git source:

```bash
dsh plugin --profile web update dsh-plugin
dsh plugin --profile web remove managed-agents
dsh plugin --profile web add git+https://github.com/sandbaseai/sandbase-harness.git
```

This is a Plugin Hub duplicate-install path, not an npm installation path. If
the installed view shows a different target identifier, remove that exact
identifier instead. Keep the profile directory and its evidence until the
runtime starts successfully; see [the reported recovery issue](https://github.com/sandbaseai/sandbase-harness/issues/78).

The profile installs the verified source checkout directly; it does not resolve
the unrelated unscoped npm package. A git-hosted install runs `prepare` only
when `dist/` is missing. Keep the HTTPS git spec; converting it to SSH fails on
Windows hosts without GitHub SSH access.

A git-hosted install needs one extra step for pnpm's build allowlist. The
first `dsh plugin --profile web add` fails with
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the exact key. Add that key
under `allowBuilds:` in the profile's `pnpm-workspace.yaml`, then re-run the
same add command; a plain package name does not match a git-hosted
resolution:

```yaml
allowBuilds:
  "managed-agents@https://codeload.github.com/sandbaseai/sandbase-harness/tar.gz/<commit>": true
```

The second run builds `dist/` through `prepare`, creates the
`managed-agents` / `managed-agents-mcp` bins, and joins the bundle layer. The
patch starts the bundled MCP entry over
stdio. DSH can then list agents,
create and run sessions, inspect results and artifacts, and stop work through
native `mcp__sandbase__*` tools. See
[`examples/deepseek-harness`](examples/deepseek-harness/README.md) for the full
tool list and authenticated-runtime configuration.

For a walkthrough that starts with DSH and adds this runtime as a real
third-party plugin, read the
[DeepSeek Harness developer guide](https://blog.sandbase.ai/deepseek-harness-developer-preview-2026/#add-a-real-third-party-runtime-plugin).
The [Chinese edition](https://blog.sandbase.ai/zh-CN/deepseek-harness-developer-preview-2026/#接入一个真实的第三方-runtime-插件)
is available as well; both articles are maintained against the pinned
SandBase Harness v0.3.8 integration.

Pair the plugin with SandBase Skills to give the same DSH project a portable,
source-verifiable research workflow:

```bash
npx --yes github:sandbaseai/sandbase-skills add multi-source-search
dsh web
```

This installs the complete Skill into `.dsh/skills/multi-source-search`, DSH's
project-scoped discovery directory. It runs from GitHub source and needs no
SandBase account when DSH already provides web/search tools.

For a complete, reproducible workflow that combines the evidence ledger with
sandboxed execution, credentials, audit, and replay, read
[Build an Auditable Research Agent](https://blog.sandbase.ai/auditable-research-agent-evidence-ledger-sandbox-replay/).

New to DSH profiles, plugin composition, tool policy, or session semantics? The
independent [DeepSeek Harness Handbook](https://github.com/sandbaseai/deepseek-harness-handbook)
provides source-backed quickstarts, architecture maps, and troubleshooting for
the runtime layers used by this integration. Read its [SandBase Harness bridge
guide](https://sandbaseai.github.io/deepseek-harness-handbook/sandbase-harness-bridge.html)
for the DSH-specific contract, then start with the local-browser
[Install Doctor](https://sandbaseai.github.io/deepseek-harness-handbook/install-doctor.html)
for installation evidence, or use the
[Failure Router](https://sandbaseai.github.io/deepseek-harness-handbook/diagnose.html)
to identify the first broken runtime boundary.

## Quick Start

```bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

Open `http://127.0.0.1:3000/dashboard`, go to **Settings > Models**, paste your
API key, and you're running.

The unscoped `managed-agents` name on npm is not this project. Until an
official scoped package is announced in this repository, install only from the
tagged GitHub source release shown above. Do not run `npx managed-agents` or
`npm install managed-agents`.

The six-tool MCP bridge is published as a multi-architecture OCI image. Start
the Harness API, then add this stdio command to an MCP client:

Container package: [GitHub Container Registry](https://github.com/orgs/sandbaseai/packages/container/package/sandbase-harness-mcp)

```bash
docker pull ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8
docker run --rm -i \
  -e MANAGED_AGENTS_URL=http://host.docker.internal:3000 \
  ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8
```

For an authenticated remote runtime, also pass `MANAGED_AGENTS_API_KEY`. The
container image contains only the MCP bridge; agent sessions and sandbox work
remain in the connected Harness runtime. Every release image is built from the
matching Git tag for `linux/amd64` and `linux/arm64`, includes OCI source and
MCP ownership metadata, and receives a GitHub build-provenance attestation.

### Portable Agent Plugin

Copilot CLI, VS Code, and other Agent Plugins 1.0 clients can install the same
OCI-backed MCP bridge directly from this repository. Start the Harness API and
Docker first, then expose its URL to the plugin process:

```bash
export MANAGED_AGENTS_URL=http://host.docker.internal:3000
# Optional when the runtime requires authentication:
export MANAGED_AGENTS_API_KEY=your-runtime-key

copilot plugin install sandbaseai/sandbase-harness:agent-plugin
```

The plugin passes these environment variables through to the pinned
`ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8` image. It does not store a key
in `plugin.json`, `mcp.json`, or the installed plugin files. On Linux, the
plugin's Docker command maps `host.docker.internal` through `host-gateway`.

For development from the latest `main` branch:

```bash
git clone https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness && npm ci && npm run build
cd .. && mkdir my-agents-dev && cd my-agents-dev
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

## Workspace Layout

```text
my-agents/
├── agents/                  # Seed agent definitions (YAML)
│   └── assistant.yaml
├── skills/                  # Seed skill packages
│   └── example-skill/
│       └── SKILL.md
└── .managed-agents/         # Runtime state (gitignored)
    ├── config.yaml          # Workspace configuration
    ├── data.db              # SQLite metadata
    ├── logs/runtime.log
    ├── files/               # Uploaded file bytes
    ├── skills/              # Uploaded skill packages
    ├── snapshots/           # Session workspace snapshots
    └── sandbox/             # Local session sandboxes
```

## Configuration

`.managed-agents/config.yaml`:

```yaml
model:
  provider: openai
  api_key: ${OPENAI_API_KEY}

storage:
  metadata: { provider: sqlite, options: {} }
  artifacts: { provider: local, options: { base_path: files } }
```

Agents pick concrete model IDs (`gpt-4o`, `claude-sonnet-4-20250514`,
`openai/gpt-5.5`). The workspace config only says how to reach the model
service.

For DeepSeek V4 Pro/Flash configuration, including maximum reasoning effort,
see [DeepSeek V4](docs/deepseek-v4.md).

For first-class MiniMax configuration, regional endpoints, and the supported
MiniMax-M3 and MiniMax-M2.7 model IDs, see [MiniMax](docs/minimax.md).

## CLI

```bash
managed-agents init
managed-agents start [--host 127.0.0.1] [--port 3000]
managed-agents list
managed-agents reload
managed-agents chat <agent-id> --message "hello"
managed-agents template list | install <name> | create <name>
```

## API Examples

Create an agent:

```bash
curl -X POST http://127.0.0.1:3000/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Incident commander",
    "model": "gpt-4o",
    "system": "You are an on-call incident commander.",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }'
```

Create an environment (local sandbox):

```bash
curl -X POST http://127.0.0.1:3000/v1/environments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Default local",
    "config": { "hosting_type": "local", "sandbox_provider": "local" }
  }'
```

Create a Docker-isolated environment:

```bash
curl -X POST http://127.0.0.1:3000/v1/environments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Docker sandbox",
    "config": {
      "sandbox_provider": "docker",
      "image": "node:22-slim",
      "resources": { "memory": "1g", "cpu": 1 }
    }
  }'
```

Start a session:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent_...",
    "environment_id": "env_...",
    "title": "Triage SENTRY-123"
  }'
```

Send a message:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{ "content": "Investigate the alert." }'
```

Resume the event stream:

```bash
curl -N http://127.0.0.1:3000/v1/sessions/SESSION_ID/events/stream \
  -H "Last-Event-ID: 42"
```

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

The `/v1` API follows Claude Managed Agents resource shapes, so you can also
point the Anthropic SDK at the local runtime:

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

## Authentication

Open by default. Authentication activates when at least one API key exists:

```bash
# Static key via environment
export MANAGED_AGENTS_API_KEY=sk-local-example

# Or create a managed key
curl -X POST http://127.0.0.1:3000/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "Local Console" }'
```

Clients send `Authorization: Bearer <key>`.

## Agent Definition

Agents are YAML files in `agents/`:

```yaml
name: Incident commander
description: Triages alerts and coordinates response.
model: gpt-4o
system: |-
  You are an on-call incident commander.
mcp_servers:
  - name: sentry
    type: url
    url: https://mcp.sentry.dev/mcp
tools:
  - type: agent_toolset_20260401
    default_config:
      permission_policy: { type: always_ask }
    configs:
      - name: bash
        permission_policy: { type: always_ask }
  - type: mcp_toolset
    mcp_server_name: sentry
skills:
  - type: custom
    skill_id: skill_...
metadata:
  template: incident-commander
```

## Development

```bash
npm ci
npm run typecheck    # src + tests
npm test             # vitest
npm run build        # runtime + console + SDK
npm run release:check  # full local release gate
```

`release:check` runs typecheck, tests, both builds, `npm pack --dry-run`, CLI
init smoke, and `examples/basic` startup smoke.

## SandBase Ecosystem

- [SandBase Skills](https://github.com/sandbaseai/sandbase-skills) — 88 installable
  Agent Skills for research, social intelligence, marketing, and business
  workflows across Codex, Claude Code, Cursor, Gemini CLI, and other clients.
- [SandBase CLI](https://github.com/sandbaseai/cli) — connect Cursor, Claude Code,
  Codex, Windsurf, Gemini CLI, OpenCode, and other MCP clients to 2,000+ AI
  models and APIs with one onboarding command.
- [DSH Plugin Store](https://github.com/sandbaseai/dsh-plugin-store) — discover,
  filter, install, and manage community DeepSeek Harness plugins from the native
  Settings experience.
- [SandBase](https://www.sandbase.ai) — hosted agent infrastructure, model access,
  tools, and managed sandboxes.

## Documentation

- [Machine-readable project metadata](llms.txt)
- [Agent / MCP installation guide](llms-install.md)
- [Installation](docs/installation.md)
- [Usage Guide](docs/usage.md)
- [API Reference](docs/api.md)
- [Skills](docs/skills.md)
- [Deployment](docs/deployment.md)
- [Architecture](docs/spec/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Citation metadata](CITATION.cff)
- [Promotion status](docs/promotion.md)
- [Promotion outreach templates](docs/promotion-outreach.md)
- [Changelog](CHANGELOG.md)

## Community Guides

- [Build an Auditable Research Agent](https://blog.sandbase.ai/auditable-research-agent-evidence-ledger-sandbox-replay/)
  — a reproducible guide combining evidence ledgers, sandboxed execution,
  credentials, audit, and replay with SandBase Harness.
- [Self-host the SandBase agent runtime](https://www.ssdnodes.com/learn/self-host-sandbase-agent-runtime)
  by SSD Nodes — an independent VPS walkthrough covering installation, agent
  configuration, MCP servers, sandbox modes, and reverse-proxy deployment. The
  article demonstrates v0.3.2; use the current release command above for v0.3.8.

## License

[Apache-2.0](LICENSE)
