---
title: Preview responses with event deltas
url: https://platform.claude.com/docs/en/managed-agents/event-deltas
description: Render the agent's response text as a live preview while the model is still generating it.
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

By default, the agent’s response text reaches the [session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) as buffered `agent.message` events. Each one is emitted only after the model request that produced it completes. Event deltas let you render that text incrementally, as a live preview, while the model is still generating it.

Previews are a best-effort display aid, and the buffered `agent.message` is always the authoritative record. A client that ignores previews still receives a complete, correct stream.

## Opt in to previews

Previews are opt-in for each stream connection. Add the `event_deltas[]` query parameter to the stream you’re reading, and repeat it once for each event type you want previewed. The accepted values are `agent.message` and `agent.thinking`. Any other value returns a 400 error, as does a request with more than 100 values.

Both stream endpoints accept the parameter:

* **Session-level stream:** `GET /v1/sessions/{session_id}/events/stream`
* **Session thread stream:** `GET /v1/sessions/{session_id}/threads/{thread_id}/stream`

A subagent’s previews appear on [that subagent’s own thread stream](https://platform.claude.com/docs/en/managed-agents/event-deltas#preview-session-thread-events).

`[]` is a shell glob pattern, so quote the URL whenever you build the request in a shell. The examples percent-encode the brackets as `%5B%5D`, which also works.

### Preview events

When a previewed event starts, the stream emits an `event_start` carrying the upcoming event’s type and `id`:

```json
{
  "type": "event_start",
  "event": {
    "type": "agent.message",
    "id": "sevt_01abc..."
  }
}
```

For `agent.message`, the start is followed by `event_delta` events carrying incremental text. Each delta names the event it extends in `event_id` and the content block it extends in `delta.index`:

```json
{
  "type": "event_delta",
  "event_id": "sevt_01abc...",
  "delta": {
    "type": "content_delta",
    "index": 0,
    "content": {
      "type": "text",
      "text": "Here is the summary"
    }
  }
}
```

For `agent.thinking`, only the `event_start` is emitted, as a signal that a thinking block has started. No `event_delta` events follow. The buffered `agent.thinking` event that concludes the preview is a progress signal and carries no thinking content.

Unlike persisted events, `event_start` and `event_delta` have no `id` or `processed_at` of their own. The only identifier they carry is the `id` of the event they preview. Their type strings are also the exception to the `{domain}.{action}` naming convention of persisted events.

<Note>
  Event deltas use a different wire format from [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming), and the difference is intentional. A previewed `agent.message` gets a single `event_start` followed only by `event_delta` events. There are no per-content-block start or stop events and no stop event for the previewed event itself. The delta type is `content_delta`, not `content_block_delta`. Accumulator code written for the Messages API does not carry over unchanged.
</Note>

## Accumulate and reconcile

Every SDK that supports event deltas includes an [accumulator helper](https://platform.claude.com/docs/en/managed-agents/event-deltas#sdk-accumulator-helpers) that handles the `index` (csharp, go: `Index`) bookkeeping for you. The manual pattern in this section works in every language when you need custom bookkeeping. Apply it to the generated event types.

In the manual pattern, hold preview text in a temporary map keyed by `(event_id, index)`, and treat the buffered event as the record. Reconcile the two for each model request.

A turn opens with a single `session.status_running` event. On a turn that completes normally, each model request then produces these events, in order:

1. `span.model_request_start`
2. `event_start`
3. The `event_delta` events
4. The buffered `agent.message`
5. [`span.model_request_end`](https://platform.claude.com/docs/en/managed-agents/reference#event-types) (in the **Span events** tab)

On the wire, this is the previewed portion of that sequence, interleaved with the connection’s other buffered events:

```text wrap
event_start     {"event": {"type": "agent.message", "id": "sevt_01abc..."}}
event_delta     {"event_id": "sevt_01abc...", "delta": {"type": "content_delta", "index": 0, "content": {"type": "text", "text": "..."}}}
...
agent.message   {"id": "sevt_01abc...", "content": [...]}
```

The `event_delta` line repeats once for each text fragment. Process each event as it arrives:

1. On `event_start`, note the announced `id`. The identifiers always line up: `event_start.event.id`, every `event_delta.event_id`, and the buffered `agent.message`’s `id` are the same value.
2. On each `event_delta`, append `delta.content.text` to the entry at `(event_id, delta.index)` and render the running text. The first delta for an `index` creates that entry.
3. When the buffered `agent.message` arrives, match it by `id`, discard the accumulated preview, and render the message’s content instead.
4. On `span.model_request_end`, close any preview that has not been reconciled by its buffered event. No more deltas are coming for it. If the turn errors or is interrupted, the buffered event might never arrive, but `span.model_request_end` still does.

The pattern relies on two guarantees:

* Concatenating a preview’s deltas in arrival order, keyed by `(event_id, index)`, gives a prefix of `content[index].text` in the buffered event. It is not necessarily the whole text, because deltas might be [shed under load](https://platform.claude.com/docs/en/managed-agents/event-deltas#limitations).
* A connection emits at most one `event_start` for each `event_id`, and the buffered event is the last thing that connection delivers for that `id`.

### SDK accumulator helpers

Each SDK’s helper handles the `index` (csharp, go: `Index`) bookkeeping. The Go, Java, Ruby, and C# helpers also key the accumulating preview by the event’s `id` (csharp, go: `ID`). With the Python, TypeScript, and PHP helpers, keep that map yourself and fold each delta into the entry for its `id` (csharp, go: `ID`).

The following examples opt in to `agent.message` previews and reconcile them with the buffered event:

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  # Preview snapshots, keyed by event ID. accumulate_managed_agents_event folds each
  # event_start / event_delta into an agent.message snapshot; the buffered
  # agent.message replaces it.
  previews: dict[str, BetaManagedAgentsAgentMessageEvent] = {}

  # Opt in to agent.message previews on this connection
  with client.beta.sessions.events.stream(
      session.id, event_deltas=["agent.message"]
  ) as stream:
      client.beta.sessions.events.send(
          session.id,
          events=[
              {
                  "type": "user.message",
                  "content": [
                      {"type": "text", "text": "Describe the repo in one sentence."}
                  ],
              },
          ],
      )

      for event in stream:
          match event.type:
              case "event_start":
                  snapshot = accumulate_managed_agents_event(None, event)
                  if snapshot is not None:
                      previews[event.event.id] = snapshot
                  print(f"event_start             {event.event.type} {event.event.id}")
              case "event_delta":
                  preview = accumulate_managed_agents_event(
                      previews.get(event.event_id), event
                  )
                  if preview is not None:
                      previews[event.event_id] = preview
                      text = "".join(block.text for block in preview.content)
                      print(f"event_delta             preview: {text!r}")
              case "agent.message":
                  # The buffered event is the record: it replaces and closes the preview
                  preview = accumulate_managed_agents_event(
                      previews.pop(event.id, None), event
                  )
                  text = "".join(block.text for block in preview.content)
                  print(f"agent.message           {event.id} {text!r}")
              case "span.model_request_end":
                  # No more deltas are coming. Close any preview whose
                  # buffered event never arrived.
                  for event_id in previews:
                      print(f"span.model_request_end  closing preview for {event_id}")
                  previews.clear()
              case "session.status_idle":
                  break
  ```

  ```typescript TypeScript
  // Preview snapshots, keyed by event ID. `accumulateManagedAgentsEvent`
  // folds event_start / event_delta previews into an agent.message snapshot.
  const previews = new Map<string, BetaManagedAgentsAgentMessageEvent>();

  // Opt in to agent.message previews for this connection only
  const stream = await client.beta.sessions.events.stream(session.id, {
    event_deltas: ["agent.message"]
  });
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Summarize the repo README" }]
      }
    ]
  });

  deltas: for await (const event of stream) {
    switch (event.type) {
      case "event_start": {
        // 1. Note the announced ID and open the snapshot. Deltas and the
        //    buffered event carry the same ID.
        const preview = accumulateManagedAgentsEvent(undefined, event);
        if (preview) {
          previews.set(event.event.id, preview);
        }
        console.log(`event_start             ${event.event.type} ${event.event.id}`);
        break;
      }
      case "event_delta": {
        // 2. Fold the fragment into the snapshot and render it
        const preview = accumulateManagedAgentsEvent(previews.get(event.event_id), event);
        if (preview) {
          previews.set(event.event_id, preview);
          const text = preview.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          console.log(`event_delta             preview: ${JSON.stringify(text)}`);
        }
        break;
      }
      case "agent.message": {
        // 3. The buffered event is the record: it replaces and closes the preview
        const message = accumulateManagedAgentsEvent(previews.get(event.id), event);
        previews.delete(event.id);
        const text = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        console.log(`agent.message           ${event.id} ${JSON.stringify(text)}`);
        break;
      }
      case "span.model_request_end":
        // 4. No more deltas are coming. Close any preview that was never reconciled.
        for (const eventId of previews.keys()) {
          console.log(`span.model_request_end  closing preview for ${eventId}`);
        }
        previews.clear();
        break;
      case "session.status_idle":
        break deltas;
    }
  }
  stream.controller.abort();
  ```

  ```csharp C#
  // Opt in to event deltas: agent.message events are previewed as they are produced.
  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(
      session.ID,
      new() { EventDeltas = [BetaManagedAgentsDeltaType.AgentMessage] }
  );
  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock { Text = "Write a haiku about event streams." },
              ],
          },
      ],
  });

  // Accumulate preview fragments for each (event ID, content index). The buffered
  // agent.message that follows carries the complete content, so it replaces the
  // accumulated preview rather than appending to it.
  Dictionary<string, SortedDictionary<long, string>> previews = [];

  await foreach (var streamEvent in stream.Enumerate())
  {
      if (streamEvent.TryPickStartEvent(out var start))
      {
          // A preview opened for the event with this ID. This stream only opts in
          // to agent.message deltas; TryPick* returns false instead of throwing,
          // so other preview types (including ones added later) are skipped.
          if (start.Event.TryPickAgentMessage(out var preview))
          {
              Console.WriteLine($"event_start             {preview.Type.GetString()} {preview.ID}");
          }
      }
      else if (streamEvent.TryPickDeltaEvent(out var delta))
      {
          // Insert at a new index, append at an existing one
          if (!previews.TryGetValue(delta.EventID, out var fragments))
          {
              previews[delta.EventID] = fragments = [];
          }
          var index = delta.Delta.Index ?? 0;
          fragments[index] = fragments.GetValueOrDefault(index, "") + delta.Delta.Content.Text;
          Console.WriteLine($"event_delta             preview: {fragments[index]}");
      }
      else if (streamEvent.TryPickAgentMessageEvent(out var message))
      {
          // Deltas are best-effort: discard the preview and use the buffered event
          previews.Remove(message.ID);
          var text = string.Concat(message.Content.Select(block =>
              block.TryPickBetaManagedAgentsTextBlock(out var textBlock) ? textBlock.Text : ""));
          Console.WriteLine($"agent.message           {message.ID} {text}");
      }
      else if (streamEvent.TryPickSpanModelRequestEndEvent(out _))
      {
          // No more deltas are coming; close any preview that was never reconciled.
          foreach (var eventId in previews.Keys)
          {
              Console.WriteLine($"span.model_request_end  closing preview for {eventId}");
          }
          previews.Clear();
      }
      else if (streamEvent.TryPickSessionStatusIdleEvent(out _))
      {
          break;
      }
  }
  ```

  ```go Go
  	// Opt in to incremental previews of agent.message events
  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{
  		EventDeltas: []anthropic.BetaManagedAgentsDeltaType{
  			anthropic.BetaManagedAgentsDeltaTypeAgentMessage,
  		},
  	})

  	if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "Write a haiku about the ocean.",
  					},
  				}},
  			},
  		}},
  	}); err != nil {
  		panic(err)
  	}

  	// The accumulator folds event_start / event_delta fragments into
  	// agent.message snapshots, one for each event ID. The zero value is ready to use.
  	var previews anthropic.BetaManagedAgentsEventAccumulator

  deltas:
  	for stream.Next() {
  		event := stream.Current()
  		previews.Accumulate(event)

  		switch event := event.AsAny().(type) {
  		case anthropic.BetaManagedAgentsStartEvent:
  			fmt.Printf("event_start             %s %s\n", event.Event.Type, event.Event.ID)
  		case anthropic.BetaManagedAgentsDeltaEvent:
  			fmt.Printf("event_delta             preview: %q\n", previews.AgentMessageText(event.EventID))
  		case anthropic.BetaManagedAgentsAgentMessageEvent:
  			// The buffered event carries the complete content: the accumulator
  			// replaces the preview with it
  			fmt.Printf("agent.message           %s %q\n", event.ID, previews.AgentMessageText(event.ID))
  		case anthropic.BetaManagedAgentsSpanModelRequestEndEvent:
  			// No more deltas are coming for this request. The accumulator
  			// drops its snapshots here, closing any preview that was never
  			// reconciled by a buffered agent.message.
  			fmt.Println("span.model_request_end  no more deltas for this request")
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			break deltas
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  	stream.Close()
  ```

  ```java Java
  // Preview text, keyed by event ID then content index. The buffered agent.message replaces it.
  Map<String, Map<Long, StringBuilder>> previews = new HashMap<>();

  // Opt in to agent.message previews on this connection
  try (var stream = client.beta().sessions().events().streamStreaming(
          session.id(),
          EventStreamParams.builder()
              .addEventDelta(BetaManagedAgentsDeltaType.AGENT_MESSAGE)
              .build()
  )) {
      client.beta().sessions().events().send(
          session.id(),
          EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                  .addTextContent("Describe the repo in one sentence.")
                  .build())
              .build()
      );

      Iterable<BetaManagedAgentsStreamSessionEvents> events = stream.stream()::iterator;
      deltas:
      for (var event : events) {
          switch (event.type().value()) {
              case EVENT_START -> {
                  if (event.asEventStart().event().isAgentMessage()) {
                      var preview = event.asEventStart().event().asAgentMessage();
                      IO.println("event_start             " + preview._type() + " " + preview.id());
                  }
              }
              case EVENT_DELTA -> {
                  var eventDelta = event.asEventDelta();
                  var fragment = eventDelta.delta();
                  var buffer = previews
                      .computeIfAbsent(eventDelta.eventId(), _ -> new HashMap<>())
                      .computeIfAbsent(fragment.index().orElse(0L), _ -> new StringBuilder());
                  buffer.append(fragment.content().text());
                  IO.println("event_delta             preview: " + buffer);
              }
              case AGENT_MESSAGE -> {
                  // The buffered event is the record: drop its preview, render its content
                  var message = event.asAgentMessage();
                  previews.remove(message.id());
                  var text = message.content().stream()
                      .flatMap(block -> block.text().stream())
                      .map(textBlock -> textBlock.text())
                      .collect(Collectors.joining());
                  IO.println("agent.message           " + message.id() + " " + text);
              }
              case SPAN_MODEL_REQUEST_END -> {
                  // No more deltas are coming. Close any preview whose buffered event never arrived.
                  previews.keySet().forEach(eventId ->
                      IO.println("span.model_request_end  closing preview for " + eventId));
                  previews.clear();
              }
              case SESSION_STATUS_IDLE -> {
                  break deltas;
              }
          }
      }
  }
  ```

  ```php PHP
  use Anthropic\Beta\Sessions\BetaManagedAgentsDeltaEvent;
  use Anthropic\Beta\Sessions\BetaManagedAgentsDeltaType;
  use Anthropic\Beta\Sessions\BetaManagedAgentsStartEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSpanModelRequestEndEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;
  use Anthropic\Lib\Sessions\EventAccumulator;

  // Preview snapshots, keyed by event ID. EventAccumulator::accumulate() adds each
  // event_start / event_delta to an agent.message snapshot; the buffered
  // agent.message replaces it.
  $previews = [];

  // The text of an agent.message snapshot or event
  $textOf = fn (ManagedAgentsAgentMessageEvent $message): string => implode(
      '',
      array_map(
          fn ($block) => $block->text,
          array_filter(
              $message->content,
              fn ($block) => $block instanceof ManagedAgentsTextBlock,
          ),
      ),
  );

  // Opt in to agent.message previews on this connection
  $stream = $client->beta->sessions->events->streamStream(
      $session->id,
      eventDeltas: [BetaManagedAgentsDeltaType::AGENT_MESSAGE],
  );

  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => 'Describe the repo in one sentence.']],
          ],
      ],
  );

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof BetaManagedAgentsStartEvent:
              $snapshot = EventAccumulator::accumulate(null, $event);
              if ($snapshot !== null) {
                  $previews[$event->event->id] = $snapshot;
              }
              printf("event_start             %s %s\n", $event->event->type, $event->event->id);
              break;
          case $event instanceof BetaManagedAgentsDeltaEvent:
              // Skip a late delta for a preview that was already replaced or closed
              if (!isset($previews[$event->eventID])) {
                  break; // Break switch statement
              }
              $previews[$event->eventID] = EventAccumulator::accumulate($previews[$event->eventID], $event);
              printf("event_delta             preview: %s\n", json_encode($textOf($previews[$event->eventID])));
              break;
          case $event instanceof ManagedAgentsAgentMessageEvent:
              // The buffered event is the record: it replaces and closes the preview
              unset($previews[$event->id]);
              printf("agent.message           %s %s\n", $event->id, json_encode($textOf($event)));
              break;
          case $event instanceof ManagedAgentsSpanModelRequestEndEvent:
              // No more deltas are coming. Close any preview whose
              // buffered event never arrived.
              foreach (array_keys($previews) as $eventID) {
                  printf("span.model_request_end  closing preview for %s\n", $eventID);
              }
              $previews = [];
              break;
          case $event instanceof ManagedAgentsSessionStatusIdleEvent:
              break 2; // Break foreach loop
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  # Opt in to event deltas: agent.message previews stream as incremental fragments.
  stream = client.beta.sessions.events.stream_events(
    session.id,
    event_deltas: [Anthropic::Beta::BetaManagedAgentsDeltaType::AGENT_MESSAGE]
  )

  client.beta.sessions.events.send_(
    session.id,
    events: [{
      type: "user.message",
      content: [{type: "text", text: "Give a one-sentence project tagline."}]
    }]
  )

  # Accumulate preview fragments by (event_id, index) into explicitly mutable
  # (`+""`) buffers so `<<` can append in place. The buffered agent.message with
  # the same ID is authoritative and replaces whatever the deltas built up.
  buffers = Hash.new do |by_event, event_id|
    by_event[event_id] = Hash.new { |fragments, index| fragments[index] = +"" }
  end

  stream.each do |event|
    case event
    when Anthropic::Beta::BetaManagedAgentsStartEvent
      puts "event_start             #{event.event.type} #{event.event.id}"
    when Anthropic::Beta::BetaManagedAgentsDeltaEvent
      delta = event.delta
      fragment = delta.content.text
      buffers[event.event_id][delta.index || 0] << fragment
      puts "event_delta             preview: #{buffers[event.event_id][delta.index || 0].inspect}"
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      # Replace: drop the accumulated preview and render the complete event.
      buffers.delete(event.id)
      puts "agent.message           #{event.id} #{event.content.map(&:text).join.inspect}"
    when Anthropic::Beta::Sessions::BetaManagedAgentsSpanModelRequestEndEvent
      # No more deltas are coming. Close any preview that was never reconciled.
      buffers.each_key { |event_id| puts "span.model_request_end  closing preview for #{event_id}" }
      buffers.clear
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      break
    else
      # ignore other event types
    end
  end
  ```
</CodeGroup>

## Preview session thread events

In a [multiagent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) session, every session thread has its own event stream. It takes the same `event_deltas[]` parameter with the same values.

A connection previews only the thread it’s reading. The session-level stream previews the primary thread, and a child thread’s previews are never cross-posted to it. To watch a subagent’s text as the model generates it, open that subagent’s thread stream.

A thread stream’s path ends in `/threads/{thread_id}/stream`. `/events/stream` exists only at the session level, so there is no `/threads/{thread_id}/events/stream` endpoint.

`event_start` and `event_delta` have the same shape on a thread stream as on the session-level stream, and the [accumulate and reconcile](https://platform.claude.com/docs/en/managed-agents/event-deltas#accumulate-and-reconcile) pattern applies as written. Run one accumulator instance for each stream connection.

<CodeGroup>
  ```bash cURL
  # The thread stream takes the same event_deltas[] parameter as the session stream.
  # Percent-encode the brackets (%5B%5D) and quote the URL.
  curl --fail-with-body -sS -N \
    "https://api.anthropic.com/v1/sessions/$SESSION_ID/threads/$THREAD_ID/stream?beta=true&event_deltas%5B%5D=agent.message" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "accept: text/event-stream"
  ```

  ```bash CLI
  # The thread stream takes the same event_deltas parameter as the session stream,
  # one --event-delta flag for each event type to preview.
  ant beta:sessions:threads:events stream \
    --session-id "$SESSION_ID" \
    --thread-id "$THREAD_ID" \
    --event-delta agent.message
  ```

  ```python Python
  # List the session's threads and pick a child: child threads have a non-null
  # parent_thread_id, and the primary thread's parent_thread_id is null.
  child_thread = next(
      thread
      for thread in client.beta.sessions.threads.list(session.id)
      if thread.parent_thread_id is not None
  )

  # The child thread's stream takes the same event_deltas parameter as the
  # session stream.
  with client.beta.sessions.threads.events.stream(
      child_thread.id,
      session_id=session.id,
      event_deltas=["agent.message"],
  ) as stream:
      for event in stream:
          match event.type:
              case "event_delta":
                  print(event.delta.content.text, end="")
              case "agent.message":
                  # The buffered event is the authoritative record; render its content.
                  print()
                  for block in event.content:
                      if block.type == "text":
                          print(block.text, end="")
                  print()
              case "session.thread_status_idle":
                  break
  ```

  ```typescript TypeScript
  // List the session's threads and pick a child: child threads have a non-null
  // parent_thread_id, and the primary thread's parent_thread_id is null.
  let childThreadId: string | undefined;
  for await (const thread of client.beta.sessions.threads.list(session.id)) {
    if (thread.parent_thread_id !== null) {
      childThreadId = thread.id;
      break;
    }
  }
  if (!childThreadId) {
    throw new Error("No child thread found");
  }

  // The child thread's stream takes the same event_deltas parameter as the
  // session stream.
  const stream = await client.beta.sessions.threads.events.stream(childThreadId, {
    session_id: session.id,
    event_deltas: ["agent.message"]
  });

  threadDeltas: for await (const event of stream) {
    switch (event.type) {
      case "event_delta":
        process.stdout.write(event.delta.content.text);
        break;
      case "agent.message": {
        // The buffered event is the authoritative record; render its content.
        process.stdout.write("\n");
        const text = event.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        console.log(text);
        break;
      }
      case "session.thread_status_idle":
        break threadDeltas;
    }
  }
  stream.controller.abort();
  ```

  ```csharp C#
  // List the session's threads and pick a child: child threads have a non-null
  // parent_thread_id, and the primary thread's parent_thread_id is null.
  var threads = await client.Beta.Sessions.Threads.List(session.ID);
  var childThread = threads.Items.First(thread => thread.ParentThreadID is not null);

  // The child thread's stream takes the same event_deltas parameter as the
  // session stream.
  using var stream = await client.Beta.Sessions.Threads.Events.WithRawResponse.StreamStreaming(
      childThread.ID,
      new() { SessionID = session.ID, EventDeltas = [BetaManagedAgentsDeltaType.AgentMessage] }
  );

  await foreach (var streamEvent in stream.Enumerate())
  {
      if (streamEvent.TryPickDeltaEvent(out var delta))
      {
          Console.Write(delta.Delta.Content.Text);
      }
      else if (streamEvent.TryPickAgentMessageEvent(out var message))
      {
          // The buffered event is the authoritative record; render its content.
          Console.WriteLine();
          var text = string.Concat(message.Content.Select(block =>
              block.TryPickBetaManagedAgentsTextBlock(out var textBlock) ? textBlock.Text : ""));
          Console.WriteLine(text);
      }
      else if (streamEvent.TryPickSessionThreadStatusIdleEvent(out _))
      {
          break;
      }
  }
  ```

  ```go Go
  	// List the session's threads and pick a child: child threads have a non-null
  	// parent_thread_id, and the primary thread's parent_thread_id is null.
  	var childThreadID string
  	threads := client.Beta.Sessions.Threads.ListAutoPaging(ctx, session.ID, anthropic.BetaSessionThreadListParams{})
  	for threads.Next() {
  		if thread := threads.Current(); thread.ParentThreadID != "" {
  			childThreadID = thread.ID
  			break
  		}
  	}
  	if err := threads.Err(); err != nil {
  		panic(err)
  	}

  	// The child thread's stream takes the same event_deltas parameter as the
  	// session stream; run one read loop for each stream connection.
  	stream := client.Beta.Sessions.Threads.Events.StreamEvents(ctx, childThreadID, anthropic.BetaSessionThreadEventStreamParams{
  		SessionID: session.ID,
  		EventDeltas: []anthropic.BetaManagedAgentsDeltaType{
  			anthropic.BetaManagedAgentsDeltaTypeAgentMessage,
  		},
  	})

  threadDeltas:
  	for stream.Next() {
  		switch event := stream.Current().AsAny().(type) {
  		case anthropic.BetaManagedAgentsDeltaEvent:
  			fmt.Print(event.Delta.Content.Text)
  		case anthropic.BetaManagedAgentsAgentMessageEvent:
  			// The buffered event is the authoritative record; render its content.
  			fmt.Println()
  			// concrete-typed list: BetaManagedAgentsTextBlock
  			for _, block := range event.Content {
  				fmt.Print(block.Text)
  			}
  			fmt.Println()
  		case anthropic.BetaManagedAgentsSessionThreadStatusIdleEvent:
  			break threadDeltas
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  	stream.Close()
  ```

  ```java Java
  // List the session's threads and pick a child: child threads have a non-null
  // parent_thread_id, and the primary thread's parent_thread_id is null.
  var childThread = client.beta().sessions().threads().list(session.id()).autoPager().stream()
      .filter(thread -> thread.parentThreadId().isPresent())
      .findFirst()
      .orElseThrow();

  // The child thread's stream takes the same event_deltas parameter as the session
  // stream. Its params class shares the session-level one's simple name, so qualify it.
  try (var stream = client.beta().sessions().threads().events().streamStreaming(
          childThread.id(),
          com.anthropic.models.beta.sessions.threads.events.EventStreamParams.builder()
              .sessionId(session.id())
              .addEventDelta(BetaManagedAgentsDeltaType.AGENT_MESSAGE)
              .build()
  )) {
      Iterable<BetaManagedAgentsStreamSessionThreadEvents> events = stream.stream()::iterator;
      threadDeltas:
      for (var event : events) {
          switch (event.type().value()) {
              case EVENT_DELTA -> IO.print(event.asEventDelta().delta().content().text());
              case AGENT_MESSAGE -> {
                  // The buffered event is the authoritative record; render its content.
                  IO.println();
                  event.asAgentMessage().content().forEach(block -> block.text().ifPresent(textBlock -> IO.print(textBlock.text())));
                  IO.println();
              }
              case SESSION_THREAD_STATUS_IDLE -> {
                  break threadDeltas;
              }
          }
      }
  }
  ```

  ```php PHP
  use Anthropic\Beta\Sessions\BetaManagedAgentsDeltaEvent;
  use Anthropic\Beta\Sessions\BetaManagedAgentsDeltaType;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionThreadStatusIdleEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;

  // List the session's threads and pick a child: child threads have a non-null
  // parentThreadID, and the primary thread's parentThreadID is null.
  $childThread = null;
  foreach ($client->beta->sessions->threads->list($session->id)->pagingEachItem() as $thread) {
      if ($thread->parentThreadID !== null) {
          $childThread = $thread;
          break;
      }
  }

  // The child thread's stream takes the same eventDeltas parameter as the
  // session stream.
  $stream = $client->beta->sessions->threads->events->streamStream(
      $childThread->id,
      sessionID: $session->id,
      eventDeltas: [BetaManagedAgentsDeltaType::AGENT_MESSAGE],
  );

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof BetaManagedAgentsDeltaEvent:
              echo $event->delta->content->text;
              break;
          case $event instanceof ManagedAgentsAgentMessageEvent:
              // The buffered event is the authoritative record; render its content.
              echo "\n";
              foreach ($event->content as $block) {
                  if ($block instanceof ManagedAgentsTextBlock) {
                      echo $block->text;
                  }
              }
              echo "\n";
              break;
          case $event instanceof ManagedAgentsSessionThreadStatusIdleEvent:
              break 2; // Break foreach loop
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  # List the session's threads and pick a child: child threads have a non-null
  # parent_thread_id, and the primary thread's parent_thread_id is null.
  child_thread = client.beta.sessions.threads.list(session.id).to_enum.find { it.parent_thread_id }

  # The child thread's stream takes the same event_deltas parameter as the
  # session stream.
  stream = client.beta.sessions.threads.events.stream_events(
    child_thread.id,
    session_id: session.id,
    event_deltas: [Anthropic::Beta::BetaManagedAgentsDeltaType::AGENT_MESSAGE]
  )

  stream.each do |event|
    case event
    when Anthropic::Beta::BetaManagedAgentsDeltaEvent
      print event.delta.content.text
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      # The buffered event is the authoritative record; render its content.
      puts
      event.content.each { print it.text }
      puts
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionThreadStatusIdleEvent
      break
    else
      # ignore other event types
    end
  end
  ```
</CodeGroup>

The read loop exits on [`session.thread_status_idle`](https://platform.claude.com/docs/en/managed-agents/reference#event-types), the event emitted when the session thread’s turn completes and the thread goes idle.

## Limitations

* **Best effort:** Under load, the server might shed deltas for an event. When it does, you receive a contiguous prefix of the text and then no further deltas for that event. The buffered `agent.message` still arrives complete. Never treat an accumulated preview as final.
* **No replay on reconnect:** Deltas are delivered only to the connection that opted in, while it is open. This applies to the session-level stream and to each session thread stream alike. A connection opened after a model request started receives no deltas for that in-flight event. There is no way to re-request missed deltas.
* **One thread, text only:** Previews cover assistant text on [the thread the connection is reading](https://platform.claude.com/docs/en/managed-agents/event-deltas#preview-session-thread-events). Tool use, tool results, and MCP results are never previewed.
* **Never persisted:** `event_start` and `event_delta` exist only on the live stream. They do not appear in the session’s event history (`GET /v1/sessions/{session_id}/events`) or in any session thread’s event history.

## Troubleshoot previews

| You see                                                             | What it means                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A stream with buffered events but no `event_start` or `event_delta` | The connection you’re reading didn’t opt in, or the turn never touched the thread you’re streaming. `event_deltas[]` applies per connection, not per session. To find which thread ran, list the session’s threads (`GET /v1/sessions/{session_id}/threads`).                                                                                                |
| A stream that drops during a preview                                | Deltas are not replayed. Follow the [reconnect procedure](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#reconnect-without-missing-events): reopen the stream and list the event history. The history includes any buffered events emitted while you were disconnected, including the `agent.message` your preview was waiting for. |
| A 404 on the stream URL                                             | The path or an ID is wrong, or the request carries no managed-agents beta header at all. The thread endpoints are beta-gated, so without the header they don’t exist.                                                                                                                                                                                        |
| A 400 naming `event_deltas`                                         | Only `agent.message` and `agent.thinking` are accepted.                                                                                                                                                                                                                                                                                                      |

## Next steps

<CardGroup cols={2}>
  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Send events, stream responses, and interrupt or redirect your session while it runs.
  </Card>

  <Card title="Multiagent orchestration" icon="stack" href="https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration">
    Coordinate multiple agents within a single session.
  </Card>
</CardGroup>

## Availability

Event deltas are in beta on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

| Status | Cloud platforms         | Models                                                            |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| Beta   | All supported platforms | [All models](https://platform.claude.com/docs/en/models/overview) |

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
