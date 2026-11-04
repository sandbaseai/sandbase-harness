---
title: Deploy self-hosted workers
url: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers
description: "Choose how self-hosted sandbox workers claim work and where sessions run: always-on or webhook-triggered, in one process or one sandbox per session."
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

The [quickstart](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#quickstart) runs one `ant` CLI worker that polls continuously and runs every session in one process. This page covers the other ways to run a worker and how to choose among them.

## Choose a deployment pattern

When deploying workers, you need to make two choices: how the worker claims work, and where each session runs.

**How the worker claims work:**

* **Always-on:** A long-running process polls the queue continuously and needs only outbound HTTPS. This is the simplest setup.
* **Webhook-triggered:** A handler wakes on `session.status_run_started` and starts polling. This avoids an idle poller, but requires a [webhook](https://platform.claude.com/docs/en/managed-agents/webhooks) endpoint that Anthropic can reach.

**Where each session runs:**

* **In process:** The worker that claims a session also runs its tool calls, in one shared working directory.
* **Sandbox per session:** A poller launches a fresh sandbox for each claimed session. Choose this for stronger isolation: a fresh filesystem, resource limits, or per-session network controls.

The CLI and SDK workers support different combinations:

| Capability                                                                                            | `ant` CLI                       | SDK (Python, TypeScript, Go) |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------- |
| Always-on polling                                                                                     | Yes                             | Yes                          |
| Webhook-triggered                                                                                     | No                              | Yes                          |
| Sandbox per session                                                                                   | Yes                             | Yes                          |
| [Memory stores](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory)      | Yes, with default sync settings | Yes, with configurable sync  |
| [Custom tools](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-custom-tools) | No                              | Yes                          |

See [Self-hosted worker reference](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference) for every CLI flag and SDK option. For more control, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work) directly and implement your own worker.

## Run an always-on worker

Start a worker that polls the queue continuously. It authenticates with the [environment key](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#run-your-first-session) from the quickstart:

<CodeGroup exclude="shell:cURL, csharp, java, php, ruby">
  ```bash CLI
  ant beta:worker poll --workdir /workspace
  ```

  ```python Python
  import asyncio
  import contextlib
  import os
  import signal
  from anthropic import AsyncAnthropic
  from anthropic.lib.environments import EnvironmentWorker


  async def main() -> None:
      environment_key = os.environ["ANTHROPIC_ENVIRONMENT_KEY"]
      environment_id = os.environ["ANTHROPIC_ENVIRONMENT_ID"]
      async with AsyncAnthropic(auth_token=environment_key) as client:
          worker = EnvironmentWorker(
              client,
              environment_id=environment_id,
              environment_key=environment_key,
              workdir="/workspace",
          )
          task = asyncio.create_task(worker.run())
          # Cancelling the task, rather than killing the process, lets the worker stop its
          # in-flight work item and upload changed memory files before it exits.
          loop = asyncio.get_running_loop()
          for signum in (signal.SIGINT, signal.SIGTERM):
              loop.add_signal_handler(signum, task.cancel)
          with contextlib.suppress(asyncio.CancelledError):
              await task


  asyncio.run(main())
  ```

  ```typescript TypeScript
  import Anthropic from "@anthropic-ai/sdk";
  import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";

  const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
  const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID!;
  const client = new Anthropic({ authToken: environmentKey });
  const controller = new AbortController();
  // Aborting on either signal lets the worker upload changed memory files and remove its
  // store directories before the process exits.
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  await new EnvironmentWorker({
    client,
    environmentId,
    environmentKey,
    workdir: "/workspace",
    signal: controller.signal
  }).run();
  ```

  <CodeGroupItem language="C#">
    The C# SDK does not have `EnvironmentWorker`. Run the `ant` CLI worker instead: `ant beta:worker poll --workdir /workspace`.
  </CodeGroupItem>

  ```go Go
  package main

  import (
  	"context"
  	"log"
  	"os"
  	"os/signal"
  	"syscall"

  	"github.com/anthropics/anthropic-sdk-go/v2"
  	"github.com/anthropics/anthropic-sdk-go/v2/lib/environments"
  	"github.com/anthropics/anthropic-sdk-go/v2/option"
  )

  func main() {
  	environmentKey := os.Getenv("ANTHROPIC_ENVIRONMENT_KEY")
  	environmentID := os.Getenv("ANTHROPIC_ENVIRONMENT_ID")

  	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
  	defer stop()

  	client := anthropic.NewClient(option.WithAuthToken(environmentKey))

  	worker := environments.NewEnvironmentWorker(client, environments.EnvironmentWorkerOptions{
  		EnvironmentID:  environmentID,
  		EnvironmentKey: environmentKey,
  		Workdir:        "/workspace",
  	})
  	if err := worker.Run(ctx); err != nil {
  		log.Fatalf("worker: %v", err)
  	}
  }
  ```

  <CodeGroupItem language="Java">
    The Java SDK does not have `EnvironmentWorker`. Run the `ant` CLI worker instead: `ant beta:worker poll --workdir /workspace`.
  </CodeGroupItem>

  <CodeGroupItem language="PHP">
    The PHP SDK does not have `EnvironmentWorker`. Run the `ant` CLI worker instead: `ant beta:worker poll --workdir /workspace`.
  </CodeGroupItem>

  <CodeGroupItem language="Ruby">
    The Ruby SDK does not have `EnvironmentWorker`. Run the `ant` CLI worker instead: `ant beta:worker poll --workdir /workspace`.
  </CodeGroupItem>
</CodeGroup>

## Trigger workers from webhooks

<Steps>
  <Step title="Subscribe to session webhooks">
    In the [Claude Console](https://platform.claude.com/settings/workspaces/default/webhooks), define a webhook endpoint that listens for `session.status_run_started` events. See [Webhooks](https://platform.claude.com/docs/en/managed-agents/webhooks) for details.
  </Step>

  <Step title="Export the webhook signing key">
    Along with the environment ID and key from [Run your first session](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#run-your-first-session), export the webhook signing key on your handler host. The handler uses it to verify incoming payloads.

    ```bash
    export ANTHROPIC_WEBHOOK_SIGNING_KEY="whsec_..."
    ```
  </Step>

  <Step title="Implement the webhook handler">
    Start the worker when `session.status_run_started` fires. The handler drains the queue and hands each claimed work item to `handle_item()` (typescript: `handleItem()`; go: `HandleItem()`), which downloads skills, runs tool calls, posts results back, and returns.

    <CodeGroup exclude="shell, csharp, java, php, ruby">
      <CodeGroupItem>
        To verify webhook signatures, install the webhooks extra: `pip install "anthropic[webhooks]"`.

        ```python Python
        import asyncio
        import os
        import anthropic
        import standardwebhooks  # installed by the anthropic[webhooks] extra

        environment_key = os.environ["ANTHROPIC_ENVIRONMENT_KEY"]
        environment_id = os.environ["ANTHROPIC_ENVIRONMENT_ID"]
        client = anthropic.AsyncAnthropic(
            auth_token=environment_key,
        )
        # Cancelled by shutdown() so an in-flight work item can upload changed memory files and
        # remove its store directories before the process exits.
        inflight: set[asyncio.Task[None]] = set()


        # Await this from the host's shutdown hook, such as an ASGI lifespan shutdown (the code after
        # `yield` in a FastAPI lifespan), which uvicorn runs on SIGTERM. uvicorn lets open requests
        # finish before that hook runs, so set --timeout-graceful-shutdown to bound the wait.
        async def shutdown() -> None:
            for task in inflight:
                task.cancel()
            await asyncio.gather(*inflight, return_exceptions=True)


        async def handle(raw: bytes, headers: dict[str, str]) -> tuple[dict[str, str], int]:
            try:
                event = client.beta.webhooks.unwrap(raw.decode(), headers=headers)
            except standardwebhooks.WebhookVerificationError:
                return {"error": "signature verification failed"}, 401
            if event.data.type != "session.status_run_started":
                return {"status": "ignored"}, 200
            task = asyncio.create_task(run_queued_work())
            inflight.add(task)
            task.add_done_callback(inflight.discard)
            try:
                # Shielded: a dropped or timed-out delivery must not cancel the item; shutdown() does.
                await asyncio.shield(task)
            except asyncio.CancelledError:
                return {"status": "shutting down"}, 503
            return {"status": "ok"}, 200


        async def run_queued_work() -> None:
            async for work in client.beta.environments.work.poller(
                environment_id=environment_id,
                environment_key=environment_key,
                block_ms=None,
                reclaim_older_than_ms=2000,
                drain=True,
                auto_stop=False,
            ):
                await client.beta.environments.work.worker(workdir="/workspace").handle_item(
                    work_id=work.id,
                    environment_id=environment_id,
                    session_id=work.data.id,
                    environment_key=environment_key,
                    # The per-session secret is what lets the worker mount the session's memory stores.
                    work_secret=work.secret,
                )
        ```
      </CodeGroupItem>

      ```typescript TypeScript
      import Anthropic from "@anthropic-ai/sdk";

      const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
      const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID!;
      const client = new Anthropic({
        authToken: environmentKey
      });
      // Call shutdown.abort() from the host's SIGTERM/SIGINT handler, alongside closing the server,
      // then wait for in-flight handle() calls before exiting: the abort lets a running work item
      // upload changed memory files and remove its store directories first.
      export const shutdown = new AbortController();

      export async function handle(req: Request): Promise<Response> {
        // Never acknowledge a delivery whose work will not run here; a 503 makes the sender retry.
        if (shutdown.signal.aborted) {
          return Response.json({ status: "shutting down" }, { status: 503 });
        }
        const body = await req.text();
        let event;
        try {
          event = client.beta.webhooks.unwrap(body, { headers: Object.fromEntries(req.headers) });
        } catch {
          return new Response("signature verification failed", { status: 401 });
        }
        if (event.data.type !== "session.status_run_started") {
          return Response.json({ status: "ignored" });
        }

        for await (const work of client.beta.environments.work.poller({
          environmentId,
          environmentKey,
          blockMs: null,
          reclaimOlderThanMs: 2000,
          drain: true,
          autoStop: false,
          signal: shutdown.signal
        })) {
          await client.beta.environments.work.worker({ workdir: "/workspace" }).handleItem({
            workId: work.id,
            environmentId,
            sessionId: work.data.id,
            environmentKey,
            // The per-session secret is what lets the worker mount the session's memory stores.
            workSecret: work.secret ?? undefined,
            signal: shutdown.signal
          });
        }
        // The poller and handleItem return quietly on abort, so a drain cut short lands here.
        if (shutdown.signal.aborted) {
          return Response.json({ status: "shutting down" }, { status: 503 });
        }
        return Response.json({ status: "ok" });
      }
      ```

      <CodeGroupItem language="C#">
        The C# SDK does not have `EnvironmentWorker`. To handle work items from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
      </CodeGroupItem>

      ```go Go
      package main

      import (
      	"context"
      	"encoding/json"
      	"errors"
      	"io"
      	"log/slog"
      	"net/http"
      	"os"
      	"os/signal"
      	"syscall"

      	"github.com/anthropics/anthropic-sdk-go/v2"
      	"github.com/anthropics/anthropic-sdk-go/v2/lib/environments"
      	"github.com/anthropics/anthropic-sdk-go/v2/option"
      	"github.com/anthropics/anthropic-sdk-go/v2/packages/param"
      )

      var (
      	environmentKey = os.Getenv("ANTHROPIC_ENVIRONMENT_KEY")
      	environmentID  = os.Getenv("ANTHROPIC_ENVIRONMENT_ID")
      	client         = anthropic.NewClient(
      		option.WithAuthToken(environmentKey),
      		option.WithWebhookKey(os.Getenv("ANTHROPIC_WEBHOOK_SIGNING_KEY")),
      	)
      	worker = environments.NewEnvironmentWorker(client, environments.EnvironmentWorkerOptions{
      		Workdir: "/workspace",
      	})
      	// Cancelled on SIGINT or SIGTERM (set in main) so an in-flight work item can
      	// upload changed memory files and remove its store directories before exit.
      	shutdown context.Context
      )

      func handle(w http.ResponseWriter, r *http.Request) {
      	body, err := io.ReadAll(r.Body)
      	if err != nil {
      		http.Error(w, "bad request", http.StatusBadRequest)
      		return
      	}
      	event, err := client.Beta.Webhooks.Unwrap(body, r.Header)
      	if err != nil {
      		http.Error(w, "signature verification failed", http.StatusUnauthorized)
      		return
      	}
      	if event.Data.Type != "session.status_run_started" {
      		json.NewEncoder(w).Encode(map[string]string{"status": "ignored"})
      		return
      	}

      	// The Go SDK does not provide a RunOne convenience: drain pending items
      	// with WorkPoller and run each one with HandleItem.
      	// Detach from r.Context(): the session can outlive the webhook delivery timeout.
      	// The process-wide shutdown context still ends the item cleanly on SIGTERM.
      	ctx := shutdown
      	poller := environments.NewWorkPoller(ctx, client, environments.WorkPollerOptions{
      		EnvironmentID:      environmentID,
      		EnvironmentKey:     environmentKey,
      		BlockMs:            param.Null[int64](),
      		ReclaimOlderThanMs: param.NewOpt[int64](2000),
      		Drain:              true,
      		AutoStop:           param.NewOpt(false),
      	})
      	defer poller.Close()
      	for poller.Next() {
      		item := poller.Current()
      		if err := worker.HandleItem(ctx, environments.HandleItemOptions{
      			WorkID:         item.ID,
      			EnvironmentID:  item.EnvironmentID,
      			SessionID:      item.Data.ID,
      			EnvironmentKey: environmentKey,
      			// The per-session secret is what lets the worker mount the session's memory stores.
      			WorkSecret: item.Secret,
      		}); err != nil {
      			slog.Error("handle work item", "work_id", item.ID, "err", err)
      			http.Error(w, "internal error", http.StatusInternalServerError)
      			return
      		}
      	}
      	if err := poller.Err(); err != nil {
      		slog.Error("poll work queue", "err", err)
      		http.Error(w, "internal error", http.StatusInternalServerError)
      		return
      	}
      	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
      }

      func main() {
      	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
      	defer stop()
      	shutdown = ctx

      	server := &http.Server{Addr: ":8080"}
      	http.HandleFunc("POST /webhook", handle)
      	go func() {
      		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
      			slog.Error("http server", "err", err)
      			os.Exit(1)
      		}
      	}()
      	// On a signal, stop accepting deliveries and return only after in-flight
      	// handlers, and therefore their work items' memory teardown, have finished.
      	<-ctx.Done()
      	if err := server.Shutdown(context.Background()); err != nil {
      		slog.Error("http shutdown", "err", err)
      	}
      }
      ```

      <CodeGroupItem language="Java">
        The Java SDK does not have `EnvironmentWorker`. To handle work items from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
      </CodeGroupItem>

      <CodeGroupItem language="PHP">
        The PHP SDK does not have `EnvironmentWorker`. To handle work items from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
      </CodeGroupItem>

      <CodeGroupItem language="Ruby">
        The Ruby SDK does not have `EnvironmentWorker`. To handle work items from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
      </CodeGroupItem>
    </CodeGroup>

    Because the handler claims work itself, it must [forward the work item’s secret](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#forward-the-work-items-secret), as the `work_secret` (typescript: `workSecret`; go: `WorkSecret`) argument does here.
  </Step>
</Steps>

This handler runs every claimed item in one process on one host. If your sessions attach the same memory store, see [Isolate sessions that share a store](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory#isolate-sessions-that-share-a-store).

## Run one sandbox per session

A poller on the host claims work and calls your script once for each work item. The script launches a sandbox for that one session.

<Steps>
  <Step title="Build the sandbox image">
    Install `ant` and set `ant beta:worker run` as the entrypoint. When a sandbox starts, it reads session details from environment variables, handles that session, and exits. The base image must provide `/bin/bash`; `curl` is only used at build time.

    ```dockerfile
    FROM your-base-image
    ARG ANT_VERSION=2.4.0
    ARG TARGETARCH
    RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo amd64) && \
        curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_${ARCH}.tar.gz" \
          | tar -xz -C /usr/local/bin ant
    WORKDIR /workspace
    VOLUME /workspace
    ENTRYPOINT ["ant", "beta:worker", "run"]
    ```
  </Step>

  <Step title="Write the spawn script">
    The script forwards the session details into a fresh sandbox. It requires `jq` on the poller host.

    ```bash
    #!/bin/bash
    # spawn.sh: called once for each claimed work item
    # The claimed work item arrives as JSON on stdin.
    ANTHROPIC_WORK_SECRET="$(jq -r '.secret // empty')"
    export ANTHROPIC_WORK_SECRET
    mkdir -p "/host/outputs/$ANTHROPIC_SESSION_ID"
    exec docker run --rm \
      -e ANTHROPIC_SESSION_ID -e ANTHROPIC_ENVIRONMENT_KEY \
      -e ANTHROPIC_WORK_ID -e ANTHROPIC_ENVIRONMENT_ID -e ANTHROPIC_BASE_URL \
      -e ANTHROPIC_WORK_SECRET \
      -v "/host/outputs/$ANTHROPIC_SESSION_ID":/workspace \
      your-image
    ```

    The poller sets the `ANTHROPIC_*` variables that the script forwards, except the secret. See [Environment variables](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference#environment-variables).

    `/host/outputs` is a host directory you choose. Mounting it at `/workspace` lets you retrieve the session’s deliverables after the sandbox exits. The mount also picks up the downloaded `skills/` tree and any intermediate files.
  </Step>

  <Step title="Start the poller">
    ```bash
    ant beta:worker poll --on-work ./spawn.sh
    ```
  </Step>
</Steps>

### Forward the work item’s secret

Each claimed work item can carry a per-session `secret` (csharp, go: `Secret`), which Anthropic issues. The worker that runs the session needs it to mount [memory stores](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory).

A worker that claims and runs sessions in one process (`ant beta:worker poll` without `--on-work`, or `EnvironmentWorker` with `run()` (go: `Run()`)) passes the secret along itself. When your own code sits between the claim and the worker, you forward it:

| You claim work with                                            | The secret arrives as                                                    | Pass it to the worker as                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ant beta:worker poll --on-work`                               | The `secret` field of the work item JSON on your script’s standard input | `ANTHROPIC_WORK_SECRET` in the sandbox’s environment                                                                                                                                                 |
| The SDK’s `work.poller()` (go: `environments.NewWorkPoller()`) | The `secret` (go: `Secret`) field of each claimed work item              | `ANTHROPIC_WORK_SECRET` in the sandbox’s environment, or the `work_secret` (typescript: `workSecret`; go: `WorkSecret`) argument to `handle_item()` (typescript: `handleItem()`; go: `HandleItem()`) |

Pass the secret only into the sandbox that serves that session, and never log it. See [Security model](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security) for how it relates to the environment key.

### Launch sandboxes from the SDK poller

To claim work from your own code instead of `ant beta:worker poll --on-work`, use `work.poller()` (typescript: `new WorkPoller()`; go: `environments.NewWorkPoller()`). It polls the queue and gives you each claimed session, and you launch the sandbox:

<CodeGroup exclude="shell, csharp, java, php, ruby">
  <CodeGroupItem language="cURL">
    Claiming work in a loop and launching a sandbox for each session needs more logic than a single shell command. From the shell, run `ant beta:worker poll --on-work` with a spawn script, as in [Run one sandbox per session](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-one-sandbox-per-session).
  </CodeGroupItem>

  <CodeGroupItem language="CLI">
    To claim work from the shell and launch a sandbox for each session, run `ant beta:worker poll --on-work` with a spawn script, as in [Run one sandbox per session](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-one-sandbox-per-session).
  </CodeGroupItem>

  ```python Python
  import asyncio
  import os

  from anthropic import AsyncAnthropic
  from anthropic.types.beta.environments import BetaSelfHostedWork

  SANDBOX_ENV = (
      "ANTHROPIC_ENVIRONMENT_ID",
      "ANTHROPIC_ENVIRONMENT_KEY",
      "ANTHROPIC_WORK_ID",
      "ANTHROPIC_SESSION_ID",
      "ANTHROPIC_WORK_SECRET",
      "ANTHROPIC_BASE_URL",  # forwarded only when set on this host
  )


  async def launch_container(work: BetaSelfHostedWork) -> None:
      print(f"claimed session {work.data.id}")
      # Replace `docker run` with your own sandbox launcher. Forward the environment
      # key (never your API key) and the work item's per-session secret: the worker
      # inside needs the secret to mount the session's memory stores.
      env = os.environ | {
          "ANTHROPIC_WORK_ID": work.id,
          "ANTHROPIC_SESSION_ID": work.data.id,
          "ANTHROPIC_WORK_SECRET": work.secret or "",
      }
      forward = [arg for name in SANDBOX_ENV for arg in ("-e", name)]
      launcher = await asyncio.create_subprocess_exec(
          "docker", "run", "--rm", "--detach", *forward, "your-image", env=env
      )
      await launcher.wait()


  async def main() -> None:
      environment_key = os.environ["ANTHROPIC_ENVIRONMENT_KEY"]
      environment_id = os.environ["ANTHROPIC_ENVIRONMENT_ID"]
      async with AsyncAnthropic(auth_token=environment_key) as client:
          async for work in client.beta.environments.work.poller(
              environment_id=environment_id,
              environment_key=environment_key,
              auto_stop=False,  # the launched sandbox owns the stop call
          ):
              await launch_container(work)


  asyncio.run(main())
  ```

  ```typescript TypeScript
  import { spawn } from "node:child_process";
  import { once } from "node:events";
  import Anthropic from "@anthropic-ai/sdk";
  import { WorkPoller } from "@anthropic-ai/sdk/helpers/beta/environments";
  import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments";

  const SANDBOX_ENV = [
    "ANTHROPIC_ENVIRONMENT_ID",
    "ANTHROPIC_ENVIRONMENT_KEY",
    "ANTHROPIC_WORK_ID",
    "ANTHROPIC_SESSION_ID",
    "ANTHROPIC_WORK_SECRET",
    "ANTHROPIC_BASE_URL" // forwarded only when set on this host
  ];

  const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
  const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID!;
  const client = new Anthropic({ authToken: environmentKey });

  async function launchContainer(work: BetaSelfHostedWork): Promise<void> {
    console.log(`claimed session ${work.data.id}`);
    // Replace `docker run` with your own sandbox launcher. Forward the environment
    // key (never your API key) and the work item's per-session secret: the worker
    // inside needs the secret to mount the session's memory stores.
    const env = {
      ...process.env,
      ANTHROPIC_WORK_ID: work.id,
      ANTHROPIC_SESSION_ID: work.data.id,
      ANTHROPIC_WORK_SECRET: work.secret ?? ""
    };
    const forward = SANDBOX_ENV.flatMap((name) => ["-e", name]);
    const launcher = spawn("docker", ["run", "--rm", "--detach", ...forward, "your-image"], {
      env,
      stdio: "inherit"
    });
    await once(launcher, "close");
  }

  const poller = new WorkPoller({
    client,
    environmentId,
    environmentKey,
    autoStop: false // the launched sandbox owns the stop call
  });

  for await (const work of poller) {
    await launchContainer(work);
  }
  ```

  <CodeGroupItem language="C#">
    The C# SDK does not have a helper that polls for work. To claim work from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
  </CodeGroupItem>

  ```go Go
  package main

  import (
  	"context"
  	"fmt"
  	"log"
  	"os"
  	"os/exec"

  	"github.com/anthropics/anthropic-sdk-go/v2"
  	"github.com/anthropics/anthropic-sdk-go/v2/lib/environments"
  	"github.com/anthropics/anthropic-sdk-go/v2/option"
  	"github.com/anthropics/anthropic-sdk-go/v2/packages/param"
  )

  var sandboxEnv = []string{
  	"ANTHROPIC_ENVIRONMENT_ID",
  	"ANTHROPIC_ENVIRONMENT_KEY",
  	"ANTHROPIC_WORK_ID",
  	"ANTHROPIC_SESSION_ID",
  	"ANTHROPIC_WORK_SECRET",
  	"ANTHROPIC_BASE_URL", // forwarded only when set on this host
  }

  func launchContainer(ctx context.Context, work *anthropic.BetaSelfHostedWork) error {
  	fmt.Printf("claimed session %s\n", work.Data.ID)
  	// Replace `docker run` with your own sandbox launcher. Forward the environment
  	// key (never your API key) and the work item's per-session secret: the worker
  	// inside needs the secret to mount the session's memory stores.
  	args := []string{"run", "--rm", "--detach"}
  	for _, name := range sandboxEnv {
  		args = append(args, "-e", name)
  	}
  	launcher := exec.CommandContext(ctx, "docker", append(args, "your-image")...)
  	launcher.Env = append(os.Environ(),
  		"ANTHROPIC_WORK_ID="+work.ID,
  		"ANTHROPIC_SESSION_ID="+work.Data.ID,
  		"ANTHROPIC_WORK_SECRET="+work.Secret,
  	)
  	launcher.Stdout, launcher.Stderr = os.Stdout, os.Stderr
  	return launcher.Run()
  }

  func main() {
  	environmentID := os.Getenv("ANTHROPIC_ENVIRONMENT_ID")
  	environmentKey := os.Getenv("ANTHROPIC_ENVIRONMENT_KEY")

  	client := anthropic.NewClient(option.WithAuthToken(environmentKey))

  	ctx := context.Background()

  	poller := environments.NewWorkPoller(ctx, client, environments.WorkPollerOptions{
  		EnvironmentID:  environmentID,
  		EnvironmentKey: environmentKey,
  		AutoStop:       param.NewOpt(false), // the launched sandbox owns the stop call
  	})
  	defer poller.Close()

  	for work, err := range poller.All() {
  		if err != nil {
  			log.Fatal(err)
  		}
  		if err := launchContainer(ctx, work); err != nil {
  			log.Fatal(err)
  		}
  	}
  }
  ```

  <CodeGroupItem language="Java">
    The Java SDK does not have a helper that polls for work. To claim work from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
  </CodeGroupItem>

  <CodeGroupItem language="PHP">
    The PHP SDK does not have a helper that polls for work. To claim work from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
  </CodeGroupItem>

  <CodeGroupItem language="Ruby">
    The Ruby SDK does not have a helper that polls for work. To claim work from your own code, call the [Environments Work endpoints](https://platform.claude.com/docs/en/api/beta/environments/work).
  </CodeGroupItem>
</CodeGroup>

### Run the SDK worker inside the sandbox

Replace the `ant beta:worker run` entrypoint with an SDK entrypoint when the sandbox must [serve custom tools](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-custom-tools) or use [non-default memory sync settings](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory#configure-sync). The entrypoint constructs `EnvironmentWorker` and calls `handle_item()` (typescript: `handleItem()`; go: `HandleItem()`), which reads the same `ANTHROPIC_*` variables that the spawn script forwards.

<CodeGroup exclude="shell, csharp, java, php, ruby">
  ```python Python
  import asyncio
  import contextlib
  import os
  import signal
  from anthropic import AsyncAnthropic
  from anthropic.lib.environments import EnvironmentWorker


  async def main() -> None:
      async with AsyncAnthropic(
          auth_token=os.environ["ANTHROPIC_ENVIRONMENT_KEY"]
      ) as client:
          worker = EnvironmentWorker(client, workdir="/workspace")
          # With no arguments, handle_item() reads the ANTHROPIC_* variables the spawn
          # script forwarded, including ANTHROPIC_WORK_SECRET.
          task = asyncio.create_task(worker.handle_item())
          # Cancelling the task when the container is stopped lets the worker upload
          # changed memory files and remove the store directories before it exits.
          loop = asyncio.get_running_loop()
          for signum in (signal.SIGINT, signal.SIGTERM):
              loop.add_signal_handler(signum, task.cancel)
          with contextlib.suppress(asyncio.CancelledError):
              await task


  asyncio.run(main())
  ```

  ```typescript TypeScript
  import Anthropic from "@anthropic-ai/sdk";
  import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";

  const client = new Anthropic({ authToken: process.env.ANTHROPIC_ENVIRONMENT_KEY });
  const controller = new AbortController();
  // Aborting when the container is stopped lets the worker upload changed memory
  // files and remove the store directories before it exits.
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  // With no arguments, handleItem() reads the ANTHROPIC_* variables the spawn
  // script forwarded, including ANTHROPIC_WORK_SECRET.
  await new EnvironmentWorker({
    client,
    workdir: "/workspace",
    signal: controller.signal
  }).handleItem();
  ```

  <CodeGroupItem language="C#">
    The C# SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  ```go Go
  package main

  import (
  	"context"
  	"log"
  	"os"
  	"os/signal"
  	"syscall"

  	"github.com/anthropics/anthropic-sdk-go/v2"
  	"github.com/anthropics/anthropic-sdk-go/v2/lib/environments"
  	"github.com/anthropics/anthropic-sdk-go/v2/option"
  )

  func main() {
  	// Cancelling the context when the container is stopped lets the worker upload
  	// changed memory files and remove the store directories before it exits.
  	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
  	defer stop()

  	client := anthropic.NewClient(option.WithAuthToken(os.Getenv("ANTHROPIC_ENVIRONMENT_KEY")))
  	worker := environments.NewEnvironmentWorker(client, environments.EnvironmentWorkerOptions{
  		Workdir: "/workspace",
  	})
  	// With zero-value options, HandleItem reads the ANTHROPIC_* variables the spawn
  	// script forwarded, including ANTHROPIC_WORK_SECRET.
  	if err := worker.HandleItem(ctx, environments.HandleItemOptions{}); err != nil {
  		log.Fatalf("worker: %v", err)
  	}
  }
  ```

  <CodeGroupItem language="Java">
    The Java SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  <CodeGroupItem language="PHP">
    The PHP SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  <CodeGroupItem language="Ruby">
    The Ruby SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>
</CodeGroup>

## Stage files for a session

Anthropic doesn’t mount files or GitHub repositories into self-hosted sandboxes. To make session-specific files available:

1. Pass file references, such as an S3 path or commit SHA, in the session’s `metadata` field.
2. In your spawn script or `--on-work` handler, retrieve the session (`GET /v1/sessions/{session_id}`) and read `metadata`. The claimed work item carries the session ID but not the metadata.
3. Stage the files into the working directory before any tool runs.

<CodeGroup>
  ```bash cURL
  curl -sS --fail-with-body https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$AGENT_ID"'",
      "environment_id": "'"$ANTHROPIC_ENVIRONMENT_ID"'",
      "metadata": {"input_file": "s3://my-bucket/data.csv"}
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$AGENT_ID" \
    --environment-id "$ANTHROPIC_ENVIRONMENT_ID" \
    --metadata '{"input_file": "s3://my-bucket/data.csv"}'
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=agent.id,
      environment_id=environment.id,
      metadata={"input_file": "s3://my-bucket/data.csv"},
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    metadata: { input_file: "s3://my-bucket/data.csv" }
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = agent.ID,
      EnvironmentID = environment.ID,
      Metadata = new Dictionary<string, string> { ["input_file"] = "s3://my-bucket/data.csv" },
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent:         anthropic.BetaSessionNewParamsAgentUnion{OfString: anthropic.String(agent.ID)},
  	EnvironmentID: environment.ID,
  	Metadata: map[string]string{
  		"input_file": "s3://my-bucket/data.csv",
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
      .metadata(SessionCreateParams.Metadata.builder()
          .putAdditionalProperty("input_file", JsonValue.from("s3://my-bucket/data.csv"))
          .build())
      .build());
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $agent->id,
      environmentID: $environment->id,
      metadata: ['input_file' => 's3://my-bucket/data.csv'],
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: agent.id,
    environment_id: environment.id,
    metadata: {input_file: "s3://my-bucket/data.csv"}
  )
  ```
</CodeGroup>

## Next steps

<CardGroup cols={2}>
  <Card title="Monitor and troubleshoot" icon="lightning" href="https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations">
    Read queue depth, stop sessions and workers cleanly, and fix common failures.
  </Card>

  <Card title="Security model" icon="lock" href="https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security">
    Shared responsibility model for self-hosted sandbox environments.
  </Card>
</CardGroup>

## Availability

Self-hosted workers are in beta on every model.

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
