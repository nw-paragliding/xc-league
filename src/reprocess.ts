// =============================================================================
// Reprocess existing IGC submissions against the current pipeline.
//
// Triggered at boot when any flight_attempts.scorer_version differs from the
// pipeline's current SCORER_VERSION constant. Re-parses each affected IGC
// blob and replaces its flight_attempts + turnpoint_crossings rows. The
// boot-time task_results sweep in server.ts runs immediately afterward and
// re-derives per-task scores once over the new full attempt set. All writes
// per-submission are inside a transaction so a failure on one IGC leaves
// the rest intact.
// =============================================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { type PipelineInput, runPipeline, SCORER_VERSION, type TurnpointDef } from './pipeline';

interface SubmissionRow {
  id: string;
  task_id: string;
  user_id: string;
  league_id: string;
  igc_data: Buffer;
}

interface TaskConfigRow {
  id: string;
  open_date: string;
  close_date: string;
  competition_type: string;
}

interface TurnpointRow {
  id: string;
  sequence_index: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  type: string;
  force_ground: number;
  goal_line_bearing_deg: number | null;
}

export async function reprocessStaleSubmissions(db: Database): Promise<{ reprocessed: number; failed: number }> {
  // Submissions whose flight_attempts are at an older scorer version.
  // Soft-deleted submissions/attempts are excluded. Use EXISTS rather than
  // a JOIN + SELECT DISTINCT so SQLite de-dupes on the submission id alone
  // — a JOIN would force the planner to compare full igc_data BLOBs to
  // collapse the per-attempt rows.
  const stale = db
    .prepare(
      `SELECT fs.id, fs.task_id, fs.user_id, fs.league_id, fs.igc_data
       FROM flight_submissions fs
       WHERE fs.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM flight_attempts fa
           WHERE fa.submission_id = fs.id
             AND fa.scorer_version != ?
             AND fa.deleted_at IS NULL
         )`,
    )
    .all(SCORER_VERSION) as SubmissionRow[];

  if (stale.length === 0) return { reprocessed: 0, failed: 0 };

  console.log(
    `[reprocess] re-running pipeline against ${stale.length} submissions for SCORER_VERSION=${SCORER_VERSION}`,
  );

  let reprocessed = 0;
  let failed = 0;

  for (const sub of stale) {
    try {
      await reprocessOne(db, sub);
      reprocessed++;
    } catch (err) {
      // Log and skip: a single bad IGC must not block the rest of the boot.
      console.error(`[reprocess] failed for submission ${sub.id}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  // No post-loop rebuildTaskResults needed: server.ts boot sweeps
  // rebuildTaskResults for every non-deleted task immediately after this
  // returns, which is the single point that re-derives task_results.
  console.log(`[reprocess] done: ${reprocessed} re-scored, ${failed} failed`);
  return { reprocessed, failed };
}

async function reprocessOne(db: Database, sub: SubmissionRow): Promise<void> {
  const task = db
    .prepare(
      `SELECT t.id, t.open_date, t.close_date, s.competition_type
       FROM tasks t JOIN seasons s ON s.id = t.season_id
       WHERE t.id = ? AND t.deleted_at IS NULL`,
    )
    .get(sub.task_id) as TaskConfigRow | undefined;
  if (!task) throw new Error(`task ${sub.task_id} missing or deleted`);

  const turnpointRows = db
    .prepare(
      `SELECT id, sequence_index, latitude, longitude, radius_m, type, force_ground, goal_line_bearing_deg
       FROM turnpoints WHERE task_id = ? AND deleted_at IS NULL ORDER BY sequence_index ASC`,
    )
    .all(sub.task_id) as TurnpointRow[];
  if (turnpointRows.length < 2) throw new Error(`task ${sub.task_id} has fewer than 2 turnpoints`);

  const turnpointDefs: TurnpointDef[] = turnpointRows.map((tp) => ({
    id: tp.id,
    sequenceIndex: tp.sequence_index,
    lat: tp.latitude,
    lng: tp.longitude,
    radiusM: tp.radius_m,
    type: tp.type as TurnpointDef['type'],
    forceGround: tp.force_ground === 1,
    goalLineBearingDeg: tp.goal_line_bearing_deg ?? undefined,
  }));

  // turnpoint_overrides has hard FKs to crossings/attempts with no
  // ON DELETE CASCADE — if any exist for this submission we'd trip the FK
  // mid-txn and abort. Overrides are immutable audit records, so the
  // correct behaviour is to skip and surface them for manual reconciliation
  // rather than silently rewrite the world out from under the audit row.
  const hasOverrides = db
    .prepare(
      `SELECT 1 FROM turnpoint_overrides
       WHERE attempt_id IN (SELECT id FROM flight_attempts WHERE submission_id = ?)
       LIMIT 1`,
    )
    .get(sub.id);
  if (hasOverrides) {
    throw new Error(`submission has turnpoint_overrides — manual reconciliation required`);
  }

  // Goal times from *other* submissions on the same task — needed by the
  // pipeline's time-points calculation when scoring this submission's
  // attempts. The boot-time task_results sweep in server.ts re-derives
  // per-task scores afterward from the full attempt set.
  const otherGoalTimes = db
    .prepare(
      `SELECT task_time_s FROM flight_attempts
       WHERE task_id = ? AND submission_id != ?
         AND reached_goal = 1 AND task_time_s IS NOT NULL AND deleted_at IS NULL`,
    )
    .all(sub.task_id, sub.id) as Array<{ task_time_s: number }>;
  const existingGoalTimes = otherGoalTimes.map((r) => r.task_time_s);

  const otherBest = db
    .prepare(
      `SELECT MAX(distance_flown_km) AS best FROM flight_attempts
       WHERE task_id = ? AND submission_id != ? AND deleted_at IS NULL`,
    )
    .get(sub.task_id, sub.id) as { best: number | null };
  const taskBestDistanceKm = otherBest.best ?? 0;

  const input: PipelineInput = {
    igcText: sub.igc_data.toString('utf8'),
    task: { id: sub.task_id, turnpoints: turnpointDefs, closeDate: new Date(task.close_date).getTime() },
    existingGoalTimes,
    competitionType: task.competition_type === 'HIKE_AND_FLY' ? 'HIKE_AND_FLY' : 'XC',
  };

  // scoresFrozenAt = null: re-processing should not be blocked by freeze state
  // (the original upload already passed the gate; we're only re-scoring).
  const result = await runPipeline(
    input,
    task.open_date.slice(0, 10),
    task.close_date.slice(0, 10),
    null,
    taskBestDistanceKm,
  );
  if (!result.ok) {
    // The original upload succeeded against the prior scorer; failure here
    // means the IGC is somehow incompatible with the current code (e.g. a
    // header parser tightened). Skip without modifying stored data so the
    // pilot's existing flight_attempts stay intact.
    throw new Error(`pipeline rejected IGC: ${result.error.stage}/${(result.error.error as { code: string }).code}`);
  }

  const { scoredAttempts, bestAttemptIndex } = result.value;
  const attemptIds = scoredAttempts.map(() => randomUUID());
  const bestAttemptId = attemptIds[bestAttemptIndex];
  const nowIso = new Date().toISOString();

  db.transaction(() => {
    // Drop only the task_results rows that point at this submission's
    // attempts — the FK is task_results.best_attempt_id → flight_attempts(id),
    // and we're about to delete those attempts. A full per-task DELETE +
    // rebuild here would be O(N²) when many stale submissions share a task;
    // the boot sweep in server.ts re-derives the whole table once afterward.
    db.prepare(
      `DELETE FROM task_results
       WHERE best_attempt_id IN (SELECT id FROM flight_attempts WHERE submission_id = ?)`,
    ).run(sub.id);

    // Drop old attempt + crossing rows for this submission. Reprocess is
    // re-scoring the same IGC against a newer SCORER_VERSION, so we need
    // to replace the existing rows wholesale; soft-delete would leave the
    // stale attempts visible alongside the freshly-scored ones, so hard-
    // delete is the right call. turnpoint_crossings has no soft-delete
    // column either, so the same delete-and-reinsert applies.
    db.prepare(
      `DELETE FROM turnpoint_crossings
       WHERE attempt_id IN (SELECT id FROM flight_attempts WHERE submission_id = ?)`,
    ).run(sub.id);
    db.prepare(`DELETE FROM flight_attempts WHERE submission_id = ?`).run(sub.id);

    for (let i = 0; i < scoredAttempts.length; i++) {
      const attempt = scoredAttempts[i];
      const attemptId = attemptIds[i];
      const sssTs = new Date(attempt.sssCrossing.crossingTime).toISOString();
      const essTs = attempt.essCrossing ? new Date(attempt.essCrossing.crossingTime).toISOString() : null;
      const goalTs = attempt.goalCrossing ? new Date(attempt.goalCrossing.crossingTime).toISOString() : null;

      db.prepare(
        `INSERT INTO flight_attempts (
          id, submission_id, task_id, user_id,
          sss_crossing_time, ess_crossing_time, goal_crossing_time, task_time_s,
          reached_goal, last_turnpoint_index,
          distance_flown_km, distance_points, time_points, total_points,
          has_flagged_crossings, attempt_index, scorer_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attemptId,
        sub.id,
        sub.task_id,
        sub.user_id,
        sssTs,
        essTs,
        goalTs,
        attempt.taskTimeS !== null ? Math.round(attempt.taskTimeS) : null,
        attempt.reachedGoal ? 1 : 0,
        attempt.lastTurnpointIndex,
        attempt.distanceFlownKm,
        attempt.distancePoints,
        attempt.timePoints,
        attempt.totalPoints,
        attempt.hasFlaggedCrossings ? 1 : 0,
        attempt.attemptIndex,
        SCORER_VERSION,
        nowIso,
        nowIso,
      );

      for (const crossing of attempt.turnpointCrossings) {
        db.prepare(
          `INSERT INTO turnpoint_crossings (
            id, attempt_id, turnpoint_id, sequence_index, crossing_time,
            ground_check_required, ground_confirmed, detected_max_speed_kmh,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          attemptId,
          crossing.turnpointId,
          crossing.sequenceIndex,
          new Date(crossing.crossingTime).toISOString(),
          crossing.groundCheckRequired ? 1 : 0,
          crossing.groundConfirmed ? 1 : 0,
          crossing.detectedMaxSpeedKmh,
          nowIso,
          nowIso,
        );
      }
    }

    db.prepare(`UPDATE flight_submissions SET best_attempt_id = ?, updated_at = ? WHERE id = ?`).run(
      bestAttemptId,
      nowIso,
      sub.id,
    );
  })();
}
