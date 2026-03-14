import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function setupTestDatabase(db: Database.Database) {
  // Load and execute schema
  const schemaPath = join(__dirname, '../src/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Load and execute migrations
  const migration1 = readFileSync(join(__dirname, '../src/migrations/0001_initial_schema.sql'), 'utf-8');
  const migration2 = readFileSync(join(__dirname, '../src/migrations/0002_admin_features.sql'), 'utf-8');
  
  // Mark migrations as applied
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  
  db.exec(migration1);
  db.exec(migration2);
  
  db.prepare(`INSERT OR IGNORE INTO migrations (id) VALUES ('0001_initial_schema')`).run();
  db.prepare(`INSERT OR IGNORE INTO migrations (id) VALUES ('0002_admin_features')`).run();
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
