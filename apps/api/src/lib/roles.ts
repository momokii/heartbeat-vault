import type { FastifyRequest, FastifyReply } from 'fastify';

export type Role = 'admin' | 'user';

const ROLE_RANK: Record<Role, number> = {
  user: 1,
  admin: 2,
};

function isRole(value: string): value is Role {
  return value === 'admin' || value === 'user';
}

function rankOf(role: string): number {
  if (isRole(role)) return ROLE_RANK[role];
  return 0;
}

export function requireRole(required: Role) {
  return async function requireRolePreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user;
    if (!user) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    if (!isRole(required)) {
      await reply.status(403).send({ error: 'forbidden' });
      return;
    }
    const userRank = rankOf(user.role);
    const requiredRank = ROLE_RANK[required];
    // default-deny: unknown role rank 0 fails
    if (userRank === 0) {
      await reply.status(403).send({ error: 'forbidden' });
      return;
    }
    // admin bypasses all (rank 2 >= any); otherwise must equal or exceed required
    if (userRank < requiredRank) {
      await reply.status(403).send({ error: 'forbidden' });
      return;
    }
  };
}

export function requireSelfOrAdmin(paramName = 'id') {
  return async function requireSelfOrAdminPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user;
    if (!user) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    // admin bypasses
    if (user.role === 'admin') return;

    const params = request.params as Record<string, string | undefined>;
    const targetId = params[paramName];
    if (!targetId || targetId !== user.id) {
      // IDOR guard: same shape as not-found to prevent enumeration
      await reply.status(404).send({ error: 'not_found' });
      return;
    }
  };
}
