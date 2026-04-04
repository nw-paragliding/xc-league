// =============================================================================
// Seed synthetic pilots + results for local dev/demo
// Run: node scripts/seed-synthetic.js
// =============================================================================

const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'league.db'));

// ── Config ────────────────────────────────────────────────────────────────────

const LEAGUE_ID = '3ff4b20b-1c0e-40ec-befa-065de30e11fd';
const SEASON_ID = 'fc09a505-5f14-4acd-8355-0554bfcaaddd';

const TASKS = [
  { id: '4d6b0d01-174b-4161-b0c6-b6eba84cb465', name: 'August', distKm: 17.8 },
  { id: '5f8d4ff2-7221-44c1-a0c5-378554de8ca2', name: 'Season', distKm: 9.5 },
  { id: '67a5a9d4-e8ab-476b-9fac-c667690b371d', name: 'May', distKm: 9.1 },
  { id: '5eda4d74-5694-466f-ba20-8d45addc8cb5', name: 'June', distKm: 6.3 },
  { id: '8d734621-267d-47cc-ad03-e75279b74775', name: 'July', distKm: 11.2 },
  { id: '5b4659c8-3e8e-4600-938b-56ef7e866e28', name: 'April', distKm: 2.9 },
];

const PILOTS = [
  { name: 'Alex Moreau', email: 'alex.moreau@example.com', skill: 0.92 },
  { name: 'Sam Reinholt', email: 'sam.reinholt@example.com', skill: 0.85 },
  { name: 'Chris Nakamura', email: 'chris.nakamura@example.com', skill: 0.78 },
  { name: 'Jordan Blake', email: 'jordan.blake@example.com', skill: 0.71 },
  { name: 'Morgan Svensson', email: 'morgan.svensson@example.com', skill: 0.65 },
  { name: 'Taylor Oduya', email: 'taylor.oduya@example.com', skill: 0.58 },
  { name: 'Riley Park', email: 'riley.park@example.com', skill: 0.5 },
  { name: 'Drew Hoffmann', email: 'drew.hoffmann@example.com', skill: 0.42 },
  { name: 'Quinn Dupont', email: 'quinn.dupont@example.com', skill: 0.35 },
  { name: 'Avery Lindqvist', email: 'avery.lindqvist@example.com', skill: 0.25 },
];

// ── IGC helpers ───────────────────────────────────────────────────────────────

// Encode decimal degrees to IGC lat string: DDMMmmmN/S (8 chars)
function igcLat(decDeg) {
  const hemi = decDeg >= 0 ? 'N' : 'S';
  const abs = Math.abs(decDeg);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60; // e.g. 29.980
  const minInt = Math.floor(minFull); // e.g. 29
  const minFrac = Math.round((minFull - minInt) * 1000); // e.g. 980 → 3 digits
  return String(deg).padStart(2, '0') + String(minInt).padStart(2, '0') + String(minFrac).padStart(3, '0') + hemi; // 2+2+3+1 = 8
}

// Encode decimal degrees to IGC lon string: DDDMMmmmE/W (9 chars)
function igcLon(decDeg) {
  const hemi = decDeg >= 0 ? 'E' : 'W';
  const abs = Math.abs(decDeg);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const minInt = Math.floor(minFull);
  const minFrac = Math.round((minFull - minInt) * 1000);
  return String(deg).padStart(3, '0') + String(minInt).padStart(2, '0') + String(minFrac).padStart(3, '0') + hemi; // 3+2+3+1 = 9
}

// Format seconds-since-midnight as HHMMSS
function igcTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0');
}

// Build a valid IGC file with a simple track that wanders near the task area
// Task turnpoints are roughly 47.48–47.55N, 121.98–122.07W (Stevens Pass area)
function makeIgc(pilotName, pilotIdx, taskIdx, distFraction) {
  // Start near launch (Tumwater Mountain area)
  const startLat = 47.5114 + Math.sin(pilotIdx * 5) * 0.005;
  const startLon = -121.991 + Math.sin(pilotIdx * 7) * 0.005;

  // End point drifts toward goal proportional to distFraction
  const endLat = startLat + distFraction * 0.06 * (pilotIdx % 2 === 0 ? 1 : -1);
  const endLon = startLon - distFraction * 0.08;

  // Generate ~30 B records over ~1.5 hours (every 3 minutes)
  const numFixes = 30;
  const startSec = 10 * 3600; // 10:00 UTC
  const lines = [
    'AXXX001 Synthetic',
    'HFDTE260526',
    `HFPLTPILOTINCHARGE:${pilotName}`,
    'HFGTYGLIDERTYPE:Synthetic Glider',
    'HFGIDGLIDERID:SYN001',
    'HFFTYFRTYPE:Synthetic Logger',
    'HFGPSGPS:Synthetic',
  ];

  for (let i = 0; i < numFixes; i++) {
    const t = i / (numFixes - 1);
    const secs = startSec + i * 180;
    const lat = startLat + t * (endLat - startLat);
    const lon = startLon + t * (endLon - startLon);
    const alt = Math.round(800 + t * distFraction * 600 + Math.sin(i * 0.8) * 50);
    const pAlt = Math.round(alt - 30);
    const bLine =
      'B' +
      igcTime(secs) +
      igcLat(lat) +
      igcLon(lon) +
      'A' +
      String(pAlt).padStart(5, '0') +
      String(alt).padStart(5, '0');
    lines.push(bLine);
  }

  lines.push('LSYNSYNTHETIC DATA - NOT A REAL FLIGHT');
  return lines.join('\r\n');
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function computeScore(task, skill, j) {
  const reachedGoal = skill + j > 0.55;

  const distKm = reachedGoal ? task.distKm : task.distKm * (0.3 + (skill + j) * 0.65);
  const distFraction = Math.min(distKm / task.distKm, 1);
  const distancePoints = Math.round(938 * distFraction);

  let taskTimeS = null;
  let timePoints = 0;

  if (reachedGoal) {
    const baseS = 3600 - Math.round(skill * 2400);
    taskTimeS = Math.max(1200, baseS + Math.round(j * 1200));
    timePoints = Math.round(938 * Math.max(0, 1 - taskTimeS / 7200));
  }

  return { reachedGoal, distKm, distFraction, distancePoints, timePoints, taskTimeS };
}

function jitter(pilotIdx, taskIdx) {
  const x = Math.sin(pilotIdx * 7 + taskIdx * 13) * 43758.5453;
  return (x - Math.floor(x)) * 0.3 - 0.15;
}

// ── Main ──────────────────────────────────────────────────────────────────────

db.pragma('journal_mode = WAL');

// First wipe existing synthetic pilots' data
const syntheticEmails = PILOTS.map((p) => p.email);
const placeholders = syntheticEmails.map(() => '?').join(',');

db.transaction(() => {
  const existingUsers = db.prepare(`SELECT id FROM users WHERE email IN (${placeholders})`).all(...syntheticEmails);
  const existingIds = existingUsers.map((u) => u.id);

  if (existingIds.length > 0) {
    const idPlaceholders = existingIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM task_results     WHERE user_id IN (${idPlaceholders})`).run(...existingIds);
    db.prepare(`DELETE FROM flight_attempts  WHERE user_id IN (${idPlaceholders})`).run(...existingIds);
    db.prepare(`DELETE FROM flight_submissions WHERE user_id IN (${idPlaceholders})`).run(...existingIds);
    db.prepare(`DELETE FROM season_registrations WHERE user_id IN (${idPlaceholders})`).run(...existingIds);
    db.prepare(`DELETE FROM league_memberships WHERE user_id IN (${idPlaceholders})`).run(...existingIds);
    db.prepare(`DELETE FROM users WHERE id IN (${idPlaceholders})`).run(...existingIds);
    console.log(`Cleared ${existingIds.length} existing synthetic pilots.`);
  }

  const insertSubmission = db.prepare(`
    INSERT INTO flight_submissions
      (id, task_id, user_id, league_id, igc_data, igc_filename, igc_size_bytes, igc_sha256,
       igc_date, submitted_at, status, best_attempt_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-05-26', datetime('now'), 'PROCESSED', ?, datetime('now'), datetime('now'))
  `);

  const insertAttempt = db.prepare(`
    INSERT INTO flight_attempts
      (id, submission_id, task_id, user_id, league_id,
       sss_crossing_time, ess_crossing_time, goal_crossing_time,
       task_time_s, reached_goal, last_turnpoint_index, distance_flown_km,
       distance_points, time_points, total_points, has_flagged_crossings,
       attempt_index, scorer_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '1.0', datetime('now'), datetime('now'))
  `);

  for (let pi = 0; pi < PILOTS.length; pi++) {
    const pilot = PILOTS[pi];
    const uid = randomUUID();

    db.prepare(`
      INSERT INTO users (id, email, display_name, is_super_admin, token_version, created_at, updated_at)
      VALUES (?, ?, ?, 0, 1, datetime('now'), datetime('now'))
    `).run(uid, pilot.email, pilot.name);

    db.prepare(`
      INSERT OR IGNORE INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pilot', datetime('now'), datetime('now'), datetime('now'))
    `).run(randomUUID(), LEAGUE_ID, uid);

    db.prepare(`
      INSERT OR IGNORE INTO season_registrations (id, season_id, user_id, registered_at, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(randomUUID(), SEASON_ID, uid);

    for (let ti = 0; ti < TASKS.length; ti++) {
      const task = TASKS[ti];
      const j = jitter(pi, ti);

      // ~20% chance pilot skips this task
      if (Math.sin(pi * 3 + ti * 11) > 0.6) continue;

      const { reachedGoal, distKm, distFraction, distancePoints, timePoints, taskTimeS } = computeScore(
        task,
        pilot.skill,
        j,
      );

      const submissionId = randomUUID();
      const attemptId = randomUUID();
      const igcText = makeIgc(pilot.name, pi, ti, distFraction);
      const sha = Buffer.from(pilot.email + task.id)
        .toString('hex')
        .slice(0, 64)
        .padEnd(64, '0');

      insertSubmission.run(
        submissionId,
        task.id,
        uid,
        LEAGUE_ID,
        Buffer.from(igcText, 'utf8'),
        `${pilot.name.replace(/ /g, '_')}_${task.name}.igc`,
        igcText.length,
        sha,
        attemptId,
      );

      insertAttempt.run(
        attemptId,
        submissionId,
        task.id,
        uid,
        LEAGUE_ID,
        reachedGoal ? datetime() : null, // sss_crossing_time
        reachedGoal ? datetime() : null, // ess_crossing_time
        taskTimeS,
        reachedGoal ? 1 : 0,
        reachedGoal ? 99 : Math.floor(distFraction * 5),
        distKm,
        distancePoints,
        timePoints,
        distancePoints + timePoints,
      );

      db.prepare(`
        INSERT INTO task_results
          (id, task_id, user_id, league_id, best_attempt_id, distance_flown_km,
           reached_goal, task_time_s, distance_points, time_points, total_points,
           has_flagged_crossings, rank, last_computed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'), datetime('now'))
      `).run(
        randomUUID(),
        task.id,
        uid,
        LEAGUE_ID,
        attemptId,
        distKm,
        reachedGoal ? 1 : 0,
        taskTimeS,
        distancePoints,
        timePoints,
        distancePoints + timePoints,
      );
    }
  }

  // Recompute ranks for every task
  for (const task of TASKS) {
    const rows = db
      .prepare(`SELECT id, total_points FROM task_results WHERE task_id = ? ORDER BY total_points DESC`)
      .all(task.id);
    rows.forEach((row, i) => {
      db.prepare('UPDATE task_results SET rank = ? WHERE id = ?').run(i + 1, row.id);
    });
  }

  // Recompute season_standings
  const standingRows = db
    .prepare(`
    SELECT
      tr.user_id,
      SUM(tr.total_points) AS total_points,
      COUNT(tr.task_id)    AS tasks_flown,
      SUM(tr.reached_goal) AS tasks_with_goal
    FROM task_results tr
    JOIN tasks t ON t.id = tr.task_id
    WHERE t.season_id = ? AND t.deleted_at IS NULL
    GROUP BY tr.user_id
    ORDER BY total_points DESC
  `)
    .all(SEASON_ID);

  const upsertStanding = db.prepare(`
    INSERT INTO season_standings
      (id, season_id, user_id, league_id, total_points, tasks_flown, tasks_with_goal,
       rank, last_computed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT (season_id, user_id) DO UPDATE SET
      total_points     = excluded.total_points,
      tasks_flown      = excluded.tasks_flown,
      tasks_with_goal  = excluded.tasks_with_goal,
      rank             = excluded.rank,
      last_computed_at = datetime('now'),
      updated_at       = datetime('now')
  `);

  standingRows.forEach((row, i) => {
    upsertStanding.run(
      randomUUID(),
      SEASON_ID,
      row.user_id,
      LEAGUE_ID,
      row.total_points,
      row.tasks_flown,
      row.tasks_with_goal,
      i + 1,
    );
  });

  console.log(
    `Done — inserted ${PILOTS.length} pilots across ${TASKS.length} tasks, ${standingRows.length} in standings.`,
  );
})();

function datetime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}
