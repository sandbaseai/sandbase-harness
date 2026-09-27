import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePiSessionFileLease, PiSessionBusyError } from '@/strategy/pi/session-lease.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Pi session-file lease', () => {
  it('rejects a live concurrent owner and removes its lease on release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 10_000 });

    await expect(acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 2_000, staleAfterMs: 10_000 }))
      .rejects.toMatchObject({ code: 'pi_session_busy' } satisfies Partial<PiSessionBusyError>);
    expect(existsSync(`${sessionFile}.lease`)).toBe(true);
    await first.release();
    expect(existsSync(`${sessionFile}.lease`)).toBe(false);
  });

  it('recovers an expired owner through an atomic stale rename', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-stale-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 10 });
    const recovered = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 2_000, staleAfterMs: 10 });

    expect(recovered.recoveredStale).toBe(true);
    await first.release();
    await recovered.release();
    expect(existsSync(`${sessionFile}.lease`)).toBe(false);
  });

  it('leaves an unreadable lease in place rather than removing it on release', async () => {
    // Release proves ownership by reading the lease back and comparing the owner
    // id, and refuses to remove what it cannot read: "Never remove an unreadable
    // lease: ownership cannot be proven." The case above only ever releases its own
    // intact lease, so it exercises the branch that does remove. The refusal is the
    // one that keeps exclusion, and it is only reachable through a lease that has
    // been written over - which is what a concurrent owner, a partial write or a
    // crash can leave behind.
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-unreadable-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 60_000 });
    writeFileSync(`${sessionFile}.lease`, 'not a lease record');

    await first.release();

    expect(existsSync(`${sessionFile}.lease`)).toBe(true);
    // And the exclusion it was holding is still real.
    await expect(acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 2_000, staleAfterMs: 60_000 }))
      .rejects.toMatchObject({ code: 'pi_session_busy' } satisfies Partial<PiSessionBusyError>);
  });
});
