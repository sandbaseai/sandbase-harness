# Pi Loop Engine (RPC)

Set `loop_engine.provider` to `pi` to select the external Pi CLI for **new**
sessions. The selected provider is persisted on each session: later global
settings changes only affect sessions created after the change. Existing
sessions continue to resolve their stored engine.

A session owns exactly one Pi child for its whole life. The first turn starts it
in RPC mode and every later turn writes to that same child:

```text
pi --mode rpc --model sandbase/<selected-model> --session <dataDir>/pi-sessions/<safe-session-id>.jsonl
```

There is no prompt on stdin at launch and stdin is never closed, because prompts
arrive as RPC commands for as long as the session lives. Prompts are never added
to command arguments. Each turn is one `prompt` command; the child's
`agent_settled` frame is what settles it. The owner serializes every frame it
writes, so two turns cannot interleave bytes on the child's stdin, and a second
prompt while a turn is in flight is refused rather than queued.

The selected agent model is resolved from the active model configuration. Its
API key and base URL placeholders are resolved from the host Settings
environment before Pi starts; only the dedicated API-key alias enters the
restricted child environment. The private session file is pre-created before its
path is passed to Pi. The already-composed system/skills prompt is written to
`AGENTS.md` in the sandbox work directory before launch.

The process runs with the session sandbox's host work directory as its current
working directory. Therefore the Pi foundation currently requires the **local**
sandbox provider; Docker, Kubernetes, and self-hosted sandbox pairings are
rejected by Settings. Explicit agent skills are passed as one managed `--skill`
flag per directory. Pi's `models.json` is written under the session's private Pi
config directory with restrictive file permissions and contains only the
`$SANDBASE_PI_API_KEY` credential reference.

Pi stdout is consumed as bounded LF-delimited JSONL without `readline`, on one
reader that separates command responses and extension UI requests from agent
events. The adapter validates documented event shapes, strips structured tool
markup across chunk boundaries, and appends final text, thinking, native tool
use/result, model spans, and terminal events to the same SQLite EventLogger used
by the builtin engine. Every durable event is appended before it is broadcast.
Text deltas have `seq: 0` and are live-only; the final `agent.message` is the
replay authority. Each Pi model request records usage exactly once. Unknown
events are inert, malformed authority-bearing events fail the turn, and stderr
is limited to a redacted 64 KiB diagnostic tail. A blocking extension dialog
fails the turn rather than being answered, with one exception: the managed gate
asks through Pi's `editor` method, so an `editor` dialog whose payload is not this
gate's own is answered with a denial. That method is shared with the gate, and
leaving Pi blocked there would stop the engine; nothing else is ever answered.

Pi children receive the session abort signal. Interrupt, stop, delete, and
runtime shutdown all close the session-owned child before the session work
directory can be released; on POSIX the child runs in its own process group, and
on Windows the session waits for `taskkill` to finish terminating the process
tree. If tree ownership cannot be confirmed before the cleanup deadline, the
session becomes `cleanup_pending` and the workspace is retained. A turn deadline
that passes cancels the child (`timed_out`); Pi cancellation becomes `cancelled`.

Pi must be installed and discoverable as `pi`; the Settings test reports a
missing CLI and a turn fails explicitly if it cannot be launched. On Windows,
the npm `pi.cmd` shim is invoked through its neighbouring `pi.ps1` script with
a fixed PowerShell argument forwarder, rather than a shell command string.

The adapter now holds a cross-runtime lease beside the managed session file for
this entire child lifetime. A live owner returns a retryable `pi_session_busy`
error; an expired owner is recovered with an observable continuity notice. A
non-empty file must match the SQLite `pi_session_state` header id/schema/path,
otherwise resume is refused rather than silently forking. A Pi resume refusal
from stderr is persisted as `pi_resume_refused` and remains visible.

The session file is not the whole proof. A file says which Pi conversation is
being continued, and nothing about what it was continued under, so
`pi_session_state` also records the host work directory the turns ran in and a
fingerprint of the compiled tool plan, the model and provider, and the approval
mode. A launch compares both against what it recorded before it spawns anything,
and a resume whose directory or fingerprint differs is refused as
`pi_policy_mismatch`, naming which of the two changed instead of reporting a
generic discontinuity; the refusal is durable, so the next attempt reads it
rather than rediscovering it. Nothing is refused for being unrecorded: a row
written before the binding existed has no value to compare against, so a session
inherited by an upgrade still resumes. The fingerprint sorts the compiled tool
sets before hashing, so a re-ordering of an equivalent policy is not a change and
one that is not a change cannot refuse a resume that reproduces its contract.

## Always_ask gating

A native tool the agent declares `always_ask` is stopped before it executes. When
at least one such tool is in the compiled plan, the launch materializes a
per-session SandBase-owned extension into the session's private Pi configuration
directory and adds it with `--extension`, together with `--no-extensions` so that
project-local content in the work directory cannot add or replace it. The gated
names and the session id reach the extension through its environment
(`SANDBASE_PI_GATED_TOOLS`, `SANDBASE_PI_SESSION_ID`).

The gate is the extension's `tool_call` hook, which blocks the call and asks
through an `editor` dialog carrying a `sandbase_tool_gate` payload: the tool call
id, the tool name, and the input a decision will be made against. The adapter
verifies the extension really loaded before it exposes a gated tool at all: the
session asks for Pi's command list and requires the per-session marker command
the extension registers. A launch with a gated tool whose marker is absent fails
with `pi_rpc_gate_unavailable` instead of running the tool ungated.

Each request is recorded durably in `pi_tool_interactions` before the caller is
told anything, and the session publishes an `agent.tool_use` with
`requires_confirmation: true` and the input fingerprint. The session then reports
`requires_action` and stays busy — Pi is suspended inside its hook, so the same
turn continues when a decision arrives and no new prompt may race it.

A decision arrives as `user.tool_confirmation` naming the `tool_use_id` (Pi's own
dialog request id is accepted as well). It is consumed exactly once, by a
conditional update whose affected-row count is the proof: a duplicate, a late
decision for a turn that moved on, or a decision naming a different tool finds no
pending row, is reported as not applied, and cannot execute the call. A decision
carrying replacement arguments is re-validated before it is written back — Pi
re-validates nothing after an extension mutates `event.input` — and a malformed
replacement denies the call instead. A second gate raised while a decision is
still pending is denied rather than replacing the first, because the runtime
relays one decision per session and a replaced gate would leave Pi suspended on a
question no caller could address.

Every path that cannot produce a trustworthy decision denies: an unrecognized
payload, a tool this session does not gate, no turn in flight, a second gate while
one is pending, a malformed reply, a turn past its deadline, and a transport that
closes while a decision is pending. None of them asks, and none of them allows.

### Preauthorized approval mode

`loop_engine.options.approval_mode` selects who answers a gate. `interactive` is
the default and the resolution for an omitted key: the call waits for a person.
`preauthorized_once` is an explicit, operator-selected second way, and the
runtime then answers the call itself under a platform-owned rule.

What the mode is allowed to be, and all it is allowed to be:

- **per call, never a standing permission.** The rule is consulted again at the
  next gate, and a decision is spent by being applied: a replay of the same call,
  a decision naming a different call, and a person's answer for a call the
  platform already decided are all refused, so no earlier decision can authorize
  a later one.
- **never human.** The decision travels the same conditional consume as a
  person's, and is recorded with `decision_source: "platform"` and published as
  `requires_confirmation: false` with `confirmation_source: "platform"`, so no
  client can read an automatic decision as a click by a person. The session does
  not report `requires_action` for it.
- **not a policy change.** The mode never reaches the child and never rewrites
  the compiled plan: the launch carries the same `--tools`/`--exclude-tools` and
  the same gated names it would carry under `interactive`.
- **not a bypass.** A rule that does not name a call leaves the gate waiting for
  a person rather than denying what a person could still approve, and every path
  that cannot consume a trustworthy decision still denies.

The mode is read per gate rather than latched on the session, so turning it off
is honored by the following decision and a decision already recorded keeps the
source it was recorded with. An unrecognized mode name is refused by Settings. An
agent definition cannot reach the key, so no agent can make its own gated calls
unattended.

## Steering

`user.steer` is a distinct event rather than a normal `user.message`, because
normal messages use the serialized execution chain — a steer routed through it
would arrive only after the turn it was meant to influence had ended. It is
written to the live session's own input channel while the turn is in flight,
keyed by `input_id`, and answered with a receipt:

- the same `input_id` with the same text is idempotent (`duplicate`);
- the same `input_id` with different text is a `conflict`, never merged;
- one steer may be in flight per turn, and a second one is refused rather than
  queued behind the first;
- a write that is not acknowledged is `outcome_unknown` and is never replayed,
  because the child may already have acted on it;
- new steer admission closes before `turn_complete` is published, and receipts
  already accepted settle before it, so a client can never see the terminal
  marker and then watch a steer land in the turn it just saw finish;
- a steer for a session with no turn in flight, or for a child that is gone, is
  refused rather than buffered for a later turn.

A steer carries text and nothing else. It cannot start a turn, expose a tool, or
change the tool policy the child was launched with, so it can never cause a tool
to run.

The current RPC adapter produces durable CMA events and visible Pi-native
tool trajectory. Native Pi tools are not Harness `ToolResolver` tools: they do
not run through the Harness tool loop and receive no Harness local path
confinement, and a gated call is decided by the session's own managed extension
rather than by a Harness approval card. A declared policy is compiled into Pi's
own vocabulary instead — `--tools` for the enabled
set, `--exclude-tools` for a tool denied by `never_allow` or `enabled: false`, and
`--no-builtin-tools` when no native tool is left — and a declaration with no
faithful expression is refused with `pi_tool_policy_not_supported`, whose message
now names the declaration that caused it. The launch sends those flags, so a denied
or disabled tool is enforced by the child rather than promised by the admission
check, and an agent that states no policy at all is launched with
`--no-builtin-tools` rather than with Pi's default toolset. An `always_ask` entry
no longer refuses the agent: a native tool declared `always_ask` is gated
before it executes instead, by the extension described above. An `auto` entry is
refused instead: the gate is a block-for-a-decision extension and the print loop
has no channel for the per-call model evaluation `auto` asks for, so compiling it
as allowed or as gated would both silently change the declared policy. A fully disabled `mcp_toolset` is admitted
instead of refused, because nothing is expected to run through it and Pi has no
MCP transport to enforce: that is a correction of the earlier blanket refusal of
any `enabled: false` entry, and it makes no tool available. Continuity is guarded
by the managed lease and SQLite header state; a failed proof remains visible and
cannot silently fork history. Docker/Kubernetes Pi transport and a Pi→Harness approval bridge remain
excluded. It also adds no OpenAI API surface.

Pi recognizes `models.json` provider settings and resolves `$ENV_VAR` values
at request time; this is why the per-session config references
`$SANDBASE_PI_API_KEY` rather than serializing a credential. See the upstream
[Pi custom models documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
