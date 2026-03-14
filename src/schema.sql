-- =============================================================================
-- XC / Hike & Fly League Platform — Database Schema v1.0
-- Engine: SQLite (compatible with PostgreSQL with minor type adjustments)
-- Strategy: Single database, league_id tenant isolation, UUID PKs, soft deletes
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;


-- =============================================================================
-- PLATFORM / AUTH LAYER
-- Global tables — not scoped to a league
-- =============================================================================

-- Users: one account per person, shared across all leagues
CREATE TABLE users (
    id                  TEXT        PRIMARY KEY,  -- UUID
    email               TEXT        NOT NULL UNIQUE,
    display_name        TEXT        NOT NULL,
    avatar_url          TEXT,                     -- synced from OAuth provider on each login
    civl_id             TEXT,                     -- optional, for WPRS linking
    is_super_admin      INTEGER     NOT NULL DEFAULT 0,   -- 1 = platform super-admin
    token_version       INTEGER     NOT NULL DEFAULT 1,   -- increment to invalidate all JWTs for this user
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at          TEXT                                              -- soft delete
);

CREATE INDEX idx_users_email ON users (email) WHERE deleted_at IS NULL;

-- OAuth identities: links a user account to one or more OAuth providers.
-- We do not store OAuth access/refresh tokens — we issue our own long-lived JWT.
CREATE TABLE oauth_identities (
    id                  TEXT        PRIMARY KEY,  -- UUID
    user_id             TEXT        NOT NULL REFERENCES users (id),
    provider            TEXT        NOT NULL,     -- 'google' (others future)
    provider_user_id    TEXT        NOT NULL,     -- provider's stable user ID (Google 'sub')
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),

    UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_oauth_identities_user ON oauth_identities (user_id);


-- =============================================================================
-- LEAGUE (TENANT) LAYER
-- =============================================================================

-- Leagues: each is an independent tenant
CREATE TABLE leagues (
    id                  TEXT        PRIMARY KEY,  -- UUID
    name                TEXT        NOT NULL,
    slug                TEXT        NOT NULL UNIQUE,  -- URL-safe identifier, e.g. 'alps-xc-2026'
    description         TEXT,
    logo_url            TEXT,
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at          TEXT
);

CREATE INDEX idx_leagues_slug ON leagues (slug) WHERE deleted_at IS NULL;

-- League memberships: links users to leagues with a role
CREATE TABLE league_memberships (
    id                  TEXT        PRIMARY KEY,  -- UUID
    league_id           TEXT        NOT NULL REFERENCES leagues (id),
    user_id             TEXT        NOT NULL REFERENCES users (id),
    role                TEXT        NOT NULL DEFAULT 'pilot',
                                    -- 'pilot' | 'admin'
    joined_at           TEXT        NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at          TEXT,

    UNIQUE (league_id, user_id)
);

CREATE INDEX idx_league_memberships_league ON league_memberships (league_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_league_memberships_user   ON league_memberships (user_id)   WHERE deleted_at IS NULL;


-- =============================================================================
-- SEASON LAYER
-- =============================================================================

-- Seasons: one league has many seasons; each season is XC or hike & fly
CREATE TABLE seasons (
    id                      TEXT        PRIMARY KEY,  -- UUID
    league_id               TEXT        NOT NULL REFERENCES leagues (id),
    name                    TEXT        NOT NULL,
    competition_type        TEXT        NOT NULL,  -- 'XC' | 'HIKE_AND_FLY'
    start_date              TEXT        NOT NULL,  -- ISO 8601 date
    end_date                TEXT        NOT NULL,
    -- GAP nominal parameters (used for potential future validity scaling)
    nominal_distance_km     REAL        NOT NULL DEFAULT 70.0,
    nominal_time_s          INTEGER     NOT NULL DEFAULT 5400,   -- 90 minutes
    nominal_goal_ratio      REAL        NOT NULL DEFAULT 0.3,
    created_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at              TEXT
);

CREATE INDEX idx_seasons_league ON seasons (league_id) WHERE deleted_at IS NULL;

-- Season registrations: pilots explicitly register for a season
CREATE TABLE season_registrations (
    id                  TEXT        PRIMARY KEY,  -- UUID
    season_id           TEXT        NOT NULL REFERENCES seasons (id),
    user_id             TEXT        NOT NULL REFERENCES users (id),
    registered_at       TEXT        NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at          TEXT,

    UNIQUE (season_id, user_id)
);

CREATE INDEX idx_season_registrations_season ON season_registrations (season_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_season_registrations_user   ON season_registrations (user_id)   WHERE deleted_at IS NULL;


-- =============================================================================
-- TASK LAYER
-- =============================================================================

-- Tasks: belong to a season; pilots fly these
CREATE TABLE tasks (
    id                      TEXT        PRIMARY KEY,  -- UUID
    season_id               TEXT        NOT NULL REFERENCES seasons (id),
    league_id               TEXT        NOT NULL REFERENCES leagues (id),  -- denormalised for efficient tenant filtering
    name                    TEXT        NOT NULL,
    description             TEXT,
    task_type               TEXT        NOT NULL,  -- 'RACE_TO_GOAL' | 'OPEN_DISTANCE'
    open_date               TEXT        NOT NULL,  -- ISO 8601 datetime; pilots may fly from this point
    close_date              TEXT        NOT NULL,  -- ISO 8601 datetime; scores freeze after this
    optimised_distance_km   REAL,                  -- pre-computed optimal route distance; null until computed
    sss_turnpoint_id        TEXT,                  -- FK set after turnpoints are created; see below
    ess_turnpoint_id        TEXT,                  -- null for hike & fly (ESS = goal)
    goal_turnpoint_id       TEXT,                  -- FK set after turnpoints are created
    scores_frozen_at        TEXT,                  -- set when close_date passes and rescoring is locked
    -- Optimiser outputs: stored so partial distance can be computed without re-optimising
    projection_origin_lat   REAL,                  -- WGS84 lat of the origin used for partial distance projection
    projection_origin_lng   REAL,                  -- WGS84 lng of the origin used for partial distance projection
    created_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at              TEXT
);

CREATE INDEX idx_tasks_season   ON tasks (season_id)  WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_league   ON tasks (league_id)  WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_close    ON tasks (close_date) WHERE deleted_at IS NULL;

-- Turnpoints: ordered waypoints for a task
CREATE TABLE turnpoints (
    id                      TEXT        PRIMARY KEY,  -- UUID
    task_id                 TEXT        NOT NULL REFERENCES tasks (id),
    league_id               TEXT        NOT NULL REFERENCES leagues (id),  -- denormalised
    sequence_index          INTEGER     NOT NULL,  -- 0-based; 0 = SSS
    name                    TEXT        NOT NULL,
    latitude                REAL        NOT NULL,  -- WGS84 decimal degrees
    longitude               REAL        NOT NULL,
    radius_m                REAL        NOT NULL,  -- cylinder radius in metres
    type                    TEXT        NOT NULL,
                            -- 'CYLINDER'          standard air turnpoint (XC and H&F)
                            -- 'GROUND_ONLY'       hike & fly: must be reached on foot
                            -- 'AIR_OR_GROUND'     hike & fly: reachable either way
                            -- 'SSS'               start of speed section
                            -- 'ESS'               end of speed section
                            -- 'GOAL_CYLINDER'     goal as a cylinder
                            -- 'GOAL_LINE'         goal as a line
    goal_line_bearing_deg   REAL,                  -- GOAL_LINE only: bearing perp to optimal inbound track
    created_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at              TEXT,

    UNIQUE (task_id, sequence_index)
);

CREATE INDEX idx_turnpoints_task   ON turnpoints (task_id)   WHERE deleted_at IS NULL;
CREATE INDEX idx_turnpoints_league ON turnpoints (league_id) WHERE deleted_at IS NULL;

-- Deferred FKs: tasks.sss/ess/goal_turnpoint_id reference turnpoints
-- SQLite doesn't support deferred FK cycles cleanly; enforce in application layer


-- =============================================================================
-- SUBMISSION & SCORING LAYER
-- =============================================================================

-- Flight submissions: one per IGC file upload
--
-- IGC files are stored as BLOBs directly in this table.
-- Rationale: club-scale usage (~tens of pilots) generates well under 500MB of
-- IGC data per season. Storing in SQLite avoids a separate object storage
-- service entirely. The Fly.io persistent volume snapshot covers backups.
-- If usage ever outgrows this, igc_data can be migrated to object storage
-- and replaced with an igc_storage_key column in a one-time script.
CREATE TABLE flight_submissions (
    id                  TEXT        PRIMARY KEY,  -- UUID
    task_id             TEXT        NOT NULL REFERENCES tasks (id),
    user_id             TEXT        NOT NULL REFERENCES users (id),
    league_id           TEXT        NOT NULL REFERENCES leagues (id),  -- denormalised
    igc_data            BLOB        NOT NULL,             -- raw IGC file bytes
    igc_filename        TEXT        NOT NULL,             -- original filename, for download
    igc_size_bytes      INTEGER     NOT NULL,             -- byte length of igc_data
    igc_sha256          TEXT        NOT NULL,             -- SHA-256 hex digest — duplicate detection
    igc_date            TEXT,                             -- date parsed from IGC HFDTE record
    submitted_at        TEXT        NOT NULL DEFAULT (datetime('now')),
    status              TEXT        NOT NULL DEFAULT 'PENDING',
                        -- 'PENDING'     queued for processing
                        -- 'PROCESSING'  job running
                        -- 'PROCESSED'   complete; attempts scored
                        -- 'INVALID'     failed validation (bad IGC, wrong date, etc.)
                        -- 'ERROR'       unexpected processing error
    status_message      TEXT,                             -- human-readable detail for INVALID/ERROR
    best_attempt_id     TEXT,                             -- FK to flight_attempts; set after processing
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at          TEXT
);

CREATE INDEX idx_submissions_task   ON flight_submissions (task_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_submissions_user   ON flight_submissions (user_id)          WHERE deleted_at IS NULL;
CREATE INDEX idx_submissions_league ON flight_submissions (league_id)        WHERE deleted_at IS NULL;
CREATE INDEX idx_submissions_status ON flight_submissions (status)           WHERE deleted_at IS NULL;
-- Duplicate detection: same pilot cannot upload the same file content twice for the same task
CREATE UNIQUE INDEX idx_submissions_dedup ON flight_submissions (task_id, user_id, igc_sha256) WHERE deleted_at IS NULL;

-- Flight attempts: one per detected attempt within an IGC file
CREATE TABLE flight_attempts (
    id                          TEXT        PRIMARY KEY,  -- UUID
    submission_id               TEXT        NOT NULL REFERENCES flight_submissions (id),
    task_id                     TEXT        NOT NULL REFERENCES tasks (id),
    user_id                     TEXT        NOT NULL REFERENCES users (id),
    league_id                   TEXT        NOT NULL REFERENCES leagues (id),  -- denormalised

    -- Timing
    sss_crossing_time           TEXT        NOT NULL,   -- interpolated ISO 8601 UTC
    ess_crossing_time           TEXT,                   -- null if ESS not reached
    goal_crossing_time          TEXT,                   -- null if goal not reached
    task_time_s                 INTEGER,                -- ess_crossing_time - sss_crossing_time in seconds; null if no ESS

    -- Achievement
    reached_goal                INTEGER     NOT NULL DEFAULT 0,  -- boolean
    last_turnpoint_index        INTEGER     NOT NULL DEFAULT 0,  -- furthest TP index achieved (0 = only SSS)
    distance_flown_km           REAL        NOT NULL DEFAULT 0,  -- best achieved distance along optimal route

    -- Score components
    distance_points             REAL        NOT NULL DEFAULT 0,  -- fixed at processing time
    time_points                 REAL        NOT NULL DEFAULT 0,  -- recalculated until task closes
    total_points                REAL        NOT NULL DEFAULT 0,  -- distance_points + time_points

    -- Hike & fly ground validation
    has_flagged_crossings       INTEGER     NOT NULL DEFAULT 0,  -- 1 if any GROUND_ONLY TP crossing is unconfirmed

    -- Metadata
    attempt_index               INTEGER     NOT NULL DEFAULT 0,  -- 0-based index within the submission
    scorer_version              TEXT        NOT NULL DEFAULT '1.0',  -- scoring engine version used
    created_at                  TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT        NOT NULL DEFAULT (datetime('now')),
    deleted_at                  TEXT
);

CREATE INDEX idx_attempts_submission ON flight_attempts (submission_id)          WHERE deleted_at IS NULL;
CREATE INDEX idx_attempts_task_user  ON flight_attempts (task_id, user_id)       WHERE deleted_at IS NULL;
CREATE INDEX idx_attempts_task_goal  ON flight_attempts (task_id, reached_goal)  WHERE deleted_at IS NULL;
CREATE INDEX idx_attempts_league     ON flight_attempts (league_id)              WHERE deleted_at IS NULL;

-- Turnpoint crossings: one row per TP successfully crossed in an attempt
CREATE TABLE turnpoint_crossings (
    id                      TEXT        PRIMARY KEY,  -- UUID
    attempt_id              TEXT        NOT NULL REFERENCES flight_attempts (id),
    turnpoint_id            TEXT        NOT NULL REFERENCES turnpoints (id),
    sequence_index          INTEGER     NOT NULL,     -- denormalised from turnpoint for query convenience
    crossing_time           TEXT        NOT NULL,     -- interpolated ISO 8601 UTC
    -- Ground validation (hike & fly only)
    ground_check_required   INTEGER     NOT NULL DEFAULT 0,   -- 1 for GROUND_ONLY TPs
    ground_confirmed        INTEGER     NOT NULL DEFAULT 0,   -- 1 if speed check passed
    detected_max_speed_kmh  REAL,                             -- max speed detected near crossing
    override_id             TEXT,                             -- FK to turnpoint_overrides if overridden
    created_at              TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT        NOT NULL DEFAULT (datetime('now')),

    UNIQUE (attempt_id, turnpoint_id)
);

CREATE INDEX idx_crossings_attempt    ON turnpoint_crossings (attempt_id);
CREATE INDEX idx_crossings_turnpoint  ON turnpoint_crossings (turnpoint_id);

-- Turnpoint overrides: pilot self-declarations for flagged ground crossings
CREATE TABLE turnpoint_overrides (
    id                      TEXT        PRIMARY KEY,  -- UUID
    crossing_id             TEXT        NOT NULL REFERENCES turnpoint_crossings (id),
    attempt_id              TEXT        NOT NULL REFERENCES flight_attempts (id),
    turnpoint_id            TEXT        NOT NULL REFERENCES turnpoints (id),
    user_id                 TEXT        NOT NULL REFERENCES users (id),  -- pilot who declared
    declared_at             TEXT        NOT NULL DEFAULT (datetime('now')),
    reason                  TEXT        NOT NULL,       -- pilot's free-text explanation
    detected_max_speed_kmh  REAL,                       -- snapshot of detected speed at time of override
    crossing_time           TEXT        NOT NULL,       -- snapshot of crossing time at time of override
    created_at              TEXT        NOT NULL DEFAULT (datetime('now'))
    -- No updated_at or deleted_at — overrides are immutable audit records
);

CREATE INDEX idx_overrides_attempt    ON turnpoint_overrides (attempt_id);
CREATE INDEX idx_overrides_user       ON turnpoint_overrides (user_id);
CREATE INDEX idx_overrides_crossing   ON turnpoint_overrides (crossing_id);


-- =============================================================================
-- SEASON STANDINGS (MATERIALISED CACHE)
-- Recomputed whenever a task's scores change
-- =============================================================================

CREATE TABLE season_standings (
    id                  TEXT        PRIMARY KEY,  -- UUID
    season_id           TEXT        NOT NULL REFERENCES seasons (id),
    user_id             TEXT        NOT NULL REFERENCES users (id),
    league_id           TEXT        NOT NULL REFERENCES leagues (id),
    total_points        REAL        NOT NULL DEFAULT 0,
    tasks_flown         INTEGER     NOT NULL DEFAULT 0,
    tasks_with_goal     INTEGER     NOT NULL DEFAULT 0,
    rank                INTEGER,                    -- recomputed on each rescore
    last_computed_at    TEXT        NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),

    UNIQUE (season_id, user_id)
);

CREATE INDEX idx_standings_season ON season_standings (season_id, rank);
CREATE INDEX idx_standings_user   ON season_standings (user_id);


-- =============================================================================
-- TASK RESULTS (MATERIALISED CACHE)
-- Best attempt per pilot per task — the public-facing result
-- Recomputed after every rescore
-- =============================================================================

CREATE TABLE task_results (
    id                  TEXT        PRIMARY KEY,  -- UUID
    task_id             TEXT        NOT NULL REFERENCES tasks (id),
    user_id             TEXT        NOT NULL REFERENCES users (id),
    league_id           TEXT        NOT NULL REFERENCES leagues (id),
    best_attempt_id     TEXT        NOT NULL REFERENCES flight_attempts (id),
    distance_flown_km   REAL        NOT NULL DEFAULT 0,
    reached_goal        INTEGER     NOT NULL DEFAULT 0,
    task_time_s         INTEGER,
    distance_points     REAL        NOT NULL DEFAULT 0,
    time_points         REAL        NOT NULL DEFAULT 0,
    total_points        REAL        NOT NULL DEFAULT 0,
    has_flagged_crossings INTEGER   NOT NULL DEFAULT 0,
    rank                INTEGER,
    last_computed_at    TEXT        NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now')),

    UNIQUE (task_id, user_id)
);

CREATE INDEX idx_task_results_task   ON task_results (task_id, rank);
CREATE INDEX idx_task_results_user   ON task_results (user_id);
CREATE INDEX idx_task_results_league ON task_results (league_id);


-- =============================================================================
-- JOB QUEUE
-- Lightweight queue for IGC processing and rescoring jobs
-- Avoids external Redis dependency while on SQLite
-- =============================================================================

CREATE TABLE jobs (
    id                  TEXT        PRIMARY KEY,  -- UUID
    type                TEXT        NOT NULL,
                        -- 'PROCESS_SUBMISSION'   parse IGC, score attempts
                        -- 'RESCORE_TASK'         recalculate time points for all attempts
                        -- 'FREEZE_TASK_SCORES'   lock scores at close_date
                        -- 'REBUILD_STANDINGS'    recompute season_standings
    payload             TEXT        NOT NULL,     -- JSON blob
    status              TEXT        NOT NULL DEFAULT 'PENDING',
                        -- 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED'
    attempts            INTEGER     NOT NULL DEFAULT 0,
    max_attempts        INTEGER     NOT NULL DEFAULT 3,
    last_error          TEXT,
    scheduled_at        TEXT        NOT NULL DEFAULT (datetime('now')),
    started_at          TEXT,
    completed_at        TEXT,
    created_at          TEXT        NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT        NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_status    ON jobs (status, scheduled_at) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX idx_jobs_type      ON jobs (type);


-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================

CREATE TABLE notifications (
    id                  TEXT        PRIMARY KEY,  -- UUID
    user_id             TEXT        NOT NULL REFERENCES users (id),
    type                TEXT        NOT NULL,
                        -- 'SUBMISSION_PROCESSED'
                        -- 'SCORE_UPDATED'
                        -- 'GROUND_CROSSING_FLAGGED'
    payload             TEXT        NOT NULL,     -- JSON: task name, old/new score, etc.
    read_at             TEXT,
    created_at          TEXT        NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notifications_user ON notifications (user_id, read_at);
