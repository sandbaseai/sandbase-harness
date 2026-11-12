# Official CMA Documentation Update Summary

**Date:** 2026-11-03  
**Baseline:** Previous snapshot from 2026-11-02  
**Status:** 7 files updated to latest, byte-identical with upstream

## Update Summary

Updated the 50-page official Claude Managed Agents documentation snapshot to latest upstream versions. The crawl identified 7 pages with changes:

### Pages Updated

| File | Change Type | Key Updates |
|------|------------|-------------|
| `events-and-streaming.md` | SDK API improvements | Simplified Java/C# examples: `.id()`, `.type()`, `.message()` now directly accessible instead of through raw JSON |
| `quickstart.md` | Minor text updates | Small clarifications in setup instructions |
| `scheduled-deployments.md` | Workflow clarification | Minor text improvements |
| `session-threads.md` | SDK API improvements | Updated C#/Java examples to use typed accessors instead of raw JSON |
| `self-hosted-sandboxes-workers.md` | Minor updates | Worker reference documentation updates |
| `self-hosted-sandboxes.md` | Minor updates | Self-hosted sandbox reference updates |
| `workflow-runs.md` | Minor updates | Workflow run documentation updates |

### What Changed

The updates reveal **SDK API maturation**:

1. **Java SDK** — Event access is now more ergonomic:
   ```java
   // Before: required raw JSON access
   event._json().orElseThrow() instanceof JsonObject json
       ? json.values().get("id").asStringOrThrow()
   
   // After: direct typed access
   event.id()
   ```

2. **C# SDK** — Similar improvements:
   ```csharp
   // Before: raw JSON property access
   sessionEvent.Json.GetProperty("type").GetString()
   
   // After: typed property access
   sessionEvent.Type.Raw()
   ```

3. **Stream event filtering** — Simplified reconnect patterns with standardized `id()` accessor across all event variants

### No Breaking Changes for SandBase

- The SandBase runtime API remains stable; these are SDK-level improvements
- Event structure and field names unchanged
- No new capabilities or removed endpoints
- Contract compliance unaffected

## CMA Compatibility Status

**Verified routes:** 110 distinct method/path pairs  
**Mounted resources:** 90  
**Explicit refusals:** 20  
**Unavailable surfaces:**  
- `threads-and-coordinator` (multiagent surface, in scope under decision 0002)
- `mcp-tunnel` (out of scope for local-first runtime)
- `user-profiles` (out of scope for single-tenant runtime)

## Key Gaps Still Open

From BACKLOG.md, the following CMA compatibility tracks remain incomplete:

### P0 Blockers
1. **Agent model defaults** — Per-model effort defaults resolve at save time in official service; still pending
2. **Self-hosted tool answers** — Tool-call identity coordination with session Work queue
3. **Work item lifecycle** — TTL and recovery semantics for the backing tool-call queue
4. **Thread foundation and subagents** — Durable threads, isolated context, status aggregation (decision 0002 scope)
5. **Workflow runs and advisor** — Background run executor, phase events, advisor consultations

### P1 Strong Local Parity
- Agent authoring validate/test/version-diff workflow
- Session trace/export/replay bundle
- Environment vs Sandbox capability validation
- Console UI completion

### P2 Operations & Adapters
- Postgres metadata adapter
- S3 artifact adapter
- mem0/MemU memory adapters
- OAuth refresh/revoke lifecycle
- MCP tunnel lifecycle/auth/reconnect
- Remote/cloud sandbox adapter

## Testing Status

- ✅ Official route coverage: 39 tests passed
- ✅ Documentation snapshot: 50 pages verified (43 identical, 7 updated)
- ⚠️ General test suite: 36 failures (unrelated path-resolution issues on macOS with `/private/var` prefix)

## Next Steps

1. **Monitor SDK updates** — Re-run crawl before any major SDK version upgrade
2. **Test thread implementation** — When implementing decision 0002 (threads/multiagent), validate against the pinned `session-threads.md` examples
3. **Workflow run implementation** — Cross-reference `workflow-runs.md` for phase lifecycle and error handling
4. **Update contract files** — If any official behavior changes are discovered during implementation, update corresponding `contracts/anthropic-cma/*.md` files

## Files Modified

- `contracts/anthropic-cma/official-docs/events-and-streaming.md` — 24 line changes
- `contracts/anthropic-cma/official-docs/quickstart.md` — 4 line changes
- `contracts/anthropic-cma/official-docs/scheduled-deployments.md` — 13 line changes
- `contracts/anthropic-cma/official-docs/self-hosted-sandboxes-workers.md` — 2 line changes
- `contracts/anthropic-cma/official-docs/self-hosted-sandboxes.md` — 2 line changes
- `contracts/anthropic-cma/official-docs/session-threads.md` — 9 line changes
- `contracts/anthropic-cma/official-docs/workflow-runs.md` — 2 line changes

Total diff: 56 insertions(+), 37 deletions(-)

---

**Note:** This is a local-only update. All changes remain in the working directory for review before any future commit.
