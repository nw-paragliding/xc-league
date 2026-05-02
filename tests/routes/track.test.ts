// =============================================================================
// GET /tasks/:taskId/submissions/:submissionId/track — public access
//
// Locks down the auth contract that #49 establishes: the track replay
// endpoint must serve unauthenticated requests, and must still 404 when the
// submissionId in the URL doesn't belong to the URL's task/season.
// =============================================================================

import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { authPlugin, loadAuthConfig } from '../../src/auth';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import {
  createTestLeague,
  createTestSeason,
  createTestSubmission,
  createTestTask,
  createTestUser,
  setupTestDatabase,
} from '../helpers';
import { getTestDb, resetTestDb } from '../setup';

async function buildTestApp(db: ReturnType<typeof getTestDb>) {
  const app = Fastify();
  // Cookie plugin first — auth's preHandler reads request.cookies for the
  // non-test-bypass JWT path. Without it an anonymous request crashes with
  // "Cannot read properties of undefined (reading 'xcleague_jwt')".
  await app.register(import('@fastify/cookie'));
  await app.register(authPlugin, { config: loadAuthConfig(), db });
  await registerLeagueRoutes(app, { db });
  await app.ready();
  return app;
}

describe('GET .../track — public access', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let db: ReturnType<typeof getTestDb>;
  let user: ReturnType<typeof createTestUser>;
  let league: ReturnType<typeof createTestLeague>;
  let season: ReturnType<typeof createTestSeason>;
  let task: ReturnType<typeof createTestTask>;
  let submissionId: string;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);
    user = createTestUser(db, { email: 'pilot@test.com', displayName: 'Pilot' });
    league = createTestLeague(db, { slug: 'test-league' });
    season = createTestSeason(db, league.id);
    task = createTestTask(db, season.id, league.id);
    submissionId = createTestSubmission(db, task.id, user.id, league.id);
    app = await buildTestApp(db);
  });

  const trackUrl = (overrides: { taskId?: string; seasonId?: string; submissionId?: string } = {}) =>
    `/leagues/${league.slug}/seasons/${overrides.seasonId ?? season.id}/tasks/${overrides.taskId ?? task.id}/submissions/${overrides.submissionId ?? submissionId}/track`;

  it('does not require auth — anonymous request reaches the handler (no 401)', async () => {
    // No `x-test-user-id` header → request.user is null.
    const res = await app.inject({ method: 'GET', url: trackUrl() });
    // Empty igc_data fails parsing, so this returns 422 INVALID_IGC.
    // The point is just that we got *past* the auth gate (was 401 before #49).
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_IGC');
  });

  it('404s when submissionId does not belong to the URL task', async () => {
    // Sibling task in the same season; ask for our submission via that task's URL.
    const otherTask = createTestTask(db, season.id, league.id, { id: randomUUID(), name: 'Other Task' });
    const res = await app.inject({ method: 'GET', url: trackUrl({ taskId: otherTask.id }) });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('SUBMISSION_NOT_FOUND');
  });

  it('404s when submissionId does not belong to the URL season', async () => {
    const otherSeason = createTestSeason(db, league.id);
    const res = await app.inject({ method: 'GET', url: trackUrl({ seasonId: otherSeason.id }) });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('SUBMISSION_NOT_FOUND');
  });
});
