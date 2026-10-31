---
title: Accessing GitHub
url: https://platform.claude.com/docs/en/managed-agents/github
description: Connect your agent to GitHub repositories for cloning, reading, and creating pull requests.
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

You can mount a GitHub repository to your session sandbox and connect to the GitHub MCP for making pull requests.

GitHub repositories are cached, so future sessions that use the same repository start faster.

## GitHub MCP and session resources

First, create an agent that declares the GitHub MCP server. The agent definition holds the server URL but no authentication token:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Code Reviewer",
      "model": "claude-opus-5-5",
      "system": "You are a code review assistant with access to GitHub.",
      "mcp_servers": [
        {
          "type": "url",
          "name": "github",
          "url": "https://api.githubcopilot.com/mcp/"
        }
      ],
      "tools": [
        {"type": "agent_toolset_20260401"},
        {
          "type": "mcp_toolset",
          "mcp_server_name": "github"
        }
      ]
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
      mcp_servers:
        - type: url
          name: github
          url: https://api.githubcopilot.com/mcp/
      tools:
        - type: agent_toolset_20260401
        - type: mcp_toolset
          mcp_server_name: github
      ---

      You are a code review assistant with access to GitHub.
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  agent = client.beta.agents.create(
      name="Code Reviewer",
      model="claude-opus-5-5",
      system="You are a code review assistant with access to GitHub.",
      mcp_servers=[
          {
              "type": "url",
              "name": "github",
              "url": "https://api.githubcopilot.com/mcp/",
          },
      ],
      tools=[
          {"type": "agent_toolset_20260401"},
          {
              "type": "mcp_toolset",
              "mcp_server_name": "github",
          },
      ],
  )
  ```

  ```typescript TypeScript
  const agent = await client.beta.agents.create({
    name: "Code Reviewer",
    model: "claude-opus-5-5",
    system: "You are a code review assistant with access to GitHub.",
    mcp_servers: [
      {
        type: "url",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/"
      }
    ],
    tools: [
      { type: "agent_toolset_20260401" },
      {
        type: "mcp_toolset",
        mcp_server_name: "github"
      }
    ]
  });
  ```

  ```csharp C#
  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Code Reviewer",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      System = "You are a code review assistant with access to GitHub.",
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
  	Name: "Code Reviewer",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	System: anthropic.String("You are a code review assistant with access to GitHub."),
  	MCPServers: []anthropic.BetaManagedAgentsURLMCPServerParams{
  		{
  			Name: "github",
  			URL:  "https://api.githubcopilot.com/mcp/",
  		},
  	},
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
  var agent = client.beta().agents().create(AgentCreateParams.builder()
      .name("Code Reviewer")
      .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
      .system("You are a code review assistant with access to GitHub.")
      .addMcpServer(BetaManagedAgentsUrlMcpServerParams.builder()
          .name("github")
          .url("https://api.githubcopilot.com/mcp/")
          .build())
      .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
      .addTool(BetaManagedAgentsMcpToolsetParams.builder()
          .mcpServerName("github")
          .build())
      .build());
  ```

  ```php PHP
  $agent = $client->beta->agents->create(
      name: 'Code Reviewer',
      model: 'claude-opus-5-5',
      system: 'You are a code review assistant with access to GitHub.',
      mcpServers: [
          [
              'type' => 'url',
              'name' => 'github',
              'url' => 'https://api.githubcopilot.com/mcp/',
          ],
      ],
      tools: [
          ['type' => 'agent_toolset_20260401'],
          [
              'type' => 'mcp_toolset',
              'mcpServerName' => 'github',
          ],
      ],
  );
  ```

  ```ruby Ruby
  agent = client.beta.agents.create(
    name: "Code Reviewer",
    model: "claude-opus-5-5",
    system_: "You are a code review assistant with access to GitHub.",
    mcp_servers: [
      {
        type: "url",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/"
      }
    ],
    tools: [
      {type: "agent_toolset_20260401"},
      {
        type: "mcp_toolset",
        mcp_server_name: "github"
      }
    ]
  )
  ```
</CodeGroup>

Then create a session that mounts the GitHub repository. With a `limited` [environment](https://platform.claude.com/docs/en/managed-agents/environments#networking), session creation fails with a 400 error when the agent declares an MCP server whose host is not in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Setting `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) to `true` in the environment’s networking turns this check off.

<CodeGroup>
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d @- <<JSON
  {
    "agent": "$agent_id",
    "environment_id": "$environment_id",
    "resources": [
      {
        "type": "github_repository",
        "url": "https://github.com/org/repo",
        "mount_path": "/workspace/repo",
        "authorization_token": "ghp_your_github_token"
      }
    ]
  }
  JSON
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$AGENT_ID" \
    --environment-id "$ENVIRONMENT_ID" <<'EOF'
  resources:
    - type: github_repository
      url: https://github.com/org/repo
      mount_path: /workspace/repo
      authorization_token: ghp_your_github_token
  EOF
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=agent.id,
      environment_id=environment.id,
      resources=[
          {
              "type": "github_repository",
              "url": "https://github.com/org/repo",
              "mount_path": "/workspace/repo",
              "authorization_token": "ghp_your_github_token",
          },
      ],
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    resources: [
      {
        type: "github_repository",
        url: "https://github.com/org/repo",
        mount_path: "/workspace/repo",
        authorization_token: "ghp_your_github_token"
      }
    ]
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = agent.ID,
      EnvironmentID = environment.ID,
      Resources =
      [
          new BetaManagedAgentsGitHubRepositoryResourceParams
          {
              Url = "https://github.com/org/repo",
              MountPath = "/workspace/repo",
              AuthorizationToken = "ghp_your_github_token",
          },
      ],
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent:         anthropic.BetaSessionNewParamsAgentUnion{OfString: anthropic.String(agent.ID)},
  	EnvironmentID: environment.ID,
  	Resources: []anthropic.BetaSessionNewParamsResourceUnion{
  		{
  			OfGitHubRepository: &anthropic.BetaManagedAgentsGitHubRepositoryResourceParams{
  				URL:                "https://github.com/org/repo",
  				MountPath:          anthropic.String("/workspace/repo"),
  				AuthorizationToken: "ghp_your_github_token",
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var session = client.beta().sessions().create(SessionCreateParams.builder()
      .agent(agent.id())
      .environmentId(environment.id())
      .addResource(BetaManagedAgentsGitHubRepositoryResourceParams.builder()
          .url("https://github.com/org/repo")
          .mountPath("/workspace/repo")
          .authorizationToken("ghp_your_github_token")
          .build())
      .build());
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $agent->id,
      environmentID: $environment->id,
      resources: [
          [
              'type' => 'github_repository',
              'url' => 'https://github.com/org/repo',
              'mountPath' => '/workspace/repo',
              'authorizationToken' => 'ghp_your_github_token',
          ],
      ],
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: agent.id,
    environment_id: environment.id,
    resources: [
      {
        type: "github_repository",
        url: "https://github.com/org/repo",
        mount_path: "/workspace/repo",
        authorization_token: "ghp_your_github_token"
      }
    ]
  )
  ```
</CodeGroup>

A `github_repository` resource accepts the following fields:

| Field                                                                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` (csharp, go: `Type`)                                                               | Required. Must be `"github_repository"`.                                                                                                                                                                                                                                                                                                                                                                        |
| `url` (csharp: `Url`; go: `URL`)                                                          | Required. The repository’s HTTPS URL in the form `https://github.com/<owner>/<repo>`, without a `.git` suffix. Other forms, including SSH URLs, are rejected with an `invalid_request_error`.                                                                                                                                                                                                                   |
| `authorization_token` (java, php: `authorizationToken`; csharp, go: `AuthorizationToken`) | Optional. The GitHub token used to clone the repository and to push to it. Without a token, a private repository fails to clone after the session is created. A public repository clones without a token, and the agent can commit in its clone, but `git push` fails. It is not echoed in API responses. See [Token permissions](https://platform.claude.com/docs/en/managed-agents/github#token-permissions). |
| `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`)                            | Optional. The directory under `/workspace` to clone the repository into. Defaults to `/workspace/<repo-name>`.                                                                                                                                                                                                                                                                                                  |
| `checkout` (csharp, go: `Checkout`)                                                       | Optional. A branch (`{"type": "branch", "name": "main"}`) or commit (`{"type": "commit", "sha": "..."}`) to check out. Defaults to the repository’s default branch.                                                                                                                                                                                                                                             |

Mounting a repository also loads any skills stored in its root `.claude/skills` directory. Skills are discovered once for each session, from the repository state checked out at session start. See [Load skills from a GitHub repository](https://platform.claude.com/docs/en/managed-agents/skills#load-skills-from-a-github-repository).

## Token permissions

When providing a GitHub token, use the minimum required permissions:

| Action              | Required scopes                   |
| ------------------- | --------------------------------- |
| Clone private repos | `repo`                            |
| Create PRs          | `repo`                            |
| Read issues         | `repo` (private) or `public_repo` |
| Create issues       | `repo` (private) or `public_repo` |

<Warning>
  Use fine-grained personal access tokens with minimum required permissions. Avoid using tokens with broad access to your GitHub account.
</Warning>

## Multiple repositories

Mount multiple repositories by adding entries to the `resources` (csharp, go: `Resources`) array:

<CodeGroup>
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d @- <<JSON
  {
    "agent": "$agent_id",
    "environment_id": "$environment_id",
    "resources": [
      {
        "type": "github_repository",
        "url": "https://github.com/org/frontend",
        "mount_path": "/workspace/frontend",
        "authorization_token": "ghp_your_github_token"
      },
      {
        "type": "github_repository",
        "url": "https://github.com/org/backend",
        "mount_path": "/workspace/backend",
        "authorization_token": "ghp_your_github_token"
      }
    ]
  }
  JSON
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$AGENT_ID" \
    --environment-id "$ENVIRONMENT_ID" <<'EOF'
  resources:
    - type: github_repository
      url: https://github.com/org/frontend
      mount_path: /workspace/frontend
      authorization_token: ghp_your_github_token
    - type: github_repository
      url: https://github.com/org/backend
      mount_path: /workspace/backend
      authorization_token: ghp_your_github_token
  EOF
  ```

  ```python Python
  resources = [
      {
          "type": "github_repository",
          "url": "https://github.com/org/frontend",
          "mount_path": "/workspace/frontend",
          "authorization_token": "ghp_your_github_token",
      },
      {
          "type": "github_repository",
          "url": "https://github.com/org/backend",
          "mount_path": "/workspace/backend",
          "authorization_token": "ghp_your_github_token",
      },
  ]
  ```

  ```typescript TypeScript
  const resources = [
    {
      type: "github_repository",
      url: "https://github.com/org/frontend",
      mount_path: "/workspace/frontend",
      authorization_token: "ghp_your_github_token"
    },
    {
      type: "github_repository",
      url: "https://github.com/org/backend",
      mount_path: "/workspace/backend",
      authorization_token: "ghp_your_github_token"
    }
  ];
  ```

  ```csharp C#
  BetaManagedAgentsGitHubRepositoryResourceParams[] resources =
  [
      new()
      {
          Url = "https://github.com/org/frontend",
          MountPath = "/workspace/frontend",
          AuthorizationToken = "ghp_your_github_token",
      },
      new()
      {
          Url = "https://github.com/org/backend",
          MountPath = "/workspace/backend",
          AuthorizationToken = "ghp_your_github_token",
      },
  ];
  ```

  ```go Go
  resources := []anthropic.BetaSessionNewParamsResourceUnion{
  	{
  		OfGitHubRepository: &anthropic.BetaManagedAgentsGitHubRepositoryResourceParams{
  			URL:                "https://github.com/org/frontend",
  			MountPath:          anthropic.String("/workspace/frontend"),
  			AuthorizationToken: "ghp_your_github_token",
  		},
  	},
  	{
  		OfGitHubRepository: &anthropic.BetaManagedAgentsGitHubRepositoryResourceParams{
  			URL:                "https://github.com/org/backend",
  			MountPath:          anthropic.String("/workspace/backend"),
  			AuthorizationToken: "ghp_your_github_token",
  		},
  	},
  }
  ```

  ```java Java
  var resources = List.of(
      BetaManagedAgentsGitHubRepositoryResourceParams.builder()
          .url("https://github.com/org/frontend")
          .mountPath("/workspace/frontend")
          .authorizationToken("ghp_your_github_token")
          .build(),
      BetaManagedAgentsGitHubRepositoryResourceParams.builder()
          .url("https://github.com/org/backend")
          .mountPath("/workspace/backend")
          .authorizationToken("ghp_your_github_token")
          .build());
  ```

  ```php PHP
  $resources = [
      [
          'type' => 'github_repository',
          'url' => 'https://github.com/org/frontend',
          'mountPath' => '/workspace/frontend',
          'authorizationToken' => 'ghp_your_github_token',
      ],
      [
          'type' => 'github_repository',
          'url' => 'https://github.com/org/backend',
          'mountPath' => '/workspace/backend',
          'authorizationToken' => 'ghp_your_github_token',
      ],
  ];
  ```

  ```ruby Ruby
  resources = [
    {
      type: "github_repository",
      url: "https://github.com/org/frontend",
      mount_path: "/workspace/frontend",
      authorization_token: "ghp_your_github_token"
    },
    {
      type: "github_repository",
      url: "https://github.com/org/backend",
      mount_path: "/workspace/backend",
      authorization_token: "ghp_your_github_token"
    }
  ]
  ```
</CodeGroup>

## Managing repositories on a running session

After a session is created, you can list its repository resources and rotate their authorization tokens. Each resource has an `id` (csharp, go: `ID`) returned at session creation time (or through `GET /v1/sessions/{session_id}/resources` (python, typescript, ruby: `client.beta.sessions.resources.list()`; go, csharp: `client.Beta.Sessions.Resources.List()`; java: `client.beta().sessions().resources().list()`; php: `$client->beta->sessions->resources->list()`; cli: `ant beta:sessions:resources list`)) that you use for updates. Repositories are attached for the lifetime of the session; to change which repositories are mounted, create a new session.

<CodeGroup>
  ```bash cURL
  # List resources on the session
  curl -fsS "https://api.anthropic.com/v1/sessions/$session_id/resources" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json"

  # Rotate the authorization token
  curl -fsS \
    "https://api.anthropic.com/v1/sessions/$session_id/resources/$repo_resource_id" \
  # ...
    -d @- <<'JSON'
  {
    "authorization_token": "ghp_your_new_github_token"
  }
  JSON
  ```

  ```bash CLI
  # List resources on the session
  ant beta:sessions:resources list --session-id "$SESSION_ID"

  # Rotate the authorization token on a specific resource
  ant beta:sessions:resources update \
    --session-id "$SESSION_ID" \
    --resource-id "$RESOURCE_ID" \
    --authorization-token "ghp_your_new_github_token"
  ```

  ```python Python
  # List resources on the session
  listed = client.beta.sessions.resources.list(session.id)
  repo_resource_id = listed.data[0].id
  print(repo_resource_id)  # "sesrsc_01ABC..."

  # Rotate the authorization token
  client.beta.sessions.resources.update(
      repo_resource_id,
      session_id=session.id,
      authorization_token="ghp_your_new_github_token",
  )
  ```

  ```typescript TypeScript
  // List resources on the session
  const listed = await client.beta.sessions.resources.list(session.id);
  const repoResource = listed.data.find((entry) => entry.type === "github_repository");
  if (!repoResource) {
    throw new Error("No GitHub repository resource on the session");
  }
  const repoResourceId = repoResource.id;
  console.log(repoResourceId); // "sesrsc_01ABC..."

  // Rotate the authorization token
  await client.beta.sessions.resources.update(repoResourceId, {
    session_id: session.id,
    authorization_token: "ghp_your_new_github_token"
  });
  ```

  ```csharp C#
  // List resources on the session
  var listed = await client.Beta.Sessions.Resources.List(session.ID);
  var repoResourceId = (await listed.Paginate().FirstAsync()).ID;
  Console.WriteLine(repoResourceId); // "sesrsc_01ABC..."

  // Rotate the authorization token
  await client.Beta.Sessions.Resources.Update(repoResourceId, new()
  {
      SessionID = session.ID,
      AuthorizationToken = "ghp_your_new_github_token",
  });
  ```

  ```go Go
  // List resources on the session
  listed, err := client.Beta.Sessions.Resources.List(ctx, session.ID, anthropic.BetaSessionResourceListParams{})
  if err != nil {
  	panic(err)
  }
  repoResourceID := listed.Data[0].ID
  fmt.Println(repoResourceID) // "sesrsc_01ABC..."

  // Rotate the authorization token
  _, err = client.Beta.Sessions.Resources.Update(ctx, repoResourceID, anthropic.BetaSessionResourceUpdateParams{
  	SessionID:          session.ID,
  	AuthorizationToken: "ghp_your_new_github_token",
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  // List resources on the session
  var listed = client.beta().sessions().resources().list(session.id());
  var repoResourceId = listed.data().getFirst().asGitHubRepository().id();
  IO.println(repoResourceId);  // "sesrsc_01ABC..."

  // Rotate the authorization token
  client.beta().sessions().resources().update(repoResourceId, ResourceUpdateParams.builder()
      .sessionId(session.id())
      .authorizationToken("ghp_your_new_github_token")
      .build());
  ```

  ```php PHP
  // List resources on the session
  $listed = $client->beta->sessions->resources->list($session->id);
  $repoResourceId = $listed->data[0]->id;
  echo $repoResourceId, PHP_EOL; // "sesrsc_01ABC..."

  // Rotate the authorization token
  $client->beta->sessions->resources->update(
      $repoResourceId,
      sessionID: $session->id,
      authorizationToken: 'ghp_your_new_github_token',
  );
  ```

  ```ruby Ruby
  # List resources on the session
  listed = client.beta.sessions.resources.list(session.id)
  repo_resource_id = listed.data.first.id
  puts repo_resource_id # "sesrsc_01ABC..."

  # Rotate the authorization token
  client.beta.sessions.resources.update(
    repo_resource_id,
    session_id: session.id,
    authorization_token: "ghp_your_new_github_token"
  )
  ```
</CodeGroup>

## Creating pull requests

With the GitHub MCP server, the agent can create branches, commit changes, and push them:

<CodeGroup>
  ```bash cURL
  curl -fsS "https://api.anthropic.com/v1/sessions/$session_id/events" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "events": [
        {
          "type": "user.message",
          "content": [
            {
              "type": "text",
              "text": "Fix the type error in src/utils.ts, commit it to a new branch, and push it."
            }
          ]
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions:events send --session-id "$SESSION_ID" <<'EOF'
  events:
    - type: user.message
      content:
        - type: text
          text: Fix the type error in src/utils.ts, commit it to a new branch, and push it.
  EOF
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
                      "text": "Fix the type error in src/utils.ts, commit it to a new branch, and push it.",
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
            text: "Fix the type error in src/utils.ts, commit it to a new branch, and push it."
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
                      Text = "Fix the type error in src/utils.ts, commit it to a new branch, and push it.",
                  },
              ],
          },
      ],
  });
  ```

  ```go Go
  _, err = client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
  	Events: []anthropic.BetaManagedAgentsEventParamsUnion{
  		{
  			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
  				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{
  					{
  						OfText: &anthropic.BetaManagedAgentsTextBlockParam{
  							Text: "Fix the type error in src/utils.ts, commit it to a new branch, and push it.",
  						},
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
  client.beta().sessions().events().send(session.id(), EventSendParams.builder()
      .addEvent(BetaManagedAgentsUserMessageEventParams.builder()
          .addContent(BetaManagedAgentsTextBlock.builder()
              .text("Fix the type error in src/utils.ts, commit it to a new branch, and push it.")
              .build())
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
                      'text' => 'Fix the type error in src/utils.ts, commit it to a new branch, and push it.',
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
            text: "Fix the type error in src/utils.ts, commit it to a new branch, and push it."
          }
        ]
      }
    ]
  )
  ```
</CodeGroup>

## Next steps

<CardGroup cols={2}>
  <Card title="Session event stream" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/events-and-streaming">
    Stream events and steer the agent while it opens the pull request
  </Card>

  <Card title="MCP connector" icon="link" href="https://platform.claude.com/docs/en/managed-agents/mcp-connector">
    Connect more MCP servers to give the agent additional tools
  </Card>

  <Card title="Adding files" icon="file" href="https://platform.claude.com/docs/en/managed-agents/files">
    Mount files in the sandbox alongside your repositories
  </Card>
</CardGroup>

## Availability

GitHub access is in beta on every model.

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
