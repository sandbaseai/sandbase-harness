/**
 * Integration test: the credential-secret envelope's security properties.
 *
 * `src/core/security/secrets.ts` picks AES-256-GCM, and the repository already
 * asserts the parts a round trip can see: the three stored columns are truthy,
 * the ciphertext does not literally contain the plaintext, and rotation changes
 * the ciphertext. Those are **symmetric** claims — they hold for an
 * unauthenticated stream cipher too, and they hold for a fixed nonce.
 *
 * Three properties make the envelope a credential boundary rather than an
 * encoding, and none of them is asserted anywhere:
 *
 * - **Authentication.** GCM authenticates the ciphertext, the nonce *and* the
 *   tag. Tampering with any of the three must refuse, not return wrong bytes.
 *   With an unauthenticated mode every existing assertion would still pass while
 *   a tampered credential silently decrypted to garbage the runtime would then
 *   inject into a session.
 * - **Nonce uniqueness.** Reusing a GCM nonce under the same key breaks the mode
 *   catastrophically, so two encryptions of the same plaintext must differ in
 *   both the nonce and the ciphertext.
 * - **Workspace binding.** The key comes from `<dataDir>/secrets.key`, created
 *   once at mode 0600 and then reused. If it were regenerated per call, every
 *   round trip in a single process would still pass and every credential stored
 *   by an earlier process would become undecryptable.
 *
 * Each case carries its own control on the untampered value, so a failure says
 * "tampering was accepted" rather than "decryption is broken here".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret, resolveSecretKeyMaterial } from '@/core/security/secrets.js';

const PLAINTEXT = 'sk-live-credential-value';

/** Flip one bit in a base64 field, keeping it a decodable value of the same length. */
function flipByte(encoded: string): string {
  const bytes = Buffer.from(encoded, 'base64');
  bytes[0] = bytes[0] ^ 0x01;
  return bytes.toString('base64');
}

describe('Credential secret envelope semantics', () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let savedKey: string | undefined;

  beforeAll(() => {
    // The environment key takes precedence over `dataDir`; the workspace-binding
    // cases are about the data-directory path, so they run without it.
    savedKey = process.env.MANAGED_AGENTS_SECRET_KEY;
    delete process.env.MANAGED_AGENTS_SECRET_KEY;
    tmpDirA = mkdtempSync(join(tmpdir(), 'ma-secret-a-'));
    tmpDirB = mkdtempSync(join(tmpdir(), 'ma-secret-b-'));
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env.MANAGED_AGENTS_SECRET_KEY = savedKey;
    rmSync(tmpDirA, { recursive: true, force: true });
    rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('refuses a delivery whose ciphertext byte was flipped', () => {
    const secret = encryptSecret(PLAINTEXT, tmpDirA);
    expect(decryptSecret(secret, tmpDirA)).toBe(PLAINTEXT);

    const tampered = { ...secret, ciphertext: flipByte(secret.ciphertext) };
    expect(() => decryptSecret(tampered, tmpDirA)).toThrow();
  });

  it('refuses a secret whose authentication tag was flipped', () => {
    const secret = encryptSecret(PLAINTEXT, tmpDirA);
    expect(decryptSecret(secret, tmpDirA)).toBe(PLAINTEXT);

    const tampered = { ...secret, tag: flipByte(secret.tag) };
    expect(() => decryptSecret(tampered, tmpDirA)).toThrow();
  });

  it('refuses a secret whose nonce was flipped', () => {
    const secret = encryptSecret(PLAINTEXT, tmpDirA);
    expect(decryptSecret(secret, tmpDirA)).toBe(PLAINTEXT);

    const tampered = { ...secret, nonce: flipByte(secret.nonce) };
    expect(() => decryptSecret(tampered, tmpDirA)).toThrow();
  });

  it('never repeats a nonce or a ciphertext for the same plaintext', () => {
    const first = encryptSecret(PLAINTEXT, tmpDirA);
    const second = encryptSecret(PLAINTEXT, tmpDirA);

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    // Both remain readable, so uniqueness is not coming from a broken envelope.
    expect(decryptSecret(first, tmpDirA)).toBe(PLAINTEXT);
    expect(decryptSecret(second, tmpDirA)).toBe(PLAINTEXT);
  });

  it('binds the ciphertext to the workspace that wrote it', () => {
    const secret = encryptSecret(PLAINTEXT, tmpDirA);
    const other = encryptSecret(PLAINTEXT, tmpDirB);

    expect(other.ciphertext).not.toBe(secret.ciphertext);
    // Another workspace's key must not open it, and the refusal is the property:
    // a shared process-wide key would make this succeed.
    expect(() => decryptSecret(secret, tmpDirB)).toThrow();
    expect(decryptSecret(secret, tmpDirA)).toBe(PLAINTEXT);
  });

  it('creates the workspace key once and keeps using it', () => {
    const keyPath = join(tmpDirA, 'secrets.key');
    const before = resolveSecretKeyMaterial(tmpDirA);
    expect(existsSync(keyPath)).toBe(true);
    const onDisk = readFileSync(keyPath, 'utf8');

    // A credential written before the second resolution has to survive it.
    const written = encryptSecret(PLAINTEXT, tmpDirA);

    expect(resolveSecretKeyMaterial(tmpDirA)).toEqual(before);
    expect(readFileSync(keyPath, 'utf8')).toBe(onDisk);
    expect(decryptSecret(written, tmpDirA)).toBe(PLAINTEXT);

    // A workspace that has never been used gets its own key material.
    expect(resolveSecretKeyMaterial(tmpDirB)).not.toEqual(before);
  });

  it('stores the workspace key with owner-only permissions', () => {
    const keyPath = join(tmpDirA, 'secrets.key');
    const contents = readFileSync(keyPath, 'utf8');

    expect(contents.trim()).not.toBe('');
    // Windows reports synthesized modes, so the permission bits are only
    // meaningful where the platform implements them.
    if (process.platform !== 'win32') {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(keyPath).isFile()).toBe(true);
    }
    // The key material must never be the plaintext of anything it protects.
    expect(contents).not.toContain(PLAINTEXT);
  });
});
