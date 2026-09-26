import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { registerSetupRoutes } from './routes/setup.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerPasswordResetRoutes } from './routes/password-resets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTwoFactorRoutes } from './routes/two-factor.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerUserRoutes } from './routes/users.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOpenRegistrationRoute } from './routes/register.js';
import { registerSwitchRoutes } from './routes/switches.js';
import { registerHeartbeatRoutes } from './routes/heartbeat.js';
import { registerTriggerRoutes } from './routes/triggers.js';
import { registerAuditLogRoutes, registerSwitchAuditRoutes } from './routes/audit-log.js';
import { registerReportsRoutes } from './routes/reports.js';

export type BuildServerOptions = {
  readonly pool: Pool;
};

export async function buildServer(pool: Pool): Promise<FastifyInstance>;
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance>;
export async function buildServer(
  poolOrOptions: Pool | BuildServerOptions,
): Promise<FastifyInstance> {
  const pool: Pool =
    poolOrOptions !== null &&
    typeof poolOrOptions === 'object' &&
    'pool' in (poolOrOptions as Record<string, unknown>)
      ? (poolOrOptions as BuildServerOptions).pool
      : (poolOrOptions as Pool);

  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(cookie);

  app.get('/api/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  await registerSetupRoutes(app, pool);
  await registerAuthRoutes(app, pool);
  await registerAccountRoutes(app, pool);
  await registerPasswordResetRoutes(app, pool);
  await registerTwoFactorRoutes(app, pool);
  await registerInviteRoutes(app, pool);
  await registerUserRoutes(app, pool);
  await registerAdminRoutes(app, pool);
  await registerOpenRegistrationRoute(app, pool);
  await registerSwitchRoutes(app, pool);
  await registerHeartbeatRoutes(app, pool);
  await registerTriggerRoutes(app, pool);
  await registerAuditLogRoutes(app, pool);
  await registerSwitchAuditRoutes(app, pool);
  await registerReportsRoutes(app, pool);

  return app;
}
