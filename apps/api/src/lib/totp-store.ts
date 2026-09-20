// TOTP secret at rest: envelope AEAD (ADR-005) serialization for the single
// users.totp_secret_encrypted bytea column.
//
// Binding: kid 'totp', kekVersion 1, AAD {tenantId:'default', switchId:'totp'}.
// Serialization: canonical JSON of the Envelope struct (Uint8Array fields as
// base64) stored as UTF-8 bytes in bytea. Version field travels inside the
// blob for future rotation. The plaintext base32 secret never touches disk
// outside the AEAD path and is never logged.
import { decrypt, encrypt, type Envelope } from '@heartbeat-vault/crypto';
import { loadTotpKek } from './kek.js';

export const TOTP_KID = 'totp';
export const TOTP_KEK_VERSION = 1;
export const TOTP_AAD = { tenantId: 'default', switchId: 'totp' } as const;

export const TOTP_PERIOD_SEC = 30;
// Past-step-only verification window: current step + one previous step,
// never a future step. RFC 6238 §5.2 past-only posture.
export const TOTP_EPOCH_TOLERANCE: readonly [number, number] = [TOTP_PERIOD_SEC, 0];

function u8ToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64ToU8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

type SerializedEnvelope = {
  version: number;
  kid: string;
  kekVersion: number;
  wrappedDEK: { nonce: string; ct: string };
  payload: { nonce: string; ct: string; tag: string };
};

export function encryptTotpSecret(secretBase32: string): Buffer {
  const envelope = encrypt(
    new TextEncoder().encode(secretBase32),
    TOTP_AAD,
    loadTotpKek(),
    TOTP_KID,
    TOTP_KEK_VERSION,
  );
  const serialized: SerializedEnvelope = {
    version: envelope.version,
    kid: envelope.kid,
    kekVersion: envelope.kekVersion,
    wrappedDEK: { nonce: u8ToB64(envelope.wrappedDEK.nonce), ct: u8ToB64(envelope.wrappedDEK.ct) },
    payload: {
      nonce: u8ToB64(envelope.payload.nonce),
      ct: u8ToB64(envelope.payload.ct),
      tag: u8ToB64(envelope.payload.tag),
    },
  };
  return Buffer.from(JSON.stringify(serialized), 'utf8');
}

export function decryptTotpSecret(blob: Buffer): string {
  const parsed = JSON.parse(blob.toString('utf8')) as SerializedEnvelope;
  const envelope: Envelope = {
    version: parsed.version,
    kid: parsed.kid,
    kekVersion: parsed.kekVersion,
    wrappedDEK: { nonce: b64ToU8(parsed.wrappedDEK.nonce), ct: b64ToU8(parsed.wrappedDEK.ct) },
    payload: {
      nonce: b64ToU8(parsed.payload.nonce),
      ct: b64ToU8(parsed.payload.ct),
      tag: b64ToU8(parsed.payload.tag),
    },
  };
  const plaintext = decrypt(envelope, TOTP_AAD, loadTotpKek());
  return new TextDecoder().decode(plaintext);
}

export type TotpVerifyOutcome =
  { readonly ok: true; readonly step: number } | { readonly ok: false };

/**
 * Verify a 6-digit TOTP against the base32 secret with a past-step-only
 * window and strict replay rejection: any time step <= afterTimeStep (the
 * last successfully consumed step) is refused, so a captured code cannot be
 * replayed even inside its validity window.
 */
export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  afterTimeStep: number,
): Promise<TotpVerifyOutcome> {
  const { verify } = await import('otplib');
  const result = await verify({
    secret: secretBase32,
    token: code,
    epochTolerance: [TOTP_EPOCH_TOLERANCE[0], TOTP_EPOCH_TOLERANCE[1]],
    afterTimeStep,
  });
  if (!result.valid || !('epoch' in result)) return { ok: false };
  return { ok: true, step: Math.floor(result.epoch / TOTP_PERIOD_SEC) };
}
