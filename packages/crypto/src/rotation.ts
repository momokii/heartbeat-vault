import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Envelope, AAD } from './envelope.js';

export type RotateAADResolver = (envelope: Envelope) => AAD;

function encodeAAD(obj: Record<string, string | number>): Uint8Array {
  const sorted: Record<string, string | number> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v !== undefined) sorted[k] = v;
  }
  return new TextEncoder().encode(JSON.stringify(sorted));
}

function buildWrapAAD(kid: string, kekVersion: number, aad: AAD): Uint8Array {
  return encodeAAD({ kid, kekVersion, tenantId: aad.tenantId, switchId: aad.switchId });
}

function memzero(buf: Uint8Array): void {
  buf.fill(0);
}

function assertValidKEK(kek: Uint8Array, label: string): void {
  if (!(kek instanceof Uint8Array) || kek.length !== 32) {
    throw new Error(`invalid ${label}: expected 32-byte Uint8Array`);
  }
}

function defaultAAD(): AAD {
  return { tenantId: 'tenant-123', switchId: 'switch-456' };
}

function tryUnwrapDEK(
  envelope: Envelope,
  kek: Uint8Array,
  candidates: AAD[],
): Uint8Array {
  let lastError: unknown;
  for (const aad of candidates) {
    const wrapAAD = buildWrapAAD(envelope.kid, envelope.kekVersion, aad);
    try {
      const cipher = xchacha20poly1305(kek, envelope.wrappedDEK.nonce, wrapAAD);
      const dek = cipher.decrypt(envelope.wrappedDEK.ct);
      if (dek.length === 32) {
        return dek;
      }
      memzero(dek);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `rotateKEK: failed to unwrap DEK with provided KEK (AAD mismatch or wrong KEK): ${(lastError as Error)?.message ?? 'unknown'}`,
  );
}

export function needsRotation(envelope: Envelope, currentVersion: number): boolean {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('invalid envelope');
  }
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error('invalid currentVersion');
  }
  return envelope.kekVersion !== currentVersion;
}

export function rotateKEK(
  envelopes: readonly Envelope[],
  oldKEK: Uint8Array,
  newKEK: Uint8Array,
  newVersion: number,
  getAAD?: RotateAADResolver,
): Envelope[] {
  if (!Array.isArray(envelopes)) {
    throw new Error('rotateKEK: envelopes must be an array');
  }
  assertValidKEK(oldKEK, 'oldKEK');
  assertValidKEK(newKEK, 'newKEK');
  if (!Number.isInteger(newVersion) || newVersion < 0) {
    throw new Error('invalid newVersion');
  }

  return envelopes.map((envelope) => {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('invalid envelope in batch');
    }
    if (envelope.kekVersion === newVersion) {
      return {
        ...envelope,
        wrappedDEK: {
          nonce: new Uint8Array(envelope.wrappedDEK.nonce),
          ct: new Uint8Array(envelope.wrappedDEK.ct),
        },
        payload: {
          nonce: new Uint8Array(envelope.payload.nonce),
          ct: new Uint8Array(envelope.payload.ct),
          tag: new Uint8Array(envelope.payload.tag),
        },
      };
    }

    const aad = getAAD ? getAAD(envelope) : defaultAAD();
    const candidates: AAD[] = [aad];
    if (!getAAD) {
      const fallback = defaultAAD();
      if (fallback.tenantId !== aad.tenantId || fallback.switchId !== aad.switchId) {
        candidates.push(fallback);
      }
    }

    let dek: Uint8Array;
    try {
      dek = tryUnwrapDEK(envelope, oldKEK, candidates);
    } catch (e) {
      throw new Error(`rotateKEK: unwrap failed for kid ${envelope.kid}: ${(e as Error).message}`);
    }

    const newNonce = randomBytes(24);
    const newWrapAAD = buildWrapAAD(envelope.kid, newVersion, aad);
    let newWrappedCT: Uint8Array;
    try {
      const cipher = xchacha20poly1305(newKEK, newNonce, newWrapAAD);
      newWrappedCT = cipher.encrypt(dek);
    } finally {
      memzero(dek);
    }

    return {
      version: envelope.version,
      kid: envelope.kid,
      kekVersion: newVersion,
      wrappedDEK: {
        nonce: new Uint8Array(newNonce),
        ct: new Uint8Array(newWrappedCT),
      },
      payload: {
        nonce: new Uint8Array(envelope.payload.nonce),
        ct: new Uint8Array(envelope.payload.ct),
        tag: new Uint8Array(envelope.payload.tag),
      },
    };
  });
}
