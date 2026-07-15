// =============================================================================
// Standings + Leaderboard API — Integration Tests
// =============================================================================

import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { authPlugin, loadAuthConfig } from '../../src/auth';
import { rebuildTaskResults } from '../../src/job-queue';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import {
  addLeagueMember,
  createTestAttempt,
  createTestLeague,
  createTestSeason,
  createTestSubmission,
  createTestTask,
  createTestTaskResult,
  createTestUser,
  setupTestDatabase,
} from '../helpers';
import { getTestDb, resetTestDb } from '../setup';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture setup
// ─────────────────────────────────────────────────────────────────────────────

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof getTestDb>;
let pilot: ReturnType<typeof createTestUser>;
let pilot2: ReturnType<typeof createTestUser>;
let league: ReturnType<typeof createTestLeague>;
let season: ReturnType<typeof createTestSeason>;
let task: ReturnType<typeof createTestTask>;

beforeEach(async () => {
  resetTestDb();
  db = getTestDb();
  setupTestDatabase(db);

  pilot = createTestUser(db, { displayName: 'Alice Smith' });
  pilot2 = createTestUser(db, { displayName: 'Bob Jones' });
  league = createTestLeague(db, { slug: 'test-league' });
  season = createTestSeason(db, league.id);
  task = createTestTask(db, season.id, league.id, { name: 'Task 1' });

  addLeagueMember(db, league.id, pilot.id, 'pilot');
  addLeagueMember(db, league.id, pilot2.id, 'pilot');

  app = Fastify();
  await app.register(authPlugin, { config: loadAuthConfig(), db });
  await registerLeagueRoutes(app, { db });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /leagues/:leagueSlug/seasons/:seasonId/standings
// ─────────────────────────────────────────────────────────────────────────────

describe('GET standings', () => {
  const url = () => `/leagues/${league.slug}/seasons/${season.id}/standings`;

  it('returns 200 with season and empty standings when no pilots have flown', async () => {
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.season.id).toBe(season.id);
    expect(body.season.name).toBe(season.name);
    expect(body.season.competitionType).toBeDefined();
    expect(body.standings).toEqual([]);
  });

  it('returns pilots sorted by rank with correct fields', async () => {
    // Seed task_results across two tasks for pilot1, one task for pilot2.
    // Standings is now a live aggregate over task_results.
    const task2 = createTestTask(db, season.id, league.id, { name: 'Task 2' });
    const sub1a = createTestSubmission(db, task.id, pilot.id, league.id);
    const att1a = createTestAttempt(db, sub1a, task.id, pilot.id, league.id, { reachedGoal: true, taskTimeS: 4200 });
    createTestTaskResult(db, task.id, pilot.id, league.id, att1a, {
      rank: 1,
      reachedGoal: true,
      totalPoints: 500,
    });
    const sub1b = createTestSubmission(db, task2.id, pilot.id, league.id);
    const att1b = createTestAttempt(db, sub1b, task2.id, pilot.id, league.id, { reachedGoal: false });
    createTestTaskResult(db, task2.id, pilot.id, league.id, att1b, {
      rank: 1,
      totalPoints: 300,
    });
    const sub2a = createTestSubmission(db, task.id, pilot2.id, league.id);
    const att2a = createTestAttempt(db, sub2a, task.id, pilot2.id, league.id, { reachedGoal: false });
    createTestTaskResult(db, task.id, pilot2.id, league.id, att2a, {
      rank: 2,
      totalPoints: 500,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });

    expect(res.statusCode).toBe(200);
    const { standings } = JSON.parse(res.body);
    expect(standings).toHaveLength(2);

    const [first, second] = standings;
    expect(first.rank).toBe(1);
    expect(first.pilotId).toBe(pilot.id);
    expect(first.pilotName).toBe('Alice Smith');
    expect(first.totalPoints).toBe(800); // 500 + 300
    expect(first.tasksFlown).toBe(2);
    expect(first.tasksWithGoal).toBe(1);

    expect(second.rank).toBe(2);
    expect(second.pilotId).toBe(pilot2.id);
    expect(second.totalPoints).toBe(500);
    expect(second.tasksFlown).toBe(1);
    expect(second.tasksWithGoal).toBe(0);
  });

  it('excludes results from soft-deleted tasks', async () => {
    const taskDeleted = createTestTask(db, season.id, league.id, { name: 'Deleted' });
    const sub = createTestSubmission(db, taskDeleted.id, pilot.id, league.id);
    const att = createTestAttempt(db, sub, taskDeleted.id, pilot.id, league.id);
    createTestTaskResult(db, taskDeleted.id, pilot.id, league.id, att, { totalPoints: 999 });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?`).run(taskDeleted.id);

    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).standings).toEqual([]);
  });

  it('returns 404 for an unknown season', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/leagues/${league.slug}/seasons/nonexistent-id/standings`,
      headers: { 'x-test-user-id': pilot.id },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for non-members (standings are public)', async () => {
    const outsider = createTestUser(db, { email: 'outsider@example.com' });
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': outsider.id } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).standings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/leaderboard
// ─────────────────────────────────────────────────────────────────────────────

describe('GET leaderboard', () => {
  const url = () => `/leagues/${league.slug}/seasons/${season.id}/tasks/${task.id}/leaderboard`;

  it('returns 200 with task and empty entries when no results', async () => {
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.task).toBeDefined();
    expect(body.entries).toEqual([]);
  });

  it('returns entries sorted by rank with all required fields', async () => {
    // Seed a submission + attempts so we have valid best_attempt_id FKs
    const sub1 = createTestSubmission(db, task.id, pilot.id, league.id);
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    const att1 = createTestAttempt(db, sub1, task.id, pilot.id, league.id, {
      reachedGoal: true,
      taskTimeS: 4200,
      distanceFlownKm: 42.3,
      distancePoints: 714,
      timePoints: 133,
      totalPoints: 847,
    });
    const att2 = createTestAttempt(db, sub2, task.id, pilot2.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 18.6,
      distancePoints: 268,
      timePoints: 0,
      totalPoints: 268,
    });

    createTestTaskResult(db, task.id, pilot.id, league.id, att1, {
      rank: 1,
      reachedGoal: true,
      taskTimeS: 4200,
      distanceFlownKm: 42.3,
      distancePoints: 714,
      timePoints: 133,
      totalPoints: 847,
    });
    createTestTaskResult(db, task.id, pilot2.id, league.id, att2, {
      rank: 2,
      reachedGoal: false,
      distanceFlownKm: 18.6,
      distancePoints: 268,
      timePoints: 0,
      totalPoints: 268,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });

    expect(res.statusCode).toBe(200);
    const { entries } = JSON.parse(res.body);
    expect(entries).toHaveLength(2);

    const [first, second] = entries;
    expect(first.rank).toBe(1);
    expect(first.pilotId).toBe(pilot.id);
    expect(first.pilotName).toBe('Alice Smith');
    expect(first.reachedGoal).toBe(true);
    expect(first.distanceFlownKm).toBeCloseTo(42.3);
    expect(first.taskTimeS).toBe(4200);
    expect(first.distancePoints).toBeCloseTo(714);
    expect(first.timePoints).toBeCloseTo(133);
    expect(first.totalPoints).toBeCloseTo(847);
    expect(first.hasFlaggedCrossings).toBe(false);

    expect(second.rank).toBe(2);
    expect(second.reachedGoal).toBe(false);
    expect(second.taskTimeS).toBeNull();
  });

  it('returns 404 for an unknown task', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/leagues/${league.slug}/seasons/${season.id}/tasks/nonexistent-id/leaderboard`,
      headers: { 'x-test-user-id': pilot.id },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rebuildTaskResults unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('rebuildTaskResults', () => {
  it('populates task_results from flight_attempts', () => {
    const sub = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub, task.id, pilot.id, league.id, { totalPoints: 500 });

    rebuildTaskResults(db, task.id);

    const rows = db.prepare('SELECT * FROM task_results WHERE task_id = ?').all(task.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(pilot.id);
    expect(rows[0].total_points).toBe(1000);
    expect(rows[0].rank).toBe(1);
  });

  it('picks goal attempt over non-goal when pilot has multiple attempts', () => {
    const sub = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub, task.id, pilot.id, league.id, { reachedGoal: false, totalPoints: 200, attemptIndex: 0 });
    createTestAttempt(db, sub, task.id, pilot.id, league.id, {
      reachedGoal: true,
      totalPoints: 847,
      attemptIndex: 1,
      taskTimeS: 3600,
    });

    rebuildTaskResults(db, task.id);

    const rows = db.prepare('SELECT * FROM task_results WHERE task_id = ?').all(task.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].reached_goal).toBe(1);
    expect(rows[0].total_points).toBe(1000);
  });

  it('ranks pilots correctly: goal pilot ranks above non-goal', () => {
    const sub1 = createTestSubmission(db, task.id, pilot.id, league.id);
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    createTestAttempt(db, sub1, task.id, pilot.id, league.id, { reachedGoal: false, totalPoints: 400 });
    createTestAttempt(db, sub2, task.id, pilot2.id, league.id, {
      reachedGoal: true,
      totalPoints: 800,
      taskTimeS: 3600,
    });

    rebuildTaskResults(db, task.id);

    const rows = db.prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY rank ASC').all(task.id) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).toBe(pilot2.id); // goal pilot wins
    expect(rows[0].rank).toBe(1);
    expect(rows[1].user_id).toBe(pilot.id);
    expect(rows[1].rank).toBe(2);
  });

  it('is idempotent: running twice does not duplicate rows', () => {
    const sub = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub, task.id, pilot.id, league.id, { totalPoints: 500 });

    rebuildTaskResults(db, task.id);
    rebuildTaskResults(db, task.id);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM task_results WHERE task_id = ?').get(task.id) as any).c;
    expect(count).toBe(1);
  });

  it('excludes soft-deleted attempts', () => {
    const sub = createTestSubmission(db, task.id, pilot.id, league.id);
    const attId = createTestAttempt(db, sub, task.id, pilot.id, league.id, { totalPoints: 500 });
    db.prepare(`UPDATE flight_attempts SET deleted_at = datetime('now') WHERE id = ?`).run(attId);

    rebuildTaskResults(db, task.id);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM task_results WHERE task_id = ?').get(task.id) as any).c;
    expect(count).toBe(0);
  });

  // Regression for the stale-distance-points bug: rebuildTaskResults must
  // re-score from the *current* best distance, not copy whatever was stored
  // on flight_attempts at submission time.
  it('rescales distance_points against the current best distance across all attempts', () => {
    const taskNoNorm = createTestTask(db, season.id, league.id, { name: 'No-norm' });
    db.prepare(`UPDATE tasks SET normalized_score = NULL WHERE id = ?`).run(taskNoNorm.id);

    const sub1 = createTestSubmission(db, taskNoNorm.id, pilot.id, league.id);
    const sub2 = createTestSubmission(db, taskNoNorm.id, pilot2.id, league.id);
    // Pilot A first: 60km, distance_points stored as if they were the best.
    createTestAttempt(db, sub1, taskNoNorm.id, pilot.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 60,
      distancePoints: 1000, // stale snapshot — should be ignored
      totalPoints: 1000,
    });
    // Pilot B then beats the best at 80km, also non-goal.
    createTestAttempt(db, sub2, taskNoNorm.id, pilot2.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 80,
      distancePoints: 1000,
      totalPoints: 1000,
    });

    rebuildTaskResults(db, taskNoNorm.id);

    const rows = db
      .prepare('SELECT user_id, distance_points, total_points, rank FROM task_results WHERE task_id = ? ORDER BY rank')
      .all(taskNoNorm.id) as any[];
    expect(rows).toHaveLength(2);
    // Pilot B (80km) is the new winner with full distance points.
    expect(rows[0].user_id).toBe(pilot2.id);
    expect(rows[0].distance_points).toBeCloseTo(1000, 0);
    expect(rows[0].total_points).toBeCloseTo(1000, 0);
    expect(rows[0].rank).toBe(1);
    // Pilot A (60km) is rescaled against best=80km: 1000 * sqrt(60/80) ≈ 866.
    expect(rows[1].user_id).toBe(pilot.id);
    expect(rows[1].distance_points).toBeCloseTo(866, 0);
    expect(rows[1].total_points).toBeCloseTo(866, 0);
    expect(rows[1].rank).toBe(2);
  });

  // Regression for double rounding: components must be rounded to one decimal
  // exactly once, AFTER the normalisation scale is applied. Rounding before
  // scaling too (the old behavior) compounds two rounding errors — here raw
  // dp = 866.0896... at scale 0.5 lands on 433.0 single-rounded but 433.1
  // double-rounded (866.1 * 0.5 = 433.05 rounds up).
  it('rounds components once, after normalisation scaling', () => {
    const taskHalf = createTestTask(db, season.id, league.id, { name: 'Half-scale' });
    db.prepare(`UPDATE tasks SET normalized_score = 500 WHERE id = ?`).run(taskHalf.id);

    // Winner: non-goal at bestDist → raw dp = 1000 exactly, so scale = 0.5 exactly.
    const sub1 = createTestSubmission(db, taskHalf.id, pilot.id, league.id);
    createTestAttempt(db, sub1, taskHalf.id, pilot.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 80,
    });
    // Runner-up: raw dp = 1000 * sqrt(60.0089 / 80) = 866.089631...
    const sub2 = createTestSubmission(db, taskHalf.id, pilot2.id, league.id);
    createTestAttempt(db, sub2, taskHalf.id, pilot2.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 60.0089,
    });

    rebuildTaskResults(db, taskHalf.id);

    const rows = db
      .prepare('SELECT user_id, distance_points, total_points FROM task_results WHERE task_id = ? ORDER BY rank')
      .all(taskHalf.id) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).toBe(pilot.id);
    expect(rows[0].distance_points).toBe(500); // winner lands exactly on normalized_score
    expect(rows[0].total_points).toBe(500);
    expect(rows[1].user_id).toBe(pilot2.id);
    expect(rows[1].distance_points).toBe(433); // 433.1 would mean a pre-scale rounding crept back in
    expect(rows[1].total_points).toBe(433);
  });

  // Regression for time-point staleness: when a new goal time enters the set,
  // every goal pilot's time_points must reflect the full updated range.
  it('rescores time_points across all goal pilots when the goal-times set changes', () => {
    // All four pilots reach goal → §11 goal ratio 1 → DistanceWeight 0.361,
    // TimeWeight 0.639. The fastest pilot's raw total is exactly
    // 361 + 639 = 1000, so normalized_score=2000 makes the scale exactly 2
    // and every persisted value is the weighted raw doubled.
    const taskTime = createTestTask(db, season.id, league.id, { name: 'Time-points' });
    db.prepare(`UPDATE tasks SET normalized_score = 2000 WHERE id = ?`).run(taskTime.id);

    const pilot3 = createTestUser(db, { email: 'c@test.com', displayName: 'Carol' });
    const pilot4 = createTestUser(db, { email: 'd@test.com', displayName: 'Dave' });
    addLeagueMember(db, league.id, pilot3.id, 'pilot');
    addLeagueMember(db, league.id, pilot4.id, 'pilot');

    // Four goal pilots all at 50km (distance_points tied at 1000).
    // Times: [3600, 4200, 5400, 3000]. Stored time_points are stale (mimic
    // what would have been written before pilot4's faster entry).
    for (const [p, t] of [
      [pilot, 3600],
      [pilot2, 4200],
      [pilot3, 5400],
      [pilot4, 3000],
    ] as const) {
      const sub = createTestSubmission(db, taskTime.id, p.id, league.id);
      createTestAttempt(db, sub, taskTime.id, p.id, league.id, {
        reachedGoal: true,
        distanceFlownKm: 50,
        taskTimeS: t,
        distancePoints: 1000,
        timePoints: 999,
        totalPoints: 1999,
      });
    }

    rebuildTaskResults(db, taskTime.id);

    const rows = db
      .prepare(
        'SELECT user_id, distance_points, time_points, total_points, rank FROM task_results WHERE task_id = ? ORDER BY rank',
      )
      .all(taskTime.id) as any[];
    expect(rows).toHaveLength(4);

    // FAI S7F §12.2: bestTime=3000s (0.8333h), cutoff at best + sqrt(best) ≈ 6286s.
    // time_points = 639 * max(0, 1 - ((t - best) / sqrt(best))^(5/6)) * 2 (scale),
    // times in hours — i.e. SpeedFraction * 1278.
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(pilot4.id).time_points).toBeCloseTo(1278, 0); // fastest
    expect(byUser.get(pilot.id).time_points).toBeCloseTo(968.2, 1); // 3600 (SF 0.7576)
    expect(byUser.get(pilot2.id).time_points).toBeCloseTo(726.0, 1); // 4200 (SF 0.5681)
    expect(byUser.get(pilot3.id).time_points).toBeCloseTo(294.5, 1); // slowest, still inside cutoff (SF 0.2304)
    // distance_points are tied at 722 = 0.361 * 1000 * 2 (all four flew 50km of best=50km).
    for (const r of rows) expect(r.distance_points).toBeCloseTo(722, 0);
  });

  // Regression: goalTimes is built per-pilot (fastest), not per-attempt.
  // Under the §12.2 formula only the fastest time (t_best) matters, so a
  // pilot's slower duplicate attempts can no longer distort anyone's score —
  // but the per-pilot dedup guard stays, and a pilot with multiple goal
  // attempts must still be scored on their fastest one.
  it('dedups goal times by pilot when computing time_points', () => {
    const taskTime = createTestTask(db, season.id, league.id, { name: 'Dedup' });
    db.prepare(`UPDATE tasks SET normalized_score = 2000 WHERE id = ?`).run(taskTime.id);

    // Pilot A: two goal attempts in one submission — fastest=3600s, slower=4200s.
    // (Could also be two different submissions; goalTimes is built from
    // flight_attempts, not submissions.) Pilot A must be scored on their
    // fastest attempt (3600), and t_best for the field is pilot B's 3000.
    const subA = createTestSubmission(db, taskTime.id, pilot.id, league.id);
    createTestAttempt(db, subA, taskTime.id, pilot.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 3600,
      attemptIndex: 0,
    });
    createTestAttempt(db, subA, taskTime.id, pilot.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 4200,
      attemptIndex: 1,
    });
    const subB = createTestSubmission(db, taskTime.id, pilot2.id, league.id);
    createTestAttempt(db, subB, taskTime.id, pilot2.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 3000,
    });

    rebuildTaskResults(db, taskTime.id);

    const rows = db
      .prepare('SELECT user_id, time_points FROM task_results WHERE task_id = ?')
      .all(taskTime.id) as any[];
    expect(rows).toHaveLength(2);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    // Both pilots in goal → GR=1 → TimeWeight 0.639; winner raw total is
    // 361 + 639 = 1000, normalized_score 2000 → scale 2 (time pool 1278).
    // §12.2 with t_best=3000s: pilot B at 3000 → 1278.
    // Pilot A's *best* is 3600 (slower 4200 is ignored) → SF 0.7576 → 968.2.
    expect(byUser.get(pilot2.id).time_points).toBeCloseTo(1278, 0);
    expect(byUser.get(pilot.id).time_points).toBeCloseTo(968.2, 1);
  });

  // §13.1: the PG time-points parameter is 0% — a speed-section time earns
  // nothing without reaching goal, including rank order. task_time_s is
  // stored for any ESS crossing (even when the pilot lands short), so an
  // ESS-but-no-goal time must not split equal-total pilots.
  it('does not split equal-total non-goal pilots by an ESS-only task_time_s', () => {
    const sub1 = createTestSubmission(db, task.id, pilot.id, league.id);
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    // Both land short at 40 km; pilot A crossed ESS (task_time_s set).
    createTestAttempt(db, sub1, task.id, pilot.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 40,
      taskTimeS: 4000,
    });
    createTestAttempt(db, sub2, task.id, pilot2.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 40,
    });

    rebuildTaskResults(db, task.id);

    const rows = db
      .prepare('SELECT user_id, total_points, rank FROM task_results WHERE task_id = ?')
      .all(task.id) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].total_points).toBe(rows[1].total_points);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(1); // shared rank — the ESS time confers nothing
  });

  it('orders a goal pilot above an equal-total non-goal pilot but shares the rank value', () => {
    // Under the §12.2 absolute cutoff a goal pilot slower than
    // t_best + sqrt(t_best) scores 0 time points, so a non-goal pilot at
    // bestDist can tie them on total_points. S7F ranks on the rounded
    // TotalScore alone, so the two SHARE a rank; the goal pilot is merely
    // listed first (deterministic render order), and the fast ESS-only time
    // earns the non-goal pilot nothing.
    const fast = createTestUser(db, { email: 'fast@test.com', displayName: 'Fast Finisher' });
    addLeagueMember(db, league.id, fast.id, 'pilot');

    // t_best = 3000 s (0.8333 h) → zero cutoff ≈ 3000 + 3286 = 6286 s.
    const subFast = createTestSubmission(db, task.id, fast.id, league.id);
    createTestAttempt(db, subFast, task.id, fast.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 3000,
    });
    // Goal pilot past the cutoff: full distance points + 0 time points.
    const subSlow = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, subSlow, task.id, pilot.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 7000,
    });
    // Non-goal pilot at bestDist with a fast ESS crossing.
    const subEss = createTestSubmission(db, task.id, pilot2.id, league.id);
    createTestAttempt(db, subEss, task.id, pilot2.id, league.id, {
      reachedGoal: false,
      distanceFlownKm: 50,
      taskTimeS: 3100,
    });

    rebuildTaskResults(db, task.id);

    // Mirror the leaderboard route's deterministic order within a shared
    // rank: goal-gated task time, then goal flag, then pilot id.
    const rows = db
      .prepare(
        `SELECT user_id, reached_goal, total_points, rank FROM task_results WHERE task_id = ?
         ORDER BY rank,
                  COALESCE(CASE WHEN reached_goal = 1 THEN task_time_s END, 1e15),
                  reached_goal DESC, user_id`,
      )
      .all(task.id) as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0].user_id).toBe(fast.id);
    expect(rows[0].rank).toBe(1);
    // Slow goal pilot and non-goal pilot tie on points…
    expect(rows[1].total_points).toBe(rows[2].total_points);
    // …the goal pilot is listed first, but the rank VALUE is shared (1, 2, 2).
    expect(rows[1].user_id).toBe(pilot.id);
    expect(rows[1].reached_goal).toBe(1);
    expect(rows[1].rank).toBe(2);
    expect(rows[2].user_id).toBe(pilot2.id);
    expect(rows[2].rank).toBe(2);
  });

  it('resumes competition ranking after a shared rank (1, 1, 3)', () => {
    // Two non-goal pilots tie at bestDist; a third lands shorter. The tied
    // pair share rank 1 and the next distinct total gets rank 3
    // (1 + count of strictly better pilots), not rank 2.
    const pilot3 = createTestUser(db, { email: 'third@test.com', displayName: 'Third Pilot' });
    addLeagueMember(db, league.id, pilot3.id, 'pilot');

    for (const p of [pilot, pilot2]) {
      const sub = createTestSubmission(db, task.id, p.id, league.id);
      createTestAttempt(db, sub, task.id, p.id, league.id, { reachedGoal: false, distanceFlownKm: 50 });
    }
    const sub3 = createTestSubmission(db, task.id, pilot3.id, league.id);
    createTestAttempt(db, sub3, task.id, pilot3.id, league.id, { reachedGoal: false, distanceFlownKm: 20 });

    rebuildTaskResults(db, task.id);

    const rows = db
      .prepare('SELECT user_id, total_points, rank FROM task_results WHERE task_id = ? ORDER BY rank, user_id')
      .all(task.id) as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(1);
    expect(rows[0].total_points).toBe(rows[1].total_points);
    expect(rows[2].user_id).toBe(pilot3.id);
    expect(rows[2].rank).toBe(3);
  });

  // ── FAI S7F §11 goal-ratio weighting ───────────────────────────────────────

  it('GR = 0: distance pool is 900 raw, but normalization still lands the winner on 1000', () => {
    // Nobody in goal → DistanceWeight 0.9 (TimeWeight 0.1 is moot — no time
    // points without goal). Raw winner = 900; the per-task normalization
    // rescales to normalized_score (default 1000), so relative spacing is
    // all sqrt-of-distance: runner-up at a quarter distance = 500.
    const sub1 = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub1, task.id, pilot.id, league.id, { reachedGoal: false, distanceFlownKm: 80 });
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    createTestAttempt(db, sub2, task.id, pilot2.id, league.id, { reachedGoal: false, distanceFlownKm: 20 });

    rebuildTaskResults(db, task.id);

    const rows = db
      .prepare('SELECT user_id, distance_points, time_points, total_points FROM task_results WHERE task_id = ? ORDER BY rank')
      .all(task.id) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).toBe(pilot.id);
    expect(rows[0].total_points).toBe(1000);
    expect(rows[0].time_points).toBe(0);
    expect(rows[1].total_points).toBe(500); // 900·√(20/80) = 450 raw, × 1000/900
  });

  it('GR = 0.5 worked example: two of four in goal → DW 0.422375 / TW 0.577625 exactly', () => {
    // A (goal, 3000 s), B (goal, 3600 s), C (25 km), D (12.5 km); task
    // distance 50 km. GR = 2/4 = 0.5:
    //   DW = 0.9 − 1.665·0.5 + 1.713·0.25 − 0.587·0.125 = 0.422375
    //   TW = 1 − DW = 0.577625
    // A's raw total = 422.375 + 577.625 = 1000 → scale is exactly 1 at the
    // default normalized_score, so the persisted rows expose the weighted
    // raw values directly:
    //   A: 422.4 + 577.6 = 1000
    //   B: 422.4 + 577.625·SF(3600 vs 3000 = 0.7576) = 437.6 → 860.0
    //   C: 422.375·√(25/50)   = 298.7
    //   D: 422.375·√(12.5/50) = 211.2
    const pilotC = createTestUser(db, { email: 'cc@test.com', displayName: 'Pilot C' });
    const pilotD = createTestUser(db, { email: 'dd@test.com', displayName: 'Pilot D' });
    addLeagueMember(db, league.id, pilotC.id, 'pilot');
    addLeagueMember(db, league.id, pilotD.id, 'pilot');

    const seed = (p: { id: string }, opts: Parameters<typeof createTestAttempt>[5]) => {
      const sub = createTestSubmission(db, task.id, p.id, league.id);
      createTestAttempt(db, sub, task.id, p.id, league.id, opts);
    };
    seed(pilot, { reachedGoal: true, distanceFlownKm: 50, taskTimeS: 3000 });
    seed(pilot2, { reachedGoal: true, distanceFlownKm: 50, taskTimeS: 3600 });
    seed(pilotC, { reachedGoal: false, distanceFlownKm: 25 });
    seed(pilotD, { reachedGoal: false, distanceFlownKm: 12.5 });

    rebuildTaskResults(db, task.id);

    const rows = db
      .prepare('SELECT user_id, distance_points, time_points, total_points, rank FROM task_results WHERE task_id = ?')
      .all(task.id) as any[];
    const byUser = new Map(rows.map((r) => [r.user_id, r]));

    const a = byUser.get(pilot.id);
    expect(a.distance_points).toBe(422.4); // DW · 1000, rounded once
    expect(a.time_points).toBe(577.6); // TW · 1000, rounded once
    expect(a.total_points).toBe(1000);
    expect(a.rank).toBe(1);

    const b = byUser.get(pilot2.id);
    expect(b.distance_points).toBe(422.4);
    expect(b.time_points).toBe(437.6);
    expect(b.total_points).toBe(860);

    expect(byUser.get(pilotC.id).total_points).toBe(298.7);
    expect(byUser.get(pilotD.id).total_points).toBe(211.2);
  });

  it('GR-changing upload parity: server numbers the frontend preview must reproduce', () => {
    // Companion to the previewPipeline.test.ts case "a goal preview moves
    // the goal ratio": one stored non-goal pilot at 40 km, then a goal
    // upload at 50 km / 3600 s arrives. GR moves 0 → 1/2 → DW 0.422375.
    // The frontend preview of that second flight must show exactly the
    // numbers this rebuild persists.
    const sub1 = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub1, task.id, pilot.id, league.id, { reachedGoal: false, distanceFlownKm: 40 });
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    createTestAttempt(db, sub2, task.id, pilot2.id, league.id, {
      reachedGoal: true,
      distanceFlownKm: 50,
      taskTimeS: 3600,
    });

    rebuildTaskResults(db, task.id);

    const rows = db
      .prepare('SELECT user_id, distance_points, time_points, total_points FROM task_results WHERE task_id = ?')
      .all(task.id) as any[];
    const byUser = new Map(rows.map((r) => [r.user_id, r]));

    const goal = byUser.get(pilot2.id);
    expect(goal.distance_points).toBe(422.4);
    expect(goal.time_points).toBe(577.6);
    expect(goal.total_points).toBe(1000);

    const short = byUser.get(pilot.id);
    expect(short.distance_points).toBe(377.8); // 422.375·√(40/50)
    expect(short.time_points).toBe(0);
    expect(short.total_points).toBe(377.8);
  });
});
