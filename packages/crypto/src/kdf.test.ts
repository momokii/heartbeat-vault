import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, deriveKEK, needsRehash } from './kdf.js';

describe('kdf: hashPassword / verifyPassword', () => {
  it('PHC round-trip: hash then verify returns true', async () => {
    const phc = await hashPassword('correct horse battery staple');
    expect(phc).toMatch(/^\$argon2id\$/);
    const ok = await verifyPassword(phc, 'correct horse battery staple');
    expect(ok).toBe(true);
  });

  it('wrong password fails verification', async () => {
    const phc = await hashPassword('correct horse battery staple');
    const ok = await verifyPassword(phc, 'wrong password');
    expect(ok).toBe(false);
  });

  it('malformed PHC throws', async () => {
    await expect(verifyPassword('not-a-phc-string', 'whatever')).rejects.toThrow();
    expect(() => needsRehash('not-a-phc-string')).toThrow();
  });

  it('needsRehash detects old params', async () => {
    const phc = await hashPassword('rehash-test');
    expect(needsRehash(phc)).toBe(false);

    // Simulate old hash with lower memory cost by crafting a PHC string with m=4096
    // We import @node-rs/argon2 directly to create an old-param hash
    const { hash } = await import('@node-rs/argon2');
    const oldPhc = await hash('rehash-test', {
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });
    expect(needsRehash(oldPhc)).toBe(true);
  });

  it('pepper changes output', async () => {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);

    const prev = process.env.KEK_PEPPER;
    try {
      process.env.KEK_PEPPER = 'pepper-alpha-1234567890';
      const kek1 = await deriveKEK('passphrase123', salt);

      process.env.KEK_PEPPER = 'pepper-beta-0987654321';
      const kek2 = await deriveKEK('passphrase123', salt);

      expect(kek1).not.toEqual(kek2);
      expect(kek1.length).toBe(32);
      expect(kek2.length).toBe(32);
    } finally {
      if (prev === undefined) delete process.env.KEK_PEPPER;
      else process.env.KEK_PEPPER = prev;
    }
  });

  it('missing pepper throws when required', async () => {
    const prev = process.env.KEK_PEPPER;
    try {
      delete process.env.KEK_PEPPER;

      await expect(hashPassword('test', { requirePepper: true })).rejects.toThrow(/KEK_PEPPER/);

      const salt = new Uint8Array(16).fill(1);
      // deriveKEK is sync - support both sync throw and async reject
      try {
        const result = deriveKEK('passphrase', salt, { requirePepper: true });
        // If it returned a Promise, await it and expect rejection
        if (result instanceof Promise) {
          await expect(result).rejects.toThrow(/KEK_PEPPER/);
        } else {
          throw new Error('expected deriveKEK to throw when pepper required');
        }
      } catch (e) {
        // Sync throw path
        expect((e as Error).message).toMatch(/KEK_PEPPER/);
      }
    } finally {
      if (prev === undefined) delete process.env.KEK_PEPPER;
      else process.env.KEK_PEPPER = prev;
    }
  });

  it('deriveKEK returns 32 bytes and is deterministic with same salt', async () => {
    const salt = new Uint8Array(16);
    salt.fill(42);
    const prev = process.env.KEK_PEPPER;
    try {
      process.env.KEK_PEPPER = 'stable-pepper-for-test';
      const kek1 = await deriveKEK('my-passphrase', salt);
      const kek2 = await deriveKEK('my-passphrase', salt);
      expect(kek1).toEqual(kek2);
      expect(kek1.length).toBe(32);
    } finally {
      if (prev === undefined) delete process.env.KEK_PEPPER;
      else process.env.KEK_PEPPER = prev;
    }
  });
});
