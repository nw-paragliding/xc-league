// =============================================================================
// XC / Hike & Fly League Platform — IGC Upload Handler
//
// POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submit
//
// Design:
//  - Synchronous processing: pipeline runs inline, result returned immediately
//  - 5MB hard limit, .igc extension required, first line must start with 'A'
//  - Duplicate detection: SHA-256 of file content; same pilot+task+hash → 409
//  - IGC stored as BLOB in flight_submissions alongside filename and size
//  - Scored result written to flight_attempts (one per attempt detected)
//  - RESCORE_TASK enqueued only when pilot reached goal (time pts provisional)
// =============================================================================

import { createHash }         from 'crypto';
import { randomUUID }         from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Database }      from 'better-sqlite3';
import {
  runPipeline,
  formatPipelineError,
  type PipelineInput,
  type TurnpointDef,
} from './pipeline';
import { rebuildTaskResults, type SQLiteJobQueue, type RescoreTaskPayload } from './job-queue';
import { requireAuth, requireLeagueMember }    from './auth';

// =============================================================================
// TYPES
// =============================================================================

interface UploadRouteParams {
  leagueSlug: string;
  seasonId:   string;
  taskId:     string;
}

interface TaskRow {
  id:               string;
  league_id:        string;
  season_id:        string;
  name:             string;
  status:           string;
  open_date:        string;
  close_date:       string;
  scores_frozen_at: string | null;
  task_type:        string | null;
}

interface TurnpointRow {
  id:                   string;
  sequence_index:       number;
  name:                 string;
  latitude:             number;
  longitude:            number;
  radius_m:             number;
  type:                 string;
  goal_line_bearing_deg: number | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const IGC_MAGIC    = 'A';

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submit
 *
 * Upload an IGC file for a task. Returns the scored submission immediately.
 */
export async function handleIgcUpload(
  request: FastifyRequest<{ Params: UploadRouteParams }>,
  reply:   FastifyReply,
  db:      Database,
  queue:   SQLiteJobQueue,
): Promise<void> {
  requireAuth(request, reply);
  requireLeagueMember(request, reply);

  const userId   = (request as any).user!.userId;
  const { taskId, seasonId } = request.params;

  // ── Resolve task ───────────────────────────────────────────────────────────
  const task = db.prepare(
    `SELECT t.*
     FROM tasks t
     JOIN seasons s ON s.id = t.season_id
     WHERE t.id = ?
       AND t.season_id = ?
       AND s.league_id = ?
       AND t.deleted_at IS NULL`,
  ).get(taskId, seasonId, (request as any).league!.id) as TaskRow | undefined;

  if (!task) {
    return reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
  }

  if (task.status !== 'published') {
    return reply.status(409).send({
      error: {
        code:    'TASK_NOT_OPEN',
        message: `Task is not published — submissions are not accepted`,
      },
    });
  }

  const now = new Date();
  if (now > new Date(task.close_date)) {
    return reply.status(409).send({
      error: { code: 'TASK_CLOSED', message: 'The submission window for this task has closed.' },
    });
  }

  if (task.scores_frozen_at) {
    return reply.status(409).send({
      error: { code: 'TASK_SCORES_FROZEN', message: 'This task is closed. No further submissions are accepted.' },
    });
  }

  // ── Parse multipart ────────────────────────────────────────────────────────
  let fileBuffer: Buffer;
  let originalFilename: string;

  try {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: { code: 'NO_FILE', message: 'No file uploaded' } });
    }

    const filename = data.filename ?? 'flight.igc';
    if (!filename.toLowerCase().endsWith('.igc')) {
      return reply.status(400).send({
        error: { code: 'INVALID_FILE_TYPE', message: 'File must have .igc extension' },
      });
    }
    originalFilename = filename;

    fileBuffer = await data.toBuffer();

    if (fileBuffer.length > MAX_FILE_SIZE) {
      return reply.status(413).send({
        error: { code: 'FILE_TOO_LARGE', message: `IGC file must be ≤ ${MAX_FILE_SIZE / 1024 / 1024} MB` },
      });
    }
  } catch (err: any) {
    if (err?.code === 'FST_FILES_LIMIT') {
      return reply.status(400).send({ error: { code: 'TOO_MANY_FILES', message: 'Only one file per request' } });
    }
    if (err?.code === 'FST_FILE_SIZE_LIMIT') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds 5 MB limit' } });
    }
    request.log.error(err, 'Multipart parse error');
    return reply.status(400).send({ error: { code: 'PARSE_ERROR', message: 'Could not parse upload' } });
  }

  // ── Basic format check ─────────────────────────────────────────────────────
  const firstLine = fileBuffer.toString('utf8', 0, Math.min(80, fileBuffer.length)).split('\n')[0] ?? '';
  if (!firstLine.startsWith(IGC_MAGIC)) {
    return reply.status(400).send({
      error: { code: 'INVALID_IGC', message: 'File does not appear to be a valid IGC file' },
    });
  }

  // ── Duplicate detection ────────────────────────────────────────────────────
  const sha256 = createHash('sha256').update(fileBuffer).digest('hex');

  const duplicate = db.prepare(
    `SELECT id FROM flight_submissions WHERE task_id = ? AND user_id = ? AND igc_sha256 = ? LIMIT 1`,
  ).get(taskId, userId, sha256);

  if (duplicate) {
    return reply.status(409).send({
      error: { code: 'DUPLICATE_SUBMISSION', message: 'You have already submitted this IGC file for this task' },
    });
  }

  // ── Load task turnpoints ───────────────────────────────────────────────────
  const turnpointRows = db.prepare(
    `SELECT id, sequence_index, name, latitude, longitude, radius_m, type, goal_line_bearing_deg
     FROM turnpoints
     WHERE task_id = ? AND deleted_at IS NULL
     ORDER BY sequence_index ASC`,
  ).all(taskId) as TurnpointRow[];

  if (turnpointRows.length < 2) {
    return reply.status(422).send({
      error: { code: 'TASK_NOT_CONFIGURED', message: 'Task has no turnpoints configured' },
    });
  }

  const turnpointDefs: TurnpointDef[] = turnpointRows.map(tp => ({
    id:                tp.id,
    sequenceIndex:     tp.sequence_index,
    lat:               tp.latitude,
    lng:               tp.longitude,
    radiusM:           tp.radius_m,
    type:              tp.type as TurnpointDef['type'],
    goalLineBearingDeg: tp.goal_line_bearing_deg ?? undefined,
  }));

  // ── Load existing goal times and best distance ─────────────────────────────
  const goalTimeRows = db.prepare(
    `SELECT task_time_s FROM flight_attempts
     WHERE task_id = ? AND reached_goal = 1 AND deleted_at IS NULL`,
  ).all(taskId) as Array<{ task_time_s: number }>;
  const existingGoalTimesS = goalTimeRows
    .filter(r => r.task_time_s != null)
    .map(r => r.task_time_s);

  const bestDistRow = db.prepare(
    `SELECT MAX(distance_flown_km) AS best FROM flight_attempts
     WHERE task_id = ? AND deleted_at IS NULL`,
  ).get(taskId) as { best: number | null };
  const taskBestDistanceKm = bestDistRow.best ?? 0;

  // ── Build pipeline input ───────────────────────────────────────────────────
  const pipelineInput: PipelineInput = {
    igcText: fileBuffer.toString('utf8'),
    task: {
      id: taskId,
      turnpoints: turnpointDefs,
      closeDate: new Date(task.close_date).getTime(),
    },
    existingGoalTimes: existingGoalTimesS,
    competitionType: 'XC',
  };

  // ── Run pipeline ───────────────────────────────────────────────────────────
  const scoresFrozenAt = task.scores_frozen_at
    ? new Date(task.scores_frozen_at).getTime()
    : null;

  const pipelineResult = await runPipeline(
    pipelineInput,
    task.open_date.slice(0, 10),   // YYYY-MM-DD
    task.close_date.slice(0, 10),  // YYYY-MM-DD
    scoresFrozenAt,
    taskBestDistanceKm,
  );

  if (!pipelineResult.ok) {
    const message = formatPipelineError(pipelineResult.error);
    return reply.status(422).send({
      error: { code: 'PIPELINE_ERROR', message },
    });
  }

  const { scoredAttempts, bestAttemptIndex } = pipelineResult.value;
  const best = scoredAttempts[bestAttemptIndex];

  // ── Persist submission + attempts ──────────────────────────────────────────
  const nowIso       = new Date().toISOString();
  const submissionId = randomUUID();

  // Pre-generate attempt IDs
  const attemptIds = scoredAttempts.map(() => randomUUID());
  const bestAttemptId = attemptIds[bestAttemptIndex];

  db.transaction(() => {
    // flight_submissions: raw upload record
    db.prepare(`
      INSERT INTO flight_submissions (
        id, task_id, user_id, league_id,
        igc_data, igc_filename, igc_size_bytes, igc_sha256,
        status,
        submitted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSED', ?, ?, ?)
    `).run(
      submissionId, taskId, userId, task.league_id,
      fileBuffer, originalFilename, fileBuffer.length, sha256,
      nowIso, nowIso, nowIso,
    );

    // Insert all scored attempts
    for (let i = 0; i < scoredAttempts.length; i++) {
      const attempt = scoredAttempts[i];
      const attemptId = attemptIds[i];

      const sssCrossingTime  = new Date(attempt.sssCrossing.crossingTime).toISOString();
      const essCrossingTime  = attempt.essCrossing
        ? new Date(attempt.essCrossing.crossingTime).toISOString()
        : null;
      const goalCrossingTime = attempt.goalCrossing
        ? new Date(attempt.goalCrossing.crossingTime).toISOString()
        : null;

      db.prepare(`
        INSERT INTO flight_attempts (
          id, submission_id, task_id, user_id, league_id,
          sss_crossing_time, ess_crossing_time, goal_crossing_time, task_time_s,
          reached_goal, last_turnpoint_index,
          distance_flown_km, distance_points, time_points, total_points,
          has_flagged_crossings, attempt_index,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, submissionId, taskId, userId, task.league_id,
        sssCrossingTime, essCrossingTime, goalCrossingTime,
        attempt.taskTimeS !== null ? Math.round(attempt.taskTimeS) : null,
        attempt.reachedGoal ? 1 : 0,
        attempt.lastTurnpointIndex,
        attempt.distanceFlownKm,
        attempt.distancePoints,
        attempt.timePoints,
        attempt.totalPoints,
        attempt.hasFlaggedCrossings ? 1 : 0,
        attempt.attemptIndex,
        nowIso, nowIso,
      );

      // Insert individual TP crossings
      for (const crossing of attempt.turnpointCrossings) {
        db.prepare(`
          INSERT INTO turnpoint_crossings (
            id, attempt_id, turnpoint_id, sequence_index, crossing_time,
            ground_check_required, ground_confirmed, detected_max_speed_kmh,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), attemptId, crossing.turnpointId, crossing.sequenceIndex,
          new Date(crossing.crossingTime).toISOString(),
          crossing.groundCheckRequired ? 1 : 0,
          crossing.groundConfirmed ? 1 : 0,
          crossing.detectedMaxSpeedKmh,
          nowIso, nowIso,
        );
      }
    }

    // Link best attempt to submission
    db.prepare(
      `UPDATE flight_submissions SET best_attempt_id = ? WHERE id = ?`,
    ).run(bestAttemptId, submissionId);

    // Immediately materialise task_results for this task so leaderboard is live
    rebuildTaskResults(db, taskId);
  })();

  // ── Enqueue rescore if goal reached ───────────────────────────────────────
  if (best.reachedGoal) {
    queue.enqueue<RescoreTaskPayload>('RESCORE_TASK', {
      taskId,
      leagueId: task.league_id,
      triggeredBySubmissionId: submissionId,
    });
  }

  // ── Response ───────────────────────────────────────────────────────────────
  const row = db.prepare(
    `SELECT fs.id, fs.status, fs.igc_filename, fs.igc_size_bytes, fs.submitted_at, fs.igc_date,
            fa.attempt_index, fa.reached_goal, fa.distance_flown_km, fa.task_time_s,
            fa.distance_points, fa.time_points, fa.total_points,
            fa.has_flagged_crossings, fa.last_turnpoint_index
     FROM flight_submissions fs
     LEFT JOIN flight_attempts fa ON fa.id = fs.best_attempt_id
     WHERE fs.id = ?`,
  ).get(submissionId) as any;

  const bestAttempt = {
    attemptIndex:        row.attempt_index ?? 0,
    reachedGoal:         Boolean(row.reached_goal),
    distanceFlownKm:     row.distance_flown_km ?? 0,
    taskTimeS:           row.task_time_s ?? null,
    distancePoints:      row.distance_points ?? 0,
    timePoints:          row.time_points ?? 0,
    totalPoints:         row.total_points ?? 0,
    hasFlaggedCrossings: Boolean(row.has_flagged_crossings),
    turnpointsCrossed:   row.last_turnpoint_index ?? 0,
  };

  reply.status(201).send({
    submission: {
      id:                    row.id,
      status:                row.status,
      submittedAt:           row.submitted_at,
      igcFilename:           row.igc_filename,
      igcSizeBytes:          row.igc_size_bytes,
      igcDate:               row.igc_date ?? null,
      bestAttempt,
      allAttempts:           [bestAttempt],
      timePointsProvisional: best.reachedGoal,
    },
  });
}

// =============================================================================
// DOWNLOAD HANDLER
// =============================================================================

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/igc
 *
 * Returns the original IGC file. Pilots can always download their own;
 * other pilots' are hidden until scores are frozen.
 */
export async function handleIgcDownload(
  request: FastifyRequest<{ Params: UploadRouteParams & { submissionId: string } }>,
  reply:   FastifyReply,
  db:      Database,
): Promise<void> {
  requireAuth(request, reply);

  const { submissionId } = request.params;

  const row = db.prepare(`
    SELECT s.user_id, s.igc_data, s.igc_filename, t.scores_frozen_at
    FROM flight_submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.id = ?
      AND s.deleted_at IS NULL
  `).get(submissionId) as { user_id: string; igc_data: Buffer; igc_filename: string; scores_frozen_at: string | null } | undefined;

  if (!row) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Submission not found' } });
  }

  const isOwner  = row.user_id === (request as any).user!.userId;
  const isFrozen = row.scores_frozen_at !== null;

  if (!isOwner && !isFrozen) {
    return reply.status(403).send({
      error: { code: 'SCORES_NOT_FROZEN', message: "Other pilots' IGC files are hidden until task scores are finalised" },
    });
  }

  reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Disposition', `attachment; filename="${row.igc_filename}"`)
    .header('Content-Length', row.igc_data.length)
    .header('Cache-Control', isFrozen ? 'public, max-age=86400' : 'private, no-cache')
    .send(row.igc_data);
}
