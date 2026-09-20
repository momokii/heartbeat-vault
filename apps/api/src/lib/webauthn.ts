// WebAuthn RP configuration, session-bound challenge storage, and the
// DB-shape helpers shared by the registration and authentication routes.
//
// Challenges are stored per-session in sessions.webauthn_challenge as
// {"challenge":"<base64url>","issuedAt":<epoch ms>} with a 5-minute TTL —
// binding a challenge to exactly one session prevents cross-session replay
// and needs no extra table or cookie.
import { z } from 'zod';

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = 'Heartbeat Vault';

const KNOWN_TRANSPORTS = [
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;
export type Transport = (typeof KNOWN_TRANSPORTS)[number];

export type WebauthnConfig = {
  readonly rpID: string;
  readonly rpName: string;
  readonly origin: string;
};

export function webauthnConfig(): WebauthnConfig {
  return {
    rpID: process.env['WEBAUTHN_RP_ID'] ?? 'localhost',
    rpName: RP_NAME,
    origin: process.env['WEBAUTHN_ORIGIN'] ?? 'https://localhost',
  };
}

export function encodeStoredChallenge(challenge: string): string {
  return JSON.stringify({ challenge, issuedAt: Date.now() });
}

export type StoredChallenge = {
  readonly challenge: string;
  readonly fresh: boolean;
};

export function readStoredChallenge(raw: string | null): StoredChallenge | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { challenge?: unknown; issuedAt?: unknown };
    if (typeof parsed.challenge !== 'string' || typeof parsed.issuedAt !== 'number') {
      return null;
    }
    return {
      challenge: parsed.challenge,
      fresh: Date.now() - parsed.issuedAt <= WEBAUTHN_CHALLENGE_TTL_MS,
    };
  } catch {
    return null;
  }
}

// Comma-joined transports are only ever written from lib-verified responses;
// unknown future values are filtered out rather than cast into the union.
export function parseTransports(stored: string | null): Transport[] | undefined {
  if (!stored) return undefined;
  const parts = stored
    .split(',')
    .filter((t): t is Transport => (KNOWN_TRANSPORTS as readonly string[]).includes(t));
  return parts.length > 0 ? parts : undefined;
}

export type StoredCredential = {
  readonly id: string;
  readonly publicKey: Buffer;
  readonly counter: string;
  readonly transports: string | null;
};

export const registrationBodySchema = z.looseObject({
  type: z.string(),
  id: z.string(),
  rawId: z.string(),
  response: z.looseObject({ clientDataJSON: z.string() }),
});

export const authenticationBodySchema = registrationBodySchema.extend({
  response: z.looseObject({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
  }),
});
