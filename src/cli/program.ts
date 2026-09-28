import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultConfigPath, defaultTemplateCacheDir, WORKSPACE_STATE_DIR } from '../core/config/paths.js';
import { createTemplate, installTemplate, listTemplates, resolveTemplateSource } from '../core/templates/templates.js';
import {
  environmentArchiveCommand,
  environmentCreateCommand,
  environmentInspectCommand,
  environmentUpdateCommand,
  environmentWorkerKeysCommand,
  environmentsListCommand,
  settingsGetCommand,
  settingsSetModelCommand,
  settingsValidateCommand,
} from './runtime-management-commands.js';
import {
  sessionCreateCommand,
  sessionInspectCommand,
  sessionLogsCommand,
  sessionMessageCommand,
  sessionTailCommand,
} from './session-commands.js';
import { workerPollCommand } from './worker-commands.js';
import {
  workspaceCreateCommand,
  workspaceListCommand,
  workspaceOpenCommand,
  workspaceRemoveCommand,
  workspaceResolveCommand,
} from './workspace-commands.js';

export interface StartServerOptions {
  port: string;
  host: string;
  workspace?: string;
  dataDir?: string;
  logFile?: string;
  agentsDir: string;
  skillsDir: string;
  config?: string;
  target?: string;
}

export interface CliProgramOptions {
  version: string;
  startServer: (opts: StartServerOptions) => Promise<void>;
}

export function runCli(options: CliProgramOptions): void {
  createCliProgram(options).parse();
}

export function createCliProgram({ version, startServer }: CliProgramOptions): Command {
  const program = new Command();
  program
    .name('managed-agents')
    .description('Managed Agents runtime - run multi-agent systems locally with any model')
    .version(version);

  program
    .command('start', { isDefault: true })
    .description('Start the managed-agents server')
    .option('-p, --port <port>', 'Server port', '3000')
    .option('--host <host>', 'Server host', '127.0.0.1')
    .option('-w, --workspace <dir>', 'Workspace root directory', '.')
    .option('-d, --data-dir <dir>', `Workspace state directory (default: <workspace>/${WORKSPACE_STATE_DIR})`)
    .option('--log-file <file>', `Runtime log file (default: <workspace>/${WORKSPACE_STATE_DIR}/logs/runtime.log)`)
    .option('--agents-dir <dir>', 'Agents directory', 'agents')
    .option('--skills-dir <dir>', 'Skills directory', 'skills')
    .option('-c, --config <file>', `Config file path (default: <workspace>/${WORKSPACE_STATE_DIR}/config.yaml)`)
    .option('--target <target>', 'Deployment target for config overrides (local|cloud)', 'local')
    .action(async (opts) => {
      await startServer(opts);
    });

  program
    .command('init')
    .description('Initialize a new managed-agents project')
    .action(() => {
      initProject();
    });

  program
    .command('list')
    .description('List loaded agents')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .action(async (opts) => {
      await listAgents(opts);
    });

  program
    .command('reload')
    .description('Hot-reload agent definitions')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .action(async (opts) => {
      await reloadAgents(opts);
    });

  program
    .command('chat [agent]')
    .description('Interactively chat with an agent (streams the reply)')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-m, --message <text>', 'Send a single message and exit (non-interactive)')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .action(async (agent, opts) => {
      await chatCommand(agent, opts);
    });

  program
    .command('deploy')
    .description('Show cloud deployment guidance (v1 placeholder)')
    .action(() => {
      console.log('managed-agents deploy\n');
      console.log('Agent definitions are portable - the same agents/ and skills/');
      console.log('run locally and in the cloud with no changes (Requirement 13).\n');
      console.log('v1 does not push to a hosted service yet. To deploy today:');
      console.log('  1. Build:   npm run build');
      console.log(`  2. Package: ship dist/ + agents/ + skills/ + ${WORKSPACE_STATE_DIR}/config.yaml`);
      console.log('  3. Run:     node dist/index.js start --port $PORT');
      console.log('  4. Add model providers in Dashboard Settings > Models, or seed a new');
      console.log(`     workspace from ${WORKSPACE_STATE_DIR}/config.yaml.`);
      console.log('  5. Or containerize with any Node 22+ base image.\n');
      console.log(`Runtime metadata, secrets, and logs are stored under ${WORKSPACE_STATE_DIR}/.`);
    });

  // The canonical runtime settings group. `docs/api-matrix.md:86` documents it as covered —
  // "Get, set model boundary, and validate canonical runtime settings" — and
  // `src/cli/runtime-management-commands.ts` implements it, but the module was imported by
  // nothing, so all three answered `unknown command 'settings'`. Registering them was not
  // enough on its own: they also had to be moved onto the routes' own document, which is why
  // this arrives with the `SettingsResource` change rather than before it.
  const settings = program.command('settings').description('Inspect and update canonical runtime settings');

  settings
    .command('get')
    .description('Print the saved and effective runtime settings')
    .option('-p, --port <port>', 'Runtime port', '3000')
    .option('-k, --api-key <key>', 'API key')
    .option('--json', 'Print the runtime response as JSON', false)
    .action((opts) => settingsGetCommand(opts));

  settings
    .command('validate')
    .description('Validate the stored settings and print every issue')
    .option('-p, --port <port>', 'Runtime port', '3000')
    .option('-k, --api-key <key>', 'API key')
    .option('--json', 'Print the runtime response as JSON', false)
    .action((opts) => settingsValidateCommand(opts));

  settings
    .command('set-model')
    .description('Point the model boundary at a vendor')
    .requiredOption('--vendor <vendor>', 'Model vendor, e.g. openai or anthropic')
    .option('--base-url <url>', 'Base URL for an openai_compatible vendor')
    .option('--api-key-env <name>', 'Environment variable holding the key, written as a ${NAME} reference')
    .option('-p, --port <port>', 'Runtime port', '3000')
    .option('-k, --api-key <key>', 'API key')
    .option('--json', 'Print the runtime response as JSON', false)
    .action((opts) => settingsSetModelCommand(opts));

  // The environments CLI group. `docs/api-matrix.md:87` documents it as covered and
  // `src/cli/runtime-management-commands.ts` implements it, but the module was imported
  // by nothing, so every command answered `unknown command 'environments'`.
  const environments = program.command('environments').description('Manage runtime environments');

  environments
    .command('list')
    .description('List environments')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (opts) => {
      await environmentsListCommand(opts);
    });

  environments
    .command('inspect <id>')
    .description('Print one environment and its config')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (id, opts) => {
      await environmentInspectCommand(id, opts);
    });

  environments
    .command('create')
    .description('Create an environment')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .requiredOption('--name <name>', 'Environment name')
    .option('--description <text>', 'Environment description')
    .option('--hosting-type <type>', 'One of cloud, local, or self_hosted')
    .option('--sandbox-provider <provider>', 'Sandbox backend to run sessions on')
    .option('--config-json <json>', 'Backend config as a JSON object')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (opts) => {
      await environmentCreateCommand(opts);
    });

  environments
    .command('update <id>')
    .description('Update an environment')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--name <name>', 'Environment name')
    .option('--description <text>', 'Environment description')
    .option('--hosting-type <type>', 'One of cloud, local, or self_hosted')
    .option('--sandbox-provider <provider>', 'Sandbox backend to run sessions on')
    .option('--config-json <json>', 'Backend config as a JSON object')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (id, opts) => {
      await environmentUpdateCommand(id, opts);
    });

  environments
    .command('archive <id>')
    .description('Archive an environment')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (id, opts) => {
      await environmentArchiveCommand(id, opts);
    });

  environments
    .command('worker-keys <id>')
    .description("List an environment's worker keys")
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--json', 'Print the raw response as JSON', false)
    .action(async (id, opts) => {
      await environmentWorkerKeysCommand(id, opts);
    });

  // The session CLI group. `docs/api-matrix.md:84` documents it as covered and
  // `src/cli/session-commands.ts` implements all five commands, but the module was
  // imported by nothing, so every one of them answered `unknown command 'session'`.
  const session = program.command('session').description('Create, message, tail, inspect and log sessions');

  session
    .command('create')
    .description('Create a session and print its id')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('-a, --agent <id>', 'Agent id (default: the first loaded agent). A session\'s agent is an id, not a name.')
    .option('-e, --environment <id>', 'Environment to run the session in')
    .option('-t, --title <title>', 'Session title')
    .action(async (opts) => {
      await sessionCreateCommand(opts);
    });

  session
    .command('message <sessionId>')
    .description('Send a user message to a session')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .requiredOption('-m, --message <text>', 'Message text to send')
    .option('--no-stream', 'Return as soon as the message is accepted instead of streaming the reply')
    .action(async (sessionId, opts) => {
      await sessionMessageCommand(sessionId, opts);
    });

  session
    .command('tail <sessionId>')
    .description('Stream a session event log (does not exit on its own)')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--last-event-id <id>', 'Resume after this event id instead of replaying from the start')
    .action(async (sessionId, opts) => {
      await sessionTailCommand(sessionId, opts);
    });

  session
    .command('inspect <sessionId>')
    .description('Print a session summary and its event count')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--json', 'Print the session and its events as JSON', false)
    .action(async (sessionId, opts) => {
      await sessionInspectCommand(sessionId, opts);
    });

  session
    .command('logs <sessionId>')
    .description('Print every recorded event in a session')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .action(async (sessionId, opts) => {
      await sessionLogsCommand(sessionId, opts);
    });

  // The workspace CLI group. `docs/api-matrix.md:88` documents it as covered and
  // `src/cli/workspace-commands.ts` implements it, but the module was imported by
  // nothing, so every command answered `unknown command 'workspace'`. Unlike the other
  // groups these commands talk to a local on-disk registry (`~/.managed-agents/
  // workspaces.json`, or `$MANAGED_AGENTS_HOME/workspaces.json`), not to a running
  // runtime, so they take no `--port` or `--api-key`.
  const workspace = program.command('workspace').description('Manage the local workspace registry');

  workspace
    .command('create <root>')
    .description('Create a workspace (directories plus config) and register it')
    .option('--name <name>', 'Display name (default: the directory basename)')
    .option('--data-dir <dir>', 'Runtime data directory for this workspace')
    .option('--json', 'Print the registry entry as JSON', false)
    .action((root, opts) => {
      workspaceCreateCommand(root, opts);
    });

  workspace
    .command('open <root>')
    .description('Register an existing workspace root without creating anything')
    .option('--name <name>', 'Display name (default: the directory basename)')
    .option('--data-dir <dir>', 'Runtime data directory for this workspace')
    .option('--json', 'Print the registry entry as JSON', false)
    .action((root, opts) => {
      workspaceOpenCommand(root, opts);
    });

  workspace
    .command('list')
    .description('List registered workspaces, most recently opened first')
    .option('--json', 'Print the registry entries as JSON', false)
    .action((opts) => {
      workspaceListCommand(opts);
    });

  workspace
    .command('resolve <id-or-name-or-root>')
    .description('Print one workspace and mark it as just opened')
    .option('--json', 'Print the registry entry as JSON', false)
    .action((value, opts) => {
      workspaceResolveCommand(value, opts);
    });

  workspace
    .command('remove <id-or-name-or-root>')
    .description('Remove a workspace from the registry (its files are left alone)')
    .action((value) => {
      workspaceRemoveCommand(value);
    });

  // The self-hosted worker CLI. Documented in `docs/deployment.md`, `docs/api.md`,
  // `docs/api-matrix.md` and the Console's environment setup step, but never wired
  // up here — so the documented command answered `unknown command 'worker'`.
  const worker = program.command('worker').description('Run a self-hosted environment worker');

  worker
    .command('poll')
    .description('Claim work items from the runtime and execute them inside --workdir')
    .option('-p, --port <port>', 'Server port to connect to', '3000')
    .option('-k, --api-key <key>', 'API key if the server has auth enabled')
    .option('--environment-id <id>', 'Environment to claim work for')
    .option(
      '--environment-key <key>',
      'Environment worker key (default: $MANAGED_AGENTS_ENVIRONMENT_KEY)',
    )
    .option('--worker-id <id>', 'Worker identity reported to the runtime (default: worker_<pid>)')
    .option('-w, --workdir <dir>', 'Directory work items are executed inside', '.')
    .option('--once', 'Claim and run at most one item, then exit', false)
    .option('--interval-ms <ms>', 'Delay between polls when the queue is empty', '1000')
    .option('--heartbeat-ms <ms>', 'Renew the claim on this interval while an item runs', '20000')
    .option(
      '--heartbeat-timeout-ms <ms>',
      'How long to wait for a renewal to be answered before reporting it as unconfirmed',
      '10000',
    )
    .option(
      '--ack-timeout-ms <ms>',
      'How long to wait for the runtime to confirm a claim before giving up on the item',
      '10000',
    )
    .action(async (opts) => {
      await workerPollCommand(opts);
    });

  const template = program.command('template').description('Manage solution templates');

  template
    .command('list')
    .description('List available templates in a local templates directory')
    .option('--repo <dir>', 'Templates directory', 'templates')
    .action((opts) => {
      const items = listTemplates(resolve(opts.repo));
      if (items.length === 0) {
        console.log('No templates found.');
        return;
      }
      for (const t of items) {
        console.log(`  ${t.name}  - ${t.description ?? ''}`);
      }
    });

  template
    .command('install <templateNameOrPath>')
    .description('Install a template into the current project (local path or remote name)')
    .option('--force', 'Overwrite existing files', false)
    .option('--repo <repo>', 'GitHub repo for remote templates (owner/name)')
    .action(async (nameOrPath: string, opts) => {
      try {
        const source = await resolveTemplateSource(nameOrPath, {
          repo: opts.repo,
          cacheDir: defaultTemplateCacheDir(),
        });
        const result = installTemplate(source, process.cwd(), { force: opts.force });
        console.log(`Installed ${result.installed.length} file(s).`);
        for (const f of result.installed) console.log(`  + ${f}`);
        if (result.skipped.length > 0) {
          console.log(`Skipped ${result.skipped.length} existing file(s) (use --force to overwrite):`);
          for (const f of result.skipped) console.log(`  - ${f}`);
        }
      } catch (err: any) {
        console.error(`Error: [TEMPLATE_INSTALL] ${err.message}`);
        process.exit(1);
      }
    });

  template
    .command('create <name>')
    .description('Export the current project (agents/skills) as a template')
    .option('-o, --out <dir>', 'Output template directory')
    .option('-d, --description <text>', 'Template description', '')
    .action((name: string, opts) => {
      try {
        const out = resolve(opts.out ?? join('templates', name));
        const result = createTemplate(process.cwd(), out, { name, description: opts.description });
        console.log(`Created template "${name}" at ${out} (${result.files.length} files).`);
      } catch (err: any) {
        console.error(`Error: [TEMPLATE_CREATE] ${err.message}`);
        process.exit(1);
      }
    });

  return program;
}

function initProject() {
  const cwd = process.cwd();

  if (existsSync(join(cwd, 'agents'))) {
    console.error('Error: [INIT] agents/ directory already exists. Use a clean directory.');
    process.exit(1);
  }

  mkdirSync(join(cwd, 'agents'), { recursive: true });
  mkdirSync(join(cwd, 'skills'), { recursive: true });

  writeFileSync(
    join(cwd, 'agents', 'assistant.yaml'),
    `name: assistant
model: gpt-4o
system: |
  You are a helpful assistant. Answer questions clearly and concisely.
skills:
  - type: custom
    skill_id: skill_example-skill
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
    configs:
      - name: read
        enabled: true
      - name: write
        enabled: true
      - name: bash
        enabled: true
        permission_policy:
          type: always_ask
max_turns: 25
temperature: 0.7
`,
  );

  mkdirSync(join(cwd, 'skills', 'example-skill'), { recursive: true });
  writeFileSync(
    join(cwd, 'skills', 'example-skill', 'SKILL.md'),
    `---
name: example-skill
description: An example skill showing the SKILL.md format
---

# Example Skill

Replace this with real instructions. Skills are injected into the agent's
system instructions so the model knows the capability up-front.
`,
  );

  mkdirSync(join(cwd, WORKSPACE_STATE_DIR), { recursive: true });
  writeFileSync(
    defaultConfigPath(cwd),
    `# managed-agents configuration
model:
  provider: openai
  api_key: \${OPENAI_API_KEY}

storage:
  metadata:
    provider: sqlite
    options: {}
  artifacts:
    provider: local
    options:
      base_path: files

environments:
  local:
    sandbox_provider: local
    timeout: 300
`,
  );

  console.log('Initialized managed-agents project:');
  console.log('  agents/assistant.yaml');
  console.log('  skills/');
  console.log(`  ${WORKSPACE_STATE_DIR}/config.yaml`);
  console.log('\nNext: start the runtime, then add a model provider in Dashboard Settings > Models:');
  console.log('  managed-agents start');
  if (process.argv[1]) {
    console.log(`  # source checkout: node ${process.argv[1]} start`);
  }
}

async function chatCommand(
  agentArg: string | undefined,
  opts: { port: string; message?: string; apiKey?: string },
) {
  const { ManagedAgentsClient } = await import('../sdk/client.js');
  const client = new ManagedAgentsClient({
    baseUrl: `http://localhost:${opts.port}`,
    apiKey: opts.apiKey,
  });

  let agent = agentArg;
  try {
    if (!agent) {
      const { data } = await client.agents.list();
      if (data.length === 0) {
        console.error('Error: [CHAT] No agents loaded on the server.');
        process.exit(1);
      }
      agent = data[0].id;
    }
  } catch {
    console.error(`Error: [CHAT] Cannot connect to server on port ${opts.port}`);
    console.error(`  -> Start it with: managed-agents start --port ${opts.port}`);
    process.exit(1);
  }

  const session = await client.sessions.create({ agent: agent! });
  console.log(`Chatting with "${agent}" (session ${session.id}). Ctrl+C to exit.\n`);

  const streamReply = async (text: string) => {
    for await (const ev of client.sessions.chat(session.id, text)) {
      if (ev.type === 'agent.message_chunk') process.stdout.write(ev.delta ?? '');
      else if (ev.type === 'agent.tool_use' || ev.type === 'agent.mcp_tool_use') {
        const b = (ev.content ?? [])[0] as any;
        process.stdout.write(`\n  -> tool: ${b?.name ?? '?'}\n`);
      }
    }
    process.stdout.write('\n');
  };

  if (opts.message) {
    await streamReply(opts.message);
    return;
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question('you> ', async (line) => {
      const text = line.trim();
      if (!text) return ask();
      process.stdout.write('agent> ');
      try {
        await streamReply(text);
      } catch (err: any) {
        console.error(`\nError: [CHAT] ${err.message}`);
      }
      ask();
    });
  ask();
}

async function listAgents(opts: { port: string }) {
  try {
    const res = await fetch(`http://localhost:${opts.port}/v1/agents`);
    if (!res.ok) {
      console.error(`Error: [LIST] Server returned ${res.status}`);
      process.exit(1);
    }
    const body = await res.json() as any;
    if (body.data.length === 0) {
      console.log('No agents loaded.');
      return;
    }
    console.log('Loaded agents:\n');
    for (const agent of body.data) {
      console.log(`  ${agent.id}  ${agent.name}  (model: ${agent.model}, status: ${agent.status})`);
    }
  } catch {
    console.error(`Error: [LIST] Cannot connect to server on port ${opts.port}`);
    console.error(`  -> Is the server running? Start with: managed-agents start --port ${opts.port}`);
    process.exit(1);
  }
}

async function reloadAgents(opts: { port: string }) {
  try {
    const res = await fetch(`http://localhost:${opts.port}/v1/x/reload`, { method: 'POST' });
    if (!res.ok) {
      console.error(`Error: [RELOAD] Server returned ${res.status}`);
      process.exit(1);
    }
    const body = await res.json() as any;
    console.log(`Reloaded: ${body.agents_loaded} agents loaded.`);
    if (body.errors?.length > 0) {
      console.log('Errors:');
      for (const err of body.errors) {
        console.log(`  ${err.file}: ${err.reason}`);
      }
    }
  } catch {
    console.error(`Error: [RELOAD] Cannot connect to server on port ${opts.port}`);
    console.error(`  -> Is the server running? Start with: managed-agents start --port ${opts.port}`);
    process.exit(1);
  }
}
