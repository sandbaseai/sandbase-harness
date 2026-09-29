/**
 * The acceptance gate for "the official SDK can connect": the published
 * Anthropic TypeScript SDK, driven against this runtime exactly as
 * `examples/official-sdk/quickstart.mjs` drives it, with the model supplied by a
 * stub provider this test starts (D28).
 *
 * It is not a shape test. Every other suite here asserts what the API answers;
 * this one asserts that an official client can *use* it — create an agent, an
 * environment and a session over HTTP, open the event stream, send a message,
 * and read a turn through to `session.status_idle`, including a tool call the
 * agent has to execute and feed back before the turn can end. That round trip is
 * the part a hand-written client cannot prove, because the runtime and the test
 * would be agreeing with each other.
 *
 * Two processes are started and both are real: the runtime is `src/index.ts`
 * through the repository's own `tsx` loader, on a free port, in a temporary
 * workspace whose config points at the stub model. The example script is spawned
 * as a child process rather than imported, because that is the command its
 * README gives a user, and a documented command that CI never runs is a claim
 * rather than a check.
 *
 * The stub is a workspace's provider, never a runtime feature: nothing under
 * `src/` can select it, and it appears in no Settings page, CLI flag, or doc.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STUB_REPLY_TEXT, startStubModelServer } from './support/stub-model-server.js';
import { startRuntimeHarness } from './support/runtime-server.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const quickstart = join(repositoryRoot, 'examples', 'official-sdk', 'quickstart.mjs');

interface QuickstartLine {
  type: string;
  text?: string;
  message?: string;
}

interface QuickstartRun {
  code: number | null;
  lines: QuickstartLine[];
  stdout: string;
  stderr: string;
}

describe('official SDK quickstart', () => {
  it('runs a turn through the published SDK and reads the reply, the tool call, and idle', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });

    try {
      const run = await runQuickstart(runtime.baseUrl);

      // A non-zero exit means the script reported why; quoting its output is the
      // difference between a failing assertion and a diagnosable one.
      expect(run.stderr, run.stdout).toBe('');
      expect(run.code, `${run.stdout}\n${run.stderr}\n--- runtime ---\n${runtime.output()}`).toBe(0);

      const of = (type: string) => run.lines.filter((line) => line.type === type);

      // The agent's answer, as text, exactly as the model produced it.
      expect(of('agent.message').map((line) => line.text)).toEqual([STUB_REPLY_TEXT]);

      // The tool call the agent made, executed by the runtime, and its result.
      // The result's text is the script's own summary, so the count is the
      // assertion; that the runtime fed the result back to the model is what the
      // request count at the end of this case checks.
      expect(of('agent.tool_use')).toHaveLength(1);
      expect(of('agent.tool_use')[0]?.text).toBe('glob {"pattern":"*"}');
      expect(of('agent.tool_result')).toHaveLength(1);
      expect(stub.calledTool).toBe('glob');

      // The terminal state, announced by the stream and confirmed by a retrieve.
      expect(of('session.status_idle')).toHaveLength(1);
      expect(of('session.status_idle')[0]?.text).toBe('stop_reason=end_turn');
      expect(of('session.retrieve')[0]?.text).toContain('idle');

      // Two model requests: the tool call, then the answer that ends the turn.
      // One would mean the runtime never fed the tool result back.
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[1]?.messages?.some((message) => {
        const content = message.content;
        return message.role === 'tool'
          || (Array.isArray(content) && content.some((part) => {
            const type = (part as { type?: string } | null)?.type;
            return type === 'tool-result' || type === 'tool_result';
          }));
      })).toBe(true);
    } finally {
      await runtime.stop();
      await stub.close();
    }
    // The budget covers starting a runtime process from source and a full turn.
    // It is generous because the CI runners this repository measures run roughly
    // ten times slower than a developer machine (see vitest.config.ts).
  }, 300_000);

  it('refuses to run when both credential variables are set, before it calls anything', async () => {
    // The runtime answers 401 when a request carries both `x-api-key` and
    // `Authorization: Bearer` (tests/integration/auth.test.ts pins that), and the
    // SDK sends both when both variables are exported. Without this guard a user
    // following the README with `ANTHROPIC_AUTH_TOKEN` already in their shell
    // would see the first call fail for a reason the 401 does not name.
    //
    // No runtime is started: the guard is the first thing the script does, which
    // is also why this case proves the message arrives instead of a transport error.
    const run = await runQuickstart('http://127.0.0.1:1', { bothCredentials: true });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('');
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]?.type).toBe('error');
    expect(run.lines[0]?.message).toContain('not both');
    expect(run.lines[0]?.message).toContain('401');
  }, 60_000);
});

/** Run the example exactly as its README says to, and parse its `--json` lines. */
async function runQuickstart(
  baseUrl: string,
  options: { bothCredentials?: boolean } = {},
): Promise<QuickstartRun> {
  // Exactly one credential variable, which is the contract the runtime enforces:
  // both at once is a 401. The others are removed rather than blanked, so a
  // developer who has them exported cannot change what this test measures:
  // `ANTHROPIC_CUSTOM_HEADERS` can carry a second credential, `ANTHROPIC_LOG`
  // writes to the stdout this test parses, and `QUICKSTART_MODEL` would move the
  // model id the assertions quote.
  const {
    ANTHROPIC_AUTH_TOKEN: _unusedAuthToken,
    ANTHROPIC_CUSTOM_HEADERS: _unusedCustomHeaders,
    ANTHROPIC_LOG: _unusedLog,
    QUICKSTART_MODEL: _unusedModel,
    ...environment
  } = process.env;
  const child = spawn(process.execPath, [quickstart, '--json', 'Look at the workspace, then say hello.'], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'conformance-stub-key',
      ...(options.bothCredentials ? { ANTHROPIC_AUTH_TOKEN: 'conformance-stub-token' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    // Deliberately longer than the script's own 120_000 abort: the script has to
    // be the one to give up, because its exit code says which step stopped
    // producing events, and a kill here would replace that with a timeout.
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error(`the quickstart did not exit within 240s\n${stdout}\n${stderr}`));
    }, 240_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode);
    });
  });

  // Only the script's own JSON lines are read, and a line that merely starts with
  // `{` is not enough to claim one: anything else on stdout is left alone.
  const lines: QuickstartLine[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as QuickstartLine;
      if (typeof parsed?.type === 'string') lines.push(parsed);
    } catch {
      // Not a report line, e.g. a library writing to stdout.
    }
  }
  return { code, lines, stdout, stderr };
}
