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
          image: your-registry.example/sandbase-harness:v0.3.0
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

## Operational Checks

Use these checks in release scripts and health monitors:

```bash
curl -fsS http://127.0.0.1:3000/v1/x/health
curl -fsS http://127.0.0.1:3000/v1/x/metrics/summary \
  -H "Authorization: Bearer ${MANAGED_AGENTS_API_KEY}"
```

The production deployment URL should terminate TLS before reaching the runtime.
The runtime itself currently serves HTTP only.
