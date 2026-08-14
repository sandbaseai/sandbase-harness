# DeepSeek Harness integration

This integration lets DeepSeek Harness delegate durable agent work to a running
`managed-agents` instance. The `managed-agents-mcp` executable speaks MCP over
stdio and exposes agents, sessions, streamed turns, artifacts, and cancellation.

Start the runtime first:

```bash
npx managed-agents start
```

In another terminal, start DSH with the supplied Cordis patch:

```bash
export MANAGED_AGENTS_URL=http://127.0.0.1:3000
# Only set MANAGED_AGENTS_API_KEY when runtime authentication is enabled.
pnpm dsh web --patch ./examples/deepseek-harness/cordis.yml
```

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
