import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function setupTestDatabase(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 0001: initial schema (schema.sql acts as the baseline migration)
  const schema = readFileSync(join(__dirname, '../src/schema.sql'), 'utf-8');
  db.exec(schema);
  db.prepare(`INSERT OR IGNORE INTO migrations (name) VALUES ('0001_initial_schema')`).run();

  // 0002 and 0003: numbered migrations
  const migrationsDir = join(__dirname, '../src/migrations');
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const name = file.replace('.sql', '');
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare(`INSERT OR IGNORE INTO migrations (name) VALUES (?)`).run(name);
  }
}

export function createTestUser(db: Database.Database, overrides: Partial<{
  id: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
}> = {}) {
  const userId = overrides.id || randomUUID();
  const email = overrides.email || `test-${userId}@example.com`;
  const displayName = overrides.displayName || 'Test User';
  const isSuperAdmin = overrides.isSuperAdmin ? 1 : 0;

  db.prepare(
    `INSERT INTO users (id, email, display_name, is_super_admin, token_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
  ).run(userId, email, displayName, isSuperAdmin);

  return {
    id: userId,
    email,
    displayName,
    isSuperAdmin: Boolean(isSuperAdmin),
  };
}

export function createTestLeague(db: Database.Database, overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  description: string;
}> = {}) {
  const leagueId = overrides.id || randomUUID();
  const name = overrides.name || 'Test League';
  const slug = overrides.slug || `test-league-${leagueId.slice(0, 8)}`;

  db.prepare(
    `INSERT INTO leagues (id, name, slug, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(leagueId, name, slug, overrides.description || null);

  return {
    id: leagueId,
    name,
    slug,
    description: overrides.description || null,
  };
}

export function addLeagueMember(
  db: Database.Database,
  leagueId: string,
  userId: string,
  role: 'admin' | 'pilot' = 'pilot'
) {
  const membershipId = randomUUID();

  db.prepare(
    `INSERT INTO league_memberships (id, league_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(membershipId, leagueId, userId, role);

  return membershipId;
}

export function createTestSeason(
  db: Database.Database,
  leagueId: string,
  overrides: Partial<{
    id: string;
    name: string;
    competitionType: 'XC' | 'HIKE_AND_FLY';
    startDate: string;
    endDate: string;
  }> = {}
) {
  const seasonId = overrides.id || randomUUID();
  const name = overrides.name || 'Test Season';
  const competitionType = overrides.competitionType || 'XC';
  const startDate = overrides.startDate || '2025-06-01';
  const endDate = overrides.endDate || '2025-09-30';

  db.prepare(
    `INSERT INTO seasons (
      id, league_id, name, competition_type, start_date, end_date,
      nominal_distance_km, nominal_time_s, nominal_goal_ratio,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 70.0, 5400, 0.3, datetime('now'), datetime('now'))`
  ).run(seasonId, leagueId, name, competitionType, startDate, endDate);

  return {
    id: seasonId,
    name,
    competitionType,
    startDate,
    endDate,
  };
}

export function createTestTask(
  db: Database.Database,
  seasonId: string,
  leagueId: string,
  overrides: Partial<{
    id: string;
    name: string;
    taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
    openDate: string;
    closeDate: string;
  }> = {}
) {
  const taskId = overrides.id || randomUUID();
  const name = overrides.name || 'Test Task';
  const taskType = overrides.taskType || 'RACE_TO_GOAL';
  const openDate = overrides.openDate || '2025-06-01T09:00:00Z';
  const closeDate = overrides.closeDate || '2025-06-01T18:00:00Z';

  db.prepare(
    `INSERT INTO tasks (
      id, season_id, league_id, name, task_type, open_date, close_date,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(taskId, seasonId, leagueId, name, taskType, openDate, closeDate);

  return {
    id: taskId,
    name,
    taskType,
    openDate,
    closeDate,
  };
}
