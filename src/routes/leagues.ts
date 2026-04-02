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
import { parseTaskFile, parseCupAll } from '../task-parsers';
import { parseAndValidate } from '../pipeline';
import { handleIgcUpload } from '../upload';
import { exportXctsk, exportCup, buildXctrackDeepLink, buildDownloadUrl, type ExportTask, type ExportTurnpoint } from '../task-exporters';
import QRCode from 'qrcode';

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
      `SELECT id, slug, name, description as shortDescription, logo_url as logoUrl
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
      name:              string;
      slug:              string;
      shortDescription?: string;
      fullDescription?:  string;
      logo_url?:         string;
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
        `INSERT INTO leagues (id, name, slug, description, full_description, logo_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(leagueId, body.name, body.slug, body.shortDescription || null, body.fullDescription || null, body.logo_url || null);
      
      db.prepare(
        `INSERT INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', datetime('now'), datetime('now'), datetime('now'))`
      ).run(membershipId, leagueId, (request as any).user!.userId);
    })();
    
    const league = db.prepare(
      `SELECT id, name, slug, description as shortDescription, full_description as fullDescription, logo_url as logoUrl, created_at as createdAt
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

      const fullLeague = db.prepare(
        `SELECT id, slug, name, description as shortDescription, full_description as fullDescription, logo_url as logoUrl, created_at as createdAt
         FROM leagues WHERE id = ? AND deleted_at IS NULL`
      ).get(league.id);

      return reply.send({ league: fullLeague });
    });

    // ── Get seasons for a league ───────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons', async (request, reply) => {
      const league = (request as any).league;
      const seasons = db.prepare(
        `SELECT 
           s.id,
           s.name,
           s.competition_type    as competitionType,
           s.start_date          as startDate,
           s.end_date            as endDate,
           s.status,
           s.nominal_distance_km as nominalDistanceKm,
           s.nominal_time_s      as nominalTimeS,
           s.nominal_goal_ratio  as nominalGoalRatio,
           s.created_at          as createdAt,
           s.updated_at          as updatedAt,
           (SELECT COUNT(*) FROM tasks WHERE season_id = s.id AND deleted_at IS NULL) as taskCount,
           (SELECT COUNT(DISTINCT user_id) FROM season_registrations WHERE season_id = s.id AND deleted_at IS NULL) as registeredPilotCount
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

      const rows = db.prepare(
        `SELECT
           t.id,
           t.season_id as seasonId,
           t.name,
           t.task_type as taskType,
           t.status,
           t.open_date as openDate,
           t.close_date as closeDate,
           CASE WHEN t.scores_frozen_at IS NOT NULL THEN 1 ELSE 0 END as isFrozen,
           t.scores_frozen_at as scoresFrozenAt,
           t.normalized_score as taskValue,
           (SELECT COUNT(DISTINCT user_id) FROM flight_submissions WHERE task_id = t.id AND deleted_at IS NULL) as pilotCount,
           (SELECT COUNT(DISTINCT fs.user_id)
            FROM flight_submissions fs
            JOIN flight_attempts fa ON fa.submission_id = fs.id
            WHERE fs.task_id = t.id AND fs.deleted_at IS NULL AND fa.reached_goal = 1) as goalCount,
           json_group_array(json_object(
             'name', tp.name, 'latitude', tp.latitude, 'longitude', tp.longitude,
             'radiusM', tp.radius_m, 'type', tp.type, 'sequenceIndex', tp.sequence_index
           ) ORDER BY tp.sequence_index) FILTER (WHERE tp.id IS NOT NULL) as turnpointsJson
         FROM tasks t
         LEFT JOIN turnpoints tp ON tp.task_id = t.id AND tp.deleted_at IS NULL
         WHERE t.season_id = ? AND t.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY t.sort_order ASC, t.created_at ASC`
      ).all(seasonId) as any[];

      const tasks = rows.map(t => ({
        ...t,
        turnpoints: JSON.parse(t.turnpointsJson || '[]'),
        turnpointsJson: undefined,
      }));

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
           t.scores_frozen_at as scoresFrozenAt
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

    // ── Task leaderboard ───────────────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/leaderboard', async (request, reply) => {
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;

      const task = db.prepare(
        `SELECT t.id, t.name, t.task_type as taskType, t.status,
                t.open_date as openDate, t.close_date as closeDate,
                CASE WHEN t.scores_frozen_at IS NOT NULL THEN 1 ELSE 0 END as isFrozen,
                t.scores_frozen_at as scoresFrozenAt
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`,
      ).get(taskId, seasonId, league.id) as any;

      if (!task) return reply.status(404).send({ error: 'Task not found' });

      const entries = db.prepare(
        `SELECT
           tr.rank,
           tr.user_id       AS pilotId,
           u.display_name   AS pilotName,
           tr.distance_flown_km AS distanceFlownKm,
           tr.reached_goal  AS reachedGoal,
           tr.task_time_s   AS taskTimeS,
           tr.distance_points AS distancePoints,
           tr.time_points   AS timePoints,
           tr.total_points  AS totalPoints,
           tr.has_flagged_crossings AS hasFlaggedCrossings,
           fa.submission_id AS submissionId
         FROM task_results tr
         JOIN users u ON u.id = tr.user_id
         LEFT JOIN flight_attempts fa ON fa.id = tr.best_attempt_id
         WHERE tr.task_id = ?
         ORDER BY tr.rank ASC`,
      ).all(taskId) as any[];

      return reply.send({
        task,
        entries: entries.map(e => ({
          ...e,
          reachedGoal:         Boolean(e.reachedGoal),
          hasFlaggedCrossings: Boolean(e.hasFlaggedCrossings),
        })),
      });
    });

    // ── Upload IGC file (submission) ───────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      return handleIgcUpload(request as any, reply, db, queue);
    });

    // ── List submissions for a task (authenticated pilot's own) ────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions', async (request, reply) => {
      requireAuth(request, reply);
      requireLeagueMember(request, reply);

      const { taskId, seasonId } = request.params as { taskId: string; seasonId: string };
      const userId = (request as any).user!.userId;
      const league = (request as any).league;

      const rows = db.prepare(
        `SELECT fs.id, fs.status, fs.igc_filename, fs.igc_size_bytes, fs.submitted_at, fs.igc_date,
                fa.attempt_index, fa.reached_goal, fa.distance_flown_km, fa.task_time_s,
                fa.distance_points, fa.time_points, fa.total_points,
                fa.has_flagged_crossings, fa.last_turnpoint_index
         FROM flight_submissions fs
         LEFT JOIN flight_attempts fa ON fa.id = fs.best_attempt_id
         JOIN tasks t ON t.id = fs.task_id
         JOIN seasons s ON s.id = t.season_id
         WHERE fs.task_id = ? AND s.id = ? AND s.league_id = ?
           AND fs.user_id = ? AND fs.deleted_at IS NULL
         ORDER BY fs.submitted_at DESC`,
      ).all(taskId, seasonId, league.id, userId) as any[];

      const submissions = rows.map(row => {
        const bestAttempt = row.attempt_index != null ? {
          attemptIndex:        row.attempt_index,
          reachedGoal:         Boolean(row.reached_goal),
          distanceFlownKm:     row.distance_flown_km ?? 0,
          taskTimeS:           row.task_time_s ?? null,
          distancePoints:      row.distance_points ?? 0,
          timePoints:          row.time_points ?? 0,
          totalPoints:         row.total_points ?? 0,
          hasFlaggedCrossings: Boolean(row.has_flagged_crossings),
          turnpointsCrossed:   row.last_turnpoint_index ?? 0,
        } : null;

        return {
          id:                    row.id,
          status:                row.status,
          submittedAt:           row.submitted_at,
          igcFilename:           row.igc_filename,
          igcSizeBytes:          row.igc_size_bytes,
          igcDate:               row.igc_date ?? null,
          bestAttempt,
          allAttempts:           bestAttempt ? [bestAttempt] : [],
          timePointsProvisional: Boolean(row.reached_goal),
        };
      });

      return reply.send({ submissions });
    });

    // ── Get submission track data ──────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/track', async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string; seasonId: string; taskId: string };

      const submission = db.prepare(
        `SELECT
           s.id,
           s.user_id as userId,
           s.task_id as taskId,
           s.igc_filename as igcFilename,
           s.igc_date as igcDate,
           s.igc_data as igcData,
           u.display_name as pilotName
         FROM flight_submissions s
         JOIN tasks t ON t.id = s.task_id
         JOIN seasons se ON se.id = t.season_id
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND se.league_id = ? AND s.deleted_at IS NULL`
      ).get(submissionId, (request as any).league.id) as any;

      if (!submission) {
        return reply.status(404).send({ error: 'Submission not found' });
      }

      const igcText = submission.igcData instanceof Buffer
        ? submission.igcData.toString('utf8')
        : String(submission.igcData);

      const parsed = parseAndValidate(igcText);
      if (!parsed.ok) {
        return reply.status(422).send({ error: 'Could not parse IGC data' });
      }

      const { fixes, flightDate } = parsed.value;
      const lats = fixes.map((f: any) => f.lat);
      const lngs = fixes.map((f: any) => f.lng);

      // Best attempt for score/goal metadata
      const bestAttempt = db.prepare(
        `SELECT reached_goal, total_points
         FROM flight_attempts
         WHERE submission_id = ? AND deleted_at IS NULL
         ORDER BY total_points DESC LIMIT 1`
      ).get(submission.id) as { reached_goal: number; total_points: number } | undefined;

      // Turnpoint crossings from best attempt
      const crossings = bestAttempt ? (db.prepare(
        `SELECT
           tc.turnpoint_id    AS turnpointId,
           tc.crossing_time   AS crossingTimeMs,
           t.name             AS turnpointName,
           t.sequence_index   AS sequenceIndex,
           t.type,
           t.radius_m         AS radiusM,
           t.latitude,
           t.longitude,
           tc.ground_confirmed       AS groundConfirmed,
           tc.ground_check_required  AS groundCheckRequired
         FROM turnpoint_crossings tc
         JOIN flight_attempts fa ON fa.id = tc.attempt_id
         JOIN turnpoints t ON t.id = tc.turnpoint_id
         WHERE fa.submission_id = ? AND fa.deleted_at IS NULL
         ORDER BY t.sequence_index`
      ).all(submission.id) as any[]) : [];

      return reply.send({
        submissionId: submission.id,
        taskId:       submission.taskId,
        pilotId:      submission.userId,
        pilotName:    submission.pilotName,
        flightDate,
        fixes: fixes.map((f: any) => ({ t: f.timestamp, lat: f.lat, lng: f.lng, alt: f.gpsAlt })),
        crossings: crossings.map((c: any) => ({
          turnpointId:         c.turnpointId,
          turnpointName:       c.turnpointName,
          sequenceIndex:       c.sequenceIndex,
          crossingTimeMs:      typeof c.crossingTimeMs === 'string' ? new Date(c.crossingTimeMs).getTime() : c.crossingTimeMs,
          type:                c.type,
          radiusM:             c.radiusM,
          latitude:            c.latitude,
          longitude:           c.longitude,
          groundConfirmed:     !!c.groundConfirmed,
          groundCheckRequired: !!c.groundCheckRequired,
        })),
        bounds: {
          north: Math.max(...lats),
          south: Math.min(...lats),
          east:  Math.max(...lngs),
          west:  Math.min(...lngs),
        },
        meta: {
          fixCount:    fixes.length,
          durationS:   fixes.length >= 2
            ? Math.round((fixes[fixes.length - 1].timestamp - fixes[0].timestamp) / 1000)
            : null,
          reachedGoal: !!bestAttempt?.reached_goal,
          totalPoints: bestAttempt?.total_points ?? 0,
        },
      });
    });

    // ── Get standings for a season ─────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/standings', async (request, reply) => {
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;

      const season = db.prepare(
        `SELECT s.id, s.name,
                s.competition_type   AS competitionType,
                s.start_date         AS startDate,
                s.end_date           AS endDate,
                COUNT(t.id)          AS taskCount
         FROM seasons s
         LEFT JOIN tasks t ON t.season_id = s.id AND t.deleted_at IS NULL
         WHERE s.id = ? AND s.league_id = ?
         GROUP BY s.id`
      ).get(seasonId, league.id) as { id: string; name: string; competitionType: string; startDate: string; endDate: string; taskCount: number } | undefined;

      if (!season) return reply.status(404).send({ error: 'Season not found' });

      const standings = db.prepare(
        `SELECT
           ss.rank,
           ss.user_id        AS pilotId,
           u.display_name    AS pilotName,
           ss.total_points   AS totalPoints,
           ss.tasks_flown    AS tasksFlown,
           ss.tasks_with_goal AS tasksWithGoal
         FROM season_standings ss
         JOIN users u ON u.id = ss.user_id
         WHERE ss.season_id = ?
         ORDER BY ss.rank`
      ).all(seasonId) as any[];

      return reply.send({ season, standings });
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

    // ── Search users by email (for adding admins) ─────────────────────────
    leagueScope.get('/leagues/:leagueSlug/users/search', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const { email } = request.query as { email?: string };
      if (!email || email.trim().length < 3) {
        return reply.status(400).send({ error: 'Provide at least 3 characters to search' });
      }

      const users = db.prepare(
        `SELECT id, email, display_name as displayName, avatar_url as avatarUrl
         FROM users
         WHERE email LIKE ? AND deleted_at IS NULL
         LIMIT 10`
      ).all(`%${email.trim()}%`) as { id: string; email: string; displayName: string; avatarUrl: string }[];

      return reply.send({ users });
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
      
      // Check if user is a member; auto-add them if not
      let membership = db.prepare(
        `SELECT id, role FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL AND deleted_at IS NULL`
      ).get(league.id, userId) as { id: string; role: string } | undefined;

      if (!membership) {
        const membershipId = randomUUID();
        db.prepare(
          `INSERT INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pilot', datetime('now'), datetime('now'), datetime('now'))`
        ).run(membershipId, league.id, userId);
        membership = { id: membershipId, role: 'pilot' };
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

    // ──────────────────────────────────────────────────────────────────────
    // SEASON MANAGEMENT (League Admin Only)
    // ──────────────────────────────────────────────────────────────────────

    // ── Create a new season ────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const league = (request as any).league;
      const body = request.body as {
        name: string;
        competitionType: 'XC' | 'HIKE_AND_FLY';
        startDate: string;  // ISO 8601 date
        endDate: string;    // ISO 8601 date
        nominalDistanceKm?: number;
        nominalTimeS?: number;
        nominalGoalRatio?: number;
      };
      
      // Validate dates
      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return reply.status(400).send({ error: 'Invalid date format. Use ISO 8601 (YYYY-MM-DD)' });
      }
      
      if (end <= start) {
        return reply.status(400).send({ error: 'End date must be after start date' });
      }
      
      const seasonId = randomUUID();
      
      db.prepare(
        `INSERT INTO seasons (
          id, league_id, name, competition_type, start_date, end_date,
          nominal_distance_km, nominal_time_s, nominal_goal_ratio,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        seasonId,
        league.id,
        body.name,
        body.competitionType,
        body.startDate,
        body.endDate,
        body.nominalDistanceKm ?? 70.0,
        body.nominalTimeS ?? 5400,
        body.nominalGoalRatio ?? 0.3
      );
      
      const season = db.prepare(
        `SELECT 
          id, name, competition_type as competitionType,
          start_date as startDate, end_date as endDate,
          nominal_distance_km as nominalDistanceKm,
          nominal_time_s as nominalTimeS,
          nominal_goal_ratio as nominalGoalRatio,
          created_at as createdAt
        FROM seasons WHERE id = ?`
      ).get(seasonId);
      
      request.log.info({ leagueId: league.id, seasonId }, 'Season created');
      return reply.status(201).send({ season });
    });

    // ── Update a season ────────────────────────────────────────────────────
    leagueScope.put('/leagues/:leagueSlug/seasons/:seasonId', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const body = request.body as {
        name?: string;
        competitionType?: 'XC' | 'HIKE_AND_FLY';
        startDate?: string;
        endDate?: string;
        nominalDistanceKm?: number;
        nominalTimeS?: number;
        nominalGoalRatio?: number;
      };
      
      // Verify season belongs to this league
      const existingSeason = db.prepare(
        `SELECT id, start_date, end_date FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);
      
      if (!existingSeason) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      // Validate dates if provided
      if (body.startDate || body.endDate) {
        const startDate = body.startDate || (existingSeason as any).start_date;
        const endDate = body.endDate || (existingSeason as any).end_date;
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          return reply.status(400).send({ error: 'Invalid date format' });
        }
        
        if (end <= start) {
          return reply.status(400).send({ error: 'End date must be after start date' });
        }
      }
      
      // Build update query dynamically based on provided fields
      const updates: string[] = [];
      const params: any[] = [];
      
      if (body.name !== undefined) {
        updates.push('name = ?');
        params.push(body.name);
      }
      if (body.competitionType !== undefined) {
        updates.push('competition_type = ?');
        params.push(body.competitionType);
      }
      if (body.startDate !== undefined) {
        updates.push('start_date = ?');
        params.push(body.startDate);
      }
      if (body.endDate !== undefined) {
        updates.push('end_date = ?');
        params.push(body.endDate);
      }
      if (body.nominalDistanceKm !== undefined) {
        updates.push('nominal_distance_km = ?');
        params.push(body.nominalDistanceKm);
      }
      if (body.nominalTimeS !== undefined) {
        updates.push('nominal_time_s = ?');
        params.push(body.nominalTimeS);
      }
      if (body.nominalGoalRatio !== undefined) {
        updates.push('nominal_goal_ratio = ?');
        params.push(body.nominalGoalRatio);
      }
      
      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }
      
      updates.push('updated_at = datetime(\'now\')');
      params.push(seasonId);
      
      db.prepare(
        `UPDATE seasons SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);
      
      const season = db.prepare(
        `SELECT 
          id, name, competition_type as competitionType,
          start_date as startDate, end_date as endDate,
          nominal_distance_km as nominalDistanceKm,
          nominal_time_s as nominalTimeS,
          nominal_goal_ratio as nominalGoalRatio,
          updated_at as updatedAt
        FROM seasons WHERE id = ?`
      ).get(seasonId);
      
      request.log.info({ leagueId: league.id, seasonId }, 'Season updated');
      return reply.send({ season });
    });

    // ── Delete a season ────────────────────────────────────────────────────
    leagueScope.delete('/leagues/:leagueSlug/seasons/:seasonId', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      
      // Verify season belongs to this league
      const season = db.prepare(
        `SELECT id FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);
      
      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      // Soft delete the season
      db.prepare(
        `UPDATE seasons
         SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(seasonId);
      
      request.log.info({ leagueId: league.id, seasonId }, 'Season deleted');
      return reply.send({ message: 'Season deleted' });
    });

    // ── Open a season ──────────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/open', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      
      // Verify season belongs to this league
      const season = db.prepare(
        `SELECT id, status FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id) as { id: string; status: string } | undefined;
      
      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      if (season.status === 'open') {
        return reply.status(400).send({ error: 'Season is already open' });
      }
      
      if (season.status === 'closed') {
        return reply.status(400).send({ error: 'Cannot reopen a closed season' });
      }
      
      // Update season status to open
      db.prepare(
        `UPDATE seasons
         SET status = 'open', updated_at = datetime('now')
         WHERE id = ?`
      ).run(seasonId);
      
      const updatedSeason = db.prepare(
        `SELECT 
          id, name, competition_type as competitionType,
          start_date as startDate, end_date as endDate,
          status, updated_at as updatedAt
        FROM seasons WHERE id = ?`
      ).get(seasonId);
      
      request.log.info({ leagueId: league.id, seasonId }, 'Season opened');
      return reply.send({ season: updatedSeason });
    });

    // ── Close a season ─────────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/close', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      
      // Verify season belongs to this league
      const season = db.prepare(
        `SELECT id, status FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id) as { id: string; status: string } | undefined;
      
      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      if (season.status === 'closed') {
        return reply.status(400).send({ error: 'Season is already closed' });
      }
      
      if (season.status === 'draft') {
        return reply.status(400).send({ error: 'Cannot close a draft season (open it first)' });
      }
      
      // Use transaction to close season and freeze all unfrozen tasks
      db.transaction(() => {
        // Update season status to closed
        db.prepare(
          `UPDATE seasons
           SET status = 'closed', updated_at = datetime('now')
           WHERE id = ?`
        ).run(seasonId);
        
        // Freeze all unfrozen tasks in this season
        db.prepare(
          `UPDATE tasks
           SET scores_frozen_at = datetime('now'), updated_at = datetime('now')
           WHERE season_id = ? AND scores_frozen_at IS NULL AND deleted_at IS NULL`
        ).run(seasonId);
      })();
      
      const updatedSeason = db.prepare(
        `SELECT 
          id, name, competition_type as competitionType,
          start_date as startDate, end_date as endDate,
          status, updated_at as updatedAt
        FROM seasons WHERE id = ?`
      ).get(seasonId);
      
      request.log.info({ leagueId: league.id, seasonId }, 'Season closed and all tasks frozen');
      return reply.send({ season: updatedSeason });
    });

    // ──────────────────────────────────────────────────────────────────────
    // SEASON REGISTRATION (Pilot Actions)
    // ──────────────────────────────────────────────────────────────────────

    // ── Register pilot for season ──────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/register', async (request, reply) => {
      requireAuth(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const userId = (request as any).user!.userId;
      
      // Verify season exists and is open
      const season = db.prepare(
        `SELECT id, status FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id) as { id: string; status: string } | undefined;
      
      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      if (season.status !== 'open') {
        return reply.status(400).send({ error: 'Season is not open for registration' });
      }
      
      // Check if already registered
      const existing = db.prepare(
        `SELECT id FROM season_registrations
         WHERE season_id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(seasonId, userId);
      
      if (existing) {
        return reply.status(400).send({ error: 'Already registered for this season' });
      }
      
      // Create registration
      const registrationId = randomUUID();
      db.prepare(
        `INSERT INTO season_registrations (id, season_id, user_id, registered_at, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
      ).run(registrationId, seasonId, userId);
      
      request.log.info({ leagueId: league.id, seasonId, userId }, 'Pilot registered for season');
      return reply.status(201).send({ message: 'Successfully registered for season' });
    });

    // ── Get season registration status ─────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/registration', async (request, reply) => {
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const user = (request as any).user;
      
      // Get total registration count
      const countResult = db.prepare(
        `SELECT COUNT(*) as count FROM season_registrations
         WHERE season_id = ? AND deleted_at IS NULL`
      ).get(seasonId) as { count: number };
      
      let isRegistered = false;
      if (user) {
        const registration = db.prepare(
          `SELECT id FROM season_registrations
           WHERE season_id = ? AND user_id = ? AND deleted_at IS NULL`
        ).get(seasonId, user.userId);
        isRegistered = !!registration;
      }
      
      return reply.send({
        isRegistered,
        registrationCount: countResult.count,
      });
    });

    // ── List pilots registered for season ──────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/registrations', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      
      const pilots = db.prepare(
        `SELECT 
          sr.id,
          sr.user_id as userId,
          u.email,
          u.display_name as displayName,
          u.avatar_url as avatarUrl,
          sr.registered_at as registeredAt
         FROM season_registrations sr
         JOIN users u ON u.id = sr.user_id
         WHERE sr.season_id = ? AND sr.deleted_at IS NULL
         ORDER BY sr.registered_at ASC`
      ).all(seasonId);
      
      return reply.send({ pilots });
    });

    // ──────────────────────────────────────────────────────────────────────
    // TASK MANAGEMENT (League Admin Only)
    // ──────────────────────────────────────────────────────────────────────

    // ── Create a new task ──────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const body = request.body as {
        name: string;
        description?: string;
        taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
        openDate: string;   // ISO 8601 datetime
        closeDate: string;  // ISO 8601 datetime
      };
      
      // Verify season belongs to this league
      const season = db.prepare(
        `SELECT id FROM seasons
         WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);
      
      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }
      
      // Validate dates
      const open = new Date(body.openDate);
      const close = new Date(body.closeDate);
      
      if (isNaN(open.getTime()) || isNaN(close.getTime())) {
        return reply.status(400).send({ error: 'Invalid date format. Use ISO 8601 datetime' });
      }
      
      if (close <= open) {
        return reply.status(400).send({ error: 'Close date must be after open date' });
      }
      
      const taskId = randomUUID();

      const nextOrder = (db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM tasks WHERE season_id = ? AND deleted_at IS NULL`
      ).get(seasonId) as any).next as number;

      db.prepare(
        `INSERT INTO tasks (
          id, season_id, league_id, name, description, task_type,
          open_date, close_date, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        taskId,
        seasonId,
        league.id,
        body.name,
        body.description || null,
        body.taskType,
        body.openDate,
        body.closeDate,
        nextOrder
      );
      
      const task = db.prepare(
        `SELECT 
          id, name, description,
          task_type as taskType,
          open_date as openDate,
          close_date as closeDate,
          created_at as createdAt
        FROM tasks WHERE id = ?`
      ).get(taskId);
      
      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task created');
      return reply.status(201).send({ task });
    });

    // ── Import task from file (.xctsk or .cup) ─────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/import', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const query = request.query as {
        name?: string;
        openDate?: string;
        closeDate?: string;
      };

      // Expect multipart: a single task file (.xctsk or .cup)
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const filename: string = data.filename ?? 'task';
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext !== 'xctsk' && ext !== 'cup') {
        return reply.status(400).send({ error: 'Unsupported file format. Use .xctsk or .cup' });
      }

      // Read file content
      const fileBuffer = await data.toBuffer();
      const content = fileBuffer.toString('utf8');

      // Parse file
      let parsed;
      try {
        parsed = parseTaskFile(content, filename);
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Failed to parse task file' });
      }

      if (parsed.turnpoints.length < 2) {
        return reply.status(400).send({ error: 'Task must have at least 2 turnpoints (SSS + Goal)' });
      }

      // Verify season exists
      const season = db.prepare(
        `SELECT id FROM seasons WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);

      if (!season) {
        return reply.status(404).send({ error: 'Season not found' });
      }

      // Use provided name or parsed name or filename
      const taskName = query.name ?? parsed.name ?? filename.replace(/\.[^.]+$/, '');
      const openDate = query.openDate;
      const closeDate = query.closeDate;

      // Create task + turnpoints in a transaction
      const taskId = randomUUID();

      db.transaction(() => {
        const nextOrderImport = (db.prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM tasks WHERE season_id = ? AND deleted_at IS NULL`
        ).get(seasonId) as any).next as number;

        // Create task
        db.prepare(
          `INSERT INTO tasks (
            id, season_id, league_id, name, task_type,
            open_date, close_date,
            task_data_source, task_data_raw,
            sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(
          taskId,
          seasonId,
          league.id,
          taskName,
          parsed.taskType ?? 'RACE_TO_GOAL',
          openDate ?? new Date().toISOString(),
          closeDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          parsed.format,
          content,
          nextOrderImport,
        );

        // Create turnpoints
        let sssId: string | null = null;
        let essId: string | null = null;
        let goalId: string | null = null;

        for (let i = 0; i < parsed.turnpoints.length; i++) {
          const tp = parsed.turnpoints[i];
          const tpId = randomUUID();

          db.prepare(
            `INSERT INTO turnpoints (
              id, task_id, league_id, sequence_index,
              name, latitude, longitude, radius_m, type,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
          ).run(
            tpId,
            taskId,
            league.id,
            i,
            tp.name,
            tp.latitude,
            tp.longitude,
            tp.radius_m,
            tp.type,
          );

          if (tp.type === 'SSS') sssId = tpId;
          if (tp.type === 'ESS') essId = tpId;
          if (tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE') goalId = tpId;
        }

        // Update task FK references
        if (sssId || essId || goalId) {
          const setClauses: string[] = [];
          const setParams: (string | null)[] = [];
          if (sssId)  { setClauses.push('sss_turnpoint_id = ?');  setParams.push(sssId); }
          if (essId)  { setClauses.push('ess_turnpoint_id = ?');  setParams.push(essId); }
          if (goalId) { setClauses.push('goal_turnpoint_id = ?'); setParams.push(goalId); }

          db.prepare(
            `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
          ).run(...setParams, taskId);
        }
      })();

      const task = db.prepare(
        `SELECT
          id, name, description,
          task_type as taskType,
          open_date as openDate,
          close_date as closeDate,
          status,
          created_at as createdAt
        FROM tasks WHERE id = ?`
      ).get(taskId);

      const turnpoints = db.prepare(
        `SELECT id, name, latitude, longitude, radius_m as radiusM, type, sequence_index as sequenceIndex
         FROM turnpoints WHERE task_id = ? AND deleted_at IS NULL ORDER BY sequence_index`
      ).all(taskId);

      request.log.info({ leagueId: league.id, seasonId, taskId, format: parsed.format }, 'Task imported from file');
      return reply.status(201).send({ task, turnpoints });
    });

    // ── Preview all tasks in a .cup file (no DB writes) ────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/cup-preview', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file uploaded' });

      const filename = data.filename ?? 'task.cup';
      if (!filename.toLowerCase().endsWith('.cup')) {
        return reply.status(400).send({ error: 'Only .cup files are supported for bulk preview' });
      }

      const content = (await data.toBuffer()).toString('utf8');
      let tasks;
      try {
        tasks = parseCupAll(content);
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Failed to parse CUP file' });
      }

      return reply.send({
        tasks: tasks.map((t, i) => ({
          index:          i,
          name:           t.name ?? `Task ${i + 1}`,
          turnpointCount: t.turnpoints.length,
          turnpoints:     t.turnpoints.map(tp => ({
            name:      tp.name,
            latitude:  tp.latitude,
            longitude: tp.longitude,
            radius_m:  tp.radius_m,
            type:      tp.type,
          })),
        })),
      });
    });

    // ── Bulk import multiple tasks from a .cup file ────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/bulk-import', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;

      // Expect multipart: 'file' (CUP) + 'tasks' (JSON string)
      let fileBuffer: Buffer | null = null;
      let filename = 'tasks.cup';
      let tasksConfig: Array<{ index: number; name?: string; openDate?: string; closeDate?: string }> = [];

      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          fileBuffer = await part.toBuffer();
          filename = part.filename ?? filename;
        } else if (part.type === 'field' && part.fieldname === 'tasks') {
          try { tasksConfig = JSON.parse(part.value as string); } catch {}
        }
      }

      if (!fileBuffer) return reply.status(400).send({ error: 'No file uploaded' });

      const content = fileBuffer.toString('utf8');
      let parsedTasks;
      try {
        parsedTasks = parseCupAll(content);
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Failed to parse CUP file' });
      }

      // Verify season
      const season = db.prepare(
        `SELECT id FROM seasons WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).get(seasonId, league.id);
      if (!season) return reply.status(404).send({ error: 'Season not found' });

      const created: string[] = [];

      db.transaction(() => {
        for (const cfg of tasksConfig) {
          const parsed = parsedTasks[cfg.index];
          if (!parsed || parsed.turnpoints.length < 2) continue;

          const taskId = randomUUID();
          const taskName = cfg.name ?? parsed.name ?? `Task ${cfg.index + 1}`;

          const nextOrder = (db.prepare(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM tasks WHERE season_id = ? AND deleted_at IS NULL`
          ).get(seasonId) as any).next as number;

          db.prepare(
            `INSERT INTO tasks (
              id, season_id, league_id, name, task_type,
              open_date, close_date,
              task_data_source, task_data_raw,
              sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
          ).run(
            taskId, seasonId, league.id, taskName,
            parsed.taskType ?? 'RACE_TO_GOAL',
            cfg.openDate  ?? new Date().toISOString(),
            cfg.closeDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            'cup', content,
            nextOrder,
          );

          let sssId: string | null = null;
          let essId: string | null = null;
          let goalId: string | null = null;

          for (let i = 0; i < parsed.turnpoints.length; i++) {
            const tp = parsed.turnpoints[i];
            const tpId = randomUUID();
            db.prepare(
              `INSERT INTO turnpoints (
                id, task_id, league_id, sequence_index,
                name, latitude, longitude, radius_m, type,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
            ).run(tpId, taskId, league.id, i, tp.name, tp.latitude, tp.longitude, tp.radius_m, tp.type);

            if (tp.type === 'SSS') sssId = tpId;
            if (tp.type === 'ESS') essId = tpId;
            if (tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE') goalId = tpId;
          }

          if (sssId || essId || goalId) {
            const sets: string[] = [];
            const vals: (string | null)[] = [];
            if (sssId)  { sets.push('sss_turnpoint_id = ?');  vals.push(sssId); }
            if (essId)  { sets.push('ess_turnpoint_id = ?');  vals.push(essId); }
            if (goalId) { sets.push('goal_turnpoint_id = ?'); vals.push(goalId); }
            db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, taskId);
          }

          created.push(taskId);
        }
      })();

      request.log.info({ leagueId: league.id, seasonId, count: created.length }, 'Bulk import from CUP');
      return reply.status(201).send({ created: created.length, taskIds: created });
    });

    // ── Update a task ──────────────────────────────────────────────────────
    leagueScope.put('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;
      const body = request.body as {
        name?: string;
        description?: string;
        taskType?: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
        openDate?: string;
        closeDate?: string;
        taskValue?: number | null;
      };
      
      // Verify task belongs to this season/league
      const existingTask = db.prepare(
        `SELECT t.id, t.open_date, t.close_date, t.scores_frozen_at
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; open_date: string; close_date: string; scores_frozen_at: string | null } | undefined;
      
      if (!existingTask) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      
      // Prevent editing frozen tasks
      if (existingTask.scores_frozen_at) {
        return reply.status(400).send({ error: 'Cannot edit a frozen task' });
      }
      
      // Validate dates if provided
      if (body.openDate || body.closeDate) {
        const openDate = body.openDate || existingTask.open_date;
        const closeDate = body.closeDate || existingTask.close_date;
        const open = new Date(openDate);
        const close = new Date(closeDate);
        
        if (isNaN(open.getTime()) || isNaN(close.getTime())) {
          return reply.status(400).send({ error: 'Invalid date format' });
        }
        
        if (close <= open) {
          return reply.status(400).send({ error: 'Close date must be after open date' });
        }
      }
      
      // Build update query dynamically
      const updates: string[] = [];
      const params: any[] = [];
      
      if (body.name !== undefined) {
        updates.push('name = ?');
        params.push(body.name);
      }
      if (body.description !== undefined) {
        updates.push('description = ?');
        params.push(body.description);
      }
      if (body.taskType !== undefined) {
        updates.push('task_type = ?');
        params.push(body.taskType);
      }
      if (body.openDate !== undefined) {
        updates.push('open_date = ?');
        params.push(body.openDate);
      }
      if (body.closeDate !== undefined) {
        updates.push('close_date = ?');
        params.push(body.closeDate);
      }
      if (body.taskValue !== undefined) {
        updates.push('normalized_score = ?');
        params.push(body.taskValue ?? null);
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }
      
      updates.push('updated_at = datetime(\'now\')');
      params.push(taskId);
      
      db.prepare(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);
      
      const task = db.prepare(
        `SELECT
          id, name, description,
          task_type as taskType,
          open_date as openDate,
          close_date as closeDate,
          normalized_score as taskValue,
          updated_at as updatedAt
        FROM tasks WHERE id = ?`
      ).get(taskId);

      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task updated');
      return reply.send({ task });
    });

    // ── Delete a task ──────────────────────────────────────────────────────
    leagueScope.delete('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;
      
      // Verify task belongs to this season/league
      const task = db.prepare(
        `SELECT t.id, t.scores_frozen_at
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; scores_frozen_at: string | null } | undefined;
      
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      
      // Prevent deleting frozen tasks
      if (task.scores_frozen_at) {
        return reply.status(400).send({ error: 'Cannot delete a frozen task' });
      }
      
      // Soft delete the task and cascade to related data in one transaction.
      // task_results has no deleted_at (computed data) so hard-delete those rows.
      db.transaction(() => {
        db.prepare(`UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(taskId);
        db.prepare(`UPDATE turnpoints SET deleted_at = datetime('now') WHERE task_id = ? AND deleted_at IS NULL`).run(taskId);
        db.prepare(`UPDATE flight_submissions SET deleted_at = datetime('now') WHERE task_id = ? AND deleted_at IS NULL`).run(taskId);
        db.prepare(`UPDATE flight_attempts SET deleted_at = datetime('now') WHERE task_id = ? AND deleted_at IS NULL`).run(taskId);
        db.prepare(`DELETE FROM task_results WHERE task_id = ?`).run(taskId);
      })();

      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task deleted');
      return reply.send({ message: 'Task deleted' });
    });

    // ── Publish task ───────────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/publish', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;
      
      // Verify task belongs to this season/league
      const task = db.prepare(
        `SELECT t.id, t.status
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; status: string } | undefined;
      
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      
      if (task.status === 'published') {
        return reply.status(400).send({ error: 'Task is already published' });
      }
      
      // Verify task has turnpoints (required for publication)
      const turnpointCount = db.prepare(
        `SELECT COUNT(*) as count FROM turnpoints WHERE task_id = ?`
      ).get(taskId) as { count: number };
      
      if (turnpointCount.count === 0) {
        return reply.status(400).send({ error: 'Cannot publish task without turnpoints' });
      }
      
      // Publish the task
      db.prepare(
        `UPDATE tasks
         SET status = 'published', updated_at = datetime('now')
         WHERE id = ?`
      ).run(taskId);
      
      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task published');
      return reply.send({ message: 'Task published' });
    });

    // ── Unpublish task ─────────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/unpublish', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;
      
      // Verify task belongs to this season/league
      const task = db.prepare(
        `SELECT t.id, t.status
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; status: string } | undefined;
      
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      
      if (task.status === 'draft') {
        return reply.status(400).send({ error: 'Task is already in draft status' });
      }
      
      // Check if task has submissions
      const submissionCount = db.prepare(
        `SELECT COUNT(*) as count FROM flight_submissions WHERE task_id = ? AND deleted_at IS NULL`
      ).get(taskId) as { count: number };
      
      if (submissionCount.count > 0) {
        return reply.status(400).send({ error: 'Cannot unpublish task with existing submissions' });
      }
      
      // Unpublish the task
      db.prepare(
        `UPDATE tasks
         SET status = 'draft', updated_at = datetime('now')
         WHERE id = ?`
      ).run(taskId);
      
      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task unpublished');
      return reply.send({ message: 'Task unpublished (returned to draft)' });
    });

    // ── Freeze task scores ─────────────────────────────────────────────────
    leagueScope.post('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/freeze', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;

      const task = db.prepare(
        `SELECT t.id, t.scores_frozen_at
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; scores_frozen_at: string | null } | undefined;

      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      if (task.scores_frozen_at) {
        return reply.status(400).send({ error: 'Task scores are already frozen' });
      }

      db.prepare(
        `UPDATE tasks SET scores_frozen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(taskId);

      request.log.info({ leagueId: league.id, seasonId, taskId }, 'Task scores frozen');
      return reply.send({ message: 'Task scores frozen' });
    });

    // ── Reorder tasks ──────────────────────────────────────────────────────
    leagueScope.put('/leagues/:leagueSlug/seasons/:seasonId/tasks/reorder', async (request, reply) => {
      requireLeagueAdmin(request, reply);

      const { seasonId } = request.params as { seasonId: string };
      const league = (request as any).league;
      const { order } = request.body as { order: { id: string; sortOrder: number }[] };

      if (!Array.isArray(order)) {
        return reply.status(400).send({ error: 'order must be an array' });
      }

      // Validate all tasks belong to this season
      const taskIds = order.map(o => o.id);
      const placeholders = taskIds.map(() => '?').join(',');
      const existing = db.prepare(
        `SELECT id FROM tasks WHERE id IN (${placeholders}) AND season_id = ? AND deleted_at IS NULL`
      ).all(...taskIds, seasonId) as { id: string }[];

      if (existing.length !== taskIds.length) {
        return reply.status(400).send({ error: 'One or more task IDs are invalid for this season' });
      }

      const update = db.prepare(`UPDATE tasks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`);
      db.transaction(() => {
        for (const { id, sortOrder } of order) {
          update.run(sortOrder, id);
        }
      })();

      request.log.info({ leagueId: league.id, seasonId }, 'Tasks reordered');
      return reply.send({ message: 'Tasks reordered' });
    });

    // ── Download task file (.xctsk or .cup) ────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/download', async (request, reply) => {

      const { seasonId, taskId } = request.params as { seasonId: string; taskId: string };
      const league = (request as any).league;
      const query = request.query as { format?: string };
      const format = (query.format ?? 'xctsk').toLowerCase();

      if (format !== 'xctsk' && format !== 'cup') {
        return reply.status(400).send({ error: 'Unsupported format. Use xctsk or cup' });
      }

      const taskRow = db.prepare(
        `SELECT t.id, t.name, t.task_type as taskType,
                t.task_data_source as dataSource, t.task_data_raw as rawContent
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as {
        id: string; name: string; taskType: string;
        dataSource: string | null; rawContent: string | null;
      } | undefined;

      if (!taskRow) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      const tpRows = db.prepare(
        `SELECT name, latitude, longitude, radius_m, type, sequence_index as sequenceIndex
         FROM turnpoints WHERE task_id = ? AND deleted_at IS NULL ORDER BY sequence_index`
      ).all(taskId) as ExportTurnpoint[];

      const exportTask: ExportTask = {
        id: taskRow.id, name: taskRow.name, taskType: taskRow.taskType,
        turnpoints: tpRows, rawContent: taskRow.rawContent, dataSource: taskRow.dataSource,
      };

      let fileContent: string;
      let contentType: string;
      let filename: string;

      if (format === 'xctsk') {
        fileContent = (taskRow.dataSource === 'xctsk' && taskRow.rawContent)
          ? taskRow.rawContent : exportXctsk(exportTask);
        contentType = 'application/octet-stream';
        filename = `${taskRow.name.replace(/[^a-z0-9]/gi, '_')}.xctsk`;
      } else {
        fileContent = (taskRow.dataSource === 'cup' && taskRow.rawContent)
          ? taskRow.rawContent : exportCup(exportTask);
        contentType = 'text/csv';
        filename = `${taskRow.name.replace(/[^a-z0-9]/gi, '_')}.cup`;
      }

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fileContent);
    });

    // ── Generate QR code for task ──────────────────────────────────────────
    leagueScope.get('/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/qr', async (request, reply) => {

      const { leagueSlug, seasonId, taskId } = request.params as {
        leagueSlug: string; seasonId: string; taskId: string;
      };
      const league = (request as any).league;
      const query = request.query as { app?: string; format?: string };
      const app = query.app ?? 'download';
      const dlFormat = (query.format ?? 'xctsk') as 'xctsk' | 'cup';

      const taskRow = db.prepare(
        `SELECT t.id, t.name, t.task_type as taskType
         FROM tasks t
         JOIN seasons s ON s.id = t.season_id
         WHERE t.id = ? AND t.season_id = ? AND s.league_id = ? AND t.deleted_at IS NULL`
      ).get(taskId, seasonId, league.id) as { id: string; name: string; taskType: string } | undefined;

      if (!taskRow) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      const tpRows = db.prepare(
        `SELECT name, latitude, longitude, radius_m, type, sequence_index as sequenceIndex
         FROM turnpoints WHERE task_id = ? AND deleted_at IS NULL ORDER BY sequence_index`
      ).all(taskId) as ExportTurnpoint[];

      const exportTask: ExportTask = {
        id: taskRow.id, name: taskRow.name, taskType: taskRow.taskType, turnpoints: tpRows,
      };

      let qrContent: string;
      if (app === 'xctrack') {
        qrContent = buildXctrackDeepLink(exportTask);
      } else {
        const proto = (request.headers['x-forwarded-proto'] as string) ?? 'http';
        const host  = request.headers.host ?? 'localhost:3000';
        const baseUrl = `${proto}://${host}`;
        qrContent = buildDownloadUrl(baseUrl, leagueSlug, seasonId, taskId, dlFormat);
      }

      // QR version 40 with error correction M holds at most 2331 bytes in binary mode
      if (Buffer.byteLength(qrContent, 'utf8') > 2331) {
        return reply.status(422).send({ error: 'qr_too_large' });
      }

      try {
        const pngBuffer = await QRCode.toBuffer(qrContent, {
          type: 'png',
          width: 600,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        reply.header('Content-Type', 'image/png');
        reply.header('Cache-Control', 'public, max-age=3600');
        return reply.send(pngBuffer);
      } catch (err) {
        request.log.error(err, 'Failed to generate QR code');
        return reply.status(500).send({ error: 'Failed to generate QR code' });
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    // LEAGUE SETTINGS (League Admin Only)
    // ──────────────────────────────────────────────────────────────────────

    // ── Update league details ──────────────────────────────────────────────
    leagueScope.put('/leagues/:leagueSlug', async (request, reply) => {
      requireLeagueAdmin(request, reply);
      
      const league = (request as any).league;
      const body = request.body as {
        name?: string;
        slug?: string;
        shortDescription?: string;
        fullDescription?: string;
        logoUrl?: string;
      };
      
      // Validate slug if provided
      if (body.slug !== undefined) {
        if (!/^[a-z0-9-]+$/.test(body.slug)) {
          return reply.status(400).send({ 
            error: 'Slug must be lowercase alphanumeric with hyphens only' 
          });
        }
        
        // Check slug uniqueness (excluding current league)
        const existing = db.prepare(
          `SELECT id FROM leagues WHERE slug = ? AND id != ? AND deleted_at IS NULL`
        ).get(body.slug, league.id);
        
        if (existing) {
          return reply.status(409).send({ error: 'League slug already exists' });
        }
      }
      
      // Build update query dynamically
      const updates: string[] = [];
      const params: any[] = [];
      
      if (body.name !== undefined) {
        updates.push('name = ?');
        params.push(body.name);
      }
      if (body.slug !== undefined) {
        updates.push('slug = ?');
        params.push(body.slug);
      }
      if (body.shortDescription !== undefined) {
        updates.push('description = ?');
        params.push(body.shortDescription);
      }
      if (body.fullDescription !== undefined) {
        updates.push('full_description = ?');
        params.push(body.fullDescription);
      }
      if (body.logoUrl !== undefined) {
        updates.push('logo_url = ?');
        params.push(body.logoUrl);
      }
      
      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }
      
      updates.push('updated_at = datetime(\'now\')');
      params.push(league.id);
      
      db.prepare(
        `UPDATE leagues SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);
      
      const updatedLeague = db.prepare(
        `SELECT
          id, name, slug,
          description as shortDescription,
          full_description as fullDescription,
          logo_url as logoUrl,
          updated_at as updatedAt
        FROM leagues WHERE id = ?`
      ).get(league.id);
      
      request.log.info({ leagueId: league.id }, 'League updated');
      return reply.send({ league: updatedLeague });
    });
  });
}
