// =============================================================================
// XC / Hike & Fly League Platform — IGC Upload Handler
//
// POST /api/v1/leagues/:leagueSlug/tasks/:taskId/submissions
//
// Design decisions (from spec):
//  - Synchronous processing: pipeline runs inline, result returned immediately
//  - 5MB hard limit, .igc extension required, first line must start with 'A'
//  - Duplicate detection: SHA-256 of file content; same pilot+task+hash → reject
//  - IGC stored as BLOB in SQLite alongside filename and size
//  - RESCORE_TASK enqueued only when best attempt reached goal
//  - Time points are provisional for goal pilots until RESCORE_TASK completes
//
// NOTE: Two known fixes pending from session summary:
//  1. formatPipelineError returns string, not {code, message}
//  2. flightDate field (igc-parser uses `date`, pipeline renames to flightDate)
// =============================================================================

import { createHash }         from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Database }      from 'better-sqlite3';
import { runPipeline, formatPipelineError } from './pipeline';
import type { SQLiteJobQueue }              from './job-queue';
import { requireAuth, requireLeagueMember } from './auth';

// =============================================================================
// TYPES
// =============================================================================

interface UploadRouteParams {
  leagueSlug: string;
  taskId:     string;
}

interface TaskRow {
  id:                     number;
  league_id:              number;
  name:                   string;
  status:                 'DRAFT' | 'OPEN' | 'CLOSED' | 'SCORED';
  open_date:              string;
  close_date:             string;
  earth_datum:            string;
  projection_origin_lat:  number | null;
  projection_origin_lng:  number | null;
}

interface SubmissionRow {
  id:             number;
  task_id:        number;
  user_id:        number;
  igc_filename:   string;
  igc_size_bytes: number;
  igc_sha256:     string;
  status:         string;
  distance_km:    number | null;
  time_seconds:   number | null;
  distance_pts:   number | null;
  time_pts:       number | null;
  total_pts:      number | null;
  reached_goal:   number; // SQLite boolean
  scored_at:      string | null;
  created_at:     string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB — enforced by @fastify/multipart too
const IGC_MAGIC    = 'A';               // All IGC files start with 'A' manufacturer record

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * POST /api/v1/leagues/:leagueSlug/tasks/:taskId/submissions
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

  const userId = request.user!.userId;
  const taskId = parseInt(request.params.taskId, 10);
  if (isNaN(taskId)) {
    return reply.status(400).send({ error: { code: 'INVALID_TASK_ID', message: 'taskId must be a number' } });
  }

  // ── Resolve task ───────────────────────────────────────────────────────────
  const task = db.prepare<[number, number]>(
    `SELECT t.* FROM tasks t
     JOIN leagues l ON l.id = t.league_id
     WHERE t.id = ?
       AND l.id = ?
       AND t.deleted_at IS NULL`,
  ).get(taskId, request.league!.id) as TaskRow | undefined;

  if (!task) {
    return reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
  }

  if (task.status !== 'OPEN') {
    return reply.status(409).send({
      error: {
        code:    'TASK_NOT_OPEN',
        message: `Task is ${task.status.toLowerCase()} — submissions are not accepted`,
      },
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

    // Validate extension
    const filename = data.filename ?? 'flight.igc';
    if (!filename.toLowerCase().endsWith('.igc')) {
      return reply.status(400).send({
        error: { code: 'INVALID_FILE_TYPE', message: 'File must have .igc extension' },
      });
    }
    originalFilename = filename;

    // Read into buffer (multipart enforces MAX_FILE_SIZE via plugin config)
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

  const duplicate = db.prepare<[number, number, string]>(
    `SELECT id FROM submissions WHERE task_id = ? AND user_id = ? AND igc_sha256 = ? LIMIT 1`,
  ).get(taskId, userId, sha256);

  if (duplicate) {
    return reply.status(409).send({
      error: { code: 'DUPLICATE_SUBMISSION', message: 'You have already submitted this IGC file for this task' },
    });
  }

  // ── Load task turnpoints for pipeline ─────────────────────────────────────
  const turnpoints = db.prepare<[number]>(
    `SELECT id, sequence_index, name, latitude, longitude, radius_m, type, is_sss, is_ess, is_goal
     FROM turnpoints
     WHERE task_id = ?
     ORDER BY sequence_index ASC`,
  ).all(taskId) as any[];

  if (turnpoints.length < 2) {
    return reply.status(422).send({
      error: { code: 'TASK_NOT_CONFIGURED', message: 'Task has no turnpoints configured' },
    });
  }

  // ── Run pipeline ───────────────────────────────────────────────────────────
  const igcText   = fileBuffer.toString('utf8');
  const pipelineResult = await runPipeline(igcText, {
    taskId,
    turnpoints,
    projectionOriginLat: task.projection_origin_lat ?? undefined,
    projectionOriginLng: task.projection_origin_lng ?? undefined,
  });

  if (!pipelineResult.ok) {
    // formatPipelineError returns a string describing the failure
    const message = formatPipelineError(pipelineResult.error);
    return reply.status(422).send({
      error: { code: 'PIPELINE_ERROR', message },
    });
  }

  const scored = pipelineResult.value;

  // ── Persist submission ─────────────────────────────────────────────────────
  const now = new Date().toISOString();

  const insertSubmission = db.prepare(`
    INSERT INTO submissions (
      task_id, user_id,
      igc_data, igc_filename, igc_size_bytes, igc_sha256,
      status,
      distance_km, time_seconds,
      distance_pts, time_pts, total_pts,
      reached_goal,
      scored_at, created_at, updated_at
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?,
      'SCORED',
      ?, ?,
      ?, ?, ?,
      ?,
      ?, ?, ?
    )
  `);

  const insertCrossing = db.prepare(`
    INSERT INTO turnpoint_crossings (
      submission_id, turnpoint_id, sequence_index,
      crossed_at, latitude, longitude, altitude_m,
      is_ground_flagged, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let submissionId: number;

  // Single transaction: write submission + crossings atomically
  const insertAll = db.transaction(() => {
    const result = insertSubmission.run(
      taskId, userId,
      fileBuffer, originalFilename, fileBuffer.length, sha256,
      scored.distanceKm,  scored.timeSeconds ?? null,
      scored.distancePts, scored.timePts ?? null,
      scored.totalPts,
      scored.reachedGoal ? 1 : 0,
      now, now, now,
    );
    submissionId = result.lastInsertRowid as number;

    for (const crossing of scored.crossings) {
      insertCrossing.run(
        submissionId,
        crossing.turnpointId,
        crossing.sequenceIndex,
        crossing.crossedAt,
        crossing.latitude,
        crossing.longitude,
        crossing.altitudeM,
        crossing.isGroundFlagged ? 1 : 0,
        now,
      );
    }

    return submissionId;
  });

  submissionId = insertAll() as number;

  // ── Enqueue rescore if goal reached ───────────────────────────────────────
  // Time points are provisional until all pilots' results are known.
  // RESCORE_TASK recalculates time points once and triggers REBUILD_STANDINGS.
  if (scored.reachedGoal) {
    queue.enqueue('RESCORE_TASK', { taskId });
  }

  // ── Response ───────────────────────────────────────────────────────────────
  const submission = db.prepare<[number]>(
    `SELECT * FROM submissions WHERE id = ?`,
  ).get(submissionId) as SubmissionRow;

  reply.status(201).send({
    submission: formatSubmission(submission),
    provisional: scored.reachedGoal, // time points may change until task closes
  });
}

// =============================================================================
// DOWNLOAD HANDLER
// =============================================================================

/**
 * GET /api/v1/leagues/:leagueSlug/tasks/:taskId/submissions/:submissionId/igc
 *
 * Returns the original IGC file. Pilots can always download their own;
 * other pilots' files are hidden until the task scores are frozen.
 */
export async function handleIgcDownload(
  request: FastifyRequest<{ Params: UploadRouteParams & { submissionId: string } }>,
  reply:   FastifyReply,
  db:      Database,
): Promise<void> {
  requireAuth(request, reply);

  const submissionId = parseInt(request.params.submissionId, 10);
  if (isNaN(submissionId)) {
    return reply.status(400).send({ error: { code: 'INVALID_ID', message: 'submissionId must be a number' } });
  }

  const row = db.prepare<[number]>(`
    SELECT s.user_id, s.igc_data, s.igc_filename, t.scores_frozen_at
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.id = ?
      AND s.deleted_at IS NULL
  `).get(submissionId) as { user_id: number; igc_data: Buffer; igc_filename: string; scores_frozen_at: string | null } | undefined;

  if (!row) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Submission not found' } });
  }

  const isOwner  = row.user_id === request.user!.userId;
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

// =============================================================================
// HELPERS
// =============================================================================

function formatSubmission(row: SubmissionRow) {
  return {
    id:           row.id,
    taskId:       row.task_id,
    userId:       row.user_id,
    status:       row.status,
    distanceKm:   row.distance_km,
    timeSeconds:  row.time_seconds,
    distancePts:  row.distance_pts,
    timePts:      row.time_pts,
    totalPts:     row.total_pts,
    reachedGoal:  Boolean(row.reached_goal),
    scoredAt:     row.scored_at,
    createdAt:    row.created_at,
    igcFilename:  row.igc_filename,
    igcSizeBytes: row.igc_size_bytes,
  };
}
