// =============================================================================
// XC / Hike & Fly League Platform — Track Replay Handler
//
// GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/track
//
// Returns the full GPS track for a submission plus turnpoint crossing events,
// suitable for rendering a map replay in the frontend.
//
// Design notes:
//   - Fixes are re-parsed from the raw IGC BLOB on demand — not stored in DB.
//     Storing ~10k fixes per submission would bloat the database for rarely-
//     accessed data. Re-parsing a 400KB IGC file takes ~20ms.
//   - Turnpoint crossings come from the DB (already computed at submission
//     time) — no need to re-run the scoring pipeline.
//   - Access control: own submission always visible; other pilots' tracks
//     only visible after task closes (scores frozen) to prevent live cheating.
//   - Response is a single JSON object. At full resolution a 3-hour flight
//     at 1Hz yields ~10,800 fixes (~320KB JSON). The frontend should render
//     progressively rather than blocking on the full payload.
// =============================================================================

import type { Fix } from './pipeline';
import { parseAndValidate } from './pipeline';

// =============================================================================
// INLINE STUBS — replaced by real Fastify types in your project
// =============================================================================

interface FastifyRequest {
  params: unknown;
  user: { userId: string; isAdmin: boolean } | null;
  membership: { role: 'ADMIN' | 'PILOT' | 'SPECTATOR' } | null;
}
interface FastifyReply {
  status(code: number): FastifyReply;
  send(payload?: unknown): FastifyReply;
  header(key: string, value: string): FastifyReply;
}

// =============================================================================
// RESPONSE SHAPE
// =============================================================================

/**
 * A single GPS fix in the replay response.
 * Timestamp is Unix ms (integer) — smaller than ISO strings over 10k+ fixes.
 * Altitude is GPS altitude in metres (pressure alt omitted — less useful for display).
 */
interface ReplayFix {
  t: number; // Unix ms
  lat: number; // WGS84 decimal degrees
  lng: number; // WGS84 decimal degrees
  alt: number; // GPS altitude metres
}

/**
 * A turnpoint crossing event.
 * Returned in sequence order so the frontend can animate them in order.
 */
interface ReplayCrossing {
  turnpointId: string;
  turnpointName: string;
  sequenceIndex: number;
  crossingTimeMs: number; // Unix ms — interpolated crossing time from pipeline
  type: string; // 'SSS' | 'CYLINDER' | 'GOAL_CYLINDER' | 'GOAL_LINE' | etc.
  radiusM: number;
  latitude: number;
  longitude: number;
  /** Hike & fly only — whether the crossing was confirmed as ground speed */
  groundConfirmed: boolean;
  groundCheckRequired: boolean;
}

interface TrackReplayResponse {
  submissionId: string;
  taskId: string;
  pilotId: string;
  pilotName: string;
  flightDate: string; // 'YYYY-MM-DD'
  fixes: ReplayFix[];
  crossings: ReplayCrossing[];
  /** Bounds for initial map viewport */
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  meta: {
    fixCount: number;
    durationS: number | null; // last fix time - first fix time in seconds
    reachedGoal: boolean;
    totalPoints: number; // from best attempt for this submission
  };
}

// =============================================================================
// HANDLER
// =============================================================================

export async function handleTrackReplay(request: any, reply: any, db: Database): Promise<void> {
  const { submissionId } = request.params as { submissionId: string };
  const userId = request.user?.userId ?? null;

  // ── 1. Load submission + task metadata ───────────────────────────────────

  const submission = db.get<SubmissionRow>(
    `SELECT
       fs.id,
       fs.task_id        AS taskId,
       fs.user_id        AS pilotId,
       fs.igc_data       AS igcData,
       fs.igc_date       AS igcDate,
       fs.status,
       fs.best_attempt_id AS bestAttemptId,
       u.display_name    AS pilotName,
       t.close_date      AS taskCloseDate,
       t.scores_frozen_at AS scoresFrozenAt
     FROM flight_submissions fs
     JOIN users u  ON u.id  = fs.user_id
     JOIN tasks t  ON t.id  = fs.task_id
     WHERE fs.id = ? AND fs.deleted_at IS NULL`,
    [submissionId],
  );

  if (!submission) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Submission not found' } });
    return;
  }

  // ── 2. Access control ─────────────────────────────────────────────────────
  //
  // Rules:
  //   - Own submission: always visible (pilot reviewing their own track)
  //   - League admin / super-admin: always visible
  //   - Other pilots: only after task closes (scores_frozen_at is set)
  //     Reason: live track access before close would let pilots see if a
  //     competitor reached goal and adjust their own submission strategy.

  const isOwn = userId === submission.pilotId;
  const isAdmin = request.user?.isAdmin || request.membership?.role === 'ADMIN';
  const taskClosed = submission.scoresFrozenAt !== null;

  if (!isOwn && !isAdmin && !taskClosed) {
    reply.status(403).send({
      error: {
        code: 'TASK_STILL_OPEN',
        message: "Other pilots' tracks are not visible until the task closes",
      },
    });
    return;
  }

  // ── 3. Check submission was actually processed ────────────────────────────

  if (submission.status !== 'PROCESSED') {
    reply.status(422).send({
      error: {
        code: 'SUBMISSION_NOT_PROCESSED',
        message: `Submission status is '${submission.status}' — track not available`,
      },
    });
    return;
  }

  // ── 4. Re-parse IGC from BLOB ─────────────────────────────────────────────
  //
  // better-sqlite3 returns BLOB columns as Buffer. We decode to UTF-8 string
  // then pass to parseAndValidate (same function used during submission).
  // This takes ~10–30ms for a typical flight — acceptable for an on-demand endpoint.

  const igcText = (submission.igcData as any).toString('utf8') as string;
  const parseResult = parseAndValidate(igcText);

  if (!parseResult.ok) {
    // Should never happen — we already validated on submission — but handle defensively
    reply.status(500).send({
      error: {
        code: 'IGC_REPARSE_FAILED',
        message: 'Failed to re-parse IGC file. Please contact support.',
      },
    });
    return;
  }

  const { fixes, flightDate } = parseResult.value;

  // ── 5. Load turnpoint crossings from DB ───────────────────────────────────
  //
  // We use the stored crossing times rather than re-running the pipeline.
  // Crossings are joined with turnpoints to get geometry and type for the map.

  const crossingRows = db.all<CrossingRow>(
    `SELECT
       tc.turnpoint_id           AS turnpointId,
       tc.sequence_index         AS sequenceIndex,
       tc.crossing_time          AS crossingTime,
       tc.ground_check_required  AS groundCheckRequired,
       tc.ground_confirmed       AS groundConfirmed,
       tp.name                   AS turnpointName,
       tp.type                   AS type,
       tp.radius_m               AS radiusM,
       tp.latitude               AS latitude,
       tp.longitude              AS longitude
     FROM turnpoint_crossings tc
     JOIN turnpoints tp ON tp.id = tc.turnpoint_id
     WHERE tc.attempt_id = ?
     ORDER BY tc.sequence_index ASC`,
    [submission.bestAttemptId],
  );

  // ── 6. Load best attempt for meta ─────────────────────────────────────────

  const bestAttempt = db.get<BestAttemptRow>(
    `SELECT reached_goal AS reachedGoal, total_points AS totalPoints
     FROM flight_attempts WHERE id = ?`,
    [submission.bestAttemptId],
  );

  // ── 7. Build response ─────────────────────────────────────────────────────

  const replayFixes: ReplayFix[] = fixes.map((fix) => ({
    t: fix.timestamp,
    lat: fix.lat,
    lng: fix.lng,
    alt: fix.gpsAlt,
  }));

  const crossings: ReplayCrossing[] = crossingRows.map((row) => ({
    turnpointId: row.turnpointId,
    turnpointName: row.turnpointName,
    sequenceIndex: row.sequenceIndex,
    crossingTimeMs: new Date(row.crossingTime).getTime(),
    type: row.type,
    radiusM: row.radiusM,
    latitude: row.latitude,
    longitude: row.longitude,
    groundConfirmed: Boolean(row.groundConfirmed),
    groundCheckRequired: Boolean(row.groundCheckRequired),
  }));

  const bounds = computeBounds(fixes);

  const firstFixTime = fixes[0]?.timestamp ?? null;
  const lastFixTime = fixes[fixes.length - 1]?.timestamp ?? null;
  const durationS =
    firstFixTime !== null && lastFixTime !== null ? Math.round((lastFixTime - firstFixTime) / 1000) : null;

  const response: TrackReplayResponse = {
    submissionId: submission.id,
    taskId: submission.taskId,
    pilotId: submission.pilotId,
    pilotName: submission.pilotName,
    flightDate: flightDate,
    fixes: replayFixes,
    crossings,
    bounds,
    meta: {
      fixCount: fixes.length,
      durationS,
      reachedGoal: Boolean(bestAttempt?.reachedGoal),
      totalPoints: bestAttempt?.totalPoints ?? 0,
    },
  };

  // Set cache headers — track data never changes after submission is processed
  // 1 hour for own/admin views; 24 hours for public views (task closed)
  const maxAge = isOwn || isAdmin ? 3600 : 86400;
  reply.header('Cache-Control', `private, max-age=${maxAge}`).status(200).send(response);
}

// =============================================================================
// HELPERS
// =============================================================================

/** Compute tight bounding box over all fixes for initial map viewport */
function computeBounds(fixes: Fix[]): TrackReplayResponse['bounds'] {
  let north = -90,
    south = 90,
    east = -180,
    west = 180;
  for (const fix of fixes) {
    if (fix.lat > north) north = fix.lat;
    if (fix.lat < south) south = fix.lat;
    if (fix.lng > east) east = fix.lng;
    if (fix.lng < west) west = fix.lng;
  }
  // Add a small margin so the track doesn't sit right at the viewport edge
  const latPad = (north - south) * 0.05;
  const lngPad = (east - west) * 0.05;
  return {
    north: north + latPad,
    south: south - latPad,
    east: east + lngPad,
    west: west - lngPad,
  };
}

// =============================================================================
// DB ROW TYPES
// =============================================================================

interface SubmissionRow {
  id: string;
  taskId: string;
  pilotId: string;
  igcData: unknown; // Buffer from better-sqlite3
  igcDate: string | null;
  status: string;
  bestAttemptId: string;
  pilotName: string;
  taskCloseDate: string;
  scoresFrozenAt: string | null;
}

interface CrossingRow {
  turnpointId: string;
  sequenceIndex: number;
  crossingTime: string; // ISO 8601 UTC
  groundCheckRequired: number; // SQLite integer boolean
  groundConfirmed: number;
  turnpointName: string;
  type: string;
  radiusM: number;
  latitude: number;
  longitude: number;
}

interface BestAttemptRow {
  reachedGoal: number; // SQLite integer boolean
  totalPoints: number;
}

// =============================================================================
// PLACEHOLDER DB TYPE
// =============================================================================

declare class Database {
  get<T>(sql: string, params?: any[]): T | null;
  all<T>(sql: string, params?: any[]): T[];
}
