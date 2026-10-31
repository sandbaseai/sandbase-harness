# CMA Contract — system.message

Contract area: the `system.message` event domain.
Status: `partial` — the domain is implemented, but the admitted payload
vocabulary is broader than the published one and two published rejections are
not produced. See §4 and §7.
Source: `src/api/routes/system-message.ts`, `src/types/cma-protocol.ts`.

<!-- capability-status
system-message-events: partial
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

The route is `src/api/routes/system-message.ts` and the event vocabulary is
`src/types/cma-protocol.ts`.

- `system.message` is accepted and persisted as its own event type, not folded
  into an agent or user domain, and it is projected as a `system` role turn
  that persists for every later turn.
- The payload shape is validated before persistence — but the validated
  vocabulary is **broader than the published one**: the block grammar also
  admits `image`, `document`, `tool_use`, and `tool_result` content blocks,
  not only text items.
- No model-support gate exists: a `system.message` is admitted on any model
  the session resolves, and the
  `model_does_not_support_mid_conversation_system` refusal is not produced.
- No `requires_action` ordering rule exists: a `system.message` sent alone
  while a call is parked is admitted rather than rejected.
- Downstream consumers (event projection, Console rendering) treat
  `system.message` distinctly, so a system notice is not rendered with a user
  or agent identity.

## 3. Alignment

Aligned for: separate event domain, privileged `system`-role semantics,
projection onto the event listing, and distinct treatment in rendering.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Content vocabulary | The published rule is 1–1,000 **text** items. SandBase additionally admits `image`, `document`, `tool_use`, and `tool_result` blocks, so a payload the official service would reject is persisted. |
| Model gate | The published `model_does_not_support_mid_conversation_system` refusal is not produced; every model admits the event. |
| `requires_action` ordering | The published rule that a `system.message` must trail a tool result while a call is parked is not enforced; a lone `system.message` during `requires_action` is admitted. |
| Field vocabulary history | An earlier revision of this file recorded "the published contract documents the domain and its privileged nature, not an exhaustive field list". That was true before the official doc spelled the text-item rule out; it no longer is. |

## 5. Reason for the difference

- The broader block vocabulary predates the published text-item rule: the
  validator was written against the general content-block grammar, and the
  official restriction was documented after the fact. Narrowing the admitted
  set is a contract-visible behaviour change, so it is scheduled as its own
  fix rather than folded into this documentation pass.
- The model gate and the `requires_action` ordering rule are not produced
  because no equivalent boundary exists in the local admission path yet; both
  are recorded here rather than silently absent.

## 6. Corresponding tests

- `tests/unit/system-message-contract.test.ts` — the domain is accepted,
  persisted separately, and validated.

## 7. Status

`partial` — the domain is implemented and covered by a dedicated contract
test, but the admitted content vocabulary is broader than the published
text-only rule, and the model gate plus the `requires_action` ordering rule
are not produced. A follow-up should either narrow the validator to the
published rule or keep this entry at `partial` with the deviation recorded.
