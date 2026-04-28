import type Database from 'better-sqlite3';

/**
 * Drop league_id columns that were removed in migration 0010.
 * SQLite lacks DROP COLUMN IF EXISTS, so we check pragma_table_info first.
 * Called from migrate.ts, server.ts, and test helpers to keep behavior consistent.
 */
export function dropRedundantLeagueIdColumns(db: Database.Database): void {
  for (const table of ['turnpoints', 'flight_attempts', 'task_results']) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
    if (cols.some((c) => c.name === 'league_id')) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN league_id`);
    }
  }
}
