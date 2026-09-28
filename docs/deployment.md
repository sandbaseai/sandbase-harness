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
backend is selected by `Settings > Sandbox` or by an Environment's
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
being left claimed. Useful flags:

| Flag | Purpose |
| --- | --- |
| `--once` | Claim and run at most one item, then exit. |
| `--interval-ms <ms>` | Delay between polls when the queue is empty (default `1000`, minimum `250`). |
| `--heartbeat-ms <ms>` | Renew the claim on this interval while an item runs (default `20000`, minimum `25`). |
| `--heartbeat-timeout-ms <ms>` | How long to wait for a renewal to be answered before reporting it as unconfirmed (default `10000`, minimum `1`). |
| `--ack-timeout-ms <ms>` | How long to wait for the runtime to confirm a claim before giving up on the item (default `10000`, minimum `1`). |
| `--worker-id <id>` | Identity reported on the claim and the completion (default `worker_<pid>`). |

A claim carries a lease window (60s by default), so a worker that executed a long
item silently would have it reclaimed and handed to a second worker while the first
was still running it. While an item runs, the worker therefore renews its own claim
every `--heartbeat-ms`, and stops renewing when the item finishes. A failed renewal
is logged and the command keeps running: the server refuses a completion from a worker
that no longer holds the claim, and stopping a command halfway on a suspicion that the
claim lapsed would leave a half-applied side effect.

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

An unusable `--port`, `--interval-ms`, `--heartbeat-ms`, `--heartbeat-timeout-ms` or
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
