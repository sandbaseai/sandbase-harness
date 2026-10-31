---
title: Migration
url: https://platform.claude.com/docs/en/managed-agents/migration
description: Move an existing agent built on the Messages API or the Claude Agent SDK to Claude Managed Agents.
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

Claude Managed Agents replaces your hand-written agent loop with managed infrastructure. This page covers what changes when you migrate from a custom loop built on the [Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages) or from the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

## From a Messages API agent loop

If you built an agent by calling `client.messages.create()` (csharp: `client.Messages.Create()`; go: `client.Messages.New()`; java: `client.messages().create()`; php: `$client->messages->create()`; cli: `ant messages create`; curl: `POST /v1/messages`) in a loop, running tool calls yourself, and appending results to the conversation history, most of that code goes away.

### What you stop managing

| Before                                                                                           | After                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| You maintain the conversation history array and pass it back on every turn.                      | The session stores history server-side. You send events and receive events.                                                |
| You iterate `tool_use` content blocks, run each tool, and loop back with `tool_result` messages. | Pre-built tools run inside the sandbox automatically. You only handle custom tools through `agent.custom_tool_use` events. |
| You provision your own sandbox for running agent-generated code.                                 | The session sandbox handles code execution, file operations, and bash.                                                     |
| You decide when the loop is done.                                                                | The session emits `session.status_idle` when the agent has nothing more to do.                                             |

### Code comparison

**Before** (Messages API loop, simplified):

<CodeGroup exclude="shell:cURL, shell:CLI">
  ```python Python
  messages = [{"role": "user", "content": task}]
  while True:
      response = client.messages.create(
          model="claude-opus-5-5",
          max_tokens=1024,
          messages=messages,
          tools=tools,
      )
      messages.append({"role": "assistant", "content": response.content})
      if response.stop_reason == "end_turn":
          break
      for block in response.content:
          if block.type == "tool_use":
              result = execute_tool(block.name, block.input)
              messages.append(
                  {
                      "role": "user",
                      "content": [
                          {
                              "type": "tool_result",
                              "tool_use_id": block.id,
                              "content": result,
                          }
                      ],
                  }
              )
  ```

  ```typescript TypeScript
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      messages,
      tools
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "end_turn") {
      break;
    }
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = executeTool(block.name, block.input);
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: block.id,
              content: result
            }
          ]
        });
      }
    }
  }
  ```

  ```csharp C#
  List<MessageParam> messages = [new UserMessageParam { Content = task }];
  while (true)
  {
      var response = await client.Messages.Create(new()
      {
          Model = Model.ClaudeOpus5_5,
          MaxTokens = 1024,
          Messages = messages,
          Tools = tools,
      });
      messages.Add(new AssistantMessageParam
      {
          Content = new([.. response.Content.Select(block => new ContentBlockParam(block.Json))]),
      });
      if (response.StopReason == StopReason.EndTurn)
      {
          break;
      }
      foreach (var block in response.Content)
      {
          if (block.Value is ToolUseBlock toolUse)
          {
              var result = ExecuteTool(toolUse.Name, toolUse.Input);
              messages.Add(new UserMessageParam
              {
                  Content = new([new ToolResultBlockParam { ToolUseID = toolUse.ID, Content = result }]),
              });
          }
      }
  }
  ```

  ```go Go
  messages := []anthropic.MessageParam{
  	anthropic.NewUserMessage(anthropic.NewTextBlock(task)),
  }
  for {
  	response, err := client.Messages.New(ctx, anthropic.MessageNewParams{
  		Model:     anthropic.ModelClaudeOpus5_5,
  		MaxTokens: 1024,
  		Messages:  messages,
  		Tools:     tools,
  	})
  	if err != nil {
  		log.Fatal(err)
  	}
  	messages = append(messages, response.ToParam())
  	if response.StopReason == anthropic.StopReasonEndTurn {
  		break
  	}
  	for _, block := range response.Content {
  		if toolUse, ok := block.AsAny().(anthropic.ToolUseBlock); ok {
  			result := executeTool(toolUse.Name, toolUse.Input)
  			messages = append(messages, anthropic.NewUserMessage(
  				anthropic.NewToolResultBlock(toolUse.ID, result, false),
  			))
  		}
  	}
  }
  ```

  ```java Java
  var messages = new ArrayList<MessageParam>();
  messages.add(MessageParam.ofUser(task));
  while (true) {
      var response = client.messages().create(MessageCreateParams.builder()
          .model(Model.CLAUDE_OPUS_5_5)
          .maxTokens(1024)
          .messages(messages)
          .tools(tools)
          .build());
      messages.add(response.toParam());
      if (StopReason.END_TURN.equals(response.stopReason().orElse(null))) {
          break;
      }
      for (var block : response.content()) {
          block.toolUse().ifPresent(toolUse -> {
              var result = executeTool(toolUse.name(), toolUse._input());
              messages.add(MessageParam.ofUserOfContentBlockParams(List.of(
                  ContentBlockParam.ofToolResult(ToolResultBlockParam.builder()
                      .toolUseId(toolUse.id())
                      .content(result)
                      .build()))));
          });
      }
  }
  ```

  ```php PHP
  $messages = [['role' => 'user', 'content' => $task]];
  while (true) {
      $response = $client->messages->create(
          model: 'claude-opus-5-5',
          maxTokens: 1024,
          messages: $messages,
          tools: $tools,
      );
      $messages[] = ['role' => 'assistant', 'content' => $response->content];
      if ($response->stopReason === 'end_turn') {
          break;
      }
      foreach ($response->content as $block) {
          if ($block->type === 'tool_use') {
              $result = executeTool($block->name, $block->input);
              $messages[] = [
                  'role' => 'user',
                  'content' => [
                      [
                          'type' => 'tool_result',
                          'tool_use_id' => $block->id,
                          'content' => $result,
                      ],
                  ],
              ];
          }
      }
  }
  ```

  ```ruby Ruby
  messages = [{ role: "user", content: task }]
  loop do
    response = client.messages.create(
      model: "claude-opus-5-5",
      max_tokens: 1024,
      messages: messages,
      tools: tools
    )
    messages << { role: "assistant", content: response.content }
    break if response.stop_reason == :end_turn
    response.content.each do |block|
      next unless block.type == :tool_use
      result = execute_tool(block.name, block.input)
      messages << {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: block.id,
            content: result
          }
        ]
      }
    end
  end
  ```
</CodeGroup>

**After** (Claude Managed Agents):

<CodeGroup exclude="shell:cURL, shell:CLI">
  <CodeGroupItem language="cURL">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    This workflow needs more logic than a single shell command. Use the [Claude SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) to run it.
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Task Runner",
      model="claude-opus-5-5",
      tools=[{"type": "agent_toolset_20260401"}],
  )

  session = client.beta.sessions.create(
      agent={"type": "agent", "id": agent.id, "version": agent.version},
      environment_id=environment.id,
  )

  with client.beta.sessions.events.stream(session.id) as stream:
      client.beta.sessions.events.send(
          session.id,
          events=[{"type": "user.message", "content": [{"type": "text", "text": task}]}],
      )
      for event in stream:
          if event.type == "session.status_idle":
              break
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Task Runner",
    model: "claude-opus-5-5",
    tools: [{ type: "agent_toolset_20260401" }]
  });

  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agent.id, version: agent.version },
    environment_id: environment.id
  });

  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: task }]
      }
    ]
  });

  for await (const event of stream) {
    if (event.type === "session.status_idle") {
      break;
    }
  }
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Task Runner",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
  });

  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = new BetaManagedAgentsAgentParams
      {
          ID = agent.ID,
          Version = agent.Version,
      },
      EnvironmentID = environment.ID,
  });

  var stream = client.Beta.Sessions.Events.StreamStreaming(session.ID);

  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content = [new BetaManagedAgentsTextBlock { Text = task }],
          },
      ],
  });

  await foreach (var streamEvent in stream)
  {
      if (streamEvent.Value is BetaManagedAgentsSessionStatusIdleEvent)
      {
          break;
      }
  }
  ```

  ```go Go
  	agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  		Name: "Task Runner",
  		Model: anthropic.BetaManagedAgentsModelConfigParams{
  			ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  		},
  		Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  			OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  		}},
  	})
  	if err != nil {
  		log.Fatal(err)
  	}

  	session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  		Agent: anthropic.BetaSessionNewParamsAgentUnion{
  			OfBetaManagedAgentsAgents: &anthropic.BetaManagedAgentsAgentParams{
  				ID:      agent.ID,
  				Version: anthropic.Int(agent.Version),
  			},
  		},
  		EnvironmentID: environment.ID,
  	})
  	if err != nil {
  		log.Fatal(err)
  	}

  	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  	defer stream.Close()

  	_, err = client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  						Text: task,
  					},
  				}},
  			},
  		}},
  	})
  	if err != nil {
  		log.Fatal(err)
  	}

  	for stream.Next() {
  		event := stream.Current()
  		if event.Type == "session.status_idle" {
  			break
  		}
  	}
  	if err := stream.Err(); err != nil {
  		log.Fatal(err)
  	}
  ```

  ```java Java
      var agent = client.beta().agents().create(
          AgentCreateParams.builder()
              .name("Task Runner")
              .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
              .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
              .build()
      );

      var session = client.beta().sessions().create(
          SessionCreateParams.builder()
              .agent(
                  BetaManagedAgentsAgentParams.builder()
                      .id(agent.id())
                      .version(agent.version())
                      .build()
              )
              .environmentId(environment.id())
              .build()
      );

      try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
          client.beta().sessions().events().send(
              session.id(),
              EventSendParams.builder()
                  .addEvent(
                      BetaManagedAgentsUserMessageEventParams.builder()
                          .addTextContent(task)
                          .build()
                  )
                  .build()
          );
          stream.stream()
              .takeWhile(event -> !event.isSessionStatusIdle())
              .forEach(_ -> {});
      }
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Task Runner',
      model: 'claude-opus-5-5',
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(),
      ],
  );

  $session = $client->beta->sessions->create(
      agent: BetaManagedAgentsAgentParams::with(
          id: $agent->id,
          version: $agent->version,
      ),
      environmentID: $environment->id,
  );

  $stream = $client->beta->sessions->events->streamStream($session->id);

  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => $task]],
          ],
      ],
  );

  foreach ($stream as $event) {
      if ($event->type === 'session.status_idle') {
          break;
      }
  }
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Task Runner",
    model: "claude-opus-5-5",
    tools: [{type: "agent_toolset_20260401"}]
  )

  session = client.beta.sessions.create(
    agent: {type: "agent", id: agent.id, version: agent.version},
    environment_id: environment.id
  )

  stream = client.beta.sessions.events.stream_events(session.id)
  client.beta.sessions.events.send_(
    session.id,
    events: [{type: "user.message", content: [{type: "text", text: task}]}]
  )
  stream.each do
    break if it.type == :"session.status_idle"
  end
  ```
</CodeGroup>

### What you still control

* **System prompt and model:** Same fields, now on the agent definition.
* **Custom tools:** Still declared with JSON Schema. Execution moves from inline handling to responding to `agent.custom_tool_use` events. See [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).
* **Web search and web fetch settings:** Same `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`), `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`), `max_content_tokens` (java, php: `maxContentTokens`; csharp, go: `MaxContentTokens`), and `user_location` (java, php: `userLocation`; csharp, go: `UserLocation`) fields, now set once on the `web_search` and `web_fetch` entries of the agent toolset’s `configs` (csharp, go: `Configs`) array instead of on every request. The `max_uses` (java, php: `maxUses`; csharp, go: `MaxUses`), `citations` (csharp, go: `Citations`), and `cache_control` (java, php: `cacheControl`; csharp, go: `CacheControl`) fields are not available. See [Differences from the Messages API tools](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#differences-from-the-messages-api-tools).
* **Context:** You can still inject context through the system prompt, [file resources](https://platform.claude.com/docs/en/managed-agents/files), or [skills](https://platform.claude.com/docs/en/managed-agents/skills).

## From the Claude Agent SDK

If you built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), you’re already working with agents, tools, and sessions as concepts. The difference is where they run: the SDK runs in a process you operate, whereas Managed Agents runs in Anthropic’s infrastructure. Most of the migration is mapping SDK configuration objects to their API-side equivalents.

### What changes

| Agent SDK                                                                                   | Managed Agents                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClaudeAgentOptions(...)` (typescript: `options`) constructed per run                       | `client.beta.agents.create(...)` (csharp: `client.Beta.Agents.Create(...)`; go: `client.Beta.Agents.New(...)`; java: `client.beta().agents().create(...)`; php: `$client->beta->agents->create(...)`) once; the Agent is persisted and versioned server-side. See [Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup). |
| `async with ClaudeSDKClient(...)` or `query(...)`                                           | `client.beta.sessions.create(...)` (csharp: `client.Beta.Sessions.Create(...)`; go: `client.Beta.Sessions.New(...)`; java: `client.beta().sessions().create(...)`; php: `$client->beta->sessions->create(...)`) then send and receive [events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).                         |
| Functions defined with `@tool` (typescript: `tool()`), dispatched automatically by the SDK  | Declare as `{"type": "custom", ...}` on the Agent; your client handles `agent.custom_tool_use` events and replies with `user.custom_tool_result`. See [Tools](https://platform.claude.com/docs/en/managed-agents/tools).                                                                                                                         |
| Built-in tools run in your process against your filesystem                                  | `{"type": "agent_toolset_20260401"}` runs the same tools inside the session sandbox against `/workspace`.                                                                                                                                                                                                                                        |
| `cwd`, `add_dirs` (typescript: `additionalDirectories`) point at local paths                | Upload or mount [files](https://platform.claude.com/docs/en/managed-agents/files) as session resources.                                                                                                                                                                                                                                          |
| `system_prompt` (typescript: `systemPrompt`) and the `CLAUDE.md` hierarchy                  | A single `system` (csharp, go: `System`; ruby: `system_`) string on the Agent. Each update that changes the agent produces a new server-side version; pin sessions to a specific version to promote or roll back without a deploy. See [Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).                            |
| `mcp_servers` (typescript: `mcpServers`) configured and authenticated in one place          | Declare servers on the Agent; provide credentials through a [Vault](https://platform.claude.com/docs/en/managed-agents/vaults) on the Session.                                                                                                                                                                                                   |
| `permission_mode` (typescript: `permissionMode`), `can_use_tool` (typescript: `canUseTool`) | Per-tool [`permission_policy` (java, php: `permissionPolicy`; csharp, go: `PermissionPolicy`)](https://platform.claude.com/docs/en/managed-agents/permission-policies) (`always_allow`, `always_ask`, or `auto`); send `user.tool_confirmation` events for calls that pause for your approval.                                                   |

### Code comparison

**Before** (Agent SDK):

<CodeGroup exclude="shell, csharp, go, java, php, ruby">
  ```python Python
  from claude_agent_sdk import (
      ClaudeAgentOptions,
      ClaudeSDKClient,
      create_sdk_mcp_server,
      tool,
  )


  @tool("get_weather", "Get the current weather for a city.", {"city": str})
  async def get_weather(args: dict) -> dict:
      return {"content": [{"type": "text", "text": f"{args['city']}: 18°C, clear"}]}


  options = ClaudeAgentOptions(
      model="claude-opus-5-5",
      system_prompt="You are a concise weather assistant.",
      mcp_servers={
          "weather": create_sdk_mcp_server("weather", "1.0", tools=[get_weather])
      },
  )

  async with ClaudeSDKClient(options=options) as agent:
      await agent.query("What's the weather in Tokyo?")
      async for msg in agent.receive_response():
          print(msg)
  ```

  ```typescript TypeScript
  import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
  import { z } from "zod";

  const getWeather = tool(
    "get_weather",
    "Get the current weather for a city.",
    { city: z.string() },
    async (args) => ({
      content: [{ type: "text", text: `${args.city}: 18°C, clear` }]
    })
  );

  for await (const message of query({
    prompt: "What's the weather in Tokyo?",
    options: {
      model: "claude-opus-5-5",
      systemPrompt: "You are a concise weather assistant.",
      mcpServers: {
        weather: createSdkMcpServer({ name: "weather", version: "1.0", tools: [getWeather] })
      }
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

**After** (Managed Agents):

<CodeGroup exclude="shell">
  ```python Python
  from anthropic import Anthropic

  client = Anthropic()

  agent = client.beta.agents.create(
      name="weather-agent",
      model="claude-opus-5-5",
      system="You are a concise weather assistant.",
      tools=[
          {
              "type": "custom",
              "name": "get_weather",
              "description": "Get the current weather for a city.",
              "input_schema": {
                  "type": "object",
                  "properties": {"city": {"type": "string"}},
                  "required": ["city"],
              },
          }
      ],
  )
  environment = client.beta.environments.create(
      name="weather-env",
      config={
          "type": "cloud",
          "networking": {"type": "limited", "allow_package_managers": True},
      },
  )

  session = client.beta.sessions.create(
      agent={"type": "agent", "id": agent.id, "version": agent.version},
      environment_id=environment.id,
  )


  def get_weather(city: str) -> str:
      return f"{city}: 18°C, clear"


  with client.beta.sessions.events.stream(session.id) as stream:
      client.beta.sessions.events.send(
          session.id,
          events=[
              {
                  "type": "user.message",
                  "content": [{"type": "text", "text": "What's the weather in Tokyo?"}],
              }
          ],
      )
      for event in stream:
          match event.type:
              case "agent.message":
                  print(
                      "".join(
                          block.text for block in event.content if block.type == "text"
                      )
                  )
              case "agent.custom_tool_use":
                  result = get_weather(**event.input)
                  client.beta.sessions.events.send(
                      session.id,
                      events=[
                          {
                              "type": "user.custom_tool_result",
                              "custom_tool_use_id": event.id,
                              "content": [{"type": "text", "text": result}],
                          }
                      ],
                  )
              case "session.status_idle":
                  if event.stop_reason and event.stop_reason.type == "end_turn":
                      break
  ```

  ```typescript TypeScript
  import Anthropic from "@anthropic-ai/sdk";

  const client = new Anthropic();

  const agent = await client.beta.agents.create({
    name: "weather-agent",
    model: "claude-opus-5-5",
    system: "You are a concise weather assistant.",
    tools: [
      {
        type: "custom",
        name: "get_weather",
        description: "Get the current weather for a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }
    ]
  });
  const environment = await client.beta.environments.create({
    name: "weather-env",
    config: {
      type: "cloud",
      networking: { type: "limited", allow_package_managers: true }
    }
  });

  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agent.id, version: agent.version },
    environment_id: environment.id
  });

  function getWeather({ city }: Record<string, unknown>): string {
    return `${city}: 18°C, clear`;
  }

  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "What's the weather in Tokyo?" }]
      }
    ]
  });

  loop: for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
        break;
      case "agent.custom_tool_use": {
        const result = getWeather(event.input);
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
        if (event.stop_reason?.type === "end_turn") {
          break loop;
        }
        break;
    }
  }
  ```

  ```csharp C#
  using System.Text.Json;

  using Anthropic.Models.Beta.Agents;
  using Anthropic.Models.Beta.Environments;
  using Anthropic.Models.Beta.Sessions;
  using Anthropic.Models.Beta.Sessions.Events;

  AnthropicClient client = new();

  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "weather-agent",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      System = "You are a concise weather assistant.",
      Tools =
      [
          new BetaManagedAgentsCustomToolParams
          {
              Name = "get_weather",
              Description = "Get the current weather for a city.",
              InputSchema = new()
              {
                  Properties = new Dictionary<string, JsonElement>
                  {
                      ["city"] = JsonSerializer.SerializeToElement(new { type = "string" }),
                  },
                  Required = ["city"],
              },
          },
      ],
  });
  var environment = await client.Beta.Environments.Create(new()
  {
      Name = "weather-env",
      Config = new BetaCloudConfigParams
      {
          Networking = new BetaLimitedNetworkParams { AllowPackageManagers = true },
      },
  });

  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = new BetaManagedAgentsAgentParams
      {
          ID = agent.ID,
          Version = agent.Version,
      },
      EnvironmentID = environment.ID,
  });

  static string GetWeather(string city) => $"{city}: 18°C, clear";

  using var stream = await client.Beta.Sessions.Events.WithRawResponse.StreamStreaming(session.ID);

  await client.Beta.Sessions.Events.Send(session.ID, new()
  {
      Events =
      [
          new BetaManagedAgentsUserMessageEventParams
          {
              Content = [new BetaManagedAgentsTextBlock { Text = "What's the weather in Tokyo?" }],
          },
      ],
  });

  await foreach (var streamEvent in stream.Enumerate())
  {
      if (streamEvent.Value is BetaManagedAgentsAgentMessageEvent message)
      {
          var text = string.Concat(message.Content.Select(block =>
              block.Value is BetaManagedAgentsTextBlock textBlock ? textBlock.Text : ""));
          Console.WriteLine(text);
      }
      else if (streamEvent.Value is BetaManagedAgentsAgentCustomToolUseEvent toolUse)
      {
          var result = GetWeather(toolUse.Input["city"].GetString()!);
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
  client := anthropic.NewClient()
  ctx := context.Background()

  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "weather-agent",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	System: anthropic.String("You are a concise weather assistant."),
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfCustom: &anthropic.BetaManagedAgentsCustomToolParams{
  			Name:        "get_weather",
  			Description: "Get the current weather for a city.",
  			InputSchema: anthropic.BetaManagedAgentsCustomToolInputSchemaParam{
  				Properties: map[string]any{
  					"city": map[string]any{"type": "string"},
  				},
  				Required: []string{"city"},
  			},
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }
  environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
  	Name: "weather-env",
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

  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent: anthropic.BetaSessionNewParamsAgentUnion{
  		OfBetaManagedAgentsAgents: &anthropic.BetaManagedAgentsAgentParams{
  			ID:      agent.ID,
  			Version: anthropic.Int(agent.Version),
  		},
  	},
  	EnvironmentID: environment.ID,
  })
  if err != nil {
  	panic(err)
  }

  getWeather := func(city string) string {
  	return fmt.Sprintf("%s: 18°C, clear", city)
  }

  stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
  defer stream.Close()

  _, err = client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  		OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  			Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
  				OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  					Text: "What's the weather in Tokyo?",
  				},
  			}},
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }

  loop:
  for stream.Next() {
  	event := stream.Current()
  	switch event.Type {
  	case "agent.message":
  		for _, block := range event.AsAgentMessage().Content {
  			if block.Type == "text" {
  				fmt.Println(block.Text)
  			}
  		}
  	case "agent.custom_tool_use":
  		toolUse := event.AsAgentCustomToolUse()
  		result := getWeather(toolUse.Input["city"].(string))
  		if _, err := client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  			Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
  				OfUserCustomToolResult: &anthropic.BetaManagedAgentsUserCustomToolResultEventParams{
  					CustomToolUseID: toolUse.ID,
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
  	case "session.status_idle":
  		idle := event.AsSessionStatusIdle()
  		if _, ok := idle.StopReason.AsAny().(anthropic.BetaManagedAgentsSessionEndTurn); ok {
  			break loop
  		}
  	}
  }
  if err := stream.Err(); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  import java.util.Map;
  import java.util.function.Function;

  import com.anthropic.models.beta.agents.AgentCreateParams;
  import com.anthropic.models.beta.agents.BetaManagedAgentsCustomToolInputSchema;
  import com.anthropic.models.beta.agents.BetaManagedAgentsCustomToolParams;
  import com.anthropic.models.beta.agents.BetaManagedAgentsModel;
  import com.anthropic.models.beta.environments.BetaCloudConfigParams;
  import com.anthropic.models.beta.environments.BetaLimitedNetworkParams;
  import com.anthropic.models.beta.environments.EnvironmentCreateParams;
  import com.anthropic.models.beta.sessions.BetaManagedAgentsAgentParams;
  import com.anthropic.models.beta.sessions.SessionCreateParams;
  import com.anthropic.models.beta.sessions.events.BetaManagedAgentsStreamSessionEvents;
  import com.anthropic.models.beta.sessions.events.BetaManagedAgentsUserCustomToolResultEventParams;
  import com.anthropic.models.beta.sessions.events.BetaManagedAgentsUserMessageEventParams;
  import com.anthropic.models.beta.sessions.events.EventSendParams;

  var client = AnthropicOkHttpClient.fromEnv();

  var agent = client.beta().agents().create(AgentCreateParams.builder()
      .name("weather-agent")
      .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
      .system("You are a concise weather assistant.")
      .addTool(BetaManagedAgentsCustomToolParams.builder()
          .name("get_weather")
          .description("Get the current weather for a city.")
          .inputSchema(BetaManagedAgentsCustomToolInputSchema.builder()
              .properties(BetaManagedAgentsCustomToolInputSchema.Properties.builder()
                  .putAdditionalProperty("city", JsonValue.from(Map.of("type", "string")))
                  .build())
              .addRequired("city")
              .build())
          .build())
      .build());
  var environment = client.beta().environments().create(EnvironmentCreateParams.builder()
      .name("weather-env")
      .config(BetaCloudConfigParams.builder()
          .networking(BetaLimitedNetworkParams.builder()
              .allowPackageManagers(true)
              .build())
          .build())
      .build());

  var session = client.beta().sessions().create(SessionCreateParams.builder()
      .agent(BetaManagedAgentsAgentParams.builder()
          .id(agent.id())
          .version(agent.version())
          .build())
      .environmentId(environment.id())
      .build());

  Function<String, String> getWeather = city -> city + ": 18°C, clear";

  try (var stream = client.beta().sessions().events().streamStreaming(session.id())) {
      client.beta().sessions().events().send(
          session.id(),
          EventSendParams.builder()
              .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
                  .addTextContent("What's the weather in Tokyo?")
                  .build())
              .build());

      loop:
      for (var event : (Iterable<BetaManagedAgentsStreamSessionEvents>) stream.stream()::iterator) {
          switch (event.type().value()) {
              case AGENT_MESSAGE -> {
                  for (var block : event.asAgentMessage().content()) {
                      block.text().ifPresent(textBlock -> IO.println(textBlock.text()));
                  }
              }
              case AGENT_CUSTOM_TOOL_USE -> {
                  var toolUse = event.asAgentCustomToolUse();
                  var city = toolUse.input()._additionalProperties().get("city").asStringOrThrow();
                  var result = getWeather.apply(city);
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
  use Anthropic\Client;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolInputSchema;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolParams;
  use Anthropic\Beta\Sessions\BetaManagedAgentsAgentParams;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentCustomToolUseEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsAgentMessageEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionEndTurn;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsSessionStatusIdleEvent;
  use Anthropic\Beta\Sessions\Events\ManagedAgentsTextBlock;

  $client = new Client();

  $agent = $client->beta->agents->create(
      name: 'weather-agent',
      model: 'claude-opus-5-5',
      system: 'You are a concise weather assistant.',
      tools: [
          BetaManagedAgentsCustomToolParams::with(
              name: 'get_weather',
              description: 'Get the current weather for a city.',
              inputSchema: BetaManagedAgentsCustomToolInputSchema::with(
                  properties: ['city' => ['type' => 'string']],
                  required: ['city'],
              ),
          ),
      ],
  );
  $environment = $client->beta->environments->create(
      name: 'weather-env',
      config: [
          'type' => 'cloud',
          'networking' => ['type' => 'limited', 'allow_package_managers' => true],
      ],
  );

  $session = $client->beta->sessions->create(
      agent: BetaManagedAgentsAgentParams::with(
          id: $agent->id,
          version: $agent->version,
      ),
      environmentID: $environment->id,
  );

  function getWeather(string $city): string
  {
      return "{$city}: 18°C, clear";
  }

  $stream = $client->beta->sessions->events->streamStream($session->id);

  $client->beta->sessions->events->send(
      $session->id,
      events: [
          [
              'type' => 'user.message',
              'content' => [['type' => 'text', 'text' => "What's the weather in Tokyo?"]],
          ],
      ],
  );

  foreach ($stream as $event) {
      switch (true) {
          case $event instanceof ManagedAgentsAgentMessageEvent:
              foreach ($event->content as $block) {
                  if ($block instanceof ManagedAgentsTextBlock) {
                      echo $block->text . "\n";
                  }
              }
              break;
          case $event instanceof ManagedAgentsAgentCustomToolUseEvent:
              $result = getWeather($event->input['city']);
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
          case $event instanceof ManagedAgentsSessionStatusIdleEvent:
              if ($event->stopReason instanceof ManagedAgentsSessionEndTurn) {
                  break 2;
              }
              break;
      }
  }
  $stream->close();
  ```

  ```ruby Ruby
  require "anthropic"

  client = Anthropic::Client.new

  agent = client.beta.agents.create(
    name: "weather-agent",
    model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
    system_: "You are a concise weather assistant.",
    tools: [
      {
        type: "custom",
        name: "get_weather",
        description: "Get the current weather for a city.",
        input_schema: {
          type: "object",
          properties: {city: {type: "string"}},
          required: ["city"]
        }
      }
    ]
  )
  environment = client.beta.environments.create(
    name: "weather-env",
    config: {type: "cloud", networking: {type: "limited", allow_package_managers: true}}
  )

  session = client.beta.sessions.create(
    agent: {type: "agent", id: agent.id, version: agent.version},
    environment_id: environment.id
  )

  def get_weather(city)
    "#{city}: 18°C, clear"
  end

  stream = client.beta.sessions.events.stream_events(session.id)
  client.beta.sessions.events.send_(
    session.id,
    events: [{type: "user.message", content: [{type: "text", text: "What's the weather in Tokyo?"}]}]
  )

  stream.each do |event|
    case event
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentMessageEvent
      event.content.each do |block|
        puts block.text if block.is_a?(Anthropic::Beta::Sessions::BetaManagedAgentsTextBlock)
      end
    when Anthropic::Beta::Sessions::BetaManagedAgentsAgentCustomToolUseEvent
      result = get_weather(event.input[:city])
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

The Agent and Environment are created once and reused across sessions. The tool function still runs in your process; the difference is that you read the `agent.custom_tool_use` event and send the result explicitly instead of the SDK dispatching it for you.

### Features that move to your client

The tradeoff for Anthropic running the agent loop is that a few things the SDK handled automatically become your client’s responsibility.

| SDK feature                          | Managed Agents approach                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan mode                            | Run a planning-only session first, then a second session to run the plan.                                                                                                                                                                                                                                                                                                                                                                     |
| Output styles, slash commands        | Apply in your client before sending `user.message` or after receiving `agent.message`.                                                                                                                                                                                                                                                                                                                                                        |
| `PreToolUse` / `PostToolUse` hooks   | Your client already sees every `agent.custom_tool_use` event before responding; put the logic there. For built-in tools, use `permission_policy: always_ask` to review every call. [`auto`](https://platform.claude.com/docs/en/managed-agents/permission-policies#let-the-server-evaluate-each-call-with-auto) lets the server evaluate each call instead, but if the server evaluates a call as safe, it runs without reaching your client. |
| `max_turns` (typescript: `maxTurns`) | Count turns client-side.                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Migration checklist

1. [Create an environment](https://platform.claude.com/docs/en/managed-agents/environments) with the networking and runtimes your agent needs.
2. Port your system prompt and tool selection to an [agent definition](https://platform.claude.com/docs/en/managed-agents/agent-setup).
3. Replace your loop: [create a session](https://platform.claude.com/docs/en/managed-agents/sessions) with `client.beta.sessions.create()` (go: `client.Beta.Sessions.New()`; csharp: `client.Beta.Sessions.Create()`; java: `client.beta().sessions().create()`; php: `$client->beta->sessions->create()`; cli: `ant beta:sessions create`; curl: `POST /v1/sessions`) and [stream its events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) with `client.beta.sessions.events.stream()` (ruby: `client.beta.sessions.events.stream_events()`; go: `client.Beta.Sessions.Events.StreamEvents()`; csharp: `client.Beta.Sessions.Events.StreamStreaming()`; java: `client.beta().sessions().events().streamStreaming()`; php: `$client->beta->sessions->events->streamStream()`; cli: `ant beta:sessions:events stream`; curl: `GET /v1/sessions/{session_id}/events/stream`).
4. For any local files the agent reads, upload them through the [Files API](https://platform.claude.com/docs/en/managed-agents/files) and mount them as `resources` (csharp, go: `Resources`).
5. For any custom tool handlers, move execution into your event loop as responses to `agent.custom_tool_use` events.
6. Verify with a test session before pointing production traffic at the new flow.

## Migrating between model versions

When a new Claude model is released, migrating a Claude Managed Agents integration is typically a one-field change: update `model` (csharp, go: `Model`) on your [agent definition](https://platform.claude.com/docs/en/managed-agents/agent-setup), and the change takes effect on the next session you create.

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -sS --fail-with-body "https://api.anthropic.com/v1/agents/$AGENT_ID?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "version": '"$AGENT_VERSION"',
      "model": "claude-opus-5-5"
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply agent.md
    ```

    <File filename="agent.md">
      ```markdown
      ---
      name: Task Runner
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
      ---

      You are a task automation agent. Complete the task you are given end to end.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  client.beta.agents.update(
      agent.id,
      version=agent.version,
      model="claude-opus-5-5",
  )
  ```

  ```typescript TypeScript
  await client.beta.agents.update(agent.id, {
    version: agent.version,
    model: "claude-opus-5-5"
  });
  ```

  ```csharp C#
  await client.Beta.Agents.Update(agent.ID, new()
  {
      Version = agent.Version,
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
  });
  ```

  ```go Go
  _, err = client.Beta.Agents.Update(ctx, agent.ID, anthropic.BetaAgentUpdateParams{
  	Version: agent.Version,
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().agents().update(
      agent.id(),
      AgentUpdateParams.builder()
          .version(agent.version())
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .build()
  );
  ```

  ```php PHP
  $client->beta->agents->update(
      $agent->id,
      version: $agent->version,
      model: 'claude-opus-5-5',
  );
  ```

  ```ruby Ruby
  client.beta.agents.update(
    agent.id,
    version: agent.version,
    model: "claude-opus-5-5"
  )
  ```
</CodeGroup>

Most model-level behavior changes documented in the [Messages API migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide) do not require action on your side:

* **Request parameter changes** (`max_tokens` (java, php: `maxTokens`; csharp, go: `MaxTokens`) defaults, `thinking` (csharp, go: `Thinking`) configuration) are handled by the Claude Managed Agents runtime. These fields are not exposed on the agent definition.
* **Assistant message prefilling** does not exist in the event-based session model, so its removal on newer models is a no-op.
* **Tool argument JSON escaping** is parsed by the runtime before you receive `agent.custom_tool_use` events. You see structured data, not raw strings.

The behavior descriptions in the Messages API guide (what the model does differently) still apply. The migration steps (how to change your request code) do not.
