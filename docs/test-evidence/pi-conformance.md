# Pi conformance evidence

Verification date: 2026-09-15. This record separates deterministic harness
proof from real-provider proof; a pinned CLI version alone is not evidence that
a model turn used the expected trust, skill, or resume behavior.

## Local observations

- `pi --version` on the Windows host returned `0.84.4`.
- The runtime invokes Pi through stdin and the controlled launcher tests verify
  multiline/Unicode input is not placed in argv.
- The launcher tests verify private `models.json` contains only
  `$SANDBASE_PI_API_KEY`, source API-key/base-URL names are not inherited, and
  the composed `AGENTS.md` is written in the managed work directory.
- Explicit skill directories are forwarded as one managed `--skill` argument
  per directory; `model_config.speed` maps to Pi `--thinking` (`fast`→`off`,
  `standard`→`medium`, `extended`→`high`).
- Three repeated controlled turns use one managed session file; a concurrent
  owner gets `pi_session_busy`, and a changed header/schema is rejected.

## Real Pi provider gate

Verified 2026-10-08 on the Windows host with Pi `0.84.4` and a configured
`openai_compatible` model whose API key lives in a managed secret (only
`$SANDBASE_PI_API_KEY` reaches the child). A session created with
`loop_engine.provider: "pi"` completed two turns on one persistent RPC child:

- turn 1 issued `agent.tool_use` (`bash`) and `agent.tool_result`, and the
  model's reply correctly described the managed work directory as containing
  only the runtime-written `AGENTS.md`;
- turn 2, sent to the same session, answered a question about the first turn —
  proving the child and its session file persist between prompts;
- the log shows `span.model_request_*`, `turn_complete`, `session.usage`, and
  `session.status_idle` — no `pi_rpc_outcome_unknown` and no `write EPIPE`,
  the failure that previously terminated every Windows Pi session at the first
  command write (fixed in #878).

Not yet exercised against the real CLI: resume after a runtime restart
(`pi_session_state` rebind), explicit `--skill` forwarding, and the managed
`always_ask` gate extension. Those paths remain covered only by the
deterministic controlled tests above.

No credentials, personal paths, or provider diagnostics are stored in this
repository.
