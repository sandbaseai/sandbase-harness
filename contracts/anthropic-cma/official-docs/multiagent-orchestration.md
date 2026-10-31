---
title: Multiagent orchestration
url: https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
description: Coordinate multiple agents within a single session.
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

Multiagent orchestration lets one agent coordinate with others to complete complex work. Agents can act in parallel with their own isolated context, which helps improve output quality and can also improve time to completion.

Not sure a multiagent setup fits your problem? See [when to use multiagent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them).

## Hand work to other agents

The agent that a session runs can hand work to other agents in two ways. With **subagents**, it delegates tasks itself and reads what each subagent reports. With **dynamic workflows**, it writes a workflow: a program that runs many agents in the background and combines their results. It can also consult an **advisor** model for guidance while it does the work itself.

You decide which of these the agent can use, and the agent determines when to use them. To guide that choice, tell the agent in its system prompt when to use a workflow run. See [Tell the agent when to use a run](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#tell-the-agent-when-to-use-a-run). You can also limit the agent to agents that you list.

With subagents, the agent itself determines what happens next. A [subagent’s thread](https://platform.claude.com/docs/en/managed-agents/session-threads) stays available until you archive it, so the agent can send it follow-up messages. With dynamic workflows, Claude writes a program to orchestrate agents without Claude’s direct involvement. Context and results are passed programmatically from one agent to another, freeing up the main session thread to communicate with the user and check in on one or several running workflows to report on progress. The agent can’t send follow-up messages to a run’s threads, and the server archives each one by the end of its run.

| Approach                                                                                                                               | What happens                                                                                                                                                                                                                                               | Use it when                                                                                                                                                                                     | Consider                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Delegate to subagents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#delegate-to-subagents)             | The agent delegates tasks to its subagents. Each subagent works in its own [session thread](https://platform.claude.com/docs/en/managed-agents/session-threads), which you can list and stream.                                                            | The agent should follow up with a subagent after it reports, or it needs specialists that you list, with their own system prompts and tools.                                                    | Delegation is one level deep, and a session can have at most 25 child threads at a time, idle ones included. Advisor threads and a workflow run’s threads don’t count.                                                                                                                       |
| [Dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#dynamic-workflows)                     | The agent writes a workflow: a program that runs many agents in phases and combines their results. The server runs it in the background as one workflow run, which you can follow. The workflow defines the agents or picks them from a list you give.     | Most work that needs more than one agent: work with many pieces, parallel work, or a long task that should complete sooner. Examples are audits, migrations, deep research, and cross-checking. | Every agent in a run uses tokens, so set a [session budget](https://platform.claude.com/docs/en/managed-agents/budgets) to cap the session’s spend, runs included. Tell the agent in its system prompt when to use a run. You follow the run by its phases and can read each of its threads. |
| [Give the session an advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor) | The session’s [primary thread](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#how-it-works) consults an advisor model mid-turn for guidance, such as planning an approach or reviewing work, and keeps doing the work itself. | One agent should do the work, with an advisor model’s judgment at key moments such as planning or a final review.                                                                               | Only the primary thread can consult the advisor, and consultations are billed at the advisor model’s rates.                                                                                                                                                                                  |

You set these up in the `multiagent` block of the agent’s definition, which has a `type`. With the `multiagent_20261001` type, an agent can use all three together, and you can turn each one on or off. By default, `subagents` and `workflows` are both enabled. `subagents` and `workflows` each have `inline_agents` enabled, the setting for [agents that the agent or a workflow defines itself](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents):

```json
{
  "multiagent": { "type": "multiagent_20261001" }
}
```

To set which agents the agent can call, see [Predefined and inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents). To turn a setting off, see [Turn on dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows).

## Predefined and inline agents

Every subagent, and every agent in a workflow run, is one of two kinds:

* **Predefined agent:** An agent that you have already [created](https://platform.claude.com/docs/en/managed-agents/agent-setup), and that you list in the `multiagent` (csharp, go: `Multiagent`) block. It uses its own configuration: model, system prompt, tools, MCP servers, and skills.
* **Inline agent:** An agent that is not saved. The agent that the session runs, or a workflow, defines it when it hands out the work. It uses that agent’s model, tools, MCP servers, and skills.

Both kinds work under `subagents` and under `workflows`:

| Kind of agent | Under `subagents`                                                                                       | Under `workflows`                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Predefined    | The agent can delegate to the agents that you list in `subagents.predefined_agents`.                    | A workflow can use the agents that you list in `workflows.predefined_agents`.                                                |
| Inline        | The agent can define an inline agent when it delegates. `subagents.inline_agents` turns this on or off. | A workflow can define inline agents, and it writes a system prompt for each. `workflows.inline_agents` turns this on or off. |

`subagents.predefined_agents` and `workflows.predefined_agents` are two separate lists. An agent in one list is not added to the other. Both lists are empty by default. An entry of either list takes one of these forms:

* `{"type": "agent", "id": agent.id}` references a previously created `agent` by ID. If no `version` is specified, the reference is pinned to the agent’s latest version when the agent that lists it is created, or when an update sends the list.
* `{"type": "agent", "id": agent.id, "version": agent.version}` pins a specific agent version.
* `agent.id` alone, as a string, is short for `{"type": "agent", "id": agent.id}`.
* `{"type": "self"}` lists the agent itself, so that copies of it can do the work. If the session was created with [agent configuration overrides](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session), those overrides also apply to these copies. Entries referenced by ID are unaffected.

The rules for these entries, and for the agents that they name, apply to both lists. See [List the subagents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#list-the-subagents).

Inline agents are on by default under both settings. To allow only the agents that you list, set `inline_agents` to `{"type": "disabled"}` under `subagents`, under `workflows`, or under both. A setting with inline agents off needs at least one agent in its `predefined_agents` list. With an empty list, the request fails with a 400 error. On an update, the server checks the settings as they stand after the update.

The following agent allows only the agents that it lists. It can delegate to one agent and to copies of itself, and a workflow can use version 2 of another agent:

```json
{
  "multiagent": {
    "type": "multiagent_20261001",
    "subagents": {
      "type": "enabled",
      "inline_agents": { "type": "disabled" },
      "predefined_agents": ["agent_01J8XkN5uT3vHpLqRfWdY2", { "type": "self" }]
    },
    "workflows": {
      "type": "enabled",
      "inline_agents": { "type": "disabled" },
      "predefined_agents": [
        { "type": "agent", "id": "agent_01Lm4cV8yQ2tNs7XbKdR5h", "version": 2 }
      ]
    }
  }
}
```

## Delegate to subagents

### What to delegate

Multiagent coordination is best suited for complex tasks that either require work across a variety of surfaces or consist of multiple well-scoped tasks that contribute to an overall goal.

Patterns that work well:

* **Parallelization:** Fan out independent subtasks simultaneously (searching multiple sources, analyzing separate files) and have the agent synthesize the results.
* **Specialization:** Route to agents with domain-focused system prompts and tools, such as a security agent or a documentation agent, rather than loading a single agent with every capability.
* **Escalation:** Consult a more capable agent or model for a subset of complex subtasks. To consult a model, [give the session an advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor).

### How it works

All agents share the same sandbox, filesystem, and [vault credentials](https://platform.claude.com/docs/en/managed-agents/vaults), but each agent runs in its own **session thread**, a context-isolated event stream with its own conversation history. The agent that the session runs reports activity in the **primary thread**, which is the session-level [event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming). Additional threads are spawned at runtime when it delegates work. A workflow run also creates threads.

A subagent’s thread is persistent. The agent can send a follow-up to a subagent it called earlier, and that subagent retains everything from its previous turns.

Which configuration a subagent uses depends on whether it is a [predefined or an inline agent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents). Session-level [agent configuration overrides](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session) apply to the agent that the session runs and to its `self` copies. Each agent keeps its own conversation history.

### List the subagents

When [defining your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), set the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) in the `multiagent` (csharp, go: `Multiagent`) block to list the agents that it can delegate to:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Engineering Lead",
      "model": "claude-opus-5-5",
      "system": "You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.",
      "tools": [
        {
          "type": "agent_toolset_20260401"
        }
      ],
      "multiagent": {
        "type": "multiagent_20261001",
        "subagents": {
          "type": "enabled",
          "predefined_agents": [
            {"type": "agent", "id": "'"$REVIEWER_AGENT_ID"'"},
            {"type": "agent", "id": "'"$TEST_WRITER_AGENT_ID"'"}
          ]
        }
      }
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply engineering-lead.md reviewer.md test-writer.md
    ```

    <File filename="engineering-lead.md">
      ```markdown
      ---
      name: Engineering Lead
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
      multiagent:
        type: multiagent_20261001
        subagents:
          type: enabled
          predefined_agents: # ant apply replaces each path with {type: agent, id, version}
            - ./reviewer.md
            - ./test-writer.md
      ---

      You coordinate engineering work. Delegate code review to the reviewer agent
      and test writing to the test agent.
      ```
    </File>

    <File filename="reviewer.md">
      ```markdown
      ---
      name: reviewer
      model: claude-haiku-5-5
      ---

      You are a code reviewer.
      ```
    </File>

    <File filename="test-writer.md">
      ```markdown
      ---
      name: test-writer
      model: claude-haiku-5-5
      ---

      You write unit tests.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  lead_agent = client.beta.agents.create(
      name="Engineering Lead",
      model="claude-opus-5-5",
      system="You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.",
      tools=[
          {"type": "agent_toolset_20260401"},
      ],
      multiagent={
          "type": "multiagent_20261001",
          "subagents": {
              "type": "enabled",
              "predefined_agents": [
                  {"type": "agent", "id": reviewer_agent.id},
                  {"type": "agent", "id": test_writer_agent.id},
              ],
          },
      },
  )
  ```

  ```typescript TypeScript
  const leadAgent = await client.beta.agents.create({
    name: "Engineering Lead",
    model: "claude-opus-5-5",
    system:
      "You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: {
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        predefined_agents: [
          { type: "agent", id: reviewerAgent.id },
          { type: "agent", id: testWriterAgent.id }
        ]
      }
    }
  });
  ```

  ```csharp C#
  var leadAgent = await client.Beta.Agents.Create(new()
  {
      Name = "Engineering Lead",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      System = "You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.",
      Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
      Multiagent = new BetaManagedAgentsMultiagent20261001Params
      {
          Subagents = new BetaManagedAgentsMultiagentSubagentsEnabledParams
          {
              PredefinedAgents = [reviewerAgent.ID, testWriterAgent.ID],
          },
      },
  });
  ```

  ```go Go
  leadAgent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name:   "Engineering Lead",
  	Model:  anthropic.BetaManagedAgentsModelConfigParams{ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5},
  	System: anthropic.String("You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent."),
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  	}},
  	Multiagent: anthropic.BetaManagedAgentsMultiagentParamsUnion{
  		OfMultiagent20261001: &anthropic.BetaManagedAgentsMultiagent20261001Params{
  			Subagents: anthropic.BetaManagedAgentsMultiagentSubagentsParamsUnion{
  				OfEnabled: &anthropic.BetaManagedAgentsMultiagentSubagentsEnabledParams{
  					PredefinedAgents: []anthropic.BetaManagedAgentsMultiagentPredefinedAgentParamsUnion{
  						{OfString: anthropic.String(reviewerAgent.ID)},
  						{OfString: anthropic.String(testWriterAgent.ID)},
  					},
  				},
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var leadAgent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("Engineering Lead")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .system("You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.")
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
          .multiagent(BetaManagedAgentsMultiagent20261001Params.builder()
              .subagents(BetaManagedAgentsMultiagentSubagentsEnabledParams.builder()
                  .addPredefinedAgent(BetaManagedAgentsAgentParams.builder()
                      .id(reviewerAgent.id())
                      .build())
                  .addPredefinedAgent(BetaManagedAgentsAgentParams.builder()
                      .id(testWriterAgent.id())
                      .build())
                  .build())
              .build())
          .build()
  );
  ```

  ```php PHP
  $leadAgent = $client->beta->agents->create(
      name: 'Engineering Lead',
      model: 'claude-opus-5-5',
      system: 'You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.',
      tools: [
          ['type' => 'agent_toolset_20260401'],
      ],
      multiagent: [
          'type' => 'multiagent_20261001',
          'subagents' => [
              'type' => 'enabled',
              'predefined_agents' => [
                  ['type' => 'agent', 'id' => $reviewerAgent->id],
                  ['type' => 'agent', 'id' => $testWriterAgent->id],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  lead_agent = client.beta.agents.create(
    name: "Engineering Lead",
    model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
    system: "You coordinate engineering work. Delegate code review to the reviewer agent and test writing to the test agent.",
    tools: [
      {type: "agent_toolset_20260401"}
    ],
    multiagent: {
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        predefined_agents: [
          {type: "agent", id: reviewer_agent.id},
          {type: "agent", id: test_writer_agent.id}
        ]
      }
    }
  )
  ```
</CodeGroup>

The agent can also delegate to inline agents unless you turn them off. For that setting, and for the forms that an entry of the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) takes, see [Predefined and inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents).

`"advisor": {"type": "enabled", "model": "<model id>"}` gives the session’s primary thread an advisor it can consult mid-turn. The advisor is a setting in the `multiagent` (csharp, go: `Multiagent`) block, not an entry in this list. See [Give the session an advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor).

Dynamic workflows are also enabled by default with this type, so this agent can plan large work that runs many agents in the background. To turn them off, or to list agents that a workflow can use, see [Turn on dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows).

The following rules apply to the agents you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`), and also to the agents you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`):

* **Pinning:** The agent’s configuration, including the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`), is snapshotted when the agent is created or updated. Referenced agents stay pinned to the versions resolved then and don’t pick up later updates to their definitions. An update that doesn’t send the list keeps the versions that are already pinned. To delegate to a newer version of a referenced agent, [update the agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-an-agent) so the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) references that version.
* **One level:** The agent can delegate to only one level of agents. Referencing another agent that has `multiagent` (csharp, go: `Multiagent`) set fails the create or update request with a 400 validation error.
* **Up to 20 agents:** The `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) can list up to 20 unique agents. The limit is for each list: the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`) can also list up to 20. The agent can call multiple copies of each subagent, within the session’s [thread limit](https://platform.claude.com/docs/en/managed-agents/session-threads).
* **Inference geography:** The agent and every agent that you list, in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) or of `workflows` (csharp, go: `Workflows`), must pin the same [inference geography](https://platform.claude.com/docs/en/manage-claude/data-residency) (`inference_geo` (java, php: `inferenceGeo`; csharp, go: `InferenceGeo`) in the `model` (csharp, go: `Model`) of the [agent definition](https://platform.claude.com/docs/en/managed-agents/agent-setup)), or none of them can pin one. A mismatch in either list is rejected with a 400 validation error. That check runs both when the agent is saved and when a [session-create override](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session) changes any of the pins.

### Create the session

Create a session referencing the agent. The agent delegates to the agents you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) as needed. It can also delegate to [inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents) unless you turn them off.

<CodeGroup>
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$LEAD_AGENT_ID"'",
      "environment_id": "'"$ENVIRONMENT_ID"'"
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$LEAD_AGENT_ID" \
    --environment-id "$ENVIRONMENT_ID"
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=lead_agent.id,
      environment_id=environment.id,
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: leadAgent.id,
    environment_id: environment.id
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = leadAgent.ID,
      EnvironmentID = environment.ID,
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent: anthropic.BetaSessionNewParamsAgentUnion{
  		OfString: anthropic.String(leadAgent.ID),
  	},
  	EnvironmentID: environment.ID,
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var session = client.beta().sessions().create(SessionCreateParams.builder()
      .agent(leadAgent.id())
      .environmentId(environment.id())
      .build());
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $leadAgent->id,
      environmentID: $environment->id,
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: lead_agent.id,
    environment_id: environment.id
  )
  ```
</CodeGroup>

### Connect agents to MCP servers

MCP servers are agent-scoped: each agent definition declares its own servers and tools. An inline agent has no agent definition, so it uses the MCP servers and tools of the agent that the session runs. Vault credentials are session-scoped: `vault_ids` (java: `vaultIds`; php: `vaultIDs`; csharp: `VaultIds`; go: `VaultIDs`) passed at session creation apply to every thread. Two implications for your integration:

* To authenticate MCP servers, include a vault credential for every MCP server used across all agents.
* To limit an agent’s access, declare only the servers it needs in its agent definition. You can’t limit an inline agent this way. To allow only the agents you list, disable `inline_agents` (java, php: `inlineAgents`; csharp, go: `InlineAgents`) in both `subagents` (csharp, go: `Subagents`) and `workflows` (csharp, go: `Workflows`), and list at least one agent in each. See [Predefined and inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents).

[Agent configuration overrides](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session) at session creation can replace the MCP servers of the agent that the session runs and those of its `self` copies.

With a `limited` [environment](https://platform.claude.com/docs/en/managed-agents/environments#networking), session creation fails with a 400 error when the agent, or an agent you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) or `workflows` (csharp, go: `Workflows`), declares an MCP server whose host is not in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Setting `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) to `true` in the environment’s networking turns this check off.

Create the researcher, which declares the GitHub MCP server, and the agent that delegates to the researcher:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  # Create the researcher
  curl --fail-with-body -sS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "researcher",
      "model": "claude-haiku-5-5",
      "mcp_servers": [{"type": "url", "name": "github", "url": "https://api.githubcopilot.com/mcp/"}],
      "tools": [{"type": "mcp_toolset", "mcp_server_name": "github"}]
    }'

  # Create the agent that delegates to it: research_agent_id is the ID from the first response
  curl --fail-with-body -sS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "lead",
      "model": "claude-opus-5-5",
      "tools": [{"type": "agent_toolset_20260401"}],
      "multiagent": {
        "type": "multiagent_20261001",
        "subagents": {
          "type": "enabled",
          "predefined_agents": [{"type": "agent", "id": "'"$research_agent_id"'"}]
        }
      }
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply lead.md researcher.md
    ```

    <File filename="lead.md">
      ```markdown
      ---
      name: lead
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
      multiagent:
        type: multiagent_20261001
        subagents:
          type: enabled
          predefined_agents: # ant apply replaces each path with {type: agent, id, version}
            - ./researcher.md
      ---
      ```
    </File>

    <File filename="researcher.md">
      ```markdown
      ---
      name: researcher
      model: claude-haiku-5-5
      mcp_servers:
        - type: url
          name: github
          url: https://api.githubcopilot.com/mcp/
      tools:
        - type: mcp_toolset
          mcp_server_name: github
      ---
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  research_agent = client.beta.agents.create(
      name="researcher",
      model="claude-haiku-5-5",
      mcp_servers=[
          {"type": "url", "name": "github", "url": "https://api.githubcopilot.com/mcp/"},
      ],
      tools=[{"type": "mcp_toolset", "mcp_server_name": "github"}],
  )

  lead_agent = client.beta.agents.create(
      name="lead",
      model="claude-opus-5-5",
      tools=[{"type": "agent_toolset_20260401"}],
      multiagent={
          "type": "multiagent_20261001",
          "subagents": {
              "type": "enabled",
              "predefined_agents": [{"type": "agent", "id": research_agent.id}],
          },
      },
  )
  ```

  ```typescript TypeScript
  const researchAgent = await client.beta.agents.create({
    name: "researcher",
    model: "claude-haiku-5-5",
    mcp_servers: [{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "github" }]
  });

  const leadAgent = await client.beta.agents.create({
    name: "lead",
    model: "claude-opus-5-5",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: {
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        predefined_agents: [{ type: "agent", id: researchAgent.id }]
      }
    }
  });
  ```

  ```csharp C#
  var researchAgent = await client.Beta.Agents.Create(new()
  {
      Name = "researcher",
      Model = BetaManagedAgentsModel.ClaudeHaiku5_5,
      McpServers =
      [
          new()
          {
              Name = "github",
              Url = "https://api.githubcopilot.com/mcp/",
          },
      ],
      Tools = [new BetaManagedAgentsMcpToolsetParams { McpServerName = "github" }],
  });

  var leadAgent = await client.Beta.Agents.Create(new()
  {
      Name = "lead",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
      Multiagent = new BetaManagedAgentsMultiagent20261001Params
      {
          Subagents = new BetaManagedAgentsMultiagentSubagentsEnabledParams
          {
              PredefinedAgents = [new BetaManagedAgentsAgentParams { ID = researchAgent.ID }],
          },
      },
  });
  ```

  ```go Go
  researcher, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name:  "researcher",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{ID: anthropic.BetaManagedAgentsModelClaudeHaiku5_5},
  	MCPServers: []anthropic.BetaManagedAgentsURLMCPServerParams{{
  		Name: "github",
  		URL:  "https://api.githubcopilot.com/mcp/",
  	}},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfMCPToolset: &anthropic.BetaManagedAgentsMCPToolsetParams{
  			MCPServerName: "github",
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }

  leadAgent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name:  "lead",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  	}},
  	Multiagent: anthropic.BetaManagedAgentsMultiagentParamsUnion{
  		OfMultiagent20261001: &anthropic.BetaManagedAgentsMultiagent20261001Params{
  			Subagents: anthropic.BetaManagedAgentsMultiagentSubagentsParamsUnion{
  				OfEnabled: &anthropic.BetaManagedAgentsMultiagentSubagentsEnabledParams{
  					PredefinedAgents: []anthropic.BetaManagedAgentsMultiagentPredefinedAgentParamsUnion{{
  						OfBetaManagedAgentsAgents: &anthropic.BetaManagedAgentsAgentParams{
  							ID: researcher.ID,
  						},
  					}},
  				},
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var researcher = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("researcher")
          .model(BetaManagedAgentsModel.CLAUDE_HAIKU_5_5)
          .addMcpServer(BetaManagedAgentsUrlMcpServerParams.builder()
              .name("github")
              .url("https://api.githubcopilot.com/mcp/")
              .build())
          .addTool(BetaManagedAgentsMcpToolsetParams.builder()
              .mcpServerName("github")
              .build())
          .build()
  );

  var leadAgent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("lead")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
          .multiagent(BetaManagedAgentsMultiagent20261001Params.builder()
              .subagents(BetaManagedAgentsMultiagentSubagentsEnabledParams.builder()
                  .addPredefinedAgent(BetaManagedAgentsAgentParams.builder()
                      .id(researcher.id())
                      .build())
                  .build())
              .build())
          .build()
  );
  ```

  ```php PHP
  $researchAgent = $client->beta->agents->create(
      name: 'researcher',
      model: 'claude-haiku-5-5',
      mcpServers: [
          ['type' => 'url', 'name' => 'github', 'url' => 'https://api.githubcopilot.com/mcp/'],
      ],
      tools: [
          ['type' => 'mcp_toolset', 'mcp_server_name' => 'github'],
      ],
  );

  $leadAgent = $client->beta->agents->create(
      name: 'lead',
      model: 'claude-opus-5-5',
      tools: [
          ['type' => 'agent_toolset_20260401'],
      ],
      multiagent: [
          'type' => 'multiagent_20261001',
          'subagents' => [
              'type' => 'enabled',
              'predefined_agents' => [
                  ['type' => 'agent', 'id' => $researchAgent->id],
              ],
          ],
      ],
  );
  ```

  ```ruby Ruby
  research_agent = client.beta.agents.create(
    name: "researcher",
    model: "claude-haiku-5-5",
    mcp_servers: [
      {type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/"}
    ],
    tools: [
      {type: "mcp_toolset", mcp_server_name: "github"}
    ]
  )

  lead_agent = client.beta.agents.create(
    name: "lead",
    model: "claude-opus-5-5",
    tools: [
      {type: "agent_toolset_20260401"}
    ],
    multiagent: {
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        predefined_agents: [
          {type: "agent", id: research_agent.id}
        ]
      }
    }
  )
  ```
</CodeGroup>

Then create the session with the vault that holds the GitHub credential:

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$lead_agent_id"'",
      "environment_id": "'"$environment_id"'",
      "vault_ids": ["'"$vault_id"'"]
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$lead_agent_id" \
    --environment-id "$environment_id" \
    --vault-id "$vault_id"
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=lead_agent.id,
      environment_id=environment.id,
      vault_ids=[vault.id],
  )
  print(session.id)
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: leadAgent.id,
    environment_id: environment.id,
    vault_ids: [vault.id]
  });
  console.log(session.id);
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = leadAgent.ID,
      EnvironmentID = environment.ID,
      VaultIds = [vault.ID],
  });
  Console.WriteLine(session.ID);
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent: anthropic.BetaSessionNewParamsAgentUnion{
  		OfString: anthropic.String(leadAgent.ID),
  	},
  	EnvironmentID: environment.ID,
  	VaultIDs:      []string{vault.ID},
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(session.ID)
  ```

  ```java Java
  var session = client.beta().sessions().create(SessionCreateParams.builder()
      .agent(leadAgent.id())
      .environmentId(environment.id())
      .vaultIds(List.of(vault.id()))
      .build());
  IO.println(session.id());
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $leadAgent->id,
      environmentID: $environment->id,
      vaultIDs: [$vault->id],
  );
  echo "{$session->id}\n";
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: lead_agent.id,
    environment_id: environment.id,
    vault_ids: [vault.id]
  )
  puts session.id
  ```
</CodeGroup>

In this example, only the researcher declares the GitHub MCP server, so the agent that the session runs does not have access. The session’s `vault_ids` (java: `vaultIds`; php: `vaultIDs`; csharp: `VaultIds`; go: `VaultIDs`) supply the GitHub credential to the researcher’s thread.

<Tip>
  If an agent’s MCP calls fail to authenticate after you declare the server, confirm the credential’s `mcp_server_url` (java: `mcpServerUrl`; php: `mcpServerURL`; csharp: `McpServerUrl`; go: `MCPServerURL`) refers to the same server as the agent’s `mcp_servers[].url` (java, php: `mcpServers[].url`; csharp: `McpServers[].Url`; go: `MCPServers[].URL`). Both URLs are normalized before matching (scheme and host lowercased, default ports and trailing slashes stripped), so differences in host casing, a default port, or a trailing slash don’t prevent a match; a different path, subdomain, or non-default port does.
</Tip>

### Threads

Each agent’s session thread has its own event stream. To list, interrupt, or archive threads, read their events, and handle tool permissions across them, see [Session threads](https://platform.claude.com/docs/en/managed-agents/session-threads).

## Dynamic workflows

With dynamic workflows, an agent can take on work with many pieces, such as reviewing hundreds of documents or cross-checking many sources. The agent writes a **workflow:** a program that runs many agents in phases and combines what they return. The server runs it in the background as a **workflow run**, while the agent keeps working or ends its turn. You turn dynamic workflows on or off with the `workflows` (csharp, go: `Workflows`) setting in the agent’s `multiagent` (csharp, go: `Multiagent`) block. A run’s agents can work at the same time, so a long task can complete sooner than if one agent did each piece in turn.

* **How a run starts:** You describe the work in a `user.message`. From that, the agent determines whether and when to start a run, so there’s no additional API call. Instead, you influence the agent’s determination by describing when to use a run in `user.message` or in the agent’s system prompt. (Permission policies apply to the tools that a run’s agents call, not to starting the run.)
* **Which agents it uses:** [Inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents) that the workflow defines, predefined agents that you list in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`), or both. If you list none, the workflow defines them all. An inline agent uses the model of the agent that the session runs. To let a run use another model for some of its agents, create them as agents and list them in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`).
* **How you follow it:** Run events arrive on the session’s event stream, and each agent in the run works in a [session thread](https://platform.claude.com/docs/en/managed-agents/session-threads) that you can list, read, and stream. See [Workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs) for the events, interrupts, [limits](https://platform.claude.com/docs/en/managed-agents/workflow-runs#limits), and [what a run’s threads show](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads).

### Turn on dynamic workflows

When [defining your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), set `multiagent.type` to `"multiagent_20261001"` and enable `workflows` (csharp, go: `Workflows`). Dynamic workflows and delegating (`subagents` (csharp, go: `Subagents`)) are both on by default with this type. For dynamic workflows only, also set `subagents` (csharp, go: `Subagents`) to `{"type": "disabled"}`.

Before you change an existing agent’s `multiagent.type`, see [how to move an agent to this type](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#move-from-the-coordinator-type).

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Contract Reviewer",
      "model": "claude-opus-5-5",
      "system": "You review contracts. When you are asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
      "tools": [{"type": "agent_toolset_20260401"}],
      "multiagent": {"type": "multiagent_20261001", "workflows": {"type": "enabled"}}
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply contract-reviewer.md
    ```

    <File filename="contract-reviewer.md">
      ```markdown
      ---
      name: Contract Reviewer
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
      multiagent:
        type: multiagent_20261001
        workflows:
          type: enabled
      ---

      You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Contract Reviewer",
      model="claude-opus-5-5",
      system="You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
      tools=[{"type": "agent_toolset_20260401"}],
      multiagent={"type": "multiagent_20261001", "workflows": {"type": "enabled"}},
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Contract Reviewer",
    model: "claude-opus-5-5",
    system:
      "You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: { type: "multiagent_20261001", workflows: { type: "enabled" } }
  });
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Contract Reviewer",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      System = "You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
      Tools = [new BetaManagedAgentsAgentToolset20260401Params()],
      Multiagent = new BetaManagedAgentsMultiagent20261001Params
      {
          Workflows = new BetaManagedAgentsMultiagentWorkflowsEnabledParams(),
      },
  });
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name:   "Contract Reviewer",
  	Model:  anthropic.BetaManagedAgentsModelConfigParams{ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5},
  	System: anthropic.String("You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run."),
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  	}},
  	Multiagent: anthropic.BetaManagedAgentsMultiagentParamsUnion{
  		OfMultiagent20261001: &anthropic.BetaManagedAgentsMultiagent20261001Params{
  			Workflows: anthropic.BetaManagedAgentsMultiagentWorkflowsParamsUnion{
  				OfEnabled: &anthropic.BetaManagedAgentsMultiagentWorkflowsEnabledParams{},
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var agent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("Contract Reviewer")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .system("You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.")
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
          .multiagent(BetaManagedAgentsMultiagent20261001Params.builder()
              .workflows(BetaManagedAgentsMultiagentWorkflowsEnabledParams.builder().build())
              .build())
          .build()
  );
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Contract Reviewer',
      model: BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
      system: "You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
      tools: [
          ['type' => 'agent_toolset_20260401'],
      ],
      multiagent: ['type' => 'multiagent_20261001', 'workflows' => ['type' => 'enabled']],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Contract Reviewer",
    model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
    system_: "You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.",
    tools: [
      {type: "agent_toolset_20260401"}
    ],
    multiagent: {type: "multiagent_20261001", workflows: {type: "enabled"}}
  )
  ```
</CodeGroup>

To let a workflow use agents you’ve already created, list them in `workflows.predefined_agents`. The `subagents` and `advisor` settings go in the same `multiagent` block. To list subagents, see [Delegate to subagents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#delegate-to-subagents). To set an advisor, see [Give the session an advisor](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor). This agent lets a workflow use one agent you created, lists two subagents, and has an advisor:

```json
{
  "multiagent": {
    "type": "multiagent_20261001",
    "workflows": {
      "type": "enabled",
      "predefined_agents": [{ "type": "agent", "id": "agent_01Lm4cV8yQ2tNs7XbKdR5h" }]
    },
    "subagents": {
      "type": "enabled",
      "predefined_agents": [
        { "type": "agent", "id": "agent_01J8XkN5uT3vHpLqRfWdY2" },
        { "type": "agent", "id": "agent_01HqR2k7vXbZ9mNpL3wYcT" }
      ]
    },
    "advisor": { "type": "enabled", "model": "claude-opus-5-5" }
  }
}
```

Each setting is enabled or disabled on its own:

| Setting     | What it turns on                                                                  | Agents go in                            | Default  |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| `workflows` | Dynamic workflows                                                                 | `workflows.predefined_agents`, up to 20 | Enabled  |
| `subagents` | Delegating to subagents: the agents you list, and agents the agent defines itself | `subagents.predefined_agents`, up to 20 | Enabled  |
| `advisor`   | An advisor model                                                                  | None. Set `model`.                      | Disabled |

For what goes in each list, and for how to allow only the agents that you list, see [Predefined and inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents).

Keep the following in mind:

* **Updating:** An update that keeps the `multiagent_20261001` type changes only what it sends:

  * A setting or field you leave out keeps its stored value.
  * A setting or field you send as `null` takes its default, and so does everything inside it, whatever you had stored.
  * A `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list you send replaces the stored list.
  * A setting you send with a different `type` replaces the stored setting, and the fields you leave out of it take their defaults.
  * Every object you send needs its `type`, and an enabled `advisor` (csharp, go: `Advisor`) needs its `model` (csharp, go: `Model`).

* **Turning it off:** Set `workflows` (csharp, go: `Workflows`) to `{"type": "disabled"}`. It stays off until an update turns it on again. Sending `null` turns it on, because its default is enabled. The same applies to `subagents` (csharp, go: `Subagents`).

* **Existing sessions:** A session copies the setting when it is created, so changing the agent later doesn’t change a session that already exists.

* **Agents you can list:** An agent that has `multiagent` (csharp, go: `Multiagent`) set can’t be listed as a subagent of another agent, or in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `workflows` (csharp, go: `Workflows`) in another agent. An agent can list itself in either list with `{"type": "self"}`, which reads back as its own `id` and `version`.

* **Tool names:** The `ant__` prefix is reserved. If your agent already has a custom tool whose name starts with `ant__`, an update fails with a 400 error until you send `tools` (csharp, go: `Tools`) without that name. A new session is refused with a 400 error too if its agent, or an agent in either list, has such a tool. Rename or remove the tool in the same update that turns dynamic workflows on. See [Custom tools](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools).

* **Budget:** Set a [session budget](https://platform.claude.com/docs/en/managed-agents/budgets) when you create the session to cap the session’s spend, runs included; you can’t add one to an existing session. Runs pause when the session reaches the budget, and runs that the budget paused resume when you raise or remove it, unless an interrupt also paused them. See [Cost and budgets](https://platform.claude.com/docs/en/managed-agents/workflow-runs#cost-and-budgets).

### Tell the agent when to use a run

Turning dynamic workflows on gives the agent the ability to start workflow runs. The agent determines when to start one. To guide that choice, add an instruction such as the following to the agent’s system prompt. The contract-review agent in [Turn on dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows) uses this system prompt:

```text wrap
You review contracts. When you're asked to review more than a few contracts, start a workflow run that reads them in parallel and combines the findings. Review one or two contracts yourself, without a run.
```

To adapt it, name the tasks in your agent’s domain that call for a run, and the small tasks the agent should do itself. You can also guide how a run does the work, as in these examples:

* **How to split the work:** “In a run, use one agent per contract. Then have a second agent review every contract, not only the ones where the first agent found something, and look for what the first agent missed. Anything that fails the review gets redone and reviewed again.”
* **What to do when an agent fails:** “One agent failing must not fail the run. If an agent fails to read a contract, list that contract as not covered. When the run ends, tell me which contracts weren’t covered.”
* **A time limit:** “Give the run a one-hour time limit.”
* **Plan first:** “Before you start a run, describe its phases and how many agents each one runs. Then wait for my go-ahead.” There’s no approval step before a run starts, so nothing enforces this.

Keep runs to the tasks that need them, because every agent in a run uses tokens.

Then [create a session](https://platform.claude.com/docs/en/managed-agents/sessions) with the agent, as you would with any agent, and describe the work in a `user.message`. You can also ask for a run in that message.

For a run’s events, interrupting a session with runs open, what changes while a run is open, and budgets and limits, see [Workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs).

## Give the session an advisor

An enabled `advisor` (csharp, go: `Advisor`) setting in the agent’s `multiagent` (csharp, go: `Multiagent`) block gives the session’s primary thread an **advisor:** a model it can consult mid-turn for strategic guidance, such as planning an approach, moving past an obstacle, or reviewing work before finishing. The setting is disabled by default. To enable it, set `advisor` (csharp, go: `Advisor`) to `{"type": "enabled", "model": "..."}`, which has exactly two fields, `type` and `model`:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Backend engineer",
      "model": "claude-sonnet-5",
      "system": "You implement backend features end to end. Consult the advisor before major backend design decisions.",
      "multiagent": {
        "type": "multiagent_20261001",
        "advisor": {"type": "enabled", "model": "claude-opus-5-5"}
      }
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply backend-engineer.md
    ```

    <File filename="backend-engineer.md">
      ```markdown
      ---
      name: Backend engineer
      model: claude-sonnet-5
      multiagent:
        type: multiagent_20261001
        advisor:
          type: enabled
          model: claude-opus-5-5
      ---

      You implement backend features end to end. Consult the advisor before major backend design decisions.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Backend engineer",
      model="claude-sonnet-5",
      system="You implement backend features end to end. Consult the advisor before major backend design decisions.",
      multiagent={
          "type": "multiagent_20261001",
          "advisor": {"type": "enabled", "model": "claude-opus-5-5"},
      },
  )
  print(agent.id)
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Backend engineer",
    model: "claude-sonnet-5",
    system:
      "You implement backend features end to end. Consult the advisor before major backend design decisions.",
    multiagent: {
      type: "multiagent_20261001",
      advisor: { type: "enabled", model: "claude-opus-5-5" }
    }
  });
  console.log(agent.id);
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Backend engineer",
      Model = BetaManagedAgentsModel.ClaudeSonnet5,
      System = "You implement backend features end to end. Consult the advisor before major backend design decisions.",
      Multiagent = new BetaManagedAgentsMultiagent20261001Params
      {
          Advisor = new BetaManagedAgentsMultiagentAdvisorEnabledParams { Model = "claude-opus-5-5" },
      },
  });
  Console.WriteLine(agent.ID);
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name:   "Backend engineer",
  	Model:  anthropic.BetaManagedAgentsModelConfigParams{ID: anthropic.BetaManagedAgentsModelClaudeSonnet5},
  	System: anthropic.String("You implement backend features end to end. Consult the advisor before major backend design decisions."),
  	Multiagent: anthropic.BetaManagedAgentsMultiagentParamsUnion{
  		OfMultiagent20261001: &anthropic.BetaManagedAgentsMultiagent20261001Params{
  			Advisor: anthropic.BetaManagedAgentsMultiagentAdvisorParamsUnion{
  				OfEnabled: &anthropic.BetaManagedAgentsMultiagentAdvisorEnabledParams{
  					Model: "claude-opus-5-5",
  				},
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(agent.ID)
  ```

  ```java Java
  var agent = client.beta().agents().create(
      AgentCreateParams.builder()
          .name("Backend engineer")
          .model(BetaManagedAgentsModel.CLAUDE_SONNET_5)
          .system("You implement backend features end to end. Consult the advisor before major backend design decisions.")
          .multiagent(BetaManagedAgentsMultiagent20261001Params.builder()
              .advisor(BetaManagedAgentsMultiagentAdvisorEnabledParams.builder()
                  .model("claude-opus-5-5")
                  .build())
              .build())
          .build()
  );
  IO.println(agent.id());
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Backend engineer',
      model: BetaManagedAgentsModel::CLAUDE_SONNET_5,
      system: 'You implement backend features end to end. Consult the advisor before major backend design decisions.',
      multiagent: [
          'type' => 'multiagent_20261001',
          'advisor' => ['type' => 'enabled', 'model' => 'claude-opus-5-5'],
      ],
  );
  echo $agent->id, PHP_EOL;
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Backend engineer",
    model: Anthropic::Beta::BetaManagedAgentsModel::CLAUDE_SONNET_5,
    system_: "You implement backend features end to end. Consult the advisor before major backend design decisions.",
    multiagent: {
      type: "multiagent_20261001",
      advisor: {type: "enabled", model: "claude-opus-5-5"}
    }
  )
  puts agent.id
  ```
</CodeGroup>

This example sets only `advisor` (csharp, go: `Advisor`). The other two settings, `subagents` (csharp, go: `Subagents`) and `workflows` (csharp, go: `Workflows`), keep their defaults, so both are enabled, and the agent can also delegate to inline agents and start workflow runs. For an agent that consults an advisor and does all the work itself, set both to `{"type": "disabled"}`.

You can’t list the advisor in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) or `workflows` (csharp, go: `Workflows`). An enabled `advisor` (csharp, go: `Advisor`) reserves the name `anthropic.advisor`. While it is enabled, neither list can hold an agent literally named `anthropic.advisor`: the request is rejected with a 400 validation error.

The advisor model must meet a minimum capability level, and the agent’s own model must not be more capable than its advisor; models of equal capability can pair. An invalid pairing is rejected with a 400 validation error when the agent is saved, and again when a session is created. The pairing is also checked when each consultation starts: if it’s no longer valid, that consultation fails and the session continues. Valid pairings follow the advisor tool’s [model compatibility](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#model-compatibility) table.

The advisor is also available as a [server tool on the Messages API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool). The Managed Agents surface differs in configuration and delivery: the `advisor` (csharp, go: `Advisor`) setting has no `max_uses`, `max_tokens`, or `caching` fields, and advice arrives through thread events rather than `advisor_tool_result` blocks.

### How consultations work

Each consultation runs as a platform-spawned thread named `anthropic.advisor` that terminates itself when the consultation completes, and the advice is delivered to the primary thread as an `agent.thread_message_received` event. A consultation emits the standard thread events, identified by the reserved name `anthropic.advisor` (the thread lifecycle events carry it as `agent_name` (java, php: `agentName`; csharp, go: `AgentName`), and the advice delivery carries it as `from_agent_name` (java, php: `fromAgentName`; csharp, go: `FromAgentName`)), typically in this order:

1. `session.thread_created`
2. `session.thread_status_running`
3. `agent.thread_message_received` (the advice)
4. `session.thread_status_idle` (`stop_reason: end_turn`)
5. `session.thread_status_terminated`

No `agent.tool_use` events are emitted for a consultation, and no `agent.thread_message_sent` event appears on the session’s event stream, because the consultation input is composed by the platform rather than sent by the agent. If you list the advisor thread’s own events, the advice also appears there as an `agent.thread_message_sent` event. The advice delivery (event 3) is not guaranteed to arrive before the advisor thread’s idle and terminated events, so don’t treat those as a signal that the advice has already been delivered.

Whether your client can read the advice is the advisor model’s policy. It mirrors the [result variants](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#result-variants) split on the Messages API advisor tool. An advisor model that returns plaintext results there delivers readable text here. One that returns redacted results delivers a `[{"type": "redacted"}]` placeholder on every client surface, while the agent still reads the full advice server-side. The preceding example uses the newest Opus model available to you as the advisor. It returns redacted results, so your client sees only the placeholder. To read the advice on the event stream, use an advisor that returns plaintext, such as Claude Opus 4.8. A model’s policy can change with no change to the API, so handle both `text` and `redacted` blocks. Some agent models pair only with redacted-result advisors; see the advisor tool’s [Model compatibility](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#model-compatibility) section. Advisor thinking is never surfaced. Clients cannot send `redacted` blocks themselves; an event containing one is rejected with a 400 validation error.

A failed or interrupted consultation never fails the agent’s turn: the agent continues after a generic notice that the consultation failed. A session-level `user.interrupt` during a consultation terminates the advisor thread with no advice delivered; a `user.interrupt` with the advisor thread’s `session_thread_id` (java: `sessionThreadId`; php: `sessionThreadID`; csharp, go: `SessionThreadID`) abandons only that consultation.

### Advisor threads

The advisor is not a subagent. The agent’s `list_agents` tool doesn’t show it, and `send_to_agent`, which sends a subagent a follow-up message, can’t reach it. Only the session’s primary thread can consult it; subagents can’t.

Advisor threads are exempt from the 25-child-thread limit. They appear in the session’s [thread list](https://platform.claude.com/docs/en/managed-agents/session-threads). Their `agent` is the advisor form, `{"type": "advisor", "model": ...}`, with the model you configured, and their `parent_thread_id` is the primary thread.

Prompt caching on the advisor’s side is automatic; there is nothing to configure. Consultations are billed at the advisor model’s rates, and their tokens appear in the advisor thread’s usage and in the session’s usage totals. They also count against a [session budget](https://platform.claude.com/docs/en/managed-agents/budgets), at the advisor model’s list price. Each consultation sends the advisor the primary thread’s conversation so far, so consultations late in a long session use more input tokens.

### Removing the advisor

To remove the advisor, [update the agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-an-agent) with `advisor` (csharp, go: `Advisor`) set to `{"type": "disabled"}`. On an agent that already has the `multiagent_20261001` type, a setting that the update leaves out keeps its stored value, so you don’t need to send `subagents` (csharp, go: `Subagents`) or `workflows` (csharp, go: `Workflows`) again. For the same reason, an update that leaves `advisor` (csharp, go: `Advisor`) out keeps the advisor. Before you change an existing agent’s `multiagent.type`, see [how to move an agent to this type](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#move-from-the-coordinator-type).

## Move from the `coordinator` type

Like `multiagent_20261001`, the `coordinator` type lets an agent delegate to subagents that you list and consult an advisor model. With the `coordinator` type, the agent can’t start workflow runs or define subagents itself. The API accepts both types.

To move an agent to `multiagent_20261001`, [update the agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-an-agent) with a `multiagent` block of that type:

1. Set `type` to `"multiagent_20261001"`.
2. List the agents that the agent can call in `subagents.predefined_agents`. The entries keep the form that they have now.
3. If the agent has an advisor, set `advisor` to `{"type": "enabled", "model": "..."}` with the advisor’s model.
4. Send the whole block in one update.

For example, this block gives an agent two subagents and an advisor:

```json
{
  "multiagent": {
    "type": "multiagent_20261001",
    "subagents": {
      "type": "enabled",
      "predefined_agents": [
        { "type": "agent", "id": "agent_01J8XkN5uT3vHpLqRfWdY2" },
        { "type": "agent", "id": "agent_01HqR2k7vXbZ9mNpL3wYcT" }
      ]
    },
    "advisor": { "type": "enabled", "model": "claude-opus-5-5" }
  }
}
```

That block leaves out `workflows` and `subagents.inline_agents`, so both take their default and are enabled. The moved agent can also start workflow runs and define subagents itself. To keep either one off, set it to `{"type": "disabled"}` in the same update. See [Turn on dynamic workflows](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows) and [Predefined and inline agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents).

If the agent has an advisor and no subagents, set `subagents` to `{"type": "disabled"}` to keep delegation off. A request that disables `subagents.inline_agents` and lists no agents fails with a 400 error.

The update replaces the whole `multiagent` block, so send the list of agents and the advisor again, as the example does. What you leave out takes its default:

* **`subagents.predefined_agents`:** The list is empty, so the agent loses the subagents that you listed.
* **`advisor`:** The advisor is disabled.

Once the agent has the `multiagent_20261001` type, a setting that a later update leaves out keeps its stored value.

The update doesn’t change sessions that already exist. To use the new block, create a session after the update.

## Availability

Multiagent orchestration is in beta on every model.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

| Status | Cloud platforms         |
| ------ | ----------------------- |
| Beta   | All supported platforms |

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
