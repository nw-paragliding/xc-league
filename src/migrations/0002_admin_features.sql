-- =============================================================================
-- Migration 0002: Admin Features
-- 
-- Adds:
-- 1. admin_audit_log table for tracking super admin changes
-- 2. left_at column to league_memberships for proper membership lifecycle
-- =============================================================================

-- Admin audit log for super admin actions
CREATE TABLE admin_audit_log (
    id                  TEXT        PRIMARY KEY,  -- UUID
    actor_user_id       TEXT        NOT NULL REFERENCES users (id),  -- who made the change
    target_user_id      TEXT        NOT NULL REFERENCES users (id),  -- who was affected
    action              TEXT        NOT NULL,
                        -- 'PROMOTE_SUPER_ADMIN'
                        -- 'DEMOTE_SUPER_ADMIN'
                        -- 'BOOTSTRAP_SUPER_ADMIN'
    details             TEXT,                     -- optional JSON metadata
    created_at          TEXT        NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_audit_actor  ON admin_audit_log (actor_user_id);
CREATE INDEX idx_admin_audit_target ON admin_audit_log (target_user_id);
CREATE INDEX idx_admin_audit_action ON admin_audit_log (action);

-- Add left_at column to league_memberships for proper lifecycle tracking
-- Members aren't "deleted", they "leave" the league
ALTER TABLE league_memberships ADD COLUMN left_at TEXT;

CREATE INDEX idx_league_memberships_left ON league_memberships (left_at);
