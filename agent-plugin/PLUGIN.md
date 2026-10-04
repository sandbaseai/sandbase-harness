# SandBase Harness Agent Plugin

## Purpose

Connect an Agent Plugins 1.0-compatible client to an existing SandBase Harness
runtime through the published MCP bridge. The plugin does not host the runtime
or store credentials; it forwards requests to the URL supplied by the user.

## Capabilities

- Discover configured agents with `list_agents`.
- Create and run persistent agent sessions with `create_session` and
  `run_session`.
- Inspect session state with `get_session`.
- List generated artifacts with `list_artifacts`.
- Stop an active session with `stop_session`.

## Install

Start a SandBase Harness API and Docker, then install the plugin from the
canonical repository:

```bash
export MANAGED_AGENTS_URL=http://host.docker.internal:3000
# Set this when the connected runtime requires authentication.
export MANAGED_AGENTS_API_KEY=your-runtime-key
copilot plugin install sandbaseai/sandbase-harness:agent-plugin
```

The bundled MCP configuration uses the pinned public image
`ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8` and passes the two environment
variables through to the bridge. The runtime API URL and any API key belong to
the user and are not embedded in this plugin.

The source-backed directory page is [Agent Plugins Directory](https://agent-plugins.directory/sandbaseai/sandbase-harness). It indexes the public manifests and source revision; the directory page is a discovery surface, not an execution service or security endorsement.

## Running the bridge container directly

The six-tool MCP bridge is also published as a standalone multi-architecture
OCI image for MCP clients that do not use Agent Plugins. Start the Harness
API, then add this stdio command to the client:

```bash
docker pull ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8
docker run --rm -i \
  -e MANAGED_AGENTS_URL=http://host.docker.internal:3000 \
  ghcr.io/sandbaseai/sandbase-harness-mcp:0.3.8
```

Container package: [GitHub Container Registry](https://github.com/orgs/sandbaseai/packages/container/package/sandbase-harness-mcp)

For an authenticated remote runtime, also pass `MANAGED_AGENTS_API_KEY`. The
container image contains only the MCP bridge; agent sessions and sandbox work
remain in the connected Harness runtime. Every release image is built from the
matching Git tag for `linux/amd64` and `linux/arm64`, includes OCI source and
MCP ownership metadata, and receives a GitHub build-provenance attestation.
On Linux, map `host.docker.internal` through `host-gateway`.

## Compatibility

- Agent Plugins 1.0-compatible clients with MCP support
- Docker on the host running the bridge
- SandBase Harness v0.3.8 or a compatible runtime API

The plugin manifest is version `0.1.1`; this patch release records the
discovery metadata and current runtime bridge reference without changing the
client-facing tool contract.

The bridge is a client-side integration layer. Session execution and isolation
remain properties of the connected Harness runtime and its selected backend
and deployment configuration; this file does not claim universal isolation or
security certification.

## Source manifests

- [`plugin.json`](./plugin.json)
- [`mcp.json`](./mcp.json)
- [Installation guide](../llms-install.md)
- [Runtime installation](../docs/installation.md)
