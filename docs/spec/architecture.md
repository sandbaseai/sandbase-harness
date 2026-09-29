# Architecture

## System Overview

```mermaid
graph TB
    User((User))
    SDK[SDK Client]

    subgraph Entry["Entry Points"]
        CLI[CLI]
        API[HTTP API]
        Console[React Console]
    end

    User --> CLI
    User --> Console
    SDK --> API
    CLI --> API
    Console --> API

    subgraph Core["Core Runtime"]
        Agents[Agent Loader]
        Sessions[Session Manager]
        Executor[Session Executor]
        Events[Event Logger]
        Compaction[Context Compactor]
        MCP[MCP Manager]
        Skills[Skill Loader]
        Templates[Template Loader]
    end

    API --> Agents
    API --> Sessions
    Sessions --> Executor
    Sessions --> Events
    Executor --> Compaction
    Executor --> MCP
    Executor --> Skills
    CLI --> Templates

    subgraph Providers["Provider Layer"]
        Models[Model Providers]
        Sandboxes[Sandbox Providers]
        Tools[Tool Sources]
        Strategies[Agent Strategies]
    end

    Executor --> Models
    Executor --> Sandboxes
    Executor --> Tools
    Executor --> Strategies

    subgraph Storage["Local Storage"]
        SQLite[(SQLite)]
        ProjectFiles[Project Files]
        Workspaces[Session Workspaces]
    end

    Events --> SQLite
    Sessions --> SQLite
    Agents --> ProjectFiles
    Skills --> ProjectFiles
    Sandboxes --> Workspaces
```

## Four-Layer Runtime Model

```mermaid
graph TD
    Agent["Agent<br/>durable definition"]
    Environment["Environment<br/>sandbox template"]
    Session["Session<br/>control-plane state"]
    Sandbox["Sandbox<br/>execution resource"]

    Agent --> Environment
    Agent --> Session
    Environment --> Session
    Session --> Sandbox
```

- Agent definitions are durable project configuration.
- Environments describe how sandboxes are provisioned.
- Sessions own state, metadata, and event history.
- Sandboxes perform execution for one session at a time.

## Session State Machine

```mermaid
stateDiagram-v2
    [*] --> queued: create session
    queued --> running: user event
    running --> idle: turn complete
    running --> paused: interrupted
    running --> requires_action: user input needed
    running --> failed: unrecoverable error
    idle --> running: user event
    paused --> running: user event
    requires_action --> running: user response
    idle --> terminated: stop or delete
    paused --> terminated: stop or delete
    failed --> [*]
    terminated --> [*]
```

## Session Turn Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Sessions as Session Manager
    participant Events as Event Logger
    participant Executor
    participant Strategy
    participant Model as Model Provider
    participant Tools
    participant SSE

    Client->>API: POST /v1/sessions/:id/messages
    API->>Sessions: send user message
    Sessions->>Events: append user.message
    Sessions->>SSE: broadcast user.message
    Sessions->>Executor: run turn
    Executor->>Strategy: execute context
    Strategy->>Model: request completion
    Model-->>Strategy: streamed response

    alt tool call
        Strategy->>Tools: execute tool
        Tools-->>Strategy: tool result
        Strategy->>Events: append tool events
        Strategy->>SSE: broadcast tool events
    else agent message
        Strategy->>Events: append agent.message
        Strategy->>SSE: broadcast agent.message
    end

    Strategy-->>Executor: turn finished
    Executor->>Sessions: update status
    Sessions->>SSE: broadcast status
```

## Event Replay and Live Stream

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Events as Event Logger
    participant Hub as SSE Hub

    Client->>API: GET /events/stream (Last-Event-ID optional)
    API->>Hub: subscribe
    alt cursor sent
        API->>Events: read persisted events after cursor
        Events-->>API: historical events
        API-->>Client: replay events
    else no cursor
        Note over API,Client: live events only, nothing recorded is replayed
    end
    Hub-->>Client: live events
```

Persisted events have a positive sequence number. Transient live chunks use
`seq = 0` and do not advance the replay cursor. A cursor that is not the numeric
`seq` the stream uses as its `id` is refused before the stream opens; the
subscription is established before the backfill read, so an event that lands
during it is buffered and written once rather than dropped or duplicated.

## Data Boundaries

```mermaid
graph LR
    Config[Project Config] --> Loader[Runtime Loaders]
    Loader --> DB[(SQLite)]
    API[HTTP API] --> DB
    Sessions[Sessions] --> Workspace[Session Workspace]
    Sandbox[Sandbox] --> Workspace
    Workspace -. cleanup .-> Sessions
```

Workspace configuration and runtime state live under the workspace boundary.
Runtime metadata belongs in SQLite at `<workspace>/.managed-agents/data.db` by
default. Uploaded bytes, logs, snapshots, and sandbox workspaces live under the
same workspace state directory and should not be committed unless intentionally
snapshotting local state.

## Workspace Boundary

```mermaid
graph TB
    Workspace["Workspace<br/>project boundary"]
    Config["Config<br/>.managed-agents/config.yaml"]
    Agents["Agent Seeds<br/>agents/*.yaml"]
    Skills["Skill Seeds<br/>skills/*/SKILL.md"]
    RuntimeData["Runtime Data<br/>.managed-agents/"]
    DB["SQLite<br/>data.db"]
    Files["Blob Storage<br/>files/ skills/ snapshots/"]
    Vaults["Credential Vaults"]
    Memory["Memory Stores"]
    Sessions["Sessions"]
    Sandboxes["Session Sandboxes"]

    Workspace --> Config
    Workspace --> Agents
    Workspace --> Skills
    Workspace -. owns slug .-> RuntimeData
    RuntimeData --> DB
    RuntimeData --> Files
    RuntimeData --> Vaults
    RuntimeData --> Memory
    RuntimeData --> Sessions
    Sessions --> Sandboxes
```

The Web Console currently exposes the active local workspace as a read-only
runtime boundary. Desktop shells may add create, open, and switch workflows, but
switching workspaces must restart or rebind runtime state so credentials,
memory, session data, and sandbox paths remain scoped to the selected workspace.

## Provider Selection

```mermaid
graph TD
    Agent[Agent Definition] --> EnvName[environment name]
    EnvName --> Env[Environment Config]
    Env --> Registry[Sandbox Provider Registry]
    Registry --> Local[Local Provider<br/>child process]
    Registry --> Docker[Docker Provider<br/>docker CLI]
    Registry --> Kubernetes[Kubernetes Provider<br/>kubectl CLI]
    Registry --> SelfHosted[Self-Hosted Provider<br/>work queue]
    Registry -. unregistered .-> Fail[Provision error<br/>lists registered providers]
```

The executor resolves the sandbox provider from the selected environment before
running a session turn.

The registry is the only authority on which backends exist in a process. A
backend is registered only when its transport is reachable at startup — no
Docker daemon means no `docker`, no reachable cluster means no `kubernetes` —
and an unresolvable request is an error rather than a substitution, so a session
configured for an isolated backend can never quietly execute on the runtime
host.

Each provider also declares a capability set the runtime reads before acting:

| Provider | isolatedExecution | hostFilesystem | resourceLimits | streamingExec |
| --- | --- | --- | --- | --- |
| local | No | Yes | No | No |
| docker | Yes | No | Yes | No |
| kubernetes | Yes | No | Yes | No |
| self_hosted | Off-host | No | No | No |

`hostFilesystem` gates workspace snapshots, which need a host-readable
workspace. `resourceLimits` gates whether an Environment's `resources` values
are enforced. A requested capability the backend lacks is logged against the
session rather than dropped in silence.

## Deployment Modes

### Local Development

```text
CLI or SDK -> local HTTP API -> SQLite + local sandbox
```

This is the default mode.

### Containerized Runtime

```text
Client -> containerized HTTP API -> mounted config + persistent data volume
```

This mode keeps the same project files and API shape.

### Self-Hosted Worker

```text
HTTP API -> work queue -> user-managed worker -> session event results
```

This mode lets users run execution on their own infrastructure while keeping
the session control plane stable.
