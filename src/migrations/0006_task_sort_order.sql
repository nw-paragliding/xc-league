-- Add sort_order to tasks for explicit admin reordering
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Initialize sort_order from existing creation order per season
UPDATE tasks
SET sort_order = (
  SELECT COUNT(*)
  FROM tasks t2
  WHERE t2.season_id = tasks.season_id
    AND t2.deleted_at IS NULL
    AND (t2.created_at < tasks.created_at OR (t2.created_at = tasks.created_at AND t2.id < tasks.id))
)
WHERE deleted_at IS NULL;
