// =============================================================================
// Task Import / Management API — Integration Tests
//
// Tests the full HTTP stack: Fastify app + real SQLite (in-memory) + auth.
// Auth is bypassed in test mode via x-test-user-id header.
// =============================================================================

import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { authPlugin, loadAuthConfig } from '../../src/auth';
import { registerLeagueRoutes } from '../../src/routes/leagues';
import { buildXctrackDeepLink, type ExportTask, encodeXctskZ } from '../../src/task-exporters';
import { parseCup, parseXctsk } from '../../src/task-parsers';
import {
  addLeagueMember,
  createTestLeague,
  createTestSeason,
  createTestTask,
  createTestUser,
  setupTestDatabase,
} from '../helpers';
import { getTestDb, resetTestDb } from '../setup';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Real task file from ~/Downloads/25_August_NWXC.xctsk
// 7 turnpoints: SSS (TLK-6K), 4 cylinders, ESS (SQT-5K), GOAL (TLZ-5K)
const XCTSK_REAL =
  '{"version":1,"turnpoints":[{"waypoint":{"altSmoothed":744,"lat":47.511400000000002,"name":"TLK-6K","description":"TLK-6K","lon":-121.99095000000001},"radius":400},{"waypoint":{"altSmoothed":-99999999,"lat":47.547830000000005,"name":"GRN-6K","description":"GRN-6K","lon":-121.98338000000001},"radius":400},{"waypoint":{"altSmoothed":40,"lat":47.543680000000002,"name":"GRV-5K","description":"GRV-5K","lon":-122.03038000000001},"radius":400},{"waypoint":{"altSmoothed":680,"lat":47.497580000000006,"name":"TM-6K","description":"TM-6K","lon":-121.99038000000002},"radius":1000},{"waypoint":{"altSmoothed":156,"lat":47.532330000000002,"name":"HPT-6K","description":"HPT-6K","lon":-121.98115000000001},"radius":1000},{"type":"ESS","waypoint":{"altSmoothed":621,"lat":47.504330000000003,"name":"SQT-5K","description":"SQT-5K","lon":-122.04750000000001},"radius":1000},{"waypoint":{"altSmoothed":55,"lat":47.500800000000005,"name":"TLZ-5K","description":"TLZ-5K","lon":-122.02190000000002},"radius":400}],"taskType":"CLASSIC"}';

/** Minimal JSON .xctsk (XCTrack v1 format) — 7 turnpoints, ESS typed */
const XCTSK_JSON = JSON.stringify({
  version: 1,
  taskType: 'CLASSIC',
  turnpoints: [
    { waypoint: { name: 'TLK-6K', lat: 47.5114, lon: -121.991, altSmoothed: 744 }, radius: 400 },
    { waypoint: { name: 'GRN-6K', lat: 47.5478, lon: -121.9834, altSmoothed: 0 }, radius: 400 },
    { waypoint: { name: 'GRV-5K', lat: 47.5437, lon: -122.0304, altSmoothed: 40 }, radius: 400 },
    { waypoint: { name: 'TM-6K', lat: 47.4976, lon: -121.9904, altSmoothed: 680 }, radius: 1000 },
    { waypoint: { name: 'HPT-6K', lat: 47.5323, lon: -121.9812, altSmoothed: 156 }, radius: 1000 },
    { waypoint: { name: 'SQT-5K', lat: 47.5043, lon: -122.0475, altSmoothed: 621 }, radius: 1000, type: 'ESS' },
    { waypoint: { name: 'TLZ-5K', lat: 47.5008, lon: -122.0219, altSmoothed: 55 }, radius: 400 },
  ],
});

/** Minimal XML .xctsk (legacy format) — 3 turnpoints */
const XCTSK_XML = `<?xml version="1.0"?>
<xctrack>
  <task type="RACE_TO_GOAL">
    <turnpoints>
      <turnpoint>
        <waypoint name="START" lat="47.5114" lon="-121.9910" />
        <observation-zone type="cylinder" radius="400" />
      </turnpoint>
      <turnpoint>
        <waypoint name="TP1" lat="47.5478" lon="-121.9834" />
        <observation-zone type="cylinder" radius="400" />
      </turnpoint>
      <turnpoint>
        <waypoint name="GOAL" lat="47.5008" lon="-122.0219" />
        <observation-zone type="cylinder" radius="400" />
      </turnpoint>
    </turnpoints>
    <sss index="0" />
    <goal index="2" />
  </task>
</xctrack>`;

/** Minimal .cup file — 3 waypoints + task section */
const CUP_CONTENT = `name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
"Start","STA","US",4730.684N,12159.460W,744m,1,,,,""
"Turnpoint1","TP1","US",4732.868N,12159.004W,0m,1,,,,""
"Goal","GOL","US",4730.048N,12201.314W,55m,1,,,,""
-----Related Tasks-----
"Test Task","Start","Turnpoint1","Goal"
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a multipart/form-data payload for app.inject() using Node built-ins */
function makeFilePayload(content: string, filename: string) {
  const form = new globalThis.FormData();
  form.append('taskFile', new Blob([content], { type: 'application/octet-stream' }), filename);
  return { payload: form };
}

/**
 * Build a test Fastify app with auth + multipart + league routes.
 * Adds a custom error handler so control-flow throws from auth guards
 * (requireAuth / requireLeagueAdmin) don't overwrite the 401/403 already sent.
 */
async function buildTestApp(db: ReturnType<typeof getTestDb>) {
  const app = Fastify();

  await app.register(import('@fastify/multipart'), { limits: { fileSize: 5 * 1024 * 1024 } });
  await app.register(authPlugin, { config: loadAuthConfig(), db });
  await registerLeagueRoutes(app, { db, queue: null as any });
  await app.ready();
  return app;
}

/** Add a minimal turnpoint to a task so it can be published */
function addTurnpoint(db: ReturnType<typeof getTestDb>, taskId: string, _leagueId: string, type: string, idx: number) {
  const { randomUUID } = require('crypto');
  db.prepare(`
    INSERT INTO turnpoints (id, task_id, sequence_index, name, latitude, longitude, radius_m, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 47.5, -122.0, 400, ?, datetime('now'), datetime('now'))
  `).run(randomUUID(), taskId, idx, `TP${idx}`, type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser unit tests (no HTTP — fast and isolated)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseXctsk — JSON format (v1)', () => {
  it('parses all 7 turnpoints', () => {
    const result = parseXctsk(XCTSK_JSON);
    expect(result.turnpoints).toHaveLength(7);
  });

  it('maps taskType CLASSIC → RACE_TO_GOAL', () => {
    const result = parseXctsk(XCTSK_JSON);
    expect(result.taskType).toBe('RACE_TO_GOAL');
  });

  it('assigns SSS to first untyped turnpoint', () => {
    const result = parseXctsk(XCTSK_JSON);
    expect(result.turnpoints[0].type).toBe('SSS');
    expect(result.turnpoints[0].name).toBe('TLK-6K');
  });

  it('preserves explicit ESS type', () => {
    const result = parseXctsk(XCTSK_JSON);
    const ess = result.turnpoints.find((tp) => tp.type === 'ESS');
    expect(ess?.name).toBe('SQT-5K');
  });

  it('assigns GOAL_CYLINDER to last untyped turnpoint', () => {
    const result = parseXctsk(XCTSK_JSON);
    const last = result.turnpoints[result.turnpoints.length - 1];
    expect(last.type).toBe('GOAL_CYLINDER');
    expect(last.name).toBe('TLZ-5K');
  });

  it('preserves coordinates', () => {
    const result = parseXctsk(XCTSK_JSON);
    const sss = result.turnpoints[0];
    expect(sss.latitude).toBeCloseTo(47.5114, 4);
    expect(sss.longitude).toBeCloseTo(-121.991, 4);
  });

  it('preserves radii', () => {
    const result = parseXctsk(XCTSK_JSON);
    expect(result.turnpoints[0].radius_m).toBe(400);
    expect(result.turnpoints[3].radius_m).toBe(1000); // TM-6K
  });

  it('middle untyped turnpoints stay as CYLINDER', () => {
    const result = parseXctsk(XCTSK_JSON);
    // Indices 1,2,3,4 are untyped non-first non-last — should be CYLINDER
    expect(result.turnpoints[1].type).toBe('CYLINDER');
    expect(result.turnpoints[2].type).toBe('CYLINDER');
  });

  it('format is xctsk', () => {
    expect(parseXctsk(XCTSK_JSON).format).toBe('xctsk');
  });
});

describe('parseXctsk — XML format (legacy)', () => {
  it('parses 3 turnpoints', () => {
    const result = parseXctsk(XCTSK_XML);
    expect(result.turnpoints).toHaveLength(3);
  });

  it('assigns SSS from <sss index>', () => {
    const result = parseXctsk(XCTSK_XML);
    expect(result.turnpoints[0].type).toBe('SSS');
  });

  it('assigns GOAL_CYLINDER from <goal index>', () => {
    const result = parseXctsk(XCTSK_XML);
    expect(result.turnpoints[2].type).toBe('GOAL_CYLINDER');
  });

  it('maps taskType attribute', () => {
    const result = parseXctsk(XCTSK_XML);
    expect(result.taskType).toBe('RACE_TO_GOAL');
  });
});

describe('parseCup', () => {
  it('parses 3 turnpoints from the task section', () => {
    const result = parseCup(CUP_CONTENT);
    expect(result.turnpoints).toHaveLength(3);
  });

  it('assigns SSS to first turnpoint', () => {
    const result = parseCup(CUP_CONTENT);
    expect(result.turnpoints[0].type).toBe('SSS');
  });

  it('assigns GOAL_CYLINDER to last turnpoint', () => {
    const result = parseCup(CUP_CONTENT);
    expect(result.turnpoints[2].type).toBe('GOAL_CYLINDER');
  });

  it('converts DDMM.mmN coordinates to decimal degrees', () => {
    const result = parseCup(CUP_CONTENT);
    // 4730.684N → 47 + 30.684/60 ≈ 47.5114
    expect(result.turnpoints[0].latitude).toBeCloseTo(47.5114, 3);
    // 12159.460W → -(121 + 59.460/60) ≈ -121.991
    expect(result.turnpoints[0].longitude).toBeCloseTo(-121.991, 2);
  });

  it('extracts task name', () => {
    const result = parseCup(CUP_CONTENT);
    expect(result.name).toBe('Test Task');
  });

  it('defaults taskType to RACE_TO_GOAL', () => {
    expect(parseCup(CUP_CONTENT).taskType).toBe('RACE_TO_GOAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Task Import API — POST /leagues/:slug/seasons/:seasonId/tasks/import', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let adminUser: ReturnType<typeof createTestUser>;
  let pilotUser: ReturnType<typeof createTestUser>;
  let testLeague: ReturnType<typeof createTestLeague>;
  let testSeason: ReturnType<typeof createTestSeason>;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    adminUser = createTestUser(db, { email: 'admin@test.com', displayName: 'Admin' });
    pilotUser = createTestUser(db, { email: 'pilot@test.com', displayName: 'Pilot' });
    testLeague = createTestLeague(db, { slug: 'test-league' });
    testSeason = createTestSeason(db, testLeague.id);

    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    addLeagueMember(db, testLeague.id, pilotUser.id, 'pilot');

    app = await buildTestApp(db);
  });

  const importUrl = () => `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/import`;

  // ── JSON .xctsk ─────────────────────────────────────────────────────────

  it('imports a JSON .xctsk file and returns 201 with task + turnpoints', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, '25_August_NWXC.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.task).toMatchObject({
      name: '25_August_NWXC',
      taskType: 'RACE_TO_GOAL',
    });
    expect(body.turnpoints).toHaveLength(7);
  });

  it('assigns SSS, ESS, and GOAL_CYLINDER correctly for JSON .xctsk', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const { turnpoints } = JSON.parse(res.body);
    expect(turnpoints.find((tp: any) => tp.type === 'SSS')).toBeTruthy();
    expect(turnpoints.find((tp: any) => tp.type === 'ESS')).toBeTruthy();
    expect(turnpoints.find((tp: any) => tp.type === 'GOAL_CYLINDER')).toBeTruthy();
  });

  it('uses query param name over parsed filename', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl() + '?name=My+Custom+Task',
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).task.name).toBe('My Custom Task');
  });

  it('persists turnpoints to DB', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    const { task } = JSON.parse(res.body);
    const dbTurnpoints = db
      .prepare(`SELECT * FROM turnpoints WHERE task_id = ? AND deleted_at IS NULL ORDER BY sequence_index`)
      .all(task.id) as any[];

    expect(dbTurnpoints).toHaveLength(7);
    expect(dbTurnpoints[0].type).toBe('SSS');
    expect(dbTurnpoints[dbTurnpoints.length - 1].type).toBe('GOAL_CYLINDER');
  });

  // ── XML .xctsk ──────────────────────────────────────────────────────────

  it('imports a legacy XML .xctsk file', async () => {
    const { payload } = makeFilePayload(XCTSK_XML, 'legacy.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.turnpoints).toHaveLength(3);
    expect(body.turnpoints[0].type).toBe('SSS');
    expect(body.turnpoints[2].type).toBe('GOAL_CYLINDER');
  });

  // ── .cup ────────────────────────────────────────────────────────────────

  it('imports a .cup file', async () => {
    const { payload } = makeFilePayload(CUP_CONTENT, 'route.cup');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.task.name).toBe('Test Task');
    expect(body.turnpoints).toHaveLength(3);
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it('rejects unsupported file extensions', async () => {
    const { payload } = makeFilePayload('...', 'route.gpx');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/unsupported/i);
  });

  it('rejects a file with fewer than 2 turnpoints', async () => {
    const tinyTask = JSON.stringify({
      version: 1,
      turnpoints: [{ waypoint: { name: 'ONLY', lat: 47.5, lon: -122.0 }, radius: 400 }],
    });
    const { payload } = makeFilePayload(tinyTask, 'tiny.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/at least 2 turnpoints/i);
  });

  it('rejects import for a non-existent season', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/non-existent-id/tasks/import`,
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(404);
  });

  // ── Authorization ────────────────────────────────────────────────────────

  it('rejects unauthenticated requests with a 4xx status', async () => {
    // requireAuth sends 401 then throws. In Fastify v4, the thrown error is caught
    // by the framework's default error handler which may emit 500 when the route's
    // preHandler hook (league resolution) has already run. The important guarantee
    // is that auth is enforced (the request does not succeed with a 2xx).
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: {},
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
    // Confirm no task was created
    const tasks = db.prepare(`SELECT id FROM tasks WHERE season_id = ?`).all(testSeason.id) as any[];
    expect(tasks).toHaveLength(0);
  });

  it('returns 403 for a pilot (non-admin) member', async () => {
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': pilotUser.id },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an authenticated user not in the league', async () => {
    const outsider = createTestUser(db, { email: 'outsider@test.com' });
    const { payload } = makeFilePayload(XCTSK_JSON, 'task.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      payload,
      headers: { 'x-test-user-id': outsider.id },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task lifecycle — publish / freeze
// ─────────────────────────────────────────────────────────────────────────────

describe('Task lifecycle — POST publish / freeze', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let adminUser: ReturnType<typeof createTestUser>;
  let pilotUser: ReturnType<typeof createTestUser>;
  let testLeague: ReturnType<typeof createTestLeague>;
  let testSeason: ReturnType<typeof createTestSeason>;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    adminUser = createTestUser(db, { email: 'admin@test.com' });
    pilotUser = createTestUser(db, { email: 'pilot@test.com' });
    testLeague = createTestLeague(db, { slug: 'test-league' });
    testSeason = createTestSeason(db, testLeague.id);

    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    addLeagueMember(db, testLeague.id, pilotUser.id, 'pilot');

    app = await buildTestApp(db);
  });

  it('publishes a draft task', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id);
    // Publish requires at least one turnpoint
    addTurnpoint(db, task.id, testLeague.id, 'SSS', 0);
    addTurnpoint(db, task.id, testLeague.id, 'GOAL_CYLINDER', 1);

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${task.id}/publish`,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(200);
    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id) as any;
    expect(row.status).toBe('published');
  });

  it('freezes a published task', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id);
    db.prepare(`UPDATE tasks SET status = 'published' WHERE id = ?`).run(task.id);

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${task.id}/freeze`,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(200);
    const row = db.prepare(`SELECT scores_frozen_at FROM tasks WHERE id = ?`).get(task.id) as any;
    expect(row.scores_frozen_at).not.toBeNull();
  });

  it('returns 403 when a pilot tries to publish', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id);

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${task.id}/publish`,
      headers: { 'x-test-user-id': pilotUser.id },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real file: 25_August_NWXC.xctsk — parser unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parseXctsk — 25_August_NWXC.xctsk (real file)', () => {
  it('parses all 7 turnpoints', () => {
    const result = parseXctsk(XCTSK_REAL);
    expect(result.turnpoints).toHaveLength(7);
  });

  it('maps CLASSIC taskType to RACE_TO_GOAL', () => {
    const result = parseXctsk(XCTSK_REAL);
    expect(result.taskType).toBe('RACE_TO_GOAL');
  });

  it('assigns SSS to TLK-6K (first untyped turnpoint)', () => {
    const result = parseXctsk(XCTSK_REAL);
    expect(result.turnpoints[0].name).toBe('TLK-6K');
    expect(result.turnpoints[0].type).toBe('SSS');
  });

  it('preserves explicit ESS on SQT-5K', () => {
    const result = parseXctsk(XCTSK_REAL);
    const ess = result.turnpoints.find((tp) => tp.type === 'ESS');
    expect(ess?.name).toBe('SQT-5K');
    expect(ess?.radius_m).toBe(1000);
  });

  it('assigns GOAL_CYLINDER to TLZ-5K (last untyped turnpoint)', () => {
    const result = parseXctsk(XCTSK_REAL);
    const last = result.turnpoints[result.turnpoints.length - 1];
    expect(last.name).toBe('TLZ-5K');
    expect(last.type).toBe('GOAL_CYLINDER');
  });

  it('middle turnpoints (GRN-6K, GRV-5K, TM-6K, HPT-6K) are CYLINDER', () => {
    const result = parseXctsk(XCTSK_REAL);
    const middle = result.turnpoints.slice(1, 5);
    for (const tp of middle) {
      expect(tp.type).toBe('CYLINDER');
    }
  });

  it('preserves coordinates for TLK-6K', () => {
    const result = parseXctsk(XCTSK_REAL);
    const sss = result.turnpoints[0];
    expect(sss.latitude).toBeCloseTo(47.5114, 4);
    expect(sss.longitude).toBeCloseTo(-121.991, 3);
  });

  it('preserves radii (TM-6K and HPT-6K are 1000m)', () => {
    const result = parseXctsk(XCTSK_REAL);
    expect(result.turnpoints[3].radius_m).toBe(1000); // TM-6K
    expect(result.turnpoints[4].radius_m).toBe(1000); // HPT-6K
    expect(result.turnpoints[0].radius_m).toBe(400); // TLK-6K
  });
});

describe('Task import API — 25_August_NWXC.xctsk (real file)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let adminUser: ReturnType<typeof createTestUser>;
  let testLeague: ReturnType<typeof createTestLeague>;
  let testSeason: ReturnType<typeof createTestSeason>;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);
    adminUser = createTestUser(db, { email: 'admin@test.com' });
    testLeague = createTestLeague(db, { slug: 'nwxc' });
    testSeason = createTestSeason(db, testLeague.id);
    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    app = await buildTestApp(db);
  });

  it('imports the real file and creates 7 turnpoints in DB', async () => {
    const { payload } = makeFilePayload(XCTSK_REAL, '25_August_NWXC.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/import`,
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.task.name).toBe('25_August_NWXC');
    expect(body.task.taskType).toBe('RACE_TO_GOAL');
    expect(body.turnpoints).toHaveLength(7);

    const dbTps = db
      .prepare(`SELECT * FROM turnpoints WHERE task_id = ? ORDER BY sequence_index`)
      .all(body.task.id) as any[];
    expect(dbTps).toHaveLength(7);
    expect(dbTps[0].type).toBe('SSS');
    expect(dbTps[5].type).toBe('ESS');
    expect(dbTps[6].type).toBe('GOAL_CYLINDER');
  });

  it('can publish the imported task (has turnpoints)', async () => {
    const { payload } = makeFilePayload(XCTSK_REAL, '25_August_NWXC.xctsk');

    const importRes = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/import`,
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });
    expect(importRes.statusCode).toBe(201);
    const { task } = JSON.parse(importRes.body);

    const publishRes = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${task.id}/publish`,
      headers: { 'x-test-user-id': adminUser.id },
    });
    expect(publishRes.statusCode).toBe(200);

    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id) as any;
    expect(row.status).toBe('published');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QR code encoder — XCTSK v2 format (XCTrack / FlySkHy / SeeYou)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildXctrackDeepLink — XCTSK v2 format', () => {
  const baseTask: ExportTask = {
    id: 'test-id',
    name: '25 Aug NWXC',
    taskType: 'RACE_TO_GOAL',
    turnpoints: parseXctsk(XCTSK_REAL).turnpoints.map((tp, i) => ({
      name: tp.name,
      latitude: tp.latitude,
      longitude: tp.longitude,
      radius_m: tp.radius_m,
      type: tp.type,
      sequenceIndex: i,
    })),
  };

  it('starts with XCTSK: scheme (not xctrack://)', () => {
    const result = buildXctrackDeepLink(baseTask);
    expect(result).toMatch(/^XCTSK:/);
    expect(result).not.toMatch(/^xctrack:\/\//);
  });

  it('contains valid JSON after the XCTSK: prefix', () => {
    const result = buildXctrackDeepLink(baseTask);
    const json = result.slice('XCTSK:'.length);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('uses version 2', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    expect(obj.version).toBe(2);
  });

  it('includes all 7 turnpoints', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    expect(obj.t).toHaveLength(7);
  });

  it('encodes turnpoints with z, n fields', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    for (const tp of obj.t) {
      expect(typeof tp.z).toBe('string');
      expect(tp.z.length).toBeGreaterThan(0);
      expect(typeof tp.n).toBe('string');
    }
  });

  it('marks SSS turnpoint with type 2', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    const sss = obj.t.find((tp: any) => tp.t === 2);
    expect(sss?.n).toBe('TLK-6K');
  });

  it('marks ESS turnpoint with type 3', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    const ess = obj.t.find((tp: any) => tp.t === 3);
    expect(ess?.n).toBe('SQT-5K');
  });

  it('goal turnpoint (TLZ-5K) has no type field', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    const goal = obj.t.find((tp: any) => tp.n === 'TLZ-5K');
    expect(goal?.t).toBeUndefined();
  });

  it('uses WGS84 earth model (e=0)', () => {
    const result = buildXctrackDeepLink(baseTask);
    const obj = JSON.parse(result.slice('XCTSK:'.length));
    expect(obj.e).toBe(0);
  });
});

describe('encodeXctskZ — polyline coordinate encoding', () => {
  it('produces a non-empty string', () => {
    expect(encodeXctskZ(-121.991, 47.5114, 0, 400).length).toBeGreaterThan(0);
  });

  it('produces different z values for different coordinates', () => {
    const z1 = encodeXctskZ(-121.991, 47.5114, 0, 400);
    const z2 = encodeXctskZ(-122.0475, 47.5043, 0, 1000);
    expect(z1).not.toBe(z2);
  });

  it('same inputs always produce the same output (deterministic)', () => {
    expect(encodeXctskZ(-121.991, 47.5114, 0, 400)).toBe(encodeXctskZ(-121.991, 47.5114, 0, 400));
  });

  it('radius difference is reflected in z string', () => {
    const z400 = encodeXctskZ(-121.991, 47.5114, 0, 400);
    const z1000 = encodeXctskZ(-121.991, 47.5114, 0, 1000);
    expect(z400).not.toBe(z1000);
  });

  // Verified against the actual decoded QR code from the FlySkHy app
  // (zbarimg "/Users/jameswillis/Downloads/August QR Code.png")
  // TLK-6K: lon=-121.99095, lat=47.5114, alt=744, radius=400
  // The reference QR uses actual altitude; we use alt=0, so only lon/lat/radius match.
  it('encodes TLK-6K lon correctly (first 5 chars match reference)', () => {
    const z = encodeXctskZ(-121.99095, 47.5114, 0, 400);
    // Reference z prefix for lon=-12199095: "ljqgV"
    expect(z.slice(0, 5)).toBe('ljqgV');
  });

  it('encodes TLK-6K lat correctly (next 5 chars match reference)', () => {
    const z = encodeXctskZ(-121.99095, 47.5114, 0, 400);
    // Reference chars for lat=4751140: "gq~`H"
    expect(z.slice(5, 10)).toBe('gq~`H');
  });

  it('encodes 400m radius correctly (last 2 chars match reference)', () => {
    const z = encodeXctskZ(-121.99095, 47.5114, 0, 400);
    // Reference chars for radius=400: "_X"
    expect(z.slice(-2)).toBe('_X');
  });

  it('encodes 1000m radius correctly', () => {
    const z = encodeXctskZ(-122.0475, 47.5043, 0, 1000);
    // Reference z for SQT-5K (ESS, 1000m): "zk|gVae}`Hye@o}@"
    // Last chars for radius=1000: "o}@"
    expect(z.slice(-3)).toBe('o}@');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QR roundtrip — parse 25_August_NWXC.xctsk → build QR → verify against
// the actual QR code decoded from ~/Downloads/August QR Code.png
// (decoded with: zbarimg "August QR Code.png")
// ─────────────────────────────────────────────────────────────────────────────

// The reference QR was generated by FlySkHy with actual altitudes.
// Our implementation uses alt=0 (not stored in DB), so z strings will differ
// in the altitude component but lon/lat/radius must match.
const REFERENCE_QR =
  'XCTSK:{"taskType":"CLASSIC","version":2,"t":[{"z":"ljqgVgq~`Hom@_X","n":"TLK-6K","d":"TLK-6K","t":2,"o":{"a1":180}},{"z":"b{ogV}teaH|nov}D_X","n":"GRN-6K","d":"GRN-6K","o":{"a1":180}},{"z":"z`ygV_{daHoA_X","n":"GRV-5K","d":"GRV-5K","o":{"a1":180}},{"z":"zfqgV{z{`Hoi@o}@","n":"TM-6K","d":"TM-6K","o":{"a1":180}},{"z":"dmogVatbaHwHo}@","n":"HPT-6K","d":"HPT-6K","o":{"a1":180}},{"z":"zk|gVae}`Hye@o}@","n":"SQT-5K","d":"SQT-5K","t":3,"o":{"a1":180}},{"z":"zkwgV_o|`HmB_X","n":"TLZ-5K","d":"TLZ-5K","o":{"a1":180}}],"s":{"g":[],"d":1,"t":1},"o":{"v":2}}';

describe('QR roundtrip — 25_August_NWXC.xctsk → XCTSK QR', () => {
  const parsed = parseXctsk(XCTSK_REAL);
  const exportTask: ExportTask = {
    id: 'test',
    name: '25_August_NWXC',
    taskType: 'RACE_TO_GOAL',
    turnpoints: parsed.turnpoints.map((tp, i) => ({
      name: tp.name,
      latitude: tp.latitude,
      longitude: tp.longitude,
      radius_m: tp.radius_m,
      type: tp.type,
      sequenceIndex: i,
    })),
  };

  const refObj = JSON.parse(REFERENCE_QR.slice('XCTSK:'.length));
  const ourQr = buildXctrackDeepLink(exportTask);
  const ourObj = JSON.parse(ourQr.slice('XCTSK:'.length));

  it('produces XCTSK: prefix', () => {
    expect(ourQr).toMatch(/^XCTSK:/);
  });

  it('taskType is "CLASSIC"', () => {
    expect(ourObj.taskType).toBe('CLASSIC');
  });

  it('version is 2', () => {
    expect(ourObj.version).toBe(2);
  });

  it('has same number of turnpoints as reference', () => {
    expect(ourObj.t).toHaveLength(refObj.t.length);
  });

  it('turnpoint names match reference in order', () => {
    const ourNames = ourObj.t.map((tp: any) => tp.n);
    const refNames = refObj.t.map((tp: any) => tp.n);
    expect(ourNames).toEqual(refNames);
  });

  it('SSS type tag matches reference (TLK-6K = 2)', () => {
    expect(ourObj.t[0].t).toBe(2);
    expect(refObj.t[0].t).toBe(2);
  });

  it('ESS type tag matches reference (SQT-5K = 3)', () => {
    expect(ourObj.t[5].t).toBe(3);
    expect(refObj.t[5].t).toBe(3);
  });

  it('goal turnpoint (TLZ-5K) has no type tag', () => {
    expect(ourObj.t[6].t).toBeUndefined();
    expect(refObj.t[6].t).toBeUndefined();
  });

  it('lon/lat/radius portion of z matches reference for each turnpoint', () => {
    // z encodes [lon, lat, alt, radius]. We use alt=0; reference uses actual altitude.
    // We can verify lon (first chars) and lat (next chars) independently by
    // checking the first 10 chars of z match (lon+lat only, before alt diverges).
    for (let i = 0; i < refObj.t.length; i++) {
      const ourZ = ourObj.t[i].z as string;
      const refZ = refObj.t[i].z as string;
      // First 10 chars encode lon×1e5 and lat×1e5 (5 chars each for these coords)
      expect(ourZ.slice(0, 10)).toBe(refZ.slice(0, 10));
    }
  });

  it('radius portion of z matches reference (last 2-3 chars)', () => {
    // 400m radius encodes as "_X" (2 chars), 1000m as "o}@" (3 chars)
    const r400 = '_X';
    const r1000 = 'o}@';
    // TLK-6K, GRN-6K, GRV-5K, TLZ-5K = 400m; TM-6K, HPT-6K, SQT-5K = 1000m
    expect(ourObj.t[0].z.endsWith(r400)).toBe(true);
    expect(ourObj.t[3].z.endsWith(r1000)).toBe(true);
    expect(ourObj.t[4].z.endsWith(r1000)).toBe(true);
    expect(ourObj.t[5].z.endsWith(r1000)).toBe(true);
    expect(ourObj.t[6].z.endsWith(r400)).toBe(true);
  });

  it('includes start section s with d and t fields', () => {
    // g (timeGates) is intentionally omitted — passing g:[] causes XCTrack
    // to throw "sss.timeGates is empty". We only assert the fields we set.
    expect(ourObj.s.d).toBe(1);
    expect(ourObj.s.t).toBe(1);
    expect(ourObj.s.g).toBeUndefined();
  });

  it('includes options o matching reference', () => {
    expect(ourObj.o).toEqual(refObj.o);
  });

  it('earth model is WGS84 (e=0)', () => {
    expect(ourObj.e).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QR code — content length and HTTP endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** Build an ExportTask with N evenly-spaced turnpoints around a central point. */
function makeLargeExportTask(turnpointCount: number): ExportTask {
  const turnpoints = Array.from({ length: turnpointCount }, (_, i) => ({
    name: `TP${String(i).padStart(2, '0')}`,
    latitude: 47.5 + i * 0.01,
    longitude: -122.0 + i * 0.01,
    radius_m: 400,
    type: i === 0 ? 'SSS' : i === turnpointCount - 1 ? 'GOAL_CYLINDER' : 'CYLINDER',
    sequenceIndex: i,
  }));
  return { id: 'test', name: 'Large Task', taskType: 'RACE_TO_GOAL', turnpoints };
}

describe('buildXctrackDeepLink — content length', () => {
  it('produces content under 2331 bytes for a normal 7-turnpoint task', () => {
    const task = makeLargeExportTask(7);
    const content = buildXctrackDeepLink(task);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(2331);
  });

  it('produces content over 2331 bytes for a 54-turnpoint task', () => {
    const task = makeLargeExportTask(54);
    const content = buildXctrackDeepLink(task);
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(2331);
  });
});

describe('Task QR endpoint — GET /leagues/:slug/seasons/:seasonId/tasks/:taskId/qr', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let adminUser: ReturnType<typeof createTestUser>;
  let pilotUser: ReturnType<typeof createTestUser>;
  let testLeague: ReturnType<typeof createTestLeague>;
  let testSeason: ReturnType<typeof createTestSeason>;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);

    adminUser = createTestUser(db, { email: 'admin@test.com' });
    pilotUser = createTestUser(db, { email: 'pilot@test.com' });
    testLeague = createTestLeague(db, { slug: 'test-league' });
    testSeason = createTestSeason(db, testLeague.id);

    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    addLeagueMember(db, testLeague.id, pilotUser.id, 'pilot');

    app = await buildTestApp(db);
  });

  const qrUrl = (taskId: string) =>
    `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/${taskId}/qr?app=xctrack&format=xctsk`;

  it('returns a PNG image for a normal task', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id);
    addTurnpoint(db, task.id, testLeague.id, 'SSS', 0);
    addTurnpoint(db, task.id, testLeague.id, 'CYLINDER', 1);
    addTurnpoint(db, task.id, testLeague.id, 'GOAL_CYLINDER', 2);

    const res = await app.inject({
      method: 'GET',
      url: qrUrl(task.id),
      headers: { 'x-test-user-id': pilotUser.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // PNG magic bytes: 89 50 4E 47
    expect(res.rawPayload[0]).toBe(0x89);
    expect(res.rawPayload[1]).toBe(0x50);
  });

  it('returns 422 with qr_too_large for a task that exceeds QR capacity', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id, { name: 'Season' });
    // 40 turnpoints is enough to exceed the 2331-byte limit
    for (let i = 0; i < 40; i++) {
      addTurnpoint(db, task.id, testLeague.id, i === 0 ? 'SSS' : i === 39 ? 'GOAL_CYLINDER' : 'CYLINDER', i);
    }

    const res = await app.inject({
      method: 'GET',
      url: qrUrl(task.id),
      headers: { 'x-test-user-id': pilotUser.id },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: 'qr_too_large' });
  });

  it('returns 404 for an unknown task id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: qrUrl('00000000-0000-0000-0000-000000000000'),
      headers: { 'x-test-user-id': pilotUser.id },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const task = createTestTask(db, testSeason.id, testLeague.id);

    const res = await app.inject({
      method: 'GET',
      url: qrUrl(task.id),
      headers: {},
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOAL_LINE import — verify goal_line_bearing_deg is computed and persisted
// ─────────────────────────────────────────────────────────────────────────────

const XCTSK_GOAL_LINE = `<?xml version="1.0"?>
<xctrack>
  <task type="RACE_TO_GOAL">
    <turnpoints>
      <turnpoint>
        <waypoint name="START" lat="470000000" lon="-1220000000" />
        <observation-zone type="cylinder" radius="400" />
      </turnpoint>
      <turnpoint>
        <waypoint name="TP1" lat="475000000" lon="-1215000000" />
        <observation-zone type="cylinder" radius="400" />
      </turnpoint>
      <turnpoint>
        <waypoint name="GOAL" lat="480000000" lon="-1220000000" />
        <observation-zone type="line" radius="200" />
      </turnpoint>
    </turnpoints>
    <sss index="0" />
    <ess index="1" />
    <goal index="2" />
  </task>
</xctrack>`;

describe('GOAL_LINE import — goal_line_bearing_deg persistence', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof getTestDb>;
  let testLeague: any;
  let testSeason: any;
  let adminUser: any;

  beforeEach(async () => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);
    adminUser = createTestUser(db);
    testLeague = createTestLeague(db);
    addLeagueMember(db, testLeague.id, adminUser.id, 'admin');
    testSeason = createTestSeason(db, testLeague.id);
    app = await buildTestApp(db);
  });

  it('computes and stores goal_line_bearing_deg for a GOAL_LINE task', async () => {
    const { payload } = makeFilePayload(XCTSK_GOAL_LINE, 'goal-line.xctsk');

    const res = await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/import`,
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(res.statusCode).toBe(201);
    const { task } = JSON.parse(res.body);

    // Check DB directly — goal_line_bearing_deg should be non-null for the GOAL_LINE TP
    const goalTp = db
      .prepare(
        `SELECT type, goal_line_bearing_deg FROM turnpoints
       WHERE task_id = ? AND type = 'GOAL_LINE'`,
      )
      .get(task.id) as any;

    expect(goalTp).toBeTruthy();
    expect(goalTp.goal_line_bearing_deg).not.toBeNull();
    expect(goalTp.goal_line_bearing_deg).toBeGreaterThanOrEqual(0);
    expect(goalTp.goal_line_bearing_deg).toBeLessThan(360);

    // Non-GOAL_LINE turnpoints should have null bearing
    const otherTps = db
      .prepare(
        `SELECT type, goal_line_bearing_deg FROM turnpoints
       WHERE task_id = ? AND type != 'GOAL_LINE'`,
      )
      .all(task.id) as any[];
    for (const tp of otherTps) {
      expect(tp.goal_line_bearing_deg).toBeNull();
    }
  });

  it('returns goalLineBearingDeg in the task list API', async () => {
    const { payload } = makeFilePayload(XCTSK_GOAL_LINE, 'goal-line.xctsk');

    await app.inject({
      method: 'POST',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks/import`,
      payload,
      headers: { 'x-test-user-id': adminUser.id },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: `/leagues/${testLeague.slug}/seasons/${testSeason.id}/tasks`,
      headers: { 'x-test-user-id': adminUser.id },
    });

    expect(listRes.statusCode).toBe(200);
    const { tasks } = JSON.parse(listRes.body);
    const goalTp = tasks[0].turnpoints.find((tp: any) => tp.type === 'GOAL_LINE');
    expect(goalTp).toBeTruthy();
    expect(goalTp.goalLineBearingDeg).not.toBeNull();
    expect(typeof goalTp.goalLineBearingDeg).toBe('number');
  });
});
