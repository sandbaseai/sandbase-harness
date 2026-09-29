# Basic Example

A minimal managed-agents workspace: one `workspace-assistant` agent with a
`code-review` skill, the local sandbox, SQLite metadata, and a local artifact
directory. It is the layout `managed-agents init` writes, with a fuller agent:
the same file names, a different agent (five more tools, a `max_turns` of 10, and
a code-review skill in place of the example one), and a provider block that names
its base URL instead of relying on the default.

## Setup

```bash
# Build from the repository root, then start from this directory.
npm run build:runtime
cd examples/basic
node ../../dist/index.js start --agents-dir agents --config .managed-agents/config.yaml
```

The runtime reads `.managed-agents/config.yaml`, which points the OpenAI
provider at `${OPENAI_BASE_URL}` and takes the key from `${OPENAI_API_KEY}`.
Both variables have to be set in the environment the runtime is started from —
a reference that resolves to nothing fails the turn with `model_config_invalid`
instead of being sent as the credential:

```bash
export OPENAI_BASE_URL=https://api.openai.com/v1   # or your OpenAI-compatible endpoint
export OPENAI_API_KEY=sk-...
node ../../dist/index.js start --agents-dir agents --config .managed-agents/config.yaml
```

`agents/workspace-assistant.yaml` names `gpt-4o`, and an agent carries its own
model ID: if the endpoint you point at serves a different model, change that
line or set it from the Console at **Settings > Setup**, where the **Agent
models** panel lists every agent and saves a new model in place.

Runtime state (`.managed-agents/data.db` and `.managed-agents/logs/`) is created
in this directory on first start. Move it elsewhere with `--data-dir` and
`--log-file` if you would rather keep the example clean.

## Usage

Once running, interact with the local API:

```bash
# Create a session
curl -X POST http://localhost:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"agent": "agent_workspace-assistant", "environment_id": "env_default"}'

# Send a message and stream the turn (replace SESSION_ID)
curl -N -X POST http://localhost:3000/v1/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!"}'

# Get events
curl http://localhost:3000/v1/sessions/SESSION_ID/events
```

The same turn is one command with the CLI, which also answers the approval the
`bash` tool asks for:

```bash
node ../../dist/index.js chat agent_workspace-assistant --message "Hello!" --tool-approval allow
```

For lower-level event-driven integrations, `POST /v1/sessions/:id/events`
also accepts explicit `user.*` events.

## With the TypeScript SDK

The SDK lives in this repository, so the snippet imports it by path: the bare
`managed-agents` specifier names an unrelated package in the npm registry, and
nothing here should send a reader there. Run it with the repository's own loader,
from this directory:

```bash
npx tsx my-script.ts
```

```typescript
import { ManagedAgentsClient } from '../../src/sdk/client.js';

const client = new ManagedAgentsClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'not-needed-for-local',
});

const session = await client.sessions.create({
  agent: 'agent_workspace-assistant',
  environment_id: 'env_default',
});

await client.sessions.message(session.id, 'Hello!', { stream: false });
```

Under plain Node, without the loader, the built entry does the same job once
`npm run build:runtime` has run:
`import { ManagedAgentsClient } from '../../dist/sdk.js';`.

`examples/official-sdk/quickstart.mjs` is the runnable version of that snippet,
against the published Anthropic-compatible API.
