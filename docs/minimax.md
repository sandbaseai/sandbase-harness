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

- `MiniMax-M3` (default)
- `MiniMax-M2.7`

Model access can depend on the MiniMax account and plan. Check the current
[MiniMax text-generation documentation](https://platform.minimax.io/docs/guides/text-generation)
and [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) before
deploying.

## Configure the workspace

Keep the API key outside version control:

```bash
export MINIMAX_API_KEY=your-key
```

Start SandBase Harness, open **Settings > Models**, and select **MiniMax**.
Choose the global or mainland China region, then click **Check configuration**
before saving.

The equivalent `.managed-agents/config.yaml` section is:

```yaml
model:
  vendor: minimax
  api_key: ${MINIMAX_API_KEY}
  options:
    region: global_en
    model: MiniMax-M3
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
    model: MiniMax-M2.7
```

Agents can select either supported model directly:

```yaml
name: MiniMax assistant
model: MiniMax-M3
system: You are a helpful assistant.
```

After saving, create a short session from the Console and inspect its events.
A successful response verifies the API key, endpoint, model access, and runtime
path together. Never commit the resolved API key or include it in an issue.
