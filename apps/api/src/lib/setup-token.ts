import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function generateSetupToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifySetupTokenHash(token: string, expectedHex: string): boolean {
  if (typeof token !== 'string' || typeof expectedHex !== 'string') return false;
  if (expectedHex.length === 0) return false;
  const actualHex = hashSetupToken(token);
  const actualBuf = Buffer.from(actualHex, 'utf8');
  const expectedBuf = Buffer.from(expectedHex, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}
