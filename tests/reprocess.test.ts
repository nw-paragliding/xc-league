// =============================================================================
// reprocessStaleSubmissions — boot-time IGC reprocess against SCORER_VERSION
// =============================================================================
//
// The reprocess loop distinguishes two pipeline failure classes:
//
//  - DETECTION-stage failures (IGC parsed fine, but the current rules find
//    no valid attempt — e.g. NO_SSS_CROSSING for a submission whose only
//    SSS tag fell in a tolerance band that has since been retired) are a
//    legitimate re-scoring outcome: the stored attempt/crossing/task_results
//    rows are cleared so the pilot drops off the leaderboard and the
//    staleness probe stops re-selecting the submission on every boot.
//  - PARSE/DATE-stage failures (genuine incompatibility, e.g. a corrupt or
//    unparseable IGC blob) are conservatively skipped — stored rows are
//    left untouched pending manual reconciliation.
// =============================================================================

import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildTaskResults } from '../src/job-queue';
import { reprocessStaleSubmissions } from '../src/reprocess';
import { SCORER_VERSION } from '../src/shared/pipeline';
import { FIXTURE_IGC, FIXTURE_TURNPOINTS } from '../src/shared/pipeline-parity-fixture';
import {
  createTestAttempt,
  createTestLeague,
  createTestSeason,
  createTestSubmission,
  createTestTask,
  createTestTaskResult,
  createTestUser,
  setupTestDatabase,
} from './helpers';
import { getTestDb, resetTestDb } from './setup';

// A track that stays ~6.6 km south of every FIXTURE_TURNPOINTS cylinder the
// whole flight (cylinders sit at 47.50 / 47.52 / 47.54, radius 400 m) — it
// never crosses the SSS boundary at all, so runPipeline rejects it with
// DETECTION/NO_SSS_CROSSING regardless of exactly how wide the cylinder
// tolerance is. Same IGC shape as FIXTURE_IGC (5 fixes, 1/min, same date),
// just shifted south.
const NO_SSS_IGC = [
  'AXLK00001',
  'HFDTE230126',
  'B1000004723700N12200000WA0050000500',
  'B1001004724000N12200000WA0050000500',
  'B1002004724600N12200000WA0050000500',
  'B1003004725200N12200000WA0050000500',
  'B1004004726400N12200000WA0050000500',
].join('\n');

const TASK_OPEN_DATE = '2026-01-01T00:00:00Z';
const TASK_CLOSE_DATE = '2026-01-31T23:59:59Z';

function insertFixtureTurnpoints(db: ReturnType<typeof getTestDb>, taskId: string) {
  const now = new Date().toISOString();
  for (const tp of FIXTURE_TURNPOINTS) {
    db.prepare(
      `INSERT INTO turnpoints (
         id, task_id, sequence_index, name, latitude, longitude, radius_m, type,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), taskId, tp.sequenceIndex, tp.id, tp.lat, tp.lng, tp.radiusM, tp.type, now, now);
  }
}

function setSubmissionIgc(db: ReturnType<typeof getTestDb>, submissionId: string, igcText: string) {
  db.prepare(`UPDATE flight_submissions SET igc_data = ? WHERE id = ?`).run(Buffer.from(igcText, 'utf8'), submissionId);
}

describe('reprocessStaleSubmissions', () => {
  let db: ReturnType<typeof getTestDb>;
  let leagueId: string;
  let seasonId: string;

  beforeEach(() => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    const league = createTestLeague(db);
    leagueId = league.id;
    seasonId = createTestSeason(db, leagueId).id;
  });

  it('clears attempts/crossings/task_results for a stale submission that no longer produces a valid attempt (DETECTION), and the leaderboard drops the pilot', async () => {
    const user = createTestUser(db);
    const task = createTestTask(db, seasonId, leagueId, { openDate: TASK_OPEN_DATE, closeDate: TASK_CLOSE_DATE });
    insertFixtureTurnpoints(db, task.id);

    const submissionId = createTestSubmission(db, task.id, user.id, leagueId);
    setSubmissionIgc(db, submissionId, NO_SSS_IGC);

    // Stale 1.x-era attempt + the task_results row it backs — as if this
    // pilot scored under a since-retired tolerance.
    const staleAttemptId = createTestAttempt(db, submissionId, task.id, user.id, leagueId, {
      distanceFlownKm: 5,
      reachedGoal: false,
    });
    createTestTaskResult(db, task.id, user.id, leagueId, staleAttemptId, { distanceFlownKm: 5 });

    const before = db.prepare(`SELECT scorer_version FROM flight_attempts WHERE id = ?`).get(staleAttemptId) as {
      scorer_version: string;
    };
    expect(before.scorer_version).not.toBe(SCORER_VERSION);

    const result = await reprocessStaleSubmissions(db);
    expect(result).toEqual({ reprocessed: 1, failed: 0 });

    // Stored attempt/crossing rows for this submission are gone.
    const attempts = db.prepare(`SELECT * FROM flight_attempts WHERE submission_id = ?`).all(submissionId);
    expect(attempts).toHaveLength(0);
    const crossings = db.prepare(`SELECT * FROM turnpoint_crossings WHERE attempt_id = ?`).all(staleAttemptId);
    expect(crossings).toHaveLength(0);

    // The task_results row tied to the deleted attempt is gone directly...
    const taskResults = db.prepare(`SELECT * FROM task_results WHERE task_id = ?`).all(task.id);
    expect(taskResults).toHaveLength(0);

    // ...and stays gone after the boot-time rebuild sweep server.ts runs
    // immediately after reprocessStaleSubmissions (the single point that
    // re-derives task_results from the full attempt set).
    rebuildTaskResults(db, task.id);
    const afterRebuild = db.prepare(`SELECT * FROM task_results WHERE task_id = ?`).all(task.id);
    expect(afterRebuild).toHaveLength(0);

    // The submission no longer points at a deleted attempt.
    const submission = db.prepare(`SELECT best_attempt_id FROM flight_submissions WHERE id = ?`).get(submissionId) as {
      best_attempt_id: string | null;
    };
    expect(submission.best_attempt_id).toBeNull();

    // The staleness probe's EXISTS subquery has nothing left to match —
    // a second run selects and reprocesses nothing. The loop is over.
    const second = await reprocessStaleSubmissions(db);
    expect(second).toEqual({ reprocessed: 0, failed: 0 });
  });

  it('does not modify stored rows for a parse-level failure (corrupt IGC) — conservative skip', async () => {
    const user = createTestUser(db);
    const task = createTestTask(db, seasonId, leagueId, { openDate: TASK_OPEN_DATE, closeDate: TASK_CLOSE_DATE });
    insertFixtureTurnpoints(db, task.id);

    const submissionId = createTestSubmission(db, task.id, user.id, leagueId);
    setSubmissionIgc(db, submissionId, 'this is not a valid IGC file\njust garbage text\n');

    const attemptId = createTestAttempt(db, submissionId, task.id, user.id, leagueId, {
      distanceFlownKm: 9,
      reachedGoal: true,
      taskTimeS: 1000,
    });
    createTestTaskResult(db, task.id, user.id, leagueId, attemptId, { distanceFlownKm: 9 });

    const result = await reprocessStaleSubmissions(db);
    expect(result).toEqual({ reprocessed: 0, failed: 1 });

    const attemptAfter = db.prepare(`SELECT * FROM flight_attempts WHERE id = ?`).get(attemptId) as {
      distance_flown_km: number;
      reached_goal: number;
      scorer_version: string;
    };
    expect(attemptAfter).toBeDefined();
    expect(attemptAfter.distance_flown_km).toBe(9);
    expect(attemptAfter.reached_goal).toBe(1);
    expect(attemptAfter.scorer_version).not.toBe(SCORER_VERSION);

    const taskResultAfter = db.prepare(`SELECT * FROM task_results WHERE task_id = ?`).all(task.id);
    expect(taskResultAfter).toHaveLength(1);
  });

  it('reprocesses a healthy stale submission normally (regression guard on the happy path)', async () => {
    const user = createTestUser(db);
    const task = createTestTask(db, seasonId, leagueId, { openDate: TASK_OPEN_DATE, closeDate: TASK_CLOSE_DATE });
    insertFixtureTurnpoints(db, task.id);

    const submissionId = createTestSubmission(db, task.id, user.id, leagueId);
    setSubmissionIgc(db, submissionId, FIXTURE_IGC);

    createTestAttempt(db, submissionId, task.id, user.id, leagueId, { distanceFlownKm: 1, reachedGoal: false });

    const result = await reprocessStaleSubmissions(db);
    expect(result).toEqual({ reprocessed: 1, failed: 0 });

    const attempts = db.prepare(`SELECT * FROM flight_attempts WHERE submission_id = ?`).all(submissionId) as Array<{
      reached_goal: number;
      scorer_version: string;
      distance_flown_km: number;
    }>;
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) expect(a.scorer_version).toBe(SCORER_VERSION);
    expect(attempts.some((a) => a.reached_goal === 1)).toBe(true);

    rebuildTaskResults(db, task.id);
    const taskResults = db.prepare(`SELECT * FROM task_results WHERE task_id = ?`).all(task.id);
    expect(taskResults).toHaveLength(1);

    // Fully re-scored — a second run finds nothing stale left.
    const second = await reprocessStaleSubmissions(db);
    expect(second).toEqual({ reprocessed: 0, failed: 0 });
  });
});
