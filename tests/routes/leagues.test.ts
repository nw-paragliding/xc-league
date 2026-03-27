import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { getTestDb, resetTestDb } from '../setup';
import { setupTestDatabase, createTestUser, createTestLeague, addLeagueMember } from '../helpers';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import { authPlugin, loadAuthConfig } from '../../src/auth';

describe('League Settings API', () => {
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

    adminUser  = createTestUser(db, { email: 'admin@test.com',  displayName: 'Admin User' });
    regularUser = createTestUser(db, { email: 'user@test.com',  displayName: 'Regular User' });

    testLeague = createTestLeague(db, {
      name:        'Test League',
      slug:        'test-league',
      description: 'A test league description',
    });

    addLeagueMember(db, testLeague.id, adminUser.id,   'admin');
    addLeagueMember(db, testLeague.id, regularUser.id, 'pilot');

    app = Fastify();
    authConfig = loadAuthConfig();
    await app.register(authPlugin, { config: authConfig, db });
    await registerLeagueRoutes(app, { db, queue: null as any });
  });

  // ── GET /leagues/:leagueSlug ─────────────────────────────────────────────

  describe('GET /leagues/:leagueSlug', () => {
    it('returns full league data including description and logoUrl', async () => {
      const res = await app.inject({
        method:  'GET',
        url:     `/leagues/${testLeague.slug}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.league).toMatchObject({
        id:               testLeague.id,
        slug:             testLeague.slug,
        name:             testLeague.name,
        shortDescription: 'A test league description',
      });
      // logoUrl and createdAt should be present (even if null)
      expect('logoUrl'   in body.league).toBe(true);
      expect('createdAt' in body.league).toBe(true);
    });

    it('returns null for optional fields when not set', async () => {
      const noDescLeague = createTestLeague(db, { name: 'No Desc', slug: 'no-desc' });

      const res = await app.inject({
        method:  'GET',
        url:     `/leagues/${noDescLeague.slug}`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.league.shortDescription).toBeNull();
      expect(body.league.logoUrl).toBeNull();
    });

  });

  // ── PUT /leagues/:leagueSlug ─────────────────────────────────────────────

  describe('PUT /leagues/:leagueSlug', () => {
    it('updates league name as admin', async () => {
      const res = await app.inject({
        method:  'PUT',
        url:     `/leagues/${testLeague.slug}`,
        payload: { name: 'Updated League Name' },
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.league.name).toBe('Updated League Name');
    });

    it('updates description without touching other fields', async () => {
      const res = await app.inject({
        method:  'PUT',
        url:     `/leagues/${testLeague.slug}`,
        payload: { shortDescription: 'New description' },
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.league.shortDescription).toBe('New description');
      expect(body.league.name).toBe(testLeague.name); // unchanged
    });

    it('returns 400 when no fields provided', async () => {
      const res = await app.inject({
        method:  'PUT',
        url:     `/leagues/${testLeague.slug}`,
        payload: {},
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('No fields to update');
    });

    it('rejects regular members from updating league settings', async () => {
      const res = await app.inject({
        method:  'PUT',
        url:     `/leagues/${testLeague.slug}`,
        payload: { name: 'Hacked Name' },
        headers: { 'x-test-user-id': regularUser.id },
      });

      expect(res.statusCode).toBe(403);
    });

  });

  // ── GET /leagues/:leagueSlug/members ─────────────────────────────────────

  describe('GET /leagues/:leagueSlug/members', () => {
    it('returns members for league members', async () => {
      const res = await app.inject({
        method:  'GET',
        url:     `/leagues/${testLeague.slug}/members`,
        headers: { 'x-test-user-id': adminUser.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.members).toHaveLength(2);

      const admin = body.members.find((m: any) => m.role === 'admin');
      expect(admin).toBeDefined();
      expect(admin.userId).toBe(adminUser.id);
      expect(admin.displayName).toBe('Admin User');
    });

    it('returns 403 for non-members', async () => {
      const outsider = createTestUser(db, { email: 'outsider@test.com' });

      const res = await app.inject({
        method:  'GET',
        url:     `/leagues/${testLeague.slug}/members`,
        headers: { 'x-test-user-id': outsider.id },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain('membership');
    });

  });
});
