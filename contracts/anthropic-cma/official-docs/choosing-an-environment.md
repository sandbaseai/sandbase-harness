---
title: Choosing an agent environment
url: https://platform.claude.com/docs/en/managed-agents/choosing-an-environment
description: Decide whether Claude Managed Agents tools and code run in an Anthropic-managed cloud environment or a self-hosted sandbox, and see what changes if you switch.
featureMetadata:
  topic:
    title: Managed Agents
    url: https://platform.claude.com/docs/en/managed-agents/overview
  status: beta
  betaHeader: managed-agents-2026-04-01
  zdr:
    eligibility: not-eligible
    note: Sessions are stateful resources; transcripts persist until you delete them. Applies to all Managed Agents sub-features, including Self-hosted sandboxes.
  supportedModels:
    - claude-fable-5-1
    - claude-mythos-5-1
    - claude-fable-5
    - claude-mythos-5
    - claude-mythos-preview
    - claude-opus-5-5
    - claude-opus-5
    - claude-sonnet-5-5
    - claude-sonnet-5
    - claude-haiku-5-5
    - claude-haiku-4-5-20251001
    - claude-opus-4-8
    - claude-opus-4-7
    - claude-opus-4-6
    - claude-sonnet-4-6
    - claude-opus-4-5-20251101
    - claude-sonnet-4-5-20250929
  supportedPlatforms:
    Claude API: beta
    Claude Platform on AWS: beta
    Claude Models on Google Cloud (Anthropic managed): beta
---

An environment sets where your agent’s tools and code run. They run in a sandbox. A sandbox is an isolated workspace, such as a container, where the agent runs commands and works on files. You have two options:

* **Cloud environment:** Anthropic runs the sandbox for you. Each session gets its own fresh Linux container on Anthropic-managed infrastructure, with common languages, databases, and utilities already installed. You choose its network rules and any extra packages to install.
* **Self-hosted sandbox:** You run the sandbox on your own infrastructure. Claude still runs on Anthropic’s side and determines which tool to call next. A program that you run, called a worker, carries out the agent’s bash and file tool calls on your machines and sends each result back. It can also serve custom tools.

The agent definition is the same whichever you choose. You set the model, prompt, and tools on the [agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), not on the environment.

## Start with a cloud environment

If you’re not sure which to choose, or you’re new to Claude Managed Agents, start with a [cloud environment](https://platform.claude.com/docs/en/managed-agents/environments), as the [quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart) does. Anthropic runs an isolated container for each session, with common languages and tools already installed, so there is nothing for you to host. Choose a self-hosted sandbox only if tools must run on infrastructure you control.

## Compare the options

The table compares the two options.

|                                     | [Cloud environment](https://platform.claude.com/docs/en/managed-agents/environments) (default)                                                                                                                                                                           | [Self-hosted sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Where tools and code run            | An Anthropic-managed sandbox                                                                                                                                                                                                                                             | Your worker, on your infrastructure                                                                                       |
| What reaches Anthropic              | The [conversation history](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#list-past-events), [tool results](https://platform.claude.com/docs/en/managed-agents/tools#available-tools), the sandbox’s files and state, skills, and memory stores | The conversation history, tool results, skills, and memory stores. The sandbox’s files and processes stay on your worker. |
| What you operate                    | Nothing                                                                                                                                                                                                                                                                  | The worker hosts, their hardening, their network limits, and the environment key your worker authenticates with           |
| Network reach                       | Network rules you set on the environment                                                                                                                                                                                                                                 | Your own network policy                                                                                                   |
| File and GitHub repository mounting | Managed by Anthropic                                                                                                                                                                                                                                                     | Managed by you                                                                                                            |
| Memory stores                       | Mounted by Anthropic at `/mnt/memory/`                                                                                                                                                                                                                                   | Downloaded to `/mnt/memory/` and synced by the worker                                                                     |
| Sandbox lifecycle                   | Managed by Anthropic                                                                                                                                                                                                                                                     | Managed by you                                                                                                            |
| Choose it when                      | The default. You don’t need tools to run on your own infrastructure.                                                                                                                                                                                                     | Tools must run on infrastructure you control.                                                                             |

## When to choose a self-hosted sandbox

A self-hosted sandbox fits when the agent needs to do one of the following:

* **Work on data that can’t leave your network:** The agent’s files and processes stay on your worker. What a tool returns to the model still reaches the Managed Agents service.
* **Reach internal services that aren’t publicly routable:** The agent’s bash and file tools, and any custom tools your worker serves, run inside your network. Anthropic, not your worker, connects to the agent’s MCP servers. A private one might be in front of your internal ticket system or company wiki. To reach it, you can use an [MCP tunnel](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview) with either option. MCP tunnels are in research preview and need an access request. See [Self-hosted sandboxes and MCP tunnels](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#self-hosted-sandboxes-and-mcp-tunnels).
* **Run under your organization’s own compliance and audit controls:** Tools run on hosts that you configure, log, and audit.

## What a self-hosted sandbox doesn’t change

With either option, the conversation history and tool results go to the Managed Agents service, which Anthropic operates. That is how the model receives the result of each tool call. The web search and web fetch tools also run on Anthropic’s side, not in the sandbox. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions). Neither option changes the compliance coverage of Managed Agents or how long it keeps conversation history. See [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#feature-eligibility).

## What you take on and give up with a self-hosted sandbox

A self-hosted sandbox makes you the operator of the worker hosts. You harden the sandbox image, control network egress, store and rotate the environment key, and isolate sessions from each other. The [Security model](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security) page has the detail.

You also give up these cloud environment features:

* [`file` and `github_repository` session resources](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#session-resources). You [stage input files yourself](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#stage-files-for-a-session), and you are responsible for mounting your own GitHub repository too.
* [Repository skill discovery](https://platform.claude.com/docs/en/managed-agents/skills#load-skills-from-a-github-repository).
* [Environment variable credentials](https://platform.claude.com/docs/en/managed-agents/vaults#add-a-credential) in vaults.
* The [pre-installed runtimes and packages](https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference) of a cloud sandbox. A self-hosted sandbox has whatever your worker provides.

## Differences on Claude Platform on AWS

If you use Claude Managed Agents through Claude Platform on AWS, Anthropic still operates the service. There, a self-hosted sandbox can’t use memory stores, workers don’t use an environment key, and MCP tunnels aren’t available. See [Claude Managed Agents on Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws#claude-managed-agents) and [Features not supported](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws#features-not-supported).

## Differences on Claude Models on Google Cloud (Anthropic managed)

If you use Claude Managed Agents through Claude Models on Google Cloud (Anthropic managed), Anthropic still operates the service. There, memory stores aren’t supported in a self-hosted sandbox, and MCP tunnels aren’t available. Workers authenticate with Google Cloud credentials, not an environment key, and you write your own, because the pre-built workers in the `ant` CLI and the Python, TypeScript, and Go SDKs don’t work there. See [Feature support](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed#feature-support) in the Claude Models on Google Cloud (Anthropic managed) guide.

## Switch from a cloud environment to a self-hosted sandbox

To switch to a self-hosted sandbox, you keep the agent, create a `self_hosted` environment, and reference its ID in new sessions and deployments.

* **What carries over:** The agent definition, the API key, Google Cloud credentials, or AWS credentials your application uses, your skills, your MCP servers, and your [memory stores](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory).
* **What is new:** A `self_hosted` environment, an environment key that you generate in the Claude Console, and a worker that you run. The [self-hosted sandboxes quickstart](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#quickstart) covers all three.
* **What stops working:** The features listed in [What you take on and give up with a self-hosted sandbox](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment#what-you-take-on-and-give-up-with-a-self-hosted-sandbox).

On Claude Platform on AWS, memory stores don’t carry over to a self-hosted sandbox, and the worker doesn’t use an environment key. See [Differences on Claude Platform on AWS](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment#differences-on-claude-platform-on-aws).

On Claude Models on Google Cloud (Anthropic managed), memory stores aren’t supported in a self-hosted sandbox, and you write your own worker, which doesn’t use an environment key. See [Differences on Claude Models on Google Cloud (Anthropic managed)](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment#differences-on-claude-models-on-google-cloud-anthropic-managed).
