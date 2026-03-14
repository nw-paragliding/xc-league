// =============================================================================
// XC / Hike & Fly League Platform — REST API Specification v1.0
//
// Base URL:        /api/v1
// Authentication:  Bearer JWT in Authorization header
// Tenant:          League slug in URL path — /leagues/:leagueSlug/...
// Content-Type:    application/json (except file uploads: multipart/form-data)
//
// Conventions:
//   - All timestamps: ISO 8601 UTC strings
//   - All distances: kilometres (number)
//   - All times: seconds (integer)
//   - Soft-deleted resources return 404 (not exposed to clients)
//   - Pagination: cursor-based where noted, otherwise full list
//   - Errors: { error: { code: string, message: string, detail?: unknown } }
// =============================================================================


// =============================================================================
// AUTH
// =============================================================================

/**
 * POST /api/v1/auth/oauth/callback
 *
 * OAuth callback — exchanges provider code for platform JWT.
 * Called by the frontend after the OAuth provider redirects back.
 *
 * Body:
 *   { provider: 'google', code: string, redirectUri: string }
 *
 * Response 200:
 *   {
 *     token: string,           // signed JWT, expires in 24h
 *     user: UserSummary,
 *   }
 *
 * Response 401:
 *   { error: { code: 'INVALID_OAUTH_CODE', message: string } }
 *
 * Flow:
 *   1. Exchange code with provider for access + id tokens
 *   2. Extract provider user ID and email from id token
 *   3. Upsert oauth_identities record
 *   4. Upsert users record (create on first login)
 *   5. Sign JWT: { sub: userId, email, isSuperAdmin, iat, exp }
 *   6. Return token + user summary
 */

/**
 * GET /api/v1/auth/me
 * Auth: required
 *
 * Returns the authenticated user's profile and league memberships.
 *
 * Response 200:
 *   {
 *     user: {
 *       id: string,
 *       email: string,
 *       displayName: string,
 *       civlId: string | null,
 *       isSuperAdmin: boolean,
 *     },
 *     memberships: Array<{
 *       leagueId: string,
 *       leagueSlug: string,
 *       leagueName: string,
 *       role: 'pilot' | 'admin',
 *       joinedAt: string,
 *     }>,
 *   }
 */

/**
 * PATCH /api/v1/auth/me
 * Auth: required
 *
 * Update own profile fields.
 *
 * Body (all optional):
 *   { displayName?: string, civlId?: string }
 *
 * Response 200: { user: UserSummary }
 */


// =============================================================================
// LEAGUES
// =============================================================================

/**
 * GET /api/v1/leagues
 * Auth: not required
 *
 * List all public leagues.
 *
 * Response 200:
 *   {
 *     leagues: Array<{
 *       id: string,
 *       slug: string,
 *       name: string,
 *       description: string | null,
 *       logoUrl: string | null,
 *     }>
 *   }
 */

/**
 * POST /api/v1/leagues
 * Auth: super-admin only
 *
 * Create a new league (tenant).
 *
 * Body:
 *   { name: string, slug: string, description?: string, logoUrl?: string }
 *
 * Response 201: { league: LeagueSummary }
 *
 * Errors:
 *   409 SLUG_TAKEN — slug already in use
 */

/**
 * GET /api/v1/leagues/:leagueSlug
 * Auth: not required
 *
 * Response 200: { league: LeagueSummary }
 * Response 404: league not found or deleted
 */

/**
 * PATCH /api/v1/leagues/:leagueSlug
 * Auth: league admin or super-admin
 *
 * Body (all optional):
 *   { name?: string, description?: string, logoUrl?: string }
 *   Note: slug is immutable after creation.
 *
 * Response 200: { league: LeagueSummary }
 */


// =============================================================================
// LEAGUE MEMBERSHIPS
// =============================================================================

/**
 * GET /api/v1/leagues/:leagueSlug/members
 * Auth: league admin or super-admin
 *
 * Response 200:
 *   {
 *     members: Array<{
 *       userId: string,
 *       displayName: string,
 *       email: string,
 *       civlId: string | null,
 *       role: 'pilot' | 'admin',
 *       joinedAt: string,
 *     }>
 *   }
 */

/**
 * POST /api/v1/leagues/:leagueSlug/members
 * Auth: authenticated user (self-join) or league admin (invite)
 *
 * Body:
 *   { userId?: string }   // omit to join as self; provide to add another user (admin only)
 *
 * Response 201:
 *   { membership: { userId, role, joinedAt } }
 *
 * Errors:
 *   403 FORBIDDEN          — non-admin providing userId
 *   409 ALREADY_MEMBER     — user already has membership
 */

/**
 * PATCH /api/v1/leagues/:leagueSlug/members/:userId
 * Auth: league admin or super-admin
 *
 * Update a member's role.
 *
 * Body: { role: 'pilot' | 'admin' }
 *
 * Response 200: { membership: MembershipSummary }
 *
 * Errors:
 *   400 CANNOT_DEMOTE_LAST_ADMIN — would leave league with no admins
 */

/**
 * DELETE /api/v1/leagues/:leagueSlug/members/:userId
 * Auth: self (leave) or league admin (remove)
 *
 * Soft-deletes the membership.
 *
 * Response 204: no content
 */


// =============================================================================
// SEASONS
// =============================================================================

/**
 * GET /api/v1/leagues/:leagueSlug/seasons
 * Auth: not required
 *
 * Response 200:
 *   {
 *     seasons: Array<{
 *       id: string,
 *       name: string,
 *       competitionType: 'XC' | 'HIKE_AND_FLY',
 *       startDate: string,
 *       endDate: string,
 *       taskCount: number,
 *       registeredPilotCount: number,
 *     }>
 *   }
 */

/**
 * POST /api/v1/leagues/:leagueSlug/seasons
 * Auth: league admin or super-admin
 *
 * Body:
 *   {
 *     name: string,
 *     competitionType: 'XC' | 'HIKE_AND_FLY',
 *     startDate: string,        // ISO 8601 date
 *     endDate: string,
 *     nominalDistanceKm?: number,   // default 70
 *     nominalTimeS?: number,        // default 5400
 *     nominalGoalRatio?: number,    // default 0.3
 *   }
 *
 * Response 201: { season: SeasonDetail }
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId
 * Auth: not required
 *
 * Response 200:
 *   {
 *     season: SeasonDetail,
 *     standings: Array<{
 *       rank: number,
 *       userId: string,
 *       displayName: string,
 *       totalPoints: number,
 *       tasksFlown: number,
 *       tasksWithGoal: number,
 *     }>,
 *   }
 */

/**
 * PATCH /api/v1/leagues/:leagueSlug/seasons/:seasonId
 * Auth: league admin or super-admin
 *
 * Body (all optional):
 *   { name?, startDate?, endDate?, nominalDistanceKm?, nominalTimeS?, nominalGoalRatio? }
 *
 * Response 200: { season: SeasonDetail }
 */

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/register
 * Auth: authenticated league member
 *
 * Register the authenticated user for a season.
 *
 * Response 201: { registration: { seasonId, userId, registeredAt } }
 * Response 409: ALREADY_REGISTERED
 */

/**
 * DELETE /api/v1/leagues/:leagueSlug/seasons/:seasonId/register
 * Auth: authenticated league member (self) or league admin
 *
 * Withdraw registration. Not permitted once any submission exists.
 *
 * Response 204: no content
 * Response 409: HAS_SUBMISSIONS — cannot unregister with existing flight submissions
 */


// =============================================================================
// TASKS
// =============================================================================

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks
 * Auth: not required
 *
 * Response 200:
 *   {
 *     tasks: Array<{
 *       id: string,
 *       name: string,
 *       taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE',
 *       openDate: string,
 *       closeDate: string,
 *       optimisedDistanceKm: number | null,
 *       isFrozen: boolean,
 *       pilotCount: number,         // pilots with at least one submission
 *       goalCount: number,          // pilots who reached goal
 *     }>
 *   }
 */

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks
 * Auth: league admin or super-admin
 *
 * Create a task. Turnpoints are provided inline and the optimiser runs
 * synchronously before responding.
 *
 * Body:
 *   {
 *     name: string,
 *     description?: string,
 *     taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE',
 *     openDate: string,
 *     closeDate: string,
 *     turnpoints: Array<{
 *       name: string,
 *       lat: number,
 *       lng: number,
 *       radiusM: number,
 *       type: 'SSS' | 'CYLINDER' | 'AIR_OR_GROUND' | 'GROUND_ONLY' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE',
 *     }>,
 *   }
 *
 * Response 201:
 *   {
 *     task: TaskDetail,
 *     optimisation: {
 *       optimisedDistanceKm: number,
 *       goalLineBearingDeg: number,
 *       converged: boolean,
 *       iterations: number,
 *     }
 *   }
 *
 * Errors:
 *   400 INVALID_TURNPOINT_SEQUENCE — e.g. no SSS, no goal, wrong order
 *   400 OPEN_DATE_AFTER_CLOSE_DATE
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId
 * Auth: not required
 *
 * Response 200:
 *   {
 *     task: TaskDetail,
 *     turnpoints: Array<{
 *       id: string,
 *       sequenceIndex: number,
 *       name: string,
 *       lat: number,
 *       lng: number,
 *       radiusM: number,
 *       type: string,
 *       goalLineBearingDeg: number | null,
 *     }>,
 *     results: Array<TaskResultSummary>,   // public results — best attempt per pilot
 *   }
 *
 * TaskResultSummary:
 *   {
 *     rank: number,
 *     userId: string,
 *     displayName: string,
 *     distanceFlownKm: number,
 *     reachedGoal: boolean,
 *     taskTimeS: number | null,
 *     totalPoints: number,
 *     hasFlaggedCrossings: boolean,
 *   }
 *   Note: distancePoints and timePoints breakdown NOT included here (private to pilot).
 */

/**
 * PATCH /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId
 * Auth: league admin or super-admin
 *
 * Update task metadata or turnpoints. If turnpoints are provided,
 * re-runs the optimiser and re-scores all existing submissions.
 *
 * Body (all optional):
 *   {
 *     name?: string,
 *     description?: string,
 *     openDate?: string,
 *     closeDate?: string,
 *     turnpoints?: Array<TurnpointInput>,  // full replacement if provided
 *   }
 *
 * Response 200: { task: TaskDetail, optimisation?: OptimisationResult }
 *
 * Errors:
 *   409 TASK_HAS_SUBMISSIONS — turnpoints cannot be changed after pilots have submitted.
 *                              Admin must explicitly confirm with ?force=true.
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/download
 * Auth: authenticated league member
 *
 * Download task as .xctsk file for loading into navigation instruments.
 *
 * Response 200:
 *   Content-Type: application/octet-stream
 *   Content-Disposition: attachment; filename="<task-name>.xctsk"
 */


// =============================================================================
// FLIGHT SUBMISSIONS
// =============================================================================

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions
 * Auth: authenticated, registered for season
 *
 * Upload an IGC file for scoring.
 * Content-Type: multipart/form-data
 *
 * Body (form fields):
 *   igcFile: File    (required, .igc extension, max 5MB)
 *
 * Processing:
 *   1. Store raw IGC to object storage
 *   2. Insert flight_submission with status PENDING
 *   3. Run pipeline synchronously:
 *      - If pipeline returns a hard error (PARSE, DATE): set status INVALID,
 *        return 422 immediately with the error message
 *      - If pipeline returns NO_SSS_CROSSING: set status PROCESSED with zero score,
 *        return 200 with result (pilot gets feedback, can resubmit)
 *      - If pipeline succeeds: set status PROCESSED, write attempts, update task_results,
 *        enqueue RESCORE_TASK job, return 200 with result
 *
 * Response 200 (processed):
 *   {
 *     submission: {
 *       id: string,
 *       status: 'PROCESSED',
 *       submittedAt: string,
 *     },
 *     bestAttempt: AttemptResult,
 *     allAttempts: Array<AttemptResult>,    // visible only to the submitting pilot
 *     replacedPreviousBest: boolean,        // true if this beats their prior best
 *   }
 *
 * Response 422 (invalid IGC):
 *   {
 *     error: {
 *       code: 'IGC_INVALID',
 *       message: string,      // human-readable from formatPipelineError()
 *       stage: 'PARSE' | 'DATE' | 'DETECTION',
 *     }
 *   }
 *
 * Errors:
 *   400 NOT_REGISTERED         — pilot not registered for this season
 *   400 TASK_CLOSED            — task close_date has passed
 *   413 FILE_TOO_LARGE         — > 5MB
 *   415 INVALID_FILE_TYPE      — not .igc
 *
 * AttemptResult:
 *   {
 *     attemptIndex: number,
 *     isBestAttempt: boolean,
 *     reachedGoal: boolean,
 *     distanceFlownKm: number,
 *     taskTimeS: number | null,
 *     distancePoints: number,
 *     timePoints: number,
 *     totalPoints: number,
 *     hasFlaggedCrossings: boolean,
 *     turnpointCrossings: Array<{
 *       turnpointId: string,
 *       sequenceIndex: number,
 *       crossingTime: string,
 *       groundCheckRequired: boolean,
 *       groundConfirmed: boolean,
 *       detectedMaxSpeedKmh: number | null,
 *       overrideId: string | null,
 *     }>,
 *   }
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions
 * Auth: authenticated
 *
 * Returns all submissions by the authenticated pilot for this task.
 * Pilots can only see their own submissions.
 * Admins can see all (add ?userId=... to filter).
 *
 * Response 200:
 *   {
 *     submissions: Array<{
 *       id: string,
 *       status: string,
 *       submittedAt: string,
 *       bestAttempt: AttemptResult | null,
 *       allAttempts: Array<AttemptResult>,
 *     }>
 *   }
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId
 * Auth: authenticated (own submission) or league admin
 *
 * Response 200:
 *   {
 *     submission: SubmissionDetail,
 *     bestAttempt: AttemptResult,
 *     allAttempts: Array<AttemptResult>,
 *   }
 *
 * Response 403: not own submission and not admin
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/track
 * Auth: authenticated (own submission) or league admin
 *
 * Returns the parsed track for replay — fixes with timestamps, lat/lng,
 * altitude, ground state (H&F only), and detected flight/hiking segments.
 *
 * Response 200:
 *   {
 *     fixes: Array<{
 *       timestamp: string,
 *       lat: number,
 *       lng: number,
 *       gpsAlt: number,
 *       pressureAlt: number,
 *       groundState: 'GROUND' | 'AIRBORNE' | 'UNKNOWN' | null,  // null for XC
 *     }>,
 *     segments: Array<{
 *       type: 'FLIGHT' | 'HIKING',
 *       startTimestamp: string,
 *       endTimestamp: string,
 *     }>,
 *   }
 *
 * Note: Track is re-parsed from the raw IGC on demand. Not stored in DB.
 */


// =============================================================================
// GROUND OVERRIDES (Hike & Fly only)
// =============================================================================

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/overrides
 * Auth: authenticated (own submission only)
 *
 * Submit a self-declaration for a flagged GROUND_ONLY turnpoint crossing.
 *
 * Body:
 *   {
 *     crossingId: string,   // the turnpoint_crossings.id that was flagged
 *     reason: string,       // pilot's explanation (required, min 10 chars)
 *   }
 *
 * Response 201:
 *   {
 *     override: {
 *       id: string,
 *       crossingId: string,
 *       declaredAt: string,
 *       reason: string,
 *       detectedMaxSpeedKmh: number | null,
 *     },
 *     updatedAttempt: AttemptResult,   // hasFlaggedCrossings updated
 *   }
 *
 * Errors:
 *   400 CROSSING_NOT_FLAGGED     — crossing was already ground-confirmed, no override needed
 *   400 OVERRIDE_ALREADY_EXISTS  — already declared for this crossing
 *   400 TASK_CLOSED              — cannot override after task close_date
 *   403 NOT_OWN_SUBMISSION
 */

/**
 * GET /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:submissionId/overrides
 * Auth: authenticated (own submission) or league admin
 *
 * Returns all overrides for a submission — the audit trail.
 *
 * Response 200:
 *   {
 *     overrides: Array<{
 *       id: string,
 *       crossingId: string,
 *       turnpointId: string,
 *       declaredAt: string,
 *       reason: string,
 *       detectedMaxSpeedKmh: number | null,
 *       crossingTime: string,
 *     }>
 *   }
 */


// =============================================================================
// NOTIFICATIONS
// =============================================================================

/**
 * GET /api/v1/notifications
 * Auth: required
 *
 * Returns unread notifications for the authenticated user, most recent first.
 *
 * Query params:
 *   ?unreadOnly=true   (default false)
 *   ?limit=20          (default 20, max 50)
 *   ?cursor=<id>       (pagination cursor — last notification id from previous page)
 *
 * Response 200:
 *   {
 *     notifications: Array<{
 *       id: string,
 *       type: string,
 *       payload: object,     // type-specific data
 *       readAt: string | null,
 *       createdAt: string,
 *     }>,
 *     nextCursor: string | null,
 *   }
 *
 * Notification payload shapes by type:
 *   SUBMISSION_PROCESSED:
 *     { submissionId, taskName, leagueName, status, totalPoints }
 *   SCORE_UPDATED:
 *     { taskName, leagueName, oldTotalPoints, newTotalPoints, reason: 'RESCORE' }
 *   GROUND_CROSSING_FLAGGED:
 *     { submissionId, taskName, leagueName, turnpointName, detectedMaxSpeedKmh }
 */

/**
 * POST /api/v1/notifications/read
 * Auth: required
 *
 * Mark notifications as read.
 *
 * Body: { ids: string[] }    // array of notification IDs, or omit for "mark all read"
 *
 * Response 200: { markedCount: number }
 */


// =============================================================================
// ADMIN — TASK MANAGEMENT
// =============================================================================

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/freeze
 * Auth: league admin or super-admin
 *
 * Manually freeze task scores before the close_date.
 * Sets scores_frozen_at to now. Irreversible.
 *
 * Response 200: { task: TaskDetail }
 *
 * Errors:
 *   409 ALREADY_FROZEN
 */

/**
 * POST /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/rescore
 * Auth: league admin or super-admin
 *
 * Manually trigger a rescore job for a task (e.g. after a correction).
 * Only permitted if task is not frozen.
 *
 * Response 202:
 *   { jobId: string, message: 'Rescore job queued' }
 *
 * Errors:
 *   409 TASK_FROZEN — cannot rescore after freeze
 */


// =============================================================================
// SUPER-ADMIN
// =============================================================================

/**
 * GET /api/v1/admin/leagues
 * Auth: super-admin only
 *
 * List all leagues including soft-deleted ones.
 *
 * Response 200: { leagues: Array<LeagueSummary & { deletedAt: string | null }> }
 */

/**
 * DELETE /api/v1/admin/leagues/:leagueSlug
 * Auth: super-admin only
 *
 * Soft-delete a league and all its data.
 *
 * Response 204: no content
 */

/**
 * POST /api/v1/admin/leagues/:leagueSlug/restore
 * Auth: super-admin only
 *
 * Restore a soft-deleted league.
 *
 * Response 200: { league: LeagueSummary }
 */


// =============================================================================
// MIDDLEWARE STACK (applied per request)
// =============================================================================

/**
 * Every request passes through this stack in order:
 *
 * 1. CORS
 *    Allow-Origin: configured per-league or wildcard for public endpoints.
 *
 * 2. JWT VERIFICATION (auth required routes only)
 *    - Extract Bearer token from Authorization header
 *    - Verify signature and expiry
 *    - Attach decoded { userId, email, isSuperAdmin } to request context
 *    - 401 if missing or invalid on auth-required routes
 *
 * 3. LEAGUE RESOLUTION (all /leagues/:leagueSlug routes)
 *    - Look up league by slug
 *    - 404 if not found or soft-deleted
 *    - Attach leagueId to request context
 *
 * 4. MEMBERSHIP RESOLUTION (auth-required league routes)
 *    - Look up league_memberships for (userId, leagueId)
 *    - Attach membership role to request context (null if not a member)
 *
 * 5. AUTHORIZATION GUARDS (applied per route)
 *    requireAuth()         — userId must be present
 *    requireMember()       — membership must exist (any role)
 *    requireAdmin()        — role must be 'admin'
 *    requireSuperAdmin()   — isSuperAdmin must be true
 *    requireOwnerOrAdmin() — userId matches resource owner OR role is 'admin'
 *
 * 6. REQUEST BODY VALIDATION
 *    Zod schemas on all mutating endpoints.
 *    400 with field-level errors on validation failure.
 */


// =============================================================================
// STANDARD ERROR CODES
// =============================================================================

/**
 * HTTP 400 Bad Request:
 *   VALIDATION_ERROR          — Zod schema failure; detail contains field errors
 *   INVALID_TURNPOINT_SEQUENCE
 *   OPEN_DATE_AFTER_CLOSE_DATE
 *   NOT_REGISTERED
 *   TASK_CLOSED
 *   HAS_SUBMISSIONS
 *   CROSSING_NOT_FLAGGED
 *   OVERRIDE_ALREADY_EXISTS
 *   CANNOT_DEMOTE_LAST_ADMIN
 *
 * HTTP 401 Unauthorized:
 *   MISSING_TOKEN
 *   INVALID_TOKEN
 *   EXPIRED_TOKEN
 *   INVALID_OAUTH_CODE
 *
 * HTTP 403 Forbidden:
 *   INSUFFICIENT_ROLE          — authenticated but not the right role
 *   NOT_OWN_SUBMISSION
 *
 * HTTP 404 Not Found:
 *   LEAGUE_NOT_FOUND
 *   SEASON_NOT_FOUND
 *   TASK_NOT_FOUND
 *   SUBMISSION_NOT_FOUND
 *   USER_NOT_FOUND
 *
 * HTTP 409 Conflict:
 *   SLUG_TAKEN
 *   ALREADY_MEMBER
 *   ALREADY_REGISTERED
 *   TASK_HAS_SUBMISSIONS
 *   ALREADY_FROZEN
 *   TASK_FROZEN
 *
 * HTTP 413 Payload Too Large:
 *   FILE_TOO_LARGE
 *
 * HTTP 415 Unsupported Media Type:
 *   INVALID_FILE_TYPE
 *
 * HTTP 422 Unprocessable Entity:
 *   IGC_INVALID               — pipeline rejected the file
 *
 * HTTP 500 Internal Server Error:
 *   INTERNAL_ERROR            — unexpected; detail omitted in production
 */


// =============================================================================
// ROUTE SUMMARY TABLE
// =============================================================================

/**
 * Auth        Method   Path                                                              Description
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * public      POST     /api/v1/auth/oauth/callback                                       OAuth login
 * required    GET      /api/v1/auth/me                                                   Own profile
 * required    PATCH    /api/v1/auth/me                                                   Update profile
 *
 * public      GET      /api/v1/leagues                                                   List leagues
 * super-admin POST     /api/v1/leagues                                                   Create league
 * public      GET      /api/v1/leagues/:leagueSlug                                       Get league
 * admin       PATCH    /api/v1/leagues/:leagueSlug                                       Update league
 *
 * admin       GET      /api/v1/leagues/:leagueSlug/members                               List members
 * member      POST     /api/v1/leagues/:leagueSlug/members                               Join league
 * admin       PATCH    /api/v1/leagues/:leagueSlug/members/:userId                       Update role
 * self/admin  DELETE   /api/v1/leagues/:leagueSlug/members/:userId                       Remove member
 *
 * public      GET      /api/v1/leagues/:leagueSlug/seasons                               List seasons
 * admin       POST     /api/v1/leagues/:leagueSlug/seasons                               Create season
 * public      GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId                     Season + standings
 * admin       PATCH    /api/v1/leagues/:leagueSlug/seasons/:seasonId                     Update season
 * member      POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/register            Register for season
 * self/admin  DELETE   /api/v1/leagues/:leagueSlug/seasons/:seasonId/register            Withdraw registration
 *
 * public      GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks               List tasks
 * admin       POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks               Create task
 * public      GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId       Task + results
 * admin       PATCH    /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId       Update task
 * member      GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/download  .xctsk file
 * admin       POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/freeze    Freeze scores
 * admin       POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/rescore   Trigger rescore
 *
 * member      POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions          Upload IGC
 * self/admin  GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions          Own submissions
 * self/admin  GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:id      Submission detail
 * self/admin  GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:id/track Track replay
 * self        POST     /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:id/overrides  Ground override
 * self/admin  GET      /api/v1/leagues/:leagueSlug/seasons/:seasonId/tasks/:taskId/submissions/:id/overrides  Override audit
 *
 * required    GET      /api/v1/notifications                                             Own notifications
 * required    POST     /api/v1/notifications/read                                        Mark read
 *
 * super-admin GET      /api/v1/admin/leagues                                             All leagues
 * super-admin DELETE   /api/v1/admin/leagues/:leagueSlug                                 Delete league
 * super-admin POST     /api/v1/admin/leagues/:leagueSlug/restore                         Restore league
 */
