// =============================================================================
// XC / Hike & Fly League — IGC Processing Pipeline
// Language: TypeScript
// Architecture: Sequential synchronous pipeline with typed stage outputs
// Each stage is a pure function: Input → Result<Output, Error>
// Errors are typed and propagate without throwing
// =============================================================================


// =============================================================================
// SHARED TYPES
// =============================================================================

/** A single GPS fix from a B record */
export interface Fix {
  timestamp: number;        // Unix ms, UTC — derived from HFDTE + B record time
  lat: number;              // WGS84 decimal degrees
  lng: number;              // WGS84 decimal degrees
  gpsAlt: number;           // metres
  pressureAlt: number;      // metres
  valid: boolean;           // IGC validity flag (A = valid, V = invalid)
  gspKmh: number | null;    // ground speed km/h from GSP extension if present; else null
  derivedSpeedKmh: number | null; // computed from distance to previous fix / time delta
}

/** A cylinder crossing event detected by segment-circle intersection */
export interface CylinderCrossing {
  turnpointId: string;
  sequenceIndex: number;
  crossingTime: number;       // interpolated Unix ms
  segmentStartFix: Fix;       // fix before crossing
  segmentEndFix: Fix;         // fix after crossing
  groundCheckRequired: boolean;
  detectedMaxSpeedKmh: number | null;  // max speed in 60s window around crossing
  groundConfirmed: boolean;   // true if speed check passed or not required
}

/** One complete or partial task attempt extracted from a track */
export interface ScoredAttempt {
  attemptIndex: number;
  sssCrossing: CylinderCrossing;
  essCrossing: CylinderCrossing | null;
  goalCrossing: CylinderCrossing | null;
  turnpointCrossings: CylinderCrossing[];   // all TPs achieved in order, including SSS/ESS/goal
  reachedGoal: boolean;
  lastTurnpointIndex: number;
  taskTimeS: number | null;                 // ESS time - SSS time in seconds; null if no ESS
  distanceFlownKm: number;
  distancePoints: number;
  timePoints: number;                       // 0 until task field is known; set by scorer
  totalPoints: number;
  hasFlaggedCrossings: boolean;
}

/** Result type — all pipeline stages return this */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}


// =============================================================================
// STAGE 0: RAW INPUT
// =============================================================================

export interface PipelineInput {
  igcText: string;           // raw file contents
  task: TaskDefinition;
  existingGoalTimes: number[]; // task times (seconds) of all pilots who already reached goal
                               // used to compute time points for this submission
  competitionType: 'XC' | 'HIKE_AND_FLY';
}

export interface TaskDefinition {
  id: string;
  turnpoints: TurnpointDef[];  // ordered: [SSS, TP1, TP2, ..., ESS/goal]
  optimisedDistanceKm: number;
  closeDate: number;           // Unix ms — used to check if scoring is frozen
}

export interface TurnpointDef {
  id: string;
  sequenceIndex: number;
  lat: number;
  lng: number;
  radiusM: number;
  type: 'SSS' | 'CYLINDER' | 'AIR_OR_GROUND' | 'GROUND_ONLY' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE';
  goalLineBearingDeg?: number;  // GOAL_LINE only
}


// =============================================================================
// STAGE 1: PARSE & VALIDATE
// Responsibility: Turn raw IGC text into a validated fix array.
// Uses igc-parser under the hood. Does NOT know about tasks.
// =============================================================================

export type ParseError =
  | { code: 'MISSING_DATE_HEADER';    message: string }
  | { code: 'NO_VALID_FIXES';         message: string }
  | { code: 'NON_MONOTONIC_TIME';     message: string; atTimestamp: number }
  | { code: 'INSUFFICIENT_DURATION';  message: string; durationS: number }
  | { code: 'PARSE_FAILURE';          message: string; detail: unknown };

export interface ParsedTrack {
  flightDate: string;    // 'YYYY-MM-DD' from HFDTE
  fixes: Fix[];          // validated, monotonic, with derivedSpeedKmh populated
  gapCount: number;      // number of gaps > 5 minutes between fixes (informational)
}

/**
 * Stage 1: parseAndValidate
 *
 * Steps:
 *  1. Call igc-parser with lenient: false initially, retry with lenient: true on failure
 *  2. Extract HFDTE date — reject if missing
 *  3. Extract B records — reject if none
 *  4. Filter invalid fixes (validity flag = 'V') — keep valid only
 *  5. Check timestamp monotonicity — reject on violation
 *  6. Compute derivedSpeedKmh for each fix from previous fix distance / time delta
 *  7. Reject if total valid duration < 120 seconds
 *  8. Count gaps > 5 minutes (normal in hike & fly; flagged for logging only)
 *  9. Encode timestamps as Unix ms using HFDTE date + B record time, handling midnight rollover
 */
export function parseAndValidate(igcText: string): Result<ParsedTrack, ParseError> {
  // Implementation outline:
  //
  // const IGCParser = require('igc-parser');
  // let parsed;
  // try {
  //   parsed = IGCParser.parse(igcText, { lenient: false });
  // } catch {
  //   try { parsed = IGCParser.parse(igcText, { lenient: true }); }
  //   catch (e) { return err({ code: 'PARSE_FAILURE', ... }); }
  // }
  //
  // if (!parsed.date) return err({ code: 'MISSING_DATE_HEADER', ... });
  //
  // const validFixes = parsed.fixes
  //   .filter(f => f.valid)
  //   .map(f => ({
  //     timestamp: f.timestamp,  // igc-parser already gives Unix ms
  //     lat: f.latitude,
  //     lng: f.longitude,
  //     gpsAlt: f.gpsAltitude,
  //     pressureAlt: f.pressureAltitude,
  //     valid: true,
  //     gspKmh: f.extensions?.GSP ? parseInt(f.extensions.GSP) / 10 : null,
  //     derivedSpeedKmh: null,  // computed below
  //   }));
  //
  // Check monotonicity, compute derived speeds, count gaps, check duration...
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 2: DATE VALIDATION
// Responsibility: Confirm the flight date falls within the task window.
// Separated from parsing so the error is clearly task-context, not file-format.
// =============================================================================

export type DateValidationError =
  | { code: 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW'; flightDate: string; taskOpen: string; taskClose: string }
  | { code: 'TASK_SCORES_FROZEN'; frozenAt: string };

export function validateFlightDate(
  track: ParsedTrack,
  task: TaskDefinition,
  taskOpenDate: string,
  taskCloseDate: string,
  scoresFrozenAt: number | null,
): Result<ParsedTrack, DateValidationError> {
  // Implementation outline:
  //
  // if (scoresFrozenAt && Date.now() > scoresFrozenAt)
  //   return err({ code: 'TASK_SCORES_FROZEN', ... });
  //
  // if (track.flightDate < taskOpenDate || track.flightDate > taskCloseDate)
  //   return err({ code: 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW', ... });
  //
  // return ok(track);
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 3: ATTEMPT DETECTION
// Responsibility: Find all SSS crossings and for each, greedily match TPs forward.
// Returns one AttemptTrace per SSS crossing found, complete or partial.
// Does NOT score — purely geometric.
// =============================================================================

export type AttemptDetectionError =
  | { code: 'NO_SSS_CROSSING'; message: string };

export interface AttemptTrace {
  attemptIndex: number;
  sssCrossing: CylinderCrossing;
  turnpointCrossings: CylinderCrossing[];  // all achieved TPs after SSS, in order
  reachedGoal: boolean;
  lastTurnpointIndex: number;
}

/**
 * Stage 3: detectAttempts
 *
 * Algorithm:
 *  1. Scan all consecutive fix pairs for SSS cylinder crossings using segmentIntersectsCircle()
 *  2. For each SSS crossing (there may be many — pilot hovering near start):
 *     a. Starting from the crossing fix index, scan forward for TP[1]
 *     b. Once TP[1] is crossed, scan forward for TP[2], etc.
 *     c. Continue greedily until goal is crossed or track ends
 *     d. Record all crossings achieved
 *  3. If a later SSS crossing produces a better (further) result, it supersedes
 *     earlier attempts with the same or fewer TPs achieved
 *  4. Return all distinct attempts (different SSS crossings leading to different results)
 *
 * Key subtlety: A pilot may cross SSS, fly TP1, fail TP2, return to SSS and restart.
 * Each SSS crossing is treated as a new attempt. The best-scoring attempt wins.
 */
export function detectAttempts(
  fixes: Fix[],
  task: TaskDefinition,
): Result<AttemptTrace[], AttemptDetectionError> {
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 3a: GEOMETRY ENGINE
// Pure geometric primitives. No task or IGC knowledge.
// Used by Stage 3 and Stage 5 (goal line).
// =============================================================================

export interface Point2D { x: number; y: number; }
export interface Segment2D { a: Point2D; b: Point2D; }

/**
 * Project WGS84 lat/lng to a local flat plane centred on origin.
 * Uses equirectangular approximation — accurate for distances < 20km.
 * Returns x (east, metres), y (north, metres).
 */
export function projectToLocal(
  lat: number, lng: number,
  originLat: number, originLng: number,
): Point2D {
  const R = 6371000; // Earth radius metres
  const x = R * (lng - originLng) * (Math.PI / 180) * Math.cos(originLat * Math.PI / 180);
  const y = R * (lat - originLat) * (Math.PI / 180);
  return { x, y };
}

/**
 * Does segment A→B intersect a circle of radius r centred at origin (0,0)?
 * Returns the interpolation parameter t ∈ [0,1] of the first intersection,
 * or null if no intersection.
 * t=0 → intersection at A, t=1 → intersection at B.
 */
export function segmentIntersectsCircle(
  a: Point2D, b: Point2D, r: number,
): number | null {
  // Parameterise segment as P(t) = A + t*(B-A), t ∈ [0,1]
  // Substitute into circle equation |P|² = r²
  // Solve quadratic: at² + bt + c = 0
  //
  // dx = b.x - a.x, dy = b.y - a.y
  // qa = dx² + dy²
  // qb = 2*(a.x*dx + a.y*dy)
  // qc = a.x² + a.y² - r²
  // discriminant = qb² - 4*qa*qc
  // if discriminant < 0: no intersection
  // t = (-qb ± sqrt(discriminant)) / (2*qa)
  // return smallest t in [0,1], or null
  throw new Error('Implementation required');
}

/**
 * Does segment A→B cross a finite line segment (goal line)?
 * Goal line is defined by its midpoint, half-length, and bearing (degrees from north).
 * Returns interpolation parameter t or null.
 */
export function segmentIntersectsGoalLine(
  a: Point2D, b: Point2D,
  lineMidpoint: Point2D,
  halfLengthM: number,
  bearingDeg: number,
): number | null {
  // Convert goal line to two endpoints using bearing and half-length
  // Then compute segment-segment intersection using standard 2D method
  // Return t parameter along A→B at the intersection point, or null
  throw new Error('Implementation required');
}

/**
 * Interpolate the timestamp at parameter t along a segment between two fixes.
 * Linear interpolation: time = fix_a.timestamp + t * (fix_b.timestamp - fix_a.timestamp)
 */
export function interpolateCrossingTime(fixA: Fix, fixB: Fix, t: number): number {
  return fixA.timestamp + t * (fixB.timestamp - fixA.timestamp);
}

/**
 * WGS84 geodesic distance between two points in metres.
 * Uses Vincenty formula via geographiclib.
 * For short distances (< 100m) equirectangular is acceptable but
 * Vincenty is used throughout for consistency.
 */
export function geodesicDistanceM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  // const { Geodesic } = require('geographiclib-geodesic');
  // const geod = Geodesic.WGS84;
  // return geod.Inverse(lat1, lng1, lat2, lng2).s12;
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 4: GROUND STATE CLASSIFICATION (Hike & Fly only)
// Responsibility: For each fix, determine ground state.
// For GROUND_ONLY turnpoints: check ground state near each crossing.
// =============================================================================

const GROUND_SPEED_THRESHOLD_KMH = 15;
const GROUND_STATE_WINDOW_S = 30;
const CROSSING_CHECK_WINDOW_S = 60;

export type GroundState = 'GROUND' | 'AIRBORNE' | 'UNKNOWN';

/**
 * Stage 4: classifyGroundState
 *
 * For each fix, derive ground state:
 *  - Use derivedSpeedKmh (always available) as primary
 *  - Cross-check against gspKmh (from GSP extension) when present
 *  - A fix is GROUND if derivedSpeedKmh < GROUND_SPEED_THRESHOLD_KMH
 *    sustained for GROUND_STATE_WINDOW_S seconds of surrounding fixes
 *  - Otherwise AIRBORNE
 *  - UNKNOWN if fix is isolated (gap > 5min on both sides)
 *
 * For each GROUND_ONLY crossing in attempts:
 *  - Find all fixes within CROSSING_CHECK_WINDOW_S of the crossing time
 *  - Compute maxSpeedKmh in that window
 *  - groundConfirmed = maxSpeedKmh < GROUND_SPEED_THRESHOLD_KMH
 *  - Store detectedMaxSpeedKmh on the crossing for audit
 *
 * XC tracks: skip this stage entirely, pass attempts through unchanged.
 */
export function classifyGroundState(
  fixes: Fix[],
  attempts: AttemptTrace[],
  competitionType: 'XC' | 'HIKE_AND_FLY',
): AttemptTrace[] {
  if (competitionType === 'XC') return attempts;
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 5: DISTANCE CALCULATION
// Responsibility: For each attempt, compute best achieved distance along
// the optimal task route.
// =============================================================================

/**
 * Stage 5: calculateDistances
 *
 * For pilots who reached goal: distanceFlownKm = task.optimisedDistanceKm
 *
 * For pilots who did not reach goal:
 *  1. Determine the last TP achieved (lastTurnpointIndex)
 *  2. Compute cumulative optimal distance up to the last achieved TP cylinder boundary
 *  3. For the next unachieved TP, find the pilot's closest approach to that cylinder
 *     along their track and project it onto the optimal line
 *  4. distanceFlownKm = cumulative distance to last TP + projected distance toward next TP
 *
 * Optimal route distance between TPs:
 *  - Shortest path from TP[n] cylinder boundary to TP[n+1] cylinder boundary
 *  - For adjacent TPs this is: geodesicDistance(tp[n].centre, tp[n+1].centre)
 *                                - tp[n].radiusM - tp[n+1].radiusM
 *  - Pre-computed and stored as task.optimisedDistanceKm; per-leg distances
 *    derived from the same computation
 *
 * Note: open distance scoring (furthest point) is NOT implemented here.
 * We only score along the task route.
 */
export function calculateDistances(
  attempts: AttemptTrace[],
  fixes: Fix[],
  task: TaskDefinition,
): AttemptTrace[] {
  throw new Error('Implementation required');
}


// =============================================================================
// STAGE 6: GAP SCORING
// Responsibility: Compute distance points and time points for each attempt.
// Distance points are final. Time points depend on the full goal field.
// =============================================================================

const MAX_POINTS = 938;

/**
 * Stage 6: scoreAttempts
 *
 * Distance points (fixed):
 *   If reached goal:
 *     distancePoints = MAX_POINTS
 *   Else:
 *     distancePoints = MAX_POINTS * sqrt(distanceFlownKm / bestDistanceKm)
 *     where bestDistanceKm = max distance across ALL pilots on this task (including this one)
 *
 * Time points (dynamic — recalculated when field changes):
 *   Only for attempts that reached goal (reachedGoal = true)
 *   t_pilot = taskTimeS
 *   t_min   = min(existingGoalTimes + [t_pilot])
 *   t_max   = max(existingGoalTimes + [t_pilot])
 *
 *   If t_min === t_max (sole finisher or all same time):
 *     timePoints = MAX_POINTS
 *   Else:
 *     timePoints = MAX_POINTS * (1 - ((t_pilot - t_min) / (t_max - t_min)) ** (2/3))
 *
 *   Non-goal attempts: timePoints = 0
 *
 * IMPORTANT: bestDistanceKm must account for all pilots on this task, not just
 * this submission. The caller must pass in the current task-wide best distance
 * so that rescoring produces consistent results.
 *
 * totalPoints = distancePoints + timePoints
 */
export function scoreAttempts(
  attempts: AttemptTrace[],
  existingGoalTimesS: number[],
  taskBestDistanceKm: number,
): ScoredAttempt[] {
  throw new Error('Implementation required');
}

/**
 * Rescore: recalculate time points for all goal attempts on a task.
 * Called as a background job whenever a new goal pilot submits.
 * Input: all ScoredAttempts for the task (across all pilots).
 * Output: updated time_points and total_points for each.
 * Distance points are NOT changed.
 */
export function rescoreTimePoints(
  allTaskAttempts: ScoredAttempt[],
): ScoredAttempt[] {
  const goalAttempts = allTaskAttempts.filter(a => a.reachedGoal && a.taskTimeS !== null);
  const times = goalAttempts.map(a => a.taskTimeS!);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);

  return allTaskAttempts.map(attempt => {
    if (!attempt.reachedGoal || attempt.taskTimeS === null) {
      return { ...attempt, timePoints: 0, totalPoints: attempt.distancePoints };
    }
    const timePoints = tMin === tMax
      ? MAX_POINTS
      : MAX_POINTS * (1 - ((attempt.taskTimeS - tMin) / (tMax - tMin)) ** (2 / 3));

    return {
      ...attempt,
      timePoints,
      totalPoints: attempt.distancePoints + timePoints,
    };
  });
}


// =============================================================================
// STAGE 7: SELECT BEST ATTEMPT
// Responsibility: From all scored attempts in a submission, pick the best.
// Also compares against the pilot's existing best across all submissions.
// =============================================================================

/**
 * Stage 7: selectBestAttempt
 *
 * Ranking priority:
 *  1. Reached goal (true > false)
 *  2. Total points (higher is better)
 *  3. Task time if both reached goal (lower is better — tiebreak)
 *
 * Returns the index into scoredAttempts of the best attempt.
 */
export function selectBestAttempt(scoredAttempts: ScoredAttempt[]): number {
  let bestIdx = 0;
  for (let i = 1; i < scoredAttempts.length; i++) {
    const candidate = scoredAttempts[i];
    const current = scoredAttempts[bestIdx];

    if (candidate.reachedGoal && !current.reachedGoal) { bestIdx = i; continue; }
    if (!candidate.reachedGoal && current.reachedGoal) { continue; }
    if (candidate.totalPoints > current.totalPoints) { bestIdx = i; continue; }
    if (
      candidate.totalPoints === current.totalPoints &&
      candidate.taskTimeS !== null &&
      current.taskTimeS !== null &&
      candidate.taskTimeS < current.taskTimeS
    ) { bestIdx = i; }
  }
  return bestIdx;
}


// =============================================================================
// PIPELINE ORCHESTRATOR
// Runs all stages in sequence. Stops at first hard error.
// Returns either a full result or a typed error from whichever stage failed.
// =============================================================================

export type PipelineError =
  | { stage: 'PARSE';        error: ParseError }
  | { stage: 'DATE';         error: DateValidationError }
  | { stage: 'DETECTION';    error: AttemptDetectionError };

export interface PipelineResult {
  scoredAttempts: ScoredAttempt[];
  bestAttemptIndex: number;
  flightDate: string;
  gapCount: number;
}

export async function runPipeline(
  input: PipelineInput,
  taskOpenDate: string,
  taskCloseDate: string,
  scoresFrozenAt: number | null,
  taskBestDistanceKm: number,
): Promise<Result<PipelineResult, PipelineError>> {

  // Stage 1: Parse
  const parseResult = parseAndValidate(input.igcText);
  if (!parseResult.ok) return err({ stage: 'PARSE', error: parseResult.error });
  const track = parseResult.value;

  // Stage 2: Date validation
  const dateResult = validateFlightDate(track, input.task, taskOpenDate, taskCloseDate, scoresFrozenAt);
  if (!dateResult.ok) return err({ stage: 'DATE', error: dateResult.error });

  // Stage 3: Attempt detection
  const detectionResult = detectAttempts(track.fixes, input.task);
  if (!detectionResult.ok) return err({ stage: 'DETECTION', error: detectionResult.error });
  let attempts = detectionResult.value;

  // Stage 4: Ground state (hike & fly only — no-op for XC)
  attempts = classifyGroundState(track.fixes, attempts, input.competitionType);

  // Stage 5: Distance calculation
  attempts = calculateDistances(attempts, track.fixes, input.task);

  // Stage 6: Scoring
  const scoredAttempts = scoreAttempts(attempts, input.existingGoalTimes, taskBestDistanceKm);

  // Stage 7: Select best
  const bestAttemptIndex = selectBestAttempt(scoredAttempts);

  return ok({
    scoredAttempts,
    bestAttemptIndex,
    flightDate: track.flightDate,
    gapCount: track.gapCount,
  });
}


// =============================================================================
// RESCORE JOB ENTRY POINT
// Called by the background job queue when a new goal pilot submits.
// Fetches all attempts for the task from the DB, recalculates time points,
// writes results back. Returns updated attempts for DB persistence.
// =============================================================================

export interface RescoreInput {
  taskId: string;
  allAttemptsForTask: ScoredAttempt[];  // loaded from DB by job runner
}

export interface RescoreOutput {
  updatedAttempts: ScoredAttempt[];     // write time_points + total_points back to DB
}

export function runRescore(input: RescoreInput): RescoreOutput {
  const updatedAttempts = rescoreTimePoints(input.allAttemptsForTask);
  return { updatedAttempts };
}


// =============================================================================
// ERROR MESSAGES
// Human-readable messages for each error code, used in pilot-facing UI.
// =============================================================================

export function formatPipelineError(error: PipelineError): string {
  switch (error.stage) {
    case 'PARSE':
      switch (error.error.code) {
        case 'MISSING_DATE_HEADER':   return 'Your IGC file is missing a valid date header (HFDTE). Please check your flight recorder settings.';
        case 'NO_VALID_FIXES':        return 'Your IGC file contains no valid GPS fixes. The file may be corrupt.';
        case 'NON_MONOTONIC_TIME':    return 'Your IGC file contains timestamps that go backwards. The file may be corrupt.';
        case 'INSUFFICIENT_DURATION': return `Your IGC file contains less than 2 minutes of valid fixes (${error.error.durationS}s found). Please check your recorder logged the full flight.`;
        case 'PARSE_FAILURE':         return 'Your IGC file could not be read. Please ensure it is a valid IGC file.';
      }
    case 'DATE':
      switch (error.error.code) {
        case 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW': return `Your flight date (${error.error.flightDate}) is outside the task window (${error.error.taskOpen} – ${error.error.taskClose}).`;
        case 'TASK_SCORES_FROZEN':              return `This task closed on ${error.error.frozenAt}. No further submissions are accepted.`;
      }
    case 'DETECTION':
      switch (error.error.code) {
        case 'NO_SSS_CROSSING': return 'No valid start cylinder crossing was detected in your track. Make sure you crossed the start cylinder before heading to the first turnpoint.';
      }
  }
}
