-- =============================================================================
-- 0013: Simplify scoring caches
--
-- Drops:
--   - season_standings table (replaced by a live SQL aggregate over
--     task_results joined to non-deleted tasks)
--   - tasks.scores_frozen_at column (the freeze concept is gone; "closed"
--     is now derived from close_date)
--   - flight_attempts.{distance_points, time_points, total_points} columns
--     (vestigial under the new scoring model — task_results is the single
--     source of truth, recomputed from canonical inputs by rebuildTaskResults)
-- =============================================================================

DROP INDEX IF EXISTS idx_standings_season;
DROP INDEX IF EXISTS idx_standings_user;
DROP TABLE IF EXISTS season_standings;

ALTER TABLE tasks            DROP COLUMN scores_frozen_at;
ALTER TABLE flight_attempts  DROP COLUMN distance_points;
ALTER TABLE flight_attempts  DROP COLUMN time_points;
ALTER TABLE flight_attempts  DROP COLUMN total_points;
