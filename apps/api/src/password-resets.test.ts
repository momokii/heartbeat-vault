import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createPasswordResetTestHarness, firstRow } from './password-resets.test-support.js';

const RESET_TTL_MS = 24 * 60 * 60 * 1000;

const issuedResetSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
});
const invalidRequestSchema = z.object({ error: z.literal('invalid_request') });
const notFoundSchema = z.object({ error: z.literal('not_found') });
const successSchema = z.object({ ok: z.literal(true) });
const rateLimitedSchema = z.object({ error: z.literal('rate_limited') });
type IssuanceContext = {
  readonly adminId: string;
  readonly targetId: string;
  readonly adminCookie: string;
};

async function createIssuanceContext(): Promise<IssuanceContext> {
  const adminId = await harness.createUser(
    'reset-admin@example.com',
    'admin-password-123',
    'admin',
  );
  const targetId = await harness.createUser('reset-target@example.com', 'target-password-123');
  const adminCookie = await harness.loginAs('reset-admin@example.com', 'admin-password-123');
  return { adminId, targetId, adminCookie };
}

let harness: Awaited<ReturnType<typeof createPasswordResetTestHarness>>;

describe('admin-issued password resets', () => {
  beforeAll(async () => {
    harness = await createPasswordResetTestHarness();
  }, 180000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('issues a 24-hour hash-only reset token and records its audit event', async () => {
    // Given an authenticated administrator and an existing target user.
    const { adminId, targetId, adminCookie } = await createIssuanceContext();

    // When the administrator issues a reset for the target user.
    const response = await harness.issueReset(targetId, adminCookie);

    // Then the one-time token, expiry, stored hash, and audit record follow the contract.
    expect(response.statusCode).toBe(201);
    const body = issuedResetSchema.parse(JSON.parse(response.body));
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const reset = firstRow(
      (
        await harness.pool.query<{
          id: string;
          token_hash: string;
          expires_at: Date;
          created_at: Date;
          user_id: string;
          created_by: string | null;
        }>(
          `SELECT id, token_hash, expires_at, created_at, user_id, created_by
           FROM password_resets WHERE id = $1`,
          [body.id],
        )
      ).rows,
    );
    expect(body.expiresAt).toBe(reset.expires_at.toISOString());
    expect(reset.token_hash).toBe(createHash('sha256').update(body.token, 'utf8').digest('hex'));
    expect(reset.token_hash).toHaveLength(64);
    expect(reset.token_hash).not.toBe(body.token);
    expect(reset.expires_at.getTime() - reset.created_at.getTime()).toBeGreaterThanOrEqual(
      RESET_TTL_MS - 1000,
    );
    expect(reset.expires_at.getTime() - reset.created_at.getTime()).toBeLessThanOrEqual(
      RESET_TTL_MS + 1000,
    );
    expect(reset.user_id).toBe(targetId);
    expect(reset.created_by).toBe(adminId);

    const audit = firstRow(
      (
        await harness.pool.query<{
          action: string;
          actor_id: string | null;
          target: string | null;
          details: Record<string, unknown>;
        }>(
          `SELECT action, actor_id, target, details FROM audit_log
           WHERE action = 'password_reset_issued' AND target = $1`,
          [body.id],
        )
      ).rows,
    );
    expect(audit).toEqual({
      action: 'password_reset_issued',
      actor_id: adminId,
      target: body.id,
      details: { expiresInHours: 24 },
    });
  });

  it('rejects a non-admin issuing a reset', async () => {
    // Given an authenticated standard user and an existing target user.
    const targetId = await harness.createUser(
      'forbidden-target@example.com',
      'target-password-123',
    );
    await harness.createUser('standard-user@example.com', 'standard-password-123');
    const userCookie = await harness.loginAs('standard-user@example.com', 'standard-password-123');

    // When the standard user attempts to issue a reset.
    const response = await harness.issueReset(targetId, userCookie);

    // Then the protected endpoint denies the request.
    expect(response.statusCode).toBe(403);
  });

  it('requires authentication to issue a reset', async () => {
    // Given an existing target user without an authenticated caller.
    const targetId = await harness.createUser(
      'unauthenticated-target@example.com',
      'target-password-123',
    );

    // When an unauthenticated caller attempts to issue a reset.
    const response = await harness.issueReset(targetId);

    // Then the protected endpoint rejects the request.
    expect(response.statusCode).toBe(401);
  });

  it('rejects an administrator issuing a reset for their own account', async () => {
    // Given an authenticated administrator targeting themselves.
    const { adminId, adminCookie } = await createIssuanceContext();

    // When the administrator attempts to reset their own password.
    const response = await harness.issueReset(adminId, adminCookie);

    // Then the endpoint refuses; self-service uses the account password change.
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 when an administrator issues a reset for an unknown user', async () => {
    // Given an authenticated administrator and a syntactically valid absent user ID.
    const { adminCookie } = await createIssuanceContext();

    // When the administrator targets the absent user.
    const response = await harness.issueReset('00000000-0000-4000-a000-000000000000', adminCookie);

    // Then the endpoint reports that the target does not exist.
    expect(response.statusCode).toBe(404);
    expect(notFoundSchema.parse(JSON.parse(response.body))).toEqual({ error: 'not_found' });
  });

  it('consumes a valid reset by replacing the password, revoking sessions, and auditing', async () => {
    // Given a user with two active sessions and an unconsumed reset token.
    const oldPassword = 'original-password-123';
    const newPassword = 'replacement-password-123';
    const targetId = await harness.createUser('consume-target@example.com', oldPassword);
    await harness.loginAs('consume-target@example.com', oldPassword);
    await harness.loginAs('consume-target@example.com', oldPassword);
    const resetId = await harness.createPasswordReset(targetId, 'valid-reset-token');

    // When the public endpoint consumes the token with a replacement password.
    const response = await harness.consumeReset('valid-reset-token', newPassword);

    // Then the password, sessions, reset record, and audit trail are atomically updated.
    expect(response.statusCode).toBe(200);
    expect(successSchema.parse(JSON.parse(response.body))).toEqual({ ok: true });
    const { verifyPassword } = await import('@heartbeat-vault/crypto');
    const passwordHash = await harness.passwordHashFor(targetId);
    await expect(verifyPassword(passwordHash, oldPassword)).resolves.toBe(false);
    await expect(verifyPassword(passwordHash, newPassword)).resolves.toBe(true);

    const reset = firstRow(
      (
        await harness.pool.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM password_resets WHERE id = $1',
          [resetId],
        )
      ).rows,
    );
    expect(reset.consumed_at).toBeInstanceOf(Date);
    const sessions = await harness.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE user_id = $1',
      [targetId],
    );
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.every(session => session.revoked_at instanceof Date)).toBe(true);
    const audit = firstRow(
      (
        await harness.pool.query<{
          action: string;
          actor_id: string | null;
          target: string | null;
          details: Record<string, unknown>;
        }>(
          `SELECT action, actor_id, target, details FROM audit_log
           WHERE action = 'password_reset_consumed' AND target = $1`,
          [resetId],
        )
      ).rows,
    );
    expect(audit).toEqual({
      action: 'password_reset_consumed',
      actor_id: targetId,
      target: resetId,
      details: { sessionsRevoked: true },
    });
    expect(JSON.stringify(audit.details)).not.toContain(newPassword);
  });

  it.each([
    { label: 'expired', state: 'expired' },
    { label: 'consumed', state: 'consumed' },
  ] as const)(
    'returns generic 400 without changing the password for an $label reset',
    async testCase => {
      // Given a reset token that cannot be consumed and the target's original password hash.
      const targetId = await harness.createUser(
        `${testCase.label}@example.com`,
        'original-password-123',
      );
      const originalHash = await harness.passwordHashFor(targetId);
      await harness.createPasswordReset(targetId, `${testCase.label}-reset-token`, testCase.state);

      // When the public endpoint attempts to consume that token.
      const response = await harness.consumeReset(
        `${testCase.label}-reset-token`,
        'replacement-password-123',
      );

      // Then it reveals no token state and leaves the password untouched.
      expect(response.statusCode).toBe(400);
      expect(invalidRequestSchema.parse(JSON.parse(response.body))).toEqual({
        error: 'invalid_request',
      });
      expect(await harness.passwordHashFor(targetId)).toBe(originalHash);
    },
  );

  it('returns generic 400 without changing the password for an unknown reset token', async () => {
    // Given a target user with no matching reset record.
    const targetId = await harness.createUser('unknown-token@example.com', 'original-password-123');
    const originalHash = await harness.passwordHashFor(targetId);

    // When the public endpoint receives an unknown token.
    const response = await harness.consumeReset('unknown-reset-token', 'replacement-password-123');

    // Then it returns the same generic failure and preserves the password.
    expect(response.statusCode).toBe(400);
    expect(invalidRequestSchema.parse(JSON.parse(response.body))).toEqual({
      error: 'invalid_request',
    });
    expect(await harness.passwordHashFor(targetId)).toBe(originalHash);
  });

  it('rate limits the sixth invalid public reset attempt from one IP', async () => {
    // Given a single client IP making invalid reset attempts.
    const remoteAddress = '198.51.100.42';

    // When the client submits five invalid requests followed by a sixth.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await harness.consumeReset(
        `invalid-reset-${attempt}`,
        'replacement-password-123',
        remoteAddress,
      );
      expect(response.statusCode).toBe(400);
      expect(invalidRequestSchema.parse(JSON.parse(response.body))).toEqual({
        error: 'invalid_request',
      });
    }
    const sixthResponse = await harness.consumeReset(
      'invalid-reset-sixth',
      'replacement-password-123',
      remoteAddress,
    );

    // Then the sixth request is rejected with retry guidance.
    expect(sixthResponse.statusCode).toBe(429);
    expect(rateLimitedSchema.parse(JSON.parse(sixthResponse.body))).toEqual({
      error: 'rate_limited',
    });
    expect(sixthResponse.headers['retry-after']).toBeDefined();
  });

  it('invalidates the first unconsumed reset when an administrator issues a second reset', async () => {
    // Given an authenticated administrator and a target user.
    const { targetId, adminCookie } = await createIssuanceContext();

    // When the administrator issues two reset tokens for the same target.
    const firstResponse = await harness.issueReset(targetId, adminCookie);
    expect(firstResponse.statusCode).toBe(201);
    const first = issuedResetSchema.parse(JSON.parse(firstResponse.body));
    const secondResponse = await harness.issueReset(targetId, adminCookie);
    expect(secondResponse.statusCode).toBe(201);
    issuedResetSchema.parse(JSON.parse(secondResponse.body));

    // Then the earlier token is marked consumed and cannot replace the password.
    const firstReset = firstRow(
      (
        await harness.pool.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM password_resets WHERE id = $1',
          [first.id],
        )
      ).rows,
    );
    expect(firstReset.consumed_at).toBeInstanceOf(Date);
    const originalHash = await harness.passwordHashFor(targetId);
    const consumeFirst = await harness.consumeReset(first.token, 'replacement-password-123');
    expect(consumeFirst.statusCode).toBe(400);
    expect(invalidRequestSchema.parse(JSON.parse(consumeFirst.body))).toEqual({
      error: 'invalid_request',
    });
    expect(await harness.passwordHashFor(targetId)).toBe(originalHash);
  });
});
