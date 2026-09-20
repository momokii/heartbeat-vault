// Two-factor authentication surface (T3.3): TOTP enroll/verify/challenge/disable,
// recovery codes, WebAuthn passkeys, and the login step-up flow.
// Owns: this file + routes/totp.ts + routes/recovery.ts + routes/webauthn.ts
//       + lib/totp-store.ts + lib/webauthn.ts + lib/step-up.ts + migration 0001.
export { requireStepUp } from '../lib/step-up.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { registerTotpRoutes } from './totp.js';
import { registerRecoveryRoutes } from './recovery.js';
import { registerWebauthnRoutes } from './webauthn.js';

export async function registerTwoFactorRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);
  // 2FA routes are the only callers allowed to see totp_pending sessions.
  const requireAuthWithPending = createAuthPreHandler(pool, { allowTotpPending: true });
  registerRecoveryRoutes(app, pool, requireAuth);
  registerWebauthnRoutes(app, pool, { requireAuth, requireAuthWithPending });
  registerTotpRoutes(app, pool, { requireAuth, requireAuthWithPending });
}
