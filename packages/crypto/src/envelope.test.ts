import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/ciphers/utils.js';
import { encrypt, decrypt, type AAD, type Envelope } from './envelope.js';

function makeAAD(overrides: Partial<AAD> = {}): AAD {
  return {
    tenantId: 'tenant-123',
    switchId: 'switch-456',
    ...overrides,
  };
}

function makeKEK(): Uint8Array {
  return randomBytes(32);
}

const KID = 'hv-test-kek-01';
const KEK_VERSION = 1;

describe('envelope AEAD', () => {
  it('round-trip encrypt/decrypt returns original plaintext', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('hello heartbeat vault');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const decrypted = decrypt(envelope, aad, kek);
    expect(decrypted).toEqual(plaintext);
  });

  it('fails when payload tag is flipped by one bit', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('tag flip test');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    // flip one bit in tag
    const tampered: Envelope = {
      ...envelope,
      payload: {
        nonce: envelope.payload.nonce,
        ct: envelope.payload.ct,
        tag: new Uint8Array(envelope.payload.tag),
      },
    };
    const tagByte = tampered.payload.tag[0];
    if (tagByte === undefined) throw new Error('tag empty');
    tampered.payload.tag[0] = tagByte ^ 0x01;
    expect(() => decrypt(tampered, aad, kek)).toThrow();
  });

  it('fails when ciphertext is flipped by one bit', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('ciphertext flip test');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const tampered: Envelope = {
      ...envelope,
      payload: {
        nonce: envelope.payload.nonce,
        ct: new Uint8Array(envelope.payload.ct),
        tag: envelope.payload.tag,
      },
    };
    const ctByte = tampered.payload.ct[0];
    if (ctByte === undefined && tampered.payload.ct.length > 0) throw new Error('ct empty');
    if (tampered.payload.ct.length > 0) {
      tampered.payload.ct[0] = (ctByte as number) ^ 0x01;
    } else {
      // empty ct edge: tamper tag instead to ensure failure path still exercised
      const tb = tampered.payload.tag[0];
      if (tb !== undefined) tampered.payload.tag[0] = tb ^ 0x01;
    }
    expect(() => decrypt(tampered, aad, kek)).toThrow();
  });

  it('fails when wrong AAD is supplied', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('aad test');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const wrongAad = makeAAD({ tenantId: 'other-tenant' });
    expect(() => decrypt(envelope, wrongAad, kek)).toThrow();
  });

  it('fails when wrong KEK is supplied', () => {
    const kek = makeKEK();
    const wrongKek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('wrong kek test');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    expect(() => decrypt(envelope, aad, wrongKek)).toThrow();
  });

  it('produces unique nonces across 1000 encryptions', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('nonce uniqueness');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const env = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
      const key = `${Buffer.from(env.wrappedDEK.nonce).toString('hex')}:${Buffer.from(env.payload.nonce).toString('hex')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(1000);
  });

  it('fails when version prefix is tampered', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new TextEncoder().encode('version test');
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const tampered: Envelope = {
      ...envelope,
      version: 999,
    };
    expect(() => decrypt(tampered, aad, kek)).toThrow();
  });

  it('round-trip with empty plaintext', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = new Uint8Array(0);
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const decrypted = decrypt(envelope, aad, kek);
    expect(decrypted).toEqual(plaintext);
  });

  it('round-trip with large plaintext (64KB)', () => {
    const kek = makeKEK();
    const aad = makeAAD();
    const plaintext = randomBytes(64 * 1024);
    const envelope = encrypt(plaintext, aad, kek, KID, KEK_VERSION);
    const decrypted = decrypt(envelope, aad, kek);
    expect(decrypted).toEqual(plaintext);
  });
});
