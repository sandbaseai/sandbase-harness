# V1 Local-First Architecture Review

This spec captures the current architecture review and the reduction plan for
the first open-source release of `managed-agents`.

The first version should help a user clone, configure one model vendor, upload
files and skills, create an agent, and run a local session quickly. It should
not look like a hosted provider marketplace before those adapters are actually
implemented and verified.

## Product Position

`managed-agents` v1 is a local-first Dashboard and runtime control plane for
Forward Deployed Engineers and agent builders.

It should feel close to Claude Managed Agents Console in structure, but it is
not a cloud clone. The default path is:

1. Runtime metadata in SQLite.
2. Uploaded files, skills, and session artifacts on the local filesystem.
3. One active model provider boundary.
4. One built-in loop engine: `managed-agents`.
5. One context memory backend by default: SQLite.
6. One sandbox backend by default: local.
7. Extension points are visible only when they have a real adapter, validation
   probe, docs, and tests.

## Architecture Decision

The v1 settings model is not a list of many providers. It is a single active
runtime configuration:

```yaml
model_provider:
  vendor: anthropic | openai | openai-compatible
  base_url: string
  api_key_env: string

loop_engine:
  type: managed-agents
  config: {}

storage:
  metadata:
    type: sqlite
    path: <workspace>/.managed-agents/data.db
  artifacts:
    type: local_filesystem
    path: <workspace>/.managed-agents/files

memory:
  backend:
    type: sqlite
    path: <workspace>/.managed-agents/data.db

sandbox:
  type: local
  config: {}
```

Advanced future values such as `harness`, `codex`, `claude`, `postgres`, `s3`,
`mem0`, `MemU`, `docker`, `self_hosted`, and remote sandboxes can stay in the
architecture as extension points, but they should not be first-run controls
unless the repository includes a working adapter and an executable validation
test.

## Current Review Findings

### 1. Settings API is moving in the right direction

`src/core/settings/schema.ts` already models one active model provider, loop
engine, metadata storage backend, artifact storage backend, memory backend, and
sandbox backend. It also separates `implemented` and validation status.

Keep this API as the canonical user-facing settings surface:

- `GET /v1/x/settings`
- `PUT /v1/x/settings`
- `PATCH /v1/x/settings`
- `POST /v1/x/settings/validate`

The Console should read and write through these endpoints.

### 2. Provider CRUD APIs created the wrong mental model for v1

The following endpoints previously behaved like a provider marketplace:

- `/v1/x/model-providers`
- `/v1/x/memory-providers`
- `/v1/x/storage-providers`

They allow creating records for providers that do not have runtime adapters,
then mark them as `adapter_required`. This is internally understandable, but
externally confusing. A new user sees selectable or creatable Postgres/S3/mem0
style records and assumes the product supports them.

V1 should either:

- remove these endpoints before release, or
- quarantine them as internal/experimental endpoints that are not used by the
  Dashboard, README, SDK quickstart, or first-run docs.

Because the project is not launched yet, the cleaner choice was removal rather
than compatibility preservation. The v1 public API now uses `/v1/x/settings`
for writes and `/v1/x/runtime` for read-only runtime summaries.

### 3. SDK and CLI use settings instead of provider management

The old SDK model-provider helper and `managed-agents models ...` command were
removed from the v1 public surface. This avoids encouraging a “manage many
providers” workflow while the product direction is “configure one provider
boundary”.

For v1, SDK and CLI expose:

- settings get
- settings patch
- settings validate

Provider CRUD helpers should be removed or moved under an explicitly
experimental namespace before the first public release.

### 4. Tests bless historical complexity

Integration tests currently assert that memory/storage provider records can be
created for future adapters such as mem0, external databases, Postgres, and S3.
Those tests are preserving the wrong behavior for v1.

Replace them with tests that assert:

- fresh runtime has SQLite metadata storage;
- fresh runtime has local artifact storage;
- fresh runtime has SQLite memory;
- settings validation reports unsupported backends as errors;
- the Dashboard does not show “Add provider” or provider marketplace controls;
- first-run docs do not instruct users to create provider records.

### 5. Public docs still overpromise advanced adapters

README and docs mention Local/Docker/self-hosted sandbox support and multiple
model adapters in the feature list. Some of that exists as implementation or
extension code, but it should not be presented as the primary v1 promise.

The public first-run path should say:

- local sandbox is the default;
- Docker/self-hosted/remote are advanced extension paths;
- SQLite and local filesystem are the default durable stores;
- model provider configuration is one active boundary, not a catalog.

### 6. App structure has improved, but root ownership should stay strict

`apps/console/src/App.tsx` has already been reduced by splitting Console pages
into page modules. Keep pushing in that direction:

- `App.tsx`: data loading, mutations, route dispatch, top-level layout only.
- `components/pages/settings/*`: all settings views and forms.
- `components/pages/*`: route-specific list/detail pages.
- No settings-specific provider-list logic should drift back into `App.tsx`.

## V1 Configuration Shape

### Models

One active provider boundary. No global model id picker and no model catalog.

Required UI fields:

- vendor
- base URL
- API key environment variable or managed secret reference

Validation:

- vendor must be set;
- base URL should be required for local/OpenAI-compatible providers;
- raw API keys must not be returned by API responses;
- `model: default` in agent YAML resolves through the active provider boundary.

### Loop Engine

One active loop engine.

Implemented:

- `managed-agents`

Roadmap only:

- Harness
- Codex
- Claude

Validation:

- unsupported engines return validation error;
- UI can show roadmap text, but not as enabled selectable choices unless the
  adapter exists.

### Storage

Storage has two flat sections, not multiple provider rows:

- Metadata storage
- Artifact storage

V1 implemented:

- metadata: SQLite
- artifacts: local filesystem

Roadmap:

- metadata: Postgres/MySQL
- artifacts: S3-compatible object storage

Validation:

- unsupported storage types return validation error;
- no “Add provider” control;
- no defaulting to non-runtime-capable storage.

### Memory

Memory settings configure the context memory backend, not Memory Stores.

V1 implemented:

- SQLite context memory
- in-memory transient context memory for tests/dev

Roadmap:

- external DB
- mem0
- MemU

Validation:

- unsupported memory backends return validation error;
- Memory Stores remain resource collections, separate from runtime memory
  backend configuration.

### Sandbox

Sandbox settings configure the execution backend.

V1 default:

- local

Advanced:

- docker
- kubernetes
- self-hosted worker

Roadmap:

- managed hosted sandbox

Every backend declares an explicit capability set — `isolatedExecution`,
`hostFilesystem`, `resourceLimits`, `streamingExec` — and the runtime reads it
instead of inferring support from optional fields. This is what keeps the P3
gate checkable in code rather than only in prose: a backend cannot appear to
support snapshots or resource limits it does not enforce.

`local` declares `isolatedExecution: false`. Path confinement and an
environment allowlist are not a security boundary, and the settings surface
should not imply otherwise.

Validation:

- selected provider must be available in the running process;
- local default must work without Docker, `kubectl`, or external services;
- an Environment naming an unregistered provider fails at provision time with
  the registered providers listed. It must never fall back to another backend:
  silently running unsandboxed after an isolated backend was requested is a
  security regression, not a degraded experience;
- a capability the selected backend lacks is reported, not silently dropped.

## Implementation Plan

### P0 — Freeze the first-run contract

- Add this spec and make it the first reading item.
- Update README and docs to describe the local-first first-run path.
- Ensure Settings pages show only the canonical settings shape.
- Ensure no public first-run doc recommends `/v1/x/*-providers`.

Acceptance:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

### P1 — Replace provider marketplace API usage

- [x] Add SDK helpers for `/v1/x/settings`.
- [x] Replace Dashboard and CLI settings flows with canonical settings endpoints.
- [x] Remove model provider CLI commands in favor of settings commands.
- [x] Update API matrix so provider CRUD endpoints are gone from the v1
      resource matrix.

Acceptance:

- Tests create/update settings through `/v1/x/settings`.
- No Console page needs `/v1/x/model-providers`, `/v1/x/memory-providers`, or
  `/v1/x/storage-providers` for first-run rendering.

### P2 — Delete provider CRUD endpoints

- [x] Delete provider CRUD routes after no first-run path depends on them.
- [x] Delete `adapter_required` creation tests for Postgres/S3/mem0/MemU.
- [x] Keep database tables only as internal persistence for the canonical
      settings API and read-only runtime summary.

Acceptance:

- Grep for `/v1/x/model-providers`, `/v1/x/memory-providers`, and
  `/v1/x/storage-providers` returns only migration notes or intentionally
  deprecated compatibility comments.

### P3 — Reintroduce adapters only with real behavior

An adapter can return to public UI/docs only when all of these exist:

- runtime implementation;
- settings schema support;
- validation probe;
- unit tests;
- integration or smoke test;
- concise user docs;
- failure behavior that does not corrupt local data.

## V1 Smoke Test

The release smoke test should be simple enough for a new open-source user:

```bash
git clone https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

Then verify:

1. `http://127.0.0.1:3000/dashboard` opens.
2. Settings validation passes with local SQLite/local filesystem defaults after
   a model provider key is configured.
3. Uploading a file stores metadata in SQLite and content under the local data
   directory.
4. Uploading a skill ZIP validates `SKILL.md` and stores it locally.
5. Creating an agent with `model: default` works.
6. Starting a session uses the local sandbox and persists events.
7. Logs and Monitoring show the running local process.

## Keep / Cut Summary

| Area | Keep for v1 | Cut or hide before v1 |
| --- | --- | --- |
| Models | One active vendor/base URL/key boundary | Model catalog, model-id registry, multiple provider CRUD |
| Loop engine | `managed-agents` | Harness/Codex/Claude as enabled choices |
| Metadata storage | SQLite | Postgres/MySQL controls without adapters |
| Artifact storage | Local filesystem | S3 controls without adapter |
| Memory backend | SQLite, in-memory for dev/tests | mem0/MemU/external DB controls without adapters |
| Memory Stores | Resource CRUD | Treating stores as backend config |
| Sandbox | Local default; Docker/Kubernetes/worker as advanced opt-ins with real probes | Backends without a reachable transport shown as selectable |
| Console | Claude-like local Dashboard | Fake enterprise/cloud controls |
| Docs | Fast local start | Provider marketplace wording |
