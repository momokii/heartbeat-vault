// Switches CRUD + arming guards + recipients + sealed payload storage (T4.1).
//
// Security posture:
// - Owner-scoped, default-deny; non-owner access is a generic 404 (no enumeration).
// - Arming is a separate explicit action with transactional guards:
//     >=1 accepted recipient, a sealed payload, and — for fail_deadly — an
//     exact switch-id typed confirmation (ADR-003).
// - Payload plaintext is envelope-encrypted (ADR-005) and never logged.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { encrypt } from '@heartbeat-vault/crypto';
import { loadTotpKek } from '../lib/kek.js';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const SWITCH_KID = 'switch';
const SWITCH_KEK_VERSION = 1;
const SWITCH_TITLE_UNIQUE_CONSTRAINT = 'switches_owner_id_title_unique';

const createSchema = z.object({
  title: z.string().min(1).max(200),
  mode: z.enum(['asymmetric_key', 'direct_delivery']),
  heartbeatIntervalHours: z.number().int().min(24).max(2160),
  graceWindowHours: z.number().int().min(2),
  dryRun: z.boolean().optional().default(false),
  releasePolicy: z.enum(['fail_safe', 'fail_deadly']).optional().default('fail_safe'),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  heartbeatIntervalHours: z.number().int().min(24).max(2160).optional(),
  graceWindowHours: z.number().int().min(2).optional(),
  dryRun: z.boolean().optional(),
});

const payloadSchema = z.object({
  plaintext: z.string().min(1).max(1_000_000),
});

const recipientSchema = z.object({
  channel: z.enum(['email', 'webhook', 'telegram']),
  address: z.string().min(1).max(500),
});

const armSchema = z.object({
  confirm: z.literal(true),
  failDeadlyConfirmation: z.string().optional(),
});

const uuidSchema = z.string().uuid();

type SwitchRow = {
  id: string;
  owner_id: string;
  title: string;
  mode: string;
  status: string;
  heartbeat_interval: string;
  grace_window: string;
  dry_run: boolean;
  release_policy: string;
  heartbeat_started_at: Date | null;
  next_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
  owner_email?: string | null;
};

function intervalToHours(pgInterval: string): number {
  // Postgres interval like '336 days' or '24:00:00' → hours.
  const days = /(\d+)\s+days?/.exec(pgInterval);
  const time = /(\d+):(\d+):(\d+)/.exec(pgInterval);
  let hours = 0;
  if (days) hours += Number(days[1]) * 24;
  if (time) hours += Number(time[1]) + Number(time[2]) / 60 + Number(time[3]) / 3600;
  return Math.round(hours);
}

function serializeSwitch(row: SwitchRow, includeOwnerEmail = false) {
  const serialized = {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    heartbeatIntervalHours: intervalToHours(row.heartbeat_interval),
    graceWindowHours: intervalToHours(row.grace_window),
    dryRun: row.dry_run,
    releasePolicy: row.release_policy,
    heartbeatStartedAt: row.heartbeat_started_at?.toISOString() ?? null,
    nextDeadline: row.next_deadline?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  return includeOwnerEmail ? { ...serialized, ownerEmail: row.owner_email ?? null } : serialized;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isDuplicateSwitchTitleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === '23505' &&
    Reflect.get(error, 'constraint') === SWITCH_TITLE_UNIQUE_CONSTRAINT
  );
}

export async function loadSwitch(
  pool: Pool,
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<SwitchRow | null> {
  const res = await pool.query<SwitchRow>(
    `SELECT id, owner_id, title, mode, status, heartbeat_interval::text, grace_window::text,
            dry_run, release_policy, heartbeat_started_at, next_deadline, created_at, updated_at
     FROM switches WHERE id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!isAdmin && row.owner_id !== userId) return null;
  return row;
}

export async function registerSwitchRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post('/api/switches', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const d = parsed.data;
    const user = request.user!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window, dry_run, release_policy)
         VALUES ($1,$2,$3,'paused', make_interval(hours => $4::int), make_interval(hours => $5::int), $6, $7)
         RETURNING id`,
        [
          user.id,
          d.title,
          d.mode,
          d.heartbeatIntervalHours,
          d.graceWindowHours,
          d.dryRun,
          d.releasePolicy,
        ],
      );
      const id = res.rows[0]!.id;
      await writeAudit(client, {
        actorId: user.id,
        action: 'switch_created',
        target: id,
        ip: request.ip,
        requestId: request.id,
        details: {
          title: d.title,
          mode: d.mode,
          status: 'paused',
          heartbeatIntervalHours: d.heartbeatIntervalHours,
          graceWindowHours: d.graceWindowHours,
          dryRun: d.dryRun,
          releasePolicy: d.releasePolicy,
        },
      });
      await client.query('COMMIT');
      return reply.status(201).send({ id, status: 'paused', dryRun: d.dryRun });
    } catch (err) {
      await client.query('ROLLBACK');
      if (isDuplicateSwitchTitleError(err)) {
        return reply.status(409).send({ error: 'duplicate_title' });
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });

  app.get('/api/switches', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    const all = (request.query as Record<string, string | undefined>)?.['all'] === '1';
    const res =
      all && user.role === 'admin'
        ? await pool.query<SwitchRow>(
            `SELECT switches.id, switches.owner_id, switches.title, switches.mode, switches.status,
                    switches.heartbeat_interval::text, switches.grace_window::text, switches.dry_run,
                    switches.release_policy, switches.heartbeat_started_at, switches.next_deadline,
                    switches.created_at, switches.updated_at, users.email AS owner_email
             FROM switches
             LEFT JOIN users ON users.id=switches.owner_id
             ORDER BY switches.created_at`,
          )
        : await pool.query<SwitchRow>(
            `SELECT id, owner_id, title, mode, status, heartbeat_interval::text, grace_window::text,
                    dry_run, release_policy, heartbeat_started_at, next_deadline, created_at, updated_at
             FROM switches WHERE owner_id=$1 ORDER BY created_at`,
            [user.id],
          );
    return reply
      .status(200)
      .send(res.rows.map(row => serializeSwitch(row, all && user.role === 'admin')));
  });

  app.get('/api/switches/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    return reply.status(200).send(serializeSwitch(row));
  });

  app.patch('/api/switches/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const d = parsed.data;
    const changes: Record<
      string,
      { readonly from: string | number | boolean; readonly to: string | number | boolean }
    > = {};
    const previousHeartbeatIntervalHours = intervalToHours(row.heartbeat_interval);
    const previousGraceWindowHours = intervalToHours(row.grace_window);
    if (d.title !== undefined && d.title !== row.title)
      changes['title'] = { from: row.title, to: d.title };
    if (
      d.heartbeatIntervalHours !== undefined &&
      d.heartbeatIntervalHours !== previousHeartbeatIntervalHours
    ) {
      changes['heartbeatIntervalHours'] = {
        from: previousHeartbeatIntervalHours,
        to: d.heartbeatIntervalHours,
      };
    }
    if (d.graceWindowHours !== undefined && d.graceWindowHours !== previousGraceWindowHours) {
      changes['graceWindowHours'] = { from: previousGraceWindowHours, to: d.graceWindowHours };
    }
    if (d.dryRun !== undefined && d.dryRun !== row.dry_run)
      changes['dryRun'] = { from: row.dry_run, to: d.dryRun };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE switches SET
           title = COALESCE($1, title),
           heartbeat_interval = COALESCE(make_interval(hours => $2::int), heartbeat_interval),
           grace_window = COALESCE(make_interval(hours => $3::int), grace_window),
           dry_run = COALESCE($4, dry_run),
           updated_at = clock_timestamp()
         WHERE id=$5`,
        [
          d.title ?? null,
          d.heartbeatIntervalHours ?? null,
          d.graceWindowHours ?? null,
          d.dryRun ?? null,
          id.data,
        ],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'switch_updated',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details:
          Object.keys(changes).length > 0 ? { changes } : { changes, noEffectiveChanges: true },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (isDuplicateSwitchTitleError(err)) {
        return reply.status(409).send({ error: 'duplicate_title' });
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    const fresh = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    return reply.status(200).send(serializeSwitch(fresh!));
  });

  app.delete('/api/switches/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.status === 'released') {
      return reply.status(409).send({ error: 'released_immutable' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM switches WHERE id=$1`, [id.data]);
      await writeAudit(client, {
        actorId: user.id,
        action: 'switch_deleted',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details: { title: row.title, mode: row.mode, status: row.status },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/switches/:id/arm', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = armSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.status === 'active') {
      return reply.status(409).send({ error: 'arm_blocked', reason: 'already_active' });
    }
    if (row.release_policy === 'fail_deadly' && parsed.data.failDeadlyConfirmation !== row.id) {
      return reply.status(409).send({ error: 'arm_blocked', reason: 'confirmation_required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM switches WHERE id=$1 FOR UPDATE`, [id.data]);
      const recip = await client.query<{ total: string; accepted: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status='accepted')::text AS accepted
         FROM recipients WHERE switch_id=$1`,
        [id.data],
      );
      const counts = recip.rows[0]!;
      if (Number(counts.total) < 1 || Number(counts.accepted) < 1) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'arm_blocked', reason: 'no_accepted_recipient' });
      }
      const payload = await client.query<{ id: string }>(
        `SELECT id FROM sealed_payloads WHERE switch_id=$1`,
        [id.data],
      );
      if (payload.rows.length < 1) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'arm_blocked', reason: 'no_payload' });
      }
      await client.query(
        `UPDATE switches SET status='active',
            heartbeat_started_at = clock_timestamp(),
            next_deadline = clock_timestamp() + heartbeat_interval,
            updated_at = clock_timestamp()
          WHERE id=$1`,
        [id.data],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'switch_armed',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details: {
          fromStatus: row.status,
          toStatus: 'active',
          acceptedRecipientCount: Number(counts.accepted),
          hasPayload: true,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true, status: 'active' });
  });

  app.post('/api/switches/:id/disarm', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE switches SET status='paused', next_deadline=NULL, updated_at=clock_timestamp()
         WHERE id=$1 AND status IN ('active','paused')`,
        [id.data],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'switch_disarmed',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details: { fromStatus: row.status, toStatus: 'paused' },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true, status: 'paused' });
  });

  app.post('/api/switches/:id/payload', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = payloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.status === 'released') {
      return reply.status(409).send({ error: 'released_immutable' });
    }
    const aad = { tenantId: 'default', switchId: id.data } as const;
    const envelope = encrypt(
      new TextEncoder().encode(parsed.data.plaintext),
      aad,
      loadTotpKek(),
      SWITCH_KID,
      SWITCH_KEK_VERSION,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingPayload = await client.query<{ id: string }>(
        `SELECT id FROM sealed_payloads WHERE switch_id=$1 FOR UPDATE`,
        [id.data],
      );
      await client.query(
        `INSERT INTO sealed_payloads (switch_id, kid, kek_version, wrapped_dek_nonce, wrapped_dek_ct,
            payload_nonce, payload_ct, payload_tag, aad)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (switch_id) DO UPDATE SET
            kid=EXCLUDED.kid, kek_version=EXCLUDED.kek_version,
            wrapped_dek_nonce=EXCLUDED.wrapped_dek_nonce, wrapped_dek_ct=EXCLUDED.wrapped_dek_ct,
            payload_nonce=EXCLUDED.payload_nonce, payload_ct=EXCLUDED.payload_ct,
            payload_tag=EXCLUDED.payload_tag, aad=EXCLUDED.aad`,
        [
          id.data,
          envelope.kid,
          envelope.kekVersion,
          Buffer.from(envelope.wrappedDEK.nonce),
          Buffer.from(envelope.wrappedDEK.ct),
          Buffer.from(envelope.payload.nonce),
          Buffer.from(envelope.payload.ct),
          Buffer.from(envelope.payload.tag),
          JSON.stringify(aad),
        ],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'payload_stored',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details: { mode: row.mode, replaced: existingPayload.rows.length > 0 },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply
      .status(201)
      .send({ storedBytes: Buffer.byteLength(parsed.data.plaintext, 'utf8') });
  });

  app.post('/api/switches/:id/recipients', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = recipientSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const inviteToken = randomBytes(32).toString('base64url');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO recipients (switch_id, channel, address, status, invite_token_hash)
         VALUES ($1,$2,$3,'invited',$4) RETURNING id`,
        [id.data, parsed.data.channel, parsed.data.address, hashToken(inviteToken)],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'recipient_invited',
        target: res.rows[0]!.id,
        ip: request.ip,
        requestId: request.id,
        details: { channel: parsed.data.channel, status: 'pending' },
      });
      await client.query('COMMIT');
      return reply.status(201).send({ id: res.rows[0]!.id, inviteToken });
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });

  app.get('/api/switches/:id/recipients', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const res = await pool.query<{
      id: string;
      channel: string;
      address: string;
      status: string;
      verified_at: Date | null;
    }>(
      `SELECT id, channel, address, status, verified_at FROM recipients WHERE switch_id=$1 ORDER BY created_at`,
      [id.data],
    );
    return reply.status(200).send(
      res.rows.map(r => ({
        id: r.id,
        channel: r.channel,
        address: r.address,
        status: r.status,
        verifiedAt: r.verified_at?.toISOString() ?? null,
      })),
    );
  });

  app.delete(
    '/api/switches/:id/recipients/:rid',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = request.params as Record<string, string>;
      const id = uuidSchema.safeParse(params['id']);
      const rid = uuidSchema.safeParse(params['rid']);
      if (!id.success || !rid.success) return reply.status(404).send({ error: 'not_found' });
      const user = request.user!;
      const row = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
      if (!row) return reply.status(404).send({ error: 'not_found' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const recipient = await client.query<{ channel: string; status: string }>(
          `SELECT channel, status FROM recipients WHERE id=$1 AND switch_id=$2 FOR UPDATE`,
          [rid.data, id.data],
        );
        const previousRecipient = recipient.rows[0];
        if (!previousRecipient) {
          await client.query('ROLLBACK');
          return reply.status(404).send({ error: 'not_found' });
        }
        await client.query(`DELETE FROM recipients WHERE id=$1 AND switch_id=$2`, [
          rid.data,
          id.data,
        ]);
        await writeAudit(client, {
          actorId: user.id,
          action: 'recipient_deleted',
          target: rid.data,
          ip: request.ip,
          requestId: request.id,
          details: { channel: previousRecipient.channel, previousStatus: previousRecipient.status },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
      return reply.status(200).send({ ok: true });
    },
  );

  app.post('/api/recipients/accept', async (request, reply) => {
    // Public endpoint (recipient has no account) — IP rate-limited.
    const limit = checkRateLimit(request.ip, '2fa');
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(limit.retryAfterSec ?? 60))
        .send({ error: 'rate_limited' });
    }
    const parsed = z.object({ token: z.string().min(16).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const tokenHash = hashToken(parsed.data.token);
    const res = await pool.query<{ id: string; channel: string; status: string; title: string }>(
      `SELECT r.id, r.channel, r.status, s.title
       FROM recipients r JOIN switches s ON s.id = r.switch_id
       WHERE r.invite_token_hash=$1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) return reply.status(400).send({ error: 'invalid_request' });
    if (row.status !== 'accepted') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE recipients SET status='accepted', verified_at=clock_timestamp() WHERE id=$1 AND status='invited'`,
          [row.id],
        );
        await writeAudit(client, {
          action: 'recipient_accepted',
          target: row.id,
          ip: request.ip,
          requestId: request.id,
          details: { channel: row.channel, status: 'accepted' },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
    }
    return reply.status(200).send({ switchTitle: row.title });
  });
}
