// MASTER_KEY → 32-byte KEK for envelope encryption of TOTP secrets.
//
// MASTER_KEY env formats accepted (first match wins):
//   - 64 hex chars (32 bytes)
//   - base64 / base64url that decodes to exactly 32 bytes
// The parsed key is cached after first successful load. Missing or malformed
// MASTER_KEY fails closed at first use (500 on the affected route, never a
// plaintext fallback).
import { memzero } from '@heartbeat-vault/crypto';

let cached: Uint8Array | null = null;

export function loadTotpKek(): Uint8Array {
  if (cached) return cached;
  const raw = process.env['MASTER_KEY'];
  if (!raw || raw.length === 0) {
    throw new Error('MASTER_KEY env is required for TOTP secret encryption');
  }
  let key: Uint8Array | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = new Uint8Array(Buffer.from(raw, 'hex'));
  } else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) {
      key = new Uint8Array(decoded);
    }
  }
  if (!key || key.length !== 32) {
    throw new Error('MASTER_KEY must decode to exactly 32 bytes (hex or base64)');
  }
  cached = key;
  return cached;
}

/** Test-only: drop the cached KEK so a new MASTER_KEY can be picked up. */
export function resetKekCacheForTests(): void {
  if (cached) memzero(cached);
  cached = null;
}
