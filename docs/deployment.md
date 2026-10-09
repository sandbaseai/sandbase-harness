# Deployment Examples

`managed-agents` is local-first, but the runtime is intentionally easy to run
as a long-lived service. A production deployment is still a self-owned Node.js
process backed by a data directory that contains SQLite metadata, uploaded
files, artifacts, snapshots, and logs.

## Production Boundaries

Before exposing a runtime beyond localhost:

- enable bearer-token authentication with `MANAGED_AGENTS_API_KEY` or managed
  API keys
- pin a persistent `--data-dir`
- run behind TLS at the reverse proxy or platform layer
- keep model provider API keys in environment variables or a secret manager
- back up the data directory
- expose only the networks and sandbox providers you actually use

## Single Host With systemd

Build or install the package, then create a dedicated runtime directory:

```bash
sudo useradd --system --create-home --home-dir /var/lib/managed-agents managed-agents
sudo mkdir -p /etc/managed-agents /var/lib/managed-agents/runtime
sudo chown -R managed-agents:managed-agents /var/lib/managed-agents
```

Example environment file:

```text
# /etc/managed-agents/runtime.env
MANAGED_AGENTS_API_KEY=ma_change_me
OPENAI_API_KEY=sk_change_me
```

Example service:

```ini
[Unit]
Description=managed-agents runtime
After=network-online.target

[Service]
User=managed-agents
Group=managed-agents
WorkingDirectory=/var/lib/managed-agents/workspace
EnvironmentFile=/etc/managed-agents/runtime.env
ExecStart=/usr/bin/managed-agents start \
  --host 127.0.0.1 \
  --port 3000 \
  --data-dir /var/lib/managed-agents/runtime \
  --config /etc/managed-agents/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Put nginx, Caddy, or an ingress in front of the localhost service for TLS and
external access.

## Docker Compose

Build the image from a tagged SandBase Harness source checkout. The unscoped
`managed-agents` npm package is not this project and must not be installed in a
deployment image.

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/index.js", "start", "--host", "0.0.0.0", "--port", "3000", "--data-dir", "/data"]
```

This Compose example stores runtime state in a named volume and keeps the HTTP
service bound to localhost on the host machine:

```yaml
services:
  managed-agents:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      MANAGED_AGENTS_API_KEY: ${MANAGED_AGENTS_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    volumes:
      - managed_agents_data:/data
      - ./agents:/app/agents:ro
      - ./skills:/app/skills:ro
      - ./config.yaml:/app/.managed-agents/config.yaml:ro

volumes:
  managed_agents_data:
```

For stronger isolation, run Docker-backed sandboxes only on hosts where the
container runtime and permissions are explicitly managed.

The `local` backend wraps every sandbox command in OS-level confinement when
the host carries the tooling: `sandbox-exec` on macOS (`/usr/bin/sandbox-exec`)
or `bubblewrap` on Linux (`bwrap`, install the `bubblewrap` package). The wrap
denies writes outside the session workdir, temp dirs, and device files —
reads and the egress policy are unchanged. Detection is automatic; set
`MANAGED_AGENTS_LOCAL_ISOLATION=off` to run unconfined, `=require` to fail a
command rather than degrade, and `MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS`
to grant extra writable roots. Windows hosts run unconfined regardless — use
Docker for untrusted work there.

The default session-sandbox image is the published reference image
`ghcr.io/sandbaseai/sandbase-harness-sandbox:latest`. It approximates the
published cloud sandbox toolchain (Ubuntu 24.04, Python 3.12, Node 22, git,
jq, ripgrep, build tools, ffmpeg, ImageMagick, SQLite/PostgreSQL/Redis
installed but not running) and is what `config.type: "cloud"` — the
published "the platform decides" hosting value — provisions: `cloud`
resolves to the `docker` backend on this image, so a `cloud` Environment
needs a running Docker daemon and fails at provision without one rather than
downgrading to `local`. `config.image` still overrides the image per
Environment — to pin a release tag, or to point at a mirror. See
`docker/sandbox-image/` for the Dockerfile, the mid-size exclusions, and a
local build command.

## Kubernetes

Push the same source-built image to your registry, then use a `Deployment` for
the runtime and a persistent volume for `/data`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: managed-agents
spec:
  replicas: 1
  selector:
    matchLabels:
      app: managed-agents
  template:
    metadata:
      labels:
        app: managed-agents
    spec:
      containers:
        - name: runtime
          image: your-registry.example/sandbase-harness:v0.3.8
          workingDir: /app
          command:
            - node
            - dist/index.js
            - start
            - --host
            - 0.0.0.0
            - --port
            - "3000"
            - --data-dir
            - /data
          envFrom:
            - secretRef:
                name: managed-agents-secrets
          ports:
            - containerPort: 3000
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: managed-agents-data
```

For multi-replica deployments, wait until metadata storage supports an external
database. The current SQLite-backed runtime should run as a single writer.

### Kubernetes Sandboxes

Running the runtime in Kubernetes and running session sandboxes as Pods are
independent choices. The Deployment above does neither by itself: the sandbox
backend is selected by `Settings > Advanced` → `Sandbox editor`, or by an
Environment's
`sandbox_provider`, and it works the same whether the runtime process sits
inside the cluster or on a laptop pointed at one.

The `kubernetes` backend shells out to `kubectl`, so the runtime image must
include it — the `node:22-bookworm-slim` image in the example above does not.
Add it to a derived image, or keep the sandbox backend on `docker` / `local`.

The runtime needs permission to manage Pods in the target namespace:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: managed-agents
  namespace: agent-sandboxes
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: managed-agents-sandboxes
  namespace: agent-sandboxes
rules:
  # create/delete for session lifecycle, get/list/watch for readiness waits,
  # and the exec subresource for running commands and copying files.
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "delete", "get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: managed-agents-sandboxes
  namespace: agent-sandboxes
subjects:
  - kind: ServiceAccount
    name: managed-agents
    namespace: agent-sandboxes
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: managed-agents-sandboxes
```

Operational notes:

- Bind the Role to a dedicated namespace. `pods/exec` is equivalent to code
  execution in that namespace, so it should not be granted cluster-wide.
- Session Pods are created without a mounted API token unless an Environment
  sets `kubernetes.service_account`. Keep it unset unless an agent needs
  cluster access.
- Sandbox Pods carry `app.kubernetes.io/managed-by=managed-agents`. A runtime
  that is killed mid-session cannot run its own cleanup, so reap leftovers:

```bash
kubectl delete pods -n agent-sandboxes \
  -l app.kubernetes.io/managed-by=managed-agents
```

- Apply a ResourceQuota and a default NetworkPolicy to the namespace. Session
  Pods honor per-Environment `resources` limits, but nothing constrains total
  namespace usage or egress by default.

## Self-hosted Environment Workers

Self-hosted environments let the control runtime keep metadata while another
machine executes work items:

```bash
export MANAGED_AGENTS_ENVIRONMENT_KEY='mawk_...'
managed-agents worker poll \
  --port 3000 \
  --environment-id env_self_hosted \
  --workdir /workspace
```

Generate and revoke environment worker keys from the Console or the
`/v1/environments/{id}/worker-keys` API.

The worker executes `exec`, `read`, `write`, and `list` items inside `--workdir`
and reports each result back to the runtime under the same worker identity it
claimed with, so an item whose command fails is recorded as `failed` rather than
being left claimed. A fifth kind, `custom_tool`, surfaces a session's
`agent.custom_tool_use` to the worker: the payload carries `{tool_name,
tool_use_id, input}` and the worker runs the handler declared under that name in
the module passed to `--tools` (default export `{tool_name: handler}`; a string
result becomes a text block, `{content: [...]}` a block list, anything else a
JSON text block, a throw an `is_error` result). The completion is injected back
into the session as a `user.custom_tool_result` for that call, which resolves
the parked call and resumes the turn — a call for a tool the worker does not
declare is answered with an error result rather than left hanging. Useful flags:

| Flag | Purpose |
| --- | --- |
| `--once` | Claim and run at most one item, then exit. |
| `--on-work <command>` | Hand each claimed item to this command instead of executing it in-process — the spawn hook below. |
| `--interval-ms <ms>` | Delay between polls when the queue is empty (default `1000`, minimum `250`). |
| `--claim-timeout-ms <ms>` | How long to wait for a claim to be answered before polling again (default `10000`, minimum `1`). |
| `--heartbeat-ms <ms>` | Renew the claim on this interval while an item runs (default `20000`, minimum `25`). |
| `--heartbeat-timeout-ms <ms>` | How long to wait for a renewal to be answered before reporting it as unconfirmed (default `10000`, minimum `1`). |
| `--complete-timeout-ms <ms>` | How long to wait for an outcome to be recorded before reporting it as unconfirmed (default `10000`, minimum `1`). |
| `--ack-timeout-ms <ms>` | How long to wait for the runtime to confirm a claim before giving up on the item (default `10000`, minimum `1`). |
| `--worker-id <id>` | Identity reported on the claim and the completion (default `worker_<pid>`). |
| `--tools <module>` | JS module declaring this worker's custom tools, used for `custom_tool` items. |

### Spawning a fresh sandbox per claim: `--on-work` and `worker run`

`worker poll` can run every item in-process, which is the simple mode. The
stronger mode — the one the published worker contract is built around — keeps
the poller as a thin launcher and gives each claim its own clean sandbox:

```bash
managed-agents worker poll \
  --port 3000 \
  --environment-id env_self_hosted \
  --on-work ./spawn-docker.sh
```

For every claimed item the poller runs the command once and hands the item's
whole lifecycle to it — it never accepts, executes, or completes the item
itself. The command receives the claimed work item as JSON on its standard
input and this environment:

| Variable | Contents |
| --- | --- |
| `MANAGED_AGENTS_WORK_ID` | The claimed work item's id. |
| `MANAGED_AGENTS_SESSION_ID` | The session the item belongs to. |
| `MANAGED_AGENTS_ENVIRONMENT_ID` | The environment the poller claims for, when set. |
| `MANAGED_AGENTS_ENVIRONMENT_KEY` | The environment worker key, when configured. |
| `MANAGED_AGENTS_WORKER_ID` | The poller's worker identity — the spawned worker must report under it, because the claim is held in that name. |
| `MANAGED_AGENTS_BASE_URL` | The runtime address the poller resolved; re-point it at the host when the handler spawns a container. |
| `MANAGED_AGENTS_API_KEY` | The poller's API key, when the runtime has auth enabled. |

The item JSON on stdin carries `id`, `sessionId`, `kind`, `payload`, and —
when the runtime can bind the item to an environment — `secret`: a base64url
`{sessions_token, api_base_url}` envelope around a per-claim `mawt_` token.
Forward it into the spawned sandbox (conventionally as
`MANAGED_AGENTS_WORK_SECRET`) and nowhere else: it is a per-session credential,
so it must never land in logs or in a sibling claim's sandbox.

If the command cannot be spawned or exits non-zero, the poller logs the exit
and moves on: the item was never accepted, so its claim lease lapses and the
queue hands it to the next claim — a failed spawn is reclaimable intent, not a
failed result.

The intended spawn target is `worker run`, this CLI's single-shot sibling:

```bash
docker run --rm -i \
  -e MANAGED_AGENTS_SESSION_ID -e MANAGED_AGENTS_WORKER_ID \
  -e MANAGED_AGENTS_BASE_URL -e MANAGED_AGENTS_ENVIRONMENT_KEY \
  -v "$WORKSPACE:/workspace" -w /workspace \
  sandbase-worker managed-agents worker run
```

`worker run` reads the handed item from stdin, accepts the claim under the
forwarded worker id, executes it inside its own `--workdir`, and then keeps
claiming that session's queued items — one sandbox serves one session. It
exits when the session ends (read through the `sessions_token`, whose
authority dies with the session) or when the queue stays empty for
`--max-idle-ms` (default `60000`); the next claim then spawns a fresh sandbox.
Its settings come from the forwarded environment rather than `--port`; the
timeout flags are shared with `worker poll`.

Before the first item of a session runs, the worker also materializes the
session's resources using only the claim's `sessions_token`: each attached
`file` lands at its `mount_path` under the worker root
(`<workdir>/mnt/session/uploads/...` — the canonical upload path mapped into
the worker's own root, the same mapping work-item paths take), and each
assigned skill package lands under `<workdir>/skills/<name>/` — the same
layout `local`/`docker` sessions get at provisioning. The session retrieve
names the attachments, and the file/skill content routes are scoped to
exactly those: an unpinned skill reference fetches the `latest` alias, a
pinned one its exact version, and the archive's executable bits are preserved
on extraction. A worker launched without a `secret` skips materialization,
and a resource that cannot be fetched fails the item rather than letting it
run short a declared file or skill.

Attached `memory_store` resources get the same treatment, as real directories
rather than API proxies: each store materializes under the worker root at its
declared mount path (the canonical `/mnt/memory/<slug>` by default, so
`<workdir>/mnt/memory/<slug>/`) with an `.anthropic-memory-store` marker file
in the root. While the worker serves the session a reconcile pass runs every
15 seconds (`MANAGED_AGENTS_MEMORY_SYNC_INTERVAL_MS`, floored at 5000): remote
edits write to disk, local file edits upload back through the memories API
with `content_sha256` preconditions, and a conflict resolves in the store's
favour. `read_only` attachments pull but never upload — the scope fence would
refuse their writes anyway. Two workers on one host cannot mount the same
store at once (an exclusive lock file in the temp dir enforces it), Windows
hosts refuse memory mounts entirely as the published contract is POSIX-only,
and on exit each mount runs one final sync within a 30-second budget before
its directory and lock are removed — the API store stays authoritative, the
disk copy is disposable.

A copyable reference implementation of both halves — the `spawn-docker.sh`
handler that wraps `docker run` and a `webhook-handler.mjs` that starts the
poller on `session.status_run_started` instead of running one always — lives
in `examples/self-hosted-worker/`, with the trigger subscription steps in its
README.

A claim carries a lease window (60s by default), so a worker that executed a long
item silently would have it reclaimed and handed to a second worker while the first
was still running it. While an item runs, the worker therefore renews its own claim
every `--heartbeat-ms`, and stops renewing when the item finishes. A failed renewal
is logged and the command keeps running: the server refuses a completion from a worker
that no longer holds the claim, and stopping a command halfway on a suspicion that the
claim lapsed would leave a half-applied side effect.

The claim itself is bounded by `--claim-timeout-ms`, and it is the one request whose
absence was least visible: it is issued once per iteration rather than from a timer, so
an unanswered claim was a silent total stall - no item, no report, no retry, and no
message, just a process that never polls again. A claim that **failed** was worse still,
because nothing caught it and the error terminated the whole worker, so a runtime that
blinked was enough to kill every worker pointed at it. Both are now one behaviour: an
item is run only when the claim produced one, and a claim that produced none - refused,
failed, or never answered - is logged (`work_claim_unconfirmed` names the bound when one
expires) and the worker polls again on `--interval-ms`. A permanently wrong credential
therefore reports at a steady rate rather than exiting, which is a deliberate change from
a fast crash to a slow loop.

Walking away from a claim is safe but **not lossless**, and the difference is worth
knowing. A claim whose response was lost may still have created the row on the server, so
that item is stranded until its lease lapses - this worker will never see the item it just
caused. It is not lost, because the row's `accepted_at` is still null, so it stays `queued`
and the sweep re-hands it after the window. That is the "unaccepted intent stays
reclaimable" property doing its job, and it is why abandoning a claim is the right move
rather than trying to release a row whose claim this side cannot prove it holds.

Each renewal is also individually bounded by `--heartbeat-timeout-ms`, and here the
bound matters more than it looks. The renewal is issued from a timer, so a runtime that
accepted the connection and never answered did not park the worker once - it parked it
again on **every tick**, and no tick ever reached the warning, because a promise that
never settles never reaches the `catch` that would have printed one. The bound turns that
into a visible failure: the worker warns with the machine-readable
`work_heartbeat_unconfirmed` and the bound it waited, so "the runtime is not answering my
renewals" is readable directly instead of arriving late as a claim that quietly lapsed.
The bound deliberately does **not** change what the worker does about it - the item keeps
running, because an expired bound is the same kind of suspicion as a transport error, and
only `work_lease_lost` aborts a running item. The default is half `--heartbeat-ms`, so a
renewal that is not going to be answered stops being in flight before the next tick is
due; the two are not coupled by validation, because a test that needs a slow renewal
against a fast tick has to be able to say so.

Before it runs an item the worker confirms its claim against the runtime and waits at
most `--ack-timeout-ms` for the answer. The bound is deliberately below the lease
window, so a bound that expires leaves the claim still the worker's own and it can walk
away rather than racing the queue for work about to be handed to someone else. A refusal
and an expired bound both mean the item is neither run nor reported - an unconfirmed
claim is one the worker cannot prove it holds - but they are reported differently: a
refusal names the status the runtime returned, while an expired bound fails with the
machine-readable `work_accept_unconfirmed` and the bound it waited, so "the runtime
refused" can be told apart from "the runtime went quiet". The default is comfortably
above a localhost round trip and well under the lease, and lowering it only makes the
worker give up sooner.

Producing an outcome and delivering it are separate steps, and the worker keeps them
separate. If a completion is refused - `409` once the lease has lapsed and the queue has
moved the item to `unknown`, or a `5xx`, or a connection that never answers - the worker
reports that the **delivery** failed rather than that the work failed. It warns with the
machine-readable `work_completion_undelivered`, names the status it was refused with (or
that the request did not reach the runtime), sends no second completion, re-runs nothing,
and keeps polling. The item is left exactly as it was: the queue already records the
truth, because an item whose outcome was not delivered becomes `unknown` when its lease
lapses, which is the record that says the effect may have happened and must not be
replayed. A command that genuinely failed is still reported as failed with its own error,
and if that report is refused the row is left unrecorded rather than being given a
failure the worker could not substantiate.

The completion is bounded by `--complete-timeout-ms`, which changes no control flow - the
delivery already fails on its own - but does change the diagnosis, and the difference is
the one thing an operator has to get right here. `work_completion_undelivered` with
"the request did not reach the runtime" is true for a refused connection and **false for a
timeout**: a request that timed out may have arrived and been applied, so the row may
already say `applied` and only this worker does not know. An unanswered completion
therefore reports its own `work_completion_unconfirmed` and says outright that the outcome
may already have been recorded - look at the row rather than assume it is unrecorded. What
it must never do is send the completion again, because the first request may already have
taken effect and the queue refuses a late write to an item it has moved on. Nothing is
lost while a completion hangs either: the item keeps its lease, but the worker stops
polling until the bound expires, so one unanswered completion is enough to stop every
later item from being claimed.

An unusable `--port`, `--interval-ms`, `--claim-timeout-ms`, `--heartbeat-ms`,
`--heartbeat-timeout-ms`, `--complete-timeout-ms` or
`--ack-timeout-ms` stops the
worker at startup with a message naming the option, which matters for a long-running
process on someone else's machine: a `--interval-ms` that does not parse would otherwise
poll with no delay at all instead of failing.

## Operational Checks

Use these checks in release scripts and health monitors:

```bash
curl -fsS http://127.0.0.1:3000/v1/x/health
curl -fsS http://127.0.0.1:3000/v1/x/metrics/summary \
  -H "Authorization: Bearer ${MANAGED_AGENTS_API_KEY}"
```

The production deployment URL should terminate TLS before reaching the runtime.
The runtime itself currently serves HTTP only.
