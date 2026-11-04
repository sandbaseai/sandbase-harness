---
title: Tools
url: https://platform.claude.com/docs/en/managed-agents/tools
description: Configure tools available to your agent.
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

Claude Managed Agents provides a set of built-in tools that Claude can use autonomously within a [session](https://platform.claude.com/docs/en/managed-agents/sessions). You control which tools are available by specifying them in the agent configuration.

Claude Managed Agents also supports custom, user-defined tools. Your application runs these tools separately and returns the results to Claude, which uses them to continue the task. To give the agent tools from an MCP server, use the [MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector) instead.

## Available tools

The agent toolset includes the following tools. All are enabled by default when you include the toolset in the agent configuration.

| Tool       | Name         | Description                                            |
| ---------- | ------------ | ------------------------------------------------------ |
| Bash       | `bash`       | Run bash commands in a shell session                   |
| Read       | `read`       | Read a file from the sandbox filesystem                |
| Write      | `write`      | Write a file to the sandbox filesystem                 |
| Edit       | `edit`       | Perform string replacement in a file                   |
| Glob       | `glob`       | Perform fast file pattern matching using glob patterns |
| Grep       | `grep`       | Search text using regex patterns                       |
| Web fetch  | `web_fetch`  | Fetch content from a URL                               |
| Web search | `web_search` | Search the web for information                         |

When a tool output exceeds 100,000 characters (about 25,000 tokens), it is automatically written to a file in the [sandbox](https://platform.claude.com/docs/en/managed-agents/environments). The model receives a truncated preview with the file path and can read the full content from there.

## Configuring the toolset

Enable the full toolset with `agent_toolset_20260401` when creating an agent. Use the `configs` (csharp, go: `Configs`) array to disable specific tools or override their settings. Each entry is identified by its `name` (csharp, go: `Name`), which takes a value from the Name column in [Available tools](https://platform.claude.com/docs/en/managed-agents/tools#available-tools). An entry also accepts an optional `type` (csharp, go: `Type`) field with the same value.

Each config entry can also set a `permission_policy` (java, php: `permissionPolicy`; csharp, go: `PermissionPolicy`). The policy controls whether the tool’s calls run without confirmation, require confirmation, or are evaluated individually by the server. See [Permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies) for the available policy types.

The following example enables the toolset and disables `web_fetch`:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Coding Assistant",
      "model": "claude-opus-5-5",
      "tools": [
        {
          "type": "agent_toolset_20260401",
          "configs": [
            {"name": "web_fetch", "enabled": false}
          ]
        }
      ]
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply agent.md
    ```

    <File filename="agent.md">
      ```markdown
      ---
      name: Coding Assistant
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
          configs:
            - name: web_fetch
              enabled: false
      ---
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Coding Assistant",
      model="claude-opus-5-5",
      tools=[
          {
              "type": "agent_toolset_20260401",
              "configs": [
                  {"name": "web_fetch", "enabled": False},
              ],
          },
      ],
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Coding Assistant",
    model: "claude-opus-5-5",
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [{ name: "web_fetch", enabled: false }]
      }
    ]
  });
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Agents;

  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Coding Assistant",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      Tools =
      [
          new BetaManagedAgentsAgentToolset20260401Params
          {
              Configs =
              [
                  new BetaManagedAgentsWebFetchToolConfigParams { Enabled = false },
              ],
          },
      ],
  });
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "Coding Assistant",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{
  			Configs: []anthropic.BetaManagedAgentsAgentToolConfigParamsUnion{{
  				OfWebFetch: &anthropic.BetaManagedAgentsWebFetchToolConfigParams{
  					Enabled: anthropic.Bool(false),
  				},
  			}},
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  import com.anthropic.models.beta.agents.*;

  var agent = client.beta().agents().create(AgentCreateParams.builder()
      .name("Coding Assistant")
      .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
      .addTool(BetaManagedAgentsAgentToolset20260401Params.builder()
          .addConfig(BetaManagedAgentsWebFetchToolConfigParams.builder()
              .enabled(false)
              .build())
          .build())
      .build());
  ```

  ```php PHP
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolset20260401Params;
  use Anthropic\Beta\Agents\BetaManagedAgentsWebFetchToolConfigParams;

  $agent = $client->beta->agents->create(
      name: 'Coding Assistant',
      model: 'claude-opus-5-5',
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(
              configs: [
                  BetaManagedAgentsWebFetchToolConfigParams::with(enabled: false),
              ],
          ),
      ],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Coding Assistant",
    model: "claude-opus-5-5",
    tools: [
      {
        type: :agent_toolset_20260401,
        configs: [
          {name: :web_fetch, enabled: false}
        ]
      }
    ]
  )
  ```
</CodeGroup>

### Disabling specific tools

To disable a tool, set `enabled: false` in its `configs` entry:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    { "name": "web_fetch", "enabled": false },
    { "name": "web_search", "enabled": false }
  ]
}
```

### Enabling only specific tools

The `default_config` object sets the baseline for every tool in the set, and per-tool `configs` entries override it. To start with everything off and enable only what you need, set `default_config.enabled` to `false`:

```json
{
  "type": "agent_toolset_20260401",
  "default_config": { "enabled": false },
  "configs": [
    { "name": "bash", "enabled": true },
    { "name": "read", "enabled": true },
    { "name": "write", "enabled": true }
  ]
}
```

### Restricting web search and web fetch

The `web_search` and `web_fetch` entries also accept domain lists, a cap on fetched content, and a search location. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).

### Config entry types in the SDKs

The SDK types each `configs` (csharp, go: `Configs`) entry by tool. The type is a union with one member for each built-in tool, discriminated by `type` (csharp, go: `Type`).

In Go, Java, C#, and PHP, you construct entries from typed values rather than plain dictionaries or hashes. In those SDKs, the element type of `configs` (csharp, go: `Configs`) is the union itself, so build each entry from its per-tool member type.

You can omit `type` (csharp, go: `Type`) when you construct an entry, because the server infers it from `name` (csharp, go: `Name`). Responses always include it. This typing does not change the JSON that an entry serializes to. A request whose entries set only `name`, `enabled`, and `permission_policy` is valid with or without `type`.

## Custom tools

Custom tools are analogous to [user-defined client tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works#user-defined-tools-client-executed) in the Messages API. You specify what operations are available and what they return, and Claude determines when and how to call them.

Claude does not run a custom tool itself. It emits a structured request, your code runs the operation, and you return the result to the session.

The following example creates an agent with the built-in toolset and one custom tool, `get_weather`:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Weather Agent",
      "model": "claude-opus-5-5",
      "tools": [
        {
          "type": "agent_toolset_20260401"
        },
        {
          "type": "custom",
          "name": "get_weather",
          "description": "Get current weather for a location",
          "input_schema": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City name"}
            },
            "required": ["location"]
          }
        }
      ]
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply agent.md
    ```

    <File filename="agent.md">
      ```markdown
      ---
      name: Weather Agent
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
        - type: custom
          name: get_weather
          description: Get current weather for a location
          input_schema:
            type: object
            properties:
              location:
                type: string
                description: City name
            required:
              - location
      ---
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Weather Agent",
      model="claude-opus-5-5",
      tools=[
          {
              "type": "agent_toolset_20260401",
          },
          {
              "type": "custom",
              "name": "get_weather",
              "description": "Get current weather for a location",
              "input_schema": {
                  "type": "object",
                  "properties": {
                      "location": {"type": "string", "description": "City name"},
                  },
                  "required": ["location"],
              },
          },
      ],
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Weather Agent",
    model: "claude-opus-5-5",
    tools: [
      { type: "agent_toolset_20260401" },
      {
        type: "custom",
        name: "get_weather",
        description: "Get current weather for a location",
        input_schema: {
          type: "object",
          properties: { location: { type: "string", description: "City name" } },
          required: ["location"]
        }
      }
    ]
  });
  ```

  ```csharp C#
  using System.Text.Json;
  using Anthropic.Models.Beta.Agents;

  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Weather Agent",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      Tools =
      [
          new BetaManagedAgentsAgentToolset20260401Params(),
          new BetaManagedAgentsCustomToolParams
          {
              Name = "get_weather",
              Description = "Get current weather for a location",
              InputSchema = new()
              {
                  Properties = new Dictionary<string, JsonElement>
                  {
                      ["location"] = JsonSerializer.SerializeToElement(
                          new { type = "string", description = "City name" }
                      ),
                  },
                  Required = ["location"],
              },
          },
      ],
  });
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "Weather Agent",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  	}, {
  		OfCustom: &anthropic.BetaManagedAgentsCustomToolParams{
  			Name:        "get_weather",
  			Description: "Get current weather for a location",
  			InputSchema: anthropic.BetaManagedAgentsCustomToolInputSchemaParam{
  				Properties: map[string]any{
  					"location": map[string]any{
  						"type":        "string",
  						"description": "City name",
  					},
  				},
  				Required: []string{"location"},
  			},
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  import com.anthropic.models.beta.agents.*;
  import java.util.Map;

  var agent = client.beta().agents().create(AgentCreateParams.builder()
      .name("Weather Agent")
      .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
      .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
      .addTool(BetaManagedAgentsCustomToolParams.builder()
          .name("get_weather")
          .description("Get current weather for a location")
          .inputSchema(BetaManagedAgentsCustomToolInputSchema.builder()
              .properties(BetaManagedAgentsCustomToolInputSchema.Properties.builder()
                  .putAdditionalProperty("location", JsonValue.from(Map.of(
                      "type", "string",
                      "description", "City name")))
                  .build())
              .addRequired("location")
              .build())
          .build())
      .build());
  ```

  ```php PHP
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolset20260401Params;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolInputSchema;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolParams;

  $agent = $client->beta->agents->create(
      name: 'Weather Agent',
      model: 'claude-opus-5-5',
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(),
          BetaManagedAgentsCustomToolParams::with(
              name: 'get_weather',
              description: 'Get current weather for a location',
              inputSchema: BetaManagedAgentsCustomToolInputSchema::with(
                  properties: ['location' => ['type' => 'string', 'description' => 'City name']],
                  required: ['location'],
              ),
          ),
      ],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Weather Agent",
    model: "claude-opus-5-5",
    tools: [
      {type: :agent_toolset_20260401},
      {
        type: :custom,
        name: "get_weather",
        description: "Get current weather for a location",
        input_schema: {
          type: :object,
          properties: {location: {type: "string", description: "City name"}},
          required: ["location"]
        }
      }
    ]
  )
  ```
</CodeGroup>

A custom tool’s name can’t start with `mcp__` or `ant__`, or match the name of a built-in agent tool. A request that breaks this rule returns a 400 error. An agent that already has a custom tool whose name starts with `ant__` accepts an update only if the update sends `tools` (csharp, go: `Tools`) without that name, so rename or remove the tool in your next update. A new session is refused with a 400 error if such a tool is on its agent (after any [overrides](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session)), on an agent in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`), or on an agent in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`). Sessions that already exist aren’t affected.

The agent calls its custom tools during a session. To receive the calls and return results, see [Answer tool calls that pause the session](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#handling-custom-tool-calls).

For sessions that run in a self-hosted sandbox, the environment worker can [serve custom tools from the sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-custom-tools). These can include tools that wrap an MCP server inside your network.

### Best practices for custom tool definitions

* **Provide extremely detailed descriptions.** This is by far the most important factor in tool performance. The more context you can give Claude about your tools, the better it is at determining when and how to use them. Aim for three to four sentences for each tool description, more if the tool is complex. Your descriptions should cover:

  * What the tool does
  * When to use it, and when not to
  * What each parameter means and how it affects the tool’s behavior
  * Any important caveats or limitations

* **Consolidate related operations into fewer tools.** Group actions such as `create_pr`, `review_pr`, and `merge_pr` into a single tool with an `action` parameter. Fewer, more capable tools reduce selection ambiguity and make your tool surface easier for Claude to navigate.

* **Use meaningful namespacing in tool names.** When your tools span multiple services or resources, prefix names with the resource (for example, `db_query` or `storage_read`). This makes tool selection unambiguous as your library grows.

* **Design tool responses to return only high-signal information.** Return semantic, stable identifiers (for example, slugs or UUIDs) rather than opaque internal references. Include only the fields Claude needs to determine its next step. Bloated responses waste context and make it harder for Claude to extract what matters.

## Next steps

<CardGroup cols={2}>
  <Card title="Restrict web search and web fetch domains" icon="shield" href="https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions">
    Control which sites the web tools can reach, cap fetched content, and localize search results.
  </Card>

  <Card title="MCP connector" icon="link" href="https://platform.claude.com/docs/en/managed-agents/mcp-connector">
    Connect MCP servers to your agents for access to external tools and data sources.
  </Card>

  <Card title="Permission policies" icon="lock" href="https://platform.claude.com/docs/en/managed-agents/permission-policies">
    Control when agent and MCP tools run.
  </Card>

  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Send events, stream responses, and interrupt or redirect your session while it runs.
  </Card>
</CardGroup>

## Availability

Agent toolset is in beta on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

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
