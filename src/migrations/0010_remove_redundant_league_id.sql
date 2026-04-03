-- Remove redundant league_id columns from tables where the value is derivable
-- via FK chains. These columns were never used in WHERE clauses.
--
-- The base schema.sql already omits these columns, so on fresh databases
-- the indexes/columns may not exist. DROP INDEX IF EXISTS handles that;
-- the column drops are handled by the migration runner's error tolerance.

DROP INDEX IF EXISTS idx_turnpoints_league;
DROP INDEX IF EXISTS idx_attempts_league;
DROP INDEX IF EXISTS idx_task_results_league;
DROP INDEX IF EXISTS idx_season_standings_league;
