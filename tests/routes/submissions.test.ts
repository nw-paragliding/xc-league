// =============================================================================
// Submissions API — GET /tasks/:taskId/submissions
//
// Covers the per-submission breakdown extension (#41): each row carries
// `thisSubmission` (facts about the submission's own best attempt) and
// `isCurrentBest` (whether this submission's best attempt is the one the
// leaderboard is currently using). The pre-existing `bestAttempt` payload
// (the pilot's overall best, matching the leaderboard) is unchanged.
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
  createTestUser,
  setupTestDatabase,
} from '../helpers';
import { getTestDb, resetTestDb } from '../setup';

async function buildTestApp(db: ReturnType<typeof getTestDb>) {
  const app = Fastify();
  await app.register(authPlugin, { config: loadAuthConfig(), db });
  await registerLeagueRoutes(app, { db });
  await app.ready();
  return app;
}

/** Wire submission → attempt by setting flight_submissions.best_attempt_id. */
function linkSubmissionBestAttempt(db: ReturnType<typeof getTestDb>, submissionId: string, attemptId: string) {
  db.prepare(`UPDATE flight_submissions SET best_attempt_id = ? WHERE id = ?`).run(attemptId, submissionId);
}

describe('GET /tasks/:taskId/submissions — per-submission breakdown (#41)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let pilot: ReturnType<typeof createTestUser>;
  let testLeague: ReturnType<typeof createTestLeague>;
  let testSeason: ReturnType<typeof createTestSeason>;
  let testTask: ReturnType<typeof createTestTask>;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    pilot = createTestUser(db, { email: 'pilot@test.com' });
    testLeague = createTestLeague(db, { slug: 'test-league' });
    testSeason = createTestSeason(db, testLeague.id);
    testTask = createTestTask(db, testSeason.id, testLeague.id);
    addLeagueMember(db, testLeague.id, pilot.id, 'pilot');

    app = await buildTestApp(db);
  });

  const listUrl = () => `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${testTask.id}/submissions`;

  it('populates thisSubmission for each row from fs.best_attempt_id', async () => {
    const subA = createTestSubmission(db, testTask.id, pilot.id, testLeague.id, { igcFilename: 'a.igc' });
    const attA = createTestAttempt(db, subA, testTask.id, pilot.id, testLeague.id, {
      distanceFlownKm: 2.795,
    });
    linkSubmissionBestAttempt(db, subA, attA);

    const subB = createTestSubmission(db, testTask.id, pilot.id, testLeague.id, { igcFilename: 'b.igc' });
    const attB = createTestAttempt(db, subB, testTask.id, pilot.id, testLeague.id, {
      distanceFlownKm: 1.178,
      attemptIndex: 0,
    });
    linkSubmissionBestAttempt(db, subB, attB);

    rebuildTaskResults(db, testTask.id);

    const res = await app.inject({
      method: 'GET',
      url: listUrl(),
      headers: { 'x-test-user-id': pilot.id },
    });

    expect(res.statusCode).toBe(200);
    const { submissions } = JSON.parse(res.body) as { submissions: any[] };
    expect(submissions).toHaveLength(2);

    // Each row's thisSubmission reflects its own attempt.
    const byFile = new Map(submissions.map((s) => [s.igcFilename, s]));
    expect(byFile.get('a.igc').thisSubmission.distanceFlownKm).toBeCloseTo(2.795);
    expect(byFile.get('b.igc').thisSubmission.distanceFlownKm).toBeCloseTo(1.178);

    // bestAttempt is the per-pilot overall best — same on both rows.
    expect(byFile.get('a.igc').bestAttempt.distanceFlownKm).toBeCloseTo(2.795);
    expect(byFile.get('b.igc').bestAttempt.distanceFlownKm).toBeCloseTo(2.795);
  });

  it('isCurrentBest is true only for the submission whose attempt the leaderboard uses', async () => {
    const subBest = createTestSubmission(db, testTask.id, pilot.id, testLeague.id, { igcFilename: 'best.igc' });
    const attBest = createTestAttempt(db, subBest, testTask.id, pilot.id, testLeague.id, {
      distanceFlownKm: 20,
    });
    linkSubmissionBestAttempt(db, subBest, attBest);

    const subWorse = createTestSubmission(db, testTask.id, pilot.id, testLeague.id, { igcFilename: 'worse.igc' });
    const attWorse = createTestAttempt(db, subWorse, testTask.id, pilot.id, testLeague.id, {
      distanceFlownKm: 5,
    });
    linkSubmissionBestAttempt(db, subWorse, attWorse);

    rebuildTaskResults(db, testTask.id);

    const res = await app.inject({
      method: 'GET',
      url: listUrl(),
      headers: { 'x-test-user-id': pilot.id },
    });

    expect(res.statusCode).toBe(200);
    const { submissions } = JSON.parse(res.body) as { submissions: any[] };
    const byFile = new Map(submissions.map((s) => [s.igcFilename, s]));
    expect(byFile.get('best.igc').isCurrentBest).toBe(true);
    expect(byFile.get('worse.igc').isCurrentBest).toBe(false);
  });

  it('thisSubmission is null when fs.best_attempt_id has not been set yet', async () => {
    // Brand-new submission, processing not yet wired up its best_attempt_id.
    createTestSubmission(db, testTask.id, pilot.id, testLeague.id);

    const res = await app.inject({
      method: 'GET',
      url: listUrl(),
      headers: { 'x-test-user-id': pilot.id },
    });

    expect(res.statusCode).toBe(200);
    const { submissions } = JSON.parse(res.body) as { submissions: any[] };
    expect(submissions).toHaveLength(1);
    expect(submissions[0].thisSubmission).toBeNull();
    expect(submissions[0].isCurrentBest).toBe(false);
  });

  it('preserves the pre-existing bestAttempt + timePointsProvisional fields', async () => {
    const sub = createTestSubmission(db, testTask.id, pilot.id, testLeague.id);
    const att = createTestAttempt(db, sub, testTask.id, pilot.id, testLeague.id, { distanceFlownKm: 8 });
    linkSubmissionBestAttempt(db, sub, att);
    rebuildTaskResults(db, testTask.id);

    const res = await app.inject({
      method: 'GET',
      url: listUrl(),
      headers: { 'x-test-user-id': pilot.id },
    });

    const { submissions } = JSON.parse(res.body) as { submissions: any[] };
    const row = submissions[0];
    expect(row.bestAttempt).toBeTruthy();
    expect(row.bestAttempt.distanceFlownKm).toBeCloseTo(8);
    expect(row.allAttempts).toHaveLength(1);
    expect(typeof row.timePointsProvisional).toBe('boolean');
  });
});
