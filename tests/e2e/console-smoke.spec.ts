/**
 * Console smoke test (WP5 F13): one ordered browser scenario against a real
 * runtime, not a mocked one.
 *
 *   1. Create an agent through the Console's YAML composer, with `bash` gated
 *      behind `always_ask`.
 *   2. Start a session from the agent page and send a message; the stub model
 *      calls `bash`.
 *   3. The approval card appears; click Allow.
 *   4. The session returns to idle and shows the stub's final reply.
 *   5. Archive the session; the status reads Archived.
 *
 * The fixture stack is started in `beforeAll`: the conformance stub model
 * server, the real runtime via `startRuntimeHarness`, and the Vite dev server
 * for the Console with `CONSOLE_API_TARGET` pointed at that runtime. Nothing
 * is mocked inside the page.
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

const AGENT_YAML = `name: e2e-smoke-agent
model: conformance-model
system: You are the Console smoke-test agent.
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
    configs:
      - name: bash
        enabled: true
        permission_policy:
          type: always_ask
max_turns: 5
temperature: 0.0
`;

let stub: StubModelServer;
let runtime: RunningRuntime;
let vite: ChildProcess;
let consoleBaseUrl: string;

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
  stub = await startStubModelServer();
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

test('create agent, approve a bash call, read the reply, archive the session', async ({ page }) => {
  await page.goto(consoleBaseUrl);

  // 1. Create the agent through the YAML composer.
  await page.getByRole('button', { name: 'Agents' }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  const createModal = page.getByRole('dialog', { name: 'Create agent' });
  await createModal.locator('.yamlShell textarea').fill(AGENT_YAML);
  await createModal.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(createModal).toBeHidden();
  await page.getByText('e2e-smoke-agent', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'e2e-smoke-agent' })).toBeVisible();

  // 2. Start a session from the agent page and send a message.
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  const sessionModal = page.getByRole('dialog', { name: 'Create session' });
  await sessionModal.getByRole('button', { name: 'Select an environment' }).click();
  // Bootstrap seeds `env_default` named "local" plus the workspace's own
  // `local` environment — both are the same provider, so either matches.
  await page.getByRole('option', { name: /local/ }).first().click();
  await sessionModal.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(sessionModal).toBeHidden();
  // Creating lands on the sessions list; open the row just created.
  await page.locator('tr.clickableRow').first().click();

  await page.locator('textarea').last().fill('run the command');
  await page.getByRole('button', { name: 'Send' }).click();

  // 3. The stub calls bash, which is gated — the approval card must appear.
  await expect(page.getByText('Waiting for your approval')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Allow' }).click();

  // 4. The turn completes: idle again, and the stub's final reply rendered.
  await expect(page.getByText(STUB_REPLY_TEXT)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status.idle').first()).toBeVisible();

  // 5. Archive the session.
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('button', { name: 'Archive session' }).click();
  await expect(page.locator('.status.archived').first()).toBeVisible();
});
