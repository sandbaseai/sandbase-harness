import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('leaves a lease that another owner has taken over in place', async () => {
    // The other half of the same refusal: release removes only a lease that still
    // names this owner. A lease can legitimately belong to somebody else by the time
    // a late release runs - this owner was declared stale, another owner recovered it
    // through the rename, and this one is only now cleaning up. Removing it would
    // cancel the exclusion the *new* owner is relying on. The cases above never see
    // this branch: they always release a lease whose owner id still matches, or one
    // that cannot be read at all.
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-taken-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 60_000 });
    const takeover = {
      version: 1 as const,
      ownerId: 'owner-b',
      pid: 4242,
      host: 'other-host',
      acquiredAt: new Date(2_000).toISOString(),
      heartbeatAt: new Date(2_000).toISOString(),
      expiresAt: new Date(62_000).toISOString(),
    };
    writeFileSync(`${sessionFile}.lease`, JSON.stringify(takeover));

    await first.release();

    // The file survives, and it is still the new owner's record - not a leftover.
    expect(existsSync(`${sessionFile}.lease`)).toBe(true);
    await expect(acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-c', now: () => 3_000, staleAfterMs: 60_000 }))
      .rejects.toMatchObject({ code: 'pi_session_busy', owner: { ownerId: 'owner-b' } });
  });

  it('stops renewing on suspendHeartbeat but keeps the lease', async () => {
    // suspendHeartbeat carries the contract "Stop heartbeats without deleting the
    // lease when cleanup ownership is unknown", and the launcher calls it when a
    // cleanup is still pending, so the lease has to outlive the heartbeat. Neither
    // half was exercised anywhere: the suite never called it, and a grep of the whole
    // test tree found no reference to it at all.
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-suspend-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const leasePath = `${sessionFile}.lease`;
    // A second is the shortest heartbeat interval the module will use, so the clock
    // is advanced past it to make a still-running heartbeat visible in the file.
    let clock = 1_000;
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => clock, staleAfterMs: 1_000 });
    const before = JSON.parse(readFileSync(leasePath, 'utf8')) as { heartbeatAt: string; expiresAt: string };

    first.suspendHeartbeat();
    clock = 50_000;
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    // The file itself is checked before it is read, so a suspend that withdrew the
    // lease is reported as that rather than surfacing as an ENOENT from a read.
    expect(existsSync(leasePath)).toBe(true);
    // Half one: no further renewal was written. (This can only fail if a heartbeat
    // really did run after the suspend, so the wait cannot produce a false failure.)
    const after = JSON.parse(readFileSync(leasePath, 'utf8')) as { heartbeatAt: string; expiresAt: string };
    expect(after.heartbeatAt).toBe(before.heartbeatAt);
    expect(after.expiresAt).toBe(before.expiresAt);
    // Half two: suspending is not releasing - the lease is still live at a time
    // before its expiry, and still refusing another owner.
    await expect(acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 1_500, staleAfterMs: 60_000 }))
      .rejects.toMatchObject({ code: 'pi_session_busy' } satisfies Partial<PiSessionBusyError>);
  });
});
