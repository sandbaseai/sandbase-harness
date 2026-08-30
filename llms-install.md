# SandBase Harness MCP installation

SandBase Harness exposes a six-tool MCP bridge for a running, self-hosted
Harness API. The bridge manages agents and durable sessions; it is not a
standalone model provider.

## Prerequisites

- Node.js 22 or newer and npm 10 or newer
- A running SandBase Harness API on port 3000
- Docker, if using the published MCP image

## Start the runtime

```bash
git clone --branch v0.3.8 --depth 1 https://github.com/sandbaseai/sandbase-harness.git
cd sandbase-harness
npm ci
npm run build
mkdir ../sandbase-workspace
cd ../sandbase-workspace
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start --workspace "$PWD"
```

## Connect the MCP bridge with Docker

```bash
docker run --rm -i \
  -e MANAGED_AGENTS_URL=http://host.docker.internal:3000 \
  ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8
```

If the runtime requires authentication, also pass
`-e MANAGED_AGENTS_API_KEY=your-runtime-key`. The image communicates with the
runtime over stdio and exposes `list_agents`, `create_session`,
`run_session`, `get_session`, `list_artifacts`, and `stop_session`.

## Connect from a source checkout

After `npm run build`, configure an MCP client to launch:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/sandbase-harness/dist/mcp/index.js"],
  "env": {
    "MANAGED_AGENTS_URL": "http://127.0.0.1:3000"
  }
}
```

Set `MANAGED_AGENTS_API_KEY` in `env` when authentication is enabled. Keep API
keys out of committed configuration and screenshots.
