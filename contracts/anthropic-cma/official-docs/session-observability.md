---
title: Inspect sessions and track usage
url: https://platform.claude.com/docs/en/managed-agents/session-observability
description: Inspect a session in the Claude Console, read its token usage and list cost, and debug unexpected agent behavior.
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
---

Use the session viewer in the Claude Console to inspect what an agent did in a session, without writing any code. Use the session’s `usage` (csharp, go: `Usage`) totals to see what that work consumed. To see a session’s turns, model requests, and tool uses in your observability platform, set up [OpenTelemetry tracing](https://platform.claude.com/docs/en/manage-claude/opentelemetry).

## Inspect a session in the Console

The session viewer is only accessible to Developers and Admins. To open it, go to the [Sessions](https://platform.claude.com/sessions) page (`platform.claude.com/sessions`) in the Claude Console. The list shows every session in the workspace with its status, agent, token usage, cost, creator, and creation time. Select a session to open it.

The session viewer shows:

* **Timeline minimap:** A zoomable overview of the session’s activity over time, with one lane for each thread in [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) sessions. Select a lane to view that thread, or select a mark to jump to its event.
* **Transcript:** The conversation grouped by model request, including thinking, tool calls with their inputs and results, and message text as it streams. You can filter the events and copy or download them as JSON.
* **Inspector:** A resizable side panel with details about the session, in five tabs.

| Inspector tab | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session**   | The session’s details and metadata, its cumulative cost over time, and spend against the session’s [budget](https://platform.claude.com/docs/en/managed-agents/budgets) when one is set.                                                                                                                                                                                                                                                                                                                                |
| **Events**    | Every raw event on the current thread, in the order the server sent it. Select an event to see its JSON. A message that streamed while the page was open also has a **Deltas** view of its [event deltas](https://platform.claude.com/docs/en/managed-agents/event-deltas).                                                                                                                                                                                                                                             |
| **Tools**     | The tools the session’s agents are configured with, along with call counts, failures, and median duration. Select a tool to see its calls and jump to one in the transcript.                                                                                                                                                                                                                                                                                                                                            |
| **Resources** | Mounted [files](https://platform.claude.com/docs/en/managed-agents/files), [repositories](https://platform.claude.com/docs/en/managed-agents/github), and [memory stores](https://platform.claude.com/docs/en/managed-agents/memory) at their container paths, including the memories in each store and the changes this session made to them. Also lists files the agent wrote to `/mnt/session/outputs` and the [skills](https://platform.claude.com/docs/en/managed-agents/skills) attached to the session’s agents. |
| **Threads**   | Every thread with its status, context size, and cost. Select a thread to view its details, such as the agent, model, context usage, and cost.                                                                                                                                                                                                                                                                                                                                                                           |

Append `?event={event_id}` to a session URL to open the session at a specific event.

With `ant beta:sessions connect`, you can open the same viewer from the `ant` CLI or follow the session in your terminal. See [Connect to a Managed Agents session from your terminal](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/sessions-connect).

## Track usage

The session object includes a `usage` field with the session’s cumulative usage: token counts, server tool use, active time, and the tracked list cost. Fetch the session after it goes idle to read the latest totals.

```json
{
  "id": "sesn_01...",
  "status": "idle",
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 3200,
    "cache_read_input_tokens": 20000,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 2000,
      "ephemeral_1h_input_tokens": 0
    },
    "list_cost": {
      "amount": "187",
      "currency": "USD"
    },
    "active_seconds": 342.5,
    "server_tool_use": {
      "web_search_requests": 3,
      "web_fetch_requests": 0
    }
  }
}
```

| Field                     | Description                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input_tokens`            | Uncached input tokens across all model calls in the session.                                                                                                                                                           |
| `output_tokens`           | Total output tokens across all model calls in the session.                                                                                                                                                             |
| `cache_read_input_tokens` | Tokens read from the prompt cache.                                                                                                                                                                                     |
| `cache_creation`          | Cache-creation tokens, broken down by cache lifetime (`ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`).                                                                                                    |
| `list_cost`               | The session’s cumulative consumption priced at public list rates, as a whole number of cents in a string, with a currency code.                                                                                        |
| `active_seconds`          | The cumulative time during which the session had at least one thread running. Overlapping activity from concurrent threads is counted once. The session’s runtime cost is priced on this duration.                     |
| `server_tool_use`         | Counts of server-executed tool requests, for pricing. Web search requests are priced into list cost per request. Web fetch requests carry no per-request charge and aren’t metered, so `web_fetch_requests` reads `0`. |

Cache entries use a 5-minute TTL by default, so back-to-back turns within that window benefit from cache reads, which reduce per-token cost.

The session’s `stats` object has its own `active_seconds`, which sums each thread’s own active time instead of counting overlapping activity once.

### Per-thread usage

Each [session thread](https://platform.claude.com/docs/en/managed-agents/session-threads)’s own `usage` (csharp, go: `Usage`) carries `list_cost` (java, php: `listCost`; csharp, go: `ListCost`) and `active_seconds` (java, php: `activeSeconds`; csharp, go: `ActiveSeconds`) too. Per-thread figures are rounded independently and exclude the session’s running-time cost, so they don’t sum exactly to the session’s `list_cost` (java, php: `listCost`; csharp, go: `ListCost`). The session figure is the authoritative one.

### Read usage from the stream

You don’t have to poll the session to observe these totals. The `session.usage` event carries the same cumulative snapshot on the session stream and in the event history. The snapshot holds the `usage` (csharp, go: `Usage`) object, plus the session’s `budget` (csharp, go: `Budget`) if the session has one.

The event is emitted on idle transitions rather than on a timer:

* The session emits one immediately before it goes idle, whatever the stop reason.
* The session emits one when a thread pauses at a [session budget](https://platform.claude.com/docs/en/managed-agents/budgets).

### Enforce a spend limit

To enforce a spend limit, set a session budget rather than polling usage and stopping the session yourself. The platform prices the session’s consumption continuously, and pauses each thread before its next model request once the list cost reaches the cap. See [When a session reaches its budget](https://platform.claude.com/docs/en/managed-agents/budgets#when-a-session-reaches-its-budget) for what that looks like on the stream.

### Find session usage across your organization

Session usage counts toward your organization’s totals on the [Usage](https://platform.claude.com/usage) page (`platform.claude.com/usage`) and the [Cost](https://platform.claude.com/cost) page (`platform.claude.com/cost`) in the Claude Console. To see token usage by agent, set **Group by** to **Agent** on the **Usage** page.

Session usage also appears in the [usage report](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages) from the [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api). To see which account it’s reported under, group the report by one of these fields:

* **`account_id`:** The member who started the session. This covers sessions started in the Console or with a [personal key](https://platform.claude.com/docs/en/manage-claude/authentication#key-types) scoped to a single workspace.
* **`service_account_id`:** An Anthropic-managed service account (`svac_...`). This covers sessions started with a workspace key or by a [deployment](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments). For this usage, `api_key_id` and `account_id` are `null`.

Anthropic creates one of these service accounts in each workspace where sessions run. It isn’t listed with the service accounts that you create, and the Admin API’s service account endpoints don’t return it. On the **Usage** page, the **Account** filter lists it by its ID. When you set **Group by** to **API key**, its usage is labeled **Managed Agents**.

To see who started a session, check the **Created by** column on the [Sessions](https://platform.claude.com/sessions) page.

## Debugging tips

* **Check session events:** The session reports errors through [`session.error`](https://platform.claude.com/docs/en/managed-agents/reference#event-types) events.
* **Review tool results:** Tool failures often explain unexpected agent behavior. The Inspector’s **Tools** tab shows each tool’s failures.
* **Use system prompts:** Add logging instructions to the system prompt so the agent summarizes what it did and what it found.
* **Troubleshoot previews:** If a stream that opts in to event deltas doesn’t behave as you expect, see [Troubleshoot previews](https://platform.claude.com/docs/en/managed-agents/event-deltas#troubleshoot-previews).

## Next steps

<CardGroup cols={2}>
  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Send events, stream responses, and interrupt or redirect your session while it runs.
  </Card>

  <Card title="Session budgets" icon="coins" href="https://platform.claude.com/docs/en/managed-agents/budgets">
    Cap a session’s spend with a hard dollar budget enforced at public list rates.
  </Card>
</CardGroup>

## Availability

Session viewer is in beta on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Always on

| Status | Cloud platforms                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| Beta   | Claude API, [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws) |

### Required beta headers

[Beta headers overview](https://platform.claude.com/docs/en/api/beta-headers)

Beta headers allow you to access experimental features and new model capabilities before they become part of the standard API.

* `managed-agents-2026-04-01`

### Data handling

[Data handling overview](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#feature-eligibility)

| Item    | Zero data retention                                                                                                                                      | HIPAA                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Status  | Not eligible                                                                                                                                             | Not eligible                                                                 |
| Details | Sessions are stateful resources; transcripts persist until you delete them. Applies to all Managed Agents sub-features, including Self-hosted sandboxes. | Applies to all Managed Agents sub-features, including Self-hosted sandboxes. |

Applicable endpoints:

* `/v1/agents`
* `/v1/sessions`
* `/v1/environments`
