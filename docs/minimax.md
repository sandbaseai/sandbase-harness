# MiniMax

SandBase Harness v0.3.3 includes a first-class MiniMax provider. The runtime
uses MiniMax's OpenAI-compatible API while keeping regional endpoint selection
and supported model IDs explicit.

## Endpoints and models

| Region | OpenAI-compatible base URL |
| --- | --- |
| Global | `https://api.minimax.io/v1` |
| Mainland China | `https://api.minimaxi.com/v1` |

The built-in model IDs are:

- `MiniMax-M3.1-Flash` (default)
- `MiniMax-M3`

These are suggestions for new configurations. Explicit saved, legacy, and custom
model IDs are passed through unchanged; upgrading does not reset an existing
agent or workspace selection.

Model access can depend on the MiniMax account and plan. Check the current
[MiniMax text-generation documentation](https://platform.minimax.io/docs/guides/text-generation)
and [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) before
deploying.

## Configure the workspace

Keep the API key outside version control:

```bash
export MINIMAX_API_KEY=your-key
```

Start SandBase Harness, open **Settings > Advanced** → **Model provider editor**,
and select **MiniMax**.
The region is an adapter option rather than a field on that form: on the **JSON**
tab set `options.region` to `global_en` or `cn_zh` (it defaults to `global_en`),
then click **Check configuration** before saving.

The equivalent `.managed-agents/config.yaml` section is:

```yaml
model:
  vendor: minimax
  api_key: ${MINIMAX_API_KEY}
  options:
    region: global_en
    model: MiniMax-M3.1-Flash
```

For the mainland China endpoint, set `region: cn_zh`. An explicit `base_url`
overrides the built-in regional endpoint when a proxy or gateway is required:

```yaml
model:
  vendor: minimax
  base_url: https://gateway.example/v1
  api_key: ${MINIMAX_API_KEY}
  options:
    region: global_en
    model: MiniMax-M3
```

Agents can select either supported model directly:

```yaml
name: MiniMax assistant
model: MiniMax-M3.1-Flash
system: You are a helpful assistant.
```

Flash always uses adaptive thinking. The runtime leaves that control omitted,
which enables thinking on the direct endpoint. Set the workspace's
`model.options.reasoning_effort` to `low`, `medium`, `high`, `xhigh`, or `max`
to tune Flash thinking depth; omitting it uses the API default of `max`.
`none` is rejected for Flash. M3 and legacy IDs retain their existing behavior
without an effort parameter. These are deployment options, separate from an
agent's model profile. See the [MiniMax request parameters](https://platform.minimax.io/docs/api-reference/text-openai-api)
for the current direct API contract. Custom gateway model IDs and capabilities
remain the gateway operator's responsibility.

After saving, create a short session from the Console and inspect its events.
A successful response verifies the API key, endpoint, model access, and runtime
path together. Never commit the resolved API key or include it in an issue.

## Tool continuation and private reasoning

The MiniMax adapter preserves `reasoning_content` when returning assistant tool
calls to the provider, as required by the
[MiniMax tool-calling guide](https://platform.minimax.io/docs/guides/text-m3-function-call).
This covers streaming and non-streaming SDK history. The built-in session
executor retains private replay across later turns, standard tool approval and
custom tool results within the same runtime process. Tool execution still
requires validated stream data, and a confirmation authorizes a call only once.

Raw reasoning is not written to the database, event stream, Console, exports,
memory or context summaries. Only the model request receives the private
supplement; malformed provider responses produce controlled errors that retain
HTTP status without copying the response body. Compaction counts the private
content's estimated tokens but summarizes only public events.

The private cache is limited to 1,000,000 UTF-8 bytes and 512 entries per session,
16,000,000 bytes and 128 sessions per executor. Old entries or sessions are
evicted whole rather than truncated. Compaction removes covered entries, and
terminal-session cleanup, deletion and shutdown clear the session cache. A
change of model, endpoint, credentials or request headers invalidates its scope.

Restarting the runtime or exceeding these limits loses the affected private
history. The durable public conversation remains available, but a provider that
requires the missing reasoning may reject continuation of an old tool call. If
that happens, start a new session; resending an approval cannot restore the
private data or grant a second execution. Private reasoning persistence across
restarts is not supported.

Verification on 2026-11-04 used deterministic provider responses with the real
adapter, session executor, local tools, approval flow and custom-tool flow for
`MiniMax-M3` and `MiniMax-M3.1-Flash`. It confirms the request/response mapping,
continuation, usage accounting and privacy boundaries. No authenticated live
MiniMax tool continuation was run because a MiniMax API key was unavailable.
To verify a deployment, request a harmless tool action in a fresh session,
approve it if prompted, and check that the model responds after the tool result
and on a follow-up message. A passing stub test alone does not establish live
interleaved-thinking compatibility for every model or gateway.
