---
title: Review and monitor agent sessions
url: https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring
description: Optionally review each session's events with an offline job. Watch webhooks for sessions that need attention, and see what Managed Agents keeps and for how long.
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

Optionally review each session’s events with an offline job. Watch webhooks for sessions that need attention, and delete sessions you no longer need. To limit what an agent can do before it runs, see [Secure your Managed Agents deployment](https://platform.claude.com/docs/en/managed-agents/secure-deployment).

## Optionally have an offline reviewer read every transcript

An offline reviewer is a job you run, separate from the sessions it reviews, that reads each session’s events after they are written. Long sessions have too many events for a person to read, so the job has Claude read them. The review flags behavior beyond what the agent was granted. For a review prompt, setup steps, and working code, see the [security review recipe](https://platform.claude.com/cookbook/managed-agents-cma-agent-security-review) in the Claude Cookbook.

## Monitor sessions and review retention

Subscribe to the webhooks that tell you when a session needs attention, and delete sessions you no longer need. Verify the signature on each delivery. See [Verify the signature](https://platform.claude.com/docs/en/managed-agents/webhooks#verify-the-signature).

| What to watch                                           | Where to see it                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions that go idle, for example to wait for approval | The `session.status_idled` webhook. It fires each time a session goes idle, for any reason                                                                                                                                                                                          |
| Sessions that reach a budget or terminate               | The `session.budget_reached` and `session.status_terminated` webhooks                                                                                                                                                                                                               |
| Scheduled runs that fail to start a session             | The `deployment_run.failed` and `deployment.paused` webhooks                                                                                                                                                                                                                        |
| MCP OAuth credentials that cannot refresh               | The `vault_credential.refresh_failed` webhook                                                                                                                                                                                                                                       |
| Tool calls the server denied or paused                  | `evaluated_permission` on `agent.tool_use` and `agent.mcp_tool_use` events. In a multiagent session, also list each thread’s events                                                                                                                                                 |
| What an agent did in a session                          | The Claude Console session viewer                                                                                                                                                                                                                                                   |
| Behavior beyond what the agent was granted              | An optional offline review job you run that reads each session’s events. See [Optionally have an offline reviewer read every transcript](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#optionally-have-an-offline-reviewer-read-every-transcript) |

To see why a session went idle, list its events with `types` set to `session.status_idle`, `order` set to `desc`, and `limit` set to `1`. The event is named `session.status_idle`, and the webhook is named `session.status_idled`. If `stop_reason.type` is `requires_action`, the session is waiting on you, and `stop_reason.event_ids` lists the events it is waiting on. To answer them, see [Answer tool calls that pause the session](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#answer-tool-calls-that-pause-the-session). In a self-hosted sandbox, an `agent.tool_use` event can be waiting for your sandbox to return the tool’s result. With workflow runs open, a tool call can wait for your answer while the session stays `running`. Answer each call when its event arrives. See [While a run is open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#while-a-run-is-open).

A webhook delivery can be missed, so also list your sessions on a schedule and check the idle ones.

See [Subscribe to webhooks](https://platform.claude.com/docs/en/managed-agents/webhooks) and [Inspect sessions and track usage](https://platform.claude.com/docs/en/managed-agents/session-observability#inspect-a-session-in-the-console).

This list shows what Managed Agents keeps, and for how long:

* **Session history:** Kept until you delete the session. Archiving a session keeps its history. To keep a session’s events, copy them to your own logs with the events API before you delete it. A `running` session cannot be deleted. See [Deleting a session](https://platform.claude.com/docs/en/managed-agents/session-operations#deleting-a-session).
* **Sandbox state:** Kept for 30 days after the sandbox is created.
* **Files a session produces:** Deleted with the session. Download the files you want to keep first.
* **Files you uploaded, memory stores, and vaults:** Not deleted with the session. Delete them separately.

With a self-hosted sandbox, the copies of tool inputs and outputs on your own infrastructure are yours to retain or delete.

Managed Agents is not currently eligible for Zero Data Retention or HIPAA Business Associate Agreement (BAA) coverage. See [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#feature-eligibility).
