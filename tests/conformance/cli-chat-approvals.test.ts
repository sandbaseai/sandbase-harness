/**
 * The acceptance gate for "`managed-agents chat` can answer a turn that waits for
 * approval".
 *
 * The runtime parks an approval-gated tool call in an ordinary
 * `session.status_idle` whose `stop_reason.type` is `requires_action`, naming the
 * blocking events in `event_ids`. Before this, `chat` printed the tool name and
 * returned to its prompt: the turn was parked, no tool ran, the session could not
 * continue, and the command exited `0` as if the turn had finished (measured on
 * the builtin engine — the session was left `requires_action` with zero tool
 * results). The published loop is to answer each id with a `user.tool_confirmation`
 * and let the runtime start the turn again.
 *
 * Every case here runs the real command line (`src/index.ts chat`, through the
 * repository's own `tsx` loader) against the real runtime on a free port with a
 * stub provider that records every request. Reading the events afterwards over
 * HTTP is what tells "the tool ran" from "the CLI said it did": the assertions are
 * on `agent.tool_result`, the session's own status, and the exit code.
 *
 * The custom-tool case is the one the CLI deliberately cannot finish. A custom
 * tool has no executor in the runtime — the caller does — so it waits for a
 * `user.custom_tool_result` this command cannot produce. Printing the exact
 * request and exiting non-zero is the safe end: the session stays parked, no tool
 * runs, and the operator is told what would resume it.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STUB_REPLY_TEXT, startStubModelServer } from './support/stub-model-server.js';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A workspace agent whose only gated tool is `bash`, which parks on every call. */
const GATED_BASH_TOOLS = [
  '  - type: agent_toolset_20260401',
  '    default_config:',
  '      enabled: false',
  '    configs:',
  '      - name: bash',
  '        enabled: true',
  '        permission_policy:',
  '          type: always_ask',
];

/** A workspace agent offering one custom tool, which the runtime cannot execute. */
const CUSTOM_TOOL_TOOLS = [
  '  - type: agent_toolset_20260401',
  '    default_config:',
  '      enabled: false',
  '    configs:',
  '      - name: read',
  '        enabled: true',
  '        permission_policy:',
  '          type: always_allow',
  '  - type: custom',
  '    name: lookup_customer',
  '    description: Look up one customer record by id.',
  '    input_schema:',
  '      type: object',
  '      properties:',
  '        id:',
  '          type: string',
  '      required: [id]',
];

/**
 * A workspace agent whose single model step can park both families: `bash` waits
 * for a decision, and the custom tool waits for a result only the caller can
 * produce.
 */
const GATED_BASH_AND_CUSTOM_TOOLS = [
  '  - type: agent_toolset_20260401',
  '    default_config:',
  '      enabled: false',
  '    configs:',
  '      - name: bash',
  '        enabled: true',
  '        permission_policy:',
  '          type: always_ask',
  '  - type: custom',
  '    name: lookup_customer',
  '    description: Look up one customer record by id.',
  '    input_schema:',
  '      type: object',
  '      properties:',
  '        id:',
  '          type: string',
  '      required: [id]',
];

interface ChatRun {
  code: number | null;
  stdout: string;
  stderr: string;
  sessionId: string;
}

/**
 * One line a script feeds to the command's stdin.
 *
 * `after` waits for that text to appear in stdout first, which is how a script
 * answers a prompt: the answer is read at the prompt, so a line written before
 * it arrives would be read as a message instead.
 */
interface StdinStep {
  send: string;
  after?: string;
  /** End stdin right after this line, the shape of a pipe that runs out. */
  thenEnd?: boolean;
}

/**
 * Run the published command, exactly as a user would, and read its session id.
 *
 * The child is killed after `RUN_CAP_MS` if it has not exited, so a command that
 * hangs fails on the assertions below instead of at the test timeout: a vitest
 * timeout would leave this promise pending, the case's `finally` would never run,
 * and the harness workspace (SQLite file included) would leak in the temp
 * directory.
 */
const RUN_CAP_MS = 60_000;

async function runChat(
  runtime: RunningRuntime,
  options: { message?: string; stdin?: StdinStep[]; toolApproval?: string },
): Promise<ChatRun> {
  const args = [
    '--import',
    'tsx',
    join(repositoryRoot, 'src', 'index.ts'),
    'chat',
    '-p',
    String(runtime.port),
    ...(options.message === undefined ? [] : ['-m', options.message]),
    ...(options.toolApproval ? ['--tool-approval', options.toolApproval] : []),
  ];

  return await new Promise<ChatRun>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      // `-m` runs with no stdin at all, which is the shape a script or a CI job
      // has: a prompt with nobody behind it must not decide anything by itself.
      // Without `-m` the command reads lines, so a case can pipe the message and
      // the answer the way a script would feed them.
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const steps = [...(options.stdin ?? [])];
    const feed = () => {
      while (steps.length > 0 && (steps[0].after === undefined || stdout.includes(steps[0].after))) {
        const step = steps.shift()!;
        child.stdin?.write(step.send);
        if (step.thenEnd) {
          child.stdin?.end();
          return;
        }
      }
      if (steps.length === 0 && !child.stdin?.destroyed) child.stdin?.end();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      feed();
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', rejectRun);
    const cap = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        stderr += `\n[runChat] killed after ${RUN_CAP_MS} ms without exiting\n`;
        child.kill('SIGKILL');
      }
    }, RUN_CAP_MS);
    child.on('close', (code) => {
      clearTimeout(cap);
      // Session ids carry a URL-safe alphabet that includes `-`, so the class has
      // to cover it: a stricter one silently reads no id, and every later
      // assertion then blames the wrong thing.
      const match = /\(session (sess_[A-Za-z0-9_-]+)\)/.exec(stdout);
      resolveRun({ code, stdout, stderr, sessionId: match?.[1] ?? '' });
    });
    feed();
  });
}

interface SessionEvent {
  type: string;
  content?: Array<{ type?: string; name?: string; text?: string; is_error?: boolean }> | null;
  error?: { type?: string; message?: string };
}

async function sessionState(runtime: RunningRuntime, sessionId: string): Promise<{
  status: string;
  events: SessionEvent[];
}> {
  const sessionResponse = await fetch(`${runtime.baseUrl}/v1/sessions/${sessionId}`);
  const session = await sessionResponse.json() as { status?: string };
  const eventsResponse = await fetch(`${runtime.baseUrl}/v1/sessions/${sessionId}/events?limit=200`);
  const body = await eventsResponse.json() as { data?: SessionEvent[] };
  return { status: session.status ?? '', events: body.data ?? [] };
}

describe('chat with a turn that waits for approval', () => {
  it('allows the gated call, runs the tool, and finishes the turn', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({ toolCalls: [{ name: 'bash', arguments: { command: 'echo cli-approval-ran' } }] });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      const run = await runChat(runtime, { message: 'run the command', toolApproval: 'allow' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(0);

      const state = await sessionState(runtime, run.sessionId);
      const toolResults = state.events.filter((event) => event.type === 'agent.tool_result');
      // The tool ran because the CLI answered the parked call: a run that only
      // printed "allowing" would leave this empty.
      expect(toolResults, JSON.stringify(state.events)).toHaveLength(1);
      expect(toolResults[0].content?.[0]?.is_error ?? false).toBe(false);
      expect(state.status).toBe('idle');
      const messages = state.events.filter((event) => event.type === 'agent.message');
      expect(JSON.stringify(messages)).toContain(STUB_REPLY_TEXT);
      // Two model requests: the one that asked for the tool, and the one whose
      // result was fed back. That is the turn resuming rather than the CLI
      // sending a second message.
      expect(stub.requests).toHaveLength(2);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('denies the gated call, records the refusal, and still finishes the turn', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({ toolCalls: [{ name: 'bash', arguments: { command: 'echo must-not-run' } }] });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      const run = await runChat(runtime, { message: 'run the command', toolApproval: 'deny' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(0);

      const state = await sessionState(runtime, run.sessionId);
      const toolResults = state.events.filter((event) => event.type === 'agent.tool_result');
      expect(toolResults, JSON.stringify(state.events)).toHaveLength(1);
      // Denied, so the result carries the error rather than the command's output.
      expect(toolResults[0].content?.[0]?.is_error).toBe(true);
      expect(JSON.stringify(toolResults)).not.toContain('must-not-run');
      expect(state.status).toBe('idle');
      expect(JSON.stringify(state.events.filter((event) => event.type === 'agent.message')))
        .toContain(STUB_REPLY_TEXT);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('reads the message and the answer from a redirected stdin', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({ toolCalls: [{ name: 'bash', arguments: { command: 'echo piped-approval-ran' } }] });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      // No `-m`: the command reads lines, so the message and the `y` that allows
      // the call both arrive on stdin, which is what a script can do. The
      // decision is still an explicit line rather than a default, and it is read
      // when the prompt appears.
      const run = await runChat(runtime, {
        stdin: [{ send: 'run the command\n' }, { send: 'y\n', after: 'Allow bash' }],
      });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(0);
      // The regression this pins: without `-m` the command used to dereference a
      // readline interface it had chosen not to create.
      expect(run.stderr, context).not.toContain('TypeError');

      const state = await sessionState(runtime, run.sessionId);
      const toolResults = state.events.filter((event) => event.type === 'agent.tool_result');
      expect(toolResults, JSON.stringify(state.events)).toHaveLength(1);
      expect(toolResults[0].content?.[0]?.is_error ?? false).toBe(false);
      expect(state.status).toBe('idle');
      expect(JSON.stringify(state.events.filter((event) => event.type === 'agent.message')))
        .toContain(STUB_REPLY_TEXT);
      expect(stub.requests).toHaveLength(2);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('leaves the call parked when the input ends without an answer', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({ toolCalls: [{ name: 'bash', arguments: { command: 'echo must-not-run' } }] });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      // The message arrives and the input then ends, so the prompt has no answer
      // behind it. Ending is not consent: the call stays parked and the run says
      // so, and it may not die on the closed reader either.
      const run = await runChat(runtime, { stdin: [{ send: 'run the command\n', thenEnd: true }] });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(1);
      expect(run.stdout, context).toContain('waiting for approval');
      expect(run.stderr, context).not.toContain('TypeError');
      expect(run.stderr, context).not.toContain('ERR_USE_AFTER_CLOSE');

      const state = await sessionState(runtime, run.sessionId);
      expect(state.status).toBe('idle');
      expect(state.events.filter((event) => event.type === 'agent.tool_result')).toHaveLength(0);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('answers the gated call and reports the custom one once when a turn parks both', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({
      toolCalls: [
        { name: 'bash', arguments: { command: 'echo mixed-park-ran' } },
        { name: 'lookup_customer', arguments: { id: 'cus_1' } },
      ],
    });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_AND_CUSTOM_TOOLS });

    try {
      const run = await runChat(runtime, { message: 'run both', toolApproval: 'allow' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      // One call was answered, the other cannot be, so the session is still
      // parked: that is a run that needs the caller's own client, not a success.
      expect(run.code, context).toBe(1);
      // The resumed turn re-reports what is still parked, so the notice arrives
      // twice from the runtime and must be printed once.
      expect(run.stdout.split('needs a result only your own client can produce'), context).toHaveLength(2);

      const state = await sessionState(runtime, run.sessionId);
      expect(state.status).toBe('idle');
      const toolResults = state.events.filter((event) => event.type === 'agent.tool_result');
      expect(toolResults, JSON.stringify(state.events)).toHaveLength(1);
      expect(toolResults[0].content?.[0]?.is_error ?? false).toBe(false);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('cannot answer a custom tool, says so, and leaves the call parked', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({
      toolCalls: [{ name: 'lookup_customer', arguments: { id: 'cus_1' } }],
    });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: CUSTOM_TOOL_TOOLS });

    try {
      // Even `allow` cannot answer this family: the runtime has no executor for a
      // custom tool, so a decision would be recorded against nothing.
      const run = await runChat(runtime, { message: 'look up the customer', toolApproval: 'allow' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      // The run needs a person (or the caller's own client), so it reports that
      // state instead of exiting 0 as if the turn had ended.
      expect(run.code, context).toBe(1);
      expect(run.stdout).toContain('custom tool has no executor in the runtime');
      expect(run.stdout).toContain('user.custom_tool_result');

      const state = await sessionState(runtime, run.sessionId);
      expect(state.status).toBe('idle');
      expect(state.events.filter((event) => event.type === 'agent.tool_result')).toHaveLength(0);
      expect(state.events.filter((event) => event.type === 'agent.custom_tool_use')).toHaveLength(1);
      // Nothing was answered, so the runtime never asked the model again.
      expect(stub.requests).toHaveLength(1);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('does not decide anything when there is nobody to ask', { timeout: 90_000 }, async () => {
    const stub = await startStubModelServer({ toolCalls: [{ name: 'bash', arguments: { command: 'echo must-not-run' } }] });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      // The default policy, with no terminal: leaving the call parked is the only
      // safe answer, so the CLI says what is waiting and exits non-zero rather
      // than allowing a tool the operator never saw.
      const run = await runChat(runtime, { message: 'run the command' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(1);
      expect(run.stdout).toContain('waiting for approval');
      expect(run.stdout).toContain('--tool-approval allow|deny');

      const state = await sessionState(runtime, run.sessionId);
      expect(state.status).toBe('idle');
      expect(state.events.filter((event) => event.type === 'agent.tool_result')).toHaveLength(0);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });
});

/**
 * The acceptance gate for "`managed-agents chat` reports a turn that failed".
 *
 * A turn that cannot reach its provider, or whose credential the provider
 * refuses, is recorded as a `session.error` and ends there — either as a failure
 * the session continues from or as one the runtime treats as terminal. The
 * command used to print nothing and exit `0`, which reads exactly like an agent
 * that answered with silence, on the terminal path the README recommends for the
 * first message; and a terminal failure, which the runtime reports as
 * `session.status_terminated` rather than `session.status_idle`, left it waiting
 * on a stream that never closes.
 */
describe('chat with a turn that fails', () => {
  it('reports the recorded failure and exits non-zero', { timeout: 90_000 }, async () => {
    // Port 1 on the loopback interface has no listener: the turn fails before a
    // request can leave the process, without needing a provider to misbehave.
    const runtime = await startRuntimeHarness({ modelBaseUrl: 'http://127.0.0.1:1/v1' });

    try {
      const run = await runChat(runtime, { message: 'hello' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(1);
      expect(run.stdout).toContain('the turn failed');
      expect(run.stdout).toContain(run.sessionId);

      // What the CLI printed has to be what the runtime recorded, not a second
      // story invented at the prompt.
      const state = await sessionState(runtime, run.sessionId);
      const failure = state.events.find((event) => event.type === 'session.error');
      expect(failure, context).toBeDefined();
      const message = failure?.error?.message ?? '';
      expect(message, context).not.toBe('');
      expect(run.stdout).toContain(message);
      expect(state.status).toBe('terminated');
      // The failure is not an approval, so nothing is parked and nothing runs.
      expect(run.stdout).not.toContain('waiting for approval');
    } finally {
      await runtime.stop();
    }
  });

  it('reports a failure on the resumed half of a turn', { timeout: 90_000 }, async () => {
    // The half that used to hang: after an approval is answered the runtime
    // finishes the tool and asks the model again, and a failure there is terminal
    // — it ends the session with `session.status_terminated`, which the tail
    // stream stays open after. Waiting for that socket to close is a command that
    // never returns and never says why.
    const stub = await startStubModelServer({
      toolCalls: [{ name: 'bash', arguments: { command: 'echo conformance' } }],
      // The first request asks for the tool; the resumed request is refused
      // with a non-retryable 400 — not one of the resumable model codes — so
      // the failure is the terminal kind rather than one the session
      // reschedules or pauses to continue from.
      failRequests: [2], failStatus: 400,
    });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_BASH_TOOLS });

    try {
      const run = await runChat(runtime, { message: 'run the command', toolApproval: 'allow' });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      expect(run.code, context).toBe(1);
      expect(run.stdout).toContain('Allowing bash');
      expect(run.stdout).toContain('the turn failed');
      expect(run.stdout).toContain(run.sessionId);

      const state = await sessionState(runtime, run.sessionId);
      const failure = state.events.find((event) => event.type === 'session.error');
      expect(failure, context).toBeDefined();
      expect(run.stdout).toContain(failure?.error?.message ?? 'no message');
      // The tool the operator allowed really ran, and the failure came after it.
      expect(state.events.filter((event) => event.type === 'agent.tool_result')).toHaveLength(1);
      expect(state.status).toBe('terminated');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('does not report a later turn with an earlier turn failure', { timeout: 90_000 }, async () => {
    // A resumable failure leaves the session usable, so the operator's next line
    // is a new turn. That turn must be reported on its own: the failure belongs to
    // the turn that recorded it, and re-printing it makes a successful turn look
    // like a failed one.
    const stub = await startStubModelServer({ failRequests: [1], failStatus: 401 });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });

    try {
      // The second line is written only once the prompt is back, after the
      // failure report: the command reads a line when it asks for one, so a line
      // that arrives earlier is read as the answer to something else (or dropped).
      const run = await runChat(runtime, {
        stdin: [{ send: 'first\n' }, { send: 'second\n', after: 'once the cause is fixed.\nyou> ' }],
      });
      const context = `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`;

      expect(run.sessionId, context).toMatch(/^sess_/);
      // The first turn failed; the second answered, and the run says so once.
      expect(run.stdout.match(/the turn failed/g) ?? [], context).toHaveLength(1);
      expect(run.stdout, context).toContain(STUB_REPLY_TEXT);
      expect(stub.requests.length, context).toBeGreaterThanOrEqual(2);
      // The run contained a failure, so the exit code stays non-zero.
      expect(run.code, context).toBe(1);

      const state = await sessionState(runtime, run.sessionId);
      expect(state.status, context).toBe('idle');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });
});
