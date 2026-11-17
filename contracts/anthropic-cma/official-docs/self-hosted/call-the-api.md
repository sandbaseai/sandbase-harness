---
title: Call the API on a self-hosted server
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api
description: Point the official SDK, cURL, or the ant CLI at your self-hosted Claude Managed Agents server, start a session, and read the agent's reply. Then connect workers of your own, if you need them.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

A self-hosted Claude Managed Agents server has the same API as Anthropic’s hosted [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) service. Your code calls it with the official SDK, cURL, or the `ant` CLI. Two things change: the base URL is your server’s address, and the API key is your [server API key](https://platform.claude.com/docs/en/managed-agents/self-hosted#the-three-credentials) instead of a Claude API key.

To create agents and run sessions in a browser, see [Use the console on your server](https://platform.claude.com/docs/en/managed-agents/self-hosted/console).

## Prerequisites

* **A running server:** Start one with [Get started with self-hosted Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart) or [Deploy on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes).
* **Access to the server:** If someone else runs the server, ask them for its address and how to authenticate. If they use single sign-on, see [Let developers log in from a terminal](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#let-developers-log-in-from-a-terminal).
* **The `ant` CLI:** Install the latest version, as the [CLI quickstart](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart#installation) shows.

## Point your client at your server

The SDK and the `ant` CLI read the server address from `ANTHROPIC_BASE_URL` and the API key from `ANTHROPIC_API_KEY`. Set both variables in a terminal that you keep for this server.

For the [quickstart stack](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart), run these commands from the directory that holds your `.env` file:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8400
export ANTHROPIC_API_KEY=$(grep '^CMA_SERVER__API_KEY=' .env | cut -d= -f2)
```

On Kubernetes, set the two variables as [Run a session](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#run-a-session) shows, and keep its port-forward running.

In that terminal, every `ant` command, such as `ant beta:agents list`, reaches your server. Don’t run Claude Code or `docker compose` in that terminal, because they read the same variables.

## Start a session

A session needs the ID of an agent and the ID of an environment:

* **Agent:** Create one as [Create an agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#create-an-agent) shows, with your client pointed at your server. If you send raw HTTP requests, replace `https://api.anthropic.com` in the URL with `$ANTHROPIC_BASE_URL`.
* **Environment:** The quickstart stack creates one named `compose-sandbox`, and the Helm charts create one named `default`. `ant beta:environments list` prints each environment’s name and ID. For your own workers, it’s the ID that the admin CLI printed in [Run your own workers](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#point-a-worker-at-your-server).

Put your two IDs in your shell, in place of these example IDs:

```bash
export AGENT_ID=agent_011CYm1BLqPXpQRk5khsSXrs
export ENVIRONMENT_ID=env_01595EKxaaTTGwwY3kyXdtbs
```

The following example creates a session and sends its first message in the same request:

<CodeGroup>
  ```bash cURL
  curl -sS --fail-with-body "$ANTHROPIC_BASE_URL/v1/sessions" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2026-10-21" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$AGENT_ID"'",
      "environment_id": "'"$ENVIRONMENT_ID"'",
      "initial_events": [
        {
          "type": "user.message",
          "content": [{"type": "text", "text": "List the files in the working directory."}]
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions create --agent "$AGENT_ID" --environment-id "$ENVIRONMENT_ID" \
    --initial-event '{type: user.message, content: [{type: text, text: "List the files in the working directory."}]}'
  ```

  ```python Python
  import os

  from anthropic import Anthropic

  client = Anthropic()

  session = client.beta.sessions.create(
      agent=os.environ["AGENT_ID"],
      environment_id=os.environ["ENVIRONMENT_ID"],
      initial_events=[
          {
              "type": "user.message",
              "content": [
                  {"type": "text", "text": "List the files in the working directory."}
              ],
          },
      ],
  )
  print(session.id)
  ```

  ```typescript TypeScript
  import Anthropic from "@anthropic-ai/sdk";

  const client = new Anthropic();

  const session = await client.beta.sessions.create({
    agent: process.env["AGENT_ID"]!,
    environment_id: process.env["ENVIRONMENT_ID"]!,
    initial_events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "List the files in the working directory." }]
      }
    ]
  });
  console.log(session.id);
  ```

  ```csharp C#
  using System;
  using Anthropic;
  using Anthropic.Models.Beta.Agents;
  using Anthropic.Models.Beta.Sessions;
  using Anthropic.Models.Beta.Sessions.Events;

  AnthropicClient client = new();

  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = Environment.GetEnvironmentVariable("AGENT_ID")!,
      EnvironmentID = Environment.GetEnvironmentVariable("ENVIRONMENT_ID")!,
      InitialEvents =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content =
              [
                  new BetaManagedAgentsTextBlock
                  {
                      Text = "List the files in the working directory.",
                  },
              ],
          },
      ],
  });
  Console.WriteLine(session.ID);
  ```

  ```go Go
  package main

  import (
  	"context"
  	"fmt"
  	"os"

  	"github.com/anthropics/anthropic-sdk-go/v2"
  )

  func main() {
  	client := anthropic.NewClient()

  	session, err := client.Beta.Sessions.New(context.Background(), anthropic.BetaSessionNewParams{
  		Agent: anthropic.BetaSessionNewParamsAgentUnion{
  			OfString: anthropic.String(os.Getenv("AGENT_ID")),
  		},
  		EnvironmentID: os.Getenv("ENVIRONMENT_ID"),
  		InitialEvents: []anthropic.BetaSessionNewParamsInitialEventUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "List the files in the working directory.",
  					},
  				}},
  			},
  		}},
  	})
  	if err != nil {
  		panic(err)
  	}
  	fmt.Println(session.ID)
  }
  ```

  ```java Java
  import com.anthropic.client.AnthropicClient;
  import com.anthropic.client.okhttp.AnthropicOkHttpClient;
  import com.anthropic.models.beta.sessions.SessionCreateParams;
  import com.anthropic.models.beta.sessions.events.BetaManagedAgentsUserMessageEventParams;

  void main() {
      AnthropicClient client = AnthropicOkHttpClient.fromEnv();

      var session = client.beta().sessions().create(SessionCreateParams.builder()
          .agent(System.getenv("AGENT_ID"))
          .environmentId(System.getenv("ENVIRONMENT_ID"))
          .addInitialEvent(BetaManagedAgentsUserMessageEventParams.builder()
              .addTextContent("List the files in the working directory.")
              .build())
          .build());
      IO.println(session.id());
  }
  ```

  ```php PHP
  <?php

  use Anthropic\Client;

  $client = new Client();

  $session = $client->beta->sessions->create(
      agent: (string) getenv('AGENT_ID'),
      environmentID: (string) getenv('ENVIRONMENT_ID'),
      initialEvents: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => 'List the files in the working directory.']],
          ],
      ],
  );
  echo $session->id, "\n";
  ```

  ```ruby Ruby
  require "anthropic"

  client = Anthropic::Client.new

  session = client.beta.sessions.create(
    agent: ENV.fetch("AGENT_ID"),
    environment_id: ENV.fetch("ENVIRONMENT_ID"),
    initial_events: [
      {
        type: :"user.message",
        content: [{type: :text, text: "List the files in the working directory."}]
      }
    ]
  )
  puts session.id
  ```
</CodeGroup>

The response holds the session’s ID, which starts with `sesn_`. The agent starts work at once. Its built-in tools, such as `bash`, run on a worker that serves the environment.

To watch the session, open the [console on your server](https://platform.claude.com/docs/en/managed-agents/self-hosted/console) in a browser, select **Sessions**, and then select the session. A session that you started with the server API key, as on this page, appears only to administrators.

To follow the session in your terminal instead, pass its ID to [`ant beta:sessions connect`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/sessions-connect):

```bash
ant beta:sessions connect sesn_011CZkZAtmR3yMPDzynEDxu7
```

For what else a session can do, such as pinning an agent version, see [Start a session](https://platform.claude.com/docs/en/managed-agents/sessions).

## Send a message and read the reply

Put your session’s ID in your shell, in place of this example ID:

```bash
export SESSION_ID=sesn_011CZkZAtmR3yMPDzynEDxu7
```

Wait until the session is idle before you run the next example. The example stops reading when a turn ends. If an earlier turn is still running, its end can stop the example before the reply to your message arrives. The console and `ant beta:sessions connect` both show the session’s status.

The following example sends a message and prints the agent’s reply. It opens the session’s event stream first, because a stream delivers only the events that come after it opens:

<CodeGroup exclude="shell">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Anthropic SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. To send messages and read the replies in your terminal, use [`ant beta:sessions connect`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/sessions-connect).
  </CodeGroupItem>

  ```python Python
  import os

  from anthropic import Anthropic

  client = Anthropic()
  session_id = os.environ["SESSION_ID"]

  with client.beta.sessions.events.stream(session_id) as stream:
      client.beta.sessions.events.send(
          session_id,
          events=[
              {
                  "type": "user.message",
                  "content": [
                      {"type": "text", "text": "Summarize what you did in one sentence."}
                  ],
              },
          ],
      )

      for event in stream:
          match event.type:
              case "agent.message":
                  for block in event.content:
                      if block.type == "text":
                          print(block.text, end="")
              case "session.error":
                  error_message = event.error.message if event.error else "unknown"
                  print(f"\n[Error: {error_message}]")
              case "session.status_idle":
                  if event.stop_reason.type != "requires_action":
                      break
              case "session.status_terminated":
                  break
  ```

  ```typescript TypeScript
  import Anthropic from "@anthropic-ai/sdk";

  const client = new Anthropic();
  const sessionId = process.env["SESSION_ID"]!;

  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Summarize what you did in one sentence." }]
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
      case "session.error":
        console.log(`\n[Error: ${event.error?.message ?? "unknown"}]`);
        break;
      case "session.status_idle":
        if (event.stop_reason.type !== "requires_action") {
          break events;
        }
        break;
      case "session.status_terminated":
        break events;
    }
  }
  ```

  ```csharp C#
  using System;
  using Anthropic;
  using Anthropic.Models.Beta.Sessions.Events;

  AnthropicClient client = new();
  var sessionId = Environment.GetEnvironmentVariable("SESSION_ID")!;

  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(sessionId);
  await client.Beta.Sessions.Events.Send(sessionId, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content = [new BetaManagedAgentsTextBlock { Text = "Summarize what you did in one sentence." }],
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
      else if (streamEvent.Value is BetaManagedAgentsSessionErrorEvent error)
      {
          Console.WriteLine($"\n[Error: {error.Error?.Message ?? "unknown"}]");
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent idle
          && idle.StopReason?.Value is not BetaManagedAgentsSessionRequiresAction)
      {
          break;
      }
      else if (streamEvent.Value is BetaManagedAgentsSessionStatusTerminatedEvent)
      {
          break;
      }
  }
  ```

  ```go Go
  package main

  import (
  	"cmp"
  	"context"
  	"fmt"
  	"os"

  	"github.com/anthropics/anthropic-sdk-go/v2"
  )

  func main() {
  	client := anthropic.NewClient()
  	ctx := context.Background()
  	sessionID := os.Getenv("SESSION_ID")

  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, sessionID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  	if _, err := client.Beta.Sessions.Events.Send(ctx, sessionID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: "Summarize what you did in one sentence.",
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
  			for _, block := range event.Content {
  				if block.Type == "text" {
  					fmt.Print(block.Text)
  				}
  			}
  		case anthropic.BetaManagedAgentsSessionErrorEvent:
  			fmt.Printf("\n[Error: %s]\n", cmp.Or(event.Error.Message, "unknown"))
  		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
  			if _, paused := event.StopReason.AsAny().(anthropic.BetaManagedAgentsSessionRequiresAction); !paused {
  				break events
  			}
  		case anthropic.BetaManagedAgentsSessionStatusTerminatedEvent:
  			break events
  		}
  	}
  	if err := stream.Err(); err != nil {
  		panic(err)
  	}
  }
  ```

  ```java Java
  import com.anthropic.client.AnthropicClient;
  import com.anthropic.client.okhttp.AnthropicOkHttpClient;
  import com.anthropic.core.JsonObject;
  import com.anthropic.models.beta.sessions.events.BetaManagedAgentsUserMessageEventParams;
  import com.anthropic.models.beta.sessions.events.EventSendParams;

  void main() {
      AnthropicClient client = AnthropicOkHttpClient.fromEnv();
      var sessionId = System.getenv("SESSION_ID");

      try (var stream = client.beta().sessions().events().streamStreaming(sessionId)) {
          client.beta().sessions().events().send(
              sessionId,
              EventSendParams.builder()
                  .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                      .addTextContent("Summarize what you did in one sentence.")
                      .build())
                  .build()
          );

          events:
          for (var event : stream) {
              switch (event.type().value()) {
                  case AGENT_MESSAGE -> {
                      for (var block : event.asAgentMessage().content()) {
                          block.text().ifPresent(textBlock -> IO.print(textBlock.text()));
                      }
                  }
                  case SESSION_ERROR -> {
                      var errorMessage =
                          event.asSessionError().error()._json().orElse(null) instanceof JsonObject json
                              ? json.values().get("message").asStringOrThrow()
                              : "unknown";
                      IO.println("\n[Error: " + errorMessage + "]");
                  }
                  case SESSION_STATUS_IDLE -> {
                      if (!event.asSessionStatusIdle().stopReason().isRequiresAction()) {
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
  }
  ```

  ```php PHP
  <?php

  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionErrorEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionRequiresAction;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusTerminatedEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;
  use Anthropic\Client;

  $client = new Client();
  $sessionId = (string) getenv('SESSION_ID');

  $stream = $client->beta->sessions->events->streamStream($sessionId);
  $client->beta->sessions->events->send(
      $sessionId,
      events: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => 'Summarize what you did in one sentence.']],
          ],
      ],
  );

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof ManagedAgentsAgentMessageEvent:
              foreach ($event->content as $block) {
                  if ($block instanceof ManagedAgentsTextBlock) {
                      echo $block->text;
                  }
              }
              break;
          case $event instanceof ManagedAgentsSessionErrorEvent:
              printf("\n[Error: %s]\n", $event->error->message);
              break;
          case $event instanceof ManagedAgentsSessionStatusIdleEvent:
              if (!($event->stopReason instanceof ManagedAgentsSessionRequiresAction)) {
                  break 2; // Break foreach loop
              }
              break;
          case $event instanceof ManagedAgentsSessionStatusTerminatedEvent:
              break 2; // Break foreach loop
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  require "anthropic"

  client = Anthropic::Client.new
  session_id = ENV.fetch("SESSION_ID")

  stream = client.beta.sessions.events.stream_events(session_id)

  client.beta.sessions.events.send_(
    session_id,
    events: [{
      type: "user.message",
      content: [{type: "text", text: "Summarize what you did in one sentence."}]
    }]
  )

  stream.each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      event.content.each do |block|
        print block.text if block.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsTextBlock)
      end
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionErrorEvent
      puts "\n[Error: #{event.error&.message || "unknown"}]"
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
      break unless event.stop_reason.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsSessionRequiresAction)
    when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusTerminatedEvent
      break
    else
      # ignore other event types
    end
  end
  ```
</CodeGroup>

Besides printing `agent.message` text, the loop handles three events:

* **`session.status_idle`:** The loop ends, unless the event’s `stop_reason.type` is `requires_action`.
* **`session.status_terminated`:** The loop ends.
* **`session.error`:** The loop prints the error’s message and keeps reading, because the server can retry a failed model call and finish the turn.

`requires_action` means that the session has paused for a tool call. What ends the pause depends on the call:

* **A custom tool call, or a request to confirm a tool call:** Only your code can answer it. If your agent uses either, see [Answer tool calls that pause the session](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#answer-tool-calls-that-pause-the-session).
* **A call to a tool that a worker runs, such as `bash`:** This call normally doesn’t pause the session. If no worker takes the call for about 3 minutes, the session pauses until a worker returns the result. Your code has nothing to answer then. Keep the stream open, and the turn resumes when a worker runs the call.

For the other events that a session sends, and how to reconnect without missing any, see [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).

## Move data in and out of a session

Data reaches a session and leaves it through the worker’s working directory.

On the quickstart stack, each session’s container starts with an empty `/workspace` directory, apart from clones of the session’s repositories. By default, about a minute after a turn ends, the container exits, and Docker deletes it together with that directory. Anything a session must keep has to leave through a tool call, such as an upload or a `git push`, before then.

A container also exits about an hour after it starts, even in the middle of a turn. No setting changes that. The turn continues in a new container, usually after a minute or two, and your client gets no event for the switch. The switch has two costs:

* **Commands:** Everything that runs in the old container stops. The new container runs the interrupted tool call again from the start, but nothing restarts a command that the agent left running in the background.
* **Files:** The new container’s `/workspace` is empty again, apart from fresh clones of the session’s repositories.

In a long turn, have the agent upload or push its work as it goes, and avoid commands that cause harm if they run twice.

On Kubernetes, a session keeps one pod for about an hour at most, and the turn continues in the same way. Two things differ: the new pod finds the session’s files in `/workspace`, and it starts about 6 minutes after the old pod stops.

For workers that you start yourself, put input files in the working directory before you send the message that needs them. Read output files from it afterward.

When you start a container for each session yourself, mount a directory that holds the session’s input files as the container’s working directory. Collect the output files from it after the container exits. See [Stage files for a session](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#stage-files-for-a-session).

## Find more examples in the hosted guides

The hosted service’s guides explain the API’s [core concepts](https://platform.claude.com/docs/en/managed-agents/overview#core-concepts) and have examples for each feature. Their SDK and CLI examples call your server when you run them in the terminal where `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are set. Their cURL examples name `https://api.anthropic.com`, so replace that address with `$ANTHROPIC_BASE_URL` before you run one.

For some features, your server needs a setting first, or an example needs a change:

| Task                                              | Hosted guide                                                                                                                                                                | On your server                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set an agent’s model, system prompt, and versions | [Define your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup)                                                                                         | Some fields [depend on your inference provider](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#differences-that-depend-on-your-inference-provider).                                                                                                                                            |
| Choose built-in tools, or add custom tools        | [Tools](https://platform.claude.com/docs/en/managed-agents/tools)                                                                                                           | To use the web tools, turn them on first, as [Web tools need a server setting](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#web-tools-need-a-server-setting) describes. Which ones exist depends on your inference provider.                                                                 |
| Connect an MCP server and store its token         | [MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector) and [Authenticate with vaults](https://platform.claude.com/docs/en/managed-agents/vaults) | Add the MCP server’s host to the [allowlist for MCP servers](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#mcp-servers-need-an-allowlist-entry). Store the token as a `static_bearer` credential.                                                                                             |
| Give an agent skills                              | [Skills](https://platform.claude.com/docs/en/managed-agents/skills)                                                                                                         | Upload each skill as individual files, because your server refuses a zip archive. The [prebuilt skills](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#features-that-arent-available) in that guide’s examples aren’t available.                                                               |
| Keep memory across sessions                       | [Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory)                                                                                             | If you run your own workers, give them a writable `/mnt/memory` directory, as in [Memory stores in self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory).                                                                                                                |
| Hand work to other agents                         | [Multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration)                                                                     | Replace the `multiagent_20261001` block in that guide’s examples with a [`coordinator` block](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#features-that-behave-differently).                                                                                                                |
| Work in a Git repository                          | [Accessing GitHub](https://platform.claude.com/docs/en/managed-agents/github)                                                                                               | List the Git host in your server’s settings, as [Git repositories need an allowlist entry](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#git-repositories-need-an-allowlist-entry) describes. That guide’s example agent also needs `api.githubcopilot.com` on the allowlist for MCP servers. |
| Have a grader check the work against a rubric     | [Define outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes)                                                                                       | Send the rubric as text. The Files API isn’t available, so [collect output files](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#move-data-in-and-out-of-a-session) from the working directory.                                                                                               |
| Follow a session and answer its tool calls        | [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)                                                                             | That guide’s first example closes the stream at any pause, so start from the loop in [Send a message and read the reply](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#send-a-message-and-read-the-reply) instead.                                                                           |

[Differences from the hosted service](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences) has the full list. Check it before you move an existing application.

## Run your own workers

The [quickstart stack](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart) creates an environment and runs its workers. So do the Helm charts in [Deploy on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes). If those workers are all that you need, skip this section.

You run workers as you do for [self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes): the same `ant beta:worker` commands and SDK workers, in the ways that [Deploy self-hosted workers](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers) shows. The exception is workers triggered by webhooks, because your server sends none.

### Create an environment and its key

Create an environment and an environment key with the admin CLI, not in the Claude Console. The CLI, `cma-server-admin`, is at the top of the release archive, so run the command from there. For `-base-url`, pass the address where your workers reach the server:

* **Workers on the machine that runs the quickstart stack:** `http://127.0.0.1:8400`
* **Workers on another machine:** the `https` address of the [TLS proxy that you put in front of the server](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#put-tls-in-front-of-the-server)

The admin CLI calls the server at the same address, so run it on a machine that can reach that address.

```bash
echo "$ANTHROPIC_API_KEY" | ./cma-server-admin bootstrap \
  -base-url http://127.0.0.1:8400 -name my-env -key-file -
```

The command prints the worker’s settings, the command that starts a worker, and the key’s ID and expiry:

```text wrap
export ANTHROPIC_BASE_URL='http://127.0.0.1:8400'
export ANTHROPIC_ENVIRONMENT_ID='env_...'
export ANTHROPIC_ENVIRONMENT_KEY='sk-ant-oat01-...'
# then: histchars= HISTFILE=/dev/null ant beta:worker poll --workdir /workspace
# key id: 'etok_...'  expires: '...'
```

The command shows the key only once, so store the key, its ID, and its expiry in your secret manager. The key stops working after 365 days. Before then, follow [Replace an environment key for your own workers](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#replace-an-environment-key-for-your-own-workers).

Keep the server API key off the machines that run workers. Run workers in a container or VM that holds nothing you need to protect. For your other security duties, see [Your security responsibilities](https://platform.claude.com/docs/en/managed-agents/self-hosted#your-security-responsibilities).

### Run a local experiment

Run the three `export` lines in the shell where you start the worker. Then start the worker with these commands, not the printed one. The first command creates the worker’s working directory, because the worker doesn’t create it:

```bash
mkdir -p "$HOME/cma-workspace" "$HOME/.config/cma"
cat > "$HOME/.config/cma/worker.inputrc" <<'EOF'
$include /etc/inputrc
set disable-completion on
EOF
histchars= HISTFILE=/dev/null INPUTRC="$HOME/.config/cma/worker.inputrc" \
  ant beta:worker poll --workdir "$HOME/cma-workspace"
```

`histchars`, `INPUTRC`, and `HISTFILE` set up the shell behind the worker’s `bash` tool, so that it runs each command as the agent wrote it:

* **`histchars=`:** The shell doesn’t treat `!` as a reference to its command history.
* **`INPUTRC`:** The file turns off completion, which would otherwise consume each tab character in a command. Keep the file out of the working directory, where the agent’s file tools could rewrite it.
* **`HISTFILE=/dev/null`:** The shell neither reads nor writes a history file.

Use this worker for nothing else. It holds the environment key and runs every session’s tools in one process. It doesn’t clone a session’s repositories either. The session runs without them, and your client gets no error.

### Run workers in production

For anything but a local experiment, start one container for each session and run `ant beta:worker run` in it, as [Run one sandbox per session](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-one-sandbox-per-session) shows. Give its image what [Build your own sandbox image](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#build-your-own-sandbox-image) lists, and change three things in that setup:

* **Environment key:** Don’t pass `ANTHROPIC_ENVIRONMENT_KEY` into a session’s container. The server accepts that key for every session in the environment, and the container needs access to one session only.
* **Work item’s secret:** Pass this secret in place of the key, because the server accepts it for that one session only. [Forward the work item’s secret](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#forward-the-work-items-secret) shows where your code receives it. Where that section sets `ANTHROPIC_WORK_SECRET`, put the secret in a file that only the container’s user can read. For example, pipe the secret to the container’s standard input, and have the container write the file before it starts the worker. Then set `ANTHROPIC_WORK_SECRET_FILE` to the file’s path.
* **Server address:** Set `ANTHROPIC_BASE_URL` to an address that the container can reach. `http://127.0.0.1:8400` isn’t one.

For an SDK worker, two more points apply:

* **Version:** Build the worker on the latest version of the SDK, as [SDKs, CLI, and libraries](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) describes. That version’s worker waits for approval before it runs a tool call that needs it, and never runs a call that a policy denies. A worker built on an earlier version runs every tool call as soon as it arrives.
* **Samples:** The samples in [Run the SDK worker inside the sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-the-sdk-worker-inside-the-sandbox) read the environment key, so they don’t work here as they are.

### Build your own sandbox image

An image of your own needs these packages and settings:

* **Packages:** Git 2.38 or later, `curl`, `jq`, and ripgrep, which the worker’s `grep` tool searches with.

* **Shell settings:** `histchars`, `HISTFILE`, and `INPUTRC`, as in the local experiment, and `TERMINFO`. Put these lines in the Dockerfile, before any `USER` line:

  ```dockerfile
  ENV histchars=
  RUN printf '\nset disable-completion on\n' >> /etc/inputrc
  ENV INPUTRC=/etc/inputrc TERMINFO=/etc/terminfo HISTFILE=/dev/null
  RUN test -r /etc/terminfo/d/dumb
  ```

  `TERMINFO` must name the directory that holds `d/dumb`, the terminal description that the worker’s `bash` reads. On Alpine with `bash` installed, that’s `/etc/terminfo`, as shown. On another base, such as Debian or Ubuntu, it’s `/lib/terminfo` or `/usr/share/terminfo`, whichever holds `d/dumb`. Write that directory in the `TERMINFO` setting and in the `RUN test` line, which stops the build if the file is missing.

The image also needs two scripts from the archive, which run before the worker starts:

1. Copy `image-build/with-repositories.sh` to `/usr/local/bin/cma-with-repositories`. It clones one session’s repositories.
2. Copy `image-build/with-egress.sh` to `/usr/local/bin/cma-with-egress`. It points the session’s tools at the [egress gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#environment-variable-credentials), if your server runs one.
3. Make both files executable.
4. Put both in front of the worker’s command, as in `cma-with-egress cma-with-repositories ant beta:worker run ...`. Skip this step if your image runs the archive’s `kubernetes/sandbox/worker.sh`, because that script starts the worker this way.

A worker that starts without `cma-with-repositories` runs the session with no repository. Your client gets no error.

### Move workers from the hosted service

If you already run workers for Anthropic’s hosted service, the same workers can serve your server instead. Do three things:

* Give the process that polls for work the three `export` values that the admin CLI printed.
* Start that process with `histchars`, `HISTFILE`, and `INPUTRC` set, as in the local experiment.
* Make the changes that [Run workers in production](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#run-workers-in-production) describes, and check each session’s image against [Build your own sandbox image](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#build-your-own-sandbox-image).

## Next steps

* [Let developers log in from a terminal](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#let-developers-log-in-from-a-terminal): Set up single sign-on, so that developers use the `ant` CLI under their own identity, in a terminal without `ANTHROPIC_API_KEY`.
* [Agent identity and credentials](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity): Let outside systems trust your agents, and keep vault credentials in your secret manager.
* [Inference provider](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider): Send model calls to a cloud provider or your own model gateway.
