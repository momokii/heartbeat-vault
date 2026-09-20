import { describe, it, expect } from 'vitest';
import {
  splitSecret,
  combineShares,
  createCommitment,
  verifyCommitment,
} from './sharing.js';

describe('shamir secret sharing + BLAKE2b commitment', () => {
  it('n=5,t=3 round-trip reconstructs secret', async () => {
    const secret = new TextEncoder().encode('my private key material 32B!!!');
    const shares = await splitSecret(secret, 5, 3);
    expect(shares).toHaveLength(5);
    const reconstructed = await combineShares(shares.slice(0, 3));
    expect(reconstructed).toEqual(secret);
    const alt = await combineShares([
      shares[1] as Uint8Array,
      shares[3] as Uint8Array,
      shares[4] as Uint8Array,
    ]);
    expect(alt).toEqual(secret);
  });

  it('<t shares do not reconstruct original secret (honest-dealer commitment fails)', async () => {
    const secret = new TextEncoder().encode('threshold-test-secret');
    const commitment = createCommitment(secret);
    const shares = await splitSecret(secret, 5, 3);
    const twoShares = shares.slice(0, 2);
    let reconstructed: Uint8Array | null = null;
    let threw = false;
    try {
      reconstructed = await combineShares(twoShares);
    } catch {
      threw = true;
    }
    if (!threw && reconstructed) {
      expect(verifyCommitment(reconstructed, commitment)).toBe(false);
      expect(reconstructed).not.toEqual(secret);
    } else {
      expect(threw).toBe(true);
    }
  });

  it('corrupt share fails commitment verification', async () => {
    const secret = new TextEncoder().encode('commitment-test');
    const commitment = createCommitment(secret);
    expect(verifyCommitment(secret, commitment)).toBe(true);
    const shares = await splitSecret(secret, 5, 3);
    const corrupted = shares.map((s) => new Uint8Array(s));
    const first = corrupted[0] as Uint8Array;
    if (!first) throw new Error('missing share');
    const b0 = first[0] as number;
    if (b0 === undefined) throw new Error('share empty');
    first[0] = b0 ^ 0xff;
    const reconstructed = await combineShares([
      corrupted[0] as Uint8Array,
      shares[1] as Uint8Array,
      shares[2] as Uint8Array,
    ]);
    expect(verifyCommitment(reconstructed, commitment)).toBe(false);
    expect(reconstructed).not.toEqual(secret);
  });

  it('invalid n/t parameters throw', async () => {
    const secret = new TextEncoder().encode('invalid-param');
    await expect(splitSecret(secret, 1, 1)).rejects.toThrow();
    await expect(splitSecret(secret, 5, 6)).rejects.toThrow();
    await expect(splitSecret(secret, 5, 1)).rejects.toThrow();
    await expect(splitSecret(secret, 256, 2)).rejects.toThrow();
    await expect(splitSecret(secret, 2, 256)).rejects.toThrow();
    await expect(splitSecret(secret, 0, 0)).rejects.toThrow();
  });

  it('commitment helper: same secret same commitment, different secret different commitment', () => {
    const a = new TextEncoder().encode('hello');
    const b = new TextEncoder().encode('hello');
    const c = new TextEncoder().encode('world');
    const ca = createCommitment(a);
    const cb = createCommitment(b);
    const cc = createCommitment(c);
    expect(ca).toEqual(cb);
    expect(ca).not.toEqual(cc);
    expect(verifyCommitment(a, ca)).toBe(true);
    expect(verifyCommitment(c, ca)).toBe(false);
  });
});
