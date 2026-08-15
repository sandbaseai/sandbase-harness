# Changelog

## 0.3.2 - 2026-08-15

### Highlights

- **Containerized MCP bridge**: adds `Dockerfile.mcp` and `.dockerignore` for
  the six-tool stdio bridge, with OCI and MCP server metadata.
- **Verified container build**: CI now builds the production MCP image from a
  clean checkout so broken Docker packaging blocks future changes.
- **Release-aligned quick start**: source, Docker, installation, deployment,
  and DeepSeek Harness examples now pin the immutable v0.3.2 tag that contains
  every referenced file.
- **Project trust and discovery**: adds security and contribution policies,
  private vulnerability reporting, and a direct SandBase Agent Skills link.

## 0.3.0 - 2026-08-14

### Highlights

- **DeepSeek Harness integration**: ships an installable Cordis bundle and the
  `managed-agents-mcp` stdio server so DSH can create and inspect agents,
  manage persistent sessions, stream turns, retrieve artifacts, and cancel
  runs through MCP.
- **Verified integration guide**: adds a reproducible DSH configuration,
  permission boundaries, troubleshooting guidance, and compatibility evidence
  against DeepSeek Harness commit `47f9438`.
- **DeepSeek V4 reasoning controls**: forwards Settings V2 `reasoning_effort`
  values to OpenAI-compatible model requests and documents a verified
  DeepSeek V4 setup.
- **Distribution metadata**: corrects package repository links to
  `sandbaseai/sandbase-harness` and adds Glama maintainer metadata for MCP
  directory verification.

## 0.2.0 - 2026-08-01

### Breaking changes

- **Workspace state directory moved**: runtime state (database, config, logs)
  now lives at `<workspace>/.managed-agents/` instead of
  `~/.managed-agents/<name>-<hash>/`. Existing workspaces need their state
  moved manually or will re-initialize on next start.
- **`composeRuntimeFromSettings`**: the `memorySeedEnabled` parameter was
  removed; use `settingsSeed: { memoryEnabled: true }` instead.
- **Legacy provider endpoints permanently removed**: `/v1/x/model-providers`,
  `/memory-providers`, `/storage-providers` return 404. Use
  `/v1/x/settings` to configure providers.

### Highlights

- **Runtime decomposition**: the monolithic route and session files are split
  into focused modules (environments, files, credential-vaults, memory-stores,
  runtime, settings, templates, session-normalizers, session-stream,
  session-records, session-lifecycle, session-recovery, secrets,
  skill-packages, skill-resources, resource-utils). `resources.ts` and
  `extended.ts` are now pure composition roots.
- **Sandbox backends**: local process, Docker (with per-session container
  labels and path confinement), and Kubernetes (kubectl exec/cp transport)
  are shipped; Environment write-side validation rejects unknown providers.
- **Docker environment mode**: `hosting_type: docker` with image/resources
  fields in the Environment config.
- **Console improvements**: YAML/JSON agent config editor, fix modal crashes,
  session send failure handling, environment editor polish, settings form
  splitting.
- **Release gate**: `npm run release:check` covers typecheck (src + tests),
  full test suite, production build, package dry-run, CLI init smoke, and
  example workspace startup.
- **Model registry**: `resolveModelConfig()` supports `openai/gpt-5.5`-style
  qualified model references.
- **Workspace registry**: `managed-agents init` and
  `createRegisteredWorkspace` write config to `.managed-agents/config.yaml`,
  consistent with the runtime's path resolution.

### Stats

- 75 test files, 569 tests (up from 67 / 544 in 0.1.0).
- 24 new source modules, 7 new test files.
- `release:check` passes on a clean checkout.

## 0.1.0 - 2026-07-18

First public release of `managed-agents`.

### Highlights

- Local-first managed agent runtime with a Claude Managed Agents-style `/v1`
  API surface.
- React Dashboard for agents, sessions, environments, credential vaults,
  memory stores, files, skills, settings, logs, monitoring, and API reference.
- SQLite-backed runtime state stored outside source-controlled workspaces by
  default.
- Settings V2 for one workspace model vendor, loop engine, storage backends,
  context-memory backend, sandbox provider, API keys, validation, and restart
  flows.
- Session lifecycle, event replay, resumable SSE streams, memory resources,
  file resources, credential vaults, snapshots, local/Docker/self-hosted
  sandbox registration, MCP tools, and skill packages.
- TypeScript SDK and CLI commands for init, start, list, reload, chat, deploy
  guidance, and templates.
- Release gate covering typecheck, tests, production build, package dry-run,
  CLI init smoke, and example workspace startup smoke.

### Known first-release boundaries

- One active model vendor, one built-in loop engine, SQLite metadata storage,
  local artifact storage, SQLite memory, and runtime-registered sandbox
  providers are supported in 0.1.0.
- Planned adapters such as S3, Postgres/MySQL, mem0, MemU, Harness, Codex, and
  Claude loop engines remain unavailable until their runtime implementations
  are added.
- Live remote model credential checks and production deployment examples are
  tracked as follow-up work.
