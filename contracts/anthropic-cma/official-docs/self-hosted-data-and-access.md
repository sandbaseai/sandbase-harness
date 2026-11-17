---
title: Data and access in self-hosted Claude Managed Agents
url: https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access
description: What self-hosted Claude Managed Agents sends outside your network, where its log, traces, and metrics go, how long data is kept, who can reach the server, and how to keep tenants apart.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

With [self-hosted Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted), you run the server, its database, and the sandboxes where workers run the agent’s shell and file tools. This page answers the questions of a security review. The server’s inference provider is the service that answers its model calls. The server connects to Anthropic only when that provider is the Claude API. Anthropic has no remote access to the server or its log.

## What leaves your network

### Every connection that the server makes

The server connects only to these destinations:

* Your inference provider
* The server’s database
* The services that issue the server’s credential for model calls, if it gets that credential from a service
* A cloud provider’s service for listing models, if your inference provider lists its models on a separate service
* The MCP servers that you allow
* The Git hosts that you allow, for the repositories that sessions use
* An OpenTelemetry collector, if you configure one
* The identity providers that you list for single sign-on, if you configure any
* A secret manager or a key management service, if you configure one
* The services that issue the server’s credential for that secret manager or key management service
* Any other service that you configure the server to call

The default inference provider is the Claude API. If you configure another inference provider, the model calls go there instead. The server connects to Anthropic only when the Claude API is its inference provider.

Where the inference provider offers the web search and web fetch tools, it runs them. The server makes no connection of its own for them. The tools are off until you turn them on in the server’s settings.

To check the server’s traffic, compare your egress proxy or firewall log with this list. The server’s requests to the Claude API carry a `User-Agent` header. See [Fields that name the server software](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#fields-that-name-the-server-software).

### What workers can reach

The list of destinations covers only the server. The [egress gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#environment-variable-credentials), if you run it, connects to the hosts that you list for it, and sends them the credential values that you store for them. Workers are separate. A worker has whatever network access you allow the container, VM, or other sandbox that it runs in. Every command that an agent runs through the worker has the same network access.

### What the server sends to its inference provider

Each model call carries the conversation so far, including prompts, tool inputs, and tool results.

When the Claude API is the inference provider, each model call also carries up to three headers. They hold IDs that your server generated:

| Header                                    | What it holds                              |
| ----------------------------------------- | ------------------------------------------ |
| `anthropic-managed-agents-session-id`     | The ID of the session that the call serves |
| `anthropic-managed-agents-agent-id`       | The ID of that session’s agent             |
| `anthropic-managed-agents-environment-id` | The ID of that session’s environment       |

An ID holds no name and no content, but it does encode the time when your server created it. With these headers, Anthropic can attribute usage to a session, an agent, or an environment. No setting turns them off. If `ANTHROPIC_BASE_URL` names a proxy or a gateway, the headers go there. Under any other inference provider, the server never sends them.

When the Claude API is the inference provider, the server also checks with the Claude API that its credential for model calls is valid. It checks at startup and then every 60 seconds, unless you change `health.check_interval`. These checks run no inference, and carry none of the three headers.

### Fields that name the server software

Every request to the Claude API has a `User-Agent` header that names the server software and its version. The header itself doesn’t identify your deployment. As on every Claude API request, the API key identifies your organization. Anthropic can use that header to count usage of self-hosted Managed Agents.

Model calls can also carry the label `cma-server`, in the request body as `metadata.user_id`. The label is the same on every server, so the label itself doesn’t identify your deployment, your users, or your sessions. Where a call reaches Anthropic, Anthropic can use the label to count usage of self-hosted Managed Agents, even if a proxy removed the `User-Agent` header.

Whether a call carries the label depends on where it goes:

* **The server sends the label on these calls:** calls to the Claude API, to Microsoft Foundry, and to a model gateway that accepts the same requests as the Claude API.
* **The server never sends `metadata.user_id` on these calls:** calls to Amazon Bedrock, to Claude Models on Google Cloud (Google managed), and to a model gateway that takes another request format.

If a model gateway or proxy passes a call on to another provider, `metadata.user_id` can go with it. On the calls that carry `metadata.user_id`, a proxy or gateway of your own must accept it in the request body. If it rejects the field, every model call fails.

## Where the log, traces, and metrics go

The server writes its log to standard error. When you run the server under Docker, Kubernetes, or a service manager, that system collects the log from standard error.

The server records no traces or metrics until you turn them on with the standard OpenTelemetry environment variables. It sends them only where those variables point. A Prometheus endpoint can also expose metrics. See [Where the server listens](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#where-the-server-listens).

## How long data is kept

Your log pipeline, your collector, and your tracing backend determine how long the log, traces, and metrics are kept. The server keeps no log files and stores no traces or metrics.

The server stores everything else, such as agents, sessions, and session history, in your database. If you set up no database, which is the default, the server holds that data in memory, and a restart erases it. If you configure a secret manager, the server keeps the secret of each new [vault credential](https://platform.claude.com/docs/en/managed-agents/vaults) there instead of in the database. Secrets that it stored earlier stay in the database.

Sessions and their history stay in your database until you delete them. The server doesn’t delete a session because of its age, archived or not. Deleting a session through the API removes the session and its history from your database, though the server keeps the session’s ID. The server can refuse the delete while a session is running. The delete doesn’t reach copies elsewhere, such as database backups, exported logs and traces, or what the agent wrote to a [memory store](https://platform.claude.com/docs/en/managed-agents/memory). On Kubernetes, the delete also leaves the session’s `/workspace` volume in place, as [Free a session’s volume](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#free-a-sessions-volume) describes.

What the server sends to the model, and what the model returns, fall under your organization’s agreement with the provider that serves the model. The agreement’s data retention terms apply. When the Claude API serves the model, the data retention agreement and settings that your organization has with Anthropic apply. If your organization has a [zero data retention (ZDR)](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#zero-data-retention-zdr-scope) arrangement, it covers these model calls in the same way as other Messages API calls.

The API and data retention page lists Claude Managed Agents as [not covered by ZDR](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#what-zdr-does-not-cover). That is because when Anthropic runs the service, it stores session transcripts until you delete them. Who stores the transcripts depends on who runs the service:

* **Anthropic runs it:** Anthropic stores them. With [self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes), you host only the sandboxes, and Anthropic runs the rest.
* **You run it, with self-hosted Managed Agents:** You store them yourself.

## Who can reach the server

Anthropic has no remote access to the server or its log. Your applications and workers connect to the server. The server never connects to a worker.

### Credentials that the server accepts

Anthropic issues none of the credentials that the server accepts, and it holds none of them. Every credential that the server accepts is one of these:

* One that you set or created
* One that your identity provider issued
* One that the server generated itself, such as the token it hands a worker with each piece of work

### Where the server listens

The server accepts API requests on one address and port. The server opens two more listeners, each only if you turn it on.

| Listener                                                                                                                                                       | On by default                                                                                                                                     | Default address                                                                                             | What it asks for                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API requests                                                                                                                                                   | Yes                                                                                                                                               | `127.0.0.1:8400`, which only the same machine can reach. To change the address and port, set `server.addr`. | See [Credentials that the server accepts](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#credentials-that-the-server-accepts). |
| The [console on your server](https://platform.claude.com/docs/en/managed-agents/self-hosted/console), a webpage                                                | Yes. To stop serving it, see [Turn off the console](https://platform.claude.com/docs/en/managed-agents/self-hosted/console#turn-off-the-console). | The same address and port as API requests                                                                   | Nothing to load the page, for anyone who can reach it. To do anything in the console, a person signs in through your identity provider.                        |
| The Prometheus metrics endpoint                                                                                                                                | No                                                                                                                                                | `localhost:9464`, which only the same machine can reach                                                     | No credential                                                                                                                                                  |
| The server’s listener for the [egress gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#environment-variable-credentials) | No                                                                                                                                                | Port 8410 on every interface                                                                                | The gateway’s key                                                                                                                                              |

More detail on the last two listeners:

* **The Prometheus metrics endpoint:** It asks for no credential, so who can reach it depends on where it listens. If you set `OTEL_METRICS_EXPORTER` to `prometheus` and set no address, it listens on the default address. If you turn it on through the server Helm chart, it listens on port 9464 of every server pod. Anything with a route to a pod’s address can then reach it, unless a NetworkPolicy blocks that traffic.
* **The listener for the egress gateway:** The egress gateway is an optional proxy between your sandboxes and the internet. The server listens for the gateway on a separate port. This listener speaks plain HTTP, and its answers carry stored credential values. The Compose stack and the server Helm chart let only the gateway reach it. If you run the server any other way, do the same.

The Docker Compose stack publishes port 8400 on the Docker host’s loopback address, `127.0.0.1`. Run Docker Engine 28.3.3 or later. Under some earlier releases, machines on the host’s local network can reach a port that is published on loopback. To publish the port on another address, set `CMA_PUBLISH_ADDRESS` in `.env`.

## Multitenancy

Each deployment serves one tenant at one trust level. Environments in one deployment don’t keep trust levels apart. The server API key reaches every environment. Every caller with a role can run sessions in every environment, with whatever network and files that environment’s workers can reach.

| To keep apart                       | Do this                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenants                             | Give each tenant its own deployment, with its own database, server API key, and workers.                                                                                                                                                                                                                                                                               |
| Workloads at different trust levels | Give each trust level its own deployment, set up as for a tenant. Examples are trusted and untrusted code, or workers that reach systems that only some callers may use.                                                                                                                                                                                               |
| Callers in a deployment             | Turn on [single sign-on](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#single-sign-on), map groups to the `developer` or `user` role, and keep the server API key for administrators. [What each role can do](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#what-each-role-can-do) shows what those callers see. |

### Secret managers, single sign-on, and model gateways

If your deployments use one of these services, also keep them apart there:

* **Secret manager:** Keep the deployments’ secrets apart, as in the [secret manager limits](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#limits).
* **Single sign-on:** Give each deployment `audiences` entries that no other deployment lists, so that it refuses the other deployments’ tokens. In each trust level’s deployment, give a role only to the callers allowed at that level, and set no `default_role`.
* **[Model gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#model-gateway):** To tell the deployments apart, give each one its own value for a header such as `x-tenant-id` under `inference.headers`.

### What roles don’t limit

Roles limit only the requests that a caller makes with their own token. Code that an agent runs can call the server with any credential that its sandbox holds. An [environment key](https://platform.claude.com/docs/en/managed-agents/self-hosted#the-three-credentials) can read events and post tool results in every session in its environment. So run each session in a sandbox of its own, and keep the environment key out of that sandbox. The stacks in [Get started with self-hosted Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart) and [Deploy on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes) do this.
