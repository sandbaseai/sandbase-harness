# Installation

This guide covers installing and starting `managed-agents` in a local
workspace. The runtime is a single Node.js process that serves both the HTTP API
and the local Console.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- A model vendor API key or an OpenAI-compatible local endpoint
- Docker, only when using Docker-backed sandboxes

## Install From A Tagged Source Release

The unscoped `managed-agents` package currently visible on npm is not this
project. Until an official scoped package is announced in this repository, use
the tagged GitHub source release and do not run `npx managed-agents` or
`npm install managed-agents`.

```bash
git clone --branch v0.3.4 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../my-agents
cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

The Dashboard will be available at:

```text
http://127.0.0.1:3000/dashboard
```

The API will be available at:

```text
http://127.0.0.1:3000/v1
```

## Optional Source Command Links

From the tagged source checkout, `npm link` exposes the two locally built
executables on a workstation. This does not download the unrelated unscoped
npm package:

```bash
cd sandbase-harness
npm link
cd ../my-agents
managed-agents init
managed-agents start
```

Remove the source links with:

```bash
cd sandbase-harness
npm unlink -g
```

## Build From Source

Use a source checkout when contributing to the project:

```bash
git clone https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
```

Before publishing or handing off a release branch, run:

```bash
npm run release:check
```

This validates type safety, tests, production builds, npm package contents, CLI
workspace initialization, and `examples/basic` startup.

Then create a runtime workspace outside the source checkout:

```bash
mkdir ../my-agents
cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

During development, run the TypeScript entry point directly:

```bash
npm run dev
```

Run the Dashboard Vite server separately when iterating on frontend code:

```bash
npm run dev:console
```

## Initialize A Workspace

Create a workspace with the default seed directories and example files:

```bash
managed-agents init
```

When running from a source checkout without a global install, use:

```bash
node /path/to/managed-agents/dist/index.js init
```

This creates:

```text
agents/
skills/
.managed-agents/
  config.yaml
  data.db
  logs/runtime.log
```

`agents/` and `skills/` are optional seed/import folders. Runtime metadata,
uploaded resource state, and logs live inside the workspace state directory.

## Configure The Model Vendor

Start the runtime, open the Dashboard, and go to `Settings > Models`.

```text
http://127.0.0.1:3000/dashboard#models
```

Configure the workspace model vendor, then click `Validate` or
`Check configuration` before saving:

- `Vendor`: `anthropic`, `openai`, `minimax`, or `openai_compatible`
- `Base URL`: required for OpenAI-compatible local or hosted endpoints
- `API key`: the provider key for model requests

Runtime model connection settings live in `.managed-agents/config.yaml`. Agents
set concrete model IDs in their own definitions, for example `model: gpt-4o` or
`model: openai/gpt-5.5`. The workspace model config supplies provider
credentials and base URL only.

For MiniMax regional endpoints and supported model IDs, follow the
[MiniMax configuration guide](minimax.md).

The same file should make the local storage defaults explicit:

```yaml
storage:
  metadata:
    provider: sqlite
    options: {}
  artifacts:
    provider: local
    options:
      base_path: files
```

The same Settings page also configures the single active Loop engine, Storage
backends, Memory backend, and default Sandbox. Docker appears as available only
when the runtime detects Docker support. Planned adapters such as S3, mem0,
MemU, Codex, Harness, and Claude are shown as unavailable until a real runtime
adapter exists.

## Configure Environments

Every session runs in an environment. The default local environment is enough
for a first run:

```yaml
environments:
  local:
    sandbox_provider: local
    timeout: 300
```

Docker-backed environments can be added when command execution needs stronger
process isolation:

```yaml
environments:
  docker:
    sandbox_provider: docker
    image: node:22-slim
    resources:
      memory: 1g
      cpu: 1
    timeout: 300
```

Docker mode creates one long-lived container per session and runs tool commands
with `docker exec` inside `/workspace`. The Docker CLI and daemon must be
available to the local runtime process; if Docker is not detected, the Console
marks the adapter unavailable and existing Docker environments cannot start new
containers until Docker is running again.

## Start Options

```bash
managed-agents start \
  --host 127.0.0.1 \
  --port 3000 \
  --config .managed-agents/config.yaml \
  --agents-dir agents \
  --skills-dir skills
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Bind address for the API and Console. |
| `--port` | `3000` | HTTP port. |
| `--workspace` | `.` | Workspace root containing config, data, logs, agents, and skills. |
| `--config` | `.managed-agents/config.yaml` | Runtime configuration file. |
| `--agents-dir` | `agents` | Directory containing agent YAML files. |
| `--skills-dir` | `skills` | Directory containing skill packages. |
| `--data-dir` | `.managed-agents` | SQLite database, uploaded files, and runtime data. |
| `--log-file` | `.managed-agents/logs/runtime.log` | Structured runtime log file. |
| `--target` | unset | Optional runtime target label surfaced in the Console. |

Pass `--workspace` for a different workspace root, or override `--config`,
`--data-dir`, and `--log-file` individually.

The API and Dashboard are served from the same origin. CORS is restricted by
default to same-origin and local loopback browser origins. For a deployed
Console or a trusted separate frontend, set a comma-separated allowlist:

```bash
export MANAGED_AGENTS_CORS_ORIGINS=https://console.example.com,https://admin.example.com
managed-agents start --host 0.0.0.0
```

## Enable API Authentication

Local development is open by default. Authentication turns on when at least one
API key exists. You can create managed keys from the Console/API, or set a
static key before starting the runtime:

```bash
export MANAGED_AGENTS_API_KEY=sk-local-example
managed-agents start
```

Clients must then send:

```text
Authorization: Bearer sk-local-example
```

Managed keys created through `/v1/api-keys` are stored in SQLite as hashes. The
raw `secret_key` is returned only once when the key is created.

## Verify The Install

Check the runtime:

```bash
curl http://127.0.0.1:3000/v1/x/health
```

List agents:

```bash
curl http://127.0.0.1:3000/v1/agents
```

Open the Dashboard:

```text
http://127.0.0.1:3000/dashboard
```

## Troubleshooting

If the Dashboard loads but agents are missing, run:

```bash
managed-agents reload
```

For a source checkout, run the same command through the built entry point:

```bash
node /path/to/managed-agents/dist/index.js reload
```

If sessions fail to start, check:

- The agent `model` value matches a configured model name.
- Required provider API keys are set in the shell that started the runtime.
- The requested `environment_id` exists and is active.
- Uploaded file resources use mount paths under `/uploads/`.
