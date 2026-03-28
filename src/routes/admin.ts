// =============================================================================
// XC / Hike & Fly League Platform — Admin Routes
//
// Registers all super admin endpoints under /api/v1/admin
// Manages platform-level administration: user management, super admin promotion
// =============================================================================

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { requireSuperAdmin, requireAuth } from '../auth';
import { randomUUID } from 'crypto';

interface AdminRouteOptions {
  db: Database.Database;
}

interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_super_admin: number;
  created_at: string;
}

export async function registerAdminRoutes(
  fastify: FastifyInstance,
  opts: AdminRouteOptions
): Promise<void> {
  const { db } = opts;

  // GET /admin/users - List all users (super admin only)
  fastify.get('/admin/users', async (request, reply) => {
    requireSuperAdmin(request, reply);
    
    const users = db.prepare(
      `SELECT id, email, display_name as displayName, avatar_url as avatarUrl,
              is_super_admin as isAdmin, created_at as createdAt
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC`
    ).all();
    
    reply.send({ users });
  });

  // POST /admin/users/:userId/promote - Promote user to super admin
  fastify.post('/admin/users/:userId/promote', async (request, reply) => {
    requireSuperAdmin(request, reply);
    
    const { userId } = request.params as { userId: string };
    
    // Check target user exists
    const targetUser = db.prepare(
      `SELECT id, email, is_super_admin FROM users WHERE id = ? AND deleted_at IS NULL`
    ).get(userId) as UserRecord | undefined;
    
    if (!targetUser) {
      reply.status(404).send({ error: 'User not found' });
      return;
    }
    
    if (targetUser.is_super_admin) {
      reply.status(400).send({ error: 'User is already a super admin' });
      return;
    }
    
    // Promote user
    db.prepare(
      `UPDATE users SET is_super_admin = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(userId);
    
    // Audit log
    db.prepare(
      `INSERT INTO admin_audit_log (id, actor_user_id, target_user_id, action, created_at)
       VALUES (?, ?, ?, 'PROMOTE_SUPER_ADMIN', datetime('now'))`
    ).run(randomUUID(), (request as any).user!.userId, userId);

    request.log.info({ actorId: (request as any).user!.userId, targetId: userId }, 'User promoted to super admin');
    reply.send({ message: 'User promoted to super admin' });
  });

  // POST /admin/users/:userId/demote - Demote super admin to regular user
  fastify.post('/admin/users/:userId/demote', async (request, reply) => {
    requireSuperAdmin(request, reply);
    
    const { userId } = request.params as { userId: string };
    
    // Check target user exists and is super admin
    const targetUser = db.prepare(
      `SELECT id, email, is_super_admin FROM users WHERE id = ? AND deleted_at IS NULL`
    ).get(userId) as UserRecord | undefined;
    
    if (!targetUser) {
      reply.status(404).send({ error: 'User not found' });
      return;
    }
    
    if (!targetUser.is_super_admin) {
      reply.status(400).send({ error: 'User is not a super admin' });
      return;
    }
    
    // Prevent demoting the last super admin
    const superAdminCount = db.prepare(
      `SELECT COUNT(*) as count FROM users WHERE is_super_admin = 1 AND deleted_at IS NULL`
    ).get() as { count: number };
    
    if (superAdminCount.count <= 1) {
      reply.status(400).send({ error: 'Cannot demote the last super admin' });
      return;
    }
    
    // Demote user
    db.prepare(
      `UPDATE users SET is_super_admin = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(userId);
    
    // Audit log
    db.prepare(
      `INSERT INTO admin_audit_log (id, actor_user_id, target_user_id, action, created_at)
       VALUES (?, ?, ?, 'DEMOTE_SUPER_ADMIN', datetime('now'))`
    ).run(randomUUID(), (request as any).user!.userId, userId);

    request.log.info({ actorId: (request as any).user!.userId, targetId: userId }, 'User demoted from super admin');
    reply.send({ message: 'User demoted from super admin' });
  });

  // GET /admin/leagues - List all leagues (super admin only)
  fastify.get('/admin/leagues', async (request, reply) => {
    requireSuperAdmin(request, reply);

    const leagues = db.prepare(
      `SELECT id, name, slug, description as shortDescription, created_at as createdAt
       FROM leagues WHERE deleted_at IS NULL ORDER BY created_at DESC`
    ).all();

    reply.send({ leagues });
  });

  // DELETE /admin/leagues/:leagueSlug - Soft-delete a league (super admin only)
  fastify.delete('/admin/leagues/:leagueSlug', async (request, reply) => {
    requireSuperAdmin(request, reply);

    const { leagueSlug } = request.params as { leagueSlug: string };

    const league = db.prepare(
      `SELECT id, name FROM leagues WHERE slug = ? AND deleted_at IS NULL`
    ).get(leagueSlug) as { id: string; name: string } | undefined;

    if (!league) {
      return reply.status(404).send({ error: 'League not found' });
    }

    db.prepare(
      `UPDATE leagues SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(league.id);

    db.prepare(
      `INSERT INTO admin_audit_log (id, actor_user_id, target_user_id, action, details, created_at)
       VALUES (?, ?, ?, 'DELETE_LEAGUE', ?, datetime('now'))`
    ).run(randomUUID(), (request as any).user!.userId, (request as any).user!.userId, league.name);

    request.log.info({ actorId: (request as any).user!.userId, leagueId: league.id }, 'League deleted by super admin');
    reply.send({ message: 'League deleted' });
  });

  // GET /admin/audit-log - View admin audit log
  fastify.get('/admin/audit-log', async (request, reply) => {
    requireSuperAdmin(request, reply);
    
    const { limit = 100, offset = 0 } = request.query as { limit?: number; offset?: number };
    
    const logs = db.prepare(
      `SELECT 
         al.id, al.action, al.details, al.created_at as createdAt,
         actor.email as actorEmail, actor.display_name as actorName,
         target.email as targetEmail, target.display_name as targetName
       FROM admin_audit_log al
       JOIN users actor ON al.actor_user_id = actor.id
       JOIN users target ON al.target_user_id = target.id
       ORDER BY al.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset);
    
    reply.send({ logs });
  });
}
