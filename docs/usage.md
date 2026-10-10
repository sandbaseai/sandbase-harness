# Usage Guide

`managed-agents` provides a local control plane for building, running, and
debugging managed agents. The usual workflow is:

1. Create or import an agent.
2. Attach skills, tools, MCP servers, files, memory stores, or credentials.
3. Start a session in an environment.
4. Inspect the transcript and debug event stream.
5. Iterate on the agent definition and save new versions.

## Workspace Layout

A workspace is a folder that contains runtime configuration, runtime state, and
optional seed agent definitions and skill packages. Live metadata is stored in
SQLite under the workspace state directory.

```text
my-agents/
+-- agents/                  # Optional seed agent definitions
|   +-- assistant.yaml
+-- skills/                  # Optional seed skill packages
|   +-- code-review/
|       +-- SKILL.md
+-- .managed-agents/
    +-- config.yaml
    +-- data.db              # SQLite metadata store
    +-- logs/
    |   +-- runtime.log
    +-- files/               # Uploaded file bytes
    +-- skills/              # Uploaded custom skill package assets
    +-- snapshots/           # Session workspace snapshots
    +-- sandbox/             # Local session workspaces
```

The workspace is portable. Commit examples, templates, config, and any seed
definitions you intentionally maintain. Keep `.managed-agents/data.db`,
`.managed-agents/logs/`, `.managed-agents/files/`, and sandbox state out of
source control unless you intentionally want to snapshot local runtime data.

Workspaces are listed in a registry at `$MANAGED_AGENTS_HOME/workspaces.json`,
which defaults to `~/.managed-agents/workspaces.json`. Set `MANAGED_AGENTS_HOME`
to keep several registries apart — for example one per project, or a throwaway
one in tests — and `managed-agents workspace list` will read that one instead.

## Agent Definitions

Agents can be imported from YAML files in `agents/` or created through the
Console/API. Once loaded, the runtime source of truth is SQLite.

```yaml
name: assistant
description: Helps with development tasks.
model: gpt-4o
system: |
  You are a helpful assistant. Answer clearly and use tools when needed.
mcp_servers: []
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
skills:
  - type: custom
    skill_id: skill_code-review
metadata:
  owner: platform
```

`permission_policy.type` accepts `always_allow`, `always_ask`, `never_allow`,
and the opt-in `auto`, which judges each call with a local model evaluation
(`allow` runs it, `deny` refuses it with an error result, `ask` holds it for
`user.tool_confirmation`, and any evaluation failure parks the call rather
than allowing it).

### External authorization freshness

Long-running sessions can outlive the authorization they were granted under.
Set `MANAGED_AGENTS_EXTERNAL_AUTHZ_ENDPOINT` to an external control plane and
every governed tool call the local policy admits is presented to it before
execution — a veto-only, fail-closed check that composes with the policies
above rather than replacing them:

- The runtime POSTs a `sandbase.authz/v1` envelope (`session_id`,
  `invocation_id`, `capability`, `target`, `arguments_digest`,
  `policy_context_digest`; digests are SHA-256 over canonical JSON under
  `sandbase.digest/v1`, so a policy change alters the digest and makes a prior
  authorization read as stale).
- The endpoint answers `{"decision": "allow"|"deny"|"reauthorize", ...}`;
  `deny` and `reauthorize` refuse the call with a synthetic error result.
  `allow` never widens a local denial — the hook only sees calls the local
  policy already cleared.
- Timeout (`MANAGED_AGENTS_EXTERNAL_AUTHZ_TIMEOUT_MS`, default 2000 ms),
  unreachable endpoints, HTTP errors, and malformed responses all refuse the
  call — an unreadable verdict never reads as permission.
- `MANAGED_AGENTS_EXTERNAL_AUTHZ_TOKEN` adds a bearer header for the
  authorizer.
- Every refusal is persisted as an `agent.external_authorization` audit event
  carrying the reason code and digests — no raw arguments and no secrets.

Unset means no check: with the endpoint absent the permission/approval path
is exactly what it always was.

Agent ids are stable object identifiers. YAML seed agents use deterministic ids
when they are first imported, while agents created through the API or Console
receive server-generated `agent_...` ids. Use the returned id in API calls,
sessions, and SDK requests; treat `name` as a human-readable display field.

## Dashboard Workflow

Start the runtime:

```bash
managed-agents start
```

Open:

```text
http://127.0.0.1:3000/dashboard
```

Setting up a first conversation takes two steps, both on `Settings > Setup`:

1. **Save the model provider** — the vendor, its base URL when it is an
   OpenAI-compatible endpoint, and the API key. The key may be a `${VAR}`
   reference; the runtime resolves it from the environment it was started with.
   A saved provider is not active until the runtime restarts (`restart_required`
   is what the settings response reports), and the page offers the restart.
2. **Set each agent's model** — the `Agent models` panel lists every agent and the
   model id it currently names, and saves a change in place. This step is not
   optional: an agent carries its own model id, and the one `init` writes
   (`gpt-4o`) has to be replaced with an id the configured provider serves. DeepSeek
   through an OpenAI-compatible endpoint, for example, uses `deepseek-chat`.

If a saved key is a `${VAR}` reference the runtime cannot resolve, the panel names
the variable and a turn sent before it is set fails with a message naming that
same variable — never with a provider `401` that hides it. Saving the form itself
refuses an unresolved reference before it is stored, so this is the state a
variable leaves behind when it is unset in a later start, or when the reference
came from `.managed-agents/config.yaml`.

The Dashboard includes:

- Workspace and local runtime status
- Agent templates and agent versions
- Session creation and session debug timelines
- Runtime Settings for the single workspace model vendor, loop engine,
  storage backends, context-memory backend, and default sandbox
- Environments
- Credential vaults and credentials
- Memory stores and memory entries
- File upload and file resources
- Skill upload and skill details

## Runtime Settings

Open `Settings > Advanced` and pick `Model provider editor`, `Loop engine
editor`, `Storage editor`, `Memory editor`, or `Sandbox editor` to edit the
workspace runtime configuration. Settings V2 stores one versioned JSON
document in SQLite under the runtime data directory. Each editor owns one
section of that document: `Model provider editor` edits `model`, `Loop engine
editor` edits `loop_engine`, `Storage editor` edits `storage`, `Memory editor`
edits `memory`, and `Sandbox editor` edits `sandbox`. The Form and JSON tabs are two views of that current
section, and saving merges the section back into the versioned document.

The usual sequence is:

1. Change the relevant field.
2. Click `Save settings`; the Dashboard validates the change before saving.
3. Optionally run `Check configuration` for a local capability check when you
   need diagnostics before or after saving.
4. Restart the runtime when the page shows `Restart required`.

All first-release Settings V2 fields require a runtime restart before they
become effective. Until restart, API responses expose both `saved_config` and
`effective_config`; sessions continue using the effective revision.

The same document is available to code. `client.settings.get()` returns the
`GET /v1/x/settings` response — `revision`, `saved_config`, `effective_config`,
`restart_required`, `secret_states`, and the `adapters` catalogue.
`client.settings.patch({ model: { vendor: 'anthropic' } })` merges that partial
document over the stored one and writes the result with the revision it read, so
a concurrent writer is refused with `409` instead of being overwritten; there is
no automatic retry. A document the runtime would reject is refused before the
write and throws `RuntimeSettingsValidationError`, whose `errors` name each
failing field, including the environment variable behind an unresolvable
`${NAME}` reference. `client.settings.validate(config)` asks about a candidate
document without saving it and returns `{ valid, errors, warnings }`. Secrets
survive the round trip: a stored literal key reads back as `********`, and that
sentinel means "keep the stored value" when it is written again.

The workspace has one active model vendor, one built-in loop engine, SQLite
metadata storage, local artifact storage, one context-memory backend, and one
default sandbox provider. Named Environments can still override the default
sandbox per session. Planned adapters such as S3, mem0, MemU, Harness, Codex,
and Claude remain unavailable until their runtime implementations exist; Docker,
Kubernetes, and remote sandbox providers appear as available only when the
current runtime can reach their transport. Remote sandbox maps to the
self-hosted worker queue: configure the worker API URL and key so external
workers can claim and complete queued work items; the Settings check calls the
remote `/v1/x/health` endpoint.

## Sandbox Backends

A sandbox is where an agent's tool commands actually run. One sandbox is bound
to one session for that session's lifetime.

Each backend declares what it can do, and the runtime reads those capabilities
instead of assuming them. Requesting something a backend cannot provide is
reported in the runtime log rather than silently dropped.

| Backend | Selected as | Isolated from runtime host | Host workspace | Resource limits | Transport |
| --- | --- | --- | --- | --- | --- |
| Local process | `local` | No | Yes | No | Child process |
| Docker | `docker` | Yes | No | Yes | `docker` CLI |
| Kubernetes | `kubernetes` | Yes | No | Yes | `kubectl` CLI |
| Self-hosted worker | `remote` in Settings, `self_hosted` in an Environment | Runs off-host | No | No | Work-item queue |

Consequences worth knowing before choosing one:

- **Local is not a VM boundary.** File tools are confined to the session
  workspace and the child process environment is reduced to an allowlist. On
  POSIX hosts carrying the tooling, commands additionally run under OS-level
  confinement — `sandbox-exec` on macOS or `bubblewrap` on Linux — which
  denies writes outside the session workdir, temp dirs, and device files while
  leaving reads and egress untouched. It is a best-effort seatbelt/namespace
  boundary, not a kernel VM boundary: the command still runs as the same OS
  user on the same machine, and a host without the tooling falls back to
  plain subprocesses. `MANAGED_AGENTS_LOCAL_ISOLATION=off` disables the wrap,
  `=require` makes a missing tool fail the command instead of degrading, and
  `MANAGED_AGENTS_LOCAL_ISOLATION_WRITE_PATHS` lists extra writable roots for
  toolchains that need them. Windows has no equivalent — nothing is wrapped
  there. Use `local` for trusted development and `docker` for untrusted agent
  output.
- **Workspace snapshots need a host workspace.** Only `local` exposes one, so
  snapshots are unavailable on the other three. Enabling them anyway logs a
  warning naming the missing capability.
- **Resource limits are honored only by `docker` and `kubernetes`.** Setting
  `resources` on `local` or `remote` logs a warning instead of appearing to
  apply.

A backend is offered only when the runtime can reach its transport: no Docker
daemon means `docker` is not registered, and no reachable cluster means
`kubernetes` is not registered. An Environment naming a backend that is not
registered fails when the session provisions its sandbox, with an error listing
the backends that are registered. It does not fall back to local execution —
quietly running unsandboxed after an isolated backend was requested would be a
worse outcome than a failed session.

Startup logs the registered backends:

```text
  Sandbox:   local, docker, self_hosted
```

### Kubernetes Sandboxes

Requires `kubectl` on `PATH` and a reachable cluster. Each session becomes one
Pod running `sleep infinity`; commands run through `kubectl exec` and files move
through `kubectl cp`.

Configure it under `Settings > Advanced` → `Sandbox editor`, or per Environment:

```json
{
  "sandbox_provider": "kubernetes",
  "image": "node:22-slim",
  "kubernetes": {
    "namespace": "agent-sandboxes",
    "context": "staging",
    "service_account": ""
  }
}
```

- The image needs `/bin/sh`, `find`, and `tar` (`tar` is what `kubectl cp`
  uses). The default `node:22-slim` has all three.
- `namespace` must be a lowercase RFC 1123 label and defaults to `default`.
- Leaving `service_account` empty creates the Pod with
  `automountServiceAccountToken: false`, so sandboxed commands cannot call the
  Kubernetes API. Only set it when an agent genuinely needs cluster access, and
  scope that account's RBAC accordingly.
- Pods are labeled `app.kubernetes.io/managed-by=managed-agents` and
  `managed-agents/session-id=<session id>`, and are deleted when the session
  reaches a terminal state.

See [Deployment Examples](deployment.md) for the RBAC the runtime itself needs
to create these Pods.

YAML model entries and legacy provider rows are bootstrap/import data for a new
workspace. After Settings V2 is seeded, normal Dashboard edits do not rewrite
source-controlled YAML files and legacy provider mutation endpoints are
read-only compatibility failures.

## Create An Agent

Use the Dashboard `Create agent` action, or add a seed YAML file in `agents/` and
reload to import it into SQLite:

```bash
managed-agents reload
```

Create an agent through the API:

```bash
curl -X POST http://127.0.0.1:3000/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "Helps with development tasks.",
    "model": "default",
    "system": "You are a helpful assistant.",
    "tools": [{ "type": "agent_toolset_20260401" }],
    "skills": [],
    "metadata": {}
  }'
```

## Start A Session

A session is a run of an agent inside an environment.

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent_assistant",
    "environment_id": "env_default",
    "title": "Local smoke test"
  }'
```

The response contains a `sesn_...` id.

Send a user message:

```bash
curl -N -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello", "stream": true}'
```

List events:

```bash
curl http://127.0.0.1:3000/v1/sessions/SESSION_ID/events
```

Resume a live event stream:

```bash
curl -N http://127.0.0.1:3000/v1/sessions/SESSION_ID/events/stream \
  -H "Last-Event-ID: 42"
```

Without the cursor the stream carries live events only, so read
`GET /v1/sessions/SESSION_ID/events` first and pass the last `seq` you saw.

Stop a session:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/stop
```

## Attach Files To A Session

Upload a file:

```bash
curl -X POST http://127.0.0.1:3000/v1/files \
  -F "file=@notes.txt"
```

Create a session with the file mounted under `/uploads/`:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent_assistant",
    "environment_id": "env_default",
    "resources": [
      {
        "type": "file",
        "file_id": "file_abc123",
        "mount_path": "/uploads/notes.txt"
      }
    ]
  }'
```

The logical `mount_path` is mapped under the runtime's own mount root, so that
file is readable inside the session at `/mnt/session/uploads/notes.txt` (a command
the agent runs names the same file by its sandbox-relative spelling,
`mnt/session/uploads/notes.txt`). On the default `local` backend each session gets
a directory under the workspace data directory, so the same bytes are at
`<data-dir>/sandbox/<session_id>/mnt/session/uploads/notes.txt`; on `docker` the
container's filesystem is the sandbox, so the canonical path is the real path and
the bytes land there verbatim. The agent is told
where the file landed: a session with a file or repository resource carries a
`# Session Resources` section in its system prompt naming both spellings on the
`local` backend, so it does not have to guess the path. See
[Mounting a file into a session](api.md#mounting-a-file-into-a-session). A
`self_hosted` worker downloads each attached file through its session work
token and writes it at the mount path under its own root, so the file serves
there too. `kubernetes` was never exercised
against a cluster and does not serve that root, so the runtime refuses the
session rather
than accepting a mount it cannot account for: creating it answers `400` with
`resource_not_mountable` and writes nothing, so use a `local`, `docker`, or
`self_hosted` environment or create the session without the resource.

## Attach A Memory Store

Create a memory store:

```bash
curl -X POST http://127.0.0.1:3000/v1/memory_stores \
  -H "Content-Type: application/json" \
  -d '{"name": "project-memory", "description": "Long-term project notes"}'
```

Add a memory:

```bash
curl -X POST http://127.0.0.1:3000/v1/memory_stores/MEMORY_STORE_ID/memories \
  -H "Content-Type: application/json" \
  -d '{"path": "/notes/overview", "content": "Use concise release notes."}'
```

Mount the store into a session:

```json
{
  "type": "memory_store",
  "memory_store_id": "memstore_abc123",
  "access": "read_write",
  "instructions": "Use this store for durable project notes."
}
```

## Use Credential Vaults

Credential vaults hold credentials that sessions can use without writing
secrets into agent YAML files.

Create a vault:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults \
  -H "Content-Type: application/json" \
  -d '{"name": "production-tools"}'
```

Add an environment variable credential:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-token",
    "auth_type": "environment_variable",
    "variable_name": "GITHUB_TOKEN",
    "value": "ghp_example",
    "network": {
      "type": "limited",
      "allowed_hosts": ["api.github.com"]
    },
    "injection_locations": ["request_headers"]
  }'
```

Attach one or more vaults when creating a session:

```json
{
  "vault_ids": ["vlt_abc123"]
}
```

## TypeScript SDK

```typescript
import { ManagedAgentsClient } from 'managed-agents/sdk';

const client = new ManagedAgentsClient({
  baseUrl: 'http://127.0.0.1:3000',
});

const session = await client.sessions.create({
  agent: 'agent_assistant',
  environment_id: 'env_default',
});

for await (const event of client.sessions.chat(session.id, 'Hello')) {
  if (event.type === 'agent.message_chunk') {
    process.stdout.write(event.delta ?? '');
  }
}
```

`managed-agents/sdk` also exports the session workflows the CLI itself is built
on, each taking `client.sessions` as its first argument: `collectReply` streams a
turn and returns `{ text, events }`; `sessionHistory` returns the whole recorded
log, paginated through `next_page` for you; `followSession` yields that log and
then the live stream resumed after the last recorded `seq` — nothing missed,
nothing yielded twice — or starts straight at a `lastEventId` you pass;
`inspectSession` returns the session summary and log together; and `converse`
runs create → message → streamed reply in one call.

A refused request throws `ManagedAgentsApiError`, which carries the published
error envelope's identity as well as its prose: `status`, `type` (for example
`invalid_request_error`, `not_found`, or `conflict`), and `code` when the
runtime names a specific cause (`invalid_agent_ref`, `budget_reached`,
`unsupported_model_field`, `resource_not_mountable`, and others). Branch on those
instead of on the
message, which is prose and may be reworded:

```typescript
import { ManagedAgentsApiError } from 'managed-agents/sdk';

try {
  await client.sessions.create({ agent: 'assistant' });
} catch (error) {
  if (error instanceof ManagedAgentsApiError && error.code === 'invalid_agent_ref') {
    // `agent` takes an agent id, not a name.
  }
  throw error;
}
```

`type` and `code` are `undefined` when the response carried no envelope or the
runtime named no specific cause. The message is unchanged, so existing code that
matches on it keeps working.

## CLI Commands

```bash
managed-agents init
managed-agents start --host 127.0.0.1 --port 3000
managed-agents list
managed-agents reload
managed-agents chat agent_assistant --message "hello"
managed-agents session create --agent agent_assistant
managed-agents session list
managed-agents session message <session-id> --message "hello"
managed-agents session tail <session-id>
managed-agents session inspect <session-id>
managed-agents session logs <session-id>
managed-agents settings get
managed-agents settings validate
managed-agents settings set-model --vendor anthropic --api-key-env ANTHROPIC_API_KEY
managed-agents environments list
managed-agents environments create --name staging --hosting-type local
managed-agents environments inspect <environment-id>
managed-agents environments update <environment-id> --sandbox-provider docker
managed-agents environments archive <environment-id>
managed-agents environments worker-keys <environment-id>
managed-agents workspace create ./my-agents --name "My agents"
managed-agents workspace open ./existing-project
managed-agents workspace list
managed-agents workspace resolve <workspace-id-or-name-or-root>
managed-agents workspace remove <workspace-id-or-name-or-root>
managed-agents template list
managed-agents template install <template-name-or-path>
managed-agents template create <name>
```

`session create` prints the new session id, and `--agent` takes an **agent id**
(default: the first loaded agent): a session's `agent` field is an id, not a name,
and the API refuses a name with `400 invalid_agent_ref`. `session list` prints one
session per line (`id  status  agent  title`), filtered by `--agent`, `--status`
(repeatable), and `--include-archived`; a printed `next page: --page <cursor>`
line continues a long listing, and `--json` prints the raw response envelope.
`session message` streams
the reply unless `--no-stream` is passed, which returns as soon as the runtime
accepts the message. `session tail` follows the live event stream and does not
exit on its own; `session inspect` prints a summary (or the session and its events
as JSON with `--json`) and `session logs` prints every recorded event, one JSON
object per line. Every command accepts `--port` and `--api-key`.

`chat` starts a session on the first loaded agent (or the id you pass), streams
each reply as it is produced, and keeps reading until you interrupt it. `--message`
sends exactly one message and exits, which is the form a script uses.

A turn whose tool needs approval does not fail — it **parks**. The runtime ends the
turn with a `session.status_idle` whose `stop_reason.type` is `requires_action` and
names the blocking events in `stop_reason.event_ids`, and the tool does not run
until each of those is answered. `chat` reads them, asks per call on a terminal
(anything that is not `y` denies), answers with `user.tool_confirmation` addressed
to the event id, and the runtime then continues the same turn on its own. Nothing
extra is typed: the reply to the resumed turn appears under the answer prompt.

`--tool-approval` decides without asking, for a script or a CI job:
`ask` (the default) prompts, `allow` answers every gated call with `allow`, and
`deny` answers every gated call with `deny` and a reason. `allow` is a
preauthorization you state on the command line, which is why it is not the
default. Without `--message` the command reads lines — from a terminal, or from
a redirected stdin — and that same reader answers the prompt, so a pipe can say
`y`: the answer is read when the prompt appears, so a script writes it after the
prompt rather than ahead of it. `--message` is the one-shot form and has no
reader attached: with `ask` it answers nothing at all, prints the calls that are
waiting along with the two ways to decide them, and exits non-zero with the
session still parked, because a tool the operator never saw must not be allowed
by a default. An input that ends while a call waits for its answer is not a
decision either: the call stays parked, the command says so, and it exits
non-zero.

A **custom** tool is the one case `chat` cannot finish. The runtime has no executor
for it, so it waits for a `user.custom_tool_result` that only your own client can
produce: the command prints the exact request that would resume the turn and exits
non-zero, leaving the call parked and the tool unrun.

A turn can also **fail**: the provider refuses the credential, the endpoint is not
reachable, or the model id is not one it serves. The runtime records a
`session.error` naming the cause and ends the turn there — either as a failure the
session continues from, or, when the runtime treats it as terminal, as a session
in the `failed` state. `chat` prints that recorded message and exits non-zero, so a
script that only reads the exit code can tell a failed turn from an agent that had
nothing to say; the printed line also names the session, which is the one to send
the next message to once the cause is fixed. A failure on the resumed half of a
turn — after an approval was answered and the tool ran — is reported the same way
instead of leaving the command on a stream that never closes. Interactive use keeps
its prompt: the next line you type starts a new turn on the same session, and that
turn is reported on its own, while the command still exits non-zero because the run
did contain a failure.

`environments create` requires `--name`; `--hosting-type` is one of `cloud`,
`local`, or `self_hosted`, and `--config-json` supplies the backend config as a
JSON object. A `--config-json` value that is not valid JSON, or that parses to
something other than an object, is refused locally with the option named. `update`
sends only the fields you pass, so an update that renames an environment keeps its
description and config. `archive` is terminal: the environment disappears from
`list`, a later `inspect` answers `404`, and archiving it again is refused. Every
command accepts `--port`, `--api-key`, and `--json`.

The `settings` commands read and write the same document as the Console. `settings get` prints
the saved values next to the effective ones, because a saved change is not in use until the
runtime restarts. `settings set-model` writes `model.vendor` and, with `--api-key-env`, a
`${NAME}` **reference** rather than a key: the runtime resolves that variable in its own
environment, so a name that is not set there is refused with the variable named, and no key
reaches the config file or this process's arguments. It sends only the fields you pass, so
changing the vendor keeps the stored credential and every other section. `settings validate`
checks the stored document, prints each issue, and exits non-zero while it is invalid. All
three accept `--port`, `--api-key`, and `--json`.

The `workspace` commands are the exception: they do not talk to a running runtime,
so they take no `--port` or `--api-key`. `workspace create` builds the folder
layout, a starter `config.yaml`, and a registry entry; `workspace open` only
registers a folder that already exists and writes nothing into it. Both accept
`--name` and `--data-dir`, and re-registering the same folder updates its single
entry rather than adding a second. `workspace list` prints the most recently
opened first, `workspace resolve` accepts an id, a name, or a root and marks the
entry as just opened, and `workspace remove` deletes the registry entry **only**
— the folder and its runtime data are left in place. `resolve` and `remove` exit
non-zero when nothing matches. `list`, `create`, `open`, and `resolve` accept
`--json`.

## Operational Notes

- Keep credentials in vaults or environment variables, not in agent YAML files.
- Keep uploaded file resources below 10 MB per file.
- Keep skill uploads below 8 MB per package.
- Use `MANAGED_AGENTS_SECRET_KEY` to provide a stable credential encryption key
  across runtime moves.
- Create a managed API key in the Dashboard or set `MANAGED_AGENTS_API_KEY` before
  exposing the runtime beyond a trusted local network.
