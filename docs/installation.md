# Installation

This guide covers installing and starting `managed-agents` in a local
workspace. The runtime is a single Node.js process that serves both the HTTP API
and the local Console.

## Recover A Plugin Hub Install

If the DSH Plugin Hub reports `already installed: managed-agents` after a
partial or repeated install, update the Hub and remove only the exact residual
entry shown in its Installed view before retrying the tagged HTTPS Git source:

```bash
dsh plugin --profile web update dsh-plugin
dsh plugin --profile web remove managed-agents
dsh plugin --profile web add git+https://github.com/sandbaseai/sandbase-harness.git
```

Use the identifier shown by the Installed view if it differs from
`managed-agents`. Do not delete the whole DSH home or install the unrelated
unscoped npm package. Keep the profile and Hub log until the runtime starts;
see [Issue #78](https://github.com/sandbaseai/sandbase-harness/issues/78) for
the original report and recovery discussion.

A git-source add builds `dist/` through the package's `prepare` script, and
pnpm blocks that script on first run with
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Add the exact key pnpm prints under
`allowBuilds:` in the profile's `pnpm-workspace.yaml`, then re-run the add
command — the same workaround the
[DeepSeek Harness example](../examples/deepseek-harness/README.md#troubleshooting)
documents. A checkout added with `dsh plugin add -w <path>` skips `prepare`
entirely but needs a local `npm run build` first.

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
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
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

Start the runtime, open the Dashboard, and go to `Settings > Advanced`, then
`Model provider editor`.

```text
http://127.0.0.1:3000/dashboard#models
```

Configure the workspace model vendor, then click `Validate` or
`Check configuration` before saving:

- `Vendor`: `anthropic`, `openai`, `minimax`, or `openai_compatible`
- `Base URL`: required for OpenAI-compatible local or hosted endpoints
- `API key`: the provider key for model requests

The Dashboard writes the effective model configuration. `.managed-agents/config.yaml`
seeds it once, on the first start of a workspace:

```yaml
model:
  provider: openai_compatible
  base_url: https://gateway.example.com/v1
  api_key: ${GATEWAY_API_KEY}
```

On that first start the `model` section above is imported into the workspace
settings and becomes the effective configuration. On every later start the saved
settings document is the single effective source, so editing this section
afterwards changes nothing — the runtime warns at startup when the file and the
effective settings differ, and says which source wins. Update the model provider
in `Settings > Setup`, or start from a new workspace to re-import the file.

The `model` section supplies the provider, the base URL, and the API key. Two
things placed there are not applied, and the runtime names them at startup rather
than dropping them silently: a concrete model ID, which belongs to an Agent, and
the vendor `options` bag, which has no column in the model record this file
seeds.

A model ID that carries a vendor namespace is passed to the provider unchanged,
which is what an OpenAI-compatible gateway expects. A reference is read as
`provider/model` only when the leading token names a configured provider — the
provider type, such as `openai` or `anthropic`, or the name a provider is
registered under. Otherwise the whole string is the model ID.

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

The Settings area also configures the single active Loop engine, Storage
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
    resources:
      memory: 1g
      cpu: 1
    timeout: 300
```

Docker mode creates one long-lived container per session and runs tool commands
with `docker exec` inside `/workspace`. The default image is the published
reference sandbox image `ghcr.io/sandbaseai/sandbase-harness-sandbox:latest`
(pulled on first use); set `image` to pin a release tag or a mirror. The Docker
CLI and daemon must be available to the local runtime process; if Docker is not
detected, the Console marks the adapter unavailable and existing Docker
environments cannot start new containers until Docker is running again. This
includes `cloud`-declared Environments, which resolve to the docker backend.

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
