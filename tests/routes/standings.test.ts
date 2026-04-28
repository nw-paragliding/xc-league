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
  await registerLeagueRoutes(app, { db, queue: null as any });
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

  // Regression for time-point staleness: when a new goal time enters the set,
  // every goal pilot's time_points must reflect the full updated range.
  it('rescores time_points across all goal pilots when the goal-times set changes', () => {
    // normalized_score=2000 matches the unscaled winner total
    // (distance_points=1000 + time_points=1000 for the fastest pilot),
    // so the post-rebuild values are the raw computeTimePoints outputs.
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

    // tMin=3000, tMax=5400; ratio = (t - 3000) / 2400.
    // time_points = 1000 * (1 - ratio^(2/3)).
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(pilot4.id).time_points).toBeCloseTo(1000, 0); // fastest
    expect(byUser.get(pilot.id).time_points).toBeCloseTo(603, 0); // 3600
    expect(byUser.get(pilot2.id).time_points).toBeCloseTo(370, 0); // 4200
    expect(byUser.get(pilot3.id).time_points).toBeCloseTo(0, 0); // slowest
    // distance_points are tied at 1000 (all four flew 50km of best=50km).
    for (const r of rows) expect(r.distance_points).toBeCloseTo(1000, 0);
  });
});
