---
title: Secure your Managed Agents deployment
url: https://platform.claude.com/docs/en/managed-agents/secure-deployment
description: The settings that limit what your agents can reach and do, most important first.
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

This guide lists the settings that limit what an agent on Claude Managed Agents can reach and do, most important first. Each section links to the page that covers the setting in full.

| Section                                                                                                                                                                                                | Setting or decision                                                           | Recommended                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Choose where the agent runs](https://platform.claude.com/docs/en/managed-agents/secure-deployment#choose-where-the-agent-runs)                                                                        | Cloud or self-hosted sandbox                                                  | Cloud, unless tools must run on infrastructure you control                                                                                                                                                                     |
| [Limit the network](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network)                                                                                            | Environment `networking.type`                                                 | `limited`, with only the hosts the agent needs                                                                                                                                                                                 |
| [Keep credentials in vaults](https://platform.claude.com/docs/en/managed-agents/secure-deployment#keep-credentials-in-vaults)                                                                          | `injection_location` and `networking` on each environment variable credential | Request headers only, and `limited` networking with only the hosts the key is for                                                                                                                                              |
| [Keep credentials in vaults](https://platform.claude.com/docs/en/managed-agents/secure-deployment#keep-credentials-in-vaults)                                                                          | How your application authenticates to the Claude API                          | Where you can, a Workload Identity Federation rule enabled in one workspace only, otherwise an API key scoped to one workspace                                                                                                 |
| [Restrict web search and web fetch](https://platform.claude.com/docs/en/managed-agents/secure-deployment#restrict-web-search-and-web-fetch)                                                            | `allowed_domains` on each web tool                                            | An allowlist on each tool. On `web_fetch`, list only the sites the agent needs. On `web_search`, list the sites you want results from                                                                                          |
| [Approve risky actions](https://platform.claude.com/docs/en/managed-agents/secure-deployment#approve-risky-actions)                                                                                    | `permission_policy` on each tool                                              | `auto` on `bash`, `write`, `edit`, `web_fetch`, and MCP tools that only read data. `always_ask` instead on a tool if you cannot undo its changes outside the sandbox, or if relayed end-user text alone should not make it run |
| [Give the agent the smallest tool set](https://platform.claude.com/docs/en/managed-agents/secure-deployment#give-the-agent-the-smallest-tool-set)                                                      | `default_config.enabled` on the agent toolset                                 | `false`, then enable the tools the agent needs                                                                                                                                                                                 |
| [Keep untrusted input away from powerful tools](https://platform.claude.com/docs/en/managed-agents/secure-deployment#keep-untrusted-input-away-from-powerful-tools)                                    | Which tools and credentials an agent holds when it reads untrusted input      | No agent that reads untrusted input has a tool on `always_allow` that writes files, runs commands, or changes records                                                                                                          |
| [Set limits and a way to stop](https://platform.claude.com/docs/en/managed-agents/secure-deployment#set-limits-and-a-way-to-stop)                                                                      | `budget` on each session and deployment                                       | A cap sized to what you expect a run to cost                                                                                                                                                                                   |
| [Optionally have an offline reviewer read every transcript](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#optionally-have-an-offline-reviewer-read-every-transcript) | An offline review job you run that reads each session’s events                | Optional. A review of each session that went idle or terminated, on a schedule                                                                                                                                                 |
| [Monitor sessions and review retention](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#monitor-sessions-and-review-retention)                                         | Webhooks and session deletion                                                 | An alert when a session goes idle, reaches its budget, or terminates, and a check of why it went idle. Store the events you want to keep in your own logs, and delete sessions you no longer need                              |

[Security risks and sandbox boundaries](https://platform.claude.com/docs/en/managed-agents/secure-deployment-risks) explains why these settings matter and what they do not protect against. To review and monitor sessions, see [Review and monitor agent sessions](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring).

The [Claude API skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/claude-api-skill) that ships with Claude Code has a `managed-agents-secure` command that checks an agent, its environments, and its vaults against this guide:

Let Claude Code check your agent against this guide

```text
/claude-api managed-agents-secure
```

The command changes nothing, and its report lists each setting to change with its recommended value and the questions only you can answer. Before you run it, update Claude Code and set up the `ant` CLI for the agent’s workspace, as the [CLI quickstart](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart) shows.

## Choose where the agent runs

Where the agent’s tools run determines who secures the sandbox: Anthropic, with a cloud environment, or you, with a self-hosted sandbox. To choose between them and learn what reaches Anthropic with each, see [Choosing an agent environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment).

If you use a [self-hosted sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes), keep these four points in mind:

* **Network:** [Limit the network](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network) applies to cloud environments. For a self-hosted sandbox, set the equivalent limits on its traffic in your own firewall. Your firewall does not limit the MCP servers an agent declares, so review them, and any that your application sets for a session.
* **Web tools:** The web tools run on Anthropic’s servers, so your firewall does not limit them. Limit them with their domain lists. See [Restrict web search and web fetch](https://platform.claude.com/docs/en/managed-agents/secure-deployment#restrict-web-search-and-web-fetch).
* **Credentials:** Environment variable credentials are not yet supported with self-hosted sandboxes.
* **Isolation and hardening:** You are responsible for both. See the [Security model](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security).

Neither option changes the compliance coverage of Managed Agents or how long it keeps session history. See [Monitor sessions and review retention](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring#monitor-sessions-and-review-retention).

## Limit the network

Use `limited` networking and list only the hosts the agent needs in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). An environment create request that omits `networking` (csharp, go: `Networking`) might get `unrestricted`, so set `networking` (csharp, go: `Networking`) in every create request. See [Risks of unrestricted networking](https://platform.claude.com/docs/en/managed-agents/environments#risks-of-unrestricted-networking).

Files, memory stores, and GitHub repositories that you attach stay available to the agent regardless of `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`).

The examples on this page use a support agent. It reads a customer’s ticket, looks up the order, reads your help center, and drafts a reply. Your application runs the order lookup, which needs no host, so this environment allows one host, the help center, for `web_fetch`:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/environments \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "support-agent",
      "config": {
        "type": "cloud",
        "networking": {
          "type": "limited",
          "allowed_hosts": ["help.example.com"]
        }
      }
    }'
  ```

  <CodeGroupItem>
    ```bash CLI
    ant apply environment.yaml
    ```

    <File filename="environment.yaml">
      ```yaml
      # yaml-language-server: $schema=https://platform.claude.com/schemas/ant/beta/environment.json
      name: support-agent
      config:
        type: cloud
        networking:
          type: limited
          allowed_hosts:
            - help.example.com
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  environment = client.beta.environments.create(
      name="support-agent",
      config={
          "type": "cloud",
          "networking": {
              "type": "limited",
              "allowed_hosts": ["help.example.com"],
          },
      },
  )
  ```

  ```typescript TypeScript
  const environment = await client.beta.environments.create({
    name: "support-agent",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: ["help.example.com"]
      }
    }
  });
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Environments;

  var environment = await client.Beta.Environments.Create(new()
  {
      Name = "support-agent",
      Config = new BetaCloudConfigParams
      {
          Networking = new BetaLimitedNetworkParams
          {
              AllowedHosts = ["help.example.com"],
          },
      },
  });
  ```

  ```go Go
  environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
  	Name: "support-agent",
  	Config: anthropic.BetaEnvironmentNewParamsConfigUnion{
  		OfCloud: &anthropic.BetaCloudConfigParams{
  			Networking: anthropic.BetaCloudConfigParamsNetworkingUnion{
  				OfLimited: &anthropic.BetaLimitedNetworkParams{
  					AllowedHosts: []string{"help.example.com"},
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
  import com.anthropic.models.beta.environments.*;
  import java.util.List;

  var environment = client.beta().environments().create(EnvironmentCreateParams.builder()
      .name("support-agent")
      .config(BetaCloudConfigParams.builder()
          .networking(BetaLimitedNetworkParams.builder()
              .allowedHosts(List.of("help.example.com"))
              .build())
          .build())
      .build());
  ```

  ```php PHP
  $environment = $client->beta->environments->create(
      name: 'support-agent',
      config: [
          'type' => 'cloud',
          'networking' => [
              'type' => 'limited',
              'allowed_hosts' => ['help.example.com'],
          ],
      ],
  );
  ```

  ```ruby Ruby
  environment = client.beta.environments.create(
    name: "support-agent",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: ["help.example.com"]
      }
    }
  )
  ```
</CodeGroup>

A `limited` environment has three networking settings:

| Setting                                                                                                                 | What it opens to code in the sandbox                                                                                                                                                                                                                                                           | Recommended                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`)                                                 | The hosts you list, for any request                                                                                                                                                                                                                                                            | Only the hosts the agent needs, including the host of each MCP server you operate or trust                                                                                                                                                                                                  |
| `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`)                        | The [package manager hosts](https://platform.claude.com/docs/en/managed-agents/environments#package-manager-hosts). They include every repository and path on `github.com`, `gitlab.com`, and `bitbucket.org`, where anyone can publish content and where code in the sandbox can upload files | `false`, unless the environment’s `packages` (csharp, go: `Packages`) setting lists packages, which requires `true`. If the agent installs packages while it runs, list only the registry hosts it needs in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) instead |
| `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) | No host. Managed Agents connects to MCP servers from Anthropic’s servers                                                                                                                                                                                                                       | `false`, with the host of each MCP server you operate or trust listed in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`)                                                                                                                                            |

The `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) and `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) settings add no hosts for web search and web fetch.

Leave `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) off, which is the default, and list the host of each MCP server you operate or trust in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Each host you list is also open to code in the sandbox. With `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) off, a check at session creation rejects the request if an MCP server’s host is not listed. See [Provide authentication at session creation](https://platform.claude.com/docs/en/managed-agents/mcp-connector#provide-authentication-at-session-creation). The same check runs when a session update changes `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`).

<Warning>
  Network access is granted by host, not by operation. The sandbox can send any request to an allowed host, including uploads such as `git push` and package publishing. It can also use any credential the command supplies, even one that someone hid in text the agent reads.
</Warning>

When you choose hosts for `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`), follow these two rules:

* List only hosts you operate or trust.
* Avoid `*.` wildcards and shared-hosting domains where anyone can publish content.

If the agent keeps `bash`, set the `bash` tool’s [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies) as [Approve risky actions](https://platform.claude.com/docs/en/managed-agents/secure-deployment#approve-risky-actions) describes.

<Note>
  After you tighten an environment, start new sessions and stop the ones that were already running. A session that is already running can keep the old limits until it ends. See [Set limits and a way to stop](https://platform.claude.com/docs/en/managed-agents/secure-deployment#set-limits-and-a-way-to-stop).
</Note>

See [Networking in Cloud environment setup](https://platform.claude.com/docs/en/managed-agents/environments#networking) for every networking setting.

## Keep credentials in vaults

Store every secret in a vault. For each environment variable credential, set the injection location to request headers only and list only the hosts the secret is for. Code in the sandbox sees a placeholder instead of the secret. Managed Agents swaps in the real secret only in outgoing HTTPS requests to the hosts the credential allows. So the secret stays out of direct reach of the model, unless a service sends it back, such as an endpoint that echoes request headers. If the credential’s `networking` (csharp, go: `Networking`) is `unrestricted`, Managed Agents swaps in the real secret in requests to any host the environment lets the sandbox reach. To use a vault, pass its ID in `vault_ids` (java: `vaultIds`; php: `vaultIDs`; csharp: `VaultIds`; go: `VaultIDs`) when you create the session or deployment.

| Setting                                                                                | Set it to                                                                                                                        | Why                                                                                                                                                                                                                              | What it does not do                                                                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `injection_location` (java, php: `injectionLocation`; csharp, go: `InjectionLocation`) | `{"header": true, "body": false}`, after you check that the service reads the key from a header                                  | Request bodies are often built from content the agent reads, so a key in a body is more exposed. Name both fields: a create request that omits the object enables both locations, and an update changes only the fields you send | Code can still use the key on every host the credential allows. A service that expects the key in the body receives the placeholder and rejects the request |
| `networking` (csharp, go: `Networking`) on the credential                              | `limited`, with the exact hosts the key is for                                                                                   | Responses reach the sandbox unredacted, so avoid wildcards, shared-hosting domains, and hosts that echo request headers                                                                                                          | It does not open the host. The environment must also allow it                                                                                               |
| The key’s permissions, at the service that issued the key                              | Only the permissions the agent needs                                                                                             | The agent can do anything the key allows                                                                                                                                                                                         | Not applicable                                                                                                                                              |
| A mounted repository’s GitHub token                                                    | A [fine-grained token](https://platform.claude.com/docs/en/managed-agents/github#token-permissions) with the minimum permissions | Code in the sandbox can fetch from and push to the mounted repository with it for the whole session. Grant write access only if the agent must push                                                                              | Not applicable                                                                                                                                              |

The support agent needs no vault credential, because your application holds the API key for your order API. If your agent does hold a vault credential, see [Add a credential](https://platform.claude.com/docs/en/managed-agents/vaults#add-a-credential) for the request in every language.

Keep keys out of system prompts, agent definitions, and messages. Do not give the agent a Claude API key or Claude API access token. Even when one is in a vault, code in the sandbox can use it to call the Claude API directly. It can do anything that credential allows, such as starting or deleting sessions, or using web search and web fetch. The agent’s tool settings, approvals, and budget do not apply to those calls. In a `limited` environment, code can make these calls only if `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) lets the sandbox reach `api.anthropic.com`.

Fetch third-party tokens yourself and store them in the vault. A token that code in the sandbox fetches with a stored secret comes back unredacted.

Keep vaults for workloads with different trust levels in separate [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces), because whoever can start sessions in a workspace can reference its vaults. Limit each workload to one workspace: where you can, a [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) rule enabled only in it, otherwise an API key scoped to it. Workload Identity Federation gives your application short-lived Claude API access tokens, so there is no long-lived Claude API key to leak.

See [Authenticate with vaults](https://platform.claude.com/docs/en/managed-agents/vaults) for MCP credentials and rotation.

## Restrict web search and web fetch

Set `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) on `web_fetch` to the sites the agent needs. Any URL the agent fetches can carry data to the site it points to, so this list is a security control. On `web_search`, set `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) to the sites you want results from, so that results come only from sites you trust to be accurate. The list does not stop the search query from reaching the search provider. Search results include text from pages, so the list also limits which sites’ text reaches the agent. Set `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) on both tools for every type of environment.

A `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) list blocks the hosts you list and their subdomains, and no other host. The same content can still reach the agent from web archives, caches, mirrors, or related domains you did not list. Do not rely on `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) for security. Use `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and name the hosts you trust.

An administrator can turn off web search or web fetch, or restrict their domains, on the [**Capabilities**](https://platform.claude.com/settings/capabilities) page of the Claude Console. These settings also apply in a session. With a tool turned off, its calls return an error result to the agent, and the session continues. With domain restrictions set, a search result or a fetched URL must pass both the organization’s restrictions and the tool’s own domain lists. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).

In a `limited` environment, the `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) list from [Limit the network](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network) also limits the web tools. An `unrestricted` environment or a self-hosted sandbox does not limit the web tools.

| In a `limited` environment                                                   | Result                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An `allowed_domains` entry on an enabled web tool is outside `allowed_hosts` | Creating a session fails with a 400 error, and so does a session update that adds such an entry. A session that a deployment starts, on its schedule or by a manual run, is created anyway. The tool then returns nothing from hosts outside `allowed_hosts` |
| A web tool has no list of its own                                            | The tool returns pages and results only from hosts in `allowed_hosts`. Set `allowed_domains` on the tool as well                                                                                                                                             |
| `allowed_hosts` has no entries                                               | Neither web tool returns a page or a search result                                                                                                                                                                                                           |
| You add a host to `allowed_hosts` for a web tool                             | The host is also open to code in the sandbox                                                                                                                                                                                                                 |

The two lists match hosts differently:

| List                          | Entry           | Matches                           | Does not match    |
| ----------------------------- | --------------- | --------------------------------- | ----------------- |
| `allowed_hosts` (environment) | `example.com`   | `example.com`                     | `www.example.com` |
| `allowed_hosts` (environment) | `*.example.com` | Every subdomain                   | `example.com`     |
| `allowed_domains` (web tool)  | `example.com`   | `example.com` and every subdomain | Other domains     |

If the agent needs a site and all of its subdomains, list both `example.com` and `*.example.com` in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`), and otherwise list exact hosts. If a tool lists `example.com` and `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) lists only `*.example.com`, the session is created. The check at session creation counts `example.com` as within `*.example.com`, but the tool returns nothing from `example.com` itself. See [Set domain lists on an agent](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#set-domain-lists-on-an-agent) for how the two lists match.

The `web_fetch` tool also opens only URLs that have already appeared in the session:

| Where the URL appears                                                                         | `web_fetch` can open it                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The text of a user message, including end-user text that you relay                            | Yes                                               |
| The description of a `user.define_outcome` event                                              | Yes                                               |
| The address of a web search result                                                            | Yes                                               |
| The text of a page that `web_fetch` returned earlier (not a PDF), where the full URL is shown | Yes                                               |
| The text of a custom tool’s result, when Claude called the tool directly                      | Yes, unless the result is marked `is_error: true` |
| The system prompt                                                                             | No                                                |
| The agent’s configuration, including `allowed_domains` entries                                | No                                                |
| Claude’s own output                                                                           | No                                                |
| Output of `bash` and the other sandbox tools                                                  | No                                                |
| An MCP tool result                                                                            | No                                                |
| A file attached to a user message                                                             | No                                                |

In a multiagent session, `web_fetch` opens a URL from another agent only if it reached that agent through a source marked Yes. A custom tool’s result from a direct call counts as a source marked Yes. This holds even if Claude wrote its text, for example when the tool repeats its input. A URL can count even when it is written without `https://`, such as `example.com/docs`. The `web_fetch` tool cannot always open a link that shows words instead of its URL, such as “Contact support.” If the agent must fetch a URL that has not appeared in the session, send it in a user message.

This rule reduces the chance that injected text builds a URL that carries private data. End-user text, search results, fetched pages, and custom tool results can still add URLs, so keep `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) set. The Messages API applies a similar rule with a different list of sources. See [URL validation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool#url-validation).

A domain list on `web_fetch` does not limit the `bash` tool. [Limit the network](https://platform.claude.com/docs/en/managed-agents/secure-deployment#limit-the-network) as well. See [Domain list rules](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#domain-list-rules).

## Approve risky actions

Set `auto` on `bash`, `write`, `edit`, and `web_fetch`, and on MCP tools that only read data. Use `always_ask` instead on a tool if you cannot undo its changes outside the sandbox. Also use it on a tool that should not run just because end-user text you relay asks for it. A [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies) determines whether a tool call runs, waits for your approval, or is evaluated by the server.

| Tool                          | Recommended policy                                                                                                                           | Why                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`, `glob`, `grep`        | `always_allow`                                                                                                                               | They read files in the sandbox and change nothing                                                                                               |
| `bash`, `write`, `edit`       | `auto`. Use `always_ask` on a tool if you cannot undo its changes outside the sandbox. Use `always_ask` on `bash` if you relay end-user text | The agent toolset default is `always_allow`, which runs every call without approval                                                             |
| `web_fetch`                   | `auto`                                                                                                                                       | A URL the agent fetches can carry data to the site it points to                                                                                 |
| `web_search`                  | `always_ask` if the agent handles data you would not want sent in a search query. Otherwise `always_allow`                                   | `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) limits which sites results come from, not what the query contains |
| MCP tools that only read data | `auto`, set for each tool in the toolset’s `configs` (csharp, go: `Configs`)                                                                 | The toolset default stays `always_ask`, so a tool the MCP server adds later still waits for approval                                            |
| MCP tools that change data    | `always_ask`                                                                                                                                 | This is the MCP toolset default. Keep it                                                                                                        |
| Custom tools                  | Your code determines whether each call runs                                                                                                  | Permission policies do not apply                                                                                                                |

The toolset in [Give the agent the smallest tool set](https://platform.claude.com/docs/en/managed-agents/secure-deployment#give-the-agent-the-smallest-tool-set) applies these policies.

The [`auto` policy](https://platform.claude.com/docs/en/managed-agents/permission-policies#let-the-server-evaluate-each-call-with-auto) lets the server run a call, deny it, or pause for approval. A person cannot approve every call in a long run, so the server checks each one instead. Pair `auto` with limited networking, a key with narrow permissions, a budget, and an alert on idle sessions. `auto` is not a human checkpoint, so if a person must review a tool’s calls before they run, configure `always_ask` on that tool.

`auto` treats text in `user.message` events and the description in a `user.define_outcome` event as your instruction, including end-user text you relay.

A paused session waits indefinitely, so an unattended session needs a client that answers paused calls or interrupts the session.

Review each paused call before you allow it. A client that allows every call without showing it to a person is the same as `always_allow`. See [Respond to confirmation requests](https://platform.claude.com/docs/en/managed-agents/permission-policies#respond-to-confirmation-requests) and [See how each call was evaluated](https://platform.claude.com/docs/en/managed-agents/permission-policies#see-how-each-call-was-evaluated).

## Give the agent the smallest tool set

Set `default_config.enabled` (java, php: `defaultConfig.enabled`; csharp, go: `DefaultConfig.Enabled`) to `false` and [enable only the tools the agent needs](https://platform.claude.com/docs/en/managed-agents/tools#enabling-only-specific-tools). The agent toolset enables all eight built-in tools by default.

| Tool                      | What it does                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `bash`                    | Runs any command, including requests to allowed hosts                     |
| `write`, `edit`           | Change files in the sandbox                                               |
| `read`, `glob`, `grep`    | Read files in the sandbox                                                 |
| `web_fetch`, `web_search` | Return pages and search results from the web, through Anthropic’s servers |

The support agent needs three built-in tools: `read` and `write` for its draft, and `web_fetch` for the help center. It looks up orders through a [custom tool](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools), `lookup_order`, that your application runs. Your application holds the API key for your order API, so the agent needs neither `bash` nor a credential.

The following sample limits `web_fetch` to `help.example.com` with `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`). It sets `auto` on `write` and `web_fetch`, as [Approve risky actions](https://platform.claude.com/docs/en/managed-agents/secure-deployment#approve-risky-actions) recommends. If a customer’s ticket leads the agent to use these tools, the agent can only change files in the sandbox or open help center pages. That is why neither tool needs `always_ask`. The sample also sets `always_ask` in `default_config` (java, php: `defaultConfig`; csharp, go: `DefaultConfig`), so a tool you enable later without its own policy uses `always_ask`:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/agents \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "Support Agent",
      "model": "claude-opus-5-5",
      "tools": [
        {
          "type": "agent_toolset_20260401",
          "default_config": {
            "enabled": false,
            "permission_policy": {"type": "always_ask"}
          },
          "configs": [
            {"name": "read", "enabled": true, "permission_policy": {"type": "always_allow"}},
            {"name": "write", "enabled": true, "permission_policy": {"type": "auto"}},
            {
              "name": "web_fetch",
              "enabled": true,
              "allowed_domains": ["help.example.com"],
              "permission_policy": {"type": "auto"}
            }
          ]
        },
        {
          "type": "custom",
          "name": "lookup_order",
          "description": "Look up one order by its ID. Returns the status, the items, and the delivery date.",
          "input_schema": {
            "type": "object",
            "properties": {
              "order_id": {"type": "string", "description": "The order ID from the ticket"}
            },
            "required": ["order_id"]
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
      name: Support Agent
      model: claude-opus-5-5
      tools:
        - type: agent_toolset_20260401
          default_config:
            enabled: false
            permission_policy:
              type: always_ask
          configs:
            - name: read
              enabled: true
              permission_policy:
                type: always_allow
            - name: write
              enabled: true
              permission_policy:
                type: auto
            - name: web_fetch
              enabled: true
              allowed_domains: [help.example.com]
              permission_policy:
                type: auto
        - type: custom
          name: lookup_order
          description: Look up one order by its ID. Returns the status, the items, and the delivery date.
          input_schema:
            type: object
            properties:
              order_id:
                type: string
                description: The order ID from the ticket
            required:
              - order_id
      ---
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  tools = [
      {
          "type": "agent_toolset_20260401",
          "default_config": {
              "enabled": False,
              "permission_policy": {"type": "always_ask"},
          },
          "configs": [
              {
                  "name": "read",
                  "enabled": True,
                  "permission_policy": {"type": "always_allow"},
              },
              {
                  "name": "write",
                  "enabled": True,
                  "permission_policy": {"type": "auto"},
              },
              {
                  "name": "web_fetch",
                  "enabled": True,
                  "allowed_domains": ["help.example.com"],
                  "permission_policy": {"type": "auto"},
              },
          ],
      },
      {
          "type": "custom",
          "name": "lookup_order",
          "description": "Look up one order by its ID. Returns the status, the items, and the delivery date.",
          "input_schema": {
              "type": "object",
              "properties": {
                  "order_id": {
                      "type": "string",
                      "description": "The order ID from the ticket",
                  },
              },
              "required": ["order_id"],
          },
      },
  ]
  ```

  ```typescript TypeScript
  const tools = [
    {
      type: "agent_toolset_20260401",
      default_config: {
        enabled: false,
        permission_policy: { type: "always_ask" }
      },
      configs: [
        {
          name: "read",
          enabled: true,
          permission_policy: { type: "always_allow" }
        },
        {
          name: "write",
          enabled: true,
          permission_policy: { type: "auto" }
        },
        {
          name: "web_fetch",
          enabled: true,
          allowed_domains: ["help.example.com"],
          permission_policy: { type: "auto" }
        }
      ]
    },
    {
      type: "custom",
      name: "lookup_order",
      description:
        "Look up one order by its ID. Returns the status, the items, and the delivery date.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order ID from the ticket" }
        },
        required: ["order_id"]
      }
    }
  ] satisfies Anthropic.Beta.AgentCreateParams["tools"];
  ```

  ```csharp C#
  using System.Text.Json;
  using Anthropic.Models.Beta.Agents;
  using Tool = Anthropic.Models.Beta.Agents.Tool;

  Tool[] tools =
  [
      new BetaManagedAgentsAgentToolset20260401Params
      {
          DefaultConfig = new()
          {
              Enabled = false,
              PermissionPolicy = new BetaManagedAgentsAlwaysAskPolicy(),
          },
          Configs =
          [
              new BetaManagedAgentsReadToolConfigParams
              {
                  Enabled = true,
                  PermissionPolicy = new BetaManagedAgentsAlwaysAllowPolicy(),
              },
              new BetaManagedAgentsWriteToolConfigParams
              {
                  Enabled = true,
                  PermissionPolicy = new BetaManagedAgentsAutoPolicy(),
              },
              new BetaManagedAgentsWebFetchToolConfigParams
              {
                  Enabled = true,
                  AllowedDomains = ["help.example.com"],
                  PermissionPolicy = new BetaManagedAgentsAutoPolicy(),
              },
          ],
      },
      new BetaManagedAgentsCustomToolParams
      {
          Name = "lookup_order",
          Description = "Look up one order by its ID. Returns the status, the items, and the delivery date.",
          InputSchema = new()
          {
              Properties = new Dictionary<string, JsonElement>
              {
                  ["order_id"] = JsonSerializer.SerializeToElement(
                      new { type = "string", description = "The order ID from the ticket" }
                  ),
              },
              Required = ["order_id"],
          },
      },
  ];
  ```

  ```go Go
  tools := []anthropic.BetaAgentNewParamsToolUnion{{
  	OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{
  		DefaultConfig: anthropic.BetaManagedAgentsAgentToolsetDefaultConfigParams{
  			Enabled: anthropic.Bool(false),
  			PermissionPolicy: anthropic.BetaManagedAgentsAgentToolsetDefaultConfigParamsPermissionPolicyUnion{
  				OfAlwaysAsk: &anthropic.BetaManagedAgentsAlwaysAskPolicyParam{},
  			},
  		},
  		Configs: []anthropic.BetaManagedAgentsAgentToolConfigParamsUnion{
  			{OfRead: &anthropic.BetaManagedAgentsReadToolConfigParams{
  				Enabled: anthropic.Bool(true),
  				PermissionPolicy: anthropic.BetaManagedAgentsReadToolConfigParamsPermissionPolicyUnion{
  					OfAlwaysAllow: &anthropic.BetaManagedAgentsAlwaysAllowPolicyParam{},
  				},
  			}},
  			{OfWrite: &anthropic.BetaManagedAgentsWriteToolConfigParams{
  				Enabled: anthropic.Bool(true),
  				PermissionPolicy: anthropic.BetaManagedAgentsWriteToolConfigParamsPermissionPolicyUnion{
  					OfAuto: &anthropic.BetaManagedAgentsAutoPolicyParam{},
  				},
  			}},
  			{OfWebFetch: &anthropic.BetaManagedAgentsWebFetchToolConfigParams{
  				AllowedDomains: []string{"help.example.com"},
  				Enabled:        anthropic.Bool(true),
  				PermissionPolicy: anthropic.BetaManagedAgentsWebFetchToolConfigParamsPermissionPolicyUnion{
  					OfAuto: &anthropic.BetaManagedAgentsAutoPolicyParam{},
  				},
  			}},
  		},
  	},
  }, {
  	OfCustom: &anthropic.BetaManagedAgentsCustomToolParams{
  		Name:        "lookup_order",
  		Description: "Look up one order by its ID. Returns the status, the items, and the delivery date.",
  		InputSchema: anthropic.BetaManagedAgentsCustomToolInputSchemaParam{
  			Properties: map[string]any{
  				"order_id": map[string]any{
  					"type":        "string",
  					"description": "The order ID from the ticket",
  				},
  			},
  			Required: []string{"order_id"},
  		},
  	},
  }}
  ```

  ```java Java
  import com.anthropic.core.JsonValue;
  import com.anthropic.models.beta.agents.*;
  import java.util.List;
  import java.util.Map;

  var tools = List.of(
      AgentCreateParams.Tool.ofAgentToolset20260401(
          BetaManagedAgentsAgentToolset20260401Params.builder()
              .defaultConfig(
                  BetaManagedAgentsAgentToolsetDefaultConfigParams.builder()
                      .enabled(false)
                      .permissionPolicy(BetaManagedAgentsAlwaysAskPolicy.builder().build())
                      .build()
              )
              .addConfig(
                  BetaManagedAgentsReadToolConfigParams.builder()
                      .enabled(true)
                      .permissionPolicy(BetaManagedAgentsAlwaysAllowPolicy.builder().build())
                      .build()
              )
              .addConfig(
                  BetaManagedAgentsWriteToolConfigParams.builder()
                      .enabled(true)
                      .permissionPolicy(BetaManagedAgentsAutoPolicy.builder().build())
                      .build()
              )
              .addConfig(
                  BetaManagedAgentsWebFetchToolConfigParams.builder()
                      .enabled(true)
                      .allowedDomains(List.of("help.example.com"))
                      .permissionPolicy(BetaManagedAgentsAutoPolicy.builder().build())
                      .build()
              )
              .build()
      ),
      AgentCreateParams.Tool.ofCustom(
          BetaManagedAgentsCustomToolParams.builder()
              .name("lookup_order")
              .description("Look up one order by its ID. Returns the status, the items, and the delivery date.")
              .inputSchema(
                  BetaManagedAgentsCustomToolInputSchema.builder()
                      .properties(
                          BetaManagedAgentsCustomToolInputSchema.Properties.builder()
                              .putAdditionalProperty("order_id", JsonValue.from(Map.of(
                                  "type", "string",
                                  "description", "The order ID from the ticket")))
                              .build()
                      )
                      .addRequired("order_id")
                      .build()
              )
              .build()
      )
  );
  ```

  ```php PHP
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolset20260401Params;
  use Anthropic\Beta\Agents\BetaManagedAgentsAgentToolsetDefaultConfigParams;
  use Anthropic\Beta\Agents\BetaManagedAgentsAlwaysAllowPolicy;
  use Anthropic\Beta\Agents\BetaManagedAgentsAlwaysAskPolicy;
  use Anthropic\Beta\Agents\BetaManagedAgentsAutoPolicy;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolInputSchema;
  use Anthropic\Beta\Agents\BetaManagedAgentsCustomToolParams;
  use Anthropic\Beta\Agents\BetaManagedAgentsReadToolConfigParams;
  use Anthropic\Beta\Agents\BetaManagedAgentsWebFetchToolConfigParams;
  use Anthropic\Beta\Agents\BetaManagedAgentsWriteToolConfigParams;

  $tools = [
      BetaManagedAgentsAgentToolset20260401Params::with(
          defaultConfig: BetaManagedAgentsAgentToolsetDefaultConfigParams::with(
              enabled: false,
              permissionPolicy: BetaManagedAgentsAlwaysAskPolicy::with(),
          ),
          configs: [
              BetaManagedAgentsReadToolConfigParams::with(
                  enabled: true,
                  permissionPolicy: BetaManagedAgentsAlwaysAllowPolicy::with(),
              ),
              BetaManagedAgentsWriteToolConfigParams::with(
                  enabled: true,
                  permissionPolicy: BetaManagedAgentsAutoPolicy::with(),
              ),
              BetaManagedAgentsWebFetchToolConfigParams::with(
                  allowedDomains: ['help.example.com'],
                  enabled: true,
                  permissionPolicy: BetaManagedAgentsAutoPolicy::with(),
              ),
          ],
      ),
      BetaManagedAgentsCustomToolParams::with(
          name: 'lookup_order',
          description: 'Look up one order by its ID. Returns the status, the items, and the delivery date.',
          inputSchema: BetaManagedAgentsCustomToolInputSchema::with(
              properties: ['order_id' => ['type' => 'string', 'description' => 'The order ID from the ticket']],
              required: ['order_id'],
          ),
      ),
  ];
  ```

  ```ruby Ruby
  tools = [
    {
      type: "agent_toolset_20260401",
      default_config: {
        enabled: false,
        permission_policy: {type: "always_ask"}
      },
      configs: [
        {
          name: "read",
          enabled: true,
          permission_policy: {type: "always_allow"}
        },
        {
          name: "write",
          enabled: true,
          permission_policy: {type: "auto"}
        },
        {
          name: "web_fetch",
          enabled: true,
          allowed_domains: ["help.example.com"],
          permission_policy: {type: "auto"}
        }
      ]
    },
    {
      type: "custom",
      name: "lookup_order",
      description: "Look up one order by its ID. Returns the status, the items, and the delivery date.",
      input_schema: {
        type: "object",
        properties: {order_id: {type: "string", description: "The order ID from the ticket"}},
        required: ["order_id"]
      }
    }
  ]
  ```
</CodeGroup>

An [agent update](https://platform.claude.com/docs/en/managed-agents/agent-setup#update-semantics) replaces the whole `tools` (csharp, go: `Tools`) array, so send every entry you want to keep.

An agent update reaches only new sessions, so also check deployments, agents that list this agent, and existing sessions:

* A deployment pins an agent version, so point each deployment at the new one.
* An agent that lists this one in the [`predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of `subagents` (csharp, go: `Subagents`)](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#list-the-subagents) or of `workflows` (csharp, go: `Workflows`) keeps the version it pinned. Update that agent too.
* To tighten a session that already exists, [update that session’s tools](https://platform.claude.com/docs/en/managed-agents/session-operations#updating-the-agent-configuration). The session must be `idle`, and the update replaces the whole `tools` (csharp, go: `Tools`) array. In a multiagent session, new `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) lists on the web tools of the agent the session runs also apply to every other agent. They apply from each agent’s next turn. Those agents’ enabled tools and permission policies do not change. To change those, update each agent, then start a new session.

Limit MCP servers and custom tools to what the agent needs, too:

* **MCP servers:** An MCP toolset enables every tool the server exposes by default. Set `default_config.enabled` (java, php: `defaultConfig.enabled`; csharp, go: `DefaultConfig.Enabled`) to `false` and enable named tools, so tools a server adds later stay off. Remove servers the agent does not use. See [MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector#configure-which-mcp-tools-are-available).
* **Custom tools:** Your application runs them, and permission policies do not apply. Validate each call’s input in your application and limit what the tool can touch.

## Keep untrusted input away from powerful tools

Check which tools and credentials an agent holds whenever it reads untrusted input, which is text that someone outside your team can write. This section uses two terms:

* **Untrusted input:** Webpages, search results, support tickets, emails, repository files, uploads, MCP server results, and end-user messages that you relay
* **Powerful tools:** `bash`, `write`, `edit`, `web_fetch`, `web_search`, MCP tools and custom tools that write or send data, and any tool that uses a credential

Text in untrusted input can tell the agent to use a powerful tool it holds. The support agent reads tickets, so it reaches your order API only through the custom tool `lookup_order`. Your application checks that the order belongs to the ticket’s sender.

| Input the agent reads           | Power it also has                                                                                                         | Do this                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tickets, emails, or uploads     | `bash` with a credential                                                                                                  | Replace `bash` with a custom tool that does one thing. If the agent must keep `bash`, approve each call with `always_ask`                                                                                                                                                                                    |
| Webpages or search results      | Writing files or changing records                                                                                         | Turn off the web tools, or limit them to sites you operate or trust                                                                                                                                                                                                                                          |
| MCP results or repository files | MCP tools that write                                                                                                      | Keep the MCP toolset on `always_ask`, and enable only the tools the agent needs                                                                                                                                                                                                                              |
| A mounted GitHub repository     | Any tool                                                                                                                  | Mount only repositories you trust. An agent with `read` loads skills from the repository’s `.claude/skills` directory as agent instructions, with no review step. See [Load skills from a GitHub repository](https://platform.claude.com/docs/en/managed-agents/skills#load-skills-from-a-github-repository) |
| Any untrusted input             | Writing to a [memory store](https://platform.claude.com/docs/en/managed-agents/memory#attach-a-memory-store-to-a-session) | Attach the store as `read_only` unless the agent must write. The default is `read_write`, and later sessions read saved text as trusted memory                                                                                                                                                               |

In a cloud environment, reading a file with `read` can also load `CLAUDE.md` and `AGENTS.md` files as instructions. They load from the file’s directory and its parent directories, up to the sandbox’s working directory. Files they reference with `@` and a path, such as `@docs/setup.md`, also load, up to five references deep. A reference can point anywhere in the sandbox, for example `@/etc/hosts`. No setting turns this off except disabling `read`, so treat a repository, package, or archive that someone outside your team can write as untrusted input.

When an agent must read untrusted input and also act, this guide recommends one of three designs:

* **Split reading from acting.** In one multiagent session, a [lead agent](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#list-the-subagents) gives tasks to a fetcher, which reads the web, and a writer, which changes files or records.
* **Give the agent one narrow custom tool.** Your application runs the tool, checks its input, and holds the credential. The support agent uses this design, not the split. See [Answer tool calls that pause the session](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#answer-tool-calls-that-pause-the-session).
* **Keep a person in the loop.** Use `always_ask` on the powerful tool so a person approves each call.

The split uses three agents:

| Agent                                  | Reads                                             | Holds                                                                                                                                                                                         | Passes on                                                   |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Lead (the agent that the session runs) | Your message, and what the other agents send back | No built-in tools. The `predefined_agents` (java, php: `predefinedAgents`; csharp, go: `PredefinedAgents`) list of its `subagents` (csharp, go: `Subagents`) names the fetcher and the writer | A task to each agent                                        |
| Fetcher                                | Webpages and search results                       | `web_fetch` and `web_search` only, each with `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`)                                                                    | Short results, in a format you ask for in its system prompt |
| Writer                                 | The task from the lead                            | The tools that write files, run commands, or change records, on `auto` or `always_ask`. No web tools                                                                                          | Its result                                                  |

The fetcher’s results are built from untrusted pages, and the lead can pass their text on to the writer. Keep `auto` or `always_ask` on the writer’s tools. The fetcher can still send some of what it reads to the sites on its `web_fetch` list, and to the search provider in its queries.

Agents in one multiagent session [share the sandbox](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#how-it-works), its files, and the vault credentials, so this split separates only their tools and conversations. For a stronger split, use two sessions with separate environments and vaults. Have your application pass only fixed fields, such as an order ID, between the two sessions.

## Set limits and a way to stop

Set a budget when you create each session, and decide in advance how you stop an agent.

| Control                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session budget                                                                                                        | A cap on spend at public list prices. At the cap, the session and each [thread](https://platform.claude.com/docs/en/managed-agents/session-threads) pause. Requests in progress can complete and their tool calls still run, so spend can pass the cap. See [When a session reaches its budget](https://platform.claude.com/docs/en/managed-agents/budgets#when-a-session-reaches-its-budget) |
| Deployment budget                                                                                                     | The same cap, applied to each session a deployment starts                                                                                                                                                                                                                                                                                                                                     |
| [`user.interrupt` event](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent) | Stops the model response immediately. A running tool call can complete first. The session goes `idle`, unless a workflow run keeps it `running`, and resumes on your next message. An interrupt ends no workflow run                                                                                                                                                                          |
| Archive or delete a session                                                                                           | Archiving keeps the history and blocks new events. Deleting is permanent. It deletes the record, events, and sandbox                                                                                                                                                                                                                                                                          |
| Pause or archive a deployment                                                                                         | Pausing stops new scheduled runs but still allows manual runs. Archiving ends the schedule permanently. Sessions already running keep running                                                                                                                                                                                                                                                 |
| Archive or delete a vault or credential                                                                               | Removes the secret from running sessions without a restart. Allow for a delay. The sessions keep running, so interrupt them too. A token the agent already fetched with the secret stays in the sandbox                                                                                                                                                                                       |

To stop a running agent, follow these steps:

1. Send `user.interrupt` by itself.
2. For a scheduled agent, also pause the deployment so that no new scheduled run starts. To end the schedule permanently, archive the deployment.
3. If a key might be exposed, rotate it at the service that issued it.
4. If the agent has workflow runs open, also send a `user.message` that asks it to stop them, because an interrupt ends no run. See [Interrupt a session with runs open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open) for the tool calls to cancel first.
5. Wait for the session to go `idle`. A running session cannot be archived or deleted.
6. Archive the session to keep its history. Delete it when you no longer need the history.

An interrupt does not undo what the agent already did or sent. Archiving an agent does not stop its running sessions.

A budget’s `max_list_cost.amount` (java, php: `maxListCost.amount`; csharp, go: `MaxListCost.Amount`) is a whole number of US cents written as a string, so `"125"` means $1.25 USD. See [Set a budget at session creation](https://platform.claude.com/docs/en/managed-agents/budgets#set-a-budget-at-session-creation).

You cannot add a budget to a session created without one. To change or remove a cap, see [Resume a session at its budget](https://platform.claude.com/docs/en/managed-agents/budgets#resume-a-session-at-its-budget). After you remove a session’s cap, you cannot set a new one.

A budget caps spending, but it does not limit what the agent does before the cap. To keep workloads with different trust levels apart, use separate [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces). Limit each workload to one workspace: where you can, a [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) rule enabled only in it, otherwise an API key scoped to it. Access to several workspaces lets the workload act in any of them.

See [Session budgets](https://platform.claude.com/docs/en/managed-agents/budgets), [Session operations](https://platform.claude.com/docs/en/managed-agents/session-operations#archiving-a-session), and [Scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments#managing-deployment-lifecycle).

## Next steps

<CardGroup cols={2}>
  <Card title="Cloud environment setup" icon="cloud" href="https://platform.claude.com/docs/en/managed-agents/environments">
    Networking modes, allowed hosts, and package managers.
  </Card>

  <Card title="Permission policies" icon="check" href="https://platform.claude.com/docs/en/managed-agents/permission-policies">
    Approval policies and confirmation requests.
  </Card>

  <Card title="Authenticate with vaults" icon="lock" href="https://platform.claude.com/docs/en/managed-agents/vaults">
    Credential types, injection locations, and rotation.
  </Card>

  <Card title="Session budgets" icon="coins" href="https://platform.claude.com/docs/en/managed-agents/budgets">
    Caps, resuming at a budget, and budgets on deployments.
  </Card>
</CardGroup>
