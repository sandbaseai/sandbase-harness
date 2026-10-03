/**
 * Integration test: the documented `managed-agents environments ...` group works.
 *
 * `docs/api-matrix.md:87` documents the group as covered — "List, inspect, create, update,
 * archive, and list worker keys" — and `src/cli/runtime-management-commands.ts` implements
 * it, but the module was imported by nothing, so every command answered
 * `unknown command 'environments'`.
 *
 * Each command is driven against the **real** routes over a real HTTP listener and a real
 * SQLite file, because a registered command can still be wrong about the wire contract.
 * That is not hypothetical: the sibling `settings` group in the same module is registered
 * from the same place and all three of its commands fail against the real API (#466) —
 * two on a response shape taken from a type no route produces, and one on a verb the route
 * does not mount. Every assertion below is therefore on data the runtime produced, and
 * every write is read back through a different call than the one that wrote it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import {
  environmentArchiveCommand,
  environmentCreateCommand,
  environmentInspectCommand,
  environmentUpdateCommand,
  environmentWorkerKeysCommand,
  environmentsListCommand,
} from '@/cli/runtime-management-commands.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };

/** Run `fn` with console.log captured, so each command's output is assertable. */
async function capture<T>(fn: () => Promise<T>): Promise<{ stdout: string; log: string[] }> {
  const log: string[] = [];
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { stdout: chunks.join(''), log };
}

describe('environments CLI group', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  /** A real runtime on a real port. No environments are seeded: the CLI creates them. */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-env-cli-'));
    tmpDir = dir;
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();

    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as RealServer;
        resolve(info.port);
      });
    });

    return { app, port, env: { port: String(port) } };
  }

  async function listEnvironments(app: ReturnType<typeof createServer>) {
    const res = await app.request('/v1/environments');
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return (JSON.parse(text) as { data: Array<Record<string, unknown>> }).data;
  }

  /** Seed an environment through the API rather than through the command under test. */
  async function createEnvironment(
    app: ReturnType<typeof createServer>,
    body: Record<string, unknown>,
  ): Promise<{ id: string; name: string }> {
    const res = await app.request('/v1/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    expect(res.status, text).toBe(201);
    return JSON.parse(text) as { id: string; name: string };
  }

  it('creates an environment and prints the row the runtime stored', async () => {
    const { app, port } = await startRuntime();

    const { log } = await capture(() =>
      environmentCreateCommand({ port: String(port), name: 'staging', description: 'Build box' }));

    const printed = log.join('\n');
    expect(printed).toContain('Created environment:');
    // The printed line is the runtime's own projection, so the id in it must be a row the
    // listing also returns — otherwise the command could be printing a client-side echo.
    const listed = await listEnvironments(app);
    const created = listed.find((item) => item.name === 'staging');
    expect(created).toBeDefined();
    expect(printed).toContain(created!.id as string);
    expect(created!.description).toBe('Build box');
  });

  it('sends hosting-type and sandbox-provider to the backend the runtime validates', async () => {
    // The route reads `hosting_type` and `sandbox_provider` either at the top level or
    // inside `config` (`environments.ts:269-271`) and refuses a backend this runtime cannot
    // run on. A `local` environment is the one every host can serve, so this asserts the
    // value round-trips rather than only that the request was accepted.
    const { app, port } = await startRuntime();

    await capture(() => environmentCreateCommand({
      port: String(port),
      name: 'plain',
      hostingType: 'local',
      sandboxProvider: 'local',
      configJson: '{"custom":"value"}',
    }));

    const created = (await listEnvironments(app)).find((item) => item.name === 'plain');
    expect(created).toBeDefined();
    expect((created!.config as Record<string, unknown>).hosting_type).toBe('local');
    expect(created!.effective_sandbox_provider).toBe('local');

    // Read back through the single-resource route, which is a different handler than the
    // listing, so the config is confirmed to be persisted rather than projected.
    const detail = await app.request(`/v1/environments/${created!.id as string}`);
    const detailBody = await detail.json() as { config: Record<string, unknown> };
    expect(detail.status).toBe(200);
    expect(detailBody.config.custom).toBe('value');
    expect(detailBody.config.hosting_type).toBe('local');
  });

  it('lists environments, and says so plainly when there are none', async () => {
    const { app, port } = await startRuntime();

    const empty = await capture(() => environmentsListCommand({ port: String(port) }));
    expect(empty.log.join('\n')).toContain('No environments configured.');

    await capture(() => environmentCreateCommand({ port: String(port), name: 'one' }));
    await capture(() => environmentCreateCommand({ port: String(port), name: 'two' }));

    const listed = await capture(() => environmentsListCommand({ port: String(port) }));
    const text = listed.log.join('\n');
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(text).not.toContain('No environments configured.');
    // One line per environment, which is what makes the output pipeable.
    expect(listed.log.filter((line) => line.includes('sandbox=')).length).toBe(2);
    expect(app).toBeDefined();
  });

  it('inspects one environment and prints its config', async () => {
    const { app, port } = await startRuntime();
    const created = await createEnvironment(app, { name: 'inspectable', config: { custom: 'deep' } });

    const human = await capture(() => environmentInspectCommand(created.id, { port: String(port) }));
    const text = human.log.join('\n');
    expect(text).toContain(created.id);
    expect(text).toContain('inspectable');
    expect(text).toContain('config:');
    expect(text).toContain('deep');

    const json = await capture(() => environmentInspectCommand(created.id, { port: String(port), json: true }));
    const parsed = JSON.parse(json.log.join('\n')) as { id: string; name: string };
    expect(parsed.id).toBe(created.id);
    expect(parsed.name).toBe('inspectable');
  });

  it('updates an environment without clearing the fields it did not send', async () => {
    // The route merges the patch over the stored config (`environments.ts:265-268`), so an
    // update that names only one field must not drop the others. Asserted because the
    // command sends the connection options and the patch in one object, where an
    // accidentally-included key would be a silent overwrite.
    const { app, port } = await startRuntime();
    const created = await createEnvironment(app, {
      name: 'before',
      description: 'kept',
      config: { custom: 'kept' },
    });

    const { log } = await capture(() =>
      environmentUpdateCommand(created.id, { port: String(port), name: 'after' }));

    expect(log.join('\n')).toContain('Updated environment:');
    const detail = await app.request(`/v1/environments/${created.id}`);
    const body = await detail.json() as {
      name: string;
      description: string;
      config: Record<string, unknown>;
    };
    expect(body.name).toBe('after');
    expect(body.description).toBe('kept');
    expect(body.config.custom).toBe('kept');
  });

  it('archives an environment, and the archived row is what the archive call returned', async () => {
    const { app, port } = await startRuntime();
    const create = (name: string) => createEnvironment(app, { name });

    const doomed = await create('doomed');
    const doomedJson = await create('doomed-json');

    const { log } = await capture(() => environmentArchiveCommand(doomed.id, { port: String(port) }));
    expect(log.join('\n')).toContain(`Archived environment: ${doomed.id} (doomed)`);

    // The archive call answers with the archived row itself, so `archived_at` is on the
    // response the command already has. Asserting it through `--json` checks the row the
    // route produced rather than only the sentence the command printed from it.
    const asJson = await capture(() =>
      environmentArchiveCommand(doomedJson.id, { port: String(port), json: true }));
    const archivedRow = JSON.parse(asJson.log.join('\n')) as { archived_at: string | null };
    expect(archivedRow.archived_at).not.toBeNull();

    // Archiving is terminal for the single-resource read and hides the row from the
    // listing — the same rule vaults and memory stores already follow, so an archived
    // Environment is not silently still usable.
    const detail = await app.request(`/v1/environments/${doomed.id}`);
    expect(detail.status).toBe(404);
    const listedIds = (await listEnvironments(app)).map((item) => item.id);
    expect(listedIds).not.toContain(doomed.id);
    expect(listedIds).not.toContain(doomedJson.id);

    // Archiving twice is refused rather than repeated, which is shared behavior of the
    // `archiveResource` helper all archive routes use. Recorded because it constrains how
    // the route may be called — a caller cannot use a second archive as a read-back.
    const again = await app.request(`/v1/environments/${doomed.id}/archive`, { method: 'POST' });
    expect(again.status).toBe(404);
  });

  it('lists an environment worker keys, including the key the API issued', async () => {
    const { app, port } = await startRuntime();
    const created = await createEnvironment(app, { name: 'workers' });

    const empty = await capture(() => environmentWorkerKeysCommand(created.id, { port: String(port) }));
    expect(empty.log.join('\n')).toContain('No worker keys for this environment.');

    // Issue a key through the API (the CLI does not create keys; the coverage table says
    // "list worker keys"), so the listing has a real row whose fields it must project.
    const issued = await app.request(`/v1/environments/${created.id}/worker-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fde-laptop' }),
    });
    const issuedText = await issued.text();
    expect(issued.status, issuedText).toBe(201);
    const issuedBody = JSON.parse(issuedText) as { id: string; key_prefix: string };
    // The secret is returned once, at creation, and must never appear in a listing.
    const secret = (JSON.parse(issuedText) as { secret_key?: string }).secret_key;
    expect(secret).toBeTruthy();

    const listed = await capture(() => environmentWorkerKeysCommand(created.id, { port: String(port) }));
    const text = listed.log.join('\n');
    expect(text).toContain(issuedBody.id);
    expect(text).toContain(issuedBody.key_prefix);
    expect(text).toContain('fde-laptop');
    expect(text).not.toContain('No worker keys for this environment.');
    // The listing route returns `key_prefix` and status only; a secret leaking into a list
    // response would be the serious version of this defect.
    expect(text).not.toContain(secret!);
  });

  it('refuses an unparseable --config-json before making a request', async () => {
    // A malformed JSON blob is a local mistake. Refusing it locally means the operator is
    // told which option is wrong instead of receiving a server-side "config must be an
    // object" that does not name `--config-json`.
    const { app, port } = await startRuntime();

    const refusal = await capture(() => environmentCreateCommand({
      port: String(port),
      name: 'bad',
      configJson: 'not json',
    })).then(() => undefined, (error: { message?: string }) => error);

    expect(refusal).toBeDefined();
    expect(refusal!.message).toContain('--config-json');
    // Nothing was created: a refused config must not leave a half-built environment behind.
    expect(await listEnvironments(app)).toEqual([]);
  });

  it('refuses a JSON array or scalar as --config-json', async () => {
    // `JSON.parse('[]')` succeeds, so a shape check is required on top of the parse; an
    // array spread into the config object would silently become numeric keys.
    const { app, port } = await startRuntime();

    for (const configJson of ['[]', '"text"', '7', 'null']) {
      const refusal = await capture(() => environmentCreateCommand({
        port: String(port),
        name: 'bad',
        configJson,
      })).then(() => undefined, (error: { message?: string }) => error);
      expect(refusal, `expected ${configJson} to be refused`).toBeDefined();
      expect(refusal!.message).toContain('--config-json must be a JSON object');
    }
    expect(await listEnvironments(app)).toEqual([]);
  });

  it('requires --name for create', async () => {
    // `requiredString` is the module's own guard, and reaching it without a name proves the
    // registration passes the option through rather than defaulting it.
    const { app, port } = await startRuntime();

    const refusal = await capture(() => environmentCreateCommand({
      port: String(port),
      name: undefined as unknown as string,
    })).then(() => undefined, (error: { message?: string }) => error);

    expect(refusal).toBeDefined();
    expect(refusal!.message).toContain('name is required');
    expect(await listEnvironments(app)).toEqual([]);
  });
});
