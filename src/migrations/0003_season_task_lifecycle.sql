-- =============================================================================
-- Migration 0003: Season and Task Lifecycle Management
--
-- Adds status tracking for seasons and tasks to support:
-- - Season: draft → open → closed workflow
-- - Task: draft → published workflow
-- - Task import/export metadata
-- =============================================================================

-- Add status column to seasons
-- Values: 'draft' | 'open' | 'closed'
-- draft: admin is still setting up, not visible to pilots
-- open: pilots can register and upload flights
-- closed: no more submissions, all scores frozen
ALTER TABLE seasons ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';

CREATE INDEX idx_seasons_status ON seasons (status) WHERE deleted_at IS NULL;

-- Add status column to tasks
-- Values: 'draft' | 'published'
-- draft: admin is editing/importing, not visible to pilots
-- published: visible to pilots, locked from edits (except freeze)
ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';

CREATE INDEX idx_tasks_status ON tasks (status) WHERE deleted_at IS NULL;

-- Add task data source tracking for imports/exports
-- Stores the format this task was imported from
ALTER TABLE tasks ADD COLUMN task_data_source TEXT;
-- Values: 'manual' | 'xctsk' | 'cup' | null

-- Store original imported file content for re-export
-- This preserves the exact task definition for download
ALTER TABLE tasks ADD COLUMN task_data_raw TEXT;

-- Add left_at column to season_registrations (if not exists from migration 0002)
-- This was added in 0002 for league_memberships, now add for season_registrations
-- ALTER TABLE season_registrations ADD COLUMN left_at TEXT;
-- Note: Check if season_registrations needs this - it's for when pilots leave a season

-- Update existing seasons to 'draft' status (already default, but explicit)
UPDATE seasons SET status = 'draft' WHERE status IS NULL;

-- Update existing tasks to 'published' status if they have turnpoints
-- If a task has turnpoints defined, it was likely published
UPDATE tasks 
SET status = 'published' 
WHERE id IN (
  SELECT DISTINCT task_id FROM turnpoints
);

-- Tasks without turnpoints remain in draft
UPDATE tasks 
SET status = 'draft'
WHERE id NOT IN (
  SELECT DISTINCT task_id FROM turnpoints
);
