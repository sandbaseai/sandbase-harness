# DeepSeek V4

SandBase Harness can use DeepSeek V4 through DeepSeek's OpenAI-compatible API.
DeepSeek V4 supports a context window of up to 1 million tokens. The runtime
compacts long sessions automatically; it does not currently expose a separate
context-window setting.

## Configure the provider

Set your API key in the environment:

```bash
export DEEPSEEK_API_KEY="<your DeepSeek API key>"
```

In Dashboard **Settings > Models**, switch to JSON and configure:

```json
{
  "vendor": "openai_compatible",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "${DEEPSEEK_API_KEY}",
  "options": {
    "reasoning_effort": "max"
  }
}
```

Save and activate the settings. `reasoning_effort` is forwarded as
`reasoning_effort` in each OpenAI-compatible chat-completions request. Use
`max` with DeepSeek V4 Pro for the strongest coding and agent performance.

## Create and run an agent

Create an agent whose model is `deepseek-v4-pro` (or
`deepseek-v4-flash` for lower latency), then start a session from the Console.
For a YAML seed definition:

```yaml
name: deepseek-coder
model: deepseek-v4-pro
system: You are a careful coding agent. Inspect the repository, make focused changes, and verify them.
tools:
  - type: agent_toolset_20260401
```

Start the runtime with `npx managed-agents start`, open
`http://127.0.0.1:3000/dashboard`, select the agent, and send the first task.

Do not commit API keys to the workspace. The `${DEEPSEEK_API_KEY}` reference is
resolved only by the runtime.
