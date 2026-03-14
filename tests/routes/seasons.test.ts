import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { getTestDb, resetTestDb } from '../setup';
import { setupTestDatabase, createTestUser, createTestLeague, addLeagueMember, createTestSeason } from '../helpers';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import { authPlugin, loadAuthConfig } from '../../src/auth';

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
    await registerLeagueRoutes(app, { db, queue: null as any });
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
      const deleted = db.prepare(
        'SELECT deleted_at FROM seasons WHERE id = ?'
      ).get(season.id);
      expect(deleted.deleted_at).not.toBeNull();
    });
  });
});
