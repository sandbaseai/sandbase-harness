---
title: Get started with self-hosted Claude Managed Agents
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart
description: Start self-hosted Claude Managed Agents on one machine with Docker Compose and run a first session in a sandbox container.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

In this quickstart, you start self-hosted Claude Managed Agents on one machine with Docker Compose. The Compose stack is the server, its PostgreSQL database, and a set of workers that run each session in a sandbox container of its own. You then chat with an agent from your terminal and confirm that its tool calls ran in a sandbox container. You can then open the session in the [console on your server](https://platform.claude.com/docs/en/managed-agents/self-hosted/console).

<Warning>
  The Compose stack is for development, not for production. It serves plain HTTP, and by default publishes port 8400 only on the Docker host’s loopback address, `127.0.0.1`. Under some Docker Engine releases before 28.3.3, machines on the host’s local network can reach that port too. Agent tools run in containers on that host, so use a machine that holds nothing you need to protect.
</Warning>

For production, Anthropic recommends the release’s two Helm charts. See [Deploy on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes).

Let Claude Code run this quickstart for you

```text
Set up self-hosted Claude Managed Agents on this machine by following https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart.md. I've already downloaded the release archive.
```

If you’re an agent that runs these steps for a person:

* **Release archive:** Ask the person where the archive is. Only they can download it.
* **Claude API key:** Have the person edit `.env` themselves. Don’t ask for the key, and don’t print `.env`.
* **Variables:** If your shell doesn’t keep variables between commands, set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` again in each `ant` command. Without them, `ant` calls the hosted service.
* **Compose:** Put `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN` in front of each `docker compose` command, so that your shell’s values don’t reach the server.
* **Chat:** `ant beta:sessions connect` needs an interactive terminal. Without one, send the message with `ant beta:sessions:events send`, and read the reply with `ant beta:sessions:events list`. [Send events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#send-events) and [List past events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#list-past-events) have examples.
* **Console:** Do the section “Try the console on your server” only if the person asks for it. If your shell doesn’t keep variables between commands, also put `COMPOSE_FILE=docker-compose.yml:docker-compose.oidc.yml` in front of each `docker compose` command from that section on.

## Prerequisites

* **The release archive:** To request access to the download, contact your Anthropic account team. If your organization already has access, follow the note at the top of this page.
* **A Claude API key:** The server uses it for model calls. Create one in the [Claude Console](https://platform.claude.com/settings/keys).
* **Docker:** The [latest version of Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin (`docker compose`, not the older `docker-compose`).
* **A host with at least two CPUs:** x86-64 or Arm. On a smaller host, set `CMA_SANDBOX_CPUS` to its CPU count when you create `.env`.
* **Network access on first start:** The first build pulls from Docker Hub, the Alpine package repositories, and GitHub releases.
* **Tools:** On the machine where you run Docker, you need `openssl` and the [`ant` CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart#installation).

## Start the stack

<Steps>
  <Step title="Extract the archive">
    Extract the archive, and work from its `compose` directory. In the command, replace `<archive>` with your archive’s name, without `.tar.gz`.

    ```bash
    tar -xzf <archive>.tar.gz && cd <archive>/compose
    ```

    If your umask is stricter than `022`, the binaries lose their execute permission for other users, and the server container can’t start them. In that case, set it to `022` and extract the archive again.
  </Step>

  <Step title="Create the .env file">
    Compose reads the stack’s secrets from a `.env` file beside `docker-compose.yml`. Create the file:

    ```bash
    cat > .env <<EOF
    CMA_PG_PASSWORD=$(openssl rand -hex 32)
    ANTHROPIC_API_KEY=sk-ant-...
    CMA_SERVER__API_KEY=$(openssl rand -hex 32)
    CMA_STORE__CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)
    EOF
    chmod 600 .env
    ```

    Open `.env` in an editor and replace `sk-ant-...` with your Claude API key. The block generates the rest: the database password, the server API key that your applications send, and the key that encrypts the server’s stored secrets.
  </Step>

  <Step title="Start the containers">
    Build and start the stack, and then follow the server’s log:

    ```bash
    docker compose up --build -d
    docker compose logs -f cma-server
    ```

    When the log shows a line with `msg="cma-server listening"`, press Ctrl+C to stop following it.
  </Step>

  <Step title="Check that the server is ready">
    ```bash
    curl -s http://127.0.0.1:8400/cma-server/readyz
    ```

    A ready server answers with `"status":"ready"`. Right after start, it can answer `"status":"degraded"` for a few seconds while its first checks run. If it stays `degraded` or answers `"status":"not_ready"`, see [Troubleshooting](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart#troubleshooting).
  </Step>
</Steps>

## Run your first session

Create an agent and chat with it from your terminal with the `ant` CLI.

<Steps>
  <Step title="Point the CLI at your server">
    Open a second terminal in the same directory, and keep it for `ant`. The following commands set `ANTHROPIC_API_KEY` to your server API key, not your Claude API key, as [Call the API on a self-hosted server](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api) explains:

    ```bash
    export ANTHROPIC_BASE_URL=http://127.0.0.1:8400
    export ANTHROPIC_API_KEY=$(grep '^CMA_SERVER__API_KEY=' .env | cut -d= -f2)
    ```

    Keep `docker compose` commands in the first terminal. If you run `docker compose up` in this terminal, Compose passes these variables to the server, and the server calls itself instead of the Claude API.
  </Step>

  <Step title="Create an agent">
    Save the file that follows the command as `quickstart-agent.md`, and then run the command. The file gives the agent the built-in tools and lets it run them without asking you first.

    <CodeGroup>
      <CodeGroupItem>
        ```bash CLI
        ant apply --yes quickstart-agent.md
        ```

        <File filename="quickstart-agent.md">
          ```markdown
          ---
          name: Quickstart agent
          model: claude-opus-5-5
          tools:
            - type: agent_toolset_20260401
          ---

          You are a helpful assistant.
          ```
        </File>
      </CodeGroupItem>
    </CodeGroup>

    The command first prints a warning that it `could not determine the organization and workspace`, with a `404` error, and then creates the agent. That’s expected on your own server.
  </Step>

  <Step title="Start a session">
    These commands find the agent and the stack’s environment, start a session, and keep the session’s ID in `SESSION_ID`. The stack names its environment `compose-sandbox`.

    ```bash
    AGENT_ID=$(ant beta:agents list --format raw \
      --transform 'data.#(name=="Quickstart agent").id' --raw-output)
    ENVIRONMENT_ID=$(ant beta:environments list --format raw \
      --transform 'data.#(name=="compose-sandbox").id' --raw-output)
    SESSION_ID=$(ant beta:sessions create --agent "$AGENT_ID" \
      --environment-id "$ENVIRONMENT_ID" --transform id --raw-output)
    ```
  </Step>

  <Step title="Ask the agent to run a command">
    Connect your terminal to the session:

    ```bash
    ant beta:sessions connect "$SESSION_ID"
    ```

    The command opens a [chat view](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/sessions-connect) of the session. Send this message:

    ```text wrap
    Run `hostname` with the bash tool and tell me the output.
    ```

    The agent replies with a hostname that starts with `cma-sandbox-`. That’s the name of the sandbox container that ran the command, which confirms that the tool ran in a sandbox and not on your machine.
  </Step>

  <Step title="Find the sandbox container">
    Leave the chat open. In the first terminal, list the sandbox containers:

    ```bash
    docker ps --filter label=cma-server.sandbox
    ```

    The list shows the container that the agent reported. The container exits about a minute after a turn ends, and the session’s next message starts a new container. If the list is empty, ask the agent to run `hostname` again, and list the containers again while it replies.

    To leave the chat, press Ctrl+C in its terminal. The session keeps running.
  </Step>
</Steps>

## Try the console on your server

This section is optional. The console needs single sign-on. To try it, restart the stack with the release’s mock sign-in provider. Port 8080 on your machine must be free.

<Warning>
  Use the mock provider with throwaway data only. It gives an administrator’s token to anyone who reaches it. On Docker Desktop, that includes the sandbox containers. Under some Docker Engine releases before 28.3.3, it includes machines on your network.
</Warning>

<Steps>
  <Step title="Restart the stack with the mock sign-in provider">
    Run these commands in the first terminal:

    ```bash
    export COMPOSE_FILE=docker-compose.yml:docker-compose.oidc.yml
    docker compose up --build -d
    ```

    The `export` line holds for the first terminal only, so run it again in any new terminal that you open for `docker compose`. To change the server’s settings in this stack, edit `compose.config.oidc.yaml`, not `compose.config.yaml`, and then run `docker compose restart cma-server`.
  </Step>

  <Step title="Open the session">
    In a browser on the same machine, open `http://127.0.0.1:8400/`, click **Continue with SSO**, and select **alice**, the demo administrator. In the sidebar, select **Sessions**, and then select the session.

    The page updates as the agent works, and you can send the agent a message from it.
  </Step>
</Steps>

To create agents and start sessions in the console too, see [Run an agent from the console](https://platform.claude.com/docs/en/managed-agents/self-hosted/console#run-an-agent-from-the-console).

## Stop the stack

In the first terminal, run this command:

```bash
docker compose down --remove-orphans
```

The command deletes the containers and keeps the database. To also delete the database, with every agent, session, and session history in it, run `docker compose down --remove-orphans -v`.

## Troubleshooting

* **Your archive has no `compose` directory:** The archive holds an earlier release, and this page’s commands don’t match it. Ask your Anthropic account team for the current release. To move a running deployment to the current release, see [Upgrade self-hosted Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade).

* **The server never comes up:** Run `docker compose logs migrate`. The one-time `migrate` container creates the database tables. It must exit with status `0` before the server starts.

* **The readiness check stays `degraded`, or every turn fails:** If you ran `docker compose up` in a terminal where `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8400`, the server calls itself instead of the Claude API. Run `docker compose up -d` again in the first terminal, where the variable isn’t set. Otherwise, the server log shows what failed. To read it, run `docker compose logs -f cma-server` again.

* **The readiness check answers `not_ready`:** In the answer, find the check with the state `failed`:

  * **`upstream`:** The Claude API rejected your Claude API key. Correct `ANTHROPIC_API_KEY` in `.env`, then run `docker compose up -d` again in the first terminal. If your shell also sets `ANTHROPIC_API_KEY`, Compose uses the shell’s value, so run `unset ANTHROPIC_API_KEY` first.
  * **`database`:** Either the database rejected the server’s login, for example because of a wrong password, or an open connection to the database broke. To see which, run `docker compose logs -f cma-server` again.

* **The agent replies but its tool call never finishes:** No worker is polling the environment. Check the workers’ log with `docker compose logs sandbox`. A worker that can’t reach the Docker daemon’s socket exits with a message that names `CMA_DOCKER_SOCKET`. Set that variable in `.env` to your daemon’s socket path, then run `docker compose up -d` again in the first terminal.

* **The workers are running, but a tool call still never finishes:** The stack starts 10 workers, and each one runs one session’s container at a time. A session takes a free worker when you create it, and a session that never gets a message keeps its worker for up to an hour. With all 10 taken, any other session’s tool calls wait for a worker. If the `docker ps` command in the “Find the sandbox container” step lists 10 containers, archive the sessions that you don’t use:

  1. In the first terminal, run `docker ps --filter label=cma-server.sandbox --format '{{.Label "cma-server.session"}}'`. It prints the ID of the session behind each container. The session that waits has no container yet, so it isn’t in the list.
  2. In the second terminal, press Ctrl+C to leave the chat, and run `ant beta:sessions archive --session-id <session-id>` for each listed session that you don’t use.
  3. Run `ant beta:sessions connect "$SESSION_ID"` again. The tool call finishes when a worker takes its session.

## Next steps

<CardGroup cols={2}>
  <Card title="Call the API" icon="code-brackets" href="https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api">
    Point the SDK and the `ant` CLI at your server.
  </Card>

  <Card title="Differences from the hosted service" icon="arrows-left-right" href="https://platform.claude.com/docs/en/managed-agents/self-hosted/differences">
    Check which features behave differently or aren’t available.
  </Card>

  <Card title="Console on your server" icon="browser" href="https://platform.claude.com/docs/en/managed-agents/self-hosted/console">
    Set up sign-in, and create agents and run sessions in a browser.
  </Card>
</CardGroup>
