---
title: Session threads
url: https://platform.claude.com/docs/en/managed-agents/session-threads
description: List, interrupt, and archive the threads of a multiagent session, read their events, and handle tool permissions across them.
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

In a [multiagent session](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration), each agent works in its own **session thread**. This page covers how to list, interrupt, and archive threads, the events they send, and how tool permissions work across them. A [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs) creates session threads too.

## Primary thread and session threads

The **session-level event stream** (`/v1/sessions/{session_id}/events/stream`) is considered the **primary thread**, containing a condensed view of all activity across all threads. You don’t see the full activity from [subagents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#delegate-to-subagents), but you do see the start and end of their work, and blocking events such as tool permission requests.

**Session threads** are where you examine a specific agent’s activity.

The session `status` (csharp, go: `Status`) is an aggregation of all agent activity; if at least one thread is `running`, then the overall session status is `running` as well. A [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs) that’s running can keep the session `running` too, even while none of its threads is working. When no thread is working and a thread waits on your client, the session is `idle`; see [Know when the work is done](https://platform.claude.com/docs/en/managed-agents/workflow-runs#know-when-the-work-is-done).

A [session budget](https://platform.claude.com/docs/en/managed-agents/budgets) is a single shared cap across all of a session’s threads. As the cap is reached, threads pause independently, and each thread’s cost is priced at the thread’s own served model.

<Note>
  A session can have at most 25 child threads at a time. Idle threads count until you archive them, and the primary thread doesn’t count. The primary thread’s agent can call multiple copies of a single subagent, creating multiple threads associated with one `agent`. [Advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor) consultation threads are exempt from this limit. So are a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs)’s threads.
</Note>

## List threads

List all threads associated with a session as follows:

<CodeGroup>
  ```bash cURL
  curl -fsS "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions:threads list --session-id "$SESSION_ID"
  ```

  ```python Python
  for thread in client.beta.sessions.threads.list(session.id):
      agent = thread.agent
      label = agent.type if agent.type == "advisor" else agent.name
      print(f"[{label}] {thread.status}")
  ```

  ```typescript TypeScript
  for await (const thread of client.beta.sessions.threads.list(session.id)) {
    const label = thread.agent.type === "advisor" ? thread.agent.type : thread.agent.name;
    console.log(`[${label}] ${thread.status}`);
  }
  ```

  ```csharp C#
  await foreach (var sessionThread in (await client.Beta.Sessions.Threads.List(session.ID)).Paginate())
  {
      var label = sessionThread.Agent.Name ?? sessionThread.Agent.Json.GetProperty("type").GetString();
      Console.WriteLine($"[{label}] {sessionThread.Status.Raw()}");
  }
  ```

  ```go Go
  threads := client.Beta.Sessions.Threads.ListAutoPaging(ctx, session.ID, anthropic.BetaSessionThreadListParams{})
  for threads.Next() {
  	thread := threads.Current()
  	label := cmp.Or(thread.Agent.Name, thread.Agent.Type)
  	fmt.Printf("[%s] %s\n", label, thread.Status)
  }
  if err := threads.Err(); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  for (var thread : client.beta().sessions().threads().list(session.id()).autoPager()) {
      var agent = thread.agent();
      var label = agent.isAgent() ? agent.asAgent().name() : agent.type().asString();
      IO.println("[" + label + "] " + thread.status());
  }
  ```

  ```php PHP
  foreach ($client->beta->sessions->threads->list($session->id)->pagingEachItem() as $thread) {
      $label = $thread->agent instanceof \Anthropic\Beta\Agents\BetaManagedAgentsAdvisor
          ? $thread->agent->type
          : $thread->agent->name;
      echo "[{$label}] {$thread->status}\n";
  }
  ```

  ```ruby Ruby
  client.beta.sessions.threads.list(session.id).auto_paging_each do |thread|
    agent = thread.agent
    label = agent.type == :advisor ? agent.type : agent.name
    puts "[#{label}] #{thread.status}"
  end
  ```
</CodeGroup>

The full list includes the primary thread. `parent_thread_id` (java: `parentThreadId`; php: `parentThreadID`; csharp, go: `ParentThreadID`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) for the primary thread. Every other thread is a child thread. `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `""`) except on [a run’s threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads).

To list only threads that have certain statuses, add `statuses[]` to the request, and repeat it to give more than one status, as in `?statuses[]=running&statuses[]=idle`. Leave it out to return threads of every status.

## Interrupt a session thread

Send `user.interrupt` with `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`) to stop a specific thread. Omitting `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`) interrupts every non-archived thread in the session, including the primary. In a session with dynamic workflows, an interrupt ends no run, and one that names a run’s thread stops nothing. An interrupt closes other child threads’ pending tool calls, but don’t rely on it to close a run thread’s. See [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open).

<CodeGroup>
  ```bash cURL
  curl -fsS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {"type": "user.interrupt", "session_thread_id": "'"$THREAD_ID"'"}
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions:events send \
    --session-id "$SESSION_ID" \
    --event "{type: user.interrupt, session_thread_id: $THREAD_ID}"
  ```

  ```python Python
  client.beta.sessions.events.send(
      session.id,
      events=[{"type": "user.interrupt", "session_thread_id": thread.id}],
  )
  ```

  ```typescript TypeScript
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.interrupt", session_thread_id: thread.id }]
  });
  ```

  ```csharp C#
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events = [new BetaManagedAgentsUserInterruptEventParams { SessionThreadID = thread.ID }],
  });
  ```

  ```go Go
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfUserInterrupt: &anthropic.BetaManagedAgentsUserInterruptEventParams{
  			SessionThreadID: anthropic.String(thread.ID),
  		},
  	}},
  }); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().sessions().events().send(
      session.id(),
      EventSendParams.builder()
          .addEvent(BetaManagedAgentsUserInterruptEventParams.builder()
              .sessionThreadId(thread.id())
              .build())
          .build());
  ```

  ```php PHP
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          ['type' => 'user.interrupt', 'session_thread_id' => $thread->id],
      ],
  );
  ```

  ```ruby Ruby
  client.beta.sessions.events.send_(
    session.id,
    events: [{type: "user.interrupt", session_thread_id: thread.id}]
  )
  ```
</CodeGroup>

Against a subagent’s thread blocked on `requires_action`, the interrupt closes each pending tool call with an error tool result (“Tool execution was interrupted before completion. Please retry.”) and re-emits `session.thread_status_idle` with `stop_reason: end_turn` directly; the model is not sampled. Against a child thread that’s idle with `end_turn` or `budget_reached`, the interrupt is a no-op. An interrupt that names a terminated thread returns a 400 error. An interrupted child doesn’t send the primary thread’s agent the report it sends when a turn ends. While that agent waits on the child, it doesn’t start another turn until something else reaches it, such as a `user.message` or another thread’s report.

## Archive a session thread

Optionally archive a session thread when it has completed its work. Archiving a thread frees its place under the 25-child-thread limit. The server archives a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs)’s threads itself. You don’t need to archive them, and you can’t while the run is open.

<CodeGroup>
  ```bash cURL
  curl -fsS -X POST "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads/$THREAD_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions:threads archive \
    --session-id "$SESSION_ID" \
    --thread-id "$THREAD_ID"
  ```

  ```python Python
  archived = client.beta.sessions.threads.archive(thread.id, session_id=session.id)
  print(archived.status, archived.archived_at)
  ```

  ```typescript TypeScript
  const archived = await client.beta.sessions.threads.archive(thread.id, {
    session_id: session.id
  });
  console.log(archived.status, archived.archived_at);
  ```

  ```csharp C#
  var archived = await client.Beta.Sessions.Threads.Archive(thread.ID, new() { SessionID = session.ID });
  Console.WriteLine($"{archived.Status} {archived.ArchivedAt}");
  ```

  ```go Go
  archived, err := client.Beta.Sessions.Threads.Archive(ctx, thread.ID, anthropic.BetaSessionThreadArchiveParams{
  	SessionID: session.ID,
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(archived.Status, archived.ArchivedAt)
  ```

  ```java Java
  var archived = client.beta().sessions().threads().archive(
      thread.id(),
      ThreadArchiveParams.builder()
          .sessionId(session.id())
          .build());
  IO.println(archived.status() + " " + archived.archivedAt().orElseThrow());
  ```

  ```php PHP
  $archived = $client->beta->sessions->threads->archive($thread->id, sessionID: $session->id);
  echo "{$archived->status} {$archived->archivedAt->format(DATE_ATOM)}\n";
  ```

  ```ruby Ruby
  archived = client.beta.sessions.threads.archive(thread.id, session_id: session.id)
  puts "#{archived.status} #{archived.archived_at}"
  ```
</CodeGroup>

Archive only succeeds if the thread is `idle`. A thread parked on `requires_action` counts as idle, so you can archive it directly. To archive a running thread, interrupt it first:

<CodeGroup>
  ```bash cURL
  # Interrupt the thread, then archive it
  curl -fsS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {"type": "user.interrupt", "session_thread_id": "'"$THREAD_ID"'"}
      ]
    }'

  curl -fsS -X POST "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads/$THREAD_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions:events send \
    --session-id "$SESSION_ID" \
    --event "{type: user.interrupt, session_thread_id: $THREAD_ID}"

  ant beta:sessions:threads archive \
    --session-id "$SESSION_ID" \
    --thread-id "$THREAD_ID"
  ```

  ```python Python
  client.beta.sessions.events.send(
      session.id,
      events=[{"type": "user.interrupt", "session_thread_id": thread.id}],
  )
  archived = client.beta.sessions.threads.archive(thread.id, session_id=session.id)
  print(archived.status, archived.archived_at)
  ```

  ```typescript TypeScript
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.interrupt", session_thread_id: thread.id }]
  });
  const archived = await client.beta.sessions.threads.archive(thread.id, {
    session_id: session.id
  });
  console.log(archived.status, archived.archived_at);
  ```

  ```csharp C#
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events = [new BetaManagedAgentsUserInterruptEventParams { SessionThreadID = thread.ID }],
  });
  archived = await client.Beta.Sessions.Threads.Archive(thread.ID, new() { SessionID = session.ID });
  Console.WriteLine($"{archived.Status} {archived.ArchivedAt}");
  ```

  ```go Go
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfUserInterrupt: &anthropic.BetaManagedAgentsUserInterruptEventParams{
  			SessionThreadID: anthropic.String(thread.ID),
  		},
  	}},
  }); err != nil {
  	panic(err)
  }

  archived, err := client.Beta.Sessions.Threads.Archive(ctx, thread.ID, anthropic.BetaSessionThreadArchiveParams{
  	SessionID: session.ID,
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(archived.Status, archived.ArchivedAt)
  ```

  ```java Java
  client.beta().sessions().events().send(
      session.id(),
      EventSendParams.builder()
          .addEvent(BetaManagedAgentsUserInterruptEventParams.builder()
              .sessionThreadId(thread.id())
              .build())
          .build());

  archived = client.beta().sessions().threads().archive(
      thread.id(),
      ThreadArchiveParams.builder()
          .sessionId(session.id())
          .build());
  IO.println(archived.status() + " " + archived.archivedAt().orElseThrow());
  ```

  ```php PHP
  $client->beta->sessions->events->send(
      $session->id,
      events: [['type' => 'user.interrupt', 'session_thread_id' => $thread->id]],
  );
  $archived = $client->beta->sessions->threads->archive($thread->id, sessionID: $session->id);
  echo "{$archived->status} {$archived->archivedAt->format(DATE_ATOM)}\n";
  ```

  ```ruby Ruby
  client.beta.sessions.events.send_(
    session.id,
    events: [{type: "user.interrupt", session_thread_id: thread.id}]
  )
  archived = client.beta.sessions.threads.archive(thread.id, session_id: session.id)
  puts "#{archived.status} #{archived.archived_at}"
  ```
</CodeGroup>

## Primary thread events

These events surface multiagent activity on the primary thread at `/v1/sessions/{session_id}/events/stream`. Message-direction events are named relative to the thread whose stream they appear on: `agent.thread_message_received` means a message arrived on this thread from another thread, and `agent.thread_message_sent` means this thread sent one. The task that the primary thread’s agent delegates, for example, arrives on the child’s own stream as an `agent.thread_message_received` event.

| Type                               | Description                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.thread_created`           | A thread was created. Includes `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`) and `agent_name` (java, php: `agentName`; csharp, go: `AgentName`).                                                                                                                                     |
| `session.thread_status_running`    | A thread started activity.                                                                                                                                                                                                                                                                                                                  |
| `session.thread_status_idle`       | The agent associated with the thread is awaiting input. Includes a `stop_reason` (java, php: `stopReason`; csharp, go: `StopReason`) indicating why the agent stopped.                                                                                                                                                                      |
| `session.thread_status_terminated` | A thread terminated and accepts no further input, for example because it was archived or encountered an unrecoverable error. An advisor thread also terminates when its consultation ends.                                                                                                                                                  |
| `agent.thread_message_received`    | On the primary thread, a subagent sent the primary thread’s agent a report or question. Includes `from_session_thread_id` (java: `fromSessionThreadId`; php: `fromSessionThreadID`; csharp, go: `FromSessionThreadID`), `from_agent_name` (java, php: `fromAgentName`; csharp, go: `FromAgentName`), and `content` (csharp, go: `Content`). |
| `agent.thread_message_sent`        | On the primary thread, the primary thread’s agent sent a subagent a task or follow-up message. Includes `to_session_thread_id` (java: `toSessionThreadId`; php: `toSessionThreadID`; csharp, go: `ToSessionThreadID`), `to_agent_name` (java, php: `toAgentName`; csharp, go: `ToAgentName`), and `content` (csharp, go: `Content`).        |

Advisor consultations emit these same thread events under the reserved name `anthropic.advisor` (as `agent_name` (java, php: `agentName`; csharp, go: `AgentName`) on the thread lifecycle events and `from_agent_name` (java, php: `fromAgentName`; csharp, go: `FromAgentName`) on the advice delivery); see [Give the session an advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor) for the sequence.

A [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs)’s threads show on the primary stream as follows:

* **Lifecycle events:** Each run thread sends `session.thread_created`, with the run’s `workflow_run_id` (java: `workflowRunId`; php: `workflowRunID`; csharp, go: `WorkflowRunID`), and its `session.thread_status_running`, `session.thread_status_idle`, and `session.thread_status_terminated` events.
* **Message events:** A run thread’s prompt, an `agent.thread_message_received` event, stays on its own stream.
* **Run events:** `workflow_run.*` events also arrive on this stream; see [Run events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events).
* **Tool calls that wait on you:** A run thread’s tool calls that need your client are cross-posted to this stream, as for any child thread. See [Tool permissions and custom tools](https://platform.claude.com/docs/en/managed-agents/session-threads#tool-permissions-and-custom-tools).

## Session thread events

Critical events are proxied to the primary thread. However, you might still want to investigate a specific agent’s reasoning and tool calls. To do so, stream or list the events from the associated session thread.

Each session thread has its own event stream at `/v1/sessions/{session_id}/threads/{thread_id}/stream`, and it accepts the same `event_deltas[]` parameter as the session-level stream, so you can preview a subagent’s text as the model generates it. A connection previews only the thread it’s reading: a child thread’s previews never appear on the session-level stream, so to watch a subagent live, open its own thread stream. See [Preview session thread events](https://platform.claude.com/docs/en/managed-agents/event-deltas#preview-session-thread-events) for opting in, accumulating, and reconciling previews.

In a workflow run, the server runs a workflow: a program that the primary thread’s agent writes. On each of the run’s threads, the first `agent.thread_message_received` is the prompt that the workflow wrote. Its `from_session_thread_id` (java: `fromSessionThreadId`; php: `fromSessionThreadID`; csharp, go: `FromSessionThreadID`) is the primary thread’s ID, and the API doesn’t set its `from_agent_name` (java, php: `fromAgentName`; csharp, go: `FromAgentName`). The API doesn’t guarantee the prompt’s text, so don’t parse it. The thread’s `session.thread_status_terminated` event, on the primary thread’s stream, tells you the thread is done. No event records the result it returned to the workflow.

A thread’s stream doesn’t replay earlier events. Right after `session.thread_created`, the event list of a run’s thread can be empty, because the server writes the thread’s first event after it. So open the thread’s stream first, then list the thread’s events, and skip each streamed event whose `id` (csharp, go: `ID`) the list returned.

<Tabs>
  <Tab title="Stream session thread events">
    <CodeGroup>
      ```bash cURL
      curl -fsSN "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads/$THREAD_ID/stream?beta=true" \
        -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: managed-agents-2026-04-01"
      ```

      ```bash CLI
      ant beta:sessions:threads:events stream \
        --session-id "$SESSION_ID" \
        --thread-id "$THREAD_ID"
      ```

      ```python Python
      with client.beta.sessions.threads.events.stream(
          thread.id,
          session_id=session.id,
      ) as stream:
          for event in stream:
              match event.type:
                  case "agent.message":
                      for block in event.content:
                          if block.type == "text":
                              print(block.text, end="")
                  case "session.thread_status_idle":
                      break
      ```

      ```typescript TypeScript
      const stream = await client.beta.sessions.threads.events.stream(thread.id, {
        session_id: session.id
      });

      loop: for await (const event of stream) {
        switch (event.type) {
          case "agent.message":
            for (const block of event.content) {
              if (block.type === "text") {
                process.stdout.write(block.text);
              }
            }
            break;
          case "session.thread_status_idle":
            break loop;
        }
      }
      ```

      ```csharp C#
      await foreach (var evt in client.Beta.Sessions.Threads.Events.StreamStreaming(thread.ID, new() { SessionID = session.ID }))
      {
          if (evt.Value is BetaManagedAgentsAgentMessageEvent message)
          {
              foreach (var block in message.Content)
              {
                  if (block.Value is BetaManagedAgentsTextBlock textBlock)
                  {
                      Console.Write(textBlock.Text);
                  }
              }
          }
          else if (evt.Value is BetaManagedAgentsSessionThreadStatusIdleEvent)
          {
              break;
          }
      }
      ```

      ```go Go
      	stream := client.Beta.Sessions.Threads.Events.StreamEvents(ctx, thread.ID, anthropic.BetaSessionThreadEventStreamParams{
      		SessionID: session.ID,
      	})
      	defer stream.Close()

      loop:
      	for stream.Next() {
      		event := stream.Current()
      		switch event.Type {
      		case "agent.message":
      			for _, block := range event.AsAgentMessage().Content {
      				if block.Type == "text" {
      					fmt.Print(block.Text)
      				}
      			}
      		case "session.thread_status_idle":
      			break loop
      		}
      	}
      	if err := stream.Err(); err != nil {
      		panic(err)
      	}
      ```

      ```java Java
      try (var streamResponse = client.beta().sessions().threads().events().streamStreaming(
          thread.id(),
          EventStreamParams.builder()
              .sessionId(session.id())
              .build()
      )) {
          loop:
          for (var event : (Iterable<BetaManagedAgentsStreamSessionThreadEvents>) streamResponse.stream()::iterator) {
              switch (event.type().value()) {
                  case AGENT_MESSAGE -> {
                      for (var block : event.asAgentMessage().content()) {
                          block.text().ifPresent(textBlock -> IO.print(textBlock.text()));
                      }
                  }
                  case SESSION_THREAD_STATUS_IDLE -> {
                      break loop;
                  }
              }
          }
      }
      ```

      ```php PHP
      $stream = $client->beta->sessions->threads->events->streamStream(
          $thread->id,
          sessionID: $session->id,
      );

      foreach ($stream as $event) {
          switch (true) {
              case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent:
                  foreach ($event->content as $block) {
                      if ($block instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock) {
                          echo $block->text;
                      }
                  }
                  break;
              case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionThreadStatusIdleEvent:
                  break 2;
          }
      }
      ```

      ```ruby Ruby
      client.beta.sessions.threads.events.stream_events(thread.id, session_id: session.id).each do |event|
        case event
        when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
          event.content.each do |block|
            print block.text if block.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsTextBlock)
          end
        when Anthropic::Beta::Sessions::BetaManagedAgentsSessionThreadStatusIdleEvent
          break
        end
      end
      ```
    </CodeGroup>
  </Tab>

  <Tab title="List session thread events">
    List all past session thread events to pull a complete history.

    <CodeGroup>
      ```bash cURL
      curl -fsS "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads/$THREAD_ID/events" \
        -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: managed-agents-2026-04-01"
      ```

      ```bash CLI
      ant beta:sessions:threads:events list \
        --session-id "$SESSION_ID" \
        --thread-id "$THREAD_ID"
      ```

      ```python Python
      for event in client.beta.sessions.threads.events.list(
          thread.id,
          session_id=session.id,
      ):
          print(f"[{event.type}] {event.processed_at}")
      ```

      ```typescript TypeScript
      for await (const event of client.beta.sessions.threads.events.list(thread.id, {
        session_id: session.id
      })) {
        console.log(`[${event.type}] ${event.processed_at}`);
      }
      ```

      ```csharp C#
      var page = await client.Beta.Sessions.Threads.Events.List(thread.ID, new() { SessionID = session.ID });
      await foreach (var evt in page.Paginate())
      {
          Console.WriteLine($"[{evt.Json.GetProperty("type").GetString()}] {evt.ProcessedAt}");
      }
      ```

      ```go Go
      pager := client.Beta.Sessions.Threads.Events.ListAutoPaging(ctx, thread.ID, anthropic.BetaSessionThreadEventListParams{
      	SessionID: session.ID,
      })
      for pager.Next() {
      	event := pager.Current()
      	fmt.Printf("[%s] %s\n", event.Type, event.ProcessedAt)
      }
      if err := pager.Err(); err != nil {
      	panic(err)
      }
      ```

      ```java Java
      for (var event : client.beta().sessions().threads().events().list(
              thread.id(),
              EventListParams.builder()
                  .sessionId(session.id())
                  .build()
      ).autoPager()) {
          var type = event._json().orElseThrow() instanceof JsonObject json
              ? json.values().get("type").asStringOrThrow()
              : "unknown";
          var processedAt = event.processedAt().map(OffsetDateTime::toString).orElse("pending");
          IO.println("[" + type + "] " + processedAt);
      }
      ```

      ```php PHP
      foreach (
          $client->beta->sessions->threads->events->list(
              $thread->id,
              sessionID: $session->id,
          )->pagingEachItem() as $event
      ) {
          echo "[{$event->type}] {$event->processedAt->format(DATE_RFC3339)}\n";
      }
      ```

      ```ruby Ruby
      client.beta.sessions.threads.events.list(
        thread.id,
        session_id: session.id
      ).auto_paging_each do |event|
        puts "[#{event.type}] #{event.processed_at}"
      end
      ```
    </CodeGroup>
  </Tab>
</Tabs>

## Tool permissions and custom tools

If a subagent needs something from your client, such as [permission](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#tool-confirmation) to run a tool call or the [result of a custom tool](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#handling-custom-tool-calls), the event is cross-posted to the **primary thread** with `session_thread_id` identifying the originating session thread. A tool call needs your permission under `always_ask`, or under [`auto`](https://platform.claude.com/docs/en/managed-agents/permission-policies#let-the-server-evaluate-each-call-with-auto) when the server reaches no determination.

```json
{
  "type": "session.thread_status_idle",
  "id": "sevt_01ABC...",
  "session_thread_id": "sthr_01DEF...",
  "agent_name": "code-reviewer",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["sevt_01XYZ..."]
  }
}
```

Post `user.tool_confirmation` (with `tool_use_id` (java: `toolUseId`; php: `toolUseID`; csharp, go: `ToolUseID`)) or `user.custom_tool_result` (with `custom_tool_use_id` (java: `customToolUseId`; php: `customToolUseID`; csharp, go: `CustomToolUseID`)); the server routes the response to the correct thread automatically. The response can appear on the primary thread and on the subagent’s thread with different `id` (csharp, go: `ID`) values. To match the two copies, compare `type` (csharp, go: `Type`) and `tool_use_id` (java: `toolUseId`; php: `toolUseID`; csharp, go: `ToolUseID`) (or `custom_tool_use_id` (java: `customToolUseId`; php: `customToolUseID`; csharp, go: `CustomToolUseID`)), not `id` (csharp, go: `ID`).

The session goes `idle` only when no thread is `running`, so `session.status_idle` can arrive long after a subagent’s call. You don’t have to wait for it: send the `user.custom_tool_result` as soon as the cross-posted `agent.custom_tool_use` event arrives.

Under `auto`, your `user.message` events can lead the server to allow a call it would otherwise deny. Nothing in a subagent’s thread counts as your intent. Your client posts no messages there, and the messages that the primary thread’s agent sends the subagent don’t count. When the server denies a call under `auto`, nothing is cross-posted: the event and the error tool result appear only on the subagent’s own [thread stream](https://platform.claude.com/docs/en/managed-agents/session-threads#session-thread-events), and the subagent keeps running.

The following example goes inside the event loop of the [tool confirmation handler](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#tool-confirmation). For each ID in `stop_reason.event_ids`, it sends a `user.tool_confirmation` that allows the call. The same pattern applies to `user.custom_tool_result`, which you can also send as soon as its `agent.custom_tool_use` event arrives.

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  for event_id in stop.event_ids:
      client.beta.sessions.events.send(
          session.id,
          events=[
              {
                  "type": "user.tool_confirmation",
                  "tool_use_id": event_id,
                  "result": "allow",
              }
          ],
      )
  ```

  ```typescript TypeScript
  for (const eventId of stop.event_ids) {
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: eventId,
          result: "allow"
        }
      ]
    });
  }
  ```

  ```csharp C#
  foreach (var eventId in requiresAction.EventIds)
  {
      await client.Beta.Sessions.Events.Send(session.ID, new()
      {
          Events =
          [
              new BetaManagedAgentsUserToolConfirmationEventParams
              {
                  ToolUseID = eventId,
                  Result = BetaManagedAgentsUserToolConfirmationEventParamsResult.Allow,
              },
          ],
      });
  }
  ```

  ```go Go
  for _, eventID := range stopReason.EventIDs {
  	params := anthropic.BetaManagedAgentsUserToolConfirmationEventParams{
  		ToolUseID: eventID,
  		Result:    anthropic.BetaManagedAgentsUserToolConfirmationEventParamsResultAllow,
  	}
  	if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{OfUserToolConfirmation: &params}},
  	}); err != nil {
  		panic(err)
  	}
  }
  ```

  ```java Java
  for (var eventId : pendingToolUseIds) {
      client.beta().sessions().events().send(
          session.id(),
          EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserToolConfirmationEventParams.builder()
                  .toolUseId(eventId)
                  .result(BetaManagedAgentsUserToolConfirmationEventParams.Result.ALLOW)
                  .build())
              .build()
      );
  }
  ```

  ```php PHP
  foreach ($event->stopReason->eventIDs as $eventId) {
      $client->beta->sessions->events->send($session->id, events: [[
          'type' => 'user.tool_confirmation',
          'tool_use_id' => $eventId,
          'result' => 'allow',
      ]]);
  }
  ```

  ```ruby Ruby
  event_ids.each do |event_id|
    client.beta.sessions.events.send_(session.id, events: [{
      type: "user.tool_confirmation",
      tool_use_id: event_id,
      result: "allow"
    }])
  end
  ```
</CodeGroup>

The previous pattern answers the calls that an idle event lists. On the primary stream, a subagent’s `session.thread_status_idle` event can arrive before the `agent.tool_use` or `agent.mcp_tool_use` events that its `stop_reason.event_ids` lists. A `user.tool_confirmation` for a call whose event hasn’t arrived yet can return 400. To avoid that, answer each call whose [`evaluated_permission` (java, php: `evaluatedPermission`; csharp, go: `EvaluatedPermission`)](https://platform.claude.com/docs/en/managed-agents/permission-policies#see-how-each-call-was-evaluated) is `ask` when its own event arrives on the primary stream.

## Availability

Session threads are available on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Always on

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
