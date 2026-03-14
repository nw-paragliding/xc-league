// =============================================================================
// XC / Hike & Fly League Platform — League Routes
//
// Registers all league-related endpoints under /api/v1/leagues
// =============================================================================

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { SQLiteJobQueue } from '../job-queue';
import { makeResolveLeagueHook, requireLeagueAdmin, requireLeagueMember } from '../auth';

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
  });
}
