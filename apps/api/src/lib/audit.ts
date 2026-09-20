import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Tamper-evident audit chain.
 * Hash = SHA256(prev_hash || '|' || ts.toISOString() || '|' || actorId || '|' || action || '|' || target)
 * Genesis prev_hash = 32 zero bytes. Uses the caller's transaction/client.
 */
export type AuditParams = {
  readonly actorId?: string | null;
  readonly action: string;
  readonly target?: string | null;
  readonly ip?: string | null;
  readonly requestId?: string | null;
};

const GENESIS = Buffer.alloc(32, 0);

export async function writeAudit(
  client: PoolClient,
  params: AuditParams,
): Promise<{ readonly id: number; readonly hash: Buffer; readonly prevHash: Buffer }> {
  const { actorId = null, action, target = null, ip = null, requestId = null } = params;

  const prevRes = await client.query<{ hash: Buffer }>(
    `SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`,
  );
  const prevHash: Buffer =
    prevRes.rows.length > 0 && prevRes.rows[0]!.hash ? (prevRes.rows[0]!.hash as Buffer) : GENESIS;

  const ts = new Date();

  const hash = createHash('sha256')
    .update(prevHash)
    .update('|')
    .update(ts.toISOString())
    .update('|')
    .update(actorId ?? '')
    .update('|')
    .update(action)
    .update('|')
    .update(target ?? '')
    .digest();

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO audit_log (ts, actor_id, action, target, ip, request_id, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ts, actorId, action, target, ip, requestId, prevHash, hash],
  );

  return { id: inserted.rows[0]!.id as number, hash, prevHash };
}

export function computeAuditHash(
  prevHash: Buffer,
  ts: Date,
  actorId: string | null,
  action: string,
  target: string | null,
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
    .digest();
}

export const AUDIT_GENESIS = GENESIS;
