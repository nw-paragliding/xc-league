import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { authPlugin, loadAuthConfig } from '../../src/auth';
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

/** Inline turnpoint fixture — no helper for this in tests/helpers.ts yet. */
function addTurnpoint(db: any, taskId: string) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO turnpoints (id, task_id, sequence_index, name, latitude, longitude, radius_m, type, created_at, updated_at)
    VALUES (?, ?, 0, 'TP', 47.5, -122.0, 400, 'SSS', datetime('now'), datetime('now'))
  `).run(id, taskId);
  return id;
}

describe('Season Management API', () => {
  let app: any;
  let db: any;
  let adminUser: any;
  let regularUser: any;
  let testLeague: any;
  let authConfig: any;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    // Create test users
    adminUser = createTestUser(db, { email: 'admin@test.com', displayName: 'Admin User' });
    regularUser = createTestUser(db, { email: 'user@test.com', displayName: 'Regular User' });

    // Create test league
    testLeague = createTestLeague(db, { name: 'Test League', slug: 'test-league' });

    // Make adminUser a league admin
    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    addLeagueMember(db, testLeague.id, regularUser.id, 'pilot');

    // Set up Fastify with auth
    app = Fastify();
    authConfig = loadAuthConfig();

    await app.register(authPlugin, { config: authConfig, db });
    await registerLeagueRoutes(app, { db });
  });

  describe('POST /leagues/:slug/seasons', () => {
    it('should create a season as league admin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/leagues/${testLeague.slug}/seasons`,
        payload: {
          name: 'Summer 2025',
          competitionType: 'XC',
          startDate: '2025-06-01',
          endDate: '2025-09-30',
        },
        headers: {
          // Mock auth - in real tests you'd generate a valid JWT
          'x-test-user-id': adminUser.id,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.season).toMatchObject({
        name: 'Summer 2025',
        competitionType: 'XC',
        startDate: '2025-06-01',
        endDate: '2025-09-30',
      });
    });

    it('should reject if end date is before start date', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/leagues/${testLeague.slug}/seasons`,
        payload: {
          name: 'Invalid Season',
          competitionType: 'XC',
          startDate: '2025-09-30',
          endDate: '2025-06-01',
        },
        headers: {
          'x-test-user-id': adminUser.id,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain('after start date');
    });

    it('should reject unauthorized users', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/leagues/${testLeague.slug}/seasons`,
        payload: {
          name: 'Summer 2025',
          competitionType: 'XC',
          startDate: '2025-06-01',
          endDate: '2025-09-30',
        },
        headers: {
          'x-test-user-id': regularUser.id, // regular pilot, not admin
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PUT /leagues/:slug/seasons/:seasonId', () => {
    it('should update a season', async () => {
      const season = createTestSeason(db, testLeague.id, { name: 'Original Name' });

      const response = await app.inject({
        method: 'PUT',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        payload: {
          name: 'Updated Name',
        },
        headers: {
          'x-test-user-id': adminUser.id,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.season.name).toBe('Updated Name');
    });

    it('should return 404 for non-existent season', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/leagues/${testLeague.slug}/seasons/non-existent-id`,
        payload: {
          name: 'Updated Name',
        },
        headers: {
          'x-test-user-id': adminUser.id,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /leagues/:slug/seasons/:seasonId', () => {
    it('should soft-delete a season', async () => {
      const season = createTestSeason(db, testLeague.id);

      const response = await app.inject({
        method: 'DELETE',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        headers: {
          'x-test-user-id': adminUser.id,
        },
      });

      expect(response.statusCode).toBe(200);

      // Verify season is soft-deleted
      const deleted = db.prepare('SELECT deleted_at FROM seasons WHERE id = ?').get(season.id);
      expect(deleted.deleted_at).not.toBeNull();
    });

    // #35: cascade soft-delete to child tasks (and their children — every
    // table the task-level cascade touches).
    it('cascades soft-delete to child tasks and the full per-task chain', async () => {
      const season = createTestSeason(db, testLeague.id);
      const taskA = createTestTask(db, season.id, testLeague.id);
      const taskB = createTestTask(db, season.id, testLeague.id);

      // taskA: full chain — turnpoint + submission → attempt → task_results.
      const turnpointA = addTurnpoint(db, taskA.id);
      const subA = createTestSubmission(db, taskA.id, regularUser.id, testLeague.id);
      const attemptA = createTestAttempt(db, subA, taskA.id, regularUser.id, testLeague.id, { distanceFlownKm: 12 });
      createTestTaskResult(db, taskA.id, regularUser.id, testLeague.id, attemptA);

      // taskB: full chain too, so we cover both.
      const subB = createTestSubmission(db, taskB.id, regularUser.id, testLeague.id);
      const attemptB = createTestAttempt(db, subB, taskB.id, regularUser.id, testLeague.id, { distanceFlownKm: 8 });
      createTestTaskResult(db, taskB.id, regularUser.id, testLeague.id, attemptB);

      const response = await app.inject({
        method: 'DELETE',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(response.statusCode).toBe(200);

      // Tasks soft-deleted.
      const taskARow = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskA.id);
      const taskBRow = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskB.id);
      expect(taskARow.deleted_at).not.toBeNull();
      expect(taskBRow.deleted_at).not.toBeNull();

      // Submissions soft-deleted.
      const subARow = db.prepare('SELECT deleted_at FROM flight_submissions WHERE id = ?').get(subA);
      const subBRow = db.prepare('SELECT deleted_at FROM flight_submissions WHERE id = ?').get(subB);
      expect(subARow.deleted_at).not.toBeNull();
      expect(subBRow.deleted_at).not.toBeNull();

      // Attempts soft-deleted.
      const attemptARow = db.prepare('SELECT deleted_at FROM flight_attempts WHERE id = ?').get(attemptA);
      const attemptBRow = db.prepare('SELECT deleted_at FROM flight_attempts WHERE id = ?').get(attemptB);
      expect(attemptARow.deleted_at).not.toBeNull();
      expect(attemptBRow.deleted_at).not.toBeNull();

      // task_results hard-deleted (no deleted_at column).
      const trCountA = db.prepare('SELECT COUNT(*) AS c FROM task_results WHERE task_id = ?').get(taskA.id) as any;
      const trCountB = db.prepare('SELECT COUNT(*) AS c FROM task_results WHERE task_id = ?').get(taskB.id) as any;
      expect(trCountA.c).toBe(0);
      expect(trCountB.c).toBe(0);

      // Turnpoints soft-deleted.
      const tpRow = db.prepare('SELECT deleted_at FROM turnpoints WHERE id = ?').get(turnpointA);
      expect(tpRow.deleted_at).not.toBeNull();
    });

    // Defensive: tasks.league_id is denormalised and not constrained to match
    // seasons.league_id. The cascade must scope by league_id so a corrupted
    // row in another league can't be reached.
    it('does not cascade across leagues even with a corrupted task.league_id', async () => {
      const otherLeague = createTestLeague(db, { name: 'Other League', slug: 'other-league' });
      addLeagueMember(db, otherLeague.id, adminUser.id, 'admin');
      const season = createTestSeason(db, testLeague.id);
      const otherSeason = createTestSeason(db, otherLeague.id);
      const otherTask = createTestTask(db, otherSeason.id, otherLeague.id);

      // Simulate corruption: a row whose season_id points at testLeague's
      // season but whose league_id stays on otherLeague.
      db.prepare(`UPDATE tasks SET season_id = ? WHERE id = ?`).run(season.id, otherTask.id);

      const response = await app.inject({
        method: 'DELETE',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(response.statusCode).toBe(200);

      const otherTaskRow = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(otherTask.id);
      expect(otherTaskRow.deleted_at).toBeNull();
    });

    // Tasks already soft-deleted before the season delete should not be
    // re-stamped — leaves the original deletion timestamp intact.
    it('does not re-stamp tasks that were already soft-deleted', async () => {
      const season = createTestSeason(db, testLeague.id);
      const task = createTestTask(db, season.id, testLeague.id);

      // Pre-soft-delete the task with a fixed timestamp.
      const originalTs = '2024-01-01 00:00:00';
      db.prepare(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(originalTs, originalTs, task.id);

      const response = await app.inject({
        method: 'DELETE',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(response.statusCode).toBe(200);

      const row = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(task.id);
      expect(row.deleted_at).toBe(originalTs);
    });
  });
});
