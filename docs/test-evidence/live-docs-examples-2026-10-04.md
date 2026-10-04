# Live docs-example validation — 2026-10-04

Environment: Node v24.9.0, @anthropic-ai/sdk 0.129.0, runtime commit a3c45dd, model `claude-opus-5`.
Model endpoint: `https://api.sandbase.ai/v1` (custom `DOCS_EXAMPLES_LIVE_BASE_URL`).

Each enabled docs-example page ran unchanged against a locally started runtime
configured with the operator's `ANTHROPIC_API_KEY` and the real Anthropic
provider. This file records outcome summaries only — exit code, duration,
session usage buckets (including prompt-cache reads/writes), final status,
and the last stop_reason. No keys, request bodies, or model replies are
recorded.

| Page | Exit | Duration | Session | Input | Output | Cache read | Cache write | Final status | Stop reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| console-build | 0 | 1.6s | sess_lsyeYMQSLygnZa9t | 0 | 0 | 0 | — | idle |  |
| tools | 0 | 1.1s | — | — | — | — | — | — | — |
| permission-policies | 0 | 1.2s | — | — | — | — | — | — | — |
