import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { PoolClient } from 'pg';

/**
 * Tamper-evident audit chain.
 * V2 hash = SHA256(prev_hash || '|' || ts.toISOString() || '|' || actorId || '|' || action || '|' || target || JCS(details))
 * Genesis prev_hash = 32 zero bytes. Uses the caller's transaction/client.
 */
export type AuditParams = {
  readonly actorId?: string | null;
  readonly action: string;
  readonly target?: string | null;
  readonly ip?: string | null;
  readonly requestId?: string | null;
  readonly details?: Record<string, unknown>;
};

const GENESIS = Buffer.alloc(32, 0);
const AUDIT_CHAIN_LOCK = 1_847_068_217;

/**
 * Centrally enforced audit-detail redaction. Any key naming credentials,
 * tokens, secrets, addresses, locators, payload material, or request
 * metadata is dropped recursively before persistence and before API
 * serialization, so caller convention alone never guards sensitive data.
 */
const SENSITIVE_DETAIL_KEY =
  /token|password|passwd|secret|hash|private|address|url|uri|endpoint|payload|cipher|envelope|dek|kek|otp|totp|cookie|session_token|request|seed|mnemonic|plaintext|signature|webhook|email|_ip$|^ip$|ip_address/i;

export function sanitizeAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditDetails);
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_DETAIL_KEY.test(key)) continue;
      clean[key] = sanitizeAuditDetails(entry);
    }
    return clean;
  }
  return value;
}

function canonicalizeDetails(details: Record<string, unknown>): string {
  const values: unknown[] = [details];
  while (values.length > 0) {
    const value = values.pop();
    if (value === undefined) {
      throw new TypeError('audit details must not contain undefined');
    }
    if (Array.isArray(value)) {
      values.push(...value);
    } else if (value !== null && typeof value === 'object') {
      values.push(...Object.values(value));
    }
  }
  return canonicalize(details);
}

export async function writeAudit(
  client: PoolClient,
  params: AuditParams,
): Promise<{ readonly id: number; readonly hash: Buffer; readonly prevHash: Buffer }> {
  const {
    actorId = null,
    action,
    target = null,
    ip = null,
    requestId = null,
    details = {},
  } = params;

  const sanitized = sanitizeAuditDetails(details);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    throw new TypeError('audit details must be a JSON object');
  }
  const cleanDetails = sanitized as Record<string, unknown>;

  // SAVEPOINT succeeds only inside a caller-owned transaction block, so a
  // bare-client caller fails fast here instead of forking the hash chain.
  // (txid_current_if_assigned() stays null for read-only statements and
  // cannot reliably detect a transaction block.)
  try {
    await client.query('SAVEPOINT hv_audit_guard');
    await client.query('RELEASE SAVEPOINT hv_audit_guard');
  } catch {
    throw new Error('writeAudit requires an active caller transaction');
  }
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK]);
  const prevRes = await client.query<{ hash: Buffer }>(
    `SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`,
  );
  const prevHash = prevRes.rows[0]?.hash ?? GENESIS;

  const ts = new Date();
  const hash = computeAuditHash(prevHash, ts, actorId, action, target, cleanDetails);

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO audit_log (ts, actor_id, action, target, ip, request_id, details, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ts, actorId, action, target, ip, requestId, cleanDetails, prevHash, hash],
  );

  return { id: inserted.rows[0]!.id, hash, prevHash };
}

export function computeAuditHash(
  prevHash: Buffer,
  ts: Date,
  actorId: string | null,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update('|')
    .update(ts.toISOString())
    .update('|')
    .update(actorId ?? '')
    .update('|')
    .update(action)
    .update('|')
    .update(target ?? '')
    .update(Buffer.from(canonicalizeDetails(details), 'utf8'))
    .digest();
}

export const AUDIT_GENESIS = GENESIS;
