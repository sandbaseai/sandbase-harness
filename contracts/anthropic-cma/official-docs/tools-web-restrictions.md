---
title: Restrict web search and web fetch domains
url: https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions
description: Control which sites an agent's web search and web fetch tools can reach, cap fetched content, and localize search results.
featureMetadata:
  topic:
    title: Managed Agents
    url: https://platform.claude.com/docs/en/managed-agents/overview
  betaHeader: managed-agents-2026-04-01
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
    Claude API: stable
    Claude Platform on AWS: beta
    Claude Models on Google Cloud (Anthropic managed): beta
---

**API support**: Usage differs by product.

* **Messages API**: Set `allowed_domains` or `blocked_domains` on the `web_search` or `web_fetch` tool in the request.
* **Managed Agents**: Set the same fields on the agent toolset; each list holds at most 64 domains.

To control which sites the agent’s web tools can reach, set a domain list on the `web_search` and `web_fetch` entries of the [agent toolset](https://platform.claude.com/docs/en/managed-agents/tools#configuring-the-toolset). Each of these `configs` (csharp, go: `Configs`) entries takes one of two lists:

* **`allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`):** The tool can reach only these hosts.
* **`blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`):** The tool can never reach these hosts.

Each tool carries its own list, so `web_search` and `web_fetch` can have different restrictions.

<Note>
  `web_search` and `web_fetch` run on Anthropic’s servers, not in the sandbox. A cloud environment with `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking) also applies its `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) to them; see [Set domain lists on an agent](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#set-domain-lists-on-an-agent). `unrestricted` networking and self-hosted environments do not limit them. The per-tool lists restrict these tools further.
</Note>

Your organization’s web search settings on the [**Capabilities**](https://platform.claude.com/settings/capabilities) page of the Claude Console also apply to `web_search` in a session. If an administrator disables web search, `web_search` calls return an error result to the agent, and the session continues. If the organization restricts web search domains, the agent receives only the search results that both the organization’s domain restrictions and the agent’s per-tool lists allow.

Your organization’s web fetch settings on the same page also apply to `web_fetch` in a session. If an administrator turns off web fetch, `web_fetch` calls return an error result to the agent, and the session continues. If the organization sets allowed or blocked domains for web fetch, a URL must pass the organization’s list and the agent’s per-tool lists, and so must any URL a redirect leads to. A `web_fetch` call for a URL that any of them excludes also returns an error result to the agent.

## Set domain lists on an agent

The following example creates an agent that limits `web_search` to two sites and blocks one host for `web_fetch`. It also sets `user_location` (java, php: `userLocation`; csharp, go: `UserLocation`) and `max_content_tokens` (java, php: `maxContentTokens`; csharp, go: `MaxContentTokens`), which [Settings](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#settings) describes. The response echoes the `configs` (csharp, go: `Configs`) array.

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Research Agent",
      "model": "claude-opus-5-5",
      "tools": [
        {
          "type": "agent_toolset_20260401",
          "configs": [
            {
              "type": "web_search",
              "name": "web_search",
              "allowed_domains": ["docs.example.com", "arxiv.org"],
              "user_location": {
                "type": "approximate",
                "country": "US",
                "timezone": "America/Los_Angeles"
              }
            },
            {
              "type": "web_fetch",
              "name": "web_fetch",
              "blocked_domains": ["ads.example.com"],
              "max_content_tokens": 50000
            }
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
      name: Research Agent
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
          configs:
            - type: web_search
              name: web_search
              allowed_domains: [docs.example.com, arxiv.org]
              user_location:
                type: approximate
                country: US
                timezone: America/Los_Angeles
            - type: web_fetch
              name: web_fetch
              blocked_domains: [ads.example.com]
              max_content_tokens: 50000
      ---
      ```
    </File>

    [`ant apply`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply) creates the agent and prints its ID, not the `configs` array.
  </CodeGroupItem>

  ```python Python
  client = Anthropic()

  agent = client.beta.agents.create(
      name="Research Agent",
      model="claude-opus-5-5",
      tools=[
          {
              "type": "agent_toolset_20260401",
              "configs": [
                  {
                      "name": "web_search",
                      "allowed_domains": ["docs.example.com", "arxiv.org"],
                      "user_location": {
                          "type": "approximate",
                          "country": "US",
                          "timezone": "America/Los_Angeles",
                      },
                  },
                  {
                      "name": "web_fetch",
                      "blocked_domains": ["ads.example.com"],
                      "max_content_tokens": 50_000,
                  },
              ],
          }
      ],
  )

  for tool in agent.tools:
      if tool.type == "agent_toolset_20260401":
          print(json.dumps([config.to_dict() for config in tool.configs], indent=2))
  ```

  ```typescript TypeScript
  const client = new Anthropic();

  const agent = await client.beta.agents.create({
    name: "Research Agent",
    model: "claude-opus-5-5",
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [
          {
            name: "web_search",
            allowed_domains: ["docs.example.com", "arxiv.org"],
            user_location: {
              type: "approximate",
              country: "US",
              timezone: "America/Los_Angeles"
            }
          },
          {
            name: "web_fetch",
            blocked_domains: ["ads.example.com"],
            max_content_tokens: 50_000
          }
        ]
      }
    ]
  });

  for (const tool of agent.tools) {
    if (tool.type === "agent_toolset_20260401") {
      console.log(JSON.stringify(tool.configs, null, 2));
    }
  }
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Agents;

  AnthropicClient client = new();

  var agent = await client.Beta.Agents.Create(new()
  {
      Name = "Research Agent",
      Model = BetaManagedAgentsModel.ClaudeOpus5_5,
      Tools =
      [
          new BetaManagedAgentsAgentToolset20260401Params
          {
              Configs =
              [
                  new BetaManagedAgentsWebSearchToolConfigParams
                  {
                      AllowedDomains = ["docs.example.com", "arxiv.org"],
                      UserLocation = new()
                      {
                          Country = "US",
                          Timezone = "America/Los_Angeles",
                      },
                  },
                  new BetaManagedAgentsWebFetchToolConfigParams
                  {
                      BlockedDomains = ["ads.example.com"],
                      MaxContentTokens = 50_000,
                  },
              ],
          },
      ],
  });

  JsonSerializerOptions jsonOptions = new() { WriteIndented = true };
  foreach (var tool in agent.Tools)
  {
      if (tool.TryPickBetaManagedAgentsAgentToolset20260401(out var toolset))
      {
          Console.WriteLine(JsonSerializer.Serialize(toolset.Configs, jsonOptions));
      }
  }
  ```

  ```go Go
  client := anthropic.NewClient()
  ctx := context.Background()

  agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
  	Name: "Research Agent",
  	Model: anthropic.BetaManagedAgentsModelConfigParams{
  		ID: anthropic.BetaManagedAgentsModelClaudeOpus5_5,
  	},
  	Tools: []anthropic.BetaAgentNewParamsToolUnion{{
  		OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{
  			Configs: []anthropic.BetaManagedAgentsAgentToolConfigParamsUnion{
  				{OfWebSearch: &anthropic.BetaManagedAgentsWebSearchToolConfigParams{
  					AllowedDomains: []string{"docs.example.com", "arxiv.org"},
  					UserLocation: anthropic.BetaManagedAgentsUserLocationParam{
  						Country:  anthropic.String("US"),
  						Timezone: anthropic.String("America/Los_Angeles"),
  					},
  				}},
  				{OfWebFetch: &anthropic.BetaManagedAgentsWebFetchToolConfigParams{
  					BlockedDomains:   []string{"ads.example.com"},
  					MaxContentTokens: anthropic.Int(50000),
  				}},
  			},
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }

  for _, tool := range agent.Tools {
  	switch toolset := tool.AsAny().(type) {
  	case anthropic.BetaManagedAgentsAgentToolset20260401:
  		configs := make([]json.RawMessage, len(toolset.Configs))
  		for i, config := range toolset.Configs {
  			configs[i] = json.RawMessage(config.RawJSON())
  		}
  		output, err := json.MarshalIndent(configs, "", "  ")
  		if err != nil {
  			panic(err)
  		}
  		fmt.Println(string(output))
  	}
  }
  ```

  ```java Java
  import com.anthropic.models.beta.agents.AgentCreateParams;
  import com.anthropic.models.beta.agents.BetaManagedAgentsAgentToolset20260401Params;
  import com.anthropic.models.beta.agents.BetaManagedAgentsModel;
  import com.anthropic.models.beta.agents.BetaManagedAgentsUserLocation;
  import com.anthropic.models.beta.agents.BetaManagedAgentsWebFetchToolConfigParams;
  import com.anthropic.models.beta.agents.BetaManagedAgentsWebSearchToolConfigParams;

  void main() {
      var client = AnthropicOkHttpClient.fromEnv();

      var agent = client.beta().agents().create(AgentCreateParams.builder()
          .name("Research Agent")
          .model(BetaManagedAgentsModel.CLAUDE_OPUS_5_5)
          .addTool(BetaManagedAgentsAgentToolset20260401Params.builder()
              .addConfig(BetaManagedAgentsWebSearchToolConfigParams.builder()
                  .allowedDomains(List.of("docs.example.com", "arxiv.org"))
                  .userLocation(BetaManagedAgentsUserLocation.builder()
                      .country("US")
                      .timezone("America/Los_Angeles")
                      .build())
                  .build())
              .addConfig(BetaManagedAgentsWebFetchToolConfigParams.builder()
                  .blockedDomains(List.of("ads.example.com"))
                  .maxContentTokens(50_000)
                  .build())
              .build())
          .build());

      for (var tool : agent.tools()) {
          if (tool.isAgentToolset20260401()) {
              var configs = tool.asAgentToolset20260401().configs();
              IO.println(ObjectMappers.jsonMapper().valueToTree(configs));
          }
      }
  }
  ```

  ```php PHP
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolset20260401;
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolset20260401Params;
  use Anthropic\Beta\Agents\BetaManagedAgentsUserLocation;
  use Anthropic\Beta\Agents\BetaManagedAgentsWebFetchToolConfigParams;
  use Anthropic\Beta\Agents\BetaManagedAgentsWebSearchToolConfigParams;
  // ...

  $client = new Client();

  $agent = $client->beta->agents->create(
      name: 'Research Agent',
      model: 'claude-opus-5-5',
      tools: [
          BetaManagedAgentsAgentToolset20260401Params::with(
              configs: [
                  BetaManagedAgentsWebSearchToolConfigParams::with(
                      allowedDomains: ['docs.example.com', 'arxiv.org'],
                      userLocation: BetaManagedAgentsUserLocation::with(
                          country: 'US',
                          timezone: 'America/Los_Angeles',
                      ),
                  ),
                  BetaManagedAgentsWebFetchToolConfigParams::with(
                      blockedDomains: ['ads.example.com'],
                      maxContentTokens: 50_000,
                  ),
              ],
          ),
      ],
  );

  foreach ($agent->tools as $tool) {
      if ($tool instanceof BetaManagedAgentsAgentToolset20260401) {
          echo json_encode($tool->configs, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
      }
  }
  ```

  ```ruby Ruby
  client = Anthropic::Client.new

  agent = client.beta.agents.create(
    name: "Research Agent",
    model: "claude-opus-5-5",
    tools: [
      {
        type: :agent_toolset_20260401,
        configs: [
          {
            name: :web_search,
            allowed_domains: ["docs.example.com", "arxiv.org"],
            user_location: {type: :approximate, country: "US", timezone: "America/Los_Angeles"}
          },
          {
            name: :web_fetch,
            blocked_domains: ["ads.example.com"],
            max_content_tokens: 50_000
          }
        ]
      }
    ]
  )

  case agent.tools.first
  in Anthropic::Models::Beta::BetaManagedAgentsAgentToolset20260401 => toolset
    puts JSON.pretty_generate(toolset.configs.map(&:to_h))
  end
  ```
</CodeGroup>

In a cloud environment with `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking), the environment’s `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) also applies to `web_search` and `web_fetch`. Creating a session fails with a 400 error when an enabled web tool’s `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) has an entry that is not within `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). So does a session update that adds such an entry. To fix it, add the host to `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) or remove the entry from `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`). At runtime, a `web_fetch` call for a URL on a host that `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) does not match returns a `url_not_allowed` error result. `web_search` omits results from such hosts. The two lists match differently: a tool’s entry covers its subdomains, but an `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) entry matches one exact host unless it starts with `*.`. For example, the tool entry `docs.example.com` is not within an `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) of `["example.com"]`, but it is within `["docs.example.com"]` or `["*.example.com"]`.

In the Claude Console, set allowed or blocked domains from the `web_search` and `web_fetch` rows of the **Built-in tools** card on the agent form. Set `max_content_tokens` and `user_location` in the **Raw** view of the agent’s configuration.

## Settings

In addition to `enabled` (csharp, go: `Enabled`) and `permission_policy` (java, php: `permissionPolicy`; csharp, go: `PermissionPolicy`), the web tool entries accept the following settings:

| Setting                                                                              | Applies to                | Description                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`)        | `web_search`, `web_fetch` | The only hosts the tool can reach. See [Domain list rules](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-list-rules).                                                        |
| `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`)        | `web_search`, `web_fetch` | Hosts the tool cannot reach. See [Domain list rules](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-list-rules).                                                              |
| `max_content_tokens` (java, php: `maxContentTokens`; csharp, go: `MaxContentTokens`) | `web_fetch`               | Caps the amount of fetched page content included in the context. Must be a positive integer. See [content limits](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool#content-limits). |
| `user_location` (java, php: `userLocation`; csharp, go: `UserLocation`)              | `web_search`              | Localizes search results. An object with the same fields as the Messages API [`user_location`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#localization) parameter.           |

For the types the SDK uses for these entries, see [Config entry types in the SDKs](https://platform.claude.com/docs/en/managed-agents/tools#config-entry-types-in-the-sdks).

## When a domain is not allowed

`web_search` omits results that its domain list does not allow. A `web_fetch` call for a URL that its domain list does not allow returns an error result to the agent. The `agent.tool_result` event has `is_error: true`, and its content names the error code `url_not_allowed`.

## Domain list rules

These rules apply to `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) alike. A request that breaks one is rejected, as [Validation errors](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#validation-errors) describes.

* **At most one list on an entry:** Set either `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) or `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) on an entry, not both.
* **List size:** Each list holds 1 to 64 domains, each 1 to 255 characters.
* **No empty lists:** To apply no restriction, omit the field or send `null`.
* **No duplicates:** A domain can appear only once in a list. `www.example.com` and `example.com` count as different domains.

### What a listed domain matches

A listed domain matches that host and all of its subdomains. `example.com` covers `docs.example.com`, but `docs.example.com` does not cover `example.com` or `api.example.com`.

A leading `www.` is a subdomain like any other, so `www.example.com` does not cover `example.com`. List the bare domain to cover both.

Hostnames are compared without regard to case.

### Domain format

Each domain is a registrable domain name, or a subdomain of one, written as a plain hostname. It can contain ASCII letters, digits, hyphens, underscores, and dots. A single trailing `/` is ignored. A `web_search` domain can also carry a path, as [Path suffixes on web search domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#path-suffixes-on-web-search-domains) describes.

| Not accepted                                                                   | Example                  | Use instead                           |
| ------------------------------------------------------------------------------ | ------------------------ | ------------------------------------- |
| A scheme                                                                       | `https://example.com`    | `example.com`                         |
| A port                                                                         | `example.com:443`        | `example.com`                         |
| A wildcard                                                                     | `*.example.com`          | `example.com`                         |
| A path on a `web_fetch` domain                                                 | `example.com/*`          | `example.com`                         |
| An IP address in any form, whether IPv4, IPv6, bracketed, or numeric shorthand | `127.1`                  | The site’s domain name                |
| A bare top-level domain or registry suffix                                     | `com`, `co.uk`, `gov.uk` | A full domain such as `example.co.uk` |
| A single-label name                                                            | `intranet`               | A full domain such as `example.co.uk` |
| Non-ASCII characters, as in an internationalized domain name                   |                          | The `xn--` (Punycode) form            |

A domain is also rejected if it contains credentials or whitespace, or if one of its labels starts or ends with a hyphen. `localhost` and hosts ending in `.localhost`, `.local`, `.internal`, `.localdomain`, or `.invalid` are rejected too.

### Path suffixes on web search domains

A `web_search` domain can carry a path suffix, such as `example.com/blog`. The path cannot contain spaces, `?`, `#`, or any of the characters `$ , | ^ !`.

Prefer plain hostnames for `web_search` too. The search provider matches path suffixes as URL patterns rather than as strict host rules.

## Validation errors

The API validates these settings when you [create an agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#create-an-agent) or [update an agent](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-an-agent). It also validates them when you create or update a session that supplies `tools` (csharp, go: `Tools`).

Format and limit violations are rejected with a 400 `invalid_request_error`:

| Violation                      | Error message                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An entry sets both lists.      | Includes `Only one of allowed_domains or blocked_domains may be set.`                                                                                          |
| A list is empty.               | Includes `allowed_domains: Empty list of domains is ambiguous. Provide at least one domain or null.`                                                           |
| A domain breaks a format rule. | Names the domain’s list and zero-based position. For example, `allowed_domains.0: IP addresses are not supported; provide a plain hostname like "example.com"` |

On the same requests, the API also rejects three settings that depend on the search and fetch providers:

* A domain in `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) that Anthropic’s crawler is not allowed to access.
* A `user_location.country` that the search provider does not support. The message ends in `user_location.country: not a country the search provider supports`.
* A `user_location.timezone` that is not a valid IANA name.

In a cloud environment with `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking), session create and update also check `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) against the environment’s `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). See the rule in [Set domain lists on an agent](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#set-domain-lists-on-an-agent).

### When an accepted setting is no longer valid

The session checks the configuration again when it first initializes the tool. If a setting that was accepted earlier is no longer valid at that point, the session emits a [`session.error`](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) event. It then returns to `idle` without retrying.

To continue the session:

1. Fix the setting by [updating the session’s tools](https://platform.claude.com/docs/en/managed-agents/session-operations#updating-the-agent-configuration).
2. Update the agent as well, so that new sessions start with the corrected configuration.
3. Send a new `user.message`.

## Multiagent and outcome-driven sessions

In a [multiagent session](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration), every domain list that applies to a thread is enforced at the same time. An agent listed in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) is bound by three sets of per-tool lists:

* Its own `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`)
* Those of any agent that called it
* The current lists of the agent that the session runs

The settings combine as follows:

| Setting                               | How it combines                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_domains`                     | The tool can reach a host only if every list covers it.                                                                                                                                                  |
| `blocked_domains`                     | The lists add together.                                                                                                                                                                                  |
| `max_content_tokens`, `user_location` | Not combined. A thread uses the value from its own tool configuration if set. Otherwise it uses the value from the agent that called it, and otherwise the current configuration of the session’s agent. |

A listed agent can therefore narrow what a tool reaches but never widen it:

* A listed agent that sets `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) keeps the `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) of the session’s agent and blocks those hosts within it.
* A listed agent that sets its own `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) can reach only the hosts that both its list and the list of the session’s agent cover.

A `{"type": "self"}` entry in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`) has no web settings of its own and follows the current settings of the session’s agent.

If the combined `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) lists have no domain in common, the tool stays available to that agent, but every call fails. Each call returns a `url_not_allowed` error whose text includes `no domain is permitted`. The tool description tells the model the same. To avoid this, keep each listed agent’s `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) inside the `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) of the session’s agent.

The grader in [outcome-driven sessions](https://platform.claude.com/docs/en/managed-agents/define-outcomes) runs without `web_search` and `web_fetch`, regardless of these settings.

## Change the lists mid-session

You can change the lists on an idle session by [updating its tools](https://platform.claude.com/docs/en/managed-agents/session-operations#updating-the-agent-configuration). The new lists apply to the rest of the session.

In a multiagent session, every thread applies the new lists from its next turn. For an agent listed in the `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`), the update does not change the agent’s own lists. Those stay as the agent’s definition set them when the session was created.

## Differences from the Messages API tools

These settings use the same `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) fields as [domain filtering](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools#domain-filtering) on the Messages API server tools. Managed Agents differs in four ways:

* Each list is [capped at 64 domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-list-rules).
* Domains listed for `web_fetch` [cannot include a path](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-format).
* Domains [must be ASCII](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-format). The Messages API accepts Unicode entries, though it recommends against them.
* `max_uses` (java, php: `maxUses`; csharp, go: `MaxUses`), `citations` (csharp, go: `Citations`), and `cache_control` (java, php: `cacheControl`; csharp, go: `CacheControl`) are not available on the toolset.

## Next steps

<CardGroup cols={2}>
  <Card title="Tools" icon="tool" href="https://platform.claude.com/docs/en/managed-agents/tools">
    See the built-in tools, enable or disable them, and define custom tools.
  </Card>

  <Card title="Permission policies" icon="lock" href="https://platform.claude.com/docs/en/managed-agents/permission-policies">
    Control when agent and MCP tools run.
  </Card>

  <Card title="Cloud environment setup" icon="settings" href="https://platform.claude.com/docs/en/managed-agents/environments">
    Control the sandbox’s own outbound network access.
  </Card>

  <Card title="Multiagent orchestration" icon="sitemap" href="https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration">
    Coordinate multiple agents within a single session.
  </Card>
</CardGroup>

## Availability

Web domain restrictions are available or in beta, depending on the API.

### API support

#### [Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)

* Availability: Available
* Usage: Set `allowed_domains` or `blocked_domains` on the `web_search` or `web_fetch` tool in the request.

| Status    | Cloud platforms |
| --------- | --------------- |
| Available | Claude API      |

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available
* Usage: Set the same fields on the `web_search` and `web_fetch` entries of the agent toolset. Unlike the Messages API, each list holds at most 64 ASCII domains, and `web_fetch` domains cannot include a path.

| Status | Cloud platforms         | Models                                                            |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| Beta   | All supported platforms | [All models](https://platform.claude.com/docs/en/models/overview) |

### Required beta headers

[Beta headers overview](https://platform.claude.com/docs/en/api/beta-headers)

Beta headers allow you to access experimental features and new model capabilities before they become part of the standard API.

| Header                      | APIs                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `managed-agents-2026-04-01` | [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) |
