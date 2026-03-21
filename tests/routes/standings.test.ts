// =============================================================================
// Standings + Leaderboard API — Integration Tests
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { getTestDb, resetTestDb } from '../setup';
import {
  setupTestDatabase,
  createTestUser,
  createTestLeague,
  addLeagueMember,
  createTestSeason,
  createTestTask,
  createTestSubmission,
  createTestAttempt,
  createTestTaskResult,
  createTestSeasonStanding,
} from '../helpers';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import { authPlugin, loadAuthConfig } from '../../src/auth';
import { rebuildTaskResults } from '../../src/job-queue';

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
  db  = getTestDb();
  setupTestDatabase(db);

  pilot  = createTestUser(db, { displayName: 'Alice Smith' });
  pilot2 = createTestUser(db, { displayName: 'Bob Jones' });
  league = createTestLeague(db, { slug: 'test-league' });
  season = createTestSeason(db, league.id);
  task   = createTestTask(db, season.id, league.id, { name: 'Task 1' });

  addLeagueMember(db, league.id, pilot.id,  'pilot');
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
    createTestSeasonStanding(db, season.id, pilot.id,  league.id, { rank: 1, totalPoints: 800, tasksFlown: 2, tasksWithGoal: 1 });
    createTestSeasonStanding(db, season.id, pilot2.id, league.id, { rank: 2, totalPoints: 500, tasksFlown: 1, tasksWithGoal: 0 });

    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': pilot.id } });

    expect(res.statusCode).toBe(200);
    const { standings } = JSON.parse(res.body);
    expect(standings).toHaveLength(2);

    const [first, second] = standings;
    expect(first.rank).toBe(1);
    expect(first.pilotId).toBe(pilot.id);
    expect(first.pilotName).toBe('Alice Smith');
    expect(first.totalPoints).toBe(800);
    expect(first.tasksFlown).toBe(2);
    expect(first.tasksWithGoal).toBe(1);

    expect(second.rank).toBe(2);
    expect(second.pilotId).toBe(pilot2.id);
    expect(second.totalPoints).toBe(500);
  });

  it('returns 404 for an unknown season', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     `/leagues/${league.slug}/seasons/nonexistent-id/standings`,
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
    const sub1 = createTestSubmission(db, task.id, pilot.id,  league.id);
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    const att1 = createTestAttempt(db, sub1, task.id, pilot.id,  league.id, { reachedGoal: true,  taskTimeS: 4200, distanceFlownKm: 42.3, distancePoints: 714, timePoints: 133, totalPoints: 847 });
    const att2 = createTestAttempt(db, sub2, task.id, pilot2.id, league.id, { reachedGoal: false, distanceFlownKm: 18.6, distancePoints: 268, timePoints: 0,   totalPoints: 268 });

    createTestTaskResult(db, task.id, pilot.id,  league.id, att1, { rank: 1, reachedGoal: true,  taskTimeS: 4200, distanceFlownKm: 42.3, distancePoints: 714, timePoints: 133, totalPoints: 847 });
    createTestTaskResult(db, task.id, pilot2.id, league.id, att2, { rank: 2, reachedGoal: false, distanceFlownKm: 18.6, distancePoints: 268, timePoints: 0,   totalPoints: 268 });

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
      method:  'GET',
      url:     `/leagues/${league.slug}/seasons/${season.id}/tasks/nonexistent-id/leaderboard`,
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
    expect(rows[0].total_points).toBe(500);
    expect(rows[0].rank).toBe(1);
  });

  it('picks goal attempt over non-goal when pilot has multiple attempts', () => {
    const sub = createTestSubmission(db, task.id, pilot.id, league.id);
    createTestAttempt(db, sub, task.id, pilot.id, league.id, { reachedGoal: false, totalPoints: 200, attemptIndex: 0 });
    createTestAttempt(db, sub, task.id, pilot.id, league.id, { reachedGoal: true,  totalPoints: 847, attemptIndex: 1, taskTimeS: 3600 });

    rebuildTaskResults(db, task.id);

    const rows = db.prepare('SELECT * FROM task_results WHERE task_id = ?').all(task.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].reached_goal).toBe(1);
    expect(rows[0].total_points).toBe(847);
  });

  it('ranks pilots correctly: goal pilot ranks above non-goal', () => {
    const sub1 = createTestSubmission(db, task.id, pilot.id,  league.id);
    const sub2 = createTestSubmission(db, task.id, pilot2.id, league.id);
    createTestAttempt(db, sub1, task.id, pilot.id,  league.id, { reachedGoal: false, totalPoints: 400 });
    createTestAttempt(db, sub2, task.id, pilot2.id, league.id, { reachedGoal: true,  totalPoints: 800, taskTimeS: 3600 });

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
});
