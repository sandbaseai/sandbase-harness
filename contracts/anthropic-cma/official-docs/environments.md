---
title: Cloud environment setup
url: https://platform.claude.com/docs/en/managed-agents/environments
description: Customize cloud sandboxes for your sessions.
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

Environments define the sandbox configuration where your agent runs. You create an environment once, then reference its ID each time you start a session. Multiple sessions can share the same environment, but each session gets its own isolated sandbox (a fresh Linux container).

This page covers `type: cloud` environments. To run sandboxes on your own infrastructure, see [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes). To choose between the two, see [Choosing an agent environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment).

## Create an environment

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/environments \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "python-dev",
      "config": {
        "type": "cloud",
        "networking": {"type": "limited", "allow_package_managers": true}
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
      name: python-dev
      config:
        type: cloud
        networking:
          type: limited
          allow_package_managers: true
      ```
    </File>

    [`ant apply`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply) creates the environment from `environment.yaml`, prints its ID, and records it in `claude-lock.json`. Commit `claude-lock.json` so the next `ant apply` updates this environment instead of attempting to create it again.
  </CodeGroupItem>

  ```python Python
  environment = client.beta.environments.create(
      name="python-dev",
      config={
          "type": "cloud",
          "networking": {"type": "limited", "allow_package_managers": True},
      },
  )

  print(f"Environment ID: {environment.id}")
  ```

  ```typescript TypeScript
  const environment = await client.beta.environments.create({
    name: "python-dev",
    config: {
      type: "cloud",
      networking: { type: "limited", allow_package_managers: true }
    }
  });

  console.log(`Environment ID: ${environment.id}`);
  ```

  ```csharp C#
  var environment = await client.Beta.Environments.Create(new()
  {
      Name = "python-dev",
      Config = new BetaCloudConfigParams
      {
          Networking = new BetaLimitedNetworkParams
          {
              AllowPackageManagers = true,
          },
      },
  });

  Console.WriteLine($"Environment ID: {environment.ID}");
  ```

  ```go Go
  environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
  	Name: "python-dev",
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

  ```java Java
  var environment = client.beta().environments().create(EnvironmentCreateParams.builder()
      .name("python-dev")
      .config(BetaCloudConfigParams.builder()
          .networking(BetaLimitedNetworkParams.builder()
              .allowPackageManagers(true)
              .build())
          .build())
      .build());
  IO.println("Environment ID: " + environment.id());
  ```

  ```php PHP
  $environment = $client->beta->environments->create(
      name: 'python-dev',
      config: [
          'type' => 'cloud',
          'networking' => ['type' => 'limited', 'allow_package_managers' => true],
      ],
  );
  echo "Environment ID: {$environment->id}\n";
  ```

  ```ruby Ruby
  environment = client.beta.environments.create(
    name: "python-dev",
    config: {
      type: "cloud",
      networking: {type: "limited", allow_package_managers: true}
    }
  )

  puts "Environment ID: #{environment.id}"
  ```
</CodeGroup>

Use a unique, descriptive `name` (csharp, go: `Name`) so you can tell environments apart. This example uses `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking) with package managers allowed, so the sandbox can reach the package registries and code hosts. To let it reach other hosts, add them to `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`).

## Use the environment in a session

Pass the environment ID as a string when [creating a session](https://platform.claude.com/docs/en/managed-agents/sessions).

<CodeGroup>
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$AGENT_ID"'",
      "environment_id": "'"$ENVIRONMENT_ID"'"
    }'
  ```

  ```bash CLI
  ant beta:sessions create --agent "$AGENT_ID" --environment-id "$ENVIRONMENT_ID"
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=agent.id,
      environment_id=environment.id,
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = agent.ID,
      EnvironmentID = environment.ID,
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent: anthropic.BetaSessionNewParamsAgentUnion{
  		OfString: anthropic.String(agent.ID),
  	},
  	EnvironmentID: environment.ID,
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var session = client.beta().sessions().create(SessionCreateParams.builder()
      .agent(agent.id())
      .environmentId(environment.id())
      .build());
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $agent->id,
      environmentID: $environment->id,
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: agent.id,
    environment_id: environment.id
  )
  ```
</CodeGroup>

## Configuration options

### Packages

The `packages` (csharp, go: `Packages`) field pre-installs packages into the sandbox before the agent starts. Packages are installed by their respective package managers and cached across sessions that share the same environment. When multiple package managers are specified, they run in alphabetical order (apt, cargo, gem, go, npm, pip). You can optionally pin specific versions. Unpinned packages install the latest version. If the environment uses `limited` [networking](https://platform.claude.com/docs/en/managed-agents/environments#networking), also set `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) in `networking` (csharp, go: `Networking`) to `true`; otherwise the request is rejected with a 400 error.

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/environments \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "data-analysis",
      "config": {
        "type": "cloud",
        "packages": {
          "pip": ["pandas", "numpy", "scikit-learn"],
          "npm": ["express"]
        },
        "networking": {"type": "limited", "allow_package_managers": true}
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
      name: data-analysis
      config:
        type: cloud
        packages:
          pip:
            - pandas
            - numpy
            - scikit-learn
          npm:
            - express
        networking:
          type: limited
          allow_package_managers: true
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  environment = client.beta.environments.create(
      name="data-analysis",
      config={
          "type": "cloud",
          "packages": {
              "pip": ["pandas", "numpy", "scikit-learn"],
              "npm": ["express"],
          },
          "networking": {"type": "limited", "allow_package_managers": True},
      },
  )
  ```

  ```typescript TypeScript
  const environment = await client.beta.environments.create({
    name: "data-analysis",
    config: {
      type: "cloud",
      packages: {
        pip: ["pandas", "numpy", "scikit-learn"],
        npm: ["express"]
      },
      networking: { type: "limited", allow_package_managers: true }
    }
  });
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Environments;

  var environment = await client.Beta.Environments.Create(new()
  {
      Name = "data-analysis",
      Config = new BetaCloudConfigParams
      {
          Packages = new()
          {
              Pip = ["pandas", "numpy", "scikit-learn"],
              Npm = ["express"],
          },
          Networking = new BetaLimitedNetworkParams
          {
              AllowPackageManagers = true,
          },
      },
  });
  ```

  ```go Go
  environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
  	Name: "data-analysis",
  	Config: anthropic.BetaEnvironmentNewParamsConfigUnion{
  		OfCloud: &anthropic.BetaCloudConfigParams{
  			Packages: anthropic.BetaPackagesParams{
  				Pip: []string{"pandas", "numpy", "scikit-learn"},
  				Npm: []string{"express"},
  			},
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
  ```

  ```java Java
  import com.anthropic.models.beta.environments.*;
  import java.util.List;

  var environment = client.beta().environments().create(EnvironmentCreateParams.builder()
      .name("data-analysis")
      .config(BetaCloudConfigParams.builder()
          .packages(BetaPackagesParams.builder()
              .pip(List.of("pandas", "numpy", "scikit-learn"))
              .npm(List.of("express"))
              .build())
          .networking(BetaLimitedNetworkParams.builder()
              .allowPackageManagers(true)
              .build())
          .build())
      .build());
  ```

  ```php PHP
  $environment = $client->beta->environments->create(
      name: 'data-analysis',
      config: [
          'type' => 'cloud',
          'packages' => [
              'pip' => ['pandas', 'numpy', 'scikit-learn'],
              'npm' => ['express'],
          ],
          'networking' => ['type' => 'limited', 'allow_package_managers' => true],
      ],
  );
  ```

  ```ruby Ruby
  environment = client.beta.environments.create(
    name: "data-analysis",
    config: {
      type: "cloud",
      packages: {
        pip: %w[pandas numpy scikit-learn],
        npm: %w[express]
      },
      networking: {type: "limited", allow_package_managers: true}
    }
  )
  ```
</CodeGroup>

Supported package managers:

| Field   | Package manager           | Example                                     |
| ------- | ------------------------- | ------------------------------------------- |
| `apt`   | System packages (apt-get) | `"graphviz"`                                |
| `cargo` | Rust (cargo)              | `"hyperfine@1.18.0"`                        |
| `gem`   | Ruby (gem)                | `"rails:7.1.0"`                             |
| `go`    | Go modules                | `"golang.org/x/tools/cmd/goimports@latest"` |
| `npm`   | Node.js (npm)             | `"express@4.18.0"`                          |
| `pip`   | Python (pip)              | `"sqlalchemy==2.0.30"`                      |

### Networking

The `networking` (csharp, go: `Networking`) field controls the sandbox’s outbound network access.

With `limited` networking, `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) also applies to the `web_search` and `web_fetch` tools, which run on Anthropic’s servers. A `web_fetch` call for a URL on a host that `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) does not match returns an error result to the agent. `web_search` omits results from hosts that `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) does not match. `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) and `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) add no hosts for these tools. When `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) lists no hosts, no `web_fetch` or `web_search` call returns a page or a search result. A host that you add to `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) for these tools is also open to the sandbox. `unrestricted` networking and self-hosted environments do not limit these tools. To restrict them further, set `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) or `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) on the tool’s entry in the agent toolset. See [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).

| Mode           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limited`      | Restricts sandbox network access to the hosts in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Set `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) and `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) to `true` to allow additional access. Use this mode unless the agent must reach sites you cannot list in advance. |
| `unrestricted` | Full outbound network access, except for a general safety blocklist. Before you use it, read [Risks of unrestricted networking](https://platform.claude.com/docs/en/managed-agents/environments#risks-of-unrestricted-networking).                                                                                                                                                                                                                                           |

<Note>
  Set `networking` (csharp, go: `Networking`) explicitly in API requests; a create request that omits it gets `unrestricted`. The Claude Console’s form for creating an environment starts with **Limited** selected and nothing else allowed.
</Note>

The following example creates an environment with `limited` networking:

<CodeGroup defaultLanguage="CLI">
  ```bash cURL
  curl -fsS https://api.anthropic.com/v1/environments \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "name": "api-access",
      "config": {
        "type": "cloud",
        "networking": {
          "type": "limited",
          "allowed_hosts": ["api.example.com"],
          "allow_mcp_servers": true,
          "allow_package_managers": true
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
      name: api-access
      config:
        type: cloud
        networking:
          type: limited
          allowed_hosts:
            - api.example.com
          allow_mcp_servers: true
          allow_package_managers: true
      ```
    </File>
  </CodeGroupItem>

  ```python Python
  environment = client.beta.environments.create(
      name="api-access",
      config={
          "type": "cloud",
          "networking": {
              "type": "limited",
              "allowed_hosts": ["api.example.com"],
              "allow_mcp_servers": True,
              "allow_package_managers": True,
          },
      },
  )
  ```

  ```typescript TypeScript
  const environment = await client.beta.environments.create({
    name: "api-access",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: ["api.example.com"],
        allow_mcp_servers: true,
        allow_package_managers: true
      }
    }
  });
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Environments;

  var environment = await client.Beta.Environments.Create(new()
  {
      Name = "api-access",
      Config = new BetaCloudConfigParams
      {
          Networking = new BetaLimitedNetworkParams
          {
              AllowedHosts = ["api.example.com"],
              AllowMcpServers = true,
              AllowPackageManagers = true,
          },
      },
  });
  ```

  ```go Go
  environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
  	Name: "api-access",
  	Config: anthropic.BetaEnvironmentNewParamsConfigUnion{
  		OfCloud: &anthropic.BetaCloudConfigParams{
  			Networking: anthropic.BetaCloudConfigParamsNetworkingUnion{
  				OfLimited: &anthropic.BetaLimitedNetworkParams{
  					AllowedHosts:         []string{"api.example.com"},
  					AllowMCPServers:      anthropic.Bool(true),
  					AllowPackageManagers: anthropic.Bool(true),
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
      .name("api-access")
      .config(BetaCloudConfigParams.builder()
          .networking(BetaLimitedNetworkParams.builder()
              .allowedHosts(List.of("api.example.com"))
              .allowMcpServers(true)
              .allowPackageManagers(true)
              .build())
          .build())
      .build());
  ```

  ```php PHP
  $environment = $client->beta->environments->create(
      name: 'api-access',
      config: [
          'type' => 'cloud',
          'networking' => [
              'type' => 'limited',
              'allowed_hosts' => ['api.example.com'],
              'allow_mcp_servers' => true,
              'allow_package_managers' => true,
          ],
      ],
  );
  ```

  ```ruby Ruby
  environment = client.beta.environments.create(
    name: "api-access",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: %w[api.example.com],
        allow_mcp_servers: true,
        allow_package_managers: true
      }
    }
  )
  ```
</CodeGroup>

<Info>
  Use `limited` networking with an explicit `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) list. Follow the principle of least privilege by granting only the minimum network access your agent requires, and regularly audit your allowed domains.
</Info>

With `limited` networking and no other fields set, no hosts are allowed. Files, memory stores, and GitHub repositories that you attach to the session stay available. When a request from the sandbox on port 80 or 443 is refused because its host is not allowed, the response is a 403 that names the blocked host.

When using `limited` networking:

* `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) specifies domains the sandbox can reach. Specify bare hostnames or wildcard patterns (such as `*.example.com`). Do not include a URL scheme, port, or path. A bare hostname matches that exact host: `example.com` does not match `www.example.com`. `*.example.com` matches every subdomain of `example.com`, but not `example.com` itself.
* `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) allows outbound access to MCP server endpoints configured on the agent, beyond those listed in the `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) array. Defaults to `false`. While it is `false`, session creation fails with a 400 error if the agent declares an MCP server whose host is not in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). The same applies to [an agent it can delegate to](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration). To fix it, add the host to `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) or set `allow_mcp_servers` (java: `allowMcpServers`; php: `allowMCPServers`; csharp: `AllowMcpServers`; go: `AllowMCPServers`) to `true`.
* `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) allows outbound access to a set of public package registries and code hosts beyond those listed in the `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) array. See [Package manager hosts](https://platform.claude.com/docs/en/managed-agents/environments#package-manager-hosts) for the list. Defaults to `false`. Set it to `true` whenever the environment specifies `packages` (csharp, go: `Packages`); otherwise the request is rejected with a 400 error, even if the registry hosts are listed in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`).

#### Package manager hosts

When `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) is `true`, the sandbox can reach the following hosts in addition to those in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Anthropic maintains this list and can change it.

| Ecosystem    | Hosts                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code hosting | `github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `gitlab.com`, `bitbucket.org` |
| Node.js      | `registry.npmjs.org`, `registry.yarnpkg.com`, `nodejs.org`                                                                                                                                 |
| Python       | `pypi.org`, `files.pythonhosted.org`                                                                                                                                                       |
| Rust         | `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org`                                                                                                                 |
| Go           | `proxy.golang.org`, `sum.golang.org`                                                                                                                                                       |
| Java         | `repo1.maven.org`, `repo.maven.apache.org`, `services.gradle.org`, `plugins.gradle.org`, `plugins-artifacts.gradle.org`                                                                    |
| Ruby         | `rubygems.org`, `index.rubygems.org`                                                                                                                                                       |
| PHP          | `packagist.org`, `repo.packagist.org`                                                                                                                                                      |
| Ubuntu (apt) | `archive.ubuntu.com`, `security.ubuntu.com`, `ppa.launchpad.net`                                                                                                                           |
| Containers   | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`, `download.docker.com`, `ghcr.io`                                                                             |

<Warning>
  Network access is granted by host, not by operation. The sandbox can send any request to an allowed host, including uploads such as `git push` and package publishing, with any credential the command supplies. If the agent processes untrusted input (repository files, fetched web content, or third-party tool output), a successful prompt injection could use an allowed host to copy files out of the sandbox. To reduce this risk, set the `bash` tool’s [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies) to `always_ask` or `auto`. If the environment does not specify `packages` (csharp, go: `Packages`), you can instead leave `allow_package_managers` (java, php: `allowPackageManagers`; csharp, go: `AllowPackageManagers`) set to `false` and list only the hosts your agent needs in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`).
</Warning>

#### Risks of unrestricted networking

With `unrestricted` networking, code in the sandbox can send requests to any host on the internet, except for hosts on a general safety blocklist. Before you choose this mode, consider what the agent can do with that access:

* **The agent can change things on external sites, not only read them:** The `bash` tool can send any request. The agent can post data, submit forms, call APIs, and run scripts that change data on external sites. Even a request that only fetches a URL can change data on some sites.
* **Nothing pauses these requests by default:** The agent toolset’s default [permission policy](https://platform.claude.com/docs/en/managed-agents/permission-policies) is `always_allow`, so `bash` commands run without approval.
* **Anything in the sandbox can leave it:** This includes files, tool outputs, and any credentials or secrets you put in the sandbox.
* **Fetched content can steer the agent:** Webpages, API responses, and other content the agent reads can contain instructions (prompt injection) that change what it does next.
* **The agent acts on your behalf:** Its actions can violate a site’s terms of service, or create accounts and records there.
* **Model behavior is not a security control:** The agent can act on external sites in ways you did not ask for, including retrying in a different way after a site blocks a request. Use network settings and permission policies to limit what it can do.
* **The safety blocklist is not an allowlist:** It does not limit which other sites the agent reaches, or what the agent does on them.

To reduce these risks, use `limited` networking with an explicit list of hosts. The following `networking` value allows `api.example.com`, plus the [package manager hosts](https://platform.claude.com/docs/en/managed-agents/environments#package-manager-hosts) for an agent that installs packages:

```json
{
  "type": "limited",
  "allowed_hosts": ["api.example.com"],
  "allow_package_managers": true
}
```

An agent that only uses the `web_search` and `web_fetch` tools does not need `unrestricted` networking if you can list the sites it needs. With `limited` networking, `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) also applies to those tools (see [Networking](https://platform.claude.com/docs/en/managed-agents/environments#networking)), so list those sites in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`). Listing them in `web_search`’s `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) too makes it search those sites. A host that you add to `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) is also open to the sandbox. To restrict the tools further, see [Restrict web search and web fetch domains](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions).

Use `unrestricted` only when the agent must reach sites you cannot list in advance. In that case, keep secrets and sensitive files out of the sandbox, and give the agent only the credentials the task needs. Consider setting the `bash` tool’s permission policy to `always_ask` or `auto`, and [watch the session’s events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).

## Environment lifecycle

* Environments persist until explicitly archived or deleted.
* Each session gets its own sandbox instance, even when multiple sessions reference the same environment. Sessions do not share filesystem state.
* Environments are not versioned. If you update an environment frequently, keep your own record of the changes so you can tell which configuration each session used.

## Manage environments

<CodeGroup>
  ```bash cURL
  # List environments
  curl -fsS https://api.anthropic.com/v1/environments \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"

  # Retrieve a specific environment
  curl -fsS "https://api.anthropic.com/v1/environments/$ENVIRONMENT_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"

  # Archive an environment (read-only, existing sessions continue)
  curl -fsS -X POST "https://api.anthropic.com/v1/environments/$ENVIRONMENT_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"

  # Delete an environment (only if no sessions reference it)
  curl -fsS -X DELETE "https://api.anthropic.com/v1/environments/$ENVIRONMENT_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  # List environments
  ant beta:environments list

  # Retrieve a specific environment
  ant beta:environments retrieve --environment-id "$ENVIRONMENT_ID"

  # Archive an environment (read-only, existing sessions continue)
  ant beta:environments archive --environment-id "$ENVIRONMENT_ID"

  # Delete an environment (only if no sessions reference it)
  ant beta:environments delete --environment-id "$ENVIRONMENT_ID"
  ```

  ```python Python
  # List environments
  environments = client.beta.environments.list()

  # Retrieve a specific environment
  env = client.beta.environments.retrieve(environment.id)

  # Archive an environment (read-only, existing sessions continue)
  client.beta.environments.archive(environment.id)

  # Delete an environment (only if no sessions reference it)
  client.beta.environments.delete(environment.id)
  ```

  ```typescript TypeScript
  // List environments
  const environments = await client.beta.environments.list();

  // Retrieve a specific environment
  const env = await client.beta.environments.retrieve(environment.id);

  // Archive an environment (read-only, existing sessions continue)
  await client.beta.environments.archive(environment.id);

  // Delete an environment (only if no sessions reference it)
  await client.beta.environments.delete(environment.id);
  ```

  ```csharp C#
  // List environments
  var environments = await client.Beta.Environments.List();

  // Retrieve a specific environment
  var env = await client.Beta.Environments.Retrieve(environment.ID);

  // Archive an environment (read-only, existing sessions continue)
  await client.Beta.Environments.Archive(environment.ID);

  // Delete an environment (only if no sessions reference it)
  await client.Beta.Environments.Delete(environment.ID);
  ```

  ```go Go
  // List environments
  environments, err := client.Beta.Environments.List(ctx, anthropic.BetaEnvironmentListParams{})
  // ...

  // Retrieve a specific environment
  env, err := client.Beta.Environments.Get(ctx, environment.ID, anthropic.BetaEnvironmentGetParams{})
  // ...

  // Archive an environment (read-only, existing sessions continue)
  _, err = client.Beta.Environments.Archive(ctx, environment.ID, anthropic.BetaEnvironmentArchiveParams{})
  // ...

  // Delete an environment (only if no sessions reference it)
  _, err = client.Beta.Environments.Delete(ctx, environment.ID, anthropic.BetaEnvironmentDeleteParams{})
  ```

  ```java Java
  // List environments
  var environments = client.beta().environments().list();
  // Retrieve a specific environment
  var env = client.beta().environments().retrieve(environment.id());
  // Archive an environment (read-only, existing sessions continue)
  client.beta().environments().archive(environment.id());
  // Delete an environment (only if no sessions reference it)
  client.beta().environments().delete(environment.id());
  ```

  ```php PHP
  // List environments
  $environments = $client->beta->environments->list();
  // Retrieve a specific environment
  $env = $client->beta->environments->retrieve($environment->id);
  // Archive an environment (read-only, existing sessions continue)
  $client->beta->environments->archive($environment->id);
  // Delete an environment (only if no sessions reference it)
  $client->beta->environments->delete($environment->id);
  ```

  ```ruby Ruby
  # List environments
  environments = client.beta.environments.list

  # Retrieve a specific environment
  env = client.beta.environments.retrieve(environment.id)

  # Archive an environment (read-only, existing sessions continue)
  client.beta.environments.archive(environment.id)

  # Delete an environment (only if no sessions reference it)
  client.beta.environments.delete(environment.id)
  ```
</CodeGroup>

## Pre-installed runtimes

Cloud sandboxes include common language runtimes, databases, and command-line tools out of the box. See [Cloud sandbox reference](https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference) for the full list.

## Next steps

<CardGroup cols={2}>
  <Card title="Cloud sandbox reference" icon="book" href="https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference">
    Pre-installed packages, databases, and utilities available in cloud sandboxes.
  </Card>

  <Card title="Start a session" icon="play" href="https://platform.claude.com/docs/en/managed-agents/sessions">
    Create a session to run your agent and start running tasks.
  </Card>
</CardGroup>

## Availability

Cloud sandboxes are available on every model.

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
