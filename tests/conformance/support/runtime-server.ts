/**
 * Start the real runtime for a conformance suite: the same process, on the same
 * entry point, that `managed-agents start` runs.
 *
 * The other conformance suites drive `app.request`, which exercises the router
 * without a socket — the right tool for asserting response shapes, and the wrong
 * one for asserting that an official client can connect, because an official
 * client is an HTTP client. This helper therefore spawns `src/index.ts` (through
 * the `tsx` loader the repository's own `npm run dev` uses) against a temporary
 * workspace, on a free port, and waits for the health route before returning.
 *
 * Source rather than `dist/`: `npm test` runs before `npm run build` in the
 * release gate and in CI, so a suite that needed build output would fail on a
 * fresh clone. The workspace it writes is the layout `init` produces, minus the
 * parts a conformance run does not exercise, and it points the provider at the
 * caller's own model endpoint — which is how the stub model server in this
 * directory gets registered for exactly one test run.
 *
 * Nothing here is shelled out through a shell, no output is inherited, and the
 * temp directory is removed on stop: a leaked server would hold a port and a
 * SQLite file, and those are the two things a later run notices first.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface RuntimeHarnessOptions {
  /** Provider base URL the workspace config points at, e.g. the stub model server's. */
  modelBaseUrl: string;
  /** Agent name to write into `agents/<name>.yaml`. */
  agentName?: string;
  /** Model id the agent asks for; the provider's own id matters only to the provider. */
  model?: string;
  /** How long to wait for the health route, in milliseconds. */
  readyTimeoutMs?: number;
}

export interface RunningRuntime {
  /** `http://127.0.0.1:<port>`, the URL an official SDK client is given. */
  baseUrl: string;
  port: number;
  workspaceDir: string;
  /** Everything the server printed, for a failure message that says why. */
  output(): string;
  stop(): Promise<void>;
}

export async function startRuntimeHarness(options: RuntimeHarnessOptions): Promise<RunningRuntime> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'ma-conformance-sdk-'));
  const stateDir = join(workspaceDir, '.managed-agents');
  mkdirSync(join(workspaceDir, 'agents'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const agentName = options.agentName ?? 'conformance-assistant';
  const model = options.model ?? 'conformance-model';

  writeFileSync(
    join(stateDir, 'config.yaml'),
    [
      '# Written by tests/conformance/support/runtime-server.ts.',
      'model:',
      '  provider: openai',
      `  base_url: ${options.modelBaseUrl}`,
      '  api_key: conformance-stub-key',
      '',
      'storage:',
      '  metadata:',
      '    provider: sqlite',
      '    options: {}',
      '',
      'environments:',
      '  local:',
      '    sandbox_provider: local',
      '    timeout: 300',
      '',
    ].join('\n'),
  );

  // One agent from the workspace, so the runtime starts in the shape a real
  // workspace has. The quickstart does not use it: the published flow creates
  // its own agent over the API, which is the part of the flow being checked.
  writeFileSync(
    join(workspaceDir, 'agents', `${agentName}.yaml`),
    [
      `name: ${agentName}`,
      `model: ${model}`,
      'system: |',
      '  You are a conformance assistant.',
      'tools:',
      '  - type: agent_toolset_20260401',
      '    default_config:',
      '      enabled: false',
      '    configs:',
      '      - name: glob',
      '        enabled: true',
      '        permission_policy:',
      '          type: always_allow',
      'max_turns: 5',
      'temperature: 0.0',
      '',
    ].join('\n'),
  );

  const port = await findFreePort();
  // The run inherits the developer's environment except for the variables that
  // would change what it measures: the inbound rate limits, a machine-wide home
  // directory, or an API key this suite never uses. Removing them rather than
  // overriding each one at least covers the reads that exist today
  // (`src/api/rate-limit.ts`, `src/core/runtime/bootstrap.ts`).
  const {
    MANAGED_AGENTS_API_KEY: _inheritedApiKey,
    MANAGED_AGENTS_HOME: _inheritedHome,
    MANAGED_AGENTS_INBOUND_RATE_LIMIT: _inheritedLimit,
    MANAGED_AGENTS_INBOUND_RATE_LIMIT_READ: _inheritedReadLimit,
    MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE: _inheritedWriteLimit,
    ...inherited
  } = process.env;
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    join(repositoryRoot, 'src', 'index.ts'),
    'start',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--workspace',
    workspaceDir,
  ], {
    cwd: repositoryRoot,
    env: {
      ...inherited,
      // Template downloads and machine-wide state belong to this run, not to
      // whoever ran the suite.
      MANAGED_AGENTS_HOME: join(workspaceDir, 'home'),
      // The runtime is started without a key so the client's credential is not
      // what the assertions depend on; a key would only add one more variable.
      MANAGED_AGENTS_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  const runtime: RunningRuntime = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    workspaceDir,
    output: () => output,
    stop: () => stopRuntime(child, workspaceDir),
  };

  try {
    await waitForHealth(runtime, options.readyTimeoutMs ?? 120_000, child);
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  return runtime;
}

async function waitForHealth(runtime: RunningRuntime, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the runtime exited with code ${child.exitCode} before it was ready\n${runtime.output()}`);
    }
    try {
      const response = await fetch(`${runtime.baseUrl}/v1/x/health`);
      if (response.ok) {
        // The agents directory is loaded at startup; a session created before it
        // is would fail as if the workspace were empty.
        const agents = await fetch(`${runtime.baseUrl}/v1/agents`);
        const body = await agents.json() as { data?: unknown[] };
        if (agents.ok && Array.isArray(body.data) && body.data.length > 0) return;
        lastError = new Error('the runtime is up but has loaded no agents yet');
      } else {
        lastError = new Error(`health answered ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`the runtime was not ready within ${timeoutMs}ms: ${String(lastError)}\n${runtime.output()}`);
}

async function stopRuntime(child: ChildProcess, workspaceDir: string): Promise<void> {
  if (child.exitCode === null) {
    // The listener is registered before the signal, so an exit that races the
    // call is still observed rather than waited out.
    const exited = new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true)));
    // SIGTERM is the runtime's graceful path: it drains turns, closes the
    // database, and stops its timers, which is what keeps the SQLite file
    // removable on Windows where an open handle blocks the delete.
    child.kill('SIGTERM');
    if (!(await Promise.race([exited, delay(10_000).then(() => false)]))) {
      // Last resort, and still waited on: deleting the workspace under a live
      // process would leave that process writing to a path that no longer exists.
      const killed = new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true)));
      child.kill();
      await Promise.race([killed, delay(5_000)]);
    }
  }
  rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
