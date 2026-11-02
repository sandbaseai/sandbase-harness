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
