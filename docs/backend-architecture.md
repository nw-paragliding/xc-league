# XC League — Backend Architecture

## Contents

1. [Overview](#1-overview)
2. [Repository Layout](#2-repository-layout)
3. [Module Reference](#3-module-reference)
4. [Database Schema](#4-database-schema)
5. [Request Lifecycle](#5-request-lifecycle)
6. [Auth and Authorisation](#6-auth-and-authorisation)
7. [IGC Processing Pipeline](#7-igc-processing-pipeline)
8. [Job Queue and Background Workers](#8-job-queue-and-background-workers)
9. [Task Import and Export](#9-task-import-and-export)
10. [Key Design Decisions](#10-key-design-decisions)
11. [Configuration and Environment](#11-configuration-and-environment)
12. [Scripts and Dependencies](#12-scripts-and-dependencies)

---

## 1. Overview

The backend is a **monolithic single-process Node.js application** that combines an HTTP API server and a background job worker. There is no separate worker process, message broker, or external database server — everything lives in one Node process talking to one SQLite file on disk.

```
┌──────────────────────────────────────────────────────────────┐
│  Node.js process                                             │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Fastify API │    │  SQLiteJobQueue + JobWorker       │   │
│  │              │───▶│  (same event loop, one job at a   │   │
│  │  /api/v1/*   │    │   time, woken by EventEmitter)    │   │
│  └──────┬───────┘    └──────────────────────────────────┘   │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐   │
│  │  better-sqlite3 (synchronous, WAL mode)              │   │
│  │  league.db — single SQLite file on persistent volume │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Stack at a glance:**

| Layer | Choice | Rationale |
|---|---|---|
| HTTP framework | Fastify v4 | Plugin encapsulation, decorator system, async-first hooks, fast JSON serialisation |
| Database | SQLite (better-sqlite3) in WAL mode | Zero external dependencies; club-scale data volumes; synchronous driver simplifies control flow |
| Auth | Google OAuth 2.0 → RS256 JWT in HttpOnly cookie | Delegates identity to Google; asymmetric key allows safe public-key sharing |
| Language | TypeScript (strict), CommonJS output | Backend compiled to CJS for Node compatibility; frontend uses ESNext/Vite |
| Deployment | Fly.io + Docker + persistent volume | SQLite file persisted across deploys on a mounted volume |

In production, Fastify also serves the Vite-built frontend from `dist/client/` and routes all non-API GETs to `index.html` (SPA fallback).

---

## 2. Repository Layout

```
/
├── src/                        # Backend TypeScript source
│   ├── server.ts               # Entry point — plugin registration, startup
│   ├── auth.ts                 # JWT, OAuth flow, request decoration, auth guards
│   ├── pipeline.ts             # IGC processing pipeline (pure functions)
│   ├── job-queue.ts            # SQLite-backed job queue + worker
│   ├── upload.ts               # IGC upload and download handlers
│   ├── track-replay.ts         # Track replay endpoint
│   ├── task-parsers.ts         # .xctsk and .cup file parsers
│   ├── task-exporters.ts       # .xctsk, .cup exporters + QR deep-link builder
│   ├── migrate.ts              # Migration runner (standalone process)
│   ├── schema.sql              # Base database schema (applied once by migration 0001)
│   ├── api-spec.ts             # Inline API specification comments
│   ├── optimiser.ts            # Route optimisation utilities
│   ├── migrations/             # Numbered SQL migration files (0002, 0003, ...)
│   └── routes/
│       ├── auth.ts             # Fastify route wiring for auth endpoints
│       ├── admin.ts            # Super-admin endpoints
│       └── leagues.ts          # All league / season / task / submission endpoints
├── frontend/                   # React + Vite frontend (separate tsconfig)
├── dist/                       # Compiled output (gitignored)
│   ├── server.js               # Built backend entry point
│   └── client/                 # Vite frontend build
├── package.json                # Backend deps + workspace scripts
└── tsconfig.server.json        # Backend TypeScript configuration
```

---

## 3. Module Reference

### `src/server.ts` — Entry Point

Responsible for wiring everything together and starting the HTTP listener.

**Startup sequence:**

1. `import 'dotenv/config'` — must be the first import; loads `.env`
2. Open SQLite with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`
3. `loadAuthConfig()` — reads all required env vars, crashes fast with a clear message if any are missing
4. Instantiate `SQLiteJobQueue`; `bootstrapWorker()` is commented out until `TaskRepository` is implemented
5. Register Fastify plugins in order:
   - `@fastify/cookie` — required for the auth cookie
   - `@fastify/multipart` — 5 MB file limit, 1 file per request
   - `@fastify/cors` — credentials-enabled in development; disabled in production (same-origin)
   - `authPlugin` — JWT decode + `request.user` decoration on every request
6. In production: register `@fastify/static` serving `dist/client/`; `setNotFoundHandler` sends `index.html` for non-API GETs
7. Dynamically import and register route modules under `/api/v1`: auth, admin, leagues
8. Register `SIGTERM` / `SIGINT` graceful shutdown handlers
9. Listen on `0.0.0.0:PORT`

**Key constants:**

```typescript
MAX_IGC_SIZE_BYTES = 5 * 1024 * 1024   // enforced in multipart plugin AND upload handler
STATIC_DIR         = '../client'        // production; '../public' in dev (effectively a no-op)
```

---

### `src/auth.ts` — Auth, JWT, and Request Guards

The largest and most cross-cutting module. It covers four responsibilities:

**1. Configuration loading**

`loadAuthConfig()` reads 7+ required environment variables. Any missing variable causes an immediate crash with a descriptive error — no silent misconfiguration.

**2. JWT utilities**

```
Algorithm:  RS256 (asymmetric — public key can be shared safely)
Expiry:     7 days
Library:    jose
Claims:     sub, email, displayName, isAdmin, tokenVersion
```

- `signJwt(claims, config)` — signs a JWT with the private key
- `verifyJwt(token, config)` — returns `JwtClaims | null` (never throws); validates issuer and required claims

**3. OAuth 2.0 — Google**

`generateOAuthState` / `verifyOAuthState` use HMAC-SHA256 over a `nonce.timestamp` string with a 10-minute expiry window. The signed state travels as an HttpOnly cookie and as a query parameter through Google's redirect, preventing CSRF.

`findOrCreateGoogleUser` handles three cases atomically (single SQLite transaction):
- Returning user: sync name/avatar, return existing user
- New Google identity linked to existing email: insert `oauth_identities` row
- Brand new user: insert `users` row + `oauth_identities` row

**4. Token revocation**

Every user row has a `token_version` integer. On every authenticated request, `authPlugin` does one DB read to compare the JWT's `tokenVersion` claim against the row. Incrementing the column immediately invalidates all outstanding tokens for that user — no blocklist table needed.

**5. Fastify plugin (`authPlugin`)**

Registered as a `preHandler` hook on every request using `fastify-plugin` (prevents encapsulation so `request.user` is visible to all child scopes). Does **not** reject unauthenticated requests — that is delegated to per-route guard functions.

**6. League resolution hook (`makeResolveLeagueHook`)**

A factory returning a `preHandler` hook for league-scoped routes. Populates `request.league` (from `:leagueSlug`) and, if authenticated, `request.membership`. Returns 404 if the league does not exist.

**7. Authorization guards**

Called by route handlers, not as middleware:

| Guard | Requirement | Response on failure |
|---|---|---|
| `requireAuth` | Any authenticated user | 401 |
| `requireSuperAdmin` | `user.isAdmin === true` | 401 / 403 |
| `requireLeagueMember` | `request.membership != null` | 403 |
| `requireLeagueAdmin` | `membership.role === 'admin'` (or super-admin) | 403 |

---

### `src/pipeline.ts` — IGC Processing Pipeline

A purely functional, staged pipeline. Every stage returns `Result<T, E>` and never throws. No database access occurs inside the pipeline — all inputs are passed in by the caller.

See [Section 7](#7-igc-processing-pipeline) for full stage-by-stage documentation.

---

### `src/job-queue.ts` — Background Job Queue

A SQLite-backed job queue with an EventEmitter-woken worker running in the same process.

See [Section 8](#8-job-queue-and-background-workers) for full documentation.

---

### `src/upload.ts` — IGC Upload Handler

Handles `POST .../tasks/:taskId/submissions` and `GET .../submissions/:submissionId/igc`.

**Upload flow (synchronous scoring):**

1. `requireAuth` + `requireLeagueMember`
2. Resolve task; validate `status === 'OPEN'`
3. Parse multipart — validate `.igc` extension, 5 MB limit, IGC `A` magic byte
4. SHA-256 duplicate detection (unique index on `task_id, user_id, igc_sha256`)
5. Load turnpoints from DB; require at least 2
6. Call `runPipeline` inline — result delivered in the HTTP response (design decision: synchronous scoring)
7. On pipeline failure: 422 with human-readable error via `formatPipelineError`
8. On success: atomic transaction inserting into `flight_submissions` + `turnpoint_crossings`
9. If `reachedGoal`: enqueue `RESCORE_TASK` (time points are provisional)
10. Return 201 with scored submission + `provisional: true` flag

**Download handler (`handleIgcDownload`):**

Serves raw IGC BLOB. Access control:
- Own submission: always accessible
- Other pilot's file: hidden (403) until `scores_frozen_at` is set
- Frozen files: `Cache-Control: public, max-age=86400`

---

### `src/track-replay.ts` — Track Replay

Handles `GET .../submissions/:submissionId/track`.

**Design decision:** GPS fixes are **not stored** in the database. They are re-parsed from the raw IGC BLOB on every request (~10–30 ms). Storing ~10,000 fixes per submission at club scale (e.g. 200 submissions) would add ~50 MB of rarely-accessed data to SQLite. Turnpoint crossing events (computed at submission time) are loaded from the DB and overlaid on the re-parsed fixes.

**Access control:** Own submission or league admin always has access. Other pilots' tracks are hidden (403) until `scores_frozen_at` — prevents live-tracking competitors during an open task.

**Response shape:** `{ submissionId, taskId, pilotId, pilotName, flightDate, fixes[], crossings[], bounds, meta }` — fixes are compact `{ t, lat, lng, alt }` tuples; `bounds` is a pre-computed bounding box with 5% padding.

---

### `src/migrate.ts` — Migration Runner

Standalone process (`node dist/migrate.js`) run before server start.

- Creates a `migrations` table on first run
- Applies `0001_initial_schema` (runs `schema.sql`) once ever
- Scans and applies all `src/migrations/*.sql` files in lexicographic order, skipping already-applied ones — safe to re-run on every deploy
- If `BOOTSTRAP_SUPER_ADMIN_EMAIL` is set and no super-admins exist, promotes that user and writes to `admin_audit_log`

---

### `src/routes/auth.ts` — Auth Route Wiring

Thin adapter. Imports handler functions from `../auth` and registers them under `/api/v1`:

| Method | Path | Handler |
|---|---|---|
| GET | `/auth/oauth/google` | Initiate OAuth — redirect to Google |
| GET | `/auth/oauth/google/callback` | Handle callback — issue JWT cookie |
| GET | `/auth/me` | Return current user profile |
| PATCH | `/auth/me` | Update display name / avatar |
| POST | `/auth/logout` | Clear cookie |
| POST | `/auth/revoke` | Increment `token_version` — invalidates all tokens |

---

### `src/routes/admin.ts` — Super-Admin Routes

All endpoints guarded by `requireSuperAdmin`. All write actions append to `admin_audit_log`.

| Method | Path | Action |
|---|---|---|
| GET | `/admin/users` | List all users |
| POST | `/admin/users/:userId/promote` | Promote to super-admin |
| POST | `/admin/users/:userId/demote` | Demote (guard: cannot demote the last admin) |
| GET | `/admin/audit-log` | Paginated audit log |

---

### `src/routes/leagues.ts` — League, Season, Task, and Submission Routes

The largest route file (~1,500 lines). All league-scoped routes run inside a Fastify sub-scope registered with the `makeResolveLeagueHook` preHandler.

**Public (no auth required):**

| Method | Path |
|---|---|
| GET | `/leagues` |
| GET | `/leagues/:leagueSlug` |
| GET | `/leagues/:leagueSlug/seasons` |
| GET | `/leagues/:leagueSlug/seasons/:seasonId/tasks` |
| GET | `/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId` |
| GET | `/leagues/:leagueSlug/seasons/:seasonId/standings` |
| GET | `/leagues/:leagueSlug/seasons/:seasonId/registration` |

**Auth required (any user):**

| Method | Path |
|---|---|
| POST | `/leagues` — create league (creator becomes first admin) |
| POST | `/leagues/:leagueSlug/join` |
| POST | `/leagues/:leagueSlug/seasons/:seasonId/register` |

**League member required:**

| Method | Path |
|---|---|
| GET | `/leagues/:leagueSlug/members` |
| GET | `.../tasks/:taskId/download?format=xctsk\|cup` |
| GET | `.../tasks/:taskId/qr?app=xctrack\|download&format=xctsk\|cup` |

**League admin required:**

| Method | Path |
|---|---|
| PUT | `/leagues/:leagueSlug` — update name/slug/description/logo |
| POST/DELETE | `.../members/:userId/promote\|demote\|remove` |
| POST/PUT/DELETE | `.../seasons` — full CRUD |
| POST | `.../seasons/:seasonId/open\|close` — lifecycle transitions |
| GET | `.../seasons/:seasonId/registrations` |
| POST/PUT/DELETE | `.../seasons/:seasonId/tasks` — full CRUD |
| POST | `.../tasks/import` — import from `.xctsk` or `.cup` (multipart) |
| POST | `.../tasks/:taskId/publish\|unpublish\|freeze` |

**Season lifecycle rules enforced by endpoints:**

```
draft ──open──▶ open ──close──▶ closed
                                  (closing auto-freezes all unfrozen tasks in one transaction)
Cannot reopen a closed season.
```

**Task lifecycle rules:**

```
draft ──publish──▶ published  (requires at least one turnpoint)
published ──unpublish──▶ draft  (blocked if any submissions exist)
published ──freeze──▶ published + scores_frozen_at set  (cannot unfreeze)
```

---

## 4. Database Schema

SQLite with WAL mode. UUID text primary keys throughout. Soft deletes via `deleted_at TEXT`. All timestamps stored as ISO 8601 text.

### Entity Relationship Overview

```
users ──────────────────────────────────────────────────────────────┐
  │ 1:N oauth_identities                                            │
  │                                                                 │
  ├── N:M leagues  (via league_memberships)                         │
  │                                                                 │
leagues ─────────────────────────────────────────────────────────── │
  │ 1:N seasons                                                     │
  │       │ 1:N season_registrations ◀──────────────── users        │
  │       │ 1:N tasks                                               │
  │              │ 1:N turnpoints (SSS, ESS, goal, cylinders)       │
  │              │ 1:N flight_submissions ◀──────────── users        │
  │                      │ 1:N flight_attempts                      │
  │                              │ 1:N turnpoint_crossings          │
  │                                      │ 1:N turnpoint_overrides  │
  │ 1:N season_standings ◀────────────────────────────── users      │
  │ 1:N task_results ◀────────────────────────────────── users      │
  │                                                                 │
jobs (queue)                                                        │
notifications ◀──────────────────────────────────────── users ──────┘
migrations
admin_audit_log
```

### Table Reference

#### Platform / Auth

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `email` (unique), `display_name`, `avatar_url`, `civl_id`, `is_super_admin`, `token_version` | `token_version` enables immediate JWT revocation |
| `oauth_identities` | `user_id`, `provider`, `provider_user_id` (unique pair) | No OAuth tokens stored; platform issues its own JWTs |

#### League (Tenant)

| Table | Key columns | Notes |
|---|---|---|
| `leagues` | `id`, `slug` (unique), `name`, `description`, `logo_url` | `slug` is the URL identifier |
| `league_memberships` | `league_id`, `user_id`, `role` (`pilot`\|`admin`), `left_at` | Unique on `(league_id, user_id)` |

#### Season

| Table | Key columns | Notes |
|---|---|---|
| `seasons` | `id`, `league_id`, `name`, `competition_type` (`XC`\|`HIKE_AND_FLY`), `start_date`, `end_date`, `status` (`draft`\|`open`\|`closed`), GAP nominal params | GAP params: `nominal_distance_km`, `nominal_time_s`, `nominal_goal_ratio` |
| `season_registrations` | `season_id`, `user_id`, `registered_at` | Unique on `(season_id, user_id)`; pilots must register before uploading |

#### Task

| Table | Key columns | Notes |
|---|---|---|
| `tasks` | `id`, `season_id`, `league_id` (denormalised), `name`, `task_type`, `open_date`, `close_date`, `scores_frozen_at`, `status` (`draft`\|`published`), `sss_turnpoint_id`, `ess_turnpoint_id`, `goal_turnpoint_id`, `optimised_distance_km`, `task_data_source`, `task_data_raw` | FK cycle on SSS/ESS/goal IDs enforced in application layer (SQLite deferred FK limitation) |
| `turnpoints` | `task_id`, `league_id` (denormalised), `sequence_index`, `name`, `latitude`, `longitude`, `radius_m`, `type`, `goal_line_bearing_deg` | `type` values: `CYLINDER`, `GROUND_ONLY`, `AIR_OR_GROUND`, `SSS`, `ESS`, `GOAL_CYLINDER`, `GOAL_LINE`; unique on `(task_id, sequence_index)` |

#### Submission / Scoring

| Table | Key columns | Notes |
|---|---|---|
| `flight_submissions` | `id`, `task_id`, `user_id`, `status`, `igc_data` (BLOB), `igc_filename`, `igc_size_bytes`, `igc_sha256`, `best_attempt_id` | BLOB storage chosen over object store; `igc_sha256` enables duplicate detection; unique partial index on `(task_id, user_id, igc_sha256)` |
| `flight_attempts` | `submission_id`, `sss_crossing_time`, `ess_crossing_time`, `goal_crossing_time`, `task_time_s`, `reached_goal`, `last_turnpoint_index`, `distance_flown_km`, `distance_points`, `time_points`, `total_points`, `has_flagged_crossings` | One row per detected start attempt within a submission |
| `turnpoint_crossings` | `attempt_id`, `turnpoint_id`, `sequence_index` (denormalised), `crossing_time`, `ground_check_required`, `ground_confirmed`, `detected_max_speed_kmh`, `override_id` | Unique on `(attempt_id, turnpoint_id)` |
| `turnpoint_overrides` | `crossing_id`, `attempt_id`, `turnpoint_id`, `user_id`, `override_type`, `notes` | Immutable audit record; no `deleted_at` |

#### Materialised Caches

| Table | Key columns | Notes |
|---|---|---|
| `season_standings` | `season_id`, `user_id`, `total_points`, `tasks_completed`, `rank` | Upserted by `REBUILD_STANDINGS` job; primary key `(season_id, user_id)` |
| `task_results` | `task_id`, `user_id`, `total_points`, `distance_points`, `time_points`, `rank`, `best_attempt_id` | Upserted by `RESCORE_TASK` job |

#### Infrastructure

| Table | Key columns | Notes |
|---|---|---|
| `jobs` | `type`, `payload` (JSON), `status`, `scheduled_at`, `attempts`, `max_attempts`, `last_error` | Partial index on `(status)` for `PENDING`/`FAILED` only |
| `notifications` | `user_id`, `type`, `payload` (JSON), `read_at` | Fan-out from scoring jobs |
| `migrations` | `name`, `applied_at` | Migration tracking; prevents re-application |
| `admin_audit_log` | `actor_user_id`, `target_user_id`, `action`, `details` | Immutable; written by admin endpoints and `migrate.ts` bootstrap |

### Key Indexes

```sql
-- Partial indexes keep size small (only non-deleted rows)
idx_submissions_task    ON flight_submissions (task_id)   WHERE deleted_at IS NULL
idx_submissions_user    ON flight_submissions (user_id)   WHERE deleted_at IS NULL
idx_submissions_dedup   ON flight_submissions (task_id, user_id, igc_sha256) UNIQUE WHERE deleted_at IS NULL
idx_turnpoints_task     ON turnpoints (task_id)           WHERE deleted_at IS NULL
idx_jobs_status         ON jobs (status, scheduled_at)    WHERE status IN ('PENDING', 'FAILED')
idx_standings_season    ON season_standings (season_id, total_points DESC)
idx_task_results_task   ON task_results (task_id, total_points DESC)
```

---

## 5. Request Lifecycle

### Standard API Request

```
HTTP request
  → @fastify/cookie         parse cookies
  → @fastify/cors           set CORS headers (dev only)
  → authPlugin preHandler
      extractToken (cookie takes precedence over Authorization: Bearer)
      verifyJwt (jose RS256 verification)
      DB read: compare token_version claim vs users.token_version
      request.user = JwtClaims | null
  → makeResolveLeagueHook preHandler  (league-scoped routes only)
      DB read: SELECT * FROM leagues WHERE slug = :leagueSlug
      request.league = LeagueRecord | null  (404 if missing)
      if request.user:
        DB read: SELECT * FROM league_memberships WHERE league_id = ? AND user_id = ?
        request.membership = MembershipRecord | null
  → Route handler
      requireAuth / requireLeagueMember / requireLeagueAdmin  (guard call)
      Business logic (prepared statement queries)
      reply.send(payload)
  → JSON serialisation and response
```

### IGC Upload Lifecycle

```
POST .../tasks/:taskId/submissions
  → requireAuth + requireLeagueMember
  → SELECT task (validate status = 'OPEN')
  → Parse multipart: extension check, 5 MB limit, 'A' magic byte check
  → Compute SHA-256 → check uniqueness (duplicate detection)
  → SELECT turnpoints (require >= 2)
  → runPipeline(igcText, taskDefinition)   ← synchronous inline call
      Stage 1: parseAndValidate
      Stage 2: validateFlightDate
      Stage 3: detectAttempts
      Stage 4: classifyGroundState  (H&F only)
      Stage 5: calculateDistances
      Stage 6: scoreAttempts
      Stage 7: selectBestAttempt
  → pipeline failure → 422 { error: human-readable message }
  → transaction:
      INSERT flight_submissions (status='PROCESSED', igc_data BLOB, scores)
      INSERT turnpoint_crossings (per crossing)
      UPDATE flight_submissions SET best_attempt_id = ?
  → if reachedGoal: queue.enqueue('RESCORE_TASK')
  → 201 { submission, provisional: reachedGoal }
```

### Background Job Lifecycle

```
queue.enqueue(type, payload)
  → INSERT INTO jobs (status='PENDING', ...)
  → emit('job:enqueued')                      ← wakes worker immediately

worker.processNext()
  → UPDATE jobs SET status='RUNNING'
    WHERE status='PENDING' AND scheduled_at <= now()
    ORDER BY created_at LIMIT 1              ← atomic claim
  → handler(payload, jobId)
  → success: UPDATE status='COMPLETE'
  → error:
      if attempts < maxAttempts:
        UPDATE status='PENDING', scheduled_at=now+backoff  (30s / 5min / 30min)
      else:
        UPDATE status='FAILED', last_error=message
  → setTimeout(processNext, 0)               ← drain remaining pending jobs

(30s polling interval as fallback for restart recovery)
```

---

## 6. Auth and Authorisation

### OAuth Flow

```
1. GET /api/v1/auth/oauth/google
   → HMAC-SHA256 state = sign(nonce + '.' + timestamp)
   → Set-Cookie: oauth_state=<state>  (HttpOnly, 10 min)
   → 302 → Google consent URL

2. GET /api/v1/auth/oauth/google/callback?code=X&state=Y
   → Verify: query state == cookie state, HMAC valid, < 10 min old
   → POST to Google token endpoint → access token
   → GET https://www.googleapis.com/oauth2/v3/userinfo
   → findOrCreateGoogleUser (atomic transaction):
       lookup by (provider='google', provider_user_id)
       if new: INSERT users + INSERT oauth_identities
               or match existing email + INSERT oauth_identities
   → signJwt (RS256, 7d, claims: sub/email/displayName/isAdmin/tokenVersion)
   → Set-Cookie: xcleague_jwt=<jwt>  (HttpOnly, secure in prod, sameSite=lax, 7d)
   → Browser: 302 /?auth=success
   → API: 200 { token, user }
```

### Token Revocation

Logout clears the cookie but the JWT remains cryptographically valid until its 7-day expiry. To immediately invalidate all tokens (e.g. after a security event), `POST /auth/revoke` increments `users.token_version`. The `authPlugin` checks this on every request — any token carrying an older `tokenVersion` claim is rejected as 401.

### Authorization Tiers

```
super-admin  →  can do everything including /admin/* endpoints
  ↓
league-admin →  can manage their league(s): settings, seasons, tasks, members
  ↓
league-member → can download task files, view own submissions, pilot endpoints
  ↓
authenticated → can create leagues, join leagues, register for seasons, upload flights
  ↓
public        → can read leaderboards, standings, task details, season lists
```

---

## 7. IGC Processing Pipeline

All stages are pure functions returning `Result<T, E>` — no side effects, no database access. The pipeline receives its entire context as input and returns a scored result (or a typed error) to the caller in `upload.ts`.

```
parseAndValidate
     │  ParsedTrack
     ▼
validateFlightDate
     │  ParsedTrack (pass-through if valid)
     ▼
detectAttempts  ◀── geometry engine (segmentIntersectsCircle, etc.)
     │  AttemptTrace[]
     ▼
classifyGroundState  (no-op for XC; speed-window analysis for H&F)
     │  AttemptTrace[] (with groundConfirmed set for H&F TPs)
     ▼
calculateDistances
     │  AttemptTrace[] (with distanceFlownKm per attempt)
     ▼
scoreAttempts  (GAP distance + time formula)
     │  ScoredAttempt[]
     ▼
selectBestAttempt  (goal > points > task time)
     │  index into ScoredAttempt[]
     ▼
runPipeline result
```

### Stage Details

| Stage | Key logic | Failure codes |
|---|---|---|
| `parseAndValidate` | `igc-parser` in lenient mode; filter valid B-records; monotonicity check; derive per-fix speed from position delta; midnight rollover | `MISSING_DATE_HEADER`, `NO_VALID_FIXES`, `NON_MONOTONIC_TIME`, `INSUFFICIENT_DURATION`, `PARSE_FAILURE` |
| `validateFlightDate` | Flight date within `open_date` / `close_date`; task not yet frozen | `FLIGHT_DATE_OUTSIDE_TASK_WINDOW`, `TASK_SCORES_FROZEN` |
| `detectAttempts` | Quadratic formula (parameterised segment-circle intersection); linear time interpolation at parameter `t`; goal line via segment-segment intersection; multiple SSS crossings → multiple attempts | `NO_SSS_CROSSING` |
| `classifyGroundState` | 30s sustained speed window classifies each fix `GROUND` / `AIRBORNE` / `UNKNOWN`; 60s window around `GROUND_ONLY` crossing stores `detectedMaxSpeedKmh` | (no error — informational only) |
| `calculateDistances` | Vincenty geodesic (`geographiclib-geodesic`) for point-to-point legs; goal pilots get full `optimisedDistanceKm`; partial pilots get cumulative distance + closest approach to next TP | — |
| `scoreAttempts` | **Distance:** `938 * sqrt(d_pilot / d_best)` (or 938 for goal). **Time:** `938 * (1 - ((t_pilot - t_min) / (t_max - t_min))^(2/3))` — provisional until task closes | — |
| `selectBestAttempt` | Priority: (1) reached goal, (2) highest total points, (3) lowest task time | — |

**Rescoring:** When a new goal pilot is detected, `RESCORE_TASK` job calls `rescoreTimePoints` — the same GAP formula applied across all known goal times for that task. `task_results` and `season_standings` are updated atomically via follow-up jobs.

---

## 8. Job Queue and Background Workers

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  SQLiteJobQueue                                             │
│  queue.enqueue(type, payload, scheduledAt?)                 │
│    → INSERT INTO jobs                                       │
│    → emit('job:enqueued')   ─────────────────────────┐      │
└─────────────────────────────────────────────────────┐ │      │
                                                      │ │      │
┌─────────────────────────────────────────────────────▼─▼─────┤
│  JobWorker                                                   │
│                                                             │
│  EventEmitter wake  ──▶  processNext()                      │
│  30s poll fallback  ──▶  processNext()                      │
│                                                             │
│  claimNextJob():                                            │
│    UPDATE jobs SET status='RUNNING'                         │
│    WHERE status='PENDING' AND scheduled_at <= now()         │
│    LIMIT 1                                 ◀── atomic claim │
│                                                             │
│  handler(payload) → completeJob()                           │
│                   → retryJob() or failJob()                 │
└─────────────────────────────────────────────────────────────┘
```

**Design constraints:** SQLite allows only one writer at a time. Having a separate worker process would require SQLite's WAL mode plus careful retry logic. The single-process design avoids this entirely — the API and worker share the same connection, no locking contention is possible.

### Job Types

| Type | Trigger | Action |
|---|---|---|
| `RESCORE_TASK` | New goal submission; task freeze | Recalculate time points for all goal attempts; upsert `task_results`; enqueue `REBUILD_STANDINGS` and optionally `NOTIFY_PILOTS` |
| `FREEZE_TASK_SCORES` | Task creation (scheduled at `close_date`) | Set `scores_frozen_at`; enqueue final `RESCORE_TASK` |
| `REBUILD_STANDINGS` | After any rescore | Aggregate `task_results` into `season_standings` with ranking |
| `REPROCESS_ALL_SUBMISSIONS` | Admin edits turnpoints | Re-run full pipeline per submission sequentially; errors on individual submissions are caught and logged |
| `NOTIFY_PILOTS` | After rescore with score changes | Bulk insert `notifications` rows for affected pilots |

### Job Dependency Graph

```
New goal submission ──▶ RESCORE_TASK ──▶ REBUILD_STANDINGS
                                     └──▶ NOTIFY_PILOTS

Task created ──▶ FREEZE_TASK_SCORES (at close_date) ──▶ RESCORE_TASK (final)

Admin edits TPs ──▶ REPROCESS_ALL_SUBMISSIONS ──▶ RESCORE_TASK ──▶ ...
```

### Retry Policy

| Attempt | Delay before retry |
|---|---|
| 1st failure | 30 seconds |
| 2nd failure | 5 minutes |
| 3rd failure | 30 minutes |
| After 3rd failure | `FAILED` — no further automatic retry |

---

## 9. Task Import and Export

### Parsers (`src/task-parsers.ts`)

Both parsers produce a common `ParsedTask` with a `turnpoints: ParsedTurnpoint[]` array. The raw file content is preserved in `rawContent` for lossless re-export.

**`.xctsk` (XCTrack XML):**
- Hand-rolled regex attribute extraction (no DOM dependency)
- Reads `<sss index="N">`, `<ess index="N">`, `<goal index="N">` for role assignment
- Handles dual coordinate encoding: `|lat| > 180` → decimal × 10⁷, otherwise raw decimal degrees
- Classifies `GOAL_LINE` when `observation-zone type="line"`

**`.cup` (SeeYou CSV):**
- Quote-aware CSV parser handles names with commas
- Parses `DDMM.mmN/S` latitude / `DDDMM.mmE/W` longitude format
- Switches mode at `"-----Related Tasks-----"` separator
- No radius information in `.cup` — defaults all turnpoints to 400 m

**Import endpoint** (`POST .../tasks/import`): Receives a multipart file upload; parses it; creates the task row and all turnpoint rows in a single transaction; sets `sss_turnpoint_id`, `ess_turnpoint_id`, `goal_turnpoint_id` FK references.

### Exporters (`src/task-exporters.ts`)

**`.xctsk` export (`exportXctsk`):** Produces XCTrack XML with coordinates encoded as decimal × 10⁷ integers (XCTrack native format). Includes `<sss>`, `<ess>`, `<goal>` index tags. Uses original `rawContent` verbatim when source format matches.

**`.cup` export (`exportCup`):** Produces SeeYou CSV with standard waypoint header + task section. Converts decimal degrees back to `DDMM.mmN` format.

**QR codes:**
- `buildXctrackDeepLink` — encodes the task as base64url JSON in `xctrack://task?...` for pilots to scan directly into XCTrack
- `buildDownloadUrl` — a plain HTTPS URL to the download endpoint, usable by any app with URL-based task import
- Backend QR endpoint (`GET .../qr`) uses `qrcode` npm package to render a 300×300 PNG

---

## 10. Key Design Decisions

### SQLite as the only store

The entire platform runs against a single SQLite file on a Fly.io persistent volume. No PostgreSQL, Redis, S3, or any other external service is required. Rationale: at club scale (hundreds of pilots, thousands of submissions) SQLite's throughput is ample, and the operational simplicity is substantial — zero external infrastructure to provision, secure, or pay for.

The migration path (column `igc_data BLOB` → `igc_storage_key TEXT`) is commented in the schema for if/when object storage becomes necessary.

### Synchronous pipeline on upload

Scoring happens inline in the upload HTTP handler — the pilot receives their scored result in the same response, with no polling loop or webhook required. The tradeoff is that the upload request may take 1–3 seconds depending on fix density. This is acceptable for club-scale usage and keeps the client-side UX simple.

### IGC data stored as BLOB

Raw IGC files are stored in `flight_submissions.igc_data BLOB` rather than in an object store. At typical club usage (~200 submissions × ~500 KB average) total BLOB storage is well under 100 MB — a rounding error. The schema column can be changed to a storage key with a one-time migration if needed.

### No fix storage in DB

GPS fixes are re-derived from the BLOB on every track replay request rather than stored in a separate table. Storing 10,000 fixes per submission would cost ~50 MB per 200 submissions for data accessed rarely. Re-parsing takes ~10–30 ms.

### JWT with `token_version` revocation

Stateless JWTs are signed for 7 days. Immediate revocation is achieved by comparing the JWT's `tokenVersion` claim to `users.token_version` on every authenticated request — one indexed DB read per request. There is no session store or token blocklist.

### Cookie-first authentication

The `authPlugin` checks the HttpOnly cookie before the `Authorization` header. This means the web frontend never handles the token — no XSS exposure — while the same endpoints work for API clients using Bearer tokens.

### Soft deletes throughout

All major tables have `deleted_at TEXT NULL`. Queries use `WHERE deleted_at IS NULL`, and all indexes are partial indexes on the same predicate, keeping index footprint equivalent to hard deletes while preserving audit history.

### Denormalised `league_id`

`league_id` is stored directly on tasks, turnpoints, submissions, attempts, `task_results`, and `season_standings`. This avoids JOIN chains (e.g. `submission → task → season → league`) on every query and makes tenant-scoping straightforward.

### Materialised caches for leaderboards

`season_standings` and `task_results` are pre-computed by background jobs rather than calculated on every request. The cost of slightly stale data (up to one job cycle behind) is outweighed by consistent O(1) leaderboard reads.

---

## 11. Configuration and Environment

All configuration is loaded from environment variables (via `.env` in development). `loadAuthConfig()` in `auth.ts` crashes immediately on startup if any required variable is missing.

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default: 3000) | HTTP listen port |
| `DB_PATH` | No (default: `./league.db`) | Path to SQLite database file |
| `NODE_ENV` | No (default: `development`) | `production` enables static serving + secure cookies |
| `GOOGLE_CLIENT_ID` | Yes | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Yes | Callback URL registered in Google Cloud Console |
| `JWT_PRIVATE_KEY_PEM` | Yes | RS256 private key (multi-line PEM, must be quoted in `.env`) |
| `JWT_PUBLIC_KEY_PEM` | Yes | RS256 public key (multi-line PEM, must be quoted in `.env`) |
| `JWT_ISSUER` | Yes | Issuer claim value (e.g. `https://xcleague.example.com`) |
| `OAUTH_STATE_SECRET` | Yes | Random string used as HMAC-SHA256 key for OAuth state |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | No | If set and no super-admins exist, that user is promoted on first `migrate` run |

Generate RS256 keys:
```bash
openssl genrsa 2048 > private.pem                    # JWT_PRIVATE_KEY_PEM
openssl rsa -in private.pem -pubout > public.pem     # JWT_PUBLIC_KEY_PEM
```

---

## 12. Scripts and Dependencies

### NPM Scripts

| Script | Command |
|---|---|
| `dev` | `concurrently dev:server dev:client` — start both with hot reload |
| `dev:server` | `tsx watch src/server.ts` — backend on `:3000` |
| `dev:client` | `cd frontend && vite` — frontend on `:5173` |
| `build` | `build:server && build:client` |
| `build:server` | `tsc -p tsconfig.server.json` |
| `build:client` | `cd frontend && vite build --outDir ../dist/client` |
| `start` | `node dist/migrate.js && node dist/server.js` — production |
| `typecheck` | `tsc --noEmit && cd frontend && tsc --noEmit` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `test:coverage` | `vitest run --coverage` |

### Production Dependencies

| Package | Version | Purpose |
|---|---|---|
| `fastify` | ^4.26.2 | HTTP server framework |
| `@fastify/cookie` | ^9.3.1 | Cookie parsing |
| `@fastify/cors` | ^9.0.1 | CORS headers |
| `@fastify/multipart` | ^8.3.0 | File upload handling |
| `@fastify/static` | ^7.0.4 | Serve Vite build in production |
| `better-sqlite3` | ^9.4.3 | Synchronous SQLite driver (native module) |
| `dotenv` | ^17.3.1 | `.env` file loading |
| `jose` | ^5.2.4 | RS256 JWT signing and verification |
| `igc-parser` | ^2.0.0 | Parse IGC flight recorder files |
| `geographiclib-geodesic` | ^2.1.1 | Vincenty geodesic distance |
| `qrcode` | ^1.5.4 | Generate QR code PNG buffers |

### Development Dependencies

| Package | Purpose |
|---|---|
| `typescript` | Compiler |
| `tsx` | Run TypeScript directly (dev watch mode) |
| `concurrently` | Run multiple dev servers |
| `pino-pretty` | Human-readable Fastify logs in development |
| `vitest` | Test runner |
| `@types/better-sqlite3` | TypeScript types |
| `@types/node` | TypeScript types |
| `@types/qrcode` | TypeScript types |

### TypeScript Configuration (`tsconfig.server.json`)

| Option | Value | Notes |
|---|---|---|
| `target` | `ES2020` | Supports `Promise`, optional chaining, etc. |
| `module` | `commonjs` | Node.js `require` / `module.exports` |
| `moduleResolution` | `node` | Classic Node.js resolution |
| `outDir` | `./dist` | Compiled output |
| `rootDir` | `./src` | Preserves directory structure |
| `strict` | `true` | All strict checks enabled |
| `esModuleInterop` | `true` | Default import interop for CJS packages |
| `resolveJsonModule` | `true` | Allow JSON imports |
| `include` | `src/**/*.ts` | Source files only |
| `exclude` | `node_modules, dist, frontend` | Frontend has its own `tsconfig` |
