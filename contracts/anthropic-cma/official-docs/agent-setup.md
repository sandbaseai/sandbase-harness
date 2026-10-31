---
title: Define your agent
url: https://platform.claude.com/docs/en/managed-agents/agent-setup
description: Create a reusable, versioned agent configuration.
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

An agent is a reusable, versioned configuration that defines persona and capabilities. It bundles the model, system prompt, tools, MCP servers, and skills that shape how Claude behaves during a session.

Create the agent once as a reusable resource and reference it by ID each time you [start a session](https://platform.claude.com/docs/en/managed-agents/sessions). Agents are versioned and easier to manage across many sessions.

## Agent configuration fields

| Field                                                                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (csharp, go: `Name`)                                                     | Required. A human-readable name for the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `model` (csharp, go: `Model`)                                                   | Required. The Claude [model](https://platform.claude.com/docs/en/models/overview) that powers the agent. Accepts a model ID string or an object, for example `{"id": "claude-opus-5-5"}`. Claude 4.5 and later models are supported. The object form also accepts `speed` (csharp, go: `Speed`), `effort` (csharp, go: `Effort`), and `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) fields; see the tips under [Create an agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#create-an-agent), [Effort levels](https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels), and [Pin the inference geo](https://platform.claude.com/docs/en/managed-agents/agent-setup#pin-the-inference-geo). |
| `system` (csharp, go: `System`; ruby: `system_`)                                | A [system prompt](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#give-claude-a-role) that defines the agent’s behavior and persona. The system prompt is distinct from [user messages](https://platform.claude.com/docs/en/managed-agents/reference#event-types), which should describe the work to be done.                                                                                                                                                                                                                                                                                                                                                                                      |
| `tools` (csharp, go: `Tools`)                                                   | The tools available to the agent. Combines [pre-built agent tools](https://platform.claude.com/docs/en/managed-agents/tools), [MCP tools](https://platform.claude.com/docs/en/managed-agents/mcp-connector), and [custom tools](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) | [MCP servers](https://platform.claude.com/docs/en/managed-agents/mcp-connector) that provide standardized third-party capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `skills` (csharp, go: `Skills`)                                                 | [Skills](https://platform.claude.com/docs/en/managed-agents/skills) that supply domain-specific context with progressive disclosure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `multiagent` (csharp, go: `Multiagent`)                                         | Lets the agent hand work to other agents, as subagents or in [dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#dynamic-workflows), and optionally consult an [advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor) model. With the `multiagent_20261001` type, dynamic workflows are on unless you disable them. See [Multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration).                                                                                                                                                                                                                    |
| `description` (csharp, go: `Description`)                                       | A description of what the agent does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `metadata` (csharp, go: `Metadata`)                                             | Arbitrary key-value pairs for your own tracking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

You can also override `model` (csharp, go: `Model`), `system` (csharp, go: `System`; ruby: `system_`), `tools` (csharp, go: `Tools`), `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`), and `skills` (csharp, go: `Skills`) for a single session without changing the agent. A `model` (csharp, go: `Model`) override replaces the agent’s `model` (csharp, go: `Model`) object in full, so the agent’s own `effort` (csharp, go: `Effort`) isn’t carried over. To run the session at a specific effort level, set `effort` (csharp, go: `Effort`) inside the override’s `model` (csharp, go: `Model`) object. See [Override agent configuration for a session](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session).

## Create an agent

The following example defines a coding agent that uses the newest Claude Opus model with access to the pre-built agent toolset. The toolset lets the agent write code, read files, search the web, and more. See the [agent tools reference](https://platform.claude.com/docs/en/managed-agents/tools) for the full list of supported tools.

The examples use curl, the `ant` CLI, or the SDK. If you haven’t set one up, the [quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart#install-the-cli) covers installation and client setup.

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
      "system": "You are a helpful coding agent.",
      "tools": [{"type": "agent_toolset_20260401"}]
    }'
  ```

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

      You are a helpful coding agent.
      ```
    </File>

    [`ant apply`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply) creates the agent from `coding-assistant.md`, prints its ID, and records it in `claude-lock.json`. Commit `claude-lock.json` so the next `ant apply` updates this agent instead of creating a second one.
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Coding Assistant",
      model="claude-opus-5-5",
      system="You are a helpful coding agent.",
      tools=[
          {"type": "agent_toolset_20260401"},
      ],
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Coding Assistant",
    model: "claude-opus-5-5",
    system: "You are a helpful coding agent.",
    tools: [{ type: "agent_toolset_20260401" }]
  });
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Coding Assistant",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      System = "You are a helpful coding agent.",
      Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
  });
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "Coding Assistant",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	System: anthropic.String("You are a helpful coding agent."),
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  	}},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var agent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("Coding Assistant")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .system("You are a helpful coding agent.")
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
          .build()
  );
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Coding Assistant',
      model: 'claude-opus-5-5',
      system: 'You are a helpful coding agent.',
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(),
      ],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Coding Assistant",
    model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
    system_: "You are a helpful coding agent.",
    tools: [{type: "agent_toolset_20260401"}]
  )
  ```
</CodeGroup>

The response echoes your configuration and adds `id`, `type`, `version`, `created_at`, `updated_at`, and `archived_at` fields, and fills in `model` fields you omit, such as `effort`, with their defaults. The `version` starts at 1 and increments each time an update changes the agent.

```json
{
  "id": "agent_01HqR2k7vXbZ9mNpL3wYcT8f",
  "type": "agent",
  "name": "Coding Assistant",
  "model": {
    "id": "claude-opus-5-5",
    "effort": { "type": "medium" },
    "speed": "standard"
  },
  "system": "You are a helpful coding agent.",
  "description": null,
  "tools": [
    {
      "type": "agent_toolset_20260401",
      "default_config": {
        "permission_policy": { "type": "always_allow" }
      }
    }
  ],
  "skills": [],
  "mcp_servers": [],
  "multiagent": null,
  "metadata": {},
  "version": 1,
  "created_at": "2026-04-03T18:24:10.412Z",
  "updated_at": "2026-04-03T18:24:10.412Z",
  "archived_at": null
}
```

The `default_config` on the toolset shows its default [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies), `always_allow`, which applies unless you configure one.

<Tip>
  To use Claude Opus 5.5, Claude Opus 5, or Claude Opus 4.8 with [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), pass `model` as an object, for example: `{"id": "claude-opus-5-5", "speed": "fast"}`. See the fast mode page’s [supported models](https://platform.claude.com/docs/en/build-with-claude/fast-mode#supported-models).
</Tip>

<Tip>
  To set the model’s effort level, pass `model` as an object, for example: `{"id": "claude-opus-5-5", "effort": "high"}`. The `effort` field accepts a level string (`low`, `medium`, `high`, `xhigh`, or `max`) or an object such as `{"type": "high"}`. See [Effort levels](https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels) for what each level does.
</Tip>

### Pin the inference geo

Like `speed` (csharp, go: `Speed`) and `effort` (csharp, go: `Effort`), `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) is set through the object form of `model` (csharp, go: `Model`): pass `model` (csharp, go: `Model`) as an object and set `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) alongside `id` (csharp, go: `ID`). The field accepts `"us"` or `"global"`. When it’s unset, each model request follows the workspace’s default inference geo at the time it’s served. See [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency) for the workspace-level geo controls and pricing.

The following example pins an agent to US inference. The response carries the `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) value in the agent’s `model` (csharp, go: `Model`) object:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Geo-pinned assistant",
      "model": {"id": "claude-opus-5-5", "inference_geo": "us"},
      "system": "You are a helpful assistant."
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply geo-pinned-assistant.md
    ```

    <File filename="geo-pinned-assistant.md">
      ```markdown
      ---
      name: Geo-pinned assistant
      model:
        id: claude-opus-5-5
        inference_geo: us
      ---

      You are a helpful assistant.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Geo-pinned assistant",
      model={
          "id": "claude-opus-5-5",
          "inference_geo": "us",
      },
      system="You are a helpful assistant.",
  )

  print(f"Inference geo: {agent.model.inference_geo}")
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Geo-pinned assistant",
    model: { id: "claude-opus-5-5", inference_geo: "us" },
    system: "You are a helpful assistant."
  });

  console.log(`Inference geo: ${agent.model.inference_geo}`);
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Geo-pinned assistant",
      Model = new BetaManagedAgentsModelConfigParams
      {
          ID = BetaManagedAgentsModel.ClaudeOpus5_5,
          InferenceGeo = "us",
      },
      System = "You are a helpful assistant.",
  });

  Console.WriteLine($"Inference geo: {agent.Model.InferenceGeo}");
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "Geo-pinned assistant",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID:           anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  		InferenceGeo: anthropic.String("us"),
  	},
  	System: anthropic.String("You are a helpful assistant."),
  })
  if err != nil {
  	panic(err)
  }

  fmt.Printf("Inference geo: %s\n", agent.Model.InferenceGeo)
  ```

  ```java Java
  var agent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("Geo-pinned assistant")
          .model(
              BetaManagedAgentsModelConfigParams.builder()
                  .id(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
                  .inferenceGeo("us")
                  .build()
          )
          .system("You are a helpful assistant.")
          .build()
  );

  IO.println("Inference geo: " + agent.model().inferenceGeo().orElseThrow());
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Geo-pinned assistant',
      model: BetaManagedAgentsModelConfigParams::with(
          id: 'claude-opus-5-5',
          inferenceGeo: 'us',
      ),
      system: 'You are a helpful assistant.',
  );

  echo "Inference geo: {$agent->model->inferenceGeo}\n";
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Geo-pinned assistant",
    model: {id: "claude-opus-5-5", inference_geo: "us"},
    system_: "You are a helpful assistant."
  )

  puts "Inference geo: #{agent.model.inference_geo}"
  ```
</CodeGroup>

An `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) pin is validated against the workspace’s [`allowed_inference_geos`](https://platform.claude.com/docs/en/manage-claude/data-residency#workspace-level-restrictions) when the agent is saved, when a session is created from it, and on every turn the session serves. If the workspace allowlist narrows so a pin is no longer allowed, new sessions can’t be created from the agent and running sessions refuse further turns; pins are never exempted, because workspaces rely on them for compliance and data residency.

Setting `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) on a model that doesn’t support geographic inference pinning returns a 400 error; see [Model availability](https://platform.claude.com/docs/en/manage-claude/data-residency#model-availability) for the models that do. In a `multiagent` (csharp, go: `Multiagent`) configuration, the agent’s pin and the pin of every agent listed in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) or `workflows` (csharp, go: `Workflows`) must all be set to the same value or all be unset; see [Multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration). To change or clear the pin later, update the agent’s `model` (csharp, go: `Model`) object; supplying `model` (csharp, go: `Model`) without `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) clears it, as described under [Update semantics](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-semantics).

## Update an agent

Updating an agent generates a new version when the configuration changes. The `version` (csharp, go: `Version`) field is optional: supply it for optimistic concurrency (a mismatch returns a 409), or omit it to apply the update unconditionally (last write wins). Updates to archived agents are rejected.

With the CLI, edit the agent’s file and run `ant apply` again; apply supplies `version` for you.

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL "https://api.anthropic.com/v1/agents/$AGENT_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "version": '"$AGENT_VERSION"',
      "system": "You are a helpful coding agent. Always write tests."
    }'
  ```

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

      You are a helpful coding agent. Always write tests.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  updated_agent = client.beta.agents.update(
      agent.id,
      version=agent.version,
      system="You are a helpful coding agent. Always write tests.",
  )

  print(f"New version: {updated_agent.version}")
  ```

  ```typescript TypeScript
  const updatedAgent = await client.beta.agents.update(agent.id, {
    version: agent.version,
    system: "You are a helpful coding agent. Always write tests."
  });

  console.log(`New version: ${updatedAgent.version}`);
  ```

  ```csharp C#
  var updatedAgent = await client.Beta.Agents.Update(agent.ID, new()
  {
      Version = agent.Version,
      System = "You are a helpful coding agent. Always write tests.",
  });

  Console.WriteLine($"New version: {updatedAgent.Version}");
  ```

  ```go Go
  updatedAgent, err := client.Beta.Agents.Update(ctx, agent.ID, anthropic.BetaAgentUpdateParams{
  	Version: anthropic.Int(agent.Version),
  	System:  anthropic.String("You are a helpful coding agent. Always write tests."),
  })
  if err != nil {
  	panic(err)
  }

  fmt.Printf("New version: %d\n", updatedAgent.Version)
  ```

  ```java Java
  var updatedAgent = client.beta().agents().update(
      agent.id(),
      AgentUpdateParams.builder()
          .version(agent.version())
          .system("You are a helpful coding agent. Always write tests.")
          .build()
  );

  IO.println("New version: " + updatedAgent.version());
  ```

  ```php PHP
  $updatedAgent = $client->beta->agents->update(
      $agent->id,
      version: $agent->version,
      system: 'You are a helpful coding agent. Always write tests.',
  );

  echo "New version: {$updatedAgent->version}\n";
  ```

  ```ruby Ruby
  updated_agent = client.beta.agents.update(
    agent.id,
    version: agent.version,
    system_: "You are a helpful coding agent. Always write tests."
  )

  puts "New version: #{updated_agent.version}"
  ```
</CodeGroup>

The preceding example supplies `version` (csharp, go: `Version`) from the create response, so the update only applies if nothing else has changed the agent since you read it. To apply an update unconditionally, omit `version` (csharp, go: `Version`) from the request:

<CodeGroup>
  ```bash cURL
  curl -fsSL "https://api.anthropic.com/v1/agents/$AGENT_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "description": "Writes and reviews code."
    }'
  ```

  ```bash CLI
  ant beta:agents update \
    --agent-id "$AGENT_ID" \
    --description "Writes and reviews code."
  ```

  ```python Python
  unconditional_agent = client.beta.agents.update(
      agent.id,
      description="Writes and reviews code.",
  )

  print(f"New version: {unconditional_agent.version}")
  ```

  ```typescript TypeScript
  const unconditionalAgent = await client.beta.agents.update(agent.id, {
    description: "Writes and reviews code."
  });

  console.log(`New version: ${unconditionalAgent.version}`);
  ```

  ```csharp C#
  var unconditionalAgent = await client.Beta.Agents.Update(agent.ID, new()
  {
      Description = "Writes and reviews code.",
  });

  Console.WriteLine($"New version: {unconditionalAgent.Version}");
  ```

  ```go Go
  unconditionalAgent, err := client.Beta.Agents.Update(ctx, agent.ID, anthropic.BetaAgentUpdateParams{
  	Description: anthropic.String("Writes and reviews code."),
  })
  if err != nil {
  	panic(err)
  }

  fmt.Printf("New version: %d\n", unconditionalAgent.Version)
  ```

  ```java Java
  var unconditionalAgent = client.beta().agents().update(
      agent.id(),
      AgentUpdateParams.builder()
          .description("Writes and reviews code.")
          .build()
  );

  IO.println("New version: " + unconditionalAgent.version());
  ```

  ```php PHP
  $unconditionalAgent = $client->beta->agents->update(
      $agent->id,
      description: 'Writes and reviews code.',
  );

  echo "New version: {$unconditionalAgent->version}\n";
  ```

  ```ruby Ruby
  unconditional_agent = client.beta.agents.update(
    agent.id,
    description: "Writes and reviews code."
  )

  puts "New version: #{unconditional_agent.version}"
  ```
</CodeGroup>

### Update semantics

* **`version` (csharp, go: `Version`)** is optional and must be at least 1 when supplied. When supplied, the request returns a 409 if it doesn’t match the agent’s current version, even when the fields you send already match the stored values; re-read the agent and retry. When omitted, the update applies unconditionally and the most recent update silently replaces any concurrent one, with no error to either caller. Supplying `version` (csharp, go: `Version`) is the recommended default for interactive callers, and omitting it fits declarative apply loops, such as a CI job that syncs checked-in agent definitions, where the loop owns the agent.

* **Omitted fields are preserved.** You only need to include the fields you want to change.

* **Scalar fields** (`model` (csharp, go: `Model`), `system` (csharp, go: `System`; ruby: `system_`), `name` (csharp, go: `Name`), `description` (csharp, go: `Description`)) are replaced with the new value. `system` (csharp, go: `System`; ruby: `system_`) and `description` (csharp, go: `Description`) can be cleared by passing `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `param.Null[string]()`; php: `requestOptions: ['extraBodyParams' => ['system' => null, 'description' => null]]`). `model` (csharp, go: `Model`) and `name` (csharp, go: `Name`) are mandatory and cannot be cleared. Within a `model` (csharp, go: `Model`) object you supply, `effort` (csharp, go: `Effort`) is the sole exception: if the model `id` (csharp, go: `ID`) is unchanged, omitting `effort` (csharp, go: `Effort`) leaves the stored effort level unchanged. If you change the model `id` (csharp, go: `ID`), an omitted `effort` (csharp, go: `Effort`) resets to the new model’s default. Other `model` (csharp, go: `Model`) fields are replaced along with the object: supplying `model` (csharp, go: `Model`) without `inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) clears the agent’s inference geo pin.

* **Array fields** (`tools` (csharp, go: `Tools`), `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`), `skills` (csharp, go: `Skills`)) are fully replaced by the new array. To clear an array field entirely, pass `null` (python: `None`; ruby: `nil`; java: `Optional.empty()`; go: `param.NullSlice[[]anthropic.BetaAgentUpdateParamsToolUnion]()`; php: `requestOptions: ['extraBodyParams' => ['mcp_servers' => null]]`) or an empty array.

* **`multiagent` (csharp, go: `Multiagent`)** is merged into the stored block level by level when the update keeps the `multiagent_20261001` type. A setting that you omit keeps its stored value, and a `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list that you send replaces the stored list. Any other update that sends `multiagent` (csharp, go: `Multiagent`) replaces the stored block as a whole, and the settings that it omits take their defaults. Pass `"multiagent": null` (python: `multiagent=None`; typescript: `multiagent: null`; ruby: `multiagent: nil`; go: `Multiagent: param.NullStruct[anthropic.BetaManagedAgentsMultiagentParamsUnion]()`; java: `.multiagent(Optional.empty())`; csharp: `Multiagent = null`; php: `requestOptions: ['extraBodyParams' => ['multiagent' => null]]`) to clear the whole block. Inside the block, `null` resets a setting to its default, so setting `workflows` (csharp, go: `Workflows`) to `null` turns dynamic workflows on. See [Turn on dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows).

* **Metadata** is merged at the key level. Keys you provide are added or updated. Keys you omit are preserved. To delete a specific key, set its value to `null`.

* **No-op detection.** If the update produces no change relative to the current version, no new version is created and the existing version is returned.

* **Other agents’ `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) lists are not updated.** Agents that list this agent in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) or `workflows` (csharp, go: `Workflows`) keep the version that was pinned when they were created or when an update last sent that list, even if the reference omits `version` (csharp, go: `Version`). To delegate to the new version, [update the agent that lists it](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#list-the-subagents) so that the list references the new version.

The following update clears the description, deletes the `team` key from `metadata` (csharp, go: `Metadata`), and sets `workflows` (csharp, go: `Workflows`) to `null`, which turns dynamic workflows on:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL "https://api.anthropic.com/v1/agents/$AGENT_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "description": null,
      "metadata": {"team": null},
      "multiagent": {"type": "multiagent_20261001", "workflows": null}
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply code-reviewer.md
    ```

    <File filename="code-reviewer.md">
      ```markdown
      ---
      name: Code Reviewer
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
      metadata:
        owner: docs
      multiagent:
        type: multiagent_20261001
        workflows: null
      ---

      You are a helpful coding agent.
      ```
    </File>

    The file no longer has `description` or the `team` key, so `ant apply` sends `null` for them. Deleting a setting inside `multiagent` keeps its stored value, so the file sets `workflows` to `null`.
  </CodeGroupItem>

  ```python Python
  cleared_agent = client.beta.agents.update(
      agent.id,
      description=None,
      metadata={"team": None},
      multiagent={"type": "multiagent_20261001", "workflows": None},
  )

  print(f"Description: {cleared_agent.description}")
  ```

  ```typescript TypeScript
  const clearedAgent = await client.beta.agents.update(agent.id, {
    description: null,
    metadata: { team: null },
    multiagent: { type: "multiagent_20261001", workflows: null }
  });

  console.log(`Description: ${clearedAgent.description}`);
  ```

  ```csharp C#
  var clearedAgent = await client.Beta.Agents.Update(agent.ID, new()
  {
      Description = null,
      Metadata = new Dictionary<string, string?> { ["team"] = null },
      Multiagent = new BetaManagedAgentsMultiagent20261001Params { Workflows = null },
  });

  Console.WriteLine($"Description: {clearedAgent.Description}");
  ```

  ```go Go
  // Metadata is a map[string]string, so send the null for team as a request option.
  clearedAgent, err := client.Beta.Agents.Update(ctx, agent.ID, anthropic.BetaAgentUpdateParams{
  	Description: param.Null[string](),
  	Multiagent: anthropic.BetaManagedAgentsMultiagentParamsUnion{
  		OfMultiagent20261001: &anthropic.BetaManagedAgentsMultiagent20261001Params{
  			Workflows: param.NullStruct[anthropic.BetaManagedAgentsMultiagentWorkflowsParamsUnion](),
  		},
  	},
  }, option.WithJSONSet("metadata.team", nil))
  if err != nil {
  	panic(err)
  }

  fmt.Printf("Description: %q\n", clearedAgent.Description)
  ```

  ```java Java
  var clearedAgent = client.beta().agents().update(
      agent.id(),
      AgentUpdateParams.builder()
          .description(Optional.empty())
          .metadata(
              AgentUpdateParams.Metadata.builder()
                  .putAdditionalProperty("team", JsonValue.from(null))
                  .build()
          )
          .multiagent(
              BetaManagedAgentsMultiagent20261001Params.builder()
                  .workflows(Optional.empty())
                  .build()
          )
          .build()
  );

  IO.println("Description: " + clearedAgent.description().orElse(null));
  ```

  ```php PHP
  // update() drops null arguments, so pass the nulls in extraBodyParams.
  $clearedAgent = $client->beta->agents->update(
      $agent->id,
      requestOptions: [
          'extraBodyParams' => [
              'description' => null,
              'metadata' => ['team' => null],
              'multiagent' => ['type' => 'multiagent_20261001', 'workflows' => null],
          ],
      ],
  );

  echo 'Description: ' . json_encode($clearedAgent->description) . "\n";
  ```

  ```ruby Ruby
  cleared_agent = client.beta.agents.update(
    agent.id,
    description: nil,
    metadata: {team: nil},
    multiagent: {type: :multiagent_20261001, workflows: nil}
  )

  puts "Description: #{cleared_agent.description.inspect}"
  ```
</CodeGroup>

## Agent lifecycle

| Operation         | Behavior                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| **Update**        | Generates a new agent version when the configuration changes.                                       |
| **List versions** | Returns the full version history so you can track changes over time.                                |
| **Archive**       | Makes the agent read-only. New sessions cannot reference it, but existing sessions continue to run. |

### List versions

Fetch the full version history to track how an agent has changed over time. Results are paginated, and the SDK examples fetch every page automatically.

<CodeGroup>
  ```bash cURL
  curl -fsSL "https://api.anthropic.com/v1/agents/$AGENT_ID/versions" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:agents:versions list --agent-id "$AGENT_ID"
  ```

  ```python Python
  for version in client.beta.agents.versions.list(agent.id):
      print(f"Version {version.version}: {version.updated_at.isoformat()}")
  ```

  ```typescript TypeScript
  for await (const version of client.beta.agents.versions.list(agent.id)) {
    console.log(`Version ${version.version}: ${version.updated_at}`);
  }
  ```

  ```csharp C#
  var versions = await client.Beta.Agents.Versions.List(agent.ID);
  await foreach (var version in versions.Paginate())
  {
      Console.WriteLine($"Version {version.Version}: {version.UpdatedAt:O}");
  }
  ```

  ```go Go
  iter := client.Beta.Agents.Versions.ListAutoPaging(ctx, agent.ID, anthropic.BetaAgentVersionListParams{})
  for iter.Next() {
  	version := iter.Current()
  	fmt.Printf("Version %d: %s\n", version.Version, version.UpdatedAt.Format(time.RFC3339))
  }
  if err := iter.Err(); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  for (var version : client.beta().agents().versions().list(agent.id()).autoPager()) {
      IO.println("Version " + version.version() + ": " + version.updatedAt());
  }
  ```

  ```php PHP
  foreach ($client->beta->agents->versions->list($agent->id)->pagingEachItem() as $version) {
      echo "Version {$version->version}: {$version->updatedAt->format(\DateTimeInterface::ATOM)}\n";
  }
  ```

  ```ruby Ruby
  client.beta.agents.versions.list(agent.id).auto_paging_each do |agent_version|
    puts "Version #{agent_version.version}: #{agent_version.updated_at.iso8601}"
  end
  ```
</CodeGroup>

### Archive an agent

Archiving makes the agent read-only and cannot be undone. Existing sessions continue to run, but new sessions cannot reference the agent. The response sets `archived_at` (java, php: `archivedAt`; csharp, go: `ArchivedAt`) to the archive timestamp.

<CodeGroup>
  ```bash cURL
  curl -fsSL -X POST "https://api.anthropic.com/v1/agents/$AGENT_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:agents archive --agent-id "$AGENT_ID"
  ```

  ```python Python
  archived = client.beta.agents.archive(agent.id)

  print(f"Archived at: {archived.archived_at.isoformat()}")
  ```

  ```typescript TypeScript
  const archived = await client.beta.agents.archive(agent.id);
  console.log(`Archived at: ${archived.archived_at}`);
  ```

  ```csharp C#
  var archived = await client.Beta.Agents.Archive(agent.ID);
  Console.WriteLine($"Archived at: {archived.ArchivedAt:O}");
  ```

  ```go Go
  archived, err := client.Beta.Agents.Archive(ctx, agent.ID, anthropic.BetaAgentArchiveParams{})
  if err != nil {
  	panic(err)
  }
  fmt.Printf("Archived at: %s\n", archived.ArchivedAt.Format(time.RFC3339))
  ```

  ```java Java
  var archived = client.beta().agents().archive(agent.id());
  IO.println("Archived at: " + archived.archivedAt().orElseThrow());
  ```

  ```php PHP
  $archived = $client->beta->agents->archive($agent->id);

  echo "Archived at: {$archived->archivedAt->format(\DateTimeInterface::ATOM)}\n";
  ```

  ```ruby Ruby
  archived = client.beta.agents.archive(agent.id)
  puts "Archived at: #{archived.archived_at.iso8601}"
  ```
</CodeGroup>

## Next steps

<CardGroup cols={2}>
  <Card title="Tools" icon="tool" href="https://platform.claude.com/docs/en/managed-agents/tools">
    Configure tools available to your agent.
  </Card>

  <Card title="Skills" icon="graduation-cap" href="https://platform.claude.com/docs/en/managed-agents/skills">
    Attach reusable, filesystem-based expertise to your agent for domain-specific workflows.
  </Card>

  <Card title="Start a session" icon="play" href="https://platform.claude.com/docs/en/managed-agents/sessions">
    Create a session to run your agent and start running tasks.
  </Card>

  <Card title="Reference" icon="book" href="https://platform.claude.com/docs/en/managed-agents/reference">
    Event types, self-hosted worker CLI flags, supported MCP server types, rate limits, and branding guidelines for Claude Managed Agents.
  </Card>
</CardGroup>

## Availability

Agent configurations are available on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

| Status    | Cloud platforms                                                                                                                                                                                                                                                                | Models                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Available | Claude API, [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws), [Claude Models on Google Cloud (Anthropic managed)](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed) | [All models](https://platform.claude.com/docs/en/models/overview) |

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
