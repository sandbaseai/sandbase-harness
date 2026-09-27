import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { PiLauncher, piInvocationFor, probePiCli } from '@/strategy/pi-launcher.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function controlledCli(directory: string): { command: string; commandArgs: string[]; resultPath: string } {
  const script = join(directory, 'controlled-pi.mjs');
  const resultPath = join(directory, 'pi-result.json');
  writeFileSync(script, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [resultPath, ...args] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const config = process.env.PI_CODING_AGENT_DIR
    ? readFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', 'utf8')
    : '';
  const agentsPath = process.cwd() + '/AGENTS.md';
  const result = {
    args,
    stdin,
    cwd: process.cwd(),
    telemetry: process.env.PI_TELEMETRY,
    apiKey: process.env.SANDBASE_PI_API_KEY,
    sourceApiKey: process.env.PI_MODEL_API_KEY,
    sourceBaseUrl: process.env.PI_MODEL_BASE_URL,
    unexpectedSecret: process.env.UNRELATED_SERVICE_SECRET,
    config,
    agents: existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : undefined,
  };
  const waitForAbort = args.includes('sandbase/wait-for-abort');
  if (waitForAbort) {
    process.once('SIGTERM', () => {
      writeFileSync(resultPath, JSON.stringify({ ...result, aborted: true }));
      process.exit(0);
    });
  }
  writeFileSync(resultPath, JSON.stringify(result));
  if (waitForAbort) setInterval(() => {}, 1_000);
});
`);
  return { command: process.execPath, commandArgs: [script, resultPath], resultPath };
}

/**
 * A controlled CLI that behaves like an RPC child: it records its argv and cwd
 * as soon as it starts, then stays alive because an RPC session writes prompts
 * to it later rather than at launch.
 */
function rpcCli(directory: string): { command: string; commandArgs: string[]; resultPath: string } {
  const script = join(directory, 'controlled-rpc-pi.mjs');
  const resultPath = join(directory, 'rpc-argv.json');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const [resultPath, ...args] = process.argv.slice(2);
writeFileSync(resultPath, JSON.stringify({
  args,
  cwd: process.cwd(),
  gateSessionId: process.env.SANDBASE_PI_SESSION_ID,
  gatedTools: process.env.SANDBASE_PI_GATED_TOOLS,
}));
setInterval(() => {}, 1_000);
`);
  return { command: process.execPath, commandArgs: [script, resultPath], resultPath };
}

function restrictedTestEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PI_MODEL_API_KEY: 'resolved-host-api-key',
    PI_MODEL_BASE_URL: 'https://models.example.test/v1',
    UNRELATED_SERVICE_SECRET: 'must-not-inherit',
  };
}

function launchRequest(workDir: string, sessionId: string) {
  return {
    sessionId,
    workDir,
    prompt: 'safe prompt',
    systemPrompt: 'system',
    model: { provider: 'openai', model: 'test-model', api_key: 'test-key' },
  } as const;
}

/**
 * A policy fingerprint for a launch that has no durable state to compare it to.
 *
 * These launches are given no database, so the binding is never read back: the
 * value only has to be present, because a launch must state the contract it is
 * claiming to resume.
 */
const UNCHECKED_POLICY_FINGERPRINT = 'unchecked-policy-fingerprint';

/**
 * Wait until the fixture's result file holds a complete document.
 *
 * Existence is not readiness. The fixtures write with `writeFileSync`, which creates the
 * path before the bytes are in it, so a caller that returned on the first `existsSync`
 * hit could parse an empty or half-written file. That is what produced an intermittent
 * `SyntaxError: Unexpected end of JSON input` in a full-suite run - never in isolation,
 * because the window is only as wide as the gap between the fixture creating the file
 * and finishing the write, and load widens it.
 *
 * Every caller of this helper parses the file as JSON, so readiness is exactly "the bytes
 * parse", which also covers a reader that arrives while the fixture is still writing and
 * any future caller that reads the same way.
 */
async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      try {
        JSON.parse(readFileSync(path, 'utf8'));
        return;
      } catch {
        // Present but not yet complete: keep waiting rather than hand the caller a
        // document it cannot read.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for a complete document at ${path}`);
}

describe('Pi launcher fixture result file', () => {
  it('waits for a complete document rather than for the path to appear', async () => {
    // The defect this covers is a race, so the assertion holds the partial state still
    // instead of hoping to lose the race: a file that exists and cannot be parsed is
    // exactly what the fixture exposes between creating the path and finishing the write.
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-wait-'));
    directories.push(directory);
    const resultPath = join(directory, 'rpc-argv.json');
    writeFileSync(resultPath, '{"args":["--policy"');

    let settled = false;
    const waiting = waitForFile(resultPath).then(() => { settled = true; });
    // Long enough for the previous implementation's 10ms poll to have returned several
    // times over. Against that implementation this is the assertion that fails.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    expect(settled).toBe(false);

    // Completing the document is what releases the wait, so the helper is not merely
    // slower - it is waiting for the condition its callers actually need.
    writeFileSync(resultPath, JSON.stringify({ args: ['--policy', 'none'] }));
    await waiting;
    expect(settled).toBe(true);
  });
});

describe('Pi launcher', () => {
  it('resolves host model settings into a managed config and launches one selected print-mode child', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-launcher-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const prompt = 'do not put this prompt in argv';
    const systemPrompt = '# System\n\nUse the included skill.';
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
    });

    await launcher.launch({
      sessionId: 'sess_safe_123',
      workDir,
      prompt,
      systemPrompt,
      model: {
        provider: 'openai',
        model: 'gpt-4.1',
        api_key: '${PI_MODEL_API_KEY}',
        base_url: '${PI_MODEL_BASE_URL}',
      },
    });

    const observed = JSON.parse(readFileSync(cli.resultPath, 'utf8')) as {
      args: string[];
      stdin: string;
      cwd: string;
      telemetry: string;
      apiKey?: string;
      sourceApiKey?: string;
      sourceBaseUrl?: string;
      unexpectedSecret?: string;
      config: string;
      agents?: string;
    };
    const expectedSessionFile = join(directory, 'pi-sessions', 'sess_safe_123.jsonl');
    expect(observed.args).toEqual([
      '-p', '--mode', 'json', '--model', 'sandbase/gpt-4.1', '--session', expectedSessionFile,
      // This request states no tool policy, and the strict end of Pi's surface is
      // what a launch that cannot state one uses.
      '--no-builtin-tools',
    ]);
    expect(observed.stdin).toBe(prompt);
    expect(observed.cwd).toBe(workDir);
    expect(observed.args.join(' ')).not.toContain(prompt);
    expect(observed.args).not.toContain('--provider');
    expect(observed.telemetry).toBe('0');
    expect(observed.apiKey).toBe('resolved-host-api-key');
    expect(observed.sourceApiKey).toBeUndefined();
    expect(observed.sourceBaseUrl).toBeUndefined();
    expect(observed.unexpectedSecret).toBeUndefined();
    expect(JSON.parse(observed.config)).toEqual({
      providers: {
        sandbase: {
          apiKey: '$SANDBASE_PI_API_KEY',
          api: 'openai-completions',
          baseUrl: 'https://models.example.test/v1',
          models: [{ id: 'gpt-4.1' }],
        },
      },
    });
    expect(observed.config).not.toContain('resolved-host-api-key');
    expect(observed.agents).toBe(systemPrompt);
    expect(existsSync(expectedSessionFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(expectedSessionFile).mode & 0o077).toBe(0);
    }
  });

  it('cancels a running Pi child and waits for it to exit before rejecting the turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-abort-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const controller = new AbortController();
    const terminationCalls: boolean[] = [];
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        terminationCalls.push(force);
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
      // Use the production grace, not a 10 ms budget: the fake CLI writes its
      // result inside the SIGTERM handler, so a runner scheduling delay can
      // otherwise turn a graceful cancel into a forced one.
      terminationGraceMs: 1_000,
    });

    const launch = launcher.launch({
      ...launchRequest(workDir, 'sess_abort_123'),
      model: { provider: 'openai', model: 'wait-for-abort', api_key: 'test-key' },
      abortSignal: controller.signal,
    });
    await waitForFile(cli.resultPath);
    controller.abort();

    await expect(launch).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminationCalls).toEqual([false]);
  });

  it('keeps cancellation pending until a surviving Pi process group is force-terminated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-group-abort-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const controller = new AbortController();
    const terminationCalls: boolean[] = [];
    let groupDescendantAlive = true;
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      platform: 'linux',
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        terminationCalls.push(force);
        if (force) groupDescendantAlive = false;
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
      processGroupAlive: () => groupDescendantAlive,
      terminationGraceMs: 10,
    });

    const launch = launcher.launch({
      ...launchRequest(workDir, 'sess_group_abort_123'),
      model: { provider: 'openai', model: 'wait-for-abort', api_key: 'test-key' },
      abortSignal: controller.signal,
    });
    await waitForFile(cli.resultPath);
    controller.abort();

    await expect(launch).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminationCalls).toEqual([false, true]);
  });

  it('waits for Windows tree termination after the Pi parent closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-windows-tree-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const controller = new AbortController();
    let completeTreeTermination: (() => void) | undefined;
    const treeTermination = new Promise<void>((resolvePromise) => {
      completeTreeTermination = resolvePromise;
    });
    let notifyParentClosed: (() => void) | undefined;
    const parentClosed = new Promise<void>((resolvePromise) => {
      notifyParentClosed = resolvePromise;
    });
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      platform: 'win32',
      environment: restrictedTestEnvironment(),
      terminateProcess: (child) => {
        child.once('close', () => notifyParentClosed?.());
        child.kill('SIGTERM');
        return treeTermination;
      },
    });

    const launch = launcher.launch({
      ...launchRequest(workDir, 'sess_windows_abort_123'),
      model: { provider: 'openai', model: 'wait-for-abort', api_key: 'test-key' },
      abortSignal: controller.signal,
    });
    let settled = false;
    void launch.then(() => { settled = true; }, () => { settled = true; });
    await waitForFile(cli.resultPath);
    controller.abort();
    await parentClosed;
    await Promise.resolve();
    expect(settled).toBe(false);

    completeTreeTermination?.();
    await expect(launch).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects nested unresolved model base URL references before materializing or launching Pi', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-unresolved-url-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: {
        ...restrictedTestEnvironment(),
        PI_MODEL_BASE_URL: '${UNRESOLVED_NESTED_BASE_URL}',
      },
    });

    await expect(launcher.launch({
      sessionId: 'sess_unresolved_url',
      workDir,
      prompt: 'safe prompt',
      systemPrompt: 'system',
      model: {
        provider: 'openai',
        model: 'gpt-4.1',
        api_key: '${PI_MODEL_API_KEY}',
        base_url: '${PI_MODEL_BASE_URL}',
      },
    })).rejects.toThrow('Pi loop engine model base URL contains unresolved environment references');

    expect(existsSync(cli.resultPath)).toBe(false);
    expect(existsSync(join(directory, 'pi-sessions'))).toBe(false);
    expect(existsSync(join(workDir, 'AGENTS.md'))).toBe(false);
  });

  it('rejects nested unresolved model API key references before materializing or launching Pi', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-unresolved-key-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: {
        ...restrictedTestEnvironment(),
        PI_MODEL_API_KEY: '${UNRESOLVED_NESTED_API_KEY}',
      },
    });

    await expect(launcher.launch({
      sessionId: 'sess_unresolved_key',
      workDir,
      prompt: 'safe prompt',
      systemPrompt: 'system',
      model: {
        provider: 'openai',
        model: 'gpt-4.1',
        api_key: '${PI_MODEL_API_KEY}',
        base_url: '${PI_MODEL_BASE_URL}',
      },
    })).rejects.toThrow('Pi loop engine model API key contains unresolved environment references');

    expect(existsSync(cli.resultPath)).toBe(false);
    expect(existsSync(join(directory, 'pi-sessions'))).toBe(false);
    expect(existsSync(join(workDir, 'AGENTS.md'))).toBe(false);
  });

  it('uses the Anthropic API kind with the same managed provider selector', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-anthropic-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
    });

    await launcher.launch({
      sessionId: 'sess_anthropic_123',
      workDir,
      prompt: 'hello',
      systemPrompt: 'system',
      model: { provider: 'anthropic', model: 'claude-test', api_key: '${PI_MODEL_API_KEY}' },
    });

    const observed = JSON.parse(readFileSync(cli.resultPath, 'utf8')) as { args: string[]; config: string };
    expect(observed.args).toEqual(expect.arrayContaining(['--model', 'sandbase/claude-test']));
    expect(JSON.parse(observed.config)).toEqual({
      providers: {
        sandbase: {
          apiKey: '$SANDBASE_PI_API_KEY',
          api: 'anthropic-messages',
          models: [{ id: 'claude-test' }],
        },
      },
    });
  });

  it('rejects unsafe session identifiers before resolving a session file path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-path-'));
    directories.push(directory);
    const launcher = new PiLauncher({ dataDir: directory, command: process.execPath });

    await expect(launcher.launch({
      sessionId: 'sess_.._escape',
      workDir: directory,
      prompt: 'safe prompt',
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'test-model', api_key: 'test-key' },
    })).rejects.toThrow('Pi session id is invalid');
    expect(existsSync(join(directory, 'escape.jsonl'))).toBe(false);
  });

  it('refuses non-regular session and AGENTS.md targets before launching Pi', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-private-files-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = controlledCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
    });

    const sessionsDir = join(directory, 'pi-sessions');
    mkdirSync(sessionsDir);
    mkdirSync(join(sessionsDir, 'sess_nonregular.jsonl'));
    await expect(launcher.launch(launchRequest(workDir, 'sess_nonregular')))
      .rejects.toThrow('Pi session file must be a private regular file');
    expect(existsSync(cli.resultPath)).toBe(false);

    rmSync(join(sessionsDir, 'sess_nonregular.jsonl'), { recursive: true });
    mkdirSync(join(workDir, 'AGENTS.md'));
    await expect(launcher.launch(launchRequest(workDir, 'sess_agents_target')))
      .rejects.toThrow('Pi AGENTS.md must be a private regular file');
    expect(existsSync(cli.resultPath)).toBe(false);
  });

  it('uses the neighbouring PowerShell shim for a Windows npm pi.cmd executable', () => {
    const command = 'C:\\npm\\pi.cmd';
    const shim = 'C:\\npm\\pi.ps1';
    const invocation = piInvocationFor(['-p', '--mode', 'json', '--session', 'C:\\data\\pi-sessions\\sess_1.jsonl'], {
      command,
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      fileExists: (path) => path === shim,
    });

    expect(invocation.file).toBe(win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(invocation.args).toEqual(expect.arrayContaining([
      '-Command',
      '& $args[0] @args[1..($args.Length - 1)]',
      shim,
      '-p',
      '--mode',
      'json',
      '--session',
      'C:\\data\\pi-sessions\\sess_1.jsonl',
    ]));
  });

  it('fails explicitly when the Pi executable is missing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-missing-'));
    directories.push(directory);
    const launcher = new PiLauncher({ dataDir: directory, command: join(directory, 'missing-pi') });

    await expect(launcher.launch({
      sessionId: 'sess_missing',
      workDir: directory,
      prompt: 'hello',
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'test-model', api_key: 'test-key' },
    })).rejects.toThrow('Pi CLI is not available');
  });

  it('probes a controlled executable without passing service credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-probe-'));
    directories.push(directory);
    const cli = controlledCli(directory);
    const result = await probePiCli({
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
    });

    expect(result).toEqual({ available: true, message: 'Pi CLI is available.' });
  });

  it('launches one RPC child with the compiled flags and no prompt on its channel', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-rpc-launch-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = rpcCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    });
    const request = {
      sessionId: 'sess_rpc_launch',
      workDir,
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'gpt-4.1', api_key: '${PI_MODEL_API_KEY}' },
      // The plan admission compiled is the argv: nothing here re-derives it.
      toolArgs: ['--tools', 'read,grep'],
      policyFingerprint: UNCHECKED_POLICY_FINGERPRINT,
    };

    const handle = await launcher.startRpc(request);
    await waitForFile(cli.resultPath);
    const observed = JSON.parse(readFileSync(cli.resultPath, 'utf8')) as { args: string[]; cwd: string };

    expect(observed.args).toEqual([
      '--mode', 'rpc', '--model', 'sandbase/gpt-4.1',
      '--session', join(directory, 'pi-sessions', 'sess_rpc_launch.jsonl'),
      '--tools', 'read,grep',
    ]);
    // Nothing print-mode about it: no `-p`, and the child stays alive with its
    // command channel open for the turns that follow.
    expect(observed.args).not.toContain('-p');
    expect(observed.cwd).toBe(workDir);
    expect(handle.stdin.writable).toBe(true);
    expect(handle.sessionFile).toBe(join(directory, 'pi-sessions', 'sess_rpc_launch.jsonl'));

    // The session lease is what makes "one child per session" true across
    // processes, including a second runtime instance pointed at the same data.
    await expect(launcher.startRpc(request)).rejects.toMatchObject({ code: 'pi_session_busy' });

    await handle.interrupt();
  });

  it('exposes no built-in tool for an RPC launch that states no policy at all', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-rpc-unstated-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = rpcCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    });

    const handle = await launcher.startRpc({
      sessionId: 'sess_rpc_unstated',
      workDir,
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'gpt-4.1', api_key: '${PI_MODEL_API_KEY}' },
      policyFingerprint: UNCHECKED_POLICY_FINGERPRINT,
    });
    await waitForFile(cli.resultPath);
    const observed = JSON.parse(readFileSync(cli.resultPath, 'utf8')) as { args: string[] };

    // Omitted is not "unrestricted": a launch that cannot state its policy is
    // given the strict end of Pi's own surface.
    expect(observed.args).toContain('--no-builtin-tools');
    expect(observed.args).not.toContain('--tools');

    await handle.interrupt();
  });

  it('loads the managed gate extension for a launch that names gated tools', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-rpc-gate-launch-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = rpcCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    });

    const handle = await launcher.startRpc({
      sessionId: 'sess_rpc_gate',
      workDir,
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'gpt-4.1', api_key: '${PI_MODEL_API_KEY}' },
      toolArgs: ['--tools', 'read,bash'],
      gateTools: ['bash'],
      policyFingerprint: UNCHECKED_POLICY_FINGERPRINT,
    });
    await waitForFile(cli.resultPath);
    const observed = JSON.parse(readFileSync(cli.resultPath, 'utf8')) as {
      args: string[];
      gateSessionId?: string;
      gatedTools?: string;
    };

    const extensionFile = join(directory, 'pi-sessions', 'sess_rpc_gate', 'gate-extension.mjs');
    // Discovery off, then exactly one extension on: a project-local file in the
    // work directory cannot add itself to, or replace, the gate.
    expect(observed.args).toEqual([
      '--mode', 'rpc', '--model', 'sandbase/gpt-4.1',
      '--session', join(directory, 'pi-sessions', 'sess_rpc_gate.jsonl'),
      '--tools', 'read,bash',
      '--no-extensions', '--extension', extensionFile,
    ]);
    expect(handle.gateExtensionFile).toBe(extensionFile);
    // The extension is written where the launch points, and it is the gate the
    // runtime later proves loaded by looking for its marker command.
    expect(existsSync(extensionFile)).toBe(true);
    const source = readFileSync(extensionFile, 'utf8');
    expect(source).toContain('sandbase-gate-');
    expect(source).toContain('SANDBASE_PI_GATED_TOOLS');
    expect(source).toContain('SANDBASE_PI_SESSION_ID');
    // The gated names travel to the extension through its environment, so the
    // child can block exactly those tools and nothing else.
    expect(observed.gateSessionId).toBe('sess_rpc_gate');
    expect(JSON.parse(observed.gatedTools ?? '[]')).toEqual(['bash']);

    await handle.interrupt();
  });

  it('refuses a gate tool list with no usable name instead of launching ungated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-rpc-gate-blank-'));
    directories.push(directory);
    const workDir = join(directory, 'work');
    mkdirSync(workDir);
    const cli = rpcCli(directory);
    const launcher = new PiLauncher({
      dataDir: directory,
      command: cli.command,
      commandArgs: cli.commandArgs,
      environment: restrictedTestEnvironment(),
      terminateProcess: (child, _platform, force) => {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    });

    // A blank name is a gated tool the extension could never match, so the launch
    // fails rather than starting with nothing gated.
    await expect(launcher.startRpc({
      sessionId: 'sess_rpc_gate_blank',
      workDir,
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'gpt-4.1', api_key: '${PI_MODEL_API_KEY}' },
      toolArgs: ['--tools', 'bash'],
      gateTools: [''],
      policyFingerprint: UNCHECKED_POLICY_FINGERPRINT,
    })).rejects.toThrow('Pi gate tool list contains no usable native tool name');
    expect(existsSync(cli.resultPath)).toBe(false);
  });
});
