---
title: Workflow runs
url: https://platform.claude.com/docs/en/managed-agents/workflow-runs
description: "Follow an agent's workflow runs: their states and events, when the work is done, requests while a run is open, budgets, and limits."
featureMetadata:
  topic:
    title: Managed Agents
    url: https://platform.claude.com/docs/en/managed-agents/overview
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
---

A **workflow** is a program that an agent writes to run many agents and combine what they return. A **workflow run** is the execution of one workflow. **[Dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#dynamic-workflows)** is the feature that lets an agent write workflows and start runs. You turn it on or off with the `workflows` (csharp, go: `Workflows`) setting in the agent’s `multiagent` (csharp, go: `Multiagent`) block.

The server runs a workflow in the background. Its agents work in [session threads](https://platform.claude.com/docs/en/managed-agents/session-threads) that the server creates as the workflow needs them. You follow runs on the session’s [event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming). To stop a run, ask the agent to stop it (see [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open)).

## How dynamic workflows work

The agent that the session runs writes each workflow for the work that you describe. A workflow is a program: it runs other agents, collects what each one returns, and combines the results. That way, the agent can take on a task that is too large for one conversation, such as a review of hundreds of documents. During a run, the agent can keep working or end its turn, and it can check on the run.

<Frame>
  ![Layers of a workflow run: the run, its two phases, and the agent threads in each. Results pass from one phase to the next.](https://platform.claude.com/docs/images/workflow-anatomy.svg)
</Frame>

The diagram shows one example. Each workflow that the agent writes has its own phases and agents. A run has these layers:

* **Workflow run:** The server runs the workflow in the background, as one workflow run. A session can have several runs open at the same time.
* **Phases:** A workflow can divide its work into phases. A phase is a named stage of the run, such as “Read the contracts.” You follow a run’s progress by its phase events.
* **Agent threads:** In a phase, the program runs agents. Each agent works in its own [session thread](https://platform.claude.com/docs/en/managed-agents/session-threads), on a prompt that the program wrote. An agent in a run can be an inline agent, which the program defines itself, or a [predefined agent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents), which you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`). For what each thread shows, see [A run’s threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads).

The program can do the following:

* **Run agents at the same time:** The program can run many agents at the same time, which is called fanning out. In the diagram, three agents read contracts in the first phase.
* **Pass results from one agent to another:** Each agent returns its result to the program. The program can pass that result on to another agent. In the diagram, the agent in the second phase works with what the first three returned. A run’s agents also work with the same files, in the session’s sandbox.
* **Take the next step by itself:** An agent’s result goes to the program, not to the agent that the session runs. The program determines which agents run next, and it writes their prompts.
* **Repeat and choose:** Inside a phase, the program can repeat work and choose its next step from what an agent returned. For example, it can have a draft revised until a review passes or a set number of rounds is used up. In the diagram, the program can repeat a step inside the second phase.
* **Handle a failed agent:** When one of its agents fails, the server usually runs that agent once more, on a new thread, while the run’s other agents keep working. If it fails again, the program can handle the failure or let it end the run. If the program handles a failure, the run can still end `completed`, so tell the agent that the session runs to report what failed.

When the run ends, the agent that the session runs gets a turn to read what the run did. It can then answer you or start another run. [Run events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events) lists the cases where that turn comes later or doesn’t come.

You can guide how a run does the work, for example how it splits the work and what it does when an agent fails. See [Tell the agent when to use a run](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#tell-the-agent-when-to-use-a-run).

There’s no approval step before a run starts: the agent starts a run in the same turn that it writes the workflow. To review a plan first, tell the agent to describe the run and wait for your approval. As a run starts, `workflow_run.created` shows its name, description, and phases. If a run starts that you didn’t approve, ask the agent to stop it (see [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open)).

## How a run moves through its states

<Frame>
  ![Workflow run states: running, idle, and ended, and what moves a run from one to another.](https://platform.claude.com/docs/images/workflow-run-states.svg)
</Frame>

A run starts as running or as idle. Reaching the budget, for example, pauses a running run, which makes it idle; raising or removing the budget then makes it run again, unless an interrupt paused it too. A running run ends when its workflow completes, the agent stops it, it fails, its lifetime passes, or the session is archived. An idle run can end too, for example when the agent stops it or the session is archived.

A run is **open** from its `workflow_run.created` event until its `workflow_run.status_ended` event, whether it’s running or idle. A run is idle while it’s paused, for example at the session’s budget. A run has a [lifetime](https://platform.claude.com/docs/en/managed-agents/workflow-runs#limits), which the agent can set when it starts the run. Time that a run spends waiting on your client counts toward that lifetime. A pause doesn’t stop a run’s lifetime from passing, so a run that stays paused can end with `timeout_error`. The following events report a run’s start, its phases, and its end. A pause at the budget sends one too. A pause after an interrupt might send none. Every `workflow_run.*` event includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), which is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) only on a `workflow_run.error` when no run was created.

## Run events

Run events arrive on the session’s event stream, which is the primary thread’s stream, and listing the session’s events returns them too. Run events don’t trigger [webhooks](https://platform.claude.com/docs/en/managed-agents/webhooks). Status events from the run’s threads arrive on the same stream. Each names its thread in `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`), and a run’s threads are the ones whose `session.thread_created` event had the run’s `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`).

| Event                                                    | When it arrives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_run.created`                                   | The agent started a run. Includes `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) (`wrun_…`), the run’s `name` (csharp, go: `Name`) and `description` (csharp, go: `Description`), and `phases` (csharp, go: `Phases`), the phases the workflow declares, each with an `id` (csharp, go: `ID`), a `name` (csharp, go: `Name`), and a `description` (csharp, go: `Description`). A `description` (csharp, go: `Description`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) when the workflow gives none. `phases` (csharp, go: `Phases`) is always present and can be empty. The run’s and phases’ `name` (csharp, go: `Name`) and `description` (csharp, go: `Description`) are text the model wrote, so they can repeat words from your request. A run’s `name` (csharp, go: `Name`) can also be one the server assigned. | Track the run as open. Show its `name` (csharp, go: `Name`), and progress against `phases` (csharp, go: `Phases`).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `workflow_run.status_running`                            | When the run starts its work, which can be a while after `created`, and each time it resumes after a pause at the budget. A resume after an interrupt might not send it. A run that starts idle might get `workflow_run.status_idle` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Show the run as running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workflow_run.status_idle`                               | The run was paused, for example at the session’s budget. The event doesn’t say why. A pause after an interrupt might not send it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | To continue, see [Cost and budgets](https://platform.claude.com/docs/en/managed-agents/workflow-runs#cost-and-budgets) or [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open).                                                                                                                                                                                                                                                                |
| `workflow_run.phase_started`, `workflow_run.phase_ended` | The workflow entered or left a phase, or the run’s end closed a phase that was still open. The end event doesn’t say whether the phase’s work completed. Both include `workflow_run_phase_id` (java: `workflowRunPhaseId`; php: `workflowRunPhaseID`; csharp, go: `WorkflowRunPhaseID`). The end also has `phase_started_id` (java: `phaseStartedId`; php: `phaseStartedID`; csharp, go: `PhaseStartedID`), the `id` (csharp, go: `ID`) of the start event it closes. Neither has the phase’s name: look it up by `workflow_run_phase_id` (java: `workflowRunPhaseId`; php: `workflowRunPhaseID`; csharp, go: `WorkflowRunPhaseID`) in the `phases` (csharp, go: `Phases`) of `workflow_run.created`.                                                                                                                                                                                                 | Update progress. Phases run one at a time, in the order of `phases` (csharp, go: `Phases`), each at most once, but the API doesn’t guarantee it. Match a phase’s end to its start by `phase_started_id` (java: `phaseStartedId`; php: `phaseStartedID`; csharp, go: `PhaseStartedID`). Handle more than one open phase, a phase that isn’t in `phases` (csharp, go: `Phases`), and a listed phase that never starts, even in a run that completes. Every phase that starts also ends, before the run’s `workflow_run.status_ended`. |
| `workflow_run.status_ended`                              | The run ended. Always the last of the run’s `workflow_run.*` events. Includes `result` (csharp, go: `Result`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Read `result` (csharp, go: `Result`) (next table). The agent then gets a turn to read how the run ended. At the budget, or while the primary thread waits on your client, that turn comes later. After an interrupt, that turn might not come: send a `user.message`, or read `result` (csharp, go: `Result`) yourself. After an archive or termination, it doesn’t come.                                                                                                                                                           |
| `workflow_run.error`                                     | The server reports an error of a run, or a start that it refused. A run that ends in `error` gets this event, with the same error, before its `workflow_run.status_ended`. Includes `error` (csharp, go: `Error`): a `type` (csharp, go: `Type`) and a `message` (csharp, go: `Message`) that is safe to log. `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) when no run was created.                                                                                                                                                                                                                                                                                                                                                                                       | Log it, and don’t take it as the run’s end. If `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`), no run started. Otherwise keep tracking the run until its `workflow_run.status_ended`.                                                                                                                                                                                                                     |

| `result`                          | Meaning                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type": "completed"}`           | The workflow finished running. The result doesn’t say whether the work passed. A run can end `completed` even though work on its threads failed, or a thread couldn’t be created. To find failed work, read the events of each of the [run’s threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads). |
| `{"type": "stopped"}`             | The agent stopped the run, or the session was archived. The event doesn’t say which. Don’t treat these as the only causes.                                                                                                                                                                                                              |
| `error` with `timeout_error`      | The run reached its [lifetime](https://platform.claude.com/docs/en/managed-agents/workflow-runs#limits), which the agent can set.                                                                                                                                                                                                       |
| `error` with `program_error`      | The workflow failed. Its code failed, or it broke a rule for workflows, other than a limit. Or one of the run’s threads failed, or couldn’t be created, and the workflow let that end the run.                                                                                                                                          |
| `error` with `thread_limit_error` | The run went over its [limit on the agents that a workflow starts](https://platform.claude.com/docs/en/managed-agents/workflow-runs#limits).                                                                                                                                                                                            |
| `error` with `unknown_error`      | The server couldn’t continue the run, or the run went over one of the server’s other limits on workflows.                                                                                                                                                                                                                               |

An error result looks like `{"type": "error", "error": {"type": "timeout_error", "message": "..."}}`, where `message` is safe to log. Treat an unrecognized `result.type` as a run that ended some other way, and an unrecognized `error.type` as an error. When something the session depends on fails, such as the model, an MCP server, credentials, or billing, the failing thread’s stream gets a `session.error`. That doesn’t end a run by itself. But if it makes one of the run’s threads fail, and the workflow lets that end the run, the run ends with `program_error`.

For example, you ask the [contract-review agent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows) which of 300 contracts have a change-of-control clause, and the agent starts a run:

1. `workflow_run.created` names the run “Find change-of-control clauses” and lists the phases “Read the contracts” and “Reconcile the findings” in `phases` (csharp, go: `Phases`). Then `workflow_run.status_running` follows.
2. Phase events mark each phase, and each thread the run creates sends `session.thread_created` with the run’s `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`).
3. `workflow_run.status_ended` arrives with `result: {"type": "completed"}`.
4. The agent answers, “41 of the 300 contracts have one,” and `session.status_idle` arrives with `end_turn`.

The run’s first event lists its phases:

```json
{
  "type": "workflow_run.created",
  "id": "sevt_01abc...",
  "workflow_run_id": "wrun_01J8XkN5uT3vHpLqRfWdY2",
  "name": "Find change-of-control clauses",
  "description": "Reads each contract and lists those that have the clause.",
  "phases": [
    {
      "id": "wrph_01Kd3a1f3",
      "name": "Read the contracts",
      "description": "Reads each contract for the clause."
    },
    { "id": "wrph_01Kd3b7c9", "name": "Reconcile the findings", "description": null }
  ],
  "processed_at": "2026-10-09T14:01:45Z"
}
```

Each phase event names its phase by `workflow_run_phase_id`. That is an `id` in `phases`, but the API doesn’t guarantee it:

```json
{
  "type": "workflow_run.phase_started",
  "id": "sevt_01def...",
  "workflow_run_id": "wrun_01J8XkN5uT3vHpLqRfWdY2",
  "workflow_run_phase_id": "wrph_01Kd3a1f3",
  "processed_at": "2026-10-09T14:01:46Z"
}
```

The run’s last event reports how it ended:

```json
{
  "type": "workflow_run.status_ended",
  "id": "sevt_01ghi...",
  "workflow_run_id": "wrun_01J8XkN5uT3vHpLqRfWdY2",
  "result": { "type": "completed" },
  "processed_at": "2026-10-09T14:09:12Z"
}
```

## A run’s threads

Each agent in a run works in its own [session thread](https://platform.claude.com/docs/en/managed-agents/session-threads), which the server creates as the workflow needs it. You can list, read, and stream a run’s threads like any child thread, and answer their tool calls from the primary stream. To stop them, ask the agent to stop the run (see [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open)).

* **Grouping:** A run’s thread has the run’s `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), as does the `session.thread_created` event that announces it. Other threads, and the `session.thread_created` events that announce them, have `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) set to `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`).
* **Agent:** `agent` (csharp, go: `Agent`) shows the agent the thread runs. For an agent you listed in the [`predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`)](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows) in `multiagent` (csharp, go: `Multiagent`), `agent` (csharp, go: `Agent`) has that agent’s `id` (csharp, go: `ID`) and `version` (csharp, go: `Version`), as on the thread of a subagent you listed. For an agent the workflow defines (an inline agent), `agent` (csharp, go: `Agent`) has `type` `inline` and no `id` (csharp, go: `ID`) or `version` (csharp, go: `Version`). It has the system prompt the workflow wrote, not the session agent’s. It also has the name and description the workflow gave it. The server assigns a name if the workflow gave none. It uses the model of the session agent, the agent the session runs. Its tools, MCP servers, and skills are a subset of the session agent’s. It gets all of them, but the API doesn’t guarantee that. Its tools keep their permission policies.
* **What the threads share:** A run’s threads work in the session’s sandbox, so every thread works with the same files. That includes the files of a memory store the session mounts. An agent the workflow defines uses its MCP servers with the credentials the session resolves for them. Each thread has its own conversation history.
* **Events:** A run thread’s `session.thread_created`, `session.thread_status_running`, `session.thread_status_idle`, and `session.thread_status_terminated` events also arrive on the primary stream (see [Run events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events)). Its message events stay on its own stream. Its thread webhooks are sent as for any child thread. For what the thread’s own stream records, see [Session thread events](https://platform.claude.com/docs/en/managed-agents/session-threads#session-thread-events).
* **Phases:** No event or field says which phase a thread works in, and threads of one run can have the same `agent_name`. Follow a run’s progress by its phase events, and tell its threads apart by `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`).
* **Archiving:** The server archives each thread no later than the end of its run. It can archive one sooner, once the thread returns its result or the run finishes with it. If the thread is still running or waiting on your client at that point, the server stops it first. An archived thread stays in the thread list, with status `terminated`. You don’t need to archive a run’s threads yourself.
* **Tools:** A run can create more than one thread for the same piece of work, so make the tools your agents call safe to call twice.

<Tip>
  You can ask the agent for the workflow that it wrote for your request. Wait until the run has ended and the session is `idle`. Then send a `user.message` that asks the agent to print the workflow that it started the run with, word for word, and not to start another run.

  ```text wrap
  Print the workflow that you started the run with, word for word, in one code block. Do not start another run.
  ```
</Tip>

## Know when the work is done

While a run is running, expect the session to stay `running`, even while none of its threads is working. It goes `idle` with `requires_action` when no thread is working and a thread waits on your client. An idle by itself doesn’t mean that the work is done. The work is done when both are true:

1. Every run you’ve seen created has its `workflow_run.status_ended`.
2. After that, a `session.status_idle` arrives with `stop_reason` (java, php: `stopReason`; csharp, go: `StopReason`) `end_turn`, and your own request, such as an interrupt, didn’t cause it. After you interrupt, count only an idle that comes after your next `user.message` or `user.define_outcome`.

* **Paused runs:** A paused run doesn’t keep the session `running`, so the session can go idle while the run is still open. At the budget, for example, the session goes idle with `budget_reached`. The work isn’t done until the run ends.
* **Another run:** The agent can start a new run when it reads a result, so check again.
* **Outcomes:** If you [defined an outcome](https://platform.claude.com/docs/en/managed-agents/define-outcomes), no evaluation starts while a run is open, whether it’s running or idle. The turn in which the agent reads the run’s result can start one.
* **`retries_exhausted`:** The agent’s turn failed on an error: retries ran out, or the error can’t be retried, such as a billing failure. A run might still be running when this idle comes. If a run ended and the agent hasn’t read its result yet, the server starts a new turn with no input from you. The session goes `running` again, so wait for the next idle. If the session stays idle, read the `session.error` that came before it and fix the cause. Then send a `user.message`, or read each run’s `result` (csharp, go: `Result`) yourself.

## Follow a run

This sample follows a session from your message to the agent’s answer. It opens the stream and sends the message. Then it does the following:

* **Tracks each run** from its `workflow_run.created` to its `workflow_run.status_ended`, and prints each phase as it starts.
* **Answers custom tool calls** when each `agent.custom_tool_use` arrives, because a run’s thread can wait on your client while the session stays `running`. If your agent’s tools [ask for confirmation](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#tool-confirmation), add a branch that answers each `agent.tool_use` or `agent.mcp_tool_use` whose `evaluated_permission` (java, php: `evaluatedPermission`; csharp, go: `EvaluatedPermission`) is `ask`. The sample has none, because a branch that allows every call would turn `always_ask` into always allow.
* **Stops** when the [work is done](https://platform.claude.com/docs/en/managed-agents/workflow-runs#know-when-the-work-is-done): no run is open, and the session goes idle with `end_turn`. It also stops if the session terminates. On an idle with any other stop reason except `requires_action`, such as `budget_reached`, `retries_exhausted`, or `refusal`, it prints the reason and stops, so handle those in your own code. It stops on `retries_exhausted` even when the server is about to start a new turn by itself. It keeps waiting on `requires_action`, and on `end_turn` while a run is open.

<CodeGroup exclude="shell">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  open_runs: dict[str, str] = {}  # workflow_run_id -> run name
  phase_names: dict[tuple[str, str], str] = {}  # (run ID, phase ID) -> phase name

  # Open the stream first, then send the user message
  with client.beta.sessions.events.stream(session_id) as stream:
      client.beta.sessions.events.send(
          session_id,
          events=[
              {
                  "type": "user.message",
                  "content": [
                      {
                          "type": "text",
                          "text": "Which contracts in /contracts have a change-of-control clause?",
                      },
                  ],
              },
          ],
      )

      for event in stream:
          match event.type:
              case "workflow_run.created":
                  open_runs[event.workflow_run_id] = event.name
                  for phase in event.phases:
                      phase_names[event.workflow_run_id, phase.id] = phase.name
                  print(f"Run started: {event.name}")
              case "workflow_run.phase_started":
                  phase_id = event.workflow_run_phase_id
                  key = (event.workflow_run_id, phase_id)
                  print(f"  Phase: {phase_names.get(key, phase_id)}")
              case "workflow_run.status_ended":
                  name = open_runs.pop(event.workflow_run_id, event.workflow_run_id)
                  print(f"Run ended: {name} ({event.result.type})")
              case "agent.custom_tool_use":
                  # Answer when the event arrives. A run's thread can wait on your
                  # client while the session stays running.
                  result = call_tool(event.name, event.input)
                  try:
                      client.beta.sessions.events.send(
                          session_id,
                          events=[
                              {
                                  "type": "user.custom_tool_result",
                                  "custom_tool_use_id": event.id,
                                  "content": [{"type": "text", "text": result}],
                              },
                          ],
                      )
                  except anthropic.BadRequestError as error:
                      # The server refuses a result that comes too late, after it
                      # archived the call's thread. Keep following the run.
                      print(f"  Answer to {event.name} refused: {error.message}")
              case "session.status_idle":
                  # Done when every run has ended and the agent has finished its turn
                  if not open_runs and event.stop_reason.type == "end_turn":
                      break
                  # An idle with requires_action waits on your client, so keep reading.
                  # On any other stop reason, print it and stop.
                  if event.stop_reason.type not in ("end_turn", "requires_action"):
                      print(f"Session idle: {event.stop_reason.type}")
                      break
              case "session.status_terminated":
                  break
  ```

  ```typescript TypeScript
  const openRuns = new Map<string, string>(); // workflow_run_id -> run name
  const phaseNames = new Map<string, string>(); // "run ID:phase ID" -> phase name

  // Open the stream first, then send the user message
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Which contracts in /contracts have a change-of-control clause?"
          }
        ]
      }
    ]
  });

  events: for await (const event of stream) {
    switch (event.type) {
      case "workflow_run.created":
        openRuns.set(event.workflow_run_id, event.name);
        for (const phase of event.phases) {
          phaseNames.set(`${event.workflow_run_id}:${phase.id}`, phase.name);
        }
        console.log(`Run started: ${event.name}`);
        break;
      case "workflow_run.phase_started": {
        const phaseId = event.workflow_run_phase_id;
        const phaseName = phaseNames.get(`${event.workflow_run_id}:${phaseId}`);
        console.log(`  Phase: ${phaseName ?? phaseId}`);
        break;
      }
      case "workflow_run.status_ended": {
        const name = openRuns.get(event.workflow_run_id) ?? event.workflow_run_id;
        openRuns.delete(event.workflow_run_id);
        console.log(`Run ended: ${name} (${event.result.type})`);
        break;
      }
      case "agent.custom_tool_use": {
        // Answer when the event arrives. A run's thread can wait on your
        // client while the session stays running.
        const result = await callTool(event.name, event.input);
        try {
          await client.beta.sessions.events.send(sessionId, {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: event.id,
                content: [{ type: "text", text: result }]
              }
            ]
          });
        } catch (error) {
          // The server refuses a result that comes too late, after it
          // archived the call's thread. Keep following the run.
          if (!(error instanceof Anthropic.BadRequestError)) {
            throw error;
          }
          console.log(`  Answer to ${event.name} refused: ${error.message}`);
        }
        break;
      }
      case "session.status_idle": {
        // Done when every run has ended and the agent has finished its turn
        const reason = event.stop_reason.type;
        if (openRuns.size === 0 && reason === "end_turn") {
          break events;
        }
        // An idle with requires_action waits on your client, so keep reading.
        // On any other stop reason, print it and stop.
        if (reason !== "end_turn" && reason !== "requires_action") {
          console.log(`Session idle: ${reason}`);
          break events;
        }
        break;
      }
      case "session.status_terminated":
        break events;
    }
  }
  ```

  ```csharp C#
  var openRuns = new Dictionary<string, string>(); // workflow_run_id -> run name
  var phaseNames = new Dictionary<(string, string), string>(); // (run ID, phase ID) -> phase name

  // Open the stream first, then send the user message. The raw-response call
  // opens the stream now. The plain call would wait for the first read.
  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(sessionId);
  await client.Beta.Sessions.Events.Send(sessionId, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock
                  {
                      Text = "Which contracts in /contracts have a change-of-control clause?",
                  },
              ],
          },
      ],
  });

  await foreach (var streamEvent in stream.Enumerate())
  {
      if (streamEvent.Value is BetaManagedAgentsWorkflowRunCreatedEvent created)
      {
          openRuns[created.WorkflowRunID] = created.Name;
          foreach (var listed in created.Phases)
          {
              phaseNames[(created.WorkflowRunID, listed.ID)] = listed.Name;
          }
          Console.WriteLine($"Run started: {created.Name}");
      }
      else if (streamEvent.Value is BetaManagedAgentsWorkflowRunPhaseStartedEvent phase)
      {
          var phaseId = phase.WorkflowRunPhaseID;
          var key = (phase.WorkflowRunID, phaseId);
          Console.WriteLine($"  Phase: {phaseNames.GetValueOrDefault(key, phaseId)}");
      }
      else if (streamEvent.Value is BetaManagedAgentsWorkflowRunStatusEndedEvent ended)
      {
          var name = openRuns.GetValueOrDefault(ended.WorkflowRunID, ended.WorkflowRunID);
          openRuns.Remove(ended.WorkflowRunID);
          var outcome = ended.Result.Value switch
          {
              BetaManagedAgentsWorkflowRunResultCompleted => "completed",
              BetaManagedAgentsWorkflowRunResultStopped => "stopped",
              BetaManagedAgentsWorkflowRunResultError => "error",
              _ => "ended",
          };
          Console.WriteLine($"Run ended: {name} ({outcome})");
      }
      else if (streamEvent.Value is BetaManagedAgentsAgentCustomToolUseEvent toolUse)
      {
          // Answer when the event arrives. A run's thread can wait on your
          // client while the session stays running.
          var result = await CallTool(toolUse.Name, toolUse.Input);
          try
          {
              await client.Beta.Sessions.Events.Send(sessionId, new()
              {
                  Events =
                  [
                      new BetaManagedAgentsUserCustomToolResultEventParams
                      {
                          CustomToolUseID = toolUse.ID,
                          Content = [new BetaManagedAgentsTextBlock { Text = result }],
                      },
                  ],
              });
          }
          catch (AnthropicBadRequestException error)
          {
              // The server refuses a result that comes too late, after it
              // archived the call's thread. Keep following the run.
              Console.WriteLine($"  Answer to {toolUse.Name} refused: {error.Message}");
          }
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent idle)
      {
          // Done when every run has ended and the agent has finished its turn
          var finished = idle.StopReason?.Value is BetaManagedAgentsSessionEndTurn;
          if (openRuns.Count == 0 && finished)
          {
              break;
          }
          // An idle with requires_action waits on your client, so keep reading.
          // On any other stop reason, print it and stop.
          if (!finished && idle.StopReason?.Value is not BetaManagedAgentsSessionRequiresAction)
          {
              var reason = idle.StopReason?.Json.GetProperty("type").GetString();
              Console.WriteLine($"Session idle: {reason}");
              break;
          }
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusTerminatedEvent)
      {
          break;
      }
  }
  ```

  ```go Go
  	openRuns := map[string]string{}      // workflow_run_id -> run name
  	phaseNames := map[[2]string]string{} // {run ID, phase ID} -> phase name

  	// Open the stream first, then send the user message
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, sessionID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  	if _, err := client.Beta.Sessions.Events.Send(ctx, sessionID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "Which contracts in /contracts have a change-of-control clause?",
  					},
  				}},
  			},
  		}},
  	}); err != nil {
  		panic(err)
  	}

  events:
  	for stream.Next() {
  		switch event := stream.Current().AsAny().(type) {
  		case anthropic.BetaManagedAgentsWorkflowRunCreatedEvent:
  			openRuns[event.WorkflowRunID] = event.Name
  			for _, phase := range event.Phases {
  				phaseNames[[2]string{event.WorkflowRunID, phase.ID}] = phase.Name
  			}
  			fmt.Printf("Run started: %s\n", event.Name)
  		case anthropic.BetaManagedAgentsWorkflowRunPhaseStartedEvent:
  			phaseName, ok := phaseNames[[2]string{event.WorkflowRunID, event.WorkflowRunPhaseID}]
  			if !ok {
  				phaseName = event.WorkflowRunPhaseID
  			}
  			fmt.Printf("  Phase: %s\n", phaseName)
  		case anthropic.BetaManagedAgentsWorkflowRunStatusEndedEvent:
  			name, ok := openRuns[event.WorkflowRunID]
  			if !ok {
  				name = event.WorkflowRunID
  			}
  			delete(openRuns, event.WorkflowRunID)
  			fmt.Printf("Run ended: %s (%s)\n", name, event.Result.Type)
  		case anthropic.BetaManagedAgentsAgentCustomToolUseEvent:
  			// Answer when the event arrives. A run's thread can wait on your
  			// client while the session stays running.
  			result := callTool(event.Name, event.Input)
  			if _, err := client.Beta.Sessions.Events.Send(ctx, sessionID, anthropic.BetaSessionEventSendParams{
  				Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  					OfUserCustomToolResult: &anthropic.BetaManagedAgentsUserCustomToolResultEventParams{
  						CustomToolUseID: event.ID,
  						Content: []anthropic.BetaManagedAgentsUserCustomToolResultEventParamsContentUnion{{
  							OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  								Text: result,
  							},
  						}},
  					},
  				}},
  			}); err != nil {
  				// The server refuses a result that comes too late, after it
  				// archived the call's thread. Keep following the run.
  				var apiErr *anthropic.Error
  				if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusBadRequest {
  					panic(err)
  				}
  				fmt.Printf("  Answer to %s refused: %v\n", event.Name, err)
  			}
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			// Done when every run has ended and the agent has finished its turn
  			switch event.StopReason.AsAny().(type) {
  			case anthropic.BetaManagedAgentsSessionEndTurn:
  				if len(openRuns) == 0 {
  					break events
  				}
  			// An idle with requires_action waits on your client, so keep reading.
  			// On any other stop reason, print it and stop.
  			case anthropic.BetaManagedAgentsSessionRequiresAction:
  			default:
  				fmt.Printf("Session idle: %s\n", event.StopReason.Type)
  				break events
  			}
  		case anthropic.BetaManagedAgentsSessionStatusTerminatedEvent:
  			break events
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  ```

  ```java Java
  var openRuns = new HashMap<String, String>(); // workflow_run_id -> run name
  var phaseNames = new HashMap<String, String>(); // "run ID:phase ID" -> phase name

  // Open the stream first, then send the user message
  try (var stream = client.beta().sessions().events().streamStreaming(sessionId)) {
      client.beta().sessions().events().send(
          sessionId,
          EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                  .addTextContent("Which contracts in /contracts have a change-of-control clause?")
                  .build())
              .build()
      );

      Iterable<BetaManagedAgentsStreamSessionEvents> events = stream.stream()::iterator;
      events:
      for (var event : events) {
          switch (event.type().value()) {
              case WORKFLOW_RUN_CREATED -> {
                  var created = event.asWorkflowRunCreated();
                  openRuns.put(created.workflowRunId(), created.name());
                  created.phases().forEach(phase ->
                      phaseNames.put(created.workflowRunId() + ":" + phase.id(), phase.name()));
                  IO.println("Run started: " + created.name());
              }
              case WORKFLOW_RUN_PHASE_STARTED -> {
                  var started = event.asWorkflowRunPhaseStarted();
                  var phaseId = started.workflowRunPhaseId();
                  var key = started.workflowRunId() + ":" + phaseId;
                  IO.println("  Phase: " + phaseNames.getOrDefault(key, phaseId));
              }
              case WORKFLOW_RUN_STATUS_ENDED -> {
                  var ended = event.asWorkflowRunStatusEnded();
                  var name = openRuns.getOrDefault(ended.workflowRunId(), ended.workflowRunId());
                  openRuns.remove(ended.workflowRunId());
                  var result = ended.result();
                  var outcome = result.isCompleted() ? "completed"
                      : result.isStopped() ? "stopped"
                      : result.isError() ? "error"
                      : "ended";
                  IO.println("Run ended: " + name + " (" + outcome + ")");
              }
              case AGENT_CUSTOM_TOOL_USE -> {
                  // Answer when the event arrives. A run's thread can wait on your
                  // client while the session stays running.
                  var toolUse = event.asAgentCustomToolUse();
                  var result = callTool(toolUse.name(), toolUse.input());
                  try {
                      client.beta().sessions().events().send(
                          sessionId,
                          EventSendParams.builder()
                              .addEvent(BetaManagedAgentsUserCustomToolResultEventParams.builder()
                                  .customToolUseId(toolUse.id())
                                  .addTextContent(result)
                                  .build())
                              .build());
                  } catch (BadRequestException e) {
                      // The server refuses a result that comes too late, after it
                      // archived the call's thread. Keep following the run.
                      IO.println("  Answer to " + toolUse.name() + " refused: " + e.getMessage());
                  }
              }
              case SESSION_STATUS_IDLE -> {
                  // Done when every run has ended and the agent has finished its turn
                  var stopReason = event.asSessionStatusIdle().stopReason();
                  if (openRuns.isEmpty() && stopReason.isEndTurn()) {
                      break events;
                  }
                  // An idle with requires_action waits on your client, so keep reading.
                  // On any other stop reason, print it and stop.
                  if (!stopReason.isEndTurn() && !stopReason.isRequiresAction()) {
                      IO.println("Session idle: " + stopReason.type().asString());
                      break events;
                  }
              }
              case SESSION_STATUS_TERMINATED -> {
                  break events;
              }
              default -> {}
          }
      }
  }
  ```

  ```php PHP
  $openRuns = []; // workflow_run_id => run name
  $phaseNames = []; // run ID => [phase ID => phase name]

  // Open the stream first, then send the user message
  $stream = $client->beta->sessions->events->streamStream($sessionId);
  $client->beta->sessions->events->send(
      $sessionId,
      events: [
          [
              'type' => 'user.message',
              'content' => [
                  ['type' => 'text', 'text' => 'Which contracts in /contracts have a change-of-control clause?'],
              ],
          ],
      ],
  );

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsWorkflowRunCreatedEvent:
              $openRuns[$event->workflowRunID] = $event->name;
              foreach ($event->phases as $phase) {
                  $phaseNames[$event->workflowRunID][$phase->id] = $phase->name;
              }
              echo "Run started: {$event->name}", PHP_EOL;
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsWorkflowRunPhaseStartedEvent:
              $phaseId = $event->workflowRunPhaseID;
              echo '  Phase: ', $phaseNames[$event->workflowRunID][$phaseId] ?? $phaseId, PHP_EOL;
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsWorkflowRunStatusEndedEvent:
              $name = $openRuns[$event->workflowRunID] ?? $event->workflowRunID;
              unset($openRuns[$event->workflowRunID]);
              echo "Run ended: {$name} ({$event->result->type})", PHP_EOL;
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsAgentCustomToolUseEvent:
              // Answer when the event arrives. A run's thread can wait on your
              // client while the session stays running.
              $result = callTool($event->name, $event->input);
              try {
                  $client->beta->sessions->events->send(
                      $sessionId,
                      events: [
                          [
                              'type' => 'user.custom_tool_result',
                              'custom_tool_use_id' => $event->id,
                              'content' => [['type' => 'text', 'text' => $result]],
                          ],
                      ],
                  );
              } catch (\Anthropic\Core\Exceptions\BadRequestException $error) {
                  // The server refuses a result that comes too late, after it
                  // archived the call's thread. Keep following the run.
                  echo "  Answer to {$event->name} refused: {$error->getMessage()}", PHP_EOL;
              }
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent:
              // Done when every run has ended and the agent has finished its turn
              $finished = $event->stopReason->type === 'end_turn';
              if (!$openRuns && $finished) {
                  break 2;
              }
              // An idle with requires_action waits on your client, so keep reading.
              // On any other stop reason, print it and stop.
              if (!$finished && $event->stopReason->type !== 'requires_action') {
                  echo "Session idle: {$event->stopReason->type}", PHP_EOL;
                  break 2;
              }
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusTerminatedEvent:
              break 2;
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  open_runs = {} # workflow_run_id => run name
  phase_names = {} # [run ID, phase ID] => phase name

  # Open the stream first, then send the user message
  stream = client.beta.sessions.events.stream_events(session_id)

  client.beta.sessions.events.send_(
    session_id,
    events: [{
      type: "user.message",
      content: [{type: "text", text: "Which contracts in /contracts have a change-of-control clause?"}]
    }]
  )

  stream.each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsWorkflowRunCreatedEvent
      open_runs[event.workflow_run_id] = event.name
      event.phases.each { |phase| phase_names[[event.workflow_run_id, phase.id]] = phase.name }
      puts "Run started: #{event.name}"
    when Anthropic::Beta::Sessions::BetaManagedAgentsWorkflowRunPhaseStartedEvent
      phase_id = event.workflow_run_phase_id
      puts "  Phase: #{phase_names.fetch([event.workflow_run_id, phase_id], phase_id)}"
    when Anthropic::Beta::Sessions::BetaManagedAgentsWorkflowRunStatusEndedEvent
      name = open_runs.delete(event.workflow_run_id) || event.workflow_run_id
      puts "Run ended: #{name} (#{event.result.type})"
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentCustomToolUseEvent
      # Answer when the event arrives. A run's thread can wait on your
      # client while the session stays running.
      result = call_tool.call(event.name, event.input)
      begin
        client.beta.sessions.events.send_(
          session_id,
          events: [{
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{type: "text", text: result}]
          }]
        )
      rescue Anthropic::Errors::BadRequestError => error
        # The server refuses a result that comes too late, after it archived
        # the call's thread. Keep following the run.
        puts "  Answer to #{event.name} refused: #{error.message}"
      end
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      reason = event.stop_reason.type.to_sym
      # Done when every run has ended and the agent has finished its turn
      break if open_runs.empty? && reason == :end_turn
      # An idle with requires_action waits on your client, so keep reading.
      # On any other stop reason, print it and stop.
      unless %i[end_turn requires_action].include?(reason)
        puts "Session idle: #{reason}"
        break
      end
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusTerminatedEvent
      break
    end
  end
  ```
</CodeGroup>

## Interrupt a session with runs open

Send [`user.interrupt`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent) with no `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`), or with the primary thread’s ID. It stops the agent’s turn. It ends no run. The session’s runs might pause or keep running, and their events might not show which. A paused run’s lifetime keeps passing, so the run can end with `timeout_error` while it’s paused.

* **Waiting tool calls:** After the interrupt, a run thread’s tool call might still wait on your client. Answer each one. To cancel a call that asks for confirmation, deny it. To cancel a custom tool call, send a result with `is_error` (java, php: `isError`; csharp, go: `IsError`) set to `true` and a text in `content` (csharp, go: `Content`) that says why. While the session is `idle` with `requires_action`, a `user.message` returns 400, so answer the calls first.
* **To stop the runs:** Send a `user.message` asking the agent to stop its runs. A stopped run ends with `result` `{"type": "stopped"}`. While the session is `idle` with `budget_reached`, a `user.message` returns 400 until you raise or remove the budget. Raising or removing it also resumes the runs that the budget paused, unless the interrupt also paused them.
* **To continue:** Send a `user.message` asking the agent to continue its runs. After an interrupt, the runs might wait for this message. If the session is `idle` with `budget_reached`, raise or remove the budget first.
* **Run results:** A run that ends after the interrupt still sends `workflow_run.status_ended`.

## While a run is open

| Request                                                     | While a run is open                                                                                                                                                                                                                                                                                 | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive or delete the session                               | Might return 400 while a run is open, whatever the session’s status. The error’s `error.details.error_code` can be `"workflow_run_open"`. Might also succeed.                                                                                                                                       | Ask the agent to stop its runs, or wait until each run has ended. A paused run ends by itself only when its lifetime passes. Then send the request once the session is `idle`. An archive that succeeds ends each open run with `{"type": "stopped"}`. After an archive, a run’s `workflow_run.status_ended`, and the `workflow_run.phase_ended` of a phase that was still open, don’t arrive on the stream. List the session’s events to read them. After a delete that succeeds, no `workflow_run` event reports the end of the session’s runs.                                                                                                                                                                                                                                                                                                                             |
| Archive one of a run’s threads                              | Returns 400 with `error.details.error_code: "workflow_run_open"` while the run is open, running or idle, unless the server has already archived the thread.                                                                                                                                         | Nothing. The server archives a run’s threads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Update the session’s `agent` (csharp, go: `Agent`)          | Returns 400 with `error.details.error_code: "workflow_run_open"` while any run is open, even a paused one. Updating the underlying agent is still accepted, and the session keeps its own copy. A request that also sends other fields, such as `budget` (csharp, go: `Budget`), is rejected whole. | Wait until every run has its `workflow_run.status_ended`, or ask the agent to stop its runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Answer a tool call or tool confirmation from a run’s thread | Allowed. It arrives on the primary stream, and its `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`) names the thread.                                                                                                                           | Answer as soon as the event arrives, passing the event’s `id` (csharp, go: `ID`) as `tool_use_id` (java: `toolUseId`; php: `toolUseID`; csharp, go: `ToolUseID`) or `custom_tool_use_id` (java: `customToolUseId`; php: `customToolUseID`; csharp, go: `CustomToolUseID`). Don’t wait for `session.status_idle`: the session can stay `running` while the run’s other threads work. Once the server has archived the thread, a tool result for one of its calls has no effect, and it can return 400. When a tool result returns 400, find the call’s thread in the thread list. If its status is `terminated`, the result came too late, so drop it. Send each tool result in a request of its own, because the server refuses a whole request when it refuses one of its events. A tool confirmation that comes too late returns 200, which doesn’t mean that the tool ran. |

### Rebuild run state after you reconnect

Rebuild each run’s state from the session’s events. The stream doesn’t replay what you missed: a new connection delivers only events emitted after it opened. So list the events with a `types` (curl: `types[]`; cli: `--type`; csharp, go: `Types`) filter, one entry for each event type, as in [List past events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#list-past-events). Pass each response’s `next_page` (ruby: `next_page_`; java, php: `nextPage`; csharp, go: `NextPage`) as `page` (cli: `--page`; csharp, go: `Page`) until `next_page` (ruby: `next_page_`; java, php: `nextPage`; csharp, go: `NextPage`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) or missing. `workflow_run.created`, `workflow_run.status_running`, `workflow_run.status_idle`, and `workflow_run.status_ended` give each run’s state, except that a run paused after an interrupt might still show as running. `workflow_run.phase_started` and `workflow_run.phase_ended` rebuild progress. A run with no status event yet hasn’t started running. No endpoint lists runs.

## Cost and budgets

A run’s model requests count toward the [session’s budget](https://platform.claude.com/docs/en/managed-agents/budgets). A run has no price of its own. The tokens its agents use are billed like the session’s other tokens, at each model’s rates. For all of a session’s charges, see [Claude Managed Agents pricing](https://platform.claude.com/docs/en/about-claude/pricing#claude-managed-agents-pricing).

* **One run’s usage:** List the session’s threads and add up the token counts in `usage` (csharp, go: `Usage`) of the threads with the run’s `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`). The list includes archived threads, whose status is `terminated`, so a finished run’s threads are counted. Pass each response’s `next_page` (ruby: `next_page_`; java, php: `nextPage`; csharp, go: `NextPage`) as `page` (cli: `--page`; csharp, go: `Page`) until `next_page` (ruby: `next_page_`; java, php: `nextPage`; csharp, go: `NextPage`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) or missing, and skip a thread with no `usage` (csharp, go: `Usage`). If you add up the threads’ `list_cost` (java, php: `listCost`; csharp, go: `ListCost`) instead, the total leaves out session runtime, and each figure is rounded separately.
* **At the budget:** Every open run pauses, and the session reports `idle` with `budget_reached`, or `requires_action` if a tool call is also waiting. Each thread completes the model request it already started, so a run can pass the budget by one request for each working thread. Raising or removing the budget resumes the runs it paused, unless an interrupt also paused them. If the session’s usage includes a model with no list price, only removing the budget does; see [Models without a list price](https://platform.claude.com/docs/en/managed-agents/budgets#models-without-a-list-price). A paused run’s lifetime keeps passing, so the run can end with `timeout_error` while it’s paused.

## Limits

| Limit                                              | Value                                               | At the limit                                                                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threads working at once in one run                 | 64                                                  | The run creates no more until one finishes. The API doesn’t guarantee this number.                                                                                                                                         |
| Agents a workflow starts over the run’s whole life | 1,000                                               | When the workflow asks for more, the server doesn’t start another agent, and the run ends with `thread_limit_error`. The server can run a failed agent again on a new thread, so a run might have more than 1,000 threads. |
| Run lifetime                                       | 24 hours by default, or the lifetime the agent sets | The run ends with `timeout_error`. No event says what lifetime the agent set.                                                                                                                                              |
| Runs open at once in a session                     | 10 by default                                       | The server refuses to start another run. The agent’s tool call gets an error, and you get a `workflow_run.error` whose `error.type` is `max_workflow_runs_error`. Idle runs count toward the limit.                        |

The server shortens a run’s or phase’s `name` (csharp, go: `Name`) to 64 characters and its `description` (csharp, go: `Description`) to 256. The server has other limits on workflows, and rules for them, that aren’t listed here. What you see depends on when the server finds the problem:

| What happens                                                                                       | What you see                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The workflow is over one of the other limits when the agent starts the run                         | The start is refused. You get a `workflow_run.error`, and no run.              |
| The run goes over one of the other limits later                                                    | You get a `workflow_run.error`, and then the run can end with `unknown_error`. |
| The server finds after the start that the workflow breaks a rule for workflows, other than a limit | You get a `workflow_run.error`, and the run can then end with `program_error`. |

A session can start any number of runs over its life.

* **Starting runs:** Only the agent on the session’s primary thread starts runs. An agent working in a run’s thread can’t start a run of its own, so runs don’t nest.
* **Ending runs:** No event you send ends a run; archiving the session can.
* **A run’s threads:** You can’t [stop a thread by its ID](https://platform.claude.com/docs/en/managed-agents/session-threads#interrupt-a-session-thread), or archive one while its run is open.
* **Thread limit:** A run’s threads are exempt from the session’s [child-thread limit](https://platform.claude.com/docs/en/managed-agents/session-threads#primary-thread-and-session-threads).
* **Visibility:** You don’t see the workflow’s code, but you can ask the agent for the workflow, as the tip in [A run’s threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads) describes. You also don’t see the tool calls the agent makes to start and manage runs, or the result each thread returns to the workflow.

### Rate limits

A run’s work counts toward rate limits that your organization already has.

| What                                                                                  | Counts toward                                                                                                                                      | What to do                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Your client’s requests to retrieve or list the session, its threads, and their events | The read limit for [Managed Agents endpoints](https://platform.claude.com/docs/en/managed-agents/reference#rate-limits)                            | Follow a run on the session’s event stream instead of polling.                                                                                  |
| Model requests from a run’s threads                                                   | Your [Messages API rate limits](https://platform.claude.com/docs/en/api/rate-limits) for the model each thread uses, along with your other traffic | Leave room for a run in those limits, or [request higher limits](https://platform.claude.com/docs/en/api/rate-limits#requesting-higher-limits). |

When a model request from one of a run’s threads is rate limited, or the model is overloaded, the thread’s own stream can get a `session.error` of type `model_rate_limited_error` or `model_overloaded_error`:

* If its `retry_status.type` is `retrying`, the server is retrying the request, and the thread is still working.
* If it’s `exhausted`, the thread has failed. If the workflow lets that failure end the run, the run ends with `program_error`, which doesn’t name the cause. Read the failed threads’ events to find it.

The server also limits how much all of your organization’s sessions do each minute. A thread that meets this limit stops, with a `session.error` on its own stream whose message names a rate limit. Wait a minute before you ask the agent to continue.

## Availability

Dynamic workflows are available on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

| Status    | Cloud platforms         |
| --------- | ----------------------- |
| Available | All supported platforms |

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
