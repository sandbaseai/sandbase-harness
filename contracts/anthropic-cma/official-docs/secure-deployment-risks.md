---
title: Security risks and sandbox boundaries
url: https://platform.claude.com/docs/en/managed-agents/secure-deployment-risks
description: Why an agent's settings matter for security, and what the Managed Agents sandbox can and cannot do.
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

This page explains why the settings in [Secure your Managed Agents deployment](https://platform.claude.com/docs/en/managed-agents/secure-deployment) matter, and what the sandbox can and cannot do.

## Why this matters

Hidden instructions in content that an agent reads can steer the agent. This is called [prompt injection](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks). Claude is inherently resilient to it, but model behavior is not a security control. The settings in [Secure your Managed Agents deployment](https://platform.claude.com/docs/en/managed-agents/secure-deployment) limit the effect if an attempt succeeds.

Claude can also take a step you did not expect while it keeps working to complete the task you gave it. For example, it might use a tool or credential it can reach to get past an obstacle. The same settings limit what such a step can reach, and an [offline reviewer](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#optionally-have-an-offline-reviewer-read-every-transcript) can flag it afterward.

| What can go wrong                        | Example                                                                                                                          | Controls                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Untrusted input steers the agent         | A ticket tells the agent to cancel every open order                                                                              | [Smallest tool set](https://platform.claude.com/docs/en/managed-agents/secure-deployment#give-the-agent-the-smallest-tool-set), [untrusted input kept away from powerful tools](https://platform.claude.com/docs/en/managed-agents/secure-deployment#keep-untrusted-input-away-from-powerful-tools), [approvals for risky actions](https://platform.claude.com/docs/en/managed-agents/secure-deployment#approve-risky-actions) |
| Code in the sandbox can use a credential | A script the agent was tricked into running sends the agent’s key to an outside host, or uses it to read every customer’s orders | [Credentials in vaults](https://platform.claude.com/docs/en/managed-agents/secure-deployment#keep-credentials-in-vaults), [limited networking](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network), [approvals for risky actions](https://platform.claude.com/docs/en/managed-agents/secure-deployment#approve-risky-actions)                                                              |
| An open network lets data out            | A bash command posts a file to an outside host                                                                                   | [Limited networking](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network), the [`web_fetch` domain list](https://platform.claude.com/docs/en/managed-agents/secure-deployment#restrict-web-search-and-web-fetch)                                                                                                                                                                            |
| Claude takes a step you did not expect   | To get past an obstacle, it uses a tool or credential it can reach                                                               | The settings in [Secure your Managed Agents deployment](https://platform.claude.com/docs/en/managed-agents/secure-deployment). An [offline reviewer](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#optionally-have-an-offline-reviewer-read-every-transcript) can flag the step afterward                                                                                                    |

These settings lower the risk but do not remove it, so do not put data in the sandbox that must never leave it. An agent can still put data it is allowed to read into its own reply or tool output. Limit a key’s permissions at the service that issued it, because these settings do not limit them. The settings do not secure your custom tools, your MCP servers, or your self-hosted infrastructure.

## What the sandbox can and cannot do

Managed Agents keeps the agent loop, session history, and vault secrets outside the sandbox by design. For the design background, see [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents).

| Part                         | Where it runs                                                                                                        | What limits it                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop                   | Anthropic’s servers                                                                                                  | The tool set, permission policies, and budget that you set                                                                                                                                                                                                  |
| `bash` and file tools        | The sandbox. In a cloud environment, each session gets its own isolated Linux container                              | Environment networking, the tool set, and permission policies                                                                                                                                                                                               |
| `web_search` and `web_fetch` | Anthropic’s servers                                                                                                  | The tool’s own domain list, your organization’s web search and web fetch settings in the Claude Console, and, in a `limited` cloud environment, the environment’s allowed hosts. `web_fetch` also opens only URLs that have already appeared in the session |
| Vault secret                 | Outside the sandbox. MCP credentials never enter it. For an environment variable credential, code sees a placeholder | For an MCP credential, the MCP server URL it is for. For an environment variable credential, the hosts the credential allows, its injection location, and the environment’s allowed hosts                                                                   |
| Session history              | Anthropic’s servers, until you delete the session                                                                    | The API keys for the workspace, the Developer and Admin roles in the Claude Console, and session deletion                                                                                                                                                   |
| Custom tools                 | Your application                                                                                                     | Your code                                                                                                                                                                                                                                                   |

In a cloud environment, sessions do not share filesystem state. A memory store attached to more than one session is shared between them.

These limits do not replace each other. For example, limiting the environment’s hosts does not stop the agent from using a credential on a host you allowed.
