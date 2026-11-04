---
title: Session event stream
url: https://platform.claude.com/docs/en/managed-agents/events-and-streaming
description: Send events, stream responses, and interrupt or redirect your session while it runs.
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

Communication with Claude Managed Agents is event-based. You open a stream to follow a session, send events to direct it, and answer it when it pauses for input.

## Event types

Events flow in two directions: you send events to the agent, and the session sends events back to you.

* **Events you send:** `user.*` events start a session and steer it as it progresses. [`system.message`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#send-system-messages) events append system-level context.
* **Events you receive:** Session events, span events, and agent events report the session’s state and the agent’s progress.

These event type strings follow a `{domain}.{action}` naming convention. See [Event types](https://platform.claude.com/docs/en/managed-agents/reference#event-types) in the reference for the full catalog.

[Webhook event types](https://platform.claude.com/docs/en/managed-agents/webhooks#supported-event-types) are separate, and some of their names differ from the stream’s. For example, webhooks use `session.status_idled` rather than `session.status_idle`.

## Stream events

Stream events from the session to receive real-time updates as the agent works. A stream delivers only the events emitted after it opens, so open the stream before you send events to avoid a race condition.

<CodeGroup>
  ```bash cURL
  # Open the stream before you send the first event: only later events are delivered.
  curl --fail-with-body -sS -N \
    "https://api.anthropic.com/v1/sessions/$SESSION_ID/events/stream?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "accept: text/event-stream"
  ```

  ```bash CLI
  # Open the stream before you send the first event: only later events are delivered.
  ant beta:sessions:events stream --session-id "$SESSION_ID"
  ```

  ```python Python
  # Open the stream first, then send the user message
  with client.beta.sessions.events.stream(session.id) as stream:
      client.beta.sessions.events.send(
          session.id,
          events=[
              {
                  "type": "user.message",
                  "content": [{"type": "text", "text": "Summarize the repo README"}],
              },
          ],
      )

      for event in stream:
          match event.type:
              case "agent.message":
                  for block in event.content:
                      if block.type == "text":
                          print(block.text, end="")
              case "session.status_idle":
                  break
              case "session.error":
                  error_message = event.error.message if event.error else "unknown"
                  print(f"\n[Error: {error_message}]")
                  break
  ```

  ```typescript TypeScript
  // Open the stream first, then send the user message
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Summarize the repo README" }]
      }
    ]
  });

  events: for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
        break;
      case "session.status_idle":
        break events;
      case "session.error":
        console.log(`\n[Error: ${event.error?.message ?? "unknown"}]`);
        break events;
    }
  }
  ```

  ```csharp C#
  // Open the stream first, then send the user message
  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(session.ID);
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content = [new BetaManagedAgentsTextBlock { Text = "Summarize the repo README" }],
          },
      ],
  });

  await foreach (var streamEvent in stream.Enumerate())
  {
      if (streamEvent.Value is BetaManagedAgentsAgentMessageEvent message)
      {
          foreach (var block in message.Content)
          {
              if (block.Value is BetaManagedAgentsTextBlock textBlock)
              {
                  Console.Write(textBlock.Text);
              }
          }
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent)
      {
          break;
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionErrorEvent error)
      {
          Console.WriteLine($"\n[Error: {error.Error?.Message ?? "unknown"}]");
          break;
      }
  }
  ```

  ```go Go
  	// Open the stream first, then send the user message
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  	if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "Summarize the repo README",
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
  		case anthropic.BetaManagedAgentsAgentMessageEvent:
  			// concrete-typed list: BetaManagedAgentsTextBlock
  			for _, block := range event.Content {
  				fmt.Print(block.Text)
  			}
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			break events
  		case anthropic.BetaManagedAgentsSessionErrorEvent:
  			fmt.Printf("\n[Error: %s]\n", cmp.Or(event.Error.Message, "unknown"))
  			break events
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  ```

  ```java Java
  // Open the stream first, then send the user message
  try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
      client.beta().sessions().events().send(
          session.id(),
          EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                  .addTextContent("Summarize the repo README")
                  .build())
              .build()
      );

      Iterable<BetaManagedAgentsStreamSessionEvents> events = stream.stream()::iterator;
      events:
      for (var event : events) {
          switch (event.type().value()) {
              case AGENT_MESSAGE -> event.asAgentMessage().content().forEach(block -> block.text().ifPresent(textBlock -> IO.print(textBlock.text())));
              case SESSION_STATUS_IDLE -> {
                  break events;
              }
              case SESSION_ERROR -> {
                  // The `message` field spans all error variants; read it from the raw JSON.
                  var errorMessage =
                      event.asSessionError().error()._json().orElse(null) instanceof JsonObject json
                          ? json.values().get("message").asStringOrThrow()
                          : "unknown";
                  IO.println("\n[Error: " + errorMessage + "]");
                  break events;
              }
          }
      }
  }
  ```

  ```php PHP
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionErrorEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;

  // Open the stream first, then send the user message
  $stream = $client->beta->sessions->events->streamStream($session->id);
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => 'Summarize the repo README']],
          ],
      ],
  );

  foreach ($stream as $event) {
      match (true) {
          $event instanceof ManagedAgentsAgentMessageEvent => array_walk(
              $event->content,
              static fn ($block) => $block instanceof ManagedAgentsTextBlock ? print($block->text) : null,
          ),
          $event instanceof ManagedAgentsSessionErrorEvent => printf("\n[Error: %s]", $event->error?->message ?? 'unknown'),
          default => null,
      };
      if ($event->type === 'session.status_idle' || $event->type === 'session.error') {
          break;
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  # Open the stream first, then send the user message
  stream = client.beta.sessions.events.stream_events(session.id)

  client.beta.sessions.events.send_(
    session.id,
    events: [{
      type: "user.message",
      content: [{type: "text", text: "Summarize the repo README"}]
    }]
  )

  stream.each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      event.content.each { print it.text }
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      break
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionErrorEvent
      puts "\n[Error: #{event.error&.message || "unknown"}]"
      break
    else
      # ignore other event types
    end
  end
  ```
</CodeGroup>

The session reports errors through the `session.error` event. See [Event types](https://platform.claude.com/docs/en/managed-agents/reference#event-types) for its fields.

The agent’s response text arrives as buffered `agent.message` events, each emitted only after the model request that produced it completes. To render the text while the model is still generating it, see [Preview responses with event deltas](https://platform.claude.com/docs/en/managed-agents/event-deltas).

### Reconnect without missing events

To reconnect to an existing session without missing events, combine a new stream with the event history:

1. Open a new stream.
2. [List the full event history](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#list-past-events) to seed a set of seen event IDs.
3. Tail the live stream, skipping any events already returned by the history list.

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  with client.beta.sessions.events.stream(session.id) as stream:
      # Stream is open and buffering. List history before tailing live.
      history = client.beta.sessions.events.list(session.id)
      seen_event_ids = {past_event.id for past_event in history}

      # Tail live events, skipping anything already seen
      for event in stream:
          if event.type == "event_start" or event.type == "event_delta":
              # Delta previews aren't enabled on this connection.
              continue
          if event.id in seen_event_ids:
              continue
          seen_event_ids.add(event.id)
          match event.type:
              case "agent.message":
                  for block in event.content:
                      if block.type == "text":
                          print(block.text, end="")
              case "session.status_idle":
                  break
  ```

  ```typescript TypeScript
  const seenEventIds = new Set<string>();
  const stream = await client.beta.sessions.events.stream(session.id);

  // Stream is open and buffering. List history before tailing live.
  for await (const event of client.beta.sessions.events.list(session.id)) {
    seenEventIds.add(event.id);
  }

  // Tail live events, skipping anything already seen
  tail: for await (const event of stream) {
    // Preview events (event_start/event_delta) carry no top-level `id`
    if (event.type === "event_start" || event.type === "event_delta") {
      continue;
    }
    if (seenEventIds.has(event.id)) {
      continue;
    }
    seenEventIds.add(event.id);
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
        break;
      case "session.status_idle":
        break tail;
    }
  }
  ```

  ```csharp C#
  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(session.ID);

  // Stream is open and buffering. List history before tailing live.
  HashSet<string> seenEventIds = [];
  var history = await client.Beta.Sessions.Events.List(session.ID);
  await foreach (var pastEvent in history.Paginate())
  {
      seenEventIds.Add(pastEvent.ID);
  }

  // Tail live events, skipping anything already seen
  await foreach (var streamEvent in stream.Enumerate())
  {
      if (!seenEventIds.Add(streamEvent.ID))
      {
          continue;
      }
      if (streamEvent.Value is BetaManagedAgentsAgentMessageEvent message)
      {
          foreach (var block in message.Content)
          {
              if (block.Value is BetaManagedAgentsTextBlock textBlock)
              {
                  Console.Write(textBlock.Text);
              }
          }
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent)
      {
          break;
      }
  }
  ```

  ```go Go
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  	// Stream is open and buffering. List history before tailing live.
  	seenEventIDs := map[string]struct{}{}
  	history := client.Beta.Sessions.Events.ListAutoPaging(ctx, session.ID, anthropic.BetaSessionEventListParams{})
  	for history.Next() {
  		seenEventIDs[history.Current().ID] = struct{}{}
  	}
  	if err := history.Err(); err != nil {
  		panic(err)
  	}

  	// Tail live events, skipping anything already seen
  tail:
  	for stream.Next() {
  		event := stream.Current()
  		if _, seen := seenEventIDs[event.ID]; seen {
  			continue
  		}
  		seenEventIDs[event.ID] = struct{}{}
  		switch event := event.AsAny().(type) {
  		case anthropic.BetaManagedAgentsAgentMessageEvent:
  			// concrete-typed list: BetaManagedAgentsTextBlock
  			for _, block := range event.Content {
  				fmt.Print(block.Text)
  			}
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			break tail
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  ```

  ```java Java
  try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
      // Stream is open and buffering. List history before tailing live.
      // Every event variant carries `id`; read it from the raw JSON to dedup across variants.
      var seenEventIds = new HashSet<String>();
      for (var pastEvent : client.beta().sessions().events().list(session.id()).autoPager()) {
          if (pastEvent._json().orElseThrow() instanceof JsonObject json) {
              seenEventIds.add(json.values().get("id").asStringOrThrow());
          }
      }

      // Tail live events; Set.add returns false for already-seen IDs, skipping the replay.
      stream.stream()
          .filter(event -> event._json().orElseThrow() instanceof JsonObject json
              && seenEventIds.add(json.values().get("id").asStringOrThrow()))
          .takeWhile(event -> !event.isSessionStatusIdle())
          .filter(BetaManagedAgentsStreamSessionEvents::isAgentMessage)
          .forEach(event -> event.asAgentMessage().content()
              .forEach(block -> block.text().ifPresent(textBlock -> IO.print(textBlock.text()))));
  }
  ```

  ```php PHP
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;

  $stream = $client->beta->sessions->events->streamStream($session->id);

  // Stream is open and buffering. List history before tailing live.
  $seenEventIds = [];
  foreach ($client->beta->sessions->events->list($session->id)->pagingEachItem() as $event) {
      $seenEventIds[$event->id] = true;
  }

  // Tail live events, skipping anything already seen
  foreach ($stream as $event) {
      if (isset($seenEventIds[$event->id])) {
          continue;
      }
      $seenEventIds[$event->id] = true;
      match (true) {
          $event instanceof ManagedAgentsAgentMessageEvent => array_walk(
              $event->content,
              static fn ($block) => $block instanceof ManagedAgentsTextBlock ? print($block->text) : null,
          ),
          default => null,
      };
      if ($event->type === 'session.status_idle') {
          break;
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  stream = client.beta.sessions.events.stream_events(session.id)

  # Stream is open and buffering. List history before tailing live.
  seen_event_ids = Set.new
  client.beta.sessions.events.list(session.id).auto_paging_each { seen_event_ids << it.id }

  # Tail live events, skipping anything already seen (Set#add? returns nil for duplicates)
  stream.each do |event|
    next unless seen_event_ids.add?(event.id)
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      event.content.each { print it.text }
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      break
    else
      # ignore other event types
    end
  end
  ```
</CodeGroup>

## Send events

Send a `user.message` event to start or continue the agent’s work:

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {
          "type": "user.message",
          "content": [
            {"type": "text", "text": "Analyze the performance of the sort function in utils.py"}
          ]
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions:events send --session-id "$SESSION_ID" <<'YAML'
  events:
    - type: user.message
      content:
        - type: text
          text: Analyze the performance of the sort function in utils.py
  YAML
  ```

  ```python Python
  client.beta.sessions.events.send(
      session.id,
      events=[
          {
              "type": "user.message",
              "content": [
                  {
                      "type": "text",
                      "text": "Analyze the performance of the sort function in utils.py",
                  },
              ],
          },
      ],
  )
  ```

  ```typescript TypeScript
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Analyze the performance of the sort function in utils.py"
          }
        ]
      }
    ]
  });
  ```

  ```csharp C#
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock
                  {
                      Text = "Analyze the performance of the sort function in utils.py",
                  },
              ],
          },
      ],
  });
  ```

  ```go Go
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  			Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  				OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  					Text: "Analyze the performance of the sort function in utils.py",
  				},
  			}},
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
          .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
              .addTextContent("Analyze the performance of the sort function in utils.py")
              .build())
          .build());
  ```

  ```php PHP
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [
                  [
                      'type' => 'text',
                      'text' => 'Analyze the performance of the sort function in utils.py',
                  ],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  client.beta.sessions.events.send_(
    session.id,
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Analyze the performance of the sort function in utils.py"
          }
        ]
      }
    ]
  )
  ```
</CodeGroup>

Every event in the session’s history includes a `processed_at` (java, php: `processedAt`; csharp, go: `ProcessedAt`) timestamp, set when the event finishes processing. On events you send, `processed_at` (java, php: `processedAt`; csharp, go: `ProcessedAt`) is `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `time.Time{}`) while the event is still queued behind earlier events. The exceptions are `user.define_outcome`, `user.custom_tool_result`, and `user.tool_result`, which are processed on receipt and echoed back with `processed_at` (java, php: `processedAt`; csharp, go: `ProcessedAt`) already populated.

## Respond when the session goes idle

A `session.status_idle` event means the agent has stopped and is waiting for input. Its `stop_reason.type` says why:

| `stop_reason.type` | Why the session stopped                                                                                                                            | What to do                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `end_turn`         | The agent finished its turn, or [you interrupted it](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent). | [Send a `user.message`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#resume-an-idle-session) when you have more work for the agent. |
| `requires_action`  | One or more tool calls need an answer from you, such as a custom tool call or a confirmation request.                                              | [Answer each blocking tool call](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#answer-tool-calls-that-pause-the-session).            |
| `budget_reached`   | The session’s tracked list cost reached its [budget](https://platform.claude.com/docs/en/managed-agents/budgets).                                  | [Change or remove the budget](https://platform.claude.com/docs/en/managed-agents/budgets#resume-a-session-at-its-budget).                                      |

No event you send resumes a session paused at its budget. The work that the budget paused resumes automatically when you change the budget to a value above the consumed list cost, or remove it. When the work resumes, the session emits a `workflow_run.status_running` event for each [workflow run that the budget paused](https://platform.claude.com/docs/en/managed-agents/workflow-runs#budgets-and-limits). A run that an interrupt paused stays paused; see [Resume a session at its budget](https://platform.claude.com/docs/en/managed-agents/budgets#resume-a-session-at-its-budget). See [When a session reaches its budget](https://platform.claude.com/docs/en/managed-agents/budgets#when-a-session-reaches-its-budget) for the events that mark the pause and the events the session still accepts.

## Answer tool calls that pause the session

A session pauses when the agent calls a [custom tool](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools), and when a tool call needs your confirmation under a [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies). Both pauses follow the same sequence:

1. The session emits the tool call as an `agent.custom_tool_use`, `agent.tool_use`, or `agent.mcp_tool_use` event.
2. The session pauses with a `session.status_idle` event whose `stop_reason.type` is `requires_action`. The blocking event IDs are in the `stop_reason.event_ids` array.
3. For each blocking event ID, send a [`user.custom_tool_result`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#return-a-custom-tool-result) or a [`user.tool_confirmation`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#confirm-a-tool-call) event. A custom tool result doesn’t have to wait for step 2.
4. Once all blocking events are resolved, the session transitions back to `running`.

In a multiagent session, a subagent’s blocking events are cross-posted to the primary thread. See [Tool permissions and custom tools](https://platform.claude.com/docs/en/managed-agents/session-threads#tool-permissions-and-custom-tools).

### Return a custom tool result

The `agent.custom_tool_use` event contains the tool name and input. Run the tool in your system. Then send a `user.custom_tool_result` event, passing the event ID in the `custom_tool_use_id` (java: `customToolUseId`; php: `customToolUseID`; csharp, go: `CustomToolUseID`) parameter along with the result content.

You can send the result as soon as the `agent.custom_tool_use` event arrives, without waiting for `session.status_idle`. The session still emits `session.status_idle` with a `requires_action` stop reason for the call, and your client can ignore it. A second result for the same call is accepted and has no effect.

When you [reconnect](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#reconnect-without-missing-events) to a paused session, `stop_reason.event_ids` on the latest `session.status_idle` event lists the calls to answer.

The following example answers each call as it arrives:

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  with client.beta.sessions.events.stream(session.id) as stream:
      for event in stream:
          match event.type:
              case "agent.custom_tool_use":
                  result = call_tool(event.name, event.input)

                  client.beta.sessions.events.send(
                      session.id,
                      events=[
                          {
                              "type": "user.custom_tool_result",
                              "custom_tool_use_id": event.id,
                              "content": [{"type": "text", "text": result}],
                          },
                      ],
                  )
              case "session.status_idle":
                  if event.stop_reason and event.stop_reason.type == "end_turn":
                      break
  ```

  ```typescript TypeScript
  const stream = await client.beta.sessions.events.stream(session.id);

  loop: for await (const event of stream) {
    switch (event.type) {
      case "agent.custom_tool_use": {
        const result = await callTool(event.name, event.input);

        await client.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: result }]
            }
          ]
        });
        break;
      }
      case "session.status_idle":
        if (event.stop_reason.type === "end_turn") {
          break loop;
        }
        break;
    }
  }
  ```

  ```csharp C#
  await foreach (var streamEvent in client.Beta.Sessions.Events.StreamStreaming(session.ID))
  {
      if (streamEvent.Value is BetaManagedAgentsAgentCustomToolUseEvent toolUse)
      {
          var result = await CallTool(toolUse.Name, toolUse.Input);

          await client.Beta.Sessions.Events.Send(session.ID, new()
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
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent idle
          && idle.StopReason?.Value is BetaManagedAgentsSessionEndTurn)
      {
          break;
      }
  }
  ```

  ```go Go
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  loop:
  	for stream.Next() {
  		switch event := stream.Current().AsAny().(type) {
  		case anthropic.BetaManagedAgentsAgentCustomToolUseEvent:
  			result := callTool(event.Name, event.Input)
  			if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
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
  				panic(err)
  			}
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			if _, ok := event.StopReason.AsAny().(anthropic.BetaManagedAgentsSessionEndTurn); ok {
  				break loop
  			}
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  ```

  ```java Java
  try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
      loop:
      for (var event : (Iterable<BetaManagedAgentsStreamSessionEvents>) stream.stream()::iterator) {
          switch (event.type().value()) {
              case AGENT_CUSTOM_TOOL_USE -> {
                  var toolUse = event.asAgentCustomToolUse();
                  var result = callTool(toolUse.name(), toolUse.input());

                  client.beta().sessions().events().send(
                      session.id(),
                      EventSendParams.builder()
                          .addEvent(BetaManagedAgentsUserCustomToolResultEventParams.builder()
                              .customToolUseId(toolUse.id())
                              .addTextContent(result)
                              .build())
                          .build());
              }
              case SESSION_STATUS_IDLE -> {
                  if (event.asSessionStatusIdle().stopReason().isEndTurn()) {
                      break loop;
                  }
              }
          }
      }
  }
  ```

  ```php PHP
  $stream = $client->beta->sessions->events->streamStream($session->id);

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsAgentCustomToolUseEvent:
              $result = callTool($event->name, $event->input);

              $client->beta->sessions->events->send(
                  $session->id,
                  events: [
                      [
                          'type' => 'user.custom_tool_result',
                          'custom_tool_use_id' => $event->id,
                          'content' => [['type' => 'text', 'text' => $result]],
                      ],
                  ],
              );
              break;
          case $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent:
              if ($event->stopReason instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionEndTurn) {
                  break 2;
              }
              break;
      }
  }
  ```

  ```ruby Ruby
  client.beta.sessions.events.stream_events(session.id).each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentCustomToolUseEvent
      result = call_tool.call(event.name, event.input)
      client.beta.sessions.events.send_(
        session.id,
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{type: "text", text: result}]
          }
        ]
      )
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      break if event.stop_reason.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsSessionEndTurn)
    end
  end
  ```
</CodeGroup>

If the agent has [workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs) open, a custom tool call can arrive while the session stays `running`. The `requires_action` idle event arrives only when none of the [session’s threads](https://platform.claude.com/docs/en/managed-agents/session-threads) is working. Don’t wait for it: answer each call when its `agent.custom_tool_use` event arrives. The sample in [Follow a run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#follow-a-run) shows how.

### Confirm a tool call

Send a `user.tool_confirmation` event, passing the event ID in the `tool_use_id` (java: `toolUseId`; php: `toolUseID`; csharp, go: `ToolUseID`) parameter. Set `result` (csharp, go: `Result`) to `"allow"` or `"deny"`. See [Respond to confirmation requests](https://platform.claude.com/docs/en/managed-agents/permission-policies#respond-to-confirmation-requests) for which calls wait for a confirmation and how to explain a denial.

The following example approves every pending call:

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  with client.beta.sessions.events.stream(session.id) as stream:
      for event in stream:
          if event.type == "session.status_idle" and (stop_reason := event.stop_reason):
              match stop_reason.type:
                  case "requires_action":
                      for event_id in stop_reason.event_ids:
                          client.beta.sessions.events.send(
                              session.id,
                              events=[
                                  {
                                      "type": "user.tool_confirmation",
                                      "tool_use_id": event_id,
                                      "result": "allow",
                                  },
                              ],
                          )
                  case "end_turn":
                      break
  ```

  ```typescript TypeScript
  const stream = await client.beta.sessions.events.stream(session.id);

  for await (const event of stream) {
    if (event.type !== "session.status_idle") {
      continue;
    }
    if (event.stop_reason.type === "end_turn") {
      break;
    }
    if (event.stop_reason.type !== "requires_action") {
      continue;
    }

    for (const eventId of event.stop_reason.event_ids) {
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
  }
  ```

  ```csharp C#
  await foreach (var streamEvent in client.Beta.Sessions.Events.StreamStreaming(session.ID))
  {
      if (streamEvent.Value is not BetaManagedAgentsSessionStatusIdleEvent idle) continue;

      if (idle.StopReason?.Value is BetaManagedAgentsSessionRequiresAction requiresAction)
      {
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
      }
      else if (idle.StopReason?.Value is BetaManagedAgentsSessionEndTurn)
      {
          break;
      }
  }
  ```

  ```go Go
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  loop:
  	for stream.Next() {
  		event, ok := stream.Current().AsAny().(anthropic.BetaManagedAgentsSessionStatusIdleEvent)
  		if !ok {
  			continue
  		}
  		switch stopReason := event.StopReason.AsAny().(type) {
  		case anthropic.BetaManagedAgentsSessionRequiresAction:
  			for _, eventID := range stopReason.EventIDs {
  				if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  					Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  						OfUserToolConfirmation: &anthropic.BetaManagedAgentsUserToolConfirmationEventParams{
  							ToolUseID: eventID,
  							Result:    anthropic.BetaManagedAgentsUserToolConfirmationEventParamsResultAllow,
  						},
  					}},
  				}); err != nil {
  					panic(err)
  				}
  			}
  		case anthropic.BetaManagedAgentsSessionEndTurn:
  			break loop
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  ```

  ```java Java
  try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
      stream.stream()
          .filter(BetaManagedAgentsStreamSessionEvents::isSessionStatusIdle)
          .map(idleEvent -> idleEvent.asSessionStatusIdle().stopReason())
          .takeWhile(stopReason -> !stopReason.isEndTurn())
          .filter(stopReason -> stopReason.isRequiresAction())
          .flatMap(stopReason -> stopReason.asRequiresAction().eventIds().stream())
          .forEach(toolUseId -> client.beta().sessions().events().send(
              session.id(),
              EventSendParams.builder()
                  .addEvent(BetaManagedAgentsUserToolConfirmationEventParams.builder()
                      .toolUseId(toolUseId)
                      .result(BetaManagedAgentsUserToolConfirmationEventParams.Result.ALLOW)
                      .build())
                  .build()));
  }
  ```

  ```php PHP
  $stream = $client->beta->sessions->events->streamStream($session->id);

  foreach ($stream as $event) {
      if ($event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent && $event->stopReason) {
          switch (true) {
              case $event->stopReason instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionRequiresAction:
                  foreach ($event->stopReason->eventIDs as $eventId) {
                      $client->beta->sessions->events->send(
                          $session->id,
                          events: [
                              [
                                  'type' => 'user.tool_confirmation',
                                  'tool_use_id' => $eventId,
                                  'result' => 'allow',
                              ],
                          ],
                      );
                  }
                  break;
              case $event->stopReason instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionEndTurn:
                  break 2;
          }
      }
  }
  ```

  ```ruby Ruby
  client.beta.sessions.events.stream_events(session.id).each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      stop_reason = event.stop_reason
      case stop_reason
      when Anthropic::Beta::Sessions::BetaManagedAgentsSessionRequiresAction
        stop_reason.event_ids.each do |event_id|
          client.beta.sessions.events.send_(
            session.id,
            events: [
              {type: "user.tool_confirmation", tool_use_id: event_id, result: "allow"}
            ]
          )
        end
      when Anthropic::Beta::Sessions::BetaManagedAgentsSessionEndTurn
        break
      end
    end
  end
  ```
</CodeGroup>

The previous example approves each call after the session goes idle. If the agent has [workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs) open, a tool call can wait for your confirmation while the session stays `running`. Don’t wait for the idle event: when an `agent.tool_use` or `agent.mcp_tool_use` event arrives whose [`evaluated_permission` (java, php: `evaluatedPermission`; csharp, go: `EvaluatedPermission`)](https://platform.claude.com/docs/en/managed-agents/permission-policies#see-how-each-call-was-evaluated) is `ask`, answer it. The sample in [Follow a run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#follow-a-run) answers custom tool calls this way, and its introduction says how to add confirmations.

## Resume an idle session

Sessions persist between interactions. To resume a session, send a `user.message` event to it as usual:

<CodeGroup>
  ```bash cURL
  # In production, pass the stored ID of the session you want to resume.
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {
          "type": "user.message",
          "content": [
            {"type": "text", "text": "Now run the tests against the changes you made earlier."}
          ]
        }
      ]
    }'
  ```

  ```bash CLI
  # In production, pass the stored ID of the session you want to resume.
  ant beta:sessions:events send --session-id "$SESSION_ID" <<'YAML'
  events:
    - type: user.message
      content:
        - type: text
          text: Now run the tests against the changes you made earlier.
  YAML
  ```

  ```python Python
  # Resume a previously created session by sending it a new user.message event.
  # In production, pass the stored ID of the session you want to resume.
  client.beta.sessions.events.send(
      session.id,
      events=[
          {
              "type": "user.message",
              "content": [
                  {
                      "type": "text",
                      "text": "Now run the tests against the changes you made earlier.",
                  },
              ],
          },
      ],
  )
  ```

  ```typescript TypeScript
  // Resume a previously created session by sending it a new user event.
  // In production, pass the stored ID of the session you want to resume.
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Now run the tests against the changes you made earlier."
          }
        ]
      }
    ]
  });
  ```

  ```csharp C#
  // Resume a previously created session by ID. In production, pass the
  // session ID you stored when the session was created.
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock
                  {
                      Text = "Now run the tests against the changes you made earlier.",
                  },
              ],
          },
      ],
  });
  ```

  ```go Go
  // Resume a previously created session by sending it a new user.message
  // event. In production, pass the stored ID of the session to resume.
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  			Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  				OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  					Text: "Now run the tests against the changes you made earlier.",
  				},
  			}},
  		},
  	}},
  }); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  // Resume a previously created session by ID. In production, pass the
  // session ID you stored when the session was created.
  client.beta().sessions().events().send(
      session.id(),
      EventSendParams.builder()
          .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
              .addTextContent("Now run the tests against the changes you made earlier.")
              .build())
          .build());
  ```

  ```php PHP
  // Resume a previously created session by sending it a new user.message event.
  // In production, pass the session ID you stored when the session was created.
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [
                  [
                      'type' => 'text',
                      'text' => 'Now run the tests against the changes you made earlier.',
                  ],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  # To resume a session, send it the next event. In production,
  # pass the session ID you stored when the session was created.
  client.beta.sessions.events.send_(
    session.id,
    events: [
      {
        type: "user.message",
        content: [
          {type: "text", text: "Now run the tests against the changes you made earlier."}
        ]
      }
    ]
  )
  ```
</CodeGroup>

Conversation history is preserved unless the session is explicitly deleted. When a session goes idle, its sandbox is checkpointed. The checkpoint preserves the full sandbox state, including the filesystem, installed packages, and any files the agent created.

<Note>
  Sandbox state is preserved for only 30 days after the sandbox is created, and activity does not extend this window. After 30 days the sandbox state (files, installed tools, and so on) is unrecoverable, and a resumed session starts from a fresh sandbox. If your workflow depends on sandbox contents, have the agent write important artifacts to [outputs](https://platform.claude.com/docs/en/managed-agents/define-outcomes#retrieving-deliverables) before the window ends.
</Note>

## Interrupt the agent

Send a `user.interrupt` event to stop the agent while it runs, then follow up with a `user.message` event to redirect it:

<CodeGroup>
  ```bash cURL
  # Agent is currently analyzing a file...
  # Interrupt with a new direction:
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {"type": "user.interrupt"},
        {
          "type": "user.message",
          "content": [
            {"type": "text", "text": "Instead, focus on fixing the bug in line 42."}
          ]
        }
      ]
    }'
  ```

  ```bash CLI
  # Agent is currently analyzing a file...
  # Interrupt with a new direction:
  ant beta:sessions:events send --session-id "$SESSION_ID" <<'YAML'
  events:
    - type: user.interrupt
    - type: user.message
      content:
        - type: text
          text: Instead, focus on fixing the bug in line 42.
  YAML
  ```

  ```python Python
  # Agent is currently analyzing a file...
  # Interrupt with a new direction:
  client.beta.sessions.events.send(
      session.id,
      events=[
          {"type": "user.interrupt"},
          {
              "type": "user.message",
              "content": [
                  {
                      "type": "text",
                      "text": "Instead, focus on fixing the bug in line 42.",
                  },
              ],
          },
      ],
  )
  ```

  ```typescript TypeScript
  // Agent is currently analyzing a file...
  // Interrupt with a new direction:
  await client.beta.sessions.events.send(session.id, {
    events: [
      { type: "user.interrupt" },
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Instead, focus on fixing the bug in line 42."
          }
        ]
      }
    ]
  });
  ```

  ```csharp C#
  // Agent is currently analyzing a file...
  // Interrupt with a new direction:
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserInterruptEventParams(),
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock
                  {
                      Text = "Instead, focus on fixing the bug in line 42.",
                  },
              ],
          },
      ],
  });
  ```

  ```go Go
  // Agent is currently analyzing a file...
  // Interrupt with a new direction:
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{
  		{
  			OfUserInterrupt: &anthropic.BetaManagedAgentsUserInterruptEventParams{},
  		},
  		{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "Instead, focus on fixing the bug in line 42.",
  					},
  				}},
  			},
  		},
  	},
  }); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  // Agent is currently analyzing a file...
  // Interrupt with a new direction:
  client.beta().sessions().events().send(
      session.id(),
      EventSendParams.builder()
          .addEvent(BetaManagedAgentsUserInterruptEventParams.builder().build())
          .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
              .addTextContent("Instead, focus on fixing the bug in line 42.")
              .build())
          .build());
  ```

  ```php PHP
  // Agent is currently analyzing a file...
  // Interrupt with a new direction:
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          ['type' => 'user.interrupt'],
          [
              'type' => 'user.message',
              'content' => [
                  [
                      'type' => 'text',
                      'text' => 'Instead, focus on fixing the bug in line 42.',
                  ],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  # Agent is currently analyzing a file...
  # Interrupt with a new direction:
  client.beta.sessions.events.send_(
    session.id,
    events: [
      {type: "user.interrupt"},
      {
        type: "user.message",
        content: [
          {type: "text", text: "Instead, focus on fixing the bug in line 42."}
        ]
      }
    ]
  )
  ```
</CodeGroup>

The call returns as soon as the events are queued. The interrupt then takes effect in this order:

1. The agent applies the interrupt. Until then, the interrupt’s `processed_at` (java, php: `processedAt`; csharp, go: `ProcessedAt`) stays `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `time.Time{}`) and the session stays `running`. A model response in progress stops immediately, but the interrupt can take longer to apply while tool calls are running.
2. The `user.interrupt` event appears on the stream, and the interrupted turn ends with a `session.status_idle` event.
3. The agent starts its next turn with the `user.message` you sent after the interrupt.

The idle event’s `stop_reason.type` is `end_turn`, the same value as a turn that completes on its own. If workflow runs are open, the interrupt ends none of them. A run that’s running can keep the session `running`, so the `session.status_idle` event in step 2 might not arrive. See [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open).

## List past events

Retrieve the full event history for a session:

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json"
  ```

  ```bash CLI
  ant beta:sessions:events list --session-id "$SESSION_ID" --format jsonl
  ```

  ```python Python
  events = client.beta.sessions.events.list(session.id)
  for event in events.data:
      print(f"[{event.type}] {event.processed_at}")
  ```

  ```typescript TypeScript
  const events = await client.beta.sessions.events.list(session.id);
  for (const event of events.data) {
    console.log(`[${event.type}] ${event.processed_at}`);
  }
  ```

  ```csharp C#
  var events = await client.Beta.Sessions.Events.List(session.ID);
  foreach (var sessionEvent in events.Items)
  {
      Console.WriteLine($"[{sessionEvent.Json.GetProperty("type").GetString()}] {sessionEvent.ProcessedAt}");
  }
  ```

  ```go Go
  events, err := client.Beta.Sessions.Events.List(ctx, session.ID, anthropic.BetaSessionEventListParams{})
  if err != nil {
  	panic(err)
  }
  for _, event := range events.Data {
  	fmt.Printf("[%s] %s\n", event.Type, event.ProcessedAt)
  }
  ```

  ```java Java
  var events = client.beta().sessions().events().list(session.id());
  for (var event : events.data()) {
      var eventJson = event._json().orElseThrow().convert(JsonNode.class);
      var processedAt = eventJson.path("processed_at");
      IO.println("[" + eventJson.get("type").asText() + "] "
          + (processedAt.isTextual() ? processedAt.asText() : "null"));
  }
  ```

  ```php PHP
  $events = $client->beta->sessions->events->list($session->id);
  foreach ($events->data as $event) {
      $processedAt = ($event->processedAt ?? null)?->format(DATE_RFC3339) ?? 'null';
      echo "[{$event->type}] {$processedAt}\n";
  }
  ```

  ```ruby Ruby
  events = client.beta.sessions.events.list(session.id)
  events.data.each { puts "[#{it.type}] #{it.processed_at}" }
  ```
</CodeGroup>

Pass a `types` (curl: `types[]`; cli: `--type`; csharp, go: `Types`) filter to return only specific event types:

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true&types[]=agent.tool_use&types[]=agent.tool_result" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions:events list --session-id "$SESSION_ID" \
    --type agent.tool_use --type agent.tool_result \
    --format jsonl
  ```

  ```python Python
  events = client.beta.sessions.events.list(
      session.id,
      types=["agent.tool_use", "agent.tool_result"],
  )
  for event in events.data:
      print(f"[{event.type}] {event.processed_at}")
  ```

  ```typescript TypeScript
  const events = await client.beta.sessions.events.list(session.id, {
    types: ["agent.tool_use", "agent.tool_result"]
  });
  for (const event of events.data) {
    console.log(`[${event.type}] ${event.processed_at}`);
  }
  ```

  ```csharp C#
  var events = await client.Beta.Sessions.Events.List(session.ID, new()
  {
      Types = ["agent.tool_use", "agent.tool_result"],
  });
  foreach (var sessionEvent in events.Items)
  {
      Console.WriteLine($"[{sessionEvent.Json.GetProperty("type").GetString()}] {sessionEvent.ProcessedAt}");
  }
  ```

  ```go Go
  events, err := client.Beta.Sessions.Events.List(ctx, session.ID, anthropic.BetaSessionEventListParams{
  	Types: []anthropic.BetaManagedAgentsSessionEventType{
  		anthropic.BetaManagedAgentsSessionEventTypeAgentToolUse,
  		anthropic.BetaManagedAgentsSessionEventTypeAgentToolResult,
  	},
  })
  if err != nil {
  	panic(err)
  }
  for _, event := range events.Data {
  	fmt.Printf("[%s] %s\n", event.Type, event.ProcessedAt)
  }
  ```

  ```java Java
  var events = client.beta().sessions().events().list(
      session.id(),
      EventListParams.builder()
          .addType(BetaManagedAgentsSessionEventType.AGENT_TOOL_USE)
          .addType(BetaManagedAgentsSessionEventType.AGENT_TOOL_RESULT)
          .build());
  for (var event : events.data()) {
      event.agentToolUse().ifPresent(toolUse ->
          IO.println("[" + toolUse._type() + "] " + toolUse.processedAt()));
      event.agentToolResult().ifPresent(toolResult ->
          IO.println("[" + toolResult._type() + "] " + toolResult.processedAt()));
  }
  ```

  ```php PHP
  $events = $client->beta->sessions->events->list(
      $session->id,
      types: ['agent.tool_use', 'agent.tool_result'],
  );
  foreach ($events->data as $event) {
      $processedAt = ($event->processedAt ?? null)?->format(DATE_RFC3339) ?? 'null';
      echo "[{$event->type}] {$processedAt}\n";
  }
  ```

  ```ruby Ruby
  events = client.beta.sessions.events.list(
    session.id,
    types: ["agent.tool_use", "agent.tool_result"]
  )
  events.data.each { puts "[#{it.type}] #{it.processed_at}" }
  ```
</CodeGroup>

## Send system messages

On a [supported model](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#supported-models), send a `system.message` event to give the agent privileged system-level context. The context applies to the accompanying turn and all subsequent turns. Use it when the agent needs updated system-level guidance mid-session, for example a different persona, revised constraints, or context fetched at runtime.

The event’s `content` (csharp, go: `Content`) accepts 1–1,000 text items. The content is appended to the session’s system context as a `role: "system"` turn. It doesn’t replace the top-level system prompt, which the `system` (csharp, go: `System`; ruby: `system_`) field on the agent definition sets.

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/events?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {
          "type": "system.message",
          "content": [
            {"type": "text", "text": "The current timezone of the user is America/New_York."}
          ]
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions:events send --session-id "$SESSION_ID" <<'YAML'
  events:
    - type: system.message
      content:
        - type: text
          text: "The user's current timezone is America/New_York."
  YAML
  ```

  ```python Python
  client.beta.sessions.events.send(
      session.id,
      events=[
          {
              "type": "system.message",
              "content": [
                  {
                      "type": "text",
                      "text": "The user's current timezone is America/New_York.",
                  },
              ],
          },
      ],
  )
  ```

  ```typescript TypeScript
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "system.message",
        content: [
          {
            type: "text",
            text: "The user's current timezone is America/New_York."
          }
        ]
      }
    ]
  });
  ```

  ```csharp C#
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsSystemMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsSystemContentBlock
                  {
                      Text = "The user's current timezone is America/New_York.",
                  },
              ],
          },
      ],
  });
  ```

  ```go Go
  if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfSystemMessage: &anthropic.BetaManagedAgentsSystemMessageEventParams{
  			Content: []anthropic.BetaManagedAgentsSystemContentBlockParam{{
  				Text: "The user's current timezone is America/New_York.",
  			}},
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
          .addEvent(BetaManagedAgentsSystemMessageEventParams.builder()
              .addTextContent("The user's current timezone is America/New_York.")
              .build())
          .build());
  ```

  ```php PHP
  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'system.message',
              'content' => [
                  [
                      'type' => 'text',
                      'text' => "The user's current timezone is America/New_York.",
                  ],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  client.beta.sessions.events.send_(
    session.id,
    events: [
      {
        type: "system.message",
        content: [
          {type: "text", text: "The user's current timezone is America/New_York."}
        ]
      }
    ]
  )
  ```
</CodeGroup>

### Supported models

`system.message` is supported by these models:

* Claude Fable 5.1
* Claude Mythos 5.1
* Claude Fable 5
* Claude Mythos 5
* Claude Opus 5.5
* Claude Opus 5
* Claude Opus 4.8
* Claude Sonnet 5.5
* Claude Haiku 5.5

If the agent’s primary model does not support mid-conversation system injection, the event is rejected with a `model_does_not_support_mid_conversation_system` validation error. Subagent models are not checked, because `system.message` lands on the primary thread only.

### System messages while a tool call is pending

While the session is idle with a `requires_action` stop reason, a `system.message` must trail a tool result event in the same request. Sent on its own or with a `user.message`, it is rejected until the pending tool events are resolved.

## Next steps

<CardGroup cols={2}>
  <Card title="Preview responses with event deltas" icon="text" href="https://platform.claude.com/docs/en/managed-agents/event-deltas">
    Render the agent’s response text while the model is still generating it.
  </Card>

  <Card title="Inspect sessions and track usage" icon="magnifying-glass" href="https://platform.claude.com/docs/en/managed-agents/session-observability">
    Inspect a session in the Claude Console and read its token usage and list cost.
  </Card>

  <Card title="Subscribe to webhooks" icon="link" href="https://platform.claude.com/docs/en/managed-agents/webhooks">
    Get notified when major events occur without polling.
  </Card>

  <Card title="Event types" icon="book" href="https://platform.claude.com/docs/en/managed-agents/reference#event-types">
    Look up every event type a session can send or receive.
  </Card>
</CardGroup>
