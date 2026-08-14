# DeepSeek Harness integration

This integration lets DeepSeek Harness delegate durable agent work to a running
`managed-agents` instance. The `managed-agents-mcp` executable speaks MCP over
stdio and exposes agents, sessions, streamed turns, artifacts, and cancellation.

## Compatibility

- Node.js 22+
- DeepSeek Harness with `@deepseek-ai/dsh-mcp-client` and stdio MCP support
- SandBase Harness v0.3.0 or a source build from this repository

Last verified on 2026-08-14 against DeepSeek Harness commit
[`47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a): the Cordis layer composed cleanly,
DSH launched the stdio child, and the MCP handshake completed.

Build the tagged source release and expose its two local executables first:

```bash
git clone --branch v0.3.0 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build:runtime
npm link
mkdir ../my-agents && cd ../my-agents
managed-agents init
managed-agents start
```

The unscoped `managed-agents` package on npm is not SandBase Harness. Do not
use `npx managed-agents`; `npm link` above links only the verified source
checkout.

In another terminal, install this bundle into the Web profile and start DSH:

```bash
export MANAGED_AGENTS_URL=http://127.0.0.1:3000
# Only set MANAGED_AGENTS_API_KEY when runtime authentication is enabled.
dsh plugin --profile web add managed-agents
dsh web
```

For source development, load the included patch directly after building and
put `dist/mcp` on `PATH`, or replace `command` with the absolute path to the
built executable in a private test overlay.

DSH receives these tools under its stable MCP namespace:

- `mcp__sandbase__list_agents`
- `mcp__sandbase__create_session`
- `mcp__sandbase__run_session`
- `mcp__sandbase__get_session`
- `mcp__sandbase__list_artifacts`
- `mcp__sandbase__stop_session`

`run_session` waits for the streamed turn to become idle and returns the
assembled text plus terminal-event metadata. API keys are read from the child
process environment and are never returned by a tool.

## Uninstall

Stop DSH and run `dsh plugin --profile web remove managed-agents`. This removes
both the profile dependency and its bundle layer.

## Permissions and data

The MCP child connects only to `MANAGED_AGENTS_URL`. Its effective access is
the access granted by `MANAGED_AGENTS_API_KEY`: it can enumerate agents,
create and run sessions, read session artifacts, and cancel sessions. The
bridge does not persist credentials. Session data and artifacts remain in the
configured managed-agents workspace.

The default local sandbox runs commands as your OS user and is intended for
trusted development. Use the Docker or Kubernetes sandbox provider for a
stronger isolation boundary.

## Troubleshooting

- `MCP startup failed`: build or install `managed-agents` and confirm
  `managed-agents-mcp` is on `PATH`.
- `fetch failed`: start the runtime and check `MANAGED_AGENTS_URL`.
- `401` or `403`: set `MANAGED_AGENTS_API_KEY` to a key accepted by the
  runtime.
- No `mcp__sandbase__*` tools: confirm the patch path and inspect DSH startup
  logs for `mcp-sandbase-harness`.

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run build:runtime
npm run package:check
```

The unit suite validates the MCP schemas and handler behavior. A stdio MCP
client can additionally connect to `dist/mcp/index.js` and call `tools/list`
without starting the managed-agents HTTP runtime.

## License and security

Apache-2.0. Report vulnerabilities through the repository's GitHub security
channel or maintainers; do not include API keys, workspace data, or session
artifacts in a public issue.
