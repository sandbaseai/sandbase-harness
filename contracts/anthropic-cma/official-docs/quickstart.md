---
title: Get started with Claude Managed Agents
url: https://platform.claude.com/docs/en/managed-agents/quickstart
description: Create your first autonomous agent.
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

This guide walks you through creating an agent, setting up an environment, starting a session, and streaming agent responses.

Let Claude Code set up your agent for you

```text
/claude-api managed-agents-onboard
```

## Core concepts

| Concept         | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Agent**       | The model, system prompt, tools, MCP servers, and skills                                                                      |
| **Environment** | Configuration for where sessions run: an Anthropic-managed cloud sandbox, or a self-hosted sandbox on your own infrastructure |
| **Session**     | A running agent instance within an environment, performing a specific task and generating outputs                             |
| **Events**      | Messages exchanged between your application and the agent (user turns, tool results, status updates)                          |

## Prerequisites

* A [Claude Console account](https://platform.claude.com/)
* An [API key](https://platform.claude.com/settings/keys) from the Console

## Install the CLI

<Tabs>
  <Tab title="Homebrew (macOS)">
    ```bash
    brew install anthropics/tap/ant
    ```
  </Tab>

  <Tab title="curl (Linux/WSL)">
    For Linux environments, download the release binary directly.

    ```bash
    VERSION=2.4.0
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case $(uname -m) in
      x86_64) ARCH=amd64 ;;
      aarch64) ARCH=arm64 ;;
    esac
    curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${VERSION}/ant_${VERSION}_${OS}_${ARCH}.tar.gz" \
      | sudo tar -xz -C /usr/local/bin ant
    ```

    You can find all releases on the [GitHub releases page](https://github.com/anthropics/anthropic-cli/releases).
  </Tab>

  <Tab title="Go">
    You can also install the CLI from source using `go install`. Requires Go 1.25 or later.

    ```bash
    go install github.com/anthropics/anthropic-cli/v2/cmd/ant@latest
    ```

    The binary is placed in `$(go env GOPATH)/bin`. Add it to your `PATH` if it isn’t already:

    ```bash
    export PATH="$PATH:$(go env GOPATH)/bin"
    ```
  </Tab>
</Tabs>

Check the installation:

```bash
ant --version
```

## Install the SDK

<Tabs>
  <Tab title="Python">
    ```bash
    pip install anthropic
    ```
  </Tab>

  <Tab title="TypeScript">
    ```bash
    npm install @anthropic-ai/sdk
    ```
  </Tab>

  <Tab title="Java">
    ```groovy Gradle
    implementation("com.anthropic:anthropic-java:3.3.0")
    ```
  </Tab>

  <Tab title="Go">
    ```bash
    go get github.com/anthropics/anthropic-sdk-go/v2
    ```
  </Tab>

  <Tab title="C#">
    ```bash
    dotnet add package Anthropic
    ```
  </Tab>

  <Tab title="Ruby">
    ```bash
    bundle add anthropic
    ```
  </Tab>

  <Tab title="PHP">
    ```bash
    composer require "anthropic-ai/sdk" "guzzlehttp/guzzle:^7"
    ```
  </Tab>
</Tabs>

Set your API key as an environment variable:

```bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

## Create your first session

<Steps>
  <Step title="Create an agent">
    Create an agent that defines the model, system prompt, and available tools.

    <CodeGroup defaultLanguage="CLI">
      <CodeGroupItem>
        ```bash cURL
        curl -sS --fail-with-body https://api.anthropic.com/v1/agents \
          -H "x-api-key: $ANTHROPIC_API_KEY" \
          -H "anthropic-version: 2023-06-01" \
          -H "anthropic-beta: managed-agents-2026-04-01" \
          -H "content-type: application/json" \
          -d '{
            "name": "Coding Assistant",
            "model": "claude-opus-5-5",
            "system": "You are a helpful coding assistant. Write clean, well-documented code.",
            "tools": [
              {"type": "agent_toolset_20260401"}
            ]
          }'
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```bash CLI
        ant apply coding-assistant.md
        ```

        <File filename="coding-assistant.md">
          ```markdown
          ---
          name: Coding Assistant
          model: claude-opus-5-5
          tools:
            - type: agent_toolset_20260401
          ---

          You are a helpful coding assistant. Write clean, well-documented code.
          ```
        </File>

        [`ant apply`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply) prints the agent’s ID and records it in `claude-lock.json`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```python Python
        from anthropic import Anthropic

        client = Anthropic()

        agent = client.beta.agents.create(
            name="Coding Assistant",
            model="claude-opus-5-5",
            system="You are a helpful coding assistant. Write clean, well-documented code.",
            tools=[
                {"type": "agent_toolset_20260401"},
            ],
        )

        print(f"Agent ID: {agent.id}, version: {agent.version}")
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```typescript TypeScript
        import Anthropic from "@anthropic-ai/sdk";

        const client = new Anthropic();

        const agent = await client.beta.agents.create({
          name: "Coding Assistant",
          model: "claude-opus-5-5",
          system: "You are a helpful coding assistant. Write clean, well-documented code.",
          tools: [{ type: "agent_toolset_20260401" }]
        });

        console.log(`Agent ID: ${agent.id}, version: ${agent.version}`);
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```csharp C#
        using Anthropic;
        using Anthropic.Models.Beta.Agents;
        using Anthropic.Models.Beta.Environments;
        using Anthropic.Models.Beta.Sessions;
        using Anthropic.Models.Beta.Sessions.Events;

        var client = new AnthropicClient();

        var agent = await client.Beta.Agents.Create(new()
        {
            Name = "Coding Assistant",
            Model = BetaManagedAgentsModel.ClaudeOpus5_5,
            System = "You are a helpful coding assistant. Write clean, well-documented code.",
            Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
        });

        Console.WriteLine($"Agent ID: {agent.ID}, version: {agent.Version}");
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```go Go
        package main

        import (
        	"context"
        	"fmt"

        	"github.com/anthropics/anthropic-sdk-go/v2"
        )

        func main() {
        	client := anthropic.NewClient()
        	ctx := context.Background()

        	agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
        		Name: "Coding Assistant",
        		Model: anthropic.BetaManagedAgentsModelConfigParams{
        			ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
        		},
        		System: anthropic.String("You are a helpful coding assistant. Write clean, well-documented code."),
        		Tools: []anthropic.BetaAgentNewParamsToolUnion{{
        			OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
        		}},
        	})
        	if err != nil {
        		panic(err)
        	}

        	fmt.Printf("Agent ID: %s, version: %d\n", agent.ID, agent.Version)
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```java Java
        import com.anthropic.client.okhttp.AnthropicOkHttpClient;
        import com.anthropic.models.beta.agents.AgentCreateParams;
        import com.anthropic.models.beta.agents.BetaManagedAgentsAgentToolset20260401Params;
        import com.anthropic.models.beta.agents.BetaManagedAgentsModel;
        import com.anthropic.models.beta.environments.BetaCloudConfigParams;
        import com.anthropic.models.beta.environments.BetaLimitedNetworkParams;
        import com.anthropic.models.beta.environments.EnvironmentCreateParams;
        import com.anthropic.models.beta.sessions.SessionCreateParams;
        import com.anthropic.models.beta.sessions.events.BetaManagedAgentsStreamSessionEvents;
        import com.anthropic.models.beta.sessions.events.BetaManagedAgentsUserMessageEventParams;
        import com.anthropic.models.beta.sessions.events.EventSendParams;

        void main() {
            var client = AnthropicOkHttpClient.fromEnv();

            var agent = client.beta().agents().create(AgentCreateParams.builder()
                .name("Coding Assistant")
                .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
                .system("You are a helpful coding assistant. Write clean, well-documented code.")
                .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
                .build());

            IO.println("Agent ID: " + agent.id() + ", version: " + agent.version());
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```php PHP
        use Anthropic\Beta\Agents\BetaManagedAgentsModel;
        use Anthropic\Client;

        $client = new Client();

        $agent = $client->beta->agents->create(
            name: 'Coding Assistant',
            model: BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
            system: 'You are a helpful coding assistant. Write clean, well-documented code.',
            tools: [
                ['type' => 'agent_toolset_20260401'],
            ],
        );

        echo "Agent ID: {$agent->id}, version: {$agent->version}\n";
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>

      <CodeGroupItem>
        ```ruby Ruby
        require "anthropic"

        client = Anthropic::Client.new

        agent = client.beta.agents.create(
          name: "Coding Assistant",
          model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
          system_: "You are a helpful coding assistant. Write clean, well-documented code.",
          tools: [{type: "agent_toolset_20260401"}]
        )

        puts "Agent ID: #{agent.id}, version: #{agent.version}"
        ```

        Save the returned `agent.id`. You’ll reference it in every session you create.
      </CodeGroupItem>
    </CodeGroup>

    The `agent_toolset_20260401` tool type enables the full set of pre-built agent tools (bash, file operations, web search, and more). See [Tools](https://platform.claude.com/docs/en/managed-agents/tools) for the complete list and per-tool configuration options.
  </Step>

  <Step title="Create an environment">
    An environment defines the sandbox where your agent runs. This one uses `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking) with package managers allowed, so code running in the sandbox can reach public [package registries and code hosts](https://platform.claude.com/docs/en/managed-agents/environments#package-manager-hosts). Web search and web fetch run outside the sandbox, and this quickstart does not need them. With `limited` networking, the [`allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) list](https://platform.claude.com/docs/en/managed-agents/environments#networking) applies to them too. They return no pages or search results in this environment, because it lists no hosts. For your own agent, list the hosts it needs in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`).

    <CodeGroup defaultLanguage="CLI">
      <CodeGroupItem>
        ```bash cURL
        curl -sS --fail-with-body https://api.anthropic.com/v1/environments \
          -H "x-api-key: $ANTHROPIC_API_KEY" \
          -H "anthropic-version: 2023-06-01" \
          -H "anthropic-beta: managed-agents-2026-04-01" \
          -H "content-type: application/json" \
          -d '{
            "name": "quickstart-env",
            "config": {
              "type": "cloud",
              "networking": {"type": "limited", "allow_package_managers": true}
            }
          }'
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```bash CLI
        ant apply environment.yaml
        ```

        <File filename="environment.yaml">
          ```yaml
          # yaml-language-server: $schema=https://platform.claude.com/schemas/ant/beta/environment.json
          name: quickstart-env
          config:
            type: cloud
            networking:
              type: limited
              allow_package_managers: true
          ```
        </File>

        [`ant apply`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply) records the environment’s ID in `claude-lock.json` too. To create the agent and the environment with one command, pass both files: `ant apply coding-assistant.md environment.yaml`.
      </CodeGroupItem>

      <CodeGroupItem>
        ```python Python
        environment = client.beta.environments.create(
            name="quickstart-env",
            config={
                "type": "cloud",
                "networking": {"type": "limited", "allow_package_managers": True},
            },
        )

        print(f"Environment ID: {environment.id}")
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```typescript TypeScript
        const environment = await client.beta.environments.create({
          name: "quickstart-env",
          config: {
            type: "cloud",
            networking: { type: "limited", allow_package_managers: true }
          }
        });

        console.log(`Environment ID: ${environment.id}`);
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```csharp C#
        var environment = await client.Beta.Environments.Create(new()
        {
            Name = "quickstart-env",
            Config = new BetaCloudConfigParams
            {
                Networking = new BetaLimitedNetworkParams { AllowPackageManagers = true },
            },
        });

        Console.WriteLine($"Environment ID: {environment.ID}");
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```go Go
        environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
        	Name: "quickstart-env",
        	Config: anthropic.BetaEnvironmentNewParamsConfigUnion{
        		OfCloud: &anthropic.BetaCloudConfigParams{
        			Networking: anthropic.BetaCloudConfigParamsNetworkingUnion{
        				OfLimited: &anthropic.BetaLimitedNetworkParams{
        					AllowPackageManagers: anthropic.Bool(true),
        				},
        			},
        		},
        	},
        })
        if err != nil {
        	panic(err)
        }

        fmt.Printf("Environment ID: %s\n", environment.ID)
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```java Java
        var environment = client.beta().environments().create(EnvironmentCreateParams.builder()
            .name("quickstart-env")
            .config(BetaCloudConfigParams.builder()
                .networking(BetaLimitedNetworkParams.builder()
                    .allowPackageManagers(true)
                    .build())
                .build())
            .build());

        IO.println("Environment ID: " + environment.id());
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```php PHP
        $environment = $client->beta->environments->create(
            name: 'quickstart-env',
            config: [
                'type' => 'cloud',
                'networking' => ['type' => 'limited', 'allow_package_managers' => true],
            ],
        );

        echo "Environment ID: {$environment->id}\n";
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>

      <CodeGroupItem>
        ```ruby Ruby
        environment = client.beta.environments.create(
          name: "quickstart-env",
          config: {type: "cloud", networking: {type: "limited", allow_package_managers: true}}
        )

        puts "Environment ID: #{environment.id}"
        ```

        Save the returned `environment.id` too.
      </CodeGroupItem>
    </CodeGroup>

    <Tip>
      This quickstart uses a cloud environment. To decide whether to run tools on your own infrastructure with a 

      [self-hosted sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)

       instead, see 

      [Choosing an agent environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment)

      .
    </Tip>
  </Step>

  <Step title="Start a session">
    Create a session that references your agent and environment.

    <CodeGroup>
      ```bash cURL
      curl -sS --fail-with-body https://api.anthropic.com/v1/sessions \
        -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: managed-agents-2026-04-01" \
        -H "content-type: application/json" \
        -d '{
          "agent": "'"$AGENT_ID"'",
          "environment_id": "'"$ENVIRONMENT_ID"'",
          "title": "Quickstart session"
        }'
      ```

      ```bash CLI
      ant beta:sessions create \
        --agent "$AGENT_ID" \
        --environment-id "$ENVIRONMENT_ID" \
        --title "Quickstart session"
      ```

      ```python Python
      session = client.beta.sessions.create(
          agent=agent.id,
          environment_id=environment.id,
          title="Quickstart session",
      )

      print(f"Session ID: {session.id}")
      ```

      ```typescript TypeScript
      const session = await client.beta.sessions.create({
        agent: agent.id,
        environment_id: environment.id,
        title: "Quickstart session"
      });

      console.log(`Session ID: ${session.id}`);
      ```

      ```csharp C#
      var session = await client.Beta.Sessions.Create(new()
      {
          Agent = agent.ID,
          EnvironmentID = environment.ID,
          Title = "Quickstart session",
      });

      Console.WriteLine($"Session ID: {session.ID}");
      ```

      ```go Go
      session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
      	Agent:         anthropic.BetaSessionNewParamsAgentUnion{OfString: anthropic.String(agent.ID)},
      	EnvironmentID: environment.ID,
      	Title:         anthropic.String("Quickstart session"),
      })
      if err != nil {
      	panic(err)
      }

      fmt.Printf("Session ID: %s\n", session.ID)
      ```

      ```java Java
      var session = client.beta().sessions().create(SessionCreateParams.builder()
          .agent(agent.id())
          .environmentId(environment.id())
          .title("Quickstart session")
          .build());

      IO.println("Session ID: " + session.id());
      ```

      ```php PHP
      $session = $client->beta->sessions->create(
          agent: $agent->id,
          environmentID: $environment->id,
          title: 'Quickstart session',
      );

      echo "Session ID: {$session->id}\n";
      ```

      ```ruby Ruby
      session = client.beta.sessions.create(
        agent: agent.id,
        environment_id: environment.id,
        title: "Quickstart session"
      )

      puts "Session ID: #{session.id}"
      ```
    </CodeGroup>
  </Step>

  <Step title="Send a message and stream the response">
    Open a stream, send a user event, then process events as they arrive:

    <CodeGroup exclude="shell">
      <CodeGroupItem language="cURL">
        This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
      </CodeGroupItem>

      <CodeGroupItem language="CLI">
        This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
      </CodeGroupItem>

      ```python Python
      with client.beta.sessions.events.stream(session.id) as stream:
          # Send the user message after the stream opens
          client.beta.sessions.events.send(
              session.id,
              events=[
                  {
                      "type": "user.message",
                      "content": [
                          {
                              "type": "text",
                              "text": "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt",
                          },
                      ],
                  },
              ],
          )

          # Process streaming events
          for event in stream:
              match event.type:
                  case "agent.message":
                      for block in event.content:
                          if block.type == "text":
                              print(block.text, end="")
                  case "agent.tool_use":
                      print(f"\n[Using tool: {event.name}]")
                  case "session.status_idle":
                      print("\n\nAgent finished.")
                      break
      ```

      ```typescript TypeScript
      const stream = await client.beta.sessions.events.stream(session.id);

      // Send the user message after the stream opens
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.message",
            content: [
              {
                type: "text",
                text: "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt"
              }
            ]
          }
        ]
      });

      // Process streaming events
      loop: for await (const event of stream) {
        switch (event.type) {
          case "agent.message":
            for (const block of event.content) {
              if (block.type === "text") {
                process.stdout.write(block.text);
              }
            }
            break;
          case "agent.tool_use":
            console.log(`\n[Using tool: ${event.name}]`);
            break;
          case "session.status_idle":
            console.log("\n\nAgent finished.");
            break loop;
        }
      }
      ```

      ```csharp C#
      var stream = client.Beta.Sessions.Events.StreamStreaming(session.ID);

      // Send the user message after the stream opens
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
                          Text = "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt",
                      },
                  ],
              },
          ],
      });

      // Process streaming events
      await foreach (var streamEvent in stream)
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
          else if (streamEvent.Value is BetaManagedAgentsAgentToolUseEvent toolUse)
          {
              Console.WriteLine($"\n[Using tool: {toolUse.Name}]");
          }
          else if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent)
          {
              Console.WriteLine("\n\nAgent finished.");
              break;
          }
      }
      ```

      ```go Go
      	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
      	defer stream.Close()

      	// Send the user message after the stream opens
      	_, err = client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
      		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
      			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
      				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
      					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
      						Text: "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt",
      					},
      				}},
      			},
      		}},
      	})
      	if err != nil {
      		panic(err)
      	}

      	// Process streaming events
      loop:
      	for stream.Next() {
      		switch event := stream.Current().AsAny().(type) {
      		case anthropic.BetaManagedAgentsAgentMessageEvent:
      			for _, block := range event.Content {
      				if block.Type == "text" {
      					fmt.Print(block.Text)
      				}
      			}
      		case anthropic.BetaManagedAgentsAgentToolUseEvent:
      			fmt.Printf("\n[Using tool: %s]\n", event.Name)
      		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
      			fmt.Print("\n\nAgent finished.\n")
      			break loop
      		}
      	}
      	if err := stream.Err(); err != nil {
      		panic(err)
      	}
      ```

      ```java Java
      try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
          // Send the user message after the stream opens
          client.beta().sessions().events().send(session.id(), EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                  .addTextContent("Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt")
                  .build())
              .build());

          // Process streaming events
          loop:
          for (var event : (Iterable<BetaManagedAgentsStreamSessionEvents>) stream.stream()::iterator) {
              switch (event.type().value()) {
                  case AGENT_MESSAGE -> event.asAgentMessage().content().forEach(block -> block.text().ifPresent(textBlock -> IO.print(textBlock.text())));
                  case AGENT_TOOL_USE -> IO.println("\n[Using tool: " + event.asAgentToolUse().name() + "]");
                  case SESSION_STATUS_IDLE -> {
                      IO.println("\n\nAgent finished.");
                      break loop;
                  }
              }
          }
      }
      ```

      ```php PHP
      $stream = $client->beta->sessions->events->streamStream($session->id);

      // Send the user message after the stream opens
      $client->beta->sessions->events->send(
          $session->id,
          events: [
              [
                  'type' => 'user.message',
                  'content' => [
                      ['type' => 'text', 'text' => 'Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt'],
                  ],
              ],
          ],
      );

      // Process streaming events
      foreach ($stream as $event) {
          match (true) {
              $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent => array_walk(
                  $event->content,
                  static fn ($block) => $block instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock ? print($block->text) : null,
              ),
              $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsAgentToolUseEvent => print("\n[Using tool: {$event->name}]\n"),
              $event instanceof \Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent => print("\n\nAgent finished.\n"),
              default => null,
          };
          if ($event->type === 'session.status_idle') {
              break;
          }
      }
      ```

      ```ruby Ruby
      stream = client.beta.sessions.events.stream_events(session.id)

      # Send the user message after the stream opens
      client.beta.sessions.events.send_(
        session.id,
        events: [{
          type: "user.message",
          content: [{type: "text", text: "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt"}]
        }]
      )

      # Process streaming events
      stream.each do |event|
        case event
        when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
          event.content.each { print it.text if it.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsTextBlock) }
        when Anthropic::Beta::Sessions::BetaManagedAgentsAgentToolUseEvent
          puts "\n[Using tool: #{event.name}]"
        when Anthropic::Beta::Sessions::BetaManagedAgentsSessionStatusIdleEvent
          puts "\n\nAgent finished."
          break
        else
          # ignore other event types
        end
      end
      ```
    </CodeGroup>

    The agent writes a Python script, runs it in the sandbox, and verifies the output file was created. Your output looks similar to this:

    ```text wrap
    I'll create a Python script that generates the first 20 Fibonacci numbers and saves them to a file.
    [Using tool: write]
    [Using tool: bash]
    The script ran successfully. Let me verify the output file.
    [Using tool: bash]
    fibonacci.txt contains the first 20 Fibonacci numbers (0 through 4181).

    Agent finished.
    ```
  </Step>
</Steps>

## What’s happening

When you send a user event, Claude Managed Agents:

1. **Provisions a sandbox:** Your environment configuration determines how it’s built.
2. **Runs the agent loop:** Claude determines which tools to use based on your message.
3. **Runs tools:** File writes, bash commands, and other tool calls run inside the sandbox.
4. **Streams events:** You receive real-time updates as the agent works.
5. **Goes idle:** The agent emits a `session.status_idle` event when it has nothing more to do.

## Build a complete app

Each of these quickstarts pairs Claude Managed Agents with a popular chat framework to make a complete, runnable application. In each one, the framework renders the chat surface while a managed session runs the agent loop server-side: the session holds the transcript, runs tools in a sandbox, and streams events that the front end renders.

<CardGroup cols={3}>
  <Card title="Chat SDK" icon="github-logo" href="https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/chat-sdk">
    A research analyst in a browser chat built with Vercel’s Chat SDK. Each conversation is one persistent session that streams its reply while a live feed shows the tool calls. Swapping the Chat SDK adapter moves the same handler to Slack, Teams, Discord, or WhatsApp.
  </Card>

  <Card title="assistant-ui" icon="github-logo" href="https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/assistant-ui">
    A spreadsheet analyst in a chat built from assistant-ui primitives. Sessions are the thread list, one reducer turns the session event log into messages and tool cards, and each bash command renders an inline Allow/Deny gate before it runs.
  </Card>

  <Card title="CopilotKit (AG-UI)" icon="github-logo" href="https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/copilot-kit-ag-ui">
    A personal finance assistant in a CopilotKit chat. The AG-UI adapter for Claude Managed Agents maps each chat thread to a managed session and streams replies token by token, and custom tools render interactive charts inline in the conversation.
  </Card>
</CardGroup>

## Next steps

<CardGroup cols={2}>
  <Card title="Define your agent" icon="brain" href="https://platform.claude.com/docs/en/managed-agents/agent-setup">
    Create reusable, versioned agent configurations
  </Card>

  <Card title="Configure environments" icon="settings" href="https://platform.claude.com/docs/en/managed-agents/environments">
    Customize networking and sandbox settings
  </Card>

  <Card title="Agent tools" icon="tool" href="https://platform.claude.com/docs/en/managed-agents/tools">
    Enable specific tools for your agent
  </Card>

  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Handle events and steer the agent while it runs
  </Card>

  <Card title="Scheduled deployments" icon="arrows-clockwise" href="https://platform.claude.com/docs/en/managed-agents/scheduled-deployments">
    Run your agent on a recurring cron schedule
  </Card>

  <Card title="Knowledge wiki quickstart" icon="github-logo" href="https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki">
    Distill a document corpus once into a knowledge wiki, then answer repeated questions from it at a fraction of the cost
  </Card>
</CardGroup>
