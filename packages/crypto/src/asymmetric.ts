/**
 * Heartbeat Vault — Asymmetric Sealed-Box (T2.4)
 *
 * Primitive: X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305 anonymous sealed box
 * Library: libsodium-wrappers@0.8.4 (pinned exact). Wraps libsodium 1.0.18 C core.
 * Audit pedigree: libsodium C core has multiple third-party audits (see Cure53
 * 2017, Trail of Bits references in upstream); wrappers are thin Emscripten bindings
 * → trust inherits from C core + wrapper tests. 0.8.4 is 2026-04-19 release, 2.3M/wk.
 *
 * Sealed box: crypto_box_seal(m, pk) = 32 B ephemeral pk || box(m+16 tag).
 * Overhead = 48 B (32 ephemeral pk + 16 Poly1305 tag), anonymous (recipient
 * not linkable without identity), single-recipient per blob. Multi-recipient
 * → one sealed box per recipient + key-id map (hex(pubkey) → sealed).
 *
 * v1 custody: server holds wrapped private-key material, releases to verified
 * recipients at trigger (server-side custody). Recipient-held Shamir shares
 * deferred (see DESIGN-NOTE.md § custody).
 */

import sodium from 'libsodium-wrappers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValidPublicKey(pk: Uint8Array): void {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) {
    throw new Error('invalid public key: expected 32-byte Uint8Array');
  }
}

function assertValidPrivateKey(sk: Uint8Array): void {
  if (!(sk instanceof Uint8Array) || sk.length !== 32) {
    throw new Error('invalid private key: expected 32-byte Uint8Array');
  }
}

async function ensureReady(): Promise<void> {
  await sodium.ready;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type KeyPair = {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
};

/**
 * Generate an X25519 key pair via libsodium `crypto_box_keypair`.
 * Returns 32-byte publicKey + 32-byte privateKey (copied, not sharing backing).
 */
export async function generateKeyPair(): Promise<KeyPair> {
  await ensureReady();
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: new Uint8Array(kp.publicKey),
    privateKey: new Uint8Array(kp.privateKey),
  };
}

/**
 * Seal `plaintext` for a single recipient (anonymous).
 * Overhead = plaintext.length + 48.
 *
 * @param plaintext - bytes to encrypt (any length, including 0)
 * @param recipientPublicKey - 32-byte X25519 public key
 */
export async function sealForRecipient(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  assertValidPublicKey(recipientPublicKey);
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error('invalid plaintext: expected Uint8Array');
  }
  const sealed = sodium.crypto_box_seal(plaintext, recipientPublicKey);
  return new Uint8Array(sealed);
}

/**
 * Open an anonymous sealed box.
 * Throws on wrong key, tampered ciphertext, or invalid lengths.
 *
 * @param sealed - bytes produced by `sealForRecipient` (must be >=48B)
 * @param publicKey - recipient's 32-byte public key (must match privateKey)
 * @param privateKey - recipient's 32-byte private key
 * @returns plaintext
 */
export async function openSealedBox(
  sealed: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  assertValidPublicKey(publicKey);
  assertValidPrivateKey(privateKey);
  if (!(sealed instanceof Uint8Array) || sealed.length < 48) {
    throw new Error('invalid sealed box: too short (expected >=48 bytes)');
  }
  try {
    const opened = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
    return new Uint8Array(opened);
  } catch {
    throw new Error('sealed box open failed: authentication failed or wrong key');
  }
}

/**
 * Multi-recipient helper: one sealed box per recipient + key-id map.
 * Key-id = hex(publicKey) (32 bytes → 64 hex chars). Map preserves input order.
 *
 * @param plaintext - bytes to encrypt for all recipients
 * @param publicKeys - array of recipient public keys (each 32 bytes, non-empty)
 * @returns Map<keyIdHex, sealedBox>
 */
export async function sealForMany(
  plaintext: Uint8Array,
  publicKeys: readonly Uint8Array[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  await ensureReady();
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
    throw new Error('sealForMany: publicKeys must be a non-empty array');
  }
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error('invalid plaintext: expected Uint8Array');
  }
  const out = new Map<string, Uint8Array>();
  for (const pk of publicKeys) {
    assertValidPublicKey(pk);
    const keyId = Buffer.from(pk).toString('hex');
    if (out.has(keyId)) {
      throw new Error('sealForMany: duplicate public key');
    }
    const sealed = sodium.crypto_box_seal(plaintext, pk);
    out.set(keyId, new Uint8Array(sealed));
  }
  return out;
}
