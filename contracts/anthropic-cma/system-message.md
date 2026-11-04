# CMA Contract — system.message

Contract area: the `system.message` event domain.
Status: `supported` — the domain is implemented, the admitted payload is
narrowed to the published text-item rule, and both published rejections are
produced.
Source: `src/api/routes/system-message.ts`, `src/api/routes/sessions.ts`,
`src/types/cma-protocol.ts`.

<!-- capability-status
system-message-events: supported
-->

---

## 1. Official definition

As of the 2026-10-31 documentation snapshot
([`official-docs/events-and-streaming.md`](./official-docs/events-and-streaming.md)
"Send system messages"):

- `system.message` is an **inbound** event that appends privileged system-level
  context; it applies to the accompanying turn and all subsequent turns, as a
  `role: "system"` turn. It does not replace the agent definition's top-level
  `system` prompt.
- The event's `content` accepts **1–1,000 text items** — text only.
- On an unsupported primary model the event is rejected with
  `model_does_not_support_mid_conversation_system` (the published supported
  list at crawl time: Claude Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus
  5.5, Opus 5, Opus 4.8, Sonnet 5.5, Haiku 5.5). Subagent models are not
  checked because `system.message` lands on the primary thread only.
- While a session is idle with a `requires_action` stop reason, a
  `system.message` must trail a tool-result event in the same request; sent on
  its own or with a `user.message`, it is rejected until the pending tool
  events are resolved.
- It is its own event domain, distinct from `user.message` and
  `agent.message`, and it is projected back on the session's event listing.

## 2. Current SandBase shape

The route is `src/api/routes/system-message.ts`, the event vocabulary is
`src/types/cma-protocol.ts`, and the two session-dependent gates live in
`src/api/routes/sessions.ts` where the session row is resolved.

- `system.message` is accepted and persisted as its own event type, not folded
  into an agent or user domain, and it is projected as a `system` role turn
  that persists for every later turn.
- `content` admits **1–1,000 text items only**: `normalizeSystemMessageContent`
  accepts a block only when it is `{type:"text", text}` with non-empty text,
  and `systemMessageContentError` names the offending item index and type so a
  caller can fix the payload. An image, document, tool_use, or tool_result
  block is refused rather than persisted as privileged context it was never
  meant to carry.
- The model gate is produced: `modelSupportsMidConversationSystem` resolves
  the session's primary model against the published supported-family prefixes
  (`claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-opus-4-8`,
  `claude-sonnet-5-5`, `claude-haiku-5-5`) by `includes` matching, so dated ids
  resolve to their family. A model the table cannot prove supports
  mid-conversation injection — an unknown id or a non-Claude one — is refused
  with `model_does_not_support_mid_conversation_system`.
- The `requires_action` ordering rule is produced: while the session is idle
  on a pending tool call, `systemMessageOrderingViolationIndex` scans the
  batch and rejects a `system.message` that does not trail a
  `user.tool_confirmation` or `user.custom_tool_result` in the same request.
  A lone `system.message`, or one beside a `user.message`, is rejected until
  the pending call is resolved; one that trails a tool-answer is admitted.
- Downstream consumers (event projection, Console rendering) treat
  `system.message` distinctly, so a system notice is not rendered with a user
  or agent identity.

## 3. Alignment

Aligned for: separate event domain, privileged `system`-role semantics,
projection onto the event listing, text-only content bounded at 1–1,000
items, the supported-model refusal, and the `requires_action` ordering rule.

## 4. Differences

None beyond the prefix granularity noted below. The published supported-model
list names model families (Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus
5.5, Opus 5, Opus 4.8, Sonnet 5.5, Haiku 5.5); SandBase resolves them as the
prefix set `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`,
`claude-opus-4-8`, `claude-sonnet-5-5`, `claude-haiku-5-5`, which covers the
published families at the generation granularity the local capability table
already uses.

## 5. Reason for the difference

The prefix set is coarser than the published family names only because the
local model-capability table resolves at generation, not point-release,
granularity; a `claude-opus-5-5-20260101` style id still resolves correctly.
This is a naming convenience, not a scope deviation.

## 6. Corresponding tests

- `tests/unit/system-message-contract.test.ts` — the domain is accepted,
  persisted separately, validated to the text-item rule, and projected as a
  `system` role turn that persists.
- `tests/integration/system-message-admission.test.ts` — the model gate
  (supported admits, unsupported and non-Claude refuse with
  `model_does_not_support_mid_conversation_system`), the `requires_action`
  ordering rule (lone or `user.message`-paired rejected, tool-answer-trailing
  admitted), and the text-only content refusal.

## 7. Status

`supported` — the domain is implemented, the admitted payload is narrowed
to the published text-item rule, and both published rejections are produced
with the published error code. No further alignment work is scheduled in this
domain; a future published change to the supported-model list is absorbed by
the capability table rather than this route.
