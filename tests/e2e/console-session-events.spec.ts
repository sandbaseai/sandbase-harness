/**
 * Console session lifecycle E2E: create, message, event replay, and a failed
 * turn — against a real runtime, not a mocked one.
 *
 *   1. Create a session through the real API against the workspace agent, then
 *      open it in the Console's session list.
 *   2. Send a message; the stub model's reply renders through the live stream.
 *   3. Reload the page and open the session again: the timeline is repopulated
 *      from the recorded log — the event-replay half of the stream contract.
 *   4. Arm the stub to refuse the next four model requests and send again; the
 *      turn fails through the real retry loop (1s/2s/4s) and the composer shows
 *      the retries-exhausted state with the conversation kept.
 *
 * The fixture stack is the same one `console-smoke.spec.ts` documents: stub
 * model server, real runtime via `startRuntimeHarness`, and the Vite dev
 * server with `CONSOLE_API_TARGET` pointed at the runtime.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startRuntimeHarness, type RunningRuntime } from '../conformance/support/runtime-server';
import { startStubModelServer, STUB_REPLY_TEXT, type StubModelServer } from '../conformance/support/stub-model-server';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SESSION_TITLE = 'e2e-session-events';

let stub: StubModelServer;
let runtime: RunningRuntime;
let vite: ChildProcess;
let consoleBaseUrl: string;
/** Mutable on purpose: the stub matches ordinals against this array per request,
 *  so pushing ordinals mid-scenario arms a failure after the happy path ran. */
const failOrdinals: number[] = [];

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404 || response.status === 301) return;
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`${url} was not ready within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  stub = await startStubModelServer({ failRequests: failOrdinals });
  runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });

  const port = await findFreePort();
  consoleBaseUrl = `http://127.0.0.1:${port}/dashboard/`;
  vite = spawn(process.execPath, [
    join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', join(repositoryRoot, 'apps', 'console', 'vite.config.ts'),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, CONSOLE_API_TARGET: runtime.baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let viteOutput = '';
  vite.stdout?.on('data', (chunk: Buffer) => { viteOutput += chunk.toString(); });
  vite.stderr?.on('data', (chunk: Buffer) => { viteOutput += chunk.toString(); });
  try {
    await waitForUrl(consoleBaseUrl, 30_000);
  } catch (error) {
    throw new Error(`the Console dev server did not start\n${viteOutput}\n${String(error)}`);
  }
});

test.afterAll(async () => {
  if (vite && vite.exitCode === null) vite.kill('SIGTERM');
  if (runtime) await runtime.stop();
  if (stub) await stub.close();
});

test('create, message, replay the log, and ride a failed turn to retries_exhausted', async ({ page }) => {
  // 1. Create the session over the real API — the Console-side create flow is
  //    already covered by the smoke spec; this test's surface is the timeline.
  const agents = await (await fetch(`${runtime.baseUrl}/v1/agents`)).json() as { data: Array<{ id: string }> };
  const agentId = agents.data[0]!.id;
  const environments = await (await fetch(`${runtime.baseUrl}/v1/environments`)).json() as { data: Array<{ id: string }> };
  const environmentId = environments.data[0]!.id;
  const created = await fetch(`${runtime.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: agentId, environment_id: environmentId, title: SESSION_TITLE }),
  });
  expect(created.status, await created.clone().text()).toBe(201);

  // 2. Open it in the Console and send a message; the stub's reply renders.
  //    The nav landmark scopes the locator — a session detail renders its own
  //    "Sessions" back button, so an unscoped role query matches both.
  await page.goto(consoleBaseUrl);
  await page.getByRole('navigation').getByRole('button', { name: 'Sessions' }).click();
  await page.locator('tr.clickable-row', { hasText: SESSION_TITLE }).click();

  await page.locator('textarea').last().fill('say hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(STUB_REPLY_TEXT).first()).toBeVisible({ timeout: 60_000 });

  // 3. Reload and reopen: the reply is rendered again from the recorded log —
  //    there is no live stream left to deliver it, so only a replayed read can.
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Sessions' }).click();
  await page.locator('tr.clickable-row', { hasText: SESSION_TITLE }).click();
  await expect(page.getByText(STUB_REPLY_TEXT).first()).toBeVisible({ timeout: 60_000 });

  // 4. Fail the next turn: 1 attempt + 3 retries (server_error backoff
  //    1s/2s/4s) — ordinals read off the requests the stub actually saw, so a
  //    turn that spent more than the scripted two requests still lines up.
  const next = stub.requests.length + 1;
  failOrdinals.push(next, next + 1, next + 2, next + 3);
  await page.locator('textarea').last().fill('fail please');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Retries were exhausted')).toBeVisible({ timeout: 90_000 });
});
