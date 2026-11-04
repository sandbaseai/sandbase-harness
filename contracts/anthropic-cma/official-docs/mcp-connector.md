---
title: MCP connector
url: https://platform.claude.com/docs/en/managed-agents/mcp-connector
description: Connect MCP servers to your agents for access to external tools and data sources.
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

Claude Managed Agents supports connecting [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers to your agents. This gives the agent access to external tools, data sources, and services through a standardized protocol.

MCP configuration is split across two steps:

1. **Agent creation** declares which MCP servers the agent connects to, by name and URL.
2. **Session creation** supplies authentication for those servers by referencing a pre-registered vault (see [Authenticate with vaults](https://platform.claude.com/docs/en/managed-agents/vaults)).

This separation keeps secrets out of reusable agent definitions while letting each session authenticate with its own credentials.

## Declare MCP servers on the agent

Specify MCP servers in the `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) array when creating an agent. Each server has a `type` (csharp, go: `Type`) of `url`, a unique `name` (csharp, go: `Name`), and a `url` (csharp: `Url`; go: `URL`). No authentication tokens are provided at this stage.

Each declared server also needs a matching `mcp_toolset` entry in the `tools` (csharp, go: `Tools`) array. The toolset’s `mcp_server_name` (java, php: `mcpServerName`; csharp: `McpServerName`; go: `MCPServerName`) must match the server’s `name` (csharp, go: `Name`).

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -sS --fail-with-body https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "GitHub Assistant",
      "model": "claude-opus-5-5",
      "mcp_servers": [
        {
          "type": "url",
          "name": "github",
          "url": "https://api.githubcopilot.com/mcp/"
        }
      ],
      "tools": [
        {"type": "agent_toolset_20260401"},
        {"type": "mcp_toolset", "mcp_server_name": "github"}
      ]
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply github-assistant.md
    ```

    <File filename="github-assistant.md">
      ```markdown
      ---
      name: GitHub Assistant
      model: claude-opus-5-5
      mcp_servers:
        - type: url
          name: github
          url: https://api.githubcopilot.com/mcp/
      tools:
        - type: agent_toolset_20260401
        - type: mcp_toolset
          mcp_server_name: github
      ---
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="GitHub Assistant",
      model="claude-opus-5-5",
      mcp_servers=[
          {
              "type": "url",
              "name": "github",
              "url": "https://api.githubcopilot.com/mcp/",
          },
      ],
      tools=[
          {"type": "agent_toolset_20260401"},
          {"type": "mcp_toolset", "mcp_server_name": "github"},
      ],
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "GitHub Assistant",
    model: "claude-opus-5-5",
    mcp_servers: [
      {
        type: "url",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/"
      }
    ],
    tools: [
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "github" }
    ]
  });
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "GitHub Assistant",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      McpServers =
      [
          new() { Name = "github", Url = "https://api.githubcopilot.com/mcp/" },
      ],
      Tools =
      [
          new BetaManagedAgentsAgentToolset20260401Params(),
          new BetaManagedAgentsMcpToolsetParams { McpServerName = "github" },
      ],
  });
  ```

  ```go Go
  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "GitHub Assistant",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	MCPServers: []anthropic.BetaManagedAgentsURLMCPServerParams{{
  		Name: "github",
  		URL:  "https://api.githubcopilot.com/mcp/",
  	}},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{
  		{
  			OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  		},
  		{
  			OfMCPToolset: &anthropic.BetaManagedAgentsMCPToolsetParams{
  				MCPServerName: "github",
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
          .name("GitHub Assistant")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .addMcpServer(
              BetaManagedAgentsUrlMcpServerParams.builder()
                  .name("github")
                  .url("https://api.githubcopilot.com/mcp/")
                  .build()
          )
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
          .addTool(
              BetaManagedAgentsMcpToolsetParams.builder()
                  .mcpServerName("github")
                  .build()
          )
          .build()
  );
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'GitHub Assistant',
      model: BetaManagedAgentsModel::CLAUDE_OPUS_5_5,
      mcpServers: [
          BetaManagedAgentsURLMCPServerParams::with(
              name: 'github',
              url: 'https://api.githubcopilot.com/mcp/',
          ),
      ],
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(),
          BetaManagedAgentsMCPToolsetParams::with(
              mcpServerName: 'github',
          ),
      ],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "GitHub Assistant",
    model: "claude-opus-5-5",
    mcp_servers: [
      {
        type: "url",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/"
      }
    ],
    tools: [
      {type: "agent_toolset_20260401"},
      {type: "mcp_toolset", mcp_server_name: "github"}
    ]
  )
  ```
</CodeGroup>

<Tip>
  The MCP toolset defaults to a permission policy of `always_ask`, which requires user approval before each tool call. See [Permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies) to configure this behavior.
</Tip>

### `mcp_servers` field reference

Each entry in the `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) array defines one connection.

| Field                            | Description                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type` (csharp, go: `Type`)      | Required. Must be `"url"`.                                                                                                                                                                                                                                                                                                                                               |
| `name` (csharp, go: `Name`)      | Required. A unique name for this server within the agent (1–255 characters). Used as the `mcp_server_name` (java, php: `mcpServerName`; csharp: `McpServerName`; go: `MCPServerName`) in the `tools` (csharp, go: `Tools`) array and surfaced on MCP tool events in the [session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming). |
| `url` (csharp: `Url`; go: `URL`) | Required. The endpoint of the remote MCP server (up to 2,048 characters). See [Supported MCP server types](https://platform.claude.com/docs/en/managed-agents/reference#supported-mcp-server-types) for transport requirements.                                                                                                                                          |

Constraints:

* An agent can declare up to 20 MCP servers. Server names must be unique within the array.
* Every `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) entry must be referenced by an `mcp_toolset` in the `tools` (csharp, go: `Tools`) array, and every `mcp_toolset` must reference a declared server. The API rejects agent definitions with unreferenced servers or dangling toolsets.

## Configure which MCP tools are available

The `mcp_toolset` entry supports a `default_config` (java, php: `defaultConfig`; csharp, go: `DefaultConfig`) object and a `configs` (csharp, go: `Configs`) array, applied to the tools the MCP server exposes. Each `configs` (csharp, go: `Configs`) entry accepts only `name` (csharp, go: `Name`), `enabled` (csharp, go: `Enabled`), and `permission_policy` (java, php: `permissionPolicy`; csharp, go: `PermissionPolicy`). Unlike entries in the built-in agent toolset, MCP tool entries do not take a `type` (csharp, go: `Type`) field, and the [web settings](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#settings) available on `web_search` and `web_fetch` do not apply to MCP tools. The `name` (csharp, go: `Name`) in each `configs` (csharp, go: `Configs`) entry is the bare tool name as reported by the server.

By default all tools exposed by the MCP server are enabled. To enable only specific tools, set `default_config.enabled` to `false` and explicitly enable the tools you want:

```json
{
  "type": "mcp_toolset",
  "mcp_server_name": "github",
  "default_config": { "enabled": false },
  "configs": [
    { "name": "get_issue", "enabled": true },
    { "name": "list_issues", "enabled": true },
    { "name": "add_issue_comment", "enabled": true }
  ]
}
```

This pattern is useful when a server exposes many tools but the agent only needs a few, or when you want tools added by the server operator to stay off until you review them.

To disable specific tools while keeping the rest enabled, omit `default_config` and set `enabled: false` on individual entries:

```json
{
  "type": "mcp_toolset",
  "mcp_server_name": "github",
  "configs": [{ "name": "delete_repository", "enabled": false }]
}
```

See [configuring the toolset](https://platform.claude.com/docs/en/managed-agents/tools#configuring-the-toolset) for the general `default_config` (java, php: `defaultConfig`; csharp, go: `DefaultConfig`) / `configs` (csharp, go: `Configs`) pattern, and [MCP toolset permissions](https://platform.claude.com/docs/en/managed-agents/permission-policies#mcp-toolset-permissions) for setting `permission_policy` (java, php: `permissionPolicy`; csharp, go: `PermissionPolicy`) on MCP tools and handling confirmation requests.

### MCP tool output handling

When an MCP tool output exceeds 100,000 characters (about 25,000 tokens), it is automatically written to a file in the sandbox. The model receives a truncated preview with the file path and can read the full content from there.

## Provide authentication at session creation

When starting a session, pass `vault_ids` (java: `vaultIds`; php: `vaultIDs`; csharp: `VaultIds`; go: `VaultIDs`) to provide credentials for your MCP servers. Vaults are collections of credentials that you register once and reference by ID. See [Authenticate with vaults](https://platform.claude.com/docs/en/managed-agents/vaults) for how to create vaults and manage credentials.

With a `limited` [environment](https://platform.claude.com/docs/en/managed-agents/environments#networking), session creation fails with a 400 error when the agent declares an MCP server whose host is not in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Setting `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) to `true` in the environment’s networking turns this check off.

<CodeGroup>
  ```bash cURL
  curl -sS --fail-with-body https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$agent_id"'",
      "environment_id": "'"$environment_id"'",
      "vault_ids": ["'"$vault_id"'"]
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$AGENT_ID" \
    --environment-id "$ENVIRONMENT_ID" \
    --vault-id "$VAULT_ID"
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=agent.id,
      environment_id=environment.id,
      vault_ids=[vault.id],
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    vault_ids: [vault.id]
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = agent.ID,
      EnvironmentID = environment.ID,
      VaultIds = [vault.ID],
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent:         anthropic.BetaSessionNewParamsAgentUnion{OfString: anthropic.String(agent.ID)},
  	EnvironmentID: environment.ID,
  	VaultIDs:      []string{vault.ID},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var session = client.beta().sessions().create(
      SessionCreateParams.builder()
          .agent(agent.id())
          .environmentId(environment.id())
          .addVaultId(vault.id())
          .build()
  );
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $agent->id,
      environmentID: $environment->id,
      vaultIDs: [$vault->id],
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: agent.id,
    environment_id: environment.id,
    vault_ids: [vault.id]
  )
  ```
</CodeGroup>

Credentials are matched by URL, so the vault must contain a credential whose `mcp_server_url` (java: `mcpServerUrl`; php: `mcpServerURL`; csharp: `McpServerUrl`; go: `MCPServerURL`) refers to the same server as the `url` (csharp: `Url`; go: `URL`) declared in `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`). Both URLs are normalized before matching (scheme and host lowercased, default ports and trailing slashes stripped), so differences in host casing, a default port, or a trailing slash don’t prevent a match; a different path, subdomain, or non-default port does. If none matches, the connection is attempted unauthenticated. See [Add a credential](https://platform.claude.com/docs/en/managed-agents/vaults#add-a-credential) for the `static_bearer` and `mcp_oauth` credential types.

### Handle connection and authentication failures

Session creation does not validate MCP connectivity or credentials. It does check each declared server’s host against the environment’s networking: with a `limited` environment, session creation fails with a 400 error when a host is not allowed, as described under [Provide authentication at session creation](https://platform.claude.com/docs/en/managed-agents/mcp-connector#provide-authentication-at-session-creation). If an MCP server is unreachable or rejects the supplied credential, the session still starts and interaction remains possible. A [`session.error`](https://platform.claude.com/docs/en/managed-agents/reference#event-types) event is emitted with the `mcp_server_name` (java, php: `mcpServerName`; csharp: `McpServerName`; go: `MCPServerName`) of the affected server and a `retry_status` (java, php: `retryStatus`; csharp, go: `RetryStatus`):

| Error type                        | Meaning                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_connection_failed_error`     | The MCP server could not be reached (network error, timeout, or non-authentication HTTP failure).                                                                                                                       |
| `mcp_authentication_failed_error` | Authentication with the MCP server failed: the server rejected the credential from the attached vault, the server required authentication when no matching credential was configured, or an OAuth token refresh failed. |

You can decide whether to block further interaction on this error, trigger a credential rotation, or let the session continue without the affected server’s tools. The connection is retried on the next `session.status_idle` to `session.status_running` transition.

## Next steps

<CardGroup cols={2}>
  <Card title="Permission policies" icon="check" href="https://platform.claude.com/docs/en/managed-agents/permission-policies">
    Control when agent and MCP tools run.
  </Card>

  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Send events, stream responses, and interrupt or redirect your session while it runs.
  </Card>

  <Card title="Supported MCP server types" icon="book" href="https://platform.claude.com/docs/en/managed-agents/reference#supported-mcp-server-types">
    Transport requirements for remote MCP servers.
  </Card>
</CardGroup>
