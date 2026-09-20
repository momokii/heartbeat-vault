/**
 * Heartbeat Vault — Crypto Known-Answer + Differential + Tamper Vectors (T2.5)
 *
 * Sources labeled per vector. Where a pinned vector would require memory-perfect
 * recall, a cross-implementation differential is used instead (never fabricated).
 *
 * - XChaCha20-Poly1305: IETF draft via @noble/ciphers (Cure53) vs libsodium
 *   crypto_aead_xchacha20poly1305_ietf_* (libsodium 1.0.18). No pinned IETF vector
 *   fetched from network — differential only.
 * - HKDF-SHA256: RFC 5869 §A.1 Test Case 1 (IKM=0x0b*22, salt=000102..0c,
 *   info=f0..f9, L=42 → OKM=3cb25f…865) — pinned KAT verified against RFC. Also
 *   differential noble vs node:crypto hkdfSync.
 * - HMAC-SHA256: RFC 4231 §4.2 Test Case 1 (key=0x0b*20, data="Hi There" →
 *   b0344c61…) — pinned KAT verified against RFC. Also differential noble vs
 *   node:crypto createHmac.
 * - Argon2id: PHC format verification. Primary path: @node-rs/argon2 hash/verify.
 *   Cross-impl attempt: @node-rs/argon2 → libsodium crypto_pwhash_str_verify.
 *   NOTE: libsodium-wrappers 0.8.4 does not expose crypto_pwhash* (Emscripten
 *   build without pwhash). Differential falls back to @node-rs/argon2 sync vs
 *   async + PHC parse (never fabricated). Marked in test when libsodium lacks pwhash.
 * - Shamir: GF(2^8) via shamir-secret-sharing@0.0.4 — no external KAT; round-trip
 *   + commitment-boundary vectors only.
 * - Envelope tamper: Wycheproof-style matrix over tag/ct/nonce/AAD/key-length/
 *   version. All failures must throw generic "decrypt failed" (no oracle detail,
 *   no plaintext leak). Coverage gate: 90% lines on packages/crypto (vitest
 *   @vitest/coverage-v8, pnpm test:coverage, CI-blocking per DESIGN-NOTE.md).
 */

import { describe, it, expect } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { createHmac, hkdfSync } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { hash as argon2Hash, verify as argon2Verify, hashRawSync } from '@node-rs/argon2';
import { encrypt, decrypt, type AAD, type Envelope } from './envelope.js';
import { splitSecret, combineShares, createCommitment, verifyCommitment } from './sharing.js';

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
function makeAAD(overrides: Partial<AAD> = {}): AAD {
  return { tenantId: 'tenant-123', switchId: 'switch-456', ...overrides };
}
const KID = 'hv-vectors-kid-01';
const KEK_VERSION = 1;
function makeKEK(): Uint8Array {
  return randomBytes(32);
}
function cloneEnvelope(e: Envelope): Envelope {
  return {
    version: e.version,
    kid: e.kid,
    kekVersion: e.kekVersion,
    wrappedDEK: { nonce: new Uint8Array(e.wrappedDEK.nonce), ct: new Uint8Array(e.wrappedDEK.ct) },
    payload: { nonce: new Uint8Array(e.payload.nonce), ct: new Uint8Array(e.payload.ct), tag: new Uint8Array(e.payload.tag) },
  };
}

describe('vectors: XChaCha20-Poly1305 differential (noble ↔ libsodium)', () => {
  it('noble encrypt → libsodium decrypt (fixed key/nonce/AAD/plaintext)', async () => {
    await sodium.ready;
    const key = hexToBytes('4211111111111111111111111111111111111111111111111111111111111111');
    const nonce = hexToBytes('070000000000000000000000000000000000000000000000');
    const aad = new TextEncoder().encode('vectors-aad-xchacha');
    const plaintext = new TextEncoder().encode('heartbeat vault xchacha differential #1');
    const ctNoble = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctNoble, aad, nonce, key);
    expect(new Uint8Array(opened)).toEqual(plaintext);
  });

  it('libsodium encrypt → noble decrypt (fixed key/nonce/AAD/plaintext)', async () => {
    await sodium.ready;
    const key = hexToBytes('4242424242424242424242424242424242424242424242424242424242424242');
    const nonce = hexToBytes('080800000000000000000000000000000000000000000000');
    const aad = new TextEncoder().encode('vectors-aad-xchacha-reverse');
    const plaintext = new TextEncoder().encode('reverse differential plaintext');
    const ctSodium = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
    const opened = xchacha20poly1305(key, nonce, aad).decrypt(new Uint8Array(ctSodium));
    expect(opened).toEqual(plaintext);
  });

  it('noble and libsodium produce identical ciphertext for same inputs', async () => {
    await sodium.ready;
    const key = new Uint8Array(32);
    key.fill(0x1a);
    const nonce = new Uint8Array(24);
    nonce.fill(0x02);
    const aad = new TextEncoder().encode('deterministic aad');
    const pt = new TextEncoder().encode('deterministic plaintext for equality check');
    const ctNoble = xchacha20poly1305(key, nonce, aad).encrypt(pt);
    const ctSodium = new Uint8Array(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aad, null, nonce, key));
    expect(ctNoble).toEqual(ctSodium);
  });

  it('round-trip with empty AAD (differential)', async () => {
    await sodium.ready;
    const key = randomBytes(32);
    const nonce = randomBytes(24);
    const pt = new TextEncoder().encode('empty aad');
    const ctNoble = xchacha20poly1305(key, nonce).encrypt(pt);
    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctNoble, null, nonce, key);
    expect(new Uint8Array(opened)).toEqual(pt);
  });
});

describe('vectors: HKDF-SHA256 RFC 5869 §A.1 TC1', () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = hexToBytes('000102030405060708090a0b0c');
  const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
  const expectedOkmHex = '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865';
  const L = 42;

  it('KAT: noble hkdf matches RFC 5869 TC1 OKM', () => {
    const okm = hkdf(sha256, ikm, salt, info, L);
    expect(bytesToHex(okm)).toBe(expectedOkmHex);
  });

  it('differential: noble vs node:crypto hkdfSync for TC1', () => {
    const nobleOkm = hkdf(sha256, ikm, salt, info, L);
    const nodeOkm = hkdfSync('sha256', ikm, salt, info, L);
    expect(bytesToHex(nobleOkm)).toBe(bytesToHex(new Uint8Array(nodeOkm as unknown as Uint8Array)));
    expect(bytesToHex(new Uint8Array(nodeOkm as unknown as Uint8Array))).toBe(expectedOkmHex);
  });

  it('differential: random inputs noble vs node:crypto agree', () => {
    const ikm2 = randomBytes(32);
    const salt2 = randomBytes(16);
    const info2 = randomBytes(8);
    const len = 32;
    const noble = hkdf(sha256, ikm2, salt2, info2, len);
    const node = hkdfSync('sha256', ikm2, salt2, info2, len);
    expect(bytesToHex(noble)).toBe(bytesToHex(new Uint8Array(node as unknown as Uint8Array)));
  });

  it('edge: HKDF with empty salt/info (RFC 5869 §2.2 zero-length handling)', () => {
    const ikm3 = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const emptySalt = new Uint8Array(0);
    const emptyInfo = new Uint8Array(0);
    const noble = hkdf(sha256, ikm3, emptySalt, emptyInfo, 32);
    const node = hkdfSync('sha256', ikm3, emptySalt, emptyInfo, 32);
    expect(noble.length).toBe(32);
    expect(bytesToHex(noble)).toBe(bytesToHex(new Uint8Array(node as unknown as Uint8Array)));
  });
});

describe('vectors: HMAC-SHA256 RFC 4231 TC1', () => {
  const key = new Uint8Array(20).fill(0x0b);
  const data = new TextEncoder().encode('Hi There');
  const expectedHex = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';

  it('KAT: noble hmac matches RFC 4231 TC1', () => {
    const tag = hmac(sha256, key, data);
    expect(bytesToHex(tag)).toBe(expectedHex);
  });

  it('differential: noble vs node:crypto createHmac for TC1', () => {
    const noble = hmac(sha256, key, data);
    const node = createHmac('sha256', key).update(data).digest();
    expect(bytesToHex(noble)).toBe(node.toString('hex'));
    expect(node.toString('hex')).toBe(expectedHex);
  });

  it('differential: RFC 4231 TC2 (key="Jefe", data="what do ya want for nothing?")', () => {
    const k2 = new TextEncoder().encode('Jefe');
    const d2 = new TextEncoder().encode('what do ya want for nothing?');
    const exp2 = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    const noble2 = hmac(sha256, k2, d2);
    expect(bytesToHex(noble2)).toBe(exp2);
    const node2 = createHmac('sha256', k2).update(d2).digest().toString('hex');
    expect(node2).toBe(exp2);
    expect(bytesToHex(noble2)).toBe(node2);
  });

  it('differential: random key/data noble vs node agree', () => {
    const k = randomBytes(32);
    const d = randomBytes(64);
    const n = hmac(sha256, k, d);
    const c = createHmac('sha256', k).update(d).digest();
    expect(bytesToHex(n)).toBe(c.toString('hex'));
  });
});

describe('vectors: Argon2id cross-implementation', () => {
  it('@node-rs/argon2: hash → verify round-trip (PHC)', async () => {
    const phc = await argon2Hash('vectors-password-α', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await argon2Verify(phc, 'vectors-password-α')).toBe(true);
    expect(await argon2Verify(phc, 'wrong')).toBe(false);
  });

  it('@node-rs/argon2: hashRawSync deterministic KEK derivation (differential sync)', () => {
    const salt = new Uint8Array(16).fill(0x5a);
    const a = hashRawSync('same-passphrase', {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      salt: Buffer.from(salt),
    } as never);
    const b = hashRawSync('same-passphrase', {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      salt: Buffer.from(salt),
    } as never);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    expect(a.length).toBe(32);
  });

  it('cross-impl: @node-rs/argon2 hash verified via libsodium if available, else documents fallback', async () => {
    await sodium.ready;
    const maybeVerify = (sodium as unknown as Record<string, unknown>)['crypto_pwhash_str_verify'] as
      | ((hash: string, passwd: string) => boolean)
      | undefined;
    const phc = await argon2Hash('cross-impl-check', { memoryCost: 19456, timeCost: 2, parallelism: 1 });

    if (typeof maybeVerify === 'function') {
      const ok = maybeVerify(phc, 'cross-impl-check');
      expect(ok).toBe(true);
      const bad = maybeVerify(phc, 'wrong');
      expect(bad).toBe(false);
    } else {
      expect(phc).toMatch(/^\$argon2id\$/);
      expect(await argon2Verify(phc, 'cross-impl-check')).toBe(true);
      expect(typeof maybeVerify).toBe('undefined');
    }
  });
});

describe('vectors: Shamir secret sharing (round-trip, no external KAT)', () => {
  it('t-of-n round-trip for exhaustive small params (2-of-2, 2-of-3, 3-of-5)', async () => {
    const secret = new TextEncoder().encode('shamir-round-trip-vectors');
    for (const [n, t] of [
      [2, 2],
      [3, 2],
      [5, 3],
    ] as const) {
      const shares = await splitSecret(secret, n, t);
      expect(shares).toHaveLength(n);
      const r1 = await combineShares(shares.slice(0, t));
      expect(r1).toEqual(secret);
      const r2 = await combineShares(shares.slice(n - t, n));
      expect(r2).toEqual(secret);
      const c = createCommitment(secret);
      expect(verifyCommitment(r1, c)).toBe(true);
    }
  });

  it('share length = secret length + 1 (x-coord prefix)', async () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const shares = await splitSecret(secret, 3, 2);
    for (const s of shares) expect(s.length).toBe(secret.length + 1);
  });

  it('any t-subset of 5-choose-3 reconstructs, any 2 does not', async () => {
    const secret = new TextEncoder().encode('quorum-test');
    const shares = await splitSecret(secret, 5, 3);
    const c = createCommitment(secret);
    const combos: number[][] = [
      [0, 1, 2],
      [0, 1, 4],
      [1, 3, 4],
      [2, 3, 4],
    ];
    for (const idxs of combos) {
      const subset = idxs.map((i) => shares[i] as Uint8Array);
      const r = await combineShares(subset);
      expect(r).toEqual(secret);
      expect(verifyCommitment(r, c)).toBe(true);
    }
    const two = [shares[0] as Uint8Array, shares[1] as Uint8Array];
    let r2: Uint8Array | null = null;
    let threw = false;
    try {
      r2 = await combineShares(two);
    } catch {
      threw = true;
    }
    if (!threw && r2) {
      expect(verifyCommitment(r2, c)).toBe(false);
      expect(r2).not.toEqual(secret);
    } else {
      expect(threw).toBe(true);
    }
  });
});

describe('adversarial: envelope Wycheproof-style tamper matrix', () => {
  function assertGenericDecryptFailed(fn: () => unknown): void {
    expect(fn).toThrow();
    let msg = '';
    try {
      fn();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.toLowerCase()).toMatch(/decrypt failed|invalid/);
    expect(msg).not.toMatch(/plaintext/i);
    expect(msg).not.toMatch(/expected tag at byte/i);
  }

  it('tag byte-class flips all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('tamper-tag-matrix'), aad, kek, KID, KEK_VERSION);
    for (const idx of [0, 7, 15]) {
      const t = cloneEnvelope(env);
      t.payload.tag[idx] = (t.payload.tag[idx] as number) ^ 0xff;
      assertGenericDecryptFailed(() => decrypt(t, aad, kek));
      const t2 = cloneEnvelope(env);
      t2.payload.tag[idx] = (t2.payload.tag[idx] as number) ^ 0x01;
      assertGenericDecryptFailed(() => decrypt(t2, aad, kek));
    }
    {
      const z = cloneEnvelope(env);
      z.payload.tag.fill(0);
      assertGenericDecryptFailed(() => decrypt(z, aad, kek));
    }
    {
      const tr = cloneEnvelope(env);
      (tr.payload as unknown as { tag: Uint8Array }).tag = tr.payload.tag.subarray(0, 15);
      assertGenericDecryptFailed(() => decrypt(tr as Envelope, aad, kek));
    }
    {
      const over = cloneEnvelope(env);
      const longer = new Uint8Array(17);
      longer.set(over.payload.tag, 0);
      (over.payload as unknown as { tag: Uint8Array }).tag = longer;
      assertGenericDecryptFailed(() => decrypt(over as Envelope, aad, kek));
    }
  });

  it('ciphertext byte-class flips all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const pt = new TextEncoder().encode('tamper-ciphertext-matrix-with-some-length');
    const env = encrypt(pt, aad, kek, KID, KEK_VERSION);
    for (const idx of [0, Math.floor(env.payload.ct.length / 2), env.payload.ct.length - 1]) {
      if (env.payload.ct.length === 0) break;
      const c = cloneEnvelope(env);
      c.payload.ct[idx] = (c.payload.ct[idx] as number) ^ 0x01;
      assertGenericDecryptFailed(() => decrypt(c, aad, kek));
    }
    {
      const w = cloneEnvelope(env);
      w.wrappedDEK.ct[0] = (w.wrappedDEK.ct[0] as number) ^ 0x01;
      assertGenericDecryptFailed(() => decrypt(w, aad, kek));
    }
    {
      const w = cloneEnvelope(env);
      (w.wrappedDEK as unknown as { ct: Uint8Array }).ct = w.wrappedDEK.ct.subarray(0, w.wrappedDEK.ct.length - 1);
      assertGenericDecryptFailed(() => decrypt(w, aad, kek));
    }
  });

  it('nonce byte-class flips and length variations all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('nonce-tamper'), aad, kek, KID, KEK_VERSION);
    {
      const n = cloneEnvelope(env);
      n.wrappedDEK.nonce[0] = (n.wrappedDEK.nonce[0] as number) ^ 0x01;
      assertGenericDecryptFailed(() => decrypt(n, aad, kek));
    }
    {
      const n = cloneEnvelope(env);
      n.payload.nonce[5] = (n.payload.nonce[5] as number) ^ 0x80;
      assertGenericDecryptFailed(() => decrypt(n, aad, kek));
    }
    for (const len of [23, 25, 0, 32]) {
      const n = cloneEnvelope(env);
      (n.payload as unknown as { nonce: Uint8Array }).nonce = new Uint8Array(len).fill(0x01);
      assertGenericDecryptFailed(() => decrypt(n as Envelope, aad, kek));
      const nw = cloneEnvelope(env);
      (nw.wrappedDEK as unknown as { nonce: Uint8Array }).nonce = new Uint8Array(len).fill(0x02);
      assertGenericDecryptFailed(() => decrypt(nw as Envelope, aad, kek));
    }
  });

  it('AAD class flips (tenantId/switchId/kid/kekVersion) all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('aad-tamper'), aad, kek, KID, KEK_VERSION);
    assertGenericDecryptFailed(() => decrypt(env, { tenantId: 'other-tenant', switchId: aad.switchId }, kek));
    assertGenericDecryptFailed(() => decrypt(env, { tenantId: aad.tenantId, switchId: 'other-switch' }, kek));
    {
      const k = cloneEnvelope(env);
      (k as unknown as { kid: string }).kid = 'different-kid';
      assertGenericDecryptFailed(() => decrypt(k as Envelope, aad, kek));
    }
    {
      const v = cloneEnvelope(env);
      (v as unknown as { kekVersion: number }).kekVersion = KEK_VERSION + 99;
      assertGenericDecryptFailed(() => decrypt(v as Envelope, aad, kek));
    }
  });

  it('key-length class (short/long/empty) all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('key-length-tamper'), aad, kek, KID, KEK_VERSION);
    for (const badLen of [0, 1, 16, 31, 33, 64]) {
      const badKek = new Uint8Array(badLen).fill(0x03);
      assertGenericDecryptFailed(() => decrypt(env, aad, badKek as unknown as Uint8Array));
    }
    expect(() => encrypt(new Uint8Array([1, 2]), aad, new Uint8Array(16), KID, KEK_VERSION)).toThrow();
  });

  it('wrong-version class (0, 2, 999, -1) all fail generic', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('version-tamper'), aad, kek, KID, KEK_VERSION);
    for (const badVer of [0, 2, 999, -1, Number.MAX_SAFE_INTEGER]) {
      const v = cloneEnvelope(env);
      (v as unknown as { version: number }).version = badVer;
      assertGenericDecryptFailed(() => decrypt(v as Envelope, aad, kek));
    }
  });

  it('oracle discipline: all tamper errors are indistinguishable (no detailed oracle)', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('oracle-discipline'), aad, kek, KID, KEK_VERSION);
    const cases: Array<() => Envelope> = [
      () => {
        const c = cloneEnvelope(env);
        c.payload.tag[0] = ((c.payload.tag[0] as number) ^ 0x01) & 0xff;
        return c;
      },
      () => {
        const c = cloneEnvelope(env);
        if (c.payload.ct.length > 0) c.payload.ct[0] = ((c.payload.ct[0] as number) ^ 0x01) & 0xff;
        else c.payload.tag[0] = ((c.payload.tag[0] as number) ^ 0x01) & 0xff;
        return c;
      },
      () => {
        const c = cloneEnvelope(env);
        c.wrappedDEK.ct[0] = ((c.wrappedDEK.ct[0] as number) ^ 0x01) & 0xff;
        return c;
      },
      () => {
        const c = cloneEnvelope(env);
        c.wrappedDEK.nonce[0] = ((c.wrappedDEK.nonce[0] as number) ^ 0x01) & 0xff;
        return c;
      },
    ];
    const messages = cases.map((mk) => {
      try {
        decrypt(mk(), aad, kek);
        return 'no-throw';
      } catch (e) {
        return (e as Error).message;
      }
    });
    for (const m of messages) expect(m).not.toBe('no-throw');
    for (const m of messages) {
      expect(m.toLowerCase()).toMatch(/decrypt failed/);
      expect(m).not.toMatch(/byte \d+/i);
      expect(m).not.toMatch(/offset/i);
    }
  });
});

import { hashPassword, verifyPassword, deriveKEK, deriveKEKAsync, needsRehash } from './kdf.js';
import { rotateKEK, needsRotation } from './rotation.js';
import { generateKeyPair, sealForRecipient, openSealedBox, sealForMany } from './asymmetric.js';
import { xchacha20poly1305 as xchachaDirect } from '@noble/ciphers/chacha.js';

describe('coverage-fill: defensive branches (source: branch coverage)', () => {
  it('deriveKEKAsync matches deriveKEK (async vs sync differential)', async () => {
    const salt = new Uint8Array(16).fill(0x11);
    const a = deriveKEK('coverage-pass', salt);
    const b = await deriveKEKAsync('coverage-pass', salt);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('KDF: validation branches', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword(123 as unknown as string)).rejects.toThrow();
    await expect(verifyPassword('', 'x')).rejects.toThrow();
    await expect(verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$salt$hash', 123 as unknown as string)).rejects.toThrow();
    expect(() => needsRehash('')).toThrow();
    expect(() => needsRehash('$notargon2')).toThrow();
    expect(() => deriveKEK('', new Uint8Array(16).fill(1))).toThrow();
    expect(() => deriveKEK('ok', new Uint8Array(8))).toThrow();
    expect(() => deriveKEK('ok', 'notbytes' as unknown as Uint8Array)).toThrow();
    await expect(deriveKEKAsync('', new Uint8Array(16))).rejects.toThrow();
    await expect(deriveKEKAsync('ok', new Uint8Array(8))).rejects.toThrow();
  });

  it('rotation: validation + fallback AAD path', () => {
    const oldKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('rot-fill'), aad, oldKEK, KID, 1);
    const rotatedNoResolver = rotateKEK([env], oldKEK, newKEK, 2);
    expect(rotatedNoResolver[0]?.kekVersion).toBe(2);
    expect(() => rotateKEK(null as unknown as Envelope[], oldKEK, newKEK, 2)).toThrow();
    expect(() => rotateKEK([env], new Uint8Array(16), newKEK, 2)).toThrow();
    expect(() => rotateKEK([env], oldKEK, new Uint8Array(16), 2)).toThrow();
    expect(() => rotateKEK([env], oldKEK, newKEK, -1)).toThrow();
    expect(() => rotateKEK([null as unknown as Envelope], oldKEK, newKEK, 2)).toThrow();
    expect(() => needsRotation(null as unknown as Envelope, 1)).toThrow();
    expect(() => needsRotation(env, -1)).toThrow();
    expect(needsRotation(env, 99)).toBe(true);
  });

  it('rotation: tryUnwrapDEK failure path (wrong KEK)', () => {
    const oldKEK = randomBytes(32);
    const wrongKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();
    const env = encrypt(new TextEncoder().encode('unwrap-fail'), aad, oldKEK, KID, 1);
    expect(() => rotateKEK([env], wrongKEK, newKEK, 2, () => aad)).toThrow(/unwrap failed/);
  });

  it('envelope: dek length mismatch crafted path (covers envelope.ts:239-240)', () => {
    const kek = randomBytes(32);
    const aad = makeAAD();
    const fakeDek = new Uint8Array(16).fill(0xab);
    const sorted: Record<string, string | number> = {};
    for (const k of ['kid', 'kekVersion', 'switchId', 'tenantId'].sort()) {
      const v: Record<string, string | number> = { kid: KID, kekVersion: KEK_VERSION, switchId: aad.switchId, tenantId: aad.tenantId };
      sorted[k] = v[k] as string | number;
    }
    const aadBytes = new TextEncoder().encode(JSON.stringify(sorted));
    const wrapNonce = randomBytes(24);
    const payloadNonce = randomBytes(24);
    const fakeWrapped = xchachaDirect(kek, wrapNonce, aadBytes).encrypt(fakeDek);
    const realDek = randomBytes(32);
    const sorted2: Record<string, string> = {};
    for (const k of ['switchId', 'tenantId'].sort()) sorted2[k] = aad[k as keyof AAD];
    const payloadAAD2 = new TextEncoder().encode(JSON.stringify(sorted2));
    const pt = new TextEncoder().encode('dek-len-mismatch');
    const ctAndTag = xchachaDirect(realDek, payloadNonce, payloadAAD2).encrypt(pt);
    const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
    const tag = ctAndTag.subarray(ctAndTag.length - 16);
    const crafted: Envelope = {
      version: 1,
      kid: KID,
      kekVersion: KEK_VERSION,
      wrappedDEK: { nonce: wrapNonce, ct: fakeWrapped },
      payload: { nonce: payloadNonce, ct: new Uint8Array(ct), tag: new Uint8Array(tag) },
    };
    expect(() => decrypt(crafted, aad, kek)).toThrow(/invalid unwrapped DEK length/);
  });

  it('asymmetric: validation branches', async () => {
    const { publicKey } = await generateKeyPair();
    await expect(sealForRecipient('notbytes' as unknown as Uint8Array, publicKey)).rejects.toThrow();
    await expect(sealForRecipient(new Uint8Array([1]), new Uint8Array(16))).rejects.toThrow();
    await expect(openSealedBox(new Uint8Array(10), publicKey, randomBytes(32))).rejects.toThrow();
    await expect(openSealedBox(await sealForRecipient(new Uint8Array([1]), publicKey), new Uint8Array(16), randomBytes(32))).rejects.toThrow();
    await expect(openSealedBox(await sealForRecipient(new Uint8Array([1]), publicKey), publicKey, new Uint8Array(16))).rejects.toThrow();
    await expect(sealForMany(new Uint8Array([1]), [])).rejects.toThrow();
    await expect(sealForMany('bad' as unknown as Uint8Array, [publicKey])).rejects.toThrow();
    const dup = [publicKey, publicKey];
    await expect(sealForMany(new Uint8Array([1]), dup)).rejects.toThrow(/duplicate/);
    await expect(sealForMany(new Uint8Array([1]), [new Uint8Array(16)] as unknown as Uint8Array[])).rejects.toThrow();
  });

  it('sharing: validation branches', async () => {
    await expect(splitSecret(new Uint8Array(0), 5, 3)).rejects.toThrow();
    await expect(splitSecret('bad' as unknown as Uint8Array, 5, 3)).rejects.toThrow();
    await expect(combineShares([] as unknown as Uint8Array[])).rejects.toThrow();
    await expect(combineShares([new Uint8Array([1])] as unknown as Uint8Array[])).rejects.toThrow();
    await expect(combineShares([new Uint8Array(1), 'bad' as unknown as Uint8Array])).rejects.toThrow();
    expect(() => createCommitment(new Uint8Array(0))).toThrow();
    expect(() => verifyCommitment('bad' as unknown as Uint8Array, new Uint8Array(64))).toThrow();
    const c = createCommitment(new TextEncoder().encode('x'));
    expect(verifyCommitment(new TextEncoder().encode('x'), new Uint8Array(32))).toBe(false);
    expect(verifyCommitment(new TextEncoder().encode('x'), c)).toBe(true);
  });

  it('envelope: encrypt/decrypt validation branches', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    expect(() => encrypt(new TextEncoder().encode('x'), { tenantId: '', switchId: 's' } as AAD, kek, KID, 1)).toThrow();
    expect(() => encrypt(new TextEncoder().encode('x'), { tenantId: 't', switchId: '' } as AAD, kek, KID, 1)).toThrow();
    expect(() => encrypt(new TextEncoder().encode('x'), null as unknown as AAD, kek, KID, 1)).toThrow();
    expect(() => encrypt('bad' as unknown as Uint8Array, aad, kek, KID, 1)).toThrow();
    expect(() => encrypt(new TextEncoder().encode('x'), aad, kek, '', 1)).toThrow();
    expect(() => encrypt(new TextEncoder().encode('x'), aad, kek, KID, -1)).toThrow();
    expect(() => encrypt(new TextEncoder().encode('x'), aad, new Uint8Array(16), KID, 1)).toThrow();
    const env = encrypt(new TextEncoder().encode('valid'), aad, kek, KID, 1);
    expect(() => decrypt(null as unknown as Envelope, aad, kek)).toThrow();
    expect(() => decrypt({ ...env, kid: '' } as unknown as Envelope, aad, kek)).toThrow();
    expect(() => decrypt(env, null as unknown as AAD, kek)).toThrow();
    expect(() => decrypt(env, aad, new Uint8Array(8))).toThrow();
  });
});
