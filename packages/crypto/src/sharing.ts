/**
 * Heartbeat Vault — Shamir Secret Sharing + BLAKE2b Commitment (T2.4)
 *
 * Library: shamir-secret-sharing@0.0.4 (privy-io, pinned exact).
 * Audit pedigree: Cure53 Jan 2023 (PVY-01, 2 senior testers) + Zellic audit.
 *   Cure53: "well-written, good best-practices" — 1 high (degree < t-1 fixed),
 *   2 info (LUT cache side-channel). Assumes honest dealer/participants; no VSS.
 *   Corrupt-share detection via higher-level hash check (we add BLAKE2b commitment).
 *
 * Threshold: t-of-n over GF(2⁸), 2<=t<=n<=255. Shares are Uint8Array with 1-byte
 * x-coord prefix (last byte). Combine requires >=t shares; <t yields wrong secret
 * (detectable via commitment). Validation enforces range pre-delegation.
 *
 * Commitment: BLAKE2b(secret) via @noble/hashes@1.8.0 (pinned exact). BLAKE2b
 * audited as part of noble-hashes (BLAKE family). Provides honest-dealer check:
 * dealer publishes commitment; after combine, recipients verify.
 */

import { split, combine } from 'shamir-secret-sharing';
import { blake2b } from '@noble/hashes/blake2b.js';
import { equalBytes } from '@noble/ciphers/utils.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidNThreshold(n: number, t: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(t)) {
    throw new Error('invalid n/t: must be integers');
  }
  if (n < 2 || n > 255) {
    throw new Error('invalid n: must be 2..255');
  }
  if (t < 2 || t > 255) {
    throw new Error('invalid t: must be 2..255');
  }
  if (t > n) {
    throw new Error('invalid t: must be <= n');
  }
}

function assertValidSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength === 0) {
    throw new Error('invalid secret: expected non-empty Uint8Array');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split `secret` into `n` shares with threshold `t`.
 * Validates 2<=t<=n<=255 then delegates to shamir-secret-sharing `split`.
 */
export async function splitSecret(
  secret: Uint8Array,
  n: number,
  t: number,
): Promise<Uint8Array[]> {
  assertValidSecret(secret);
  assertValidNThreshold(n, t);
  const shares = await split(secret, n, t);
  return shares.map((s) => new Uint8Array(s));
}

/**
 * Combine `shares` to reconstruct the secret.
 * Pass-through to shamir-secret-sharing `combine` with basic length checks.
 * Note: combining <t shares will either throw or produce a wrong secret —
 * caller MUST verify via `verifyCommitment`.
 */
export async function combineShares(shares: Uint8Array[]): Promise<Uint8Array> {
  if (!Array.isArray(shares) || shares.length < 2) {
    throw new Error('invalid shares: need at least 2 shares');
  }
  if (shares.length > 255) {
    throw new Error('invalid shares: at most 255 shares');
  }
  for (const s of shares) {
    if (!(s instanceof Uint8Array) || s.byteLength < 2) {
      throw new Error('invalid share: expected Uint8Array with >=2 bytes');
    }
  }
  const secret = await combine(shares);
  return new Uint8Array(secret);
}

/**
 * Create a BLAKE2b commitment (hash) of `secret`.
 * Uses 64-byte (512-bit) BLAKE2b digest — deterministic, no key.
 */
export function createCommitment(secret: Uint8Array): Uint8Array {
  assertValidSecret(secret);
  return blake2b(secret);
}

/**
 * Verify a secret against a BLAKE2b commitment (constant-time compare).
 * Returns true iff BLAKE2b(secret) === commitment.
 */
export function verifyCommitment(
  secret: Uint8Array,
  commitment: Uint8Array,
): boolean {
  if (!(secret instanceof Uint8Array) || !(commitment instanceof Uint8Array)) {
    throw new Error('verifyCommitment: expected Uint8Array for secret and commitment');
  }
  if (commitment.length !== 64) {
    return false;
  }
  const computed = blake2b(secret);
  return equalBytes(computed, commitment);
}
