import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  checkInAll,
  createActiveSwitch,
  createOwner,
  createUser,
  enableTotp,
  pool,
  startHarness,
  stopHarness,
  totpLogin,
  truncateAll,
} from './bulk-check-in.test-support.js';

type BulkResult = {
  readonly switchId: string;
  readonly ok: boolean;
  readonly error?: string;
};

function authCookie(cookie: string): { readonly cookie: string } {
  return { cookie: `__Host-session=${cookie}` };
}

beforeAll(startHarness, 180_000);
afterAll(stopHarness);
beforeEach(truncateAll);

describe('bulk manual check-in', () => {
  it('checks in every active switch owned by the caller with per-switch results', async () => {
    const ownerCookie = await createOwner('bulk-owner@example.com');
    const firstSwitchId = await createActiveSwitch(ownerCookie, 'bulk-first');
    const secondSwitchId = await createActiveSwitch(ownerCookie, 'bulk-second');

    const response = await checkInAll(ownerCookie, [firstSwitchId, secondSwitchId]);

    expect(response.statusCode).toBe(200);
    const results = JSON.parse(response.body) as BulkResult[];
    expect(results).toEqual([
      { switchId: firstSwitchId, ok: true },
      { switchId: secondSwitchId, ok: true },
    ]);
    const heartbeats = await pool.query(
      `SELECT switch_id FROM heartbeats WHERE switch_id = ANY($1::uuid[])`,
      [[firstSwitchId, secondSwitchId]],
    );
    expect(heartbeats.rows).toHaveLength(2);
  });

  it('returns one not-found result for paused, unauthorized, and missing switches', async () => {
    const ownerCookie = await createOwner('bulk-owner@example.com');
    const otherOwnerCookie = await createOwner('bulk-other@example.com');
    const activeSwitchId = await createActiveSwitch(ownerCookie, 'bulk-active');
    const pausedSwitchId = await createActiveSwitch(ownerCookie, 'bulk-paused');
    const otherOwnerSwitchId = await createActiveSwitch(otherOwnerCookie, 'bulk-other');
    await app.inject({
      method: 'POST',
      url: `/api/switches/${pausedSwitchId}/disarm`,
      headers: authCookie(ownerCookie),
    });
    const missingSwitchId = '00000000-0000-4000-8000-000000000000';

    const response = await checkInAll(ownerCookie, [
      activeSwitchId,
      pausedSwitchId,
      otherOwnerSwitchId,
      missingSwitchId,
    ]);

    expect(response.statusCode).toBe(200);
    const results = JSON.parse(response.body) as BulkResult[];
    expect(results).toEqual([
      { switchId: activeSwitchId, ok: true },
      { switchId: pausedSwitchId, ok: false, error: 'not_found' },
      { switchId: otherOwnerSwitchId, ok: false, error: 'not_found' },
      { switchId: missingSwitchId, ok: false, error: 'not_found' },
    ]);
    const untouched = await pool.query(
      `SELECT id FROM heartbeats WHERE switch_id = ANY($1::uuid[])`,
      [[pausedSwitchId, otherOwnerSwitchId]],
    );
    expect(untouched.rows).toHaveLength(0);
  });

  it('writes exactly one heartbeat audit row per processed switch', async () => {
    const ownerCookie = await createOwner('bulk-audit@example.com');
    const switchIds = [
      await createActiveSwitch(ownerCookie, 'bulk-audit-first'),
      await createActiveSwitch(ownerCookie, 'bulk-audit-second'),
      await createActiveSwitch(ownerCookie, 'bulk-audit-third'),
    ];

    const response = await checkInAll(ownerCookie, switchIds);

    expect(response.statusCode).toBe(200);
    const auditRows = await pool.query(
      `SELECT target FROM audit_log
       WHERE action='heartbeat_checkin' AND target = ANY($1::uuid[])`,
      [switchIds],
    );
    expect(auditRows.rows).toHaveLength(switchIds.length);
  });

  it('requires a TOTP step-up for an owner with 2FA enabled', async () => {
    const ownerId = await createUser('bulk-totp@example.com');
    const secret = await enableTotp(ownerId);
    const steppedUpCookie = await totpLogin('bulk-totp@example.com', secret);
    const switchId = await createActiveSwitch(steppedUpCookie, 'bulk-totp-switch');

    const response = await checkInAll(steppedUpCookie, [switchId]);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body) as { error: string }).toMatchObject({
      error: 'totp_required',
    });
  });

  it('rejects unauthenticated bulk check-in requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/switches/check-in/all',
      payload: { switchIds: [] },
    });

    expect(response.statusCode).toBe(401);
  });
});
