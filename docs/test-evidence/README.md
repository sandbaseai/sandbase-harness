# Test evidence

Outcome summaries from validation runs that are safe to publish. Files here
record exit codes, durations, session usage buckets, and environment details —
never API keys, request bodies, or model reply text.

- `live-docs-examples-<date>.md` — produced by
  `node --import tsx scripts/docs-examples-live.mjs` (see
  `tests/conformance/docs-examples/README.md#live-model-validation`). The
  operator supplies `ANTHROPIC_API_KEY` locally; the run proves the enabled
  documentation examples work against a real model over the Anthropic
  Messages protocol. `DOCS_EXAMPLES_LIVE_BASE_URL` selects a custom
  Anthropic-compatible endpoint, which the evidence file then names.
