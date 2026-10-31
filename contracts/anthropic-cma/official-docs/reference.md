---
title: Reference
url: https://platform.claude.com/docs/en/managed-agents/reference
description: Event types, self-hosted worker CLI flags, supported MCP server types, rate limits, and branding guidelines for Claude Managed Agents.
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

This page collects reference material for Claude Managed Agents. For task-oriented guides, follow the links in each section. For the operations on the session resource, see [Session operations](https://platform.claude.com/docs/en/managed-agents/session-operations).

## Event types

Persisted event type strings follow a `{domain}.{action}` naming convention; the stream-only event deltas (see the **Event deltas** tab) are the exception. See [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) for sending, streaming, and listing events. Webhook event types are listed separately in [Subscribe to webhooks](https://platform.claude.com/docs/en/managed-agents/webhooks#supported-event-types), and some of their names differ from the stream’s (for example, `session.status_idled` rather than `session.status_idle`).

<Tabs>
  <Tab title="User events">
    | Type                      | Description                                                                                                                                                                                                                                          |
    | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `user.message`            | A user message with text, image, or document content.                                                                                                                                                                                                |
    | `user.interrupt`          | Stop the agent while it runs. It ends no [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open).                                                                                        |
    | `user.custom_tool_result` | Response to a custom tool call from the agent.                                                                                                                                                                                                       |
    | `user.tool_confirmation`  | Approve or deny an agent or MCP tool call when a permission policy requires confirmation.                                                                                                                                                            |
    | `user.define_outcome`     | Define an [outcome](https://platform.claude.com/docs/en/managed-agents/define-outcomes) for the agent to work toward.                                                                                                                                |
    | `user.tool_result`        | For sessions with `self_hosted` [environments](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) only, your integration is responsible for providing `agent_toolset` results. The SDK helpers and CLI do this automatically. |
  </Tab>

  <Tab title="Agent events">
    | Type                             | Description                                                                                                                                                                                                                                                                                                                                                                    |
    | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `agent.message`                  | Agent response content blocks.                                                                                                                                                                                                                                                                                                                                                 |
    | `agent.thinking`                 | Signals the agent is making forward progress through extended thinking. This is a progress signal only and does not carry the thinking content.                                                                                                                                                                                                                                |
    | `agent.tool_use`                 | Agent calls a pre-built agent tool (bash, file operations, and so on). Carries `evaluated_permission` (java, php: `evaluatedPermission`; csharp, go: `EvaluatedPermission`) and, usually, `evaluation` (csharp, go: `Evaluation`) (see [how each call was evaluated](https://platform.claude.com/docs/en/managed-agents/permission-policies#see-how-each-call-was-evaluated)). |
    | `agent.tool_result`              | Result of a pre-built agent tool execution.                                                                                                                                                                                                                                                                                                                                    |
    | `agent.mcp_tool_use`             | Agent calls an MCP server tool. Carries `evaluated_permission` (java, php: `evaluatedPermission`; csharp, go: `EvaluatedPermission`) and, usually, `evaluation` (csharp, go: `Evaluation`) (see [how each call was evaluated](https://platform.claude.com/docs/en/managed-agents/permission-policies#see-how-each-call-was-evaluated)).                                        |
    | `agent.mcp_tool_result`          | Result of an MCP tool execution.                                                                                                                                                                                                                                                                                                                                               |
    | `agent.custom_tool_use`          | Agent calls one of your custom tools. Respond with a `user.custom_tool_result` event.                                                                                                                                                                                                                                                                                          |
    | `agent.thread_context_compacted` | Conversation history was compacted to fit the context window.                                                                                                                                                                                                                                                                                                                  |
    | `agent.thread_message_received`  | In a [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) session, a message from another thread arrived on the thread whose stream carries this event; on the primary thread, an agent sent a report or question to the agent that the session runs.                                                                                     |
    | `agent.thread_message_sent`      | In a [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) session, the thread whose stream carries this event sent a message to another thread; on the primary thread, the agent that the session runs sent a task or follow-up message to another agent.                                                                                 |

    Message content in these events can include a `redacted` content block, `{"type": "redacted"}`: a placeholder for content withheld by Anthropic model policy. The block carries no other fields. Redacted blocks appear only in content the platform emits; a user event that includes one is rejected with a 400 error.
  </Tab>

  <Tab title="Session events">
    | Type                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                               |
    | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `session.status_running`            | Agent is actively processing.                                                                                                                                                                                                                                                                                                                                                                                                                             |
    | `session.status_idle`               | Agent finished its current task and is waiting for input. Includes a `stop_reason` (java, php: `stopReason`; csharp, go: `StopReason`) indicating why the agent stopped.                                                                                                                                                                                                                                                                                  |
    | `session.status_rescheduled`        | A transient error occurred and the session is retrying automatically.                                                                                                                                                                                                                                                                                                                                                                                     |
    | `session.status_terminated`         | Session ended, either because of an unrecoverable error or because it was archived.                                                                                                                                                                                                                                                                                                                                                                       |
    | `session.deleted`                   | Session was deleted. Ends any active event stream; no further events are emitted for this session.                                                                                                                                                                                                                                                                                                                                                        |
    | `session.updated`                   | Session update request changed at least one field. Includes only the fields that changed. Updates apply on the next turn.                                                                                                                                                                                                                                                                                                                                 |
    | `session.error`                     | An error occurred during processing. Includes a typed `error` (csharp, go: `Error`) object with a `retry_status` (java, php: `retryStatus`; csharp, go: `RetryStatus`).                                                                                                                                                                                                                                                                                   |
    | `session.usage`                     | Snapshot of the session’s cumulative usage and tracked list cost. Carries the session’s usage totals and, if the session has one, its [budget](https://platform.claude.com/docs/en/managed-agents/budgets).                                                                                                                                                                                                                                               |
    | `session.thread_created`            | A [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) thread was created. It includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`): the run’s ID for a [workflow run’s thread](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads), and `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) for any other thread. |
    | `session.thread_status_running`     | A session thread began executing. Every session emits this for its primary thread; in [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) sessions, child-thread transitions are also cross-posted to the primary stream.                                                                                                                                                                                           |
    | `session.thread_status_idle`        | A session thread finished its turn and is awaiting input. Includes `stop_reason` (java, php: `stopReason`; csharp, go: `StopReason`).                                                                                                                                                                                                                                                                                                                     |
    | `session.thread_status_rescheduled` | A session thread hit a transient error and is retrying automatically.                                                                                                                                                                                                                                                                                                                                                                                     |
    | `session.thread_status_terminated`  | A session thread terminated and accepts no further input, for example because it was archived or hit an unrecoverable error. An advisor thread also terminates when its consultation ends. The server archives a workflow run’s threads itself.                                                                                                                                                                                                           |

    In a session whose agent has [dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#dynamic-workflows) turned on, these `workflow_run.*` events arrive on the session’s stream:

    | Type                          | Description                                                                                                                                                                                                                                                                                                                                                                                                        |
    | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `workflow_run.created`        | A workflow run was created. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), the run’s `name` (csharp, go: `Name`) and `description` (csharp, go: `Description`), and `phases` (csharp, go: `Phases`), the phases declared for the run. A status event follows, though after an interrupt it might not.                                                      |
    | `workflow_run.status_running` | A workflow run is running. Sent when the run starts to execute, which can be a while after `workflow_run.created`, and again when it resumes after a pause at the budget. A resume after an interrupt might not send it. A run that is idle from the start might get `workflow_run.status_idle` first. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`).      |
    | `workflow_run.status_idle`    | A workflow run went idle: it was paused, for example at the session’s budget. A pause after an interrupt might not send it. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`).                                                                                                                                                                                 |
    | `workflow_run.status_ended`   | A workflow run ended. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) and `result` (csharp, go: `Result`), whose `type` (csharp, go: `Type`) says how the run ended.                                                                                                                                                                                         |
    | `workflow_run.error`          | An error of a workflow run, or a start that the server refused. A run that ends in error gets it, with the same error, before its `workflow_run.status_ended`. Includes `error` (csharp, go: `Error`) and `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), which is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) when no run was created. |
    | `workflow_run.phase_started`  | A workflow run entered one of its phases. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) and `workflow_run_phase_id` (java: `workflowRunPhaseId`; php: `workflowRunPhaseID`; csharp, go: `WorkflowRunPhaseID`).                                                                                                                                             |
    | `workflow_run.phase_ended`    | A workflow run left a phase. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), `workflow_run_phase_id` (java: `workflowRunPhaseId`; php: `workflowRunPhaseID`; csharp, go: `WorkflowRunPhaseID`), and `phase_started_id` (java: `phaseStartedId`; php: `phaseStartedID`; csharp, go: `PhaseStartedID`).                                                       |
  </Tab>

  <Tab title="Span events">
    Span events are observability markers that wrap activity for timing and usage tracking.

    | Type                              | Description                                                                                                                                                                                                                                              |
    | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `span.model_request_start`        | A model inference call has started.                                                                                                                                                                                                                      |
    | `span.model_request_end`          | A model inference call has completed. Includes `model_usage` (java, php: `modelUsage`; csharp, go: `ModelUsage`) with token counts.                                                                                                                      |
    | `span.outcome_evaluation_start`   | [Outcome](https://platform.claude.com/docs/en/managed-agents/define-outcomes) evaluation has started.                                                                                                                                                    |
    | `span.outcome_evaluation_ongoing` | Heartbeat during an ongoing [outcome](https://platform.claude.com/docs/en/managed-agents/define-outcomes) evaluation.                                                                                                                                    |
    | `span.outcome_evaluation_end`     | An [outcome](https://platform.claude.com/docs/en/managed-agents/define-outcomes) evaluation cycle has completed. A `needs_revision` result means another cycle follows; `satisfied`, `max_iterations_reached`, `failed`, and `interrupted` are terminal. |
  </Tab>

  <Tab title="System events">
    | Type             | Description                                                                                                                                                                                                                                                                                                                                                          |
    | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `system.message` | Append privileged system-level context that applies to the accompanying turn and all subsequent turns. For the models that accept it, see [Supported models](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#supported-models). On an unsupported primary model the event is rejected with `model_does_not_support_mid_conversation_system`. |
  </Tab>

  <Tab title="Event deltas">
    Event deltas are stream-only preview events. They are emitted on stream connections (session-level or per-thread) that opt in with the `event_deltas` (curl: `event_deltas[]`; cli: `--event-delta`; java, php: `eventDeltas`; csharp, go: `EventDeltas`) parameter, and they are never persisted to the session’s event history. See [Preview responses with event deltas](https://platform.claude.com/docs/en/managed-agents/event-deltas) for opting in, accumulating, and reconciling them.

    | Type          | Description                                                                                                                                                      |
    | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `event_start` | A previewed event has started generating. Carries the upcoming event’s `type` (csharp, go: `Type`) and `id` (csharp, go: `ID`). Stream-only and never persisted. |
    | `event_delta` | Incremental content for a previewed event, identified by `event_id` (java: `eventId`; php: `eventID`; csharp, go: `EventID`). Stream-only and never persisted.   |
  </Tab>
</Tabs>

## Self-hosted worker

See [Self-hosted worker reference](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference) for the `ant beta:worker` CLI flags, environment variables, filesystem paths, and SDK helper options of the pre-built workers that drive a `self_hosted` environment.

## Supported MCP server types

Claude Managed Agents connects to [remote MCP servers](https://platform.claude.com/docs/en/agents-and-tools/remote-mcp-servers) that expose an HTTP endpoint, or to private MCP servers through [MCP tunnels](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview). The server should support the MCP protocol’s streamable HTTP transport; servers that only support the deprecated SSE transport still work through an automatic fallback. See [MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector) for declaring servers on an agent.

For more information on MCP and building MCP servers, see the [MCP documentation](https://modelcontextprotocol.io).

## Rate limits

Managed Agents endpoints are rate-limited for each organization:

| Operation                                                     | Limit                     |
| ------------------------------------------------------------- | ------------------------- |
| Create endpoints (such as agents, sessions, and environments) | 300 requests per minute   |
| Read endpoints (such as retrieve, list, and stream)           | 1,200 requests per minute |

Organization-level [spend limits and usage-tier rate limits](https://platform.claude.com/docs/en/api/rate-limits) also apply.

## Branding guidelines

For partners integrating Claude Managed Agents, use of Claude branding is optional. When referencing Claude in your product:

**Allowed:**

* “Claude Agent” (preferred for dropdown menus)
* “Claude” (when within a menu already labeled “Agents”)
* “\{YourAgentName} Powered by Claude” (if you have an existing agent name)

**Not permitted:**

* “Claude Code” or “Claude Code Agent”
* “Claude Cowork” or “Claude Cowork Agent”
* Claude Code-branded ASCII art or visual elements that mimic Claude Code

Your product should maintain its own branding and not appear to be Claude Code, Claude Cowork, or any other Anthropic product. For questions about branding compliance, contact the Anthropic [sales team](https://www.anthropic.com/contact-sales).
