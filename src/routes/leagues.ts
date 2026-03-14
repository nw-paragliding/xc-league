// =============================================================================
// XC / Hike & Fly League Platform — League Routes
//
// Registers all league-related endpoints under /api/v1/leagues
// =============================================================================

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { SQLiteJobQueue } from '../job-queue';
import { makeResolveLeagueHook, requireLeagueAdmin, requireLeagueMember, requireAuth } from '../auth';
import { randomUUID } from 'crypto';

interface LeagueRouteOptions {
  db: Database.Database;
  queue: SQLiteJobQueue;
}

export async function registerLeagueRoutes(
  fastify: FastifyInstance,
  opts: LeagueRouteOptions,
): Promise<void> {
  const { db, queue } = opts;

  // ── Public league list ─────────────────────────────────────────────────────
  fastify.get('/leagues', async (request, reply) => {
    const leagues = db.prepare(
      `SELECT id, slug, name, description, logo_url as logoUrl
       FROM leagues
       WHERE deleted_at IS NULL
       ORDER BY name`
    ).all();

    return reply.send({ leagues });
  });

  // ── Create a new league ────────────────────────────────────────────────────
  // Any authenticated user can create a league and becomes the first admin
  fastify.post('/leagues', async (request, reply) => {
    requireAuth(request, reply);
    
    const body = request.body as {
      name: string;
      slug: string;
      description?: string;
      logo_url?: string;
    };
    
    // Validate slug format (alphanumeric + hyphens only)
    if (!/^[a-z0-9-]+$/.test(body.slug)) {
      return reply.status(400).send({ 
        error: 'Slug must be lowercase alphanumeric with hyphens only' 
      });
    }
    
    // Check slug uniqueness
    const existing = db.prepare(
      `SELECT id FROM leagues WHERE slug = ? AND deleted_at IS NULL`
    ).get(body.slug);
    
    if (existing) {
      return reply.status(409).send({ error: 'League slug already exists' });
    }
    
    const leagueId = randomUUID();
    const membershipId = randomUUID();
    
    // Create league and make creator the first admin in a transaction
    db.transaction(() => {
      db.prepare(
        `INSERT INTO leagues (id, name, slug, description, logo_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(leagueId, body.name, body.slug, body.description || null, body.logo_url || null);
      
      db.prepare(
        `INSERT INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', datetime('now'), datetime('now'), datetime('now'))`
      ).run(membershipId, leagueId, (request as any).user!.userId);
    })();
    
    const league = db.prepare(
      `SELECT id, name, slug, description, logo_url as logoUrl, created_at as createdAt
       FROM leagues WHERE id = ?`
    ).get(leagueId);
    
    request.log.info({ leagueId, userId: (request as any).user!.userId }, 'League created');
    return reply.status(201).send({ league });
  });

  // ── League-scoped routes (require :leagueSlug param) ───────────────────────
  // Register with league resolution hook
  await fastify.register(async (leagueScope) => {
    // This hook resolves request.league and request.membership from :leagueSlug
    leagueScope.addHook('preHandler', makeResolveLeagueHook(db));

    // ── Get league details ─────────────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug', async (request, reply) => {
      const league = (request as any).league;
      if (!league) {
        return reply.status(404).send({ error: 'League not found' });
      }

      return reply.send({ league });
    });

    // ── Get seasons for a league ───────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons', async (request, reply) => {
      const league = (request as any).league;
      const seasons = db.prepare(
        `SELECT 
           s.id,
           s.name,
           s.competition_type as competitionType,
           s.start_date as startDate,
           s.end_date as endDate,
           (SELECT COUNT(*) FROM tasks WHERE season_id = s.id AND deleted_at IS NULL) as taskCount,
           (SELECT COUNT(DISTINCT user_id) FROM season_registrations WHERE season_id = s.id AND left_at IS NULL) as registeredPilotCount
         FROM seasons s
         WHERE s.league_id = ? AND s.deleted_at IS NULL
         ORDER BY s.start_date DESC`
      ).all(league.id);

      return reply.send({ seasons });
    });

    // ── Get tasks for a season ─────────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks', async (request, reply) => {
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;

      // Verify season belongs to this league
      const season = db.prepare(
        `SELECT id FROM seasons WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);

      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }

      const tasks = db.prepare(
        `SELECT 
           t.id,
           t.name,
           t.task_type as taskType,
           t.open_date as openDate,
           t.close_date as closeDate,
           t.optimised_distance_km as optimisedDistanceKm,
           CASE WHEN t.frozen_at IS NOT NULL THEN 1 ELSE 0 END as isFrozen,
           (SELECT COUNT(DISTINCT user_id) FROM submissions WHERE task_id = t.id AND deleted_at IS NULL) as pilotCount,
           (SELECT COUNT(DISTINCT s.user_id) 
            FROM submissions s 
            JOIN attempts a ON a.submission_id = s.id 
            WHERE s.task_id = t.id AND s.deleted_at IS NULL AND a.reached_goal = 1) as goalCount
         FROM tasks t
         WHERE t.season_id = ? AND t.deleted_at IS NULL
         ORDER BY t.open_date DESC`
      ).all(seasonId);

      return reply.send({ tasks });
    });

    // ── Get task details with results ──────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId', async (request, reply) => {
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;

      // Verify task belongs to this season/league
      const task = db.prepare(
        `SELECT 
           t.id,
           t.name,
           t.description,
           t.task_type as taskType,
           t.open_date as openDate,
           t.close_date as closeDate,
           t.optimised_distance_km as optimisedDistanceKm,
           t.frozen_at as frozenAt
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id);

      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      // Get turnpoints
      const turnpoints = db.prepare(
        `SELECT 
           id,
           sequence_index as sequenceIndex,
           name,
           lat,
           lng,
           radius_m as radiusM,
           type,
           goal_line_bearing_deg as goalLineBearingDeg
         FROM turnpoints
         WHERE task_id = ?
         ORDER BY sequence_index`
      ).all(taskId);

      // Get results (best attempt per pilot)
      const results = db.prepare(
        `SELECT 
           tr.rank,
           tr.user_id as userId,
           u.display_name as pilotName,
           tr.distance_points as distancePoints,
           tr.time_points as timePoints,
           tr.total_points as totalPoints,
           tr.distance_flown_km as distanceFlownKm,
           tr.task_time_s as taskTimeS,
           tr.reached_goal as reachedGoal,
           tr.has_flagged_crossings as hasFlaggedCrossings,
           tr.submitted_at as submittedAt
         FROM task_results tr
         JOIN users u ON u.id = tr.user_id
         WHERE tr.task_id = ?
         ORDER BY tr.rank`
      ).all(taskId);

      return reply.send({ task, turnpoints, results });
    });

    // ── Upload IGC file (submission) ───────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submit', async (request, reply) => {
      // TODO: Implement IGC upload handler
      // This will use the upload.ts module and pipeline.ts
      return reply.status(501).send({ error: 'Upload endpoint not yet implemented' });
    });

    // ── Get submission track data ──────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/submissions/:submissionId/track', async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string };

      const submission = db.prepare(
        `SELECT 
           s.id,
           s.user_id as userId,
           s.task_id as taskId,
           s.igc_data as igcData
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
         JOIN seasons se ON se.id = t.season_id
         WHERE s.id = ? AND se.league_id = ? AND s.deleted_at IS NULL`
      ).get(submissionId, (request as any).league.id);

      if (!submission) {
        return reply.status(404).send({ error: 'Submission not found' });
      }

      // TODO: Generate track replay data from IGC
      // For now, return stub data
      return reply.send({
        track: {
          submissionId: submission.id,
          fixes: [],
          bounds: { north: 0, south: 0, east: 0, west: 0 },
        }
      });
    });

    // ── Get standings for a season ─────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/standings', async (request, reply) => {
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;

      const standings = db.prepare(
        `SELECT 
           ss.rank,
           ss.user_id as userId,
           u.display_name as pilotName,
           ss.total_points as totalPoints,
           ss.tasks_counted as tasksCounted,
           ss.best_distance_km as bestDistanceKm
         FROM season_standings ss
         JOIN users u ON u.id = ss.user_id
         JOIN seasons s ON s.id = ss.season_id
         WHERE ss.season_id = ? AND s.league_id = ? AND s.deleted_at IS NULL
         ORDER BY ss.rank`
      ).all(seasonId, league.id);

      return reply.send({ standings });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // LEAGUE MEMBER MANAGEMENT
    // ──────────────────────────────────────────────────────────────────────────

    // ── Join a league ──────────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/join', async (request, reply) => {
      requireAuth(request, reply);
      
      const league = (request as any).league;
      const userId = (request as any).user!.userId;
      
      // Check if already a member
      const existing = db.prepare(
        `SELECT id FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id, userId);
      
      if (existing) {
        return reply.status(400).send({ error: 'Already a member of this league' });
      }
      
      // Add as pilot
      const membershipId = randomUUID();
      db.prepare(
        `INSERT INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pilot', datetime('now'), datetime('now'), datetime('now'))`
      ).run(membershipId, league.id, userId);
      
      request.log.info({ leagueId: league.id, userId }, 'User joined league');
      return reply.status(201).send({ message: 'Joined league successfully' });
    });

    // ── List league members ────────────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/members', async (request, reply) => {
      requireLeagueMember(request, reply);
      
      const league = (request as any).league;
      
      const members = db.prepare(
        `SELECT 
           lm.id, lm.role, lm.joined_at as joinedAt,
           u.id as userId, u.email, u.display_name as displayName, u.avatar_url as avatarUrl
         FROM league_memberships lm
         JOIN users u ON lm.user_id = u.id
         WHERE lm.league_id = ? AND lm.left_at IS NULL AND lm.deleted_at IS NULL
         ORDER BY lm.joined_at ASC`
      ).all(league.id);
      
      return reply.send({ members });
    });

    // ── Promote member to admin ────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/members/:userId/promote', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { userId } = request.params as { userId: string };
      const league = (request as any).league;
      
      // Check if user is a member
      const membership = db.prepare(
        `SELECT id, role FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id, userId) as { id: string; role: string } | undefined;
      
      if (!membership) {
        return reply.status(404).send({ error: 'User is not a member of this league' });
      }
      
      if (membership.role === 'admin') {
        return reply.status(400).send({ error: 'User is already an admin' });
      }
      
      db.prepare(
        `UPDATE league_memberships
         SET role = 'admin', updated_at = datetime('now')
         WHERE id = ?`
      ).run(membership.id);
      
      request.log.info({ leagueId: league.id, userId }, 'Member promoted to admin');
      return reply.send({ message: 'Member promoted to admin' });
    });

    // ── Demote admin to pilot ──────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/members/:userId/demote', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { userId } = request.params as { userId: string };
      const league = (request as any).league;
      
      const membership = db.prepare(
        `SELECT id, role FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id, userId) as { id: string; role: string } | undefined;
      
      if (!membership) {
        return reply.status(404).send({ error: 'User is not a member of this league' });
      }
      
      if (membership.role !== 'admin') {
        return reply.status(400).send({ error: 'User is not an admin' });
      }
      
      // Prevent demoting the last admin
      const adminCount = db.prepare(
        `SELECT COUNT(*) as count FROM league_memberships
         WHERE league_id = ? AND role = 'admin' AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id) as { count: number };
      
      if (adminCount.count <= 1) {
        return reply.status(400).send({ error: 'Cannot demote the last admin' });
      }
      
      db.prepare(
        `UPDATE league_memberships
         SET role = 'pilot', updated_at = datetime('now')
         WHERE id = ?`
      ).run(membership.id);
      
      request.log.info({ leagueId: league.id, userId }, 'Admin demoted to pilot');
      return reply.send({ message: 'Admin demoted to pilot' });
    });

    // ── Remove member from league ──────────────────────────────────────────
    leagueScope.delete('/leagues/:leagueSlug/members/:userId', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { userId } = request.params as { userId: string };
      const league = (request as any).league;
      const actorUserId = (request as any).user!.userId;
      
      // Check if trying to remove themselves
      const isSelf = userId === actorUserId;
      
      const membership = db.prepare(
        `SELECT id, role FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id, userId) as { id: string; role: string } | undefined;
      
      if (!membership) {
        return reply.status(404).send({ error: 'User is not a member of this league' });
      }
      
      // If removing self as admin, ensure there's another admin
      if (isSelf && membership.role === 'admin') {
        const adminCount = db.prepare(
          `SELECT COUNT(*) as count FROM league_memberships
           WHERE league_id = ? AND role = 'admin' AND left_at IS NULL AND deleted_at IS NULL`
        ).get(league.id) as { count: number };
        
        if (adminCount.count <= 1) {
          return reply.status(400).send({ error: 'Cannot remove yourself as the last admin' });
        }
      }
      
      // Soft delete the membership by setting left_at
      db.prepare(
        `UPDATE league_memberships
         SET left_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(membership.id);
      
      request.log.info({ leagueId: league.id, userId, removedByUserId: actorUserId }, 'Member removed from league');
      return reply.send({ message: 'Member removed from league' });
    });
  });
}
