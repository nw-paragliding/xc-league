import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { authPlugin, loadAuthConfig } from '../../src/auth';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import {
  addLeagueMember,
  createTestLeague,
  createTestSeason,
  createTestSubmission,
  createTestTask,
  createTestUser,
  setupTestDatabase,
} from '../helpers';
import { getTestDb, resetTestDb } from '../setup';

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

    // #35: cascade soft-delete to child tasks (and their children).
    it('cascades soft-delete to child tasks and their submissions', async () => {
      const season = createTestSeason(db, testLeague.id);
      const taskA = createTestTask(db, season.id, testLeague.id);
      const taskB = createTestTask(db, season.id, testLeague.id);
      const subA = createTestSubmission(db, taskA.id, regularUser.id, testLeague.id);
      const subB = createTestSubmission(db, taskB.id, regularUser.id, testLeague.id);

      const response = await app.inject({
        method: 'DELETE',
        url: `/leagues/${testLeague.slug}/seasons/${season.id}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(response.statusCode).toBe(200);

      const taskARow = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskA.id);
      const taskBRow = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskB.id);
      expect(taskARow.deleted_at).not.toBeNull();
      expect(taskBRow.deleted_at).not.toBeNull();

      const subARow = db.prepare('SELECT deleted_at FROM flight_submissions WHERE id = ?').get(subA);
      const subBRow = db.prepare('SELECT deleted_at FROM flight_submissions WHERE id = ?').get(subB);
      expect(subARow.deleted_at).not.toBeNull();
      expect(subBRow.deleted_at).not.toBeNull();
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
