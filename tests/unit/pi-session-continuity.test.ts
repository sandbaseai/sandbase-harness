import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import {
  PI_POLICY_MISMATCH_CODE,
  assertPiSessionContinuity,
  getPiSessionState,
  inspectPiSessionFile,
  recordPiSessionState,
} from '@/strategy/pi/session-continuity.js';
import { piPolicyFingerprint } from '@/strategy/pi/rpc-wire.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';

const directories: string[] = [];
afterEach(() => {
  // A Pi child that is still exiting can hold files in the directory on
  // Windows; retry briefly instead of failing the next test on EPERM.
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ma-pi-continuity-'));
  directories.push(directory);
  const db = new Database(join(directory, 'data.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
  const session = 'sess_pi_continuity';
  db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine) VALUES ('${session}', 'agent_pi', 'pi-agent', 'env_default', 'paused', '[]', '[]', 'pi')`);
  return { db, directory, session, file: join(directory, 'session.jsonl') };
}

describe('Pi session continuity state', () => {
  it('accepts a new empty file, then requires matching SQLite state for resume', () => {
    const value = setup();
    writeFileSync(value.file, '');
    expect(assertPiSessionContinuity(value.db, value.session, value.file)).toEqual({});

    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('without matching SandBase continuity state');
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' });
    expect(assertPiSessionContinuity(value.db, value.session, value.file).state).toMatchObject({ piSessionId: 'pi-1', schemaVersion: '1', status: 'active' });
    expect(getPiSessionState(value.db, value.session)?.sessionFile).toBe(value.file);
    value.db.close();
  });

  it('rejects a changed header identity, schema, and malformed header', () => {
    const value = setup();
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' });

    writeFileSync(value.file, '{"type":"session","id":"pi-2","version":1}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('identity or schema');
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":2}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('identity or schema');
    writeFileSync(value.file, '{"type":"not-session","id":"pi-1"}\n');
    expect(() => inspectPiSessionFile(value.file)).toThrow('missing type=session');
    value.db.close();
  });

  it('refuses a resume whose work directory or policy is not the recorded one', () => {
    const value = setup();
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    const binding = { workDir: join(value.directory, 'work'), policyFingerprint: 'fingerprint-a' };
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' }, 'active', undefined, binding);

    // The recorded contract is what is compared, and reproducing it resumes.
    expect(assertPiSessionContinuity(value.db, value.session, value.file, binding).state?.status).toBe('active');

    // A different directory names the directory, not a generic discontinuity:
    // the caller has to know which half of the contract it has to repair.
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file, {
      ...binding,
      workDir: join(value.directory, 'elsewhere'),
    })).toThrow(expect.objectContaining({
      code: PI_POLICY_MISMATCH_CODE,
      message: expect.stringContaining('work directory'),
    }));

    // And a different policy names the policy.
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file, {
      ...binding,
      policyFingerprint: 'fingerprint-b',
    })).toThrow(expect.objectContaining({
      code: PI_POLICY_MISMATCH_CODE,
      message: expect.stringContaining('tool policy'),
    }));

    // A resume that cannot state its contract at all is not the recorded one
    // either, so it is refused rather than assumed to match.
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file))
      .toThrow(expect.objectContaining({ code: PI_POLICY_MISMATCH_CODE }));
    value.db.close();
  });

  it('resumes a row recorded before the binding existed, which has nothing to compare', () => {
    const value = setup();
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    // The shape a pre-M041 row has: identity and status, no recorded binding.
    value.db.prepare(`
      INSERT INTO pi_session_state (session_id, session_file, pi_session_id, schema_version, status)
      VALUES (?, ?, 'pi-1', '1', 'active')
    `).run(value.session, value.file);

    const state = getPiSessionState(value.db, value.session);
    expect(state?.workDir).toBeUndefined();
    expect(state?.policyFingerprint).toBeUndefined();

    // Nothing to compare means nothing to refuse: the session continues, and the
    // upgraded runtime does not invent a contract the earlier turns never had.
    const asserted = assertPiSessionContinuity(value.db, value.session, value.file, {
      workDir: join(value.directory, 'work'),
      policyFingerprint: 'fingerprint-a',
    });
    expect(asserted.state?.piSessionId).toBe('pi-1');
    value.db.close();
  });

  it('treats a re-ordered equivalent policy as the same contract, and keeps a recorded binding', () => {
    const value = setup();
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    const policy = {
      allow: ['read', 'bash'],
      gate: ['bash'],
      denied: ['write'],
      exposeNoTools: false,
      model: 'fixture-model',
      provider: 'openai',
      workDir: join(value.directory, 'work'),
      approvalMode: 'interactive' as const,
    };
    const recorded = piPolicyFingerprint(policy);

    // A re-ordering is the same plan, so it is the same contract; hashing it
    // differently would refuse a resume that reproduces what it ran under.
    expect(piPolicyFingerprint({ ...policy, allow: ['bash', 'read'] })).toBe(recorded);
    expect(piPolicyFingerprint({ ...policy, gate: ['bash'] })).toBe(recorded);
    // Everything else that changes the contract does change the digest.
    expect(piPolicyFingerprint({ ...policy, denied: [] })).not.toBe(recorded);
    expect(piPolicyFingerprint({ ...policy, approvalMode: 'preauthorized_once' })).not.toBe(recorded);
    expect(piPolicyFingerprint({ ...policy, model: 'other-model' })).not.toBe(recorded);
    expect(piPolicyFingerprint({ ...policy, workDir: join(value.directory, 'other') })).not.toBe(recorded);

    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' }, 'active', undefined, {
      workDir: policy.workDir,
      policyFingerprint: recorded,
    });
    expect(assertPiSessionContinuity(value.db, value.session, value.file, {
      workDir: policy.workDir,
      policyFingerprint: piPolicyFingerprint({ ...policy, allow: ['bash', 'read'] }),
    }).state?.policyFingerprint).toBe(recorded);

    // A later turn that states the identity but not the contract leaves the
    // recorded binding in place rather than erasing what the session ran under.
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' });
    expect(getPiSessionState(value.db, value.session)).toMatchObject({
      workDir: policy.workDir,
      policyFingerprint: recorded,
      status: 'active',
    });
    value.db.close();
  });

  it('proves repeated launcher turns share one managed file and reject a concurrent writer', async () => {
    const value = setup();
    const script = join(value.directory, 'controlled-pi.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf('--session') + 1];
if (args[args.indexOf('--thinking') + 1] !== 'medium' || !args.includes('--skill')) process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'pi-real-fixture', version: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'session', id: 'pi-real-fixture', version: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
  setTimeout(() => process.exit(0), 100);
});
`);
    const launcher = new PiLauncher({
      dataDir: value.directory,
      database: value.db,
      command: process.execPath,
      commandArgs: [script],
      // Generous budgets: under a loaded Windows process table the spawn alone
      // can approach 2s, and taskkill /T tree teardown can outlast a 100ms
      // deadline. Neither timer binds on the happy path — the fixture exits on
      // its own ~100ms after the prompt.
      timeoutMs: 15_000,
      cleanupTimeoutMs: process.platform === 'win32' ? 10_000 : 1_000,
    });
    const request = {
      sessionId: value.session,
      workDir: value.directory,
      prompt: '多行\\nUnicode ✓',
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      skillDirs: [value.directory] as string[],
      thinkingLevel: 'medium' as const,
    };

    const first = await launcher.start(request);
    await first.wait();
    const sessionFile = join(value.directory, 'pi-sessions', `${value.session}.jsonl`);
    recordPiSessionState(value.db, value.session, sessionFile, { id: 'pi-real-fixture', schemaVersion: '1' });

    const second = await launcher.start(request);
    await second.wait();
    expect(getPiSessionState(value.db, value.session)).toMatchObject({ piSessionId: 'pi-real-fixture', status: 'active' });

    const held = await launcher.start(request);
    await expect(launcher.start(request)).rejects.toMatchObject({ code: 'pi_session_busy' });
    await held.wait();
    value.db.close();
  });
});
