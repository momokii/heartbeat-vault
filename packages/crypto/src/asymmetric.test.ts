import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  sealForRecipient,
  openSealedBox,
  sealForMany,
} from './asymmetric.js';

describe('asymmetric sealed-box (X25519 via libsodium)', () => {
  it('round-trip 1-recipient: seal then open returns plaintext', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const plaintext = new TextEncoder().encode('dead-man-switch payload');
    const sealed = await sealForRecipient(plaintext, publicKey);
    const opened = await openSealedBox(sealed, publicKey, privateKey);
    expect(opened).toEqual(plaintext);
  });

  it('wrong key fails to open', async () => {
    const { publicKey } = await generateKeyPair();
    const { publicKey: otherPub, privateKey: otherPriv } = await generateKeyPair();
    const plaintext = new TextEncoder().encode('secret');
    const sealed = await sealForRecipient(plaintext, publicKey);
    await expect(openSealedBox(sealed, otherPub, otherPriv)).rejects.toThrow();
  });

  it('tampered sealed box fails authentication', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const plaintext = new TextEncoder().encode('tamper-me');
    const sealed = await sealForRecipient(plaintext, publicKey);
    const tampered = new Uint8Array(sealed);
    const idx = tampered.length - 1;
    const last = tampered[idx];
    if (last === undefined) throw new Error('tampered empty');
    tampered[idx] = last ^ 0x01;
    await expect(openSealedBox(tampered, publicKey, privateKey)).rejects.toThrow();
  });

  it('multi-recipient: each recipient can open their own sealed box', async () => {
    const recipients = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
    const publicKeys = recipients.map((r) => r.publicKey);
    const plaintext = new TextEncoder().encode('shared secret for many');
    const boxes = await sealForMany(plaintext, publicKeys);
    expect(boxes.size).toBe(3);
    for (const { publicKey, privateKey } of recipients) {
      const keyId = Buffer.from(publicKey).toString('hex');
      const sealed = boxes.get(keyId);
      expect(sealed).toBeDefined();
      const opened = await openSealedBox(sealed as Uint8Array, publicKey, privateKey);
      expect(opened).toEqual(plaintext);
    }
  });

  it('anonymous seal has 48B overhead (ciphertext = plaintext + 48)', async () => {
    const { publicKey } = await generateKeyPair();
    const plaintext = new TextEncoder().encode('exact-overhead');
    const sealed = await sealForRecipient(plaintext, publicKey);
    expect(sealed.length).toBe(plaintext.length + 48);
    const emptySealed = await sealForRecipient(new Uint8Array(0), publicKey);
    expect(emptySealed.length).toBe(48);
  });
});
