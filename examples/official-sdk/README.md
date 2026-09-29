# Official Anthropic SDK against SandBase Harness

`quickstart.mjs` runs the published [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
against a local SandBase Harness runtime. Nothing in it is hand-rolled HTTP and
nothing reshapes a response: it creates an agent, an environment and a session,
opens the session's event stream, sends a message, and reads the turn through to
`session.status_idle` — including a tool call the agent executes and feeds back.
The only differences from a quickstart written against the hosted service are
`baseURL`, the credential, and the environment `config.type` (this runtime reads
it as its own `hosting_type` and supports `local`; see
[`docs/api.md`](../../docs/api.md#environments)).

## Before you run it

You need a running Harness runtime with a model provider. The steps below are the
repository [Quick Start](../../README.md#quick-start), which is the only install
path this project supports: the unscoped `managed-agents` package on npm is not
this project, so do not run `npx managed-agents` or `npm install managed-agents`.

```bash
git clone https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../my-agents && cd ../my-agents
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start     # http://127.0.0.1:3000
```

Then give the runtime a model provider, in the Console at **Settings > Setup** or
in `.managed-agents/config.yaml`. Nothing here supplies a model: the stub provider
the conformance suite uses lives in `tests/`, is registered by a test workspace,
and is not a provider a user can select from Settings, the CLI, or these docs.

Two things have to agree, and neither is set by this script:

- the provider must serve the model id the quickstart puts on the agent it
  creates. The default is `gpt-4o`; set `QUICKSTART_MODEL` to change it — for
  DeepSeek, an `openai_compatible` provider with
  `base_url: https://api.deepseek.com/v1` and the model id `deepseek-chat`.
- the session in this script runs on the agent it creates over the API, not on
  the `assistant` agent `init` writes into `agents/`, so that file's `model:` does
  not have to match the provider you configure.

## Run it

From the directory you started the runtime in, with the script's path in your
clone:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000 \
ANTHROPIC_API_KEY=local \
  node ../sandbase-harness/examples/official-sdk/quickstart.mjs "Say hello in one sentence."
```

Optional: `QUICKSTART_MODEL` overrides the model id the script puts on the agent
(default `gpt-4o`), and `--json` prints one JSON object per event instead of
human-readable lines. The conformance suite runs the script with `--json`.

Expected output:

```
base_url: http://127.0.0.1:3000
agent: agent_…
environment: env_…
session: sess_… (idle)
agent.tool_use: glob {"pattern":"*"}
agent.tool_result: received
agent.message: Hello! …
session.status_idle: stop_reason=end_turn
session.retrieve: idle usage={"input_tokens":…,"output_tokens":…}
done: 1 message(s), 1 tool call(s)
```

If the turn never ends, the script exits non-zero and says which step failed: `2`
means no `agent.message` arrived, `3` means the session never reached
`session.status_idle` — usually an agent whose model the configured provider does
not serve, or a tool that needs approval, in which case the stream shows
`session.status_idle: stop_reason=requires_action`.

## Credentials: set exactly one

`ANTHROPIC_API_KEY` becomes the SDK's `x-api-key` header;
`ANTHROPIC_AUTH_TOKEN` becomes `Authorization: Bearer <token>`. **If both are
set, every protected request answers `401 authentication_error`** — supplying two
credential sources is refused before the key is even looked at, including when
the runtime has no API key configured at all. That is deliberate: a request
carrying two competing credentials has no single correct reading. The script
checks this up front and tells you instead of letting the first call fail.

If your runtime was started with an API key (`MANAGED_AGENTS_API_KEY`, or a key
created in the Console), pass that key. If it was not, any non-empty value works.

## Scope

This example is the quickstart, not the whole API. It does not cover memory
stores, vaults, MCP toolsets, files, deployments, or the beta-header matrix —
those have their own contracts under [`contracts/anthropic-cma/`](../../contracts/anthropic-cma/).

Each run creates a fresh agent, environment, and session on the runtime you point
it at; nothing is deleted afterwards. To clean up, archive them from the Console
or `DELETE /v1/agents/{id}` / `/v1/environments/{id}` and let the sessions expire,
or point the script at a throwaway runtime.

Verified against `@anthropic-ai/sdk` 0.129.0 (the version pinned in
`devDependencies`) on 2026-09-29, and executed by
`tests/conformance/official-sdk-quickstart.test.ts` on every CI run, which is
what keeps this page from drifting away from the script.
