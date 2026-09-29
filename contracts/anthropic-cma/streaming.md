# CMA Contract — streaming

Contract area: `GET /v1/sessions/:id/events/stream` — SSE delivery, resume,
and delta previews.
Status: `supported`.
Source: `src/api/routes/stream.ts`, `src/core/session/event-deltas.ts`.

<!-- capability-status
resumable-sse: supported
agent-message-stream-preview: supported
-->

---

## 1. Official definition

- Session progress is observable as a resumable server-sent event stream.
- A stream carries what happens next. A resuming client supplies the last event
  it saw and receives everything after it, with no gaps and no duplicates; a
  client that sends no cursor is not asking for the log.
- A long-lived connection is kept alive with a keepalive frame a client is
  expected to skip rather than treat as an event.
- Streaming previews of a buffered message are opt-in. The default stream carries
  the buffered `agent.message`, not per-token fragments.

## 2. Current SandBase shape

The stream route is `src/api/routes/stream.ts` and the delta projection is
`src/core/session/event-deltas.ts`.

Two subscription modes:

- **No cursor** — the connection receives live events only. Nothing recorded is
  replayed, so a fresh subscription cannot deliver a session's whole history to a
  client that already read, or never asked for, it. A blank `Last-Event-ID` (or
  `last_event_id`) is the same as none: it names no position.
- **With a cursor** — the cursor is read from the `Last-Event-ID` header or a
  `last_event_id` query parameter, and stored events with `seq > cursor` are
  backfilled, then the stream switches to live delivery. Cursor `0` replays the
  whole log, which is how a client asks for one.
- A cursor that is not a safe integer is refused with a 400 **before** the stream
  opens, rather than being read as "replay everything" or as "replay nothing". An
  event id from `GET /events` is a different string and is not a cursor. A number
  too large to compare exactly is the second of those readings — every real `seq`
  is below it, so the connection would never receive a persisted event again —
  and is refused with the rest.
- The two spellings of one cursor have to agree: `Last-Event-ID` beside a
  `last_event_id` that names a different position is refused, so a resume never
  starts from a position only one of the two named. A blank spelling names
  nothing and therefore does not disagree.
- Live events that arrive during backfill are buffered, so an event landing
  between backfill and subscription is neither dropped nor delivered twice.
- Dedup is by `seq`. Transient events (`seq === 0`) are broadcast-only: never
  persisted, never advancing the resume cursor, and exempt from dedup because
  they have no stable identity to dedup on.

Keepalive:

- Every 15 seconds the connection receives `event: ping` with the JSON body
  `{"type":"ping"}`, and no `id`, so it cannot move the resume cursor.

Delta previews:

- Requested through `event_deltas[]` (both `event_deltas` and `event_deltas[]`
  query spellings are read).
- An unrecognized delta type is rejected with a 400 **before** the stream opens,
  because an error on an established SSE stream could not be returned as a
  normal response.
- Previews are emitted ahead of the buffered event they anticipate, and carry no
  `id` — they must not advance the resume cursor, or a reconnecting client would
  resume from a fragment that was never persisted.

## 3. Alignment

Aligned for: a live-by-default stream with an opt-in replay from a cursor,
resumable delivery with no gaps or duplicates under a concurrent write, the
`event: ping` keepalive carrying JSON, opt-in previews, and the rule that the
default stream is buffered rather than token-by-token.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Cursor type | The published event ids are opaque; this runtime's SSE `id` is the numeric per-session `seq`, and that is what a resume cursor must be. An id read from `GET /events` is refused with a 400 rather than guessed at. |
| Malformed cursor | Refused with `400 invalid_request_error` before the stream opens, including a number too large to compare exactly. Treating it as absent would silently deliver live events only to a client that asked to resume, and treating it as `0` would replay a history it did not ask for. |
| Cursor spellings | `Last-Event-ID` and `last_event_id` are both read, and a pair that names different positions is refused rather than resolved by precedence. The published contract names neither spelling in a way that fixes a precedence rule. |
| Keepalive contents | The frame name is `ping`, which is the keepalive name the official SDK skips, so a published client needs no change. Its JSON payload (`{"type":"ping"}`) and the 15-second interval are local: the published payload shape was not verified against a live deployment, and the frame this runtime sent before carried an empty payload under the name `heartbeat`. |
| Preview type names | SandBase names its preview frames locally. The published contract documents opt-in previews but not a fixed frame vocabulary. |
| Query spellings | `event_deltas` and `event_deltas[]` are both accepted, so a client using either array-encoding convention works. `last_event_id` is accepted as the query spelling of the header. |
| Preview persistence | Previews are never persisted. The published contract does not state persistence either way; SandBase's choice is documented because a client must not resend a preview as state. |

## 5. Reason for the difference

- Accepting both query spellings avoids a class of integration bug where a
  client's HTTP library encodes an array one way and the server expects the
  other. The cost is one extra read.
- Rejecting an unknown delta type before opening the stream is deliberate: once
  a stream is established the HTTP status is already 200, so a configuration
  error would surface as a stream that simply never shows previews.
- A cursor that cannot be ordered by is refused for the same reason: a 400 is
  actionable, while either silent reading of it is a client-visible data bug that
  nobody can see. The numeric `seq` is the only cursor this route publishes,
  because it is what the log can resume from.
- An unreadable cursor is refused rather than repaired because the two plausible
  repairs point in opposite directions — replay everything, or replay nothing —
  and the caller is the only one who knows which was meant. A value too large to
  compare exactly is refused with the rest for the same reason: accepting it reads
  as "replay nothing" for the rest of the connection's life.
- Two cursor spellings that disagree are refused rather than resolved by
  precedence, which is the rule this API already applies to two spellings of one
  declared field: a caller who wrote two positions cannot have both, and guessing
  resumes from a position they may never have seen.
- The keepalive keeps the published event name so a client that already skips
  `ping` (the official SDK does) needs no change, and it drops the empty payload
  the previous `heartbeat` frame carried, which was not JSON and had no event
  name a published client knew.

## 6. Corresponding tests

- `tests/integration/event-stream-subscription.test.ts` — both subscription
  modes at the route: a cursor-less connection replays nothing and receives live
  events, a cursor replays only later events in order, cursor `0` replays the
  log, the query spelling behaves as the header does, an event that also arrives
  live is delivered once (both after the backfill and during it, from inside the
  read), a cursor that is not a safe integer is refused with a JSON 400 before the
  stream opens, two cursor spellings that disagree are refused, and the keepalive
  is `event: ping` with a JSON body and no id.
- `tests/integration/sdk.test.ts` — the SDK's tail resuming from cursor `0`
  through the published client, and a refusal that arrives before the stream opens
  reaching the caller with the API's own message and `type`.
- `tests/integration/sdk-stream-keepalive.test.ts` — the SDK's stream reader
  yielding only session events, so `ping`, `heartbeat`, and a payload-less
  keepalive are all skipped rather than surfaced as events.
- `tests/integration/session-cli-commands.test.ts` — `session tail` printing the
  recorded log and then following a write that happens after that read.
- `tests/unit/console-stream-replay.test.ts` — the Console's stream transport
  sending `Last-Event-ID: 0` rather than dropping a zero cursor.
- `tests/integration/api.test.ts` — stream and event ordering assertions.
- `tests/unit/event-deltas.test.ts` — delta request parsing and preview frame
  projection.

## 7. Status

`supported` — live-only and cursor-resumed delivery, dedup, the keepalive, and
opt-in previews are implemented and covered by tests.
