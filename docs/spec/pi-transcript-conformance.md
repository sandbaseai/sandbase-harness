# Pi Transcript Projection: Local-First MVP Conformance Plan

Reviewed: 2026-09-20

Baseline: `origin/main` and `upstream/main` at `3a6605594deac80c51be2ab4582ac85ee9297f65` (`feat(pi): enforce session continuity and cleanup states (#208)`)

Status: design and evidence contract for the Pi JSONL projection path; the Pi loop foundation, stdout JSONL translator, and session-continuity cleanup are now present on the baseline, while this document defines the conformance boundary and remaining evidence work.

## Purpose and boundary

SandBase Harness is a local-first, self-hosted runtime. It does not need a
hosted control plane, hosted event feed, or a claim of full Claude Managed
Agents parity to provide a useful local Pi-backed loop. The Pi integration must
preserve the existing local guarantees: raw external data is validated before
it grants authority, durable events are appended before they are broadcast,
and replayed SSE events retain their sequence order.

The Pi loop foundation, stdout JSONL translation, and session continuity work
landed through PRs #204, #206, and #208. The current implementation exposes a
private Pi process boundary through `PiLauncher`, translates validated stdout
records through `PiTranslator`, persists durable events before broadcasting
them, and appends `turn_complete` only after a successful process close. This
document records the conformance contract for that path; it does not claim that
all listed evidence or all future Pi capabilities are complete.

## Verified Pi JSON contract

The local CLI reported version `0.84.4` on 2026-09-14. No provider-backed Pi
prompt was executed for this review, because no model credentials or provider
configuration were supplied.

The official Pi JSON-mode documentation describes JSON Lines on stdout, with a
first `session` record containing JSON session schema version `3`. It documents
agent and turn lifecycle records, delta-only `message_update` records, final
`message_end` records, tool-execution records, and `agent_end`. Its referenced
AI types define final assistant messages as an ordered content array whose text
parts are `{ type: "text", text: string }`; reasoning and tool calls have
distinct content variants.

Sources:

- [Pi JSON event stream mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- [Pi AI message types](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/types.ts)

The schema facts above are rephrased for compliance with licensing restrictions.
The source pages track Pi `main`, not a tagged `0.84.4` source snapshot. A
fixture manifest must bind each accepted transcript to its actual CLI version
and schema version before this feature is claimed compatible with that release.

## Current projection boundary

The current runtime has two event classes:

1. **Durable events** are appended through `EventLogWriter`, receive positive
   session sequences, and are then broadcast. They include model request
   boundaries, final assistant text, thinking content, native tool use/results,
   and usage data when the source record supplies valid values.
2. **Transient stream events** are broadcast for live text deltas with sequence
   `0`. They are not appended to the durable event log and must not become the
   authority for replay. A final `agent.message` remains the durable text
   authority.

`PiTranslator` accepts JSON objects from the Pi stdout stream, rejects malformed
JSON or malformed records that require a typed field, keeps unknown record types
inert, and does not grant tool or approval authority merely because a native Pi
record exists. `PiStrategy` owns process completion, session-file continuity
checks, and the final durable `turn_complete` marker. The strategy must not
yield durable events that it already appended and broadcast, because the session
executor would broadcast them a second time.

## Conformance behavior

### Expected behavior

For a permitted Pi text turn, the private process boundary and JSONL translator
must validate the stream before allowing it to affect durable session state. The
projection must preserve source order and produce the following observable
behavior:

1. A valid session and turn lifecycle produces durable model-request boundary
   events and the final assistant text in source order. A final text message is
   authoritative over its preceding `message_update` deltas.
2. Text deltas may be sent as transient live-stream events, but those events
   have sequence `0`, are not persisted, and are never used as replay authority.
3. Thinking, native tool calls/results, and usage are projected only through
   their explicitly supported canonical event types and validated fields. A Pi
   tool record is not evidence that Harness may execute a tool or bypass its
   approval policy.
4. A successful process close with a valid session header permits one durable
   `turn_complete` after the translator has finished. Process failure, parser
   failure, missing session header, or continuity failure must not claim a normal
   completed turn.
5. The persisted positive-sequence events are the authority for reconnect and
   replay. Every durable broadcast must equal the event returned by persistence.
6. The launcher keeps raw JSONL private to the launcher/translator boundary,
   preserves private-path and regular-file checks, and reports only observed
   process cleanup status.

### Acceptance criteria

1. A valid, version-pinned fixture with final assistant text produces the exact
   expected ordered durable events, followed by one `turn_complete` from the
   strategy. If the fixture includes native tools, the expected tool events and
   model-request boundaries are explicit in the manifest.
2. Every durable broadcast equals the event returned by persistence and has a
   positive, increasing sequence. Transient stream events have sequence `0`,
   are not persisted, and replay returns only the durable ordered events.
3. `message_update` text deltas do not duplicate the final durable assistant
   message. Thinking content, tool calls, tool results, usage, model identity,
   and stop reason appear only in their documented canonical fields and only
   after validation.
4. Malformed JSON, a malformed JSON object, an invalid required nested field,
   an oversize input, a missing or invalid session header, an unsupported
   schema version, or a process/turn error cannot produce a normal terminal
   completion. Unknown record types remain inert and cannot grant execution or
   approval authority.
5. A failed or invalid transcript does not become a successful replayable turn.
   Any partial durable events produced before a later protocol failure must be
   covered explicitly by the transaction/rollback behavior or called out as a
   known implementation gap; the conformance evidence must not silently treat
   partial persistence as a valid completion.
6. The launcher does not return arbitrary raw JSON, does not use Pi stderr as
   event authority, and preserves the existing private-path, regular-file, and
   cleanup checks.
7. A deterministic fixture can exercise this behavior without a model provider,
   API key, Docker daemon, Kubernetes cluster, or hosted service.

## Explicit exclusions

This increment does not claim full Pi protocol parity, token accounting beyond
validated usage fields, tool confirmation, custom tool execution, retry/resume
semantics beyond the current session-continuity contract, cancellation
escalation, model/provider discovery, Console changes, API changes, or
Docker/Kubernetes Pi execution. A Pi tool record is not evidence that Harness
may execute a tool. Any future bridge must validate the raw request, bind a
one-shot approval to the canonical input, persist the obligation before
execution, and verify native application of the approved host result.

## Local-first scope classification

| Area | Current local-first requirement | Deliberately later | Not a current product target |
| --- | --- | --- | --- |
| Pi loop | Committed foundation, validated stdout translation, session continuity, durable events, and the conformance contract above. | Broader transcript retention, richer diagnostics, tool/confirmation bridge, and isolated-provider execution. | A hosted Pi control plane or external host-event parity. |
| Durable events | Validate before authority, append before broadcast, ordered replay, and deterministic fixture coverage. | Broader raw-transcript retention and audited redacted diagnostics once storage policy is designed. | Making lossy live output authoritative. |
| Local sandbox | Preserve path confinement, restricted environment, process-close accounting, and the explicit non-security-boundary warning. | Docker/Kubernetes integration tests for Pi and provider-specific resource controls. | Calling the local provider a kernel security boundary. |
| Windows process control | Keep current close/wait semantics truthful when process-tree termination is unavailable. | Capability-detected Job Object ownership, explicit cleanup status, and native Windows tests. | Reporting a forced process-tree kill that did not occur. |
| External provider verification | Keep a separately runnable, secret-free conformance protocol ready. | A supplied-provider live test and an isolated Docker/Kubernetes run. | Making a cloud account or hosted transport a prerequisite for deterministic local development. |
| CMA parity | Maintain an honest local `/v1` compatibility subset, durable sessions, replay, approvals, credentials, and documented unsupported behavior. | Coverage expansion based on the published CMA matrix and real integration evidence. | Claiming full hosted Claude Managed Agents equivalence. |

The constrained IDE's rejection of a Windows `taskkill` process-tree operation
is evidence that the current environment cannot prove hard process-tree
termination. It is not enough evidence to call the runtime logic correct or to
call it an IDE-only defect. Until a separately designed Job Object feature is
implemented and tested on native Windows, the runtime must wait for the child
close and report only observed cleanup.

## Durable test evidence

Every transcript conformance test must retain both the test input and the
method used to establish its expected result. The repository should contain
only sanitized, reproducible evidence; runtime captures and credentials remain
in managed runtime storage and are never committed.

```text
tests/
  fixtures/
    pi/
      v0.84.4/
        manifest.json
        final-text-success.jsonl
        text-thinking-and-tool.jsonl
        malformed-json.jsonl
        missing-agent-end.jsonl
        unsupported-schema.jsonl
        unknown-record.jsonl
  unit/
    pi-translator.test.ts
    pi-jsonl-transcript.test.ts
    pi-launcher.test.ts
    pi-strategy.test.ts
  integration/
    pi-transcript-replay.test.ts
docs/
  test-evidence/
    pi-transcript.md
```

`manifest.json` records the Pi CLI version, JSON session schema version,
source classification (`synthetic_official_contract` or
`sanitized_live_capture`), source URL/revision, SHA-256 of each fixture,
redaction review date, and the expected projection. The test-evidence document
records the exact commands, fixture manifest hash, platform, Node version,
pass/fail result, intentionally skipped external tests, and known limitations.
A sanitized live capture may be added only after independent review confirms
that it contains no prompts, secrets, personal paths, provider identifiers, or
tool arguments/results that are not required by the fixture.

The deterministic test matrix is:

| Scenario | Method | Required evidence |
| --- | --- | --- |
| Normal final text | Parse a version-pinned fixture. | Exact persisted/broadcast/replay sequence and one terminal marker. |
| Non-text final content | Include thinking and tool-call entries in a final assistant message. | Only supported canonical projections are emitted. |
| Delta and tool records | Include `message_update` and tool-execution records. | Deltas remain transient; tools never bypass approval or execution policy. |
| Invalid transcript | Exercise malformed JSON, malformed fields, schema mismatch, unknown type, and input-limit cases. | No successful terminal completion or valid replay claim. |
| Launch containment | Test a controlled Pi executable that writes fixture bytes to the actual session path. | Private regular-file/path checks and validated candidates only. |
| Append-before-broadcast | Use a fake event writer and subscriber. | Durable broadcasts are persisted positive-sequence values, with no duplicate yield path. |
| Replay | Run through `SessionManager` and reconnect/replay support. | Live durable and stored events have matching ordered sequences. |
| Live provider (opt-in) | Run only with a user-supplied non-production model configuration. | Redacted runtime artifact reference, version manifest, and no secrets in source/control output. |

The first seven rows are required for a conformance claim. The last row is
required to claim real-Pi compatibility, but it is not a blocker for
fixture-backed local iteration. Docker and Kubernetes tests are likewise
explicit optional transport validation, not substitutes for deterministic
translator and replay tests.

## Implementation and release sequence

1. The Pi engine foundation, stdout JSONL translator, and session-continuity
   cleanup are already established by PRs #204, #206, and #208 on the current
   baseline. Do not reintroduce their historical branches into a new PR.
2. Use this document to add or refine the narrow conformance fixtures, replay
   evidence, and any focused runtime correction required by the acceptance
   criteria. Keep any runtime correction in its own independently verifiable
   behavior rather than hiding it in a documentation change.
3. Run focused Pi unit/integration tests during development, then
   `npm run release:check` before requesting review (Pi work is
   Windows-sensitive; see CONTRIBUTING.md#required-checks). Record Docker,
   Kubernetes, Windows privilege, and live-model skips precisely rather than
   treating skipped coverage as passed.
4. Run the opt-in provider conformance test only when credentials and a
   non-production provider are supplied. Store its redacted evidence under the
   configured managed runtime/artifact directory, not the repository root.
5. Review the final diff against this document's expected behavior, acceptance
   criteria, and exclusions before any commit or integration.

This document is a conformance and evidence contract. It does not by itself
claim that a provider-backed Pi run, Docker/Kubernetes isolation, or every
fixture row has been verified.
