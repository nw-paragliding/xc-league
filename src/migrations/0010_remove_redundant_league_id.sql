-- Remove redundant league_id columns from tables where the value is derivable
-- via FK chains. These columns were never used in WHERE clauses.
--
-- This file only drops the indexes. The actual column drops are handled by
-- dropRedundantLeagueIdColumns() in migration-helpers.ts (called from
-- migrate.ts, server.ts, and test helpers) because SQLite lacks
-- DROP COLUMN IF EXISTS.

DROP INDEX IF EXISTS idx_turnpoints_league;
DROP INDEX IF EXISTS idx_attempts_league;
DROP INDEX IF EXISTS idx_task_results_league;
DROP INDEX IF EXISTS idx_season_standings_league;
