import { hash, verify, hashRaw, hashRawSync, parseOptions } from '@node-rs/argon2';

const Algorithm = {
  Argon2d: 0,
  Argon2i: 1,
  Argon2id: 2,
} as const;

const Version = {
  V0x10: 0,
  V0x13: 1,
} as const;

export const ARGON2_MEMORY_COST = 19456 as const;
export const ARGON2_TIME_COST = 2 as const;
export const ARGON2_PARALLELISM = 1 as const;
export const ARGON2_SALT_LENGTH = 16 as const;
export const ARGON2_OUTPUT_LENGTH = 32 as const;

export type KdfOptions = {
  readonly requirePepper?: boolean;
};

function getPepperSecret(options?: KdfOptions): Buffer | undefined {
  const pepper = process.env.KEK_PEPPER;
  if (options?.requirePepper && (!pepper || pepper.length === 0)) {
    throw new Error('KEK_PEPPER required but not set (fail-closed)');
  }
  if (pepper && pepper.length > 0) {
    return Buffer.from(pepper, 'utf8');
  }
  return undefined;
}

export async function hashPassword(
  password: string,
  options?: KdfOptions,
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string');
  }
  const secret = getPepperSecret(options);
  const hashOptions: Record<string, unknown> = {
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    outputLen: ARGON2_OUTPUT_LENGTH,
  };
  if (secret) {
    hashOptions.secret = secret;
  }
  return hash(password, hashOptions as never);
}

export async function verifyPassword(
  phc: string,
  password: string,
  options?: KdfOptions,
): Promise<boolean> {
  if (typeof phc !== 'string' || phc.length === 0) {
    throw new Error('invalid PHC: empty');
  }
  if (!phc.startsWith('$argon2')) {
    throw new Error('invalid PHC: malformed argon2 hash');
  }
  if (typeof password !== 'string') {
    throw new Error('verifyPassword: password must be a string');
  }
  const secret = getPepperSecret(options);
  const verifyOptions: Record<string, unknown> = {};
  if (secret) {
    verifyOptions.secret = secret;
  }
  try {
    return await verify(phc, password, verifyOptions as never);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('invalid PHC') || msg.includes('malformed') || msg.includes('parsing')) {
      throw new Error(`invalid PHC: ${msg}`);
    }
    throw new Error(`invalid PHC: ${msg}`);
  }
}

export function needsRehash(phc: string): boolean {
  if (typeof phc !== 'string' || phc.length === 0) {
    throw new Error('invalid PHC: empty');
  }
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(phc);
  } catch (e) {
    throw new Error(`invalid PHC: ${(e as Error).message}`);
  }
  return (
    parsed.algorithm !== Algorithm.Argon2id ||
    parsed.version !== Version.V0x13 ||
    parsed.memoryCost !== ARGON2_MEMORY_COST ||
    parsed.timeCost !== ARGON2_TIME_COST ||
    parsed.parallelism !== ARGON2_PARALLELISM ||
    parsed.outputLen !== ARGON2_OUTPUT_LENGTH ||
    parsed.saltLen < ARGON2_SALT_LENGTH
  );
}

export function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
  options?: KdfOptions,
): Uint8Array {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('deriveKEK: passphrase must be a non-empty string');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== ARGON2_SALT_LENGTH) {
    throw new Error(`deriveKEK: salt must be ${ARGON2_SALT_LENGTH}-byte Uint8Array`);
  }
  const secret = getPepperSecret(options);
  const raw = hashRawSync(passphrase, {
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    salt: Buffer.from(salt),
    outputLen: ARGON2_OUTPUT_LENGTH,
    ...(secret ? { secret } : {}),
  } as never);
  return new Uint8Array(raw);
}

export async function deriveKEKAsync(
  passphrase: string,
  salt: Uint8Array,
  options?: KdfOptions,
): Promise<Uint8Array> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('deriveKEK: passphrase must be a non-empty string');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== ARGON2_SALT_LENGTH) {
    throw new Error(`deriveKEK: salt must be ${ARGON2_SALT_LENGTH}-byte Uint8Array`);
  }
  const secret = getPepperSecret(options);
  const raw = await hashRaw(passphrase, {
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    salt: Buffer.from(salt),
    outputLen: ARGON2_OUTPUT_LENGTH,
    ...(secret ? { secret } : {}),
  } as never);
  return new Uint8Array(raw);
}
