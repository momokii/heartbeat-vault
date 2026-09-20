import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/ciphers/utils.js';
import { encrypt, decrypt, type AAD } from './envelope.js';
import { rotateKEK, needsRotation } from './rotation.js';

function makeAAD(): AAD {
  return { tenantId: 'tenant-123', switchId: 'switch-456' };
}

const KID = 'hv-test-kek-01';

describe('rotation', () => {
  it('re-wrap preserves plaintext decryptability', () => {
    const oldKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('secret payload for rotation');

    const envelope = encrypt(plaintext, aad, oldKEK, KID, 1);
    const rotated = rotateKEK([envelope], oldKEK, newKEK, 2, () => aad);

    expect(rotated).toHaveLength(1);
    const r = rotated[0];
    if (!r) throw new Error('missing rotated envelope');
    expect(r.kekVersion).toBe(2);
    expect(r.wrappedDEK.nonce).not.toEqual(envelope.wrappedDEK.nonce);

    const decrypted = decrypt(r, aad, newKEK);
    expect(decrypted).toEqual(plaintext);
  });

  it('idempotent double-rotate', () => {
    const oldKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('idempotent test');

    const envelope = encrypt(plaintext, aad, oldKEK, KID, 1);
    const once = rotateKEK([envelope], oldKEK, newKEK, 2, () => aad);
    const r1 = once[0];
    if (!r1) throw new Error('missing');

    // Rotating an already-rotated envelope with same newVersion should be no-op
    const twice = rotateKEK(once, newKEK, newKEK, 2, () => aad);
    const r2 = twice[0];
    if (!r2) throw new Error('missing');
    expect(r2.kekVersion).toBe(2);
    expect(r2.wrappedDEK.ct).toEqual(r1.wrappedDEK.ct);
    expect(r2.wrappedDEK.nonce).toEqual(r1.wrappedDEK.nonce);

    const decrypted = decrypt(r2, aad, newKEK);
    expect(decrypted).toEqual(plaintext);
  });

  it('old-version decrypt still works when old KEK retained', () => {
    const oldKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('old kek retained');

    const envelope = encrypt(plaintext, aad, oldKEK, KID, 1);
    const rotated = rotateKEK([envelope], oldKEK, newKEK, 2, () => aad);
    const r = rotated[0];
    if (!r) throw new Error('missing');

    // Old envelope still decryptable with old KEK
    const oldDecrypted = decrypt(envelope, aad, oldKEK);
    expect(oldDecrypted).toEqual(plaintext);

    // Old envelope NOT decryptable with new KEK
    expect(() => decrypt(envelope, aad, newKEK)).toThrow();

    // New envelope decryptable with new KEK, not old
    const newDecrypted = decrypt(r, aad, newKEK);
    expect(newDecrypted).toEqual(plaintext);
    expect(() => decrypt(r, aad, oldKEK)).toThrow();
  });

  it('needsRotation detects stale version', () => {
    const oldKEK = randomBytes(32);
    const aad = makeAAD();
    const envelope = encrypt(new TextEncoder().encode('x'), aad, oldKEK, KID, 1);

    expect(needsRotation(envelope, 1)).toBe(false);
    expect(needsRotation(envelope, 2)).toBe(true);
  });

  it('batch-friendly: rotates multiple envelopes', () => {
    const oldKEK = randomBytes(32);
    const newKEK = randomBytes(32);
    const aad = makeAAD();

    const e1 = encrypt(new TextEncoder().encode('one'), aad, oldKEK, KID, 1);
    const e2 = encrypt(new TextEncoder().encode('two'), aad, oldKEK, KID, 1);
    const rotated = rotateKEK([e1, e2], oldKEK, newKEK, 2, () => aad);

    expect(rotated).toHaveLength(2);
    expect(decrypt(rotated[0] as never, aad, newKEK)).toEqual(new TextEncoder().encode('one'));
    expect(decrypt(rotated[1] as never, aad, newKEK)).toEqual(new TextEncoder().encode('two'));
  });
});
