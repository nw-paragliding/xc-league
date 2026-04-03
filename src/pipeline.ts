// =============================================================================
// XC / Hike & Fly League — IGC Processing Pipeline
// Language: TypeScript
// Architecture: Sequential synchronous pipeline with typed stage outputs
// Each stage is a pure function: Input → Result<Output, Error>
// Errors are typed and propagate without throwing
// =============================================================================

import {
  optimiseRoute, computePartialDistanceKm, computeDistancePoints, computeTimePoints,
  MAX_POINTS,
  type OptimisedRoute, type Cylinder,
} from './shared/task-engine';

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
 */
export function parseAndValidate(igcText: string): Result<ParsedTrack, ParseError> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IGCParser = require('igc-parser');

  let parsed: any;
  try {
    parsed = IGCParser.parse(igcText, { lenient: false });
  } catch {
    try {
      parsed = IGCParser.parse(igcText, { lenient: true });
    } catch (e) {
      return err({ code: 'PARSE_FAILURE', message: 'IGC file could not be parsed', detail: e });
    }
  }

  if (!parsed.date) {
    return err({ code: 'MISSING_DATE_HEADER', message: 'IGC file is missing a valid HFDTE date header' });
  }

  const rawFixes: any[] = parsed.fixes ?? [];
  if (rawFixes.length === 0) {
    return err({ code: 'NO_VALID_FIXES', message: 'IGC file contains no B-record fixes' });
  }

  // Filter to valid fixes only
  const validRaw = rawFixes.filter((f: any) => f.valid !== false);
  if (validRaw.length === 0) {
    return err({ code: 'NO_VALID_FIXES', message: 'IGC file contains no valid GPS fixes (all marked invalid)' });
  }

  // Map to Fix shape (no derivedSpeedKmh yet)
  const proto: Fix[] = validRaw.map((f: any) => ({
    timestamp: f.timestamp as number,
    lat: f.latitude as number,
    lng: f.longitude as number,
    gpsAlt: (f.gpsAltitude ?? 0) as number,
    pressureAlt: (f.pressureAltitude ?? 0) as number,
    valid: true,
    gspKmh: f.extensions?.GSP != null ? parseInt(f.extensions.GSP, 10) / 10 : null,
    derivedSpeedKmh: null,
  }));

  // Check monotonicity
  for (let i = 1; i < proto.length; i++) {
    if (proto[i].timestamp <= proto[i - 1].timestamp) {
      return err({
        code: 'NON_MONOTONIC_TIME',
        message: 'IGC timestamps are not monotonically increasing — file may be corrupt',
        atTimestamp: proto[i].timestamp,
      });
    }
  }

  // Compute derivedSpeedKmh
  const DEG = Math.PI / 180;
  const R = 6371000;
  const fixes: Fix[] = proto.map((f, i) => {
    if (i === 0) return { ...f, derivedSpeedKmh: 0 };
    const prev = proto[i - 1];
    const dtS = (f.timestamp - prev.timestamp) / 1000;
    if (dtS <= 0) return { ...f, derivedSpeedKmh: 0 };
    const dLat = (f.lat - prev.lat) * DEG;
    const dLng = (f.lng - prev.lng) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(prev.lat * DEG) * Math.cos(f.lat * DEG) * Math.sin(dLng / 2) ** 2;
    const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return { ...f, derivedSpeedKmh: (distM / dtS) * 3.6 };
  });

  // Check minimum duration (2 minutes)
  const durationS = (fixes[fixes.length - 1].timestamp - fixes[0].timestamp) / 1000;
  if (durationS < 120) {
    return err({
      code: 'INSUFFICIENT_DURATION',
      message: `Track duration is only ${Math.round(durationS)}s; minimum is 120s`,
      durationS,
    });
  }

  // Count gaps > 5 minutes (300 000 ms)
  let gapCount = 0;
  for (let i = 1; i < fixes.length; i++) {
    if (fixes[i].timestamp - fixes[i - 1].timestamp > 300_000) gapCount++;
  }

  // Extract flight date as YYYY-MM-DD
  const d: Date = parsed.date instanceof Date ? parsed.date : new Date(parsed.date);
  const flightDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  return ok({ flightDate, fixes, gapCount });
}


// =============================================================================
// STAGE 2: DATE VALIDATION
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
  if (scoresFrozenAt !== null) {
    return err({
      code: 'TASK_SCORES_FROZEN',
      frozenAt: new Date(scoresFrozenAt).toISOString(),
    });
  }

  // Compare YYYY-MM-DD strings lexicographically (safe for ISO date format)
  const openDay  = taskOpenDate.slice(0, 10);
  const closeDay = taskCloseDate.slice(0, 10);

  if (track.flightDate < openDay || track.flightDate > closeDay) {
    return err({
      code: 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW',
      flightDate: track.flightDate,
      taskOpen:  openDay,
      taskClose: closeDay,
    });
  }

  return ok(track);
}


// =============================================================================
// STAGE 3: ATTEMPT DETECTION
// =============================================================================

export type AttemptDetectionError =
  | { code: 'NO_SSS_CROSSING'; message: string };

export interface AttemptTrace {
  attemptIndex: number;
  sssCrossing: CylinderCrossing;
  essCrossing: CylinderCrossing | null;
  goalCrossing: CylinderCrossing | null;
  turnpointCrossings: CylinderCrossing[];  // all achieved TPs in order (includes SSS, ESS, goal)
  reachedGoal: boolean;
  lastTurnpointIndex: number;
  taskTimeS: number | null;     // (ESS or goal crossing time - SSS crossing time) / 1000
  distanceFlownKm: number;      // populated by calculateDistances (initialised to 0 here)
}

/**
 * Stage 3: detectAttempts
 *
 * For each SSS outward crossing:
 *   - Greedily match remaining TPs forward using segment-circle intersection
 *   - Build an AttemptTrace per SSS crossing
 */
export function detectAttempts(
  fixes: Fix[],
  task: TaskDefinition,
): Result<AttemptTrace[], AttemptDetectionError> {
  if (task.turnpoints.length < 2) {
    return err({ code: 'NO_SSS_CROSSING', message: 'Task has fewer than 2 turnpoints' });
  }

  const sss = task.turnpoints[0];

  // ── Step 1: Find all SSS outward crossings ──────────────────────────────────
  const sssCrossings: Array<{ fixIndex: number; t: number; crossingTime: number }> = [];

  for (let i = 0; i < fixes.length - 1; i++) {
    const a = fixes[i];
    const b = fixes[i + 1];
    const aLocal = projectToLocal(a.lat, a.lng, sss.lat, sss.lng);
    const bLocal = projectToLocal(b.lat, b.lng, sss.lat, sss.lng);
    const distA = Math.sqrt(aLocal.x ** 2 + aLocal.y ** 2);
    const distB = Math.sqrt(bLocal.x ** 2 + bLocal.y ** 2);

    // Outward: inside → outside
    if (distA <= sss.radiusM && distB > sss.radiusM) {
      const t = segmentIntersectsCircle(aLocal, bLocal, sss.radiusM);
      if (t !== null) {
        sssCrossings.push({ fixIndex: i, t, crossingTime: interpolateCrossingTime(a, b, t) });
      }
    }
  }

  if (sssCrossings.length === 0) {
    return err({ code: 'NO_SSS_CROSSING', message: 'No SSS outward cylinder crossing was detected in the track' });
  }

  // ── Step 2: For each SSS crossing, greedily match remaining TPs ────────────
  const attempts: AttemptTrace[] = [];

  for (let ai = 0; ai < sssCrossings.length; ai++) {
    const sssCross = sssCrossings[ai];

    const sssCrossing: CylinderCrossing = {
      turnpointId: sss.id,
      sequenceIndex: sss.sequenceIndex,
      crossingTime: sssCross.crossingTime,
      segmentStartFix: fixes[sssCross.fixIndex],
      segmentEndFix:   fixes[sssCross.fixIndex + 1],
      groundCheckRequired: false,
      detectedMaxSpeedKmh: null,
      groundConfirmed: true,
    };

    const turnpointCrossings: CylinderCrossing[] = [sssCrossing];
    let tpIdx = 1;  // next TP to look for (0 = SSS already done)
    let reachedGoal = false;
    let essCrossing: CylinderCrossing | null = null;
    let goalCrossing: CylinderCrossing | null = null;

    // Use while loop so we can re-check the same fix-pair after a TP is achieved
    let fixI = sssCross.fixIndex;
    while (fixI < fixes.length - 1 && tpIdx < task.turnpoints.length) {
      const tp = task.turnpoints[tpIdx];
      const a = fixes[fixI];
      const b = fixes[fixI + 1];
      const aLocal = projectToLocal(a.lat, a.lng, tp.lat, tp.lng);
      const bLocal = projectToLocal(b.lat, b.lng, tp.lat, tp.lng);
      const distA = Math.sqrt(aLocal.x ** 2 + aLocal.y ** 2);

      let crossed = false;
      let crossT: number | null = null;

      if (tp.type === 'GOAL_LINE') {
        // Compute goal line bearing: use stored value or derive from previous TP
        let bearingDeg = tp.goalLineBearingDeg;
        if (!bearingDeg) {
          const prevTp = task.turnpoints[tpIdx - 1];
          const prevLocal = projectToLocal(prevTp.lat, prevTp.lng, tp.lat, tp.lng);
          const inboundAngle = Math.atan2(prevLocal.x, prevLocal.y) * 180 / Math.PI;
          bearingDeg = ((inboundAngle + 90) + 360) % 360;
        }
        const tChord = segmentIntersectsGoalLine(aLocal, bLocal, { x: 0, y: 0 }, tp.radiusM, bearingDeg);
        const tArc   = segmentEntersGoalSemiCircle(aLocal, bLocal, { x: 0, y: 0 }, tp.radiusM, bearingDeg);
        if (tChord !== null || tArc !== null) {
          crossT = Math.min(
            tChord !== null ? tChord : Infinity,
            tArc   !== null ? tArc   : Infinity,
          );
          crossed = true;
        }
      } else if (distA < tp.radiusM) {
        // Already inside this cylinder — count as immediately achieved
        crossT = 0;
        crossed = true;
      } else {
        // Look for inward crossing (outside → inside, or graze-through)
        const t = segmentIntersectsCircle(aLocal, bLocal, tp.radiusM);
        if (t !== null) {
          crossT = t;
          crossed = true;
        }
      }

      if (crossed && crossT !== null) {
        const groundCheckRequired = tp.type === 'GROUND_ONLY' || tp.type === 'AIR_OR_GROUND';
        const crossing: CylinderCrossing = {
          turnpointId: tp.id,
          sequenceIndex: tp.sequenceIndex,
          crossingTime: interpolateCrossingTime(a, b, crossT),
          segmentStartFix: a,
          segmentEndFix:   b,
          groundCheckRequired,
          detectedMaxSpeedKmh: null,
          groundConfirmed: !groundCheckRequired,
        };

        turnpointCrossings.push(crossing);

        if (tp.type === 'ESS') essCrossing = crossing;

        const isGoal = tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE';
        if (isGoal) {
          goalCrossing = crossing;
          reachedGoal = true;
          tpIdx++;
          break;  // done for this attempt
        }

        tpIdx++;
        // Don't advance fixI — re-check same segment for next TP
      } else {
        fixI++;
      }
    }

    const lastTurnpointIndex = tpIdx - 1;

    // Task time: ESS → goal time if ESS exists, else SSS → goal
    const timingCrossing = essCrossing ?? goalCrossing;
    const taskTimeS = timingCrossing !== null
      ? (timingCrossing.crossingTime - sssCrossing.crossingTime) / 1000
      : null;

    attempts.push({
      attemptIndex: ai,
      sssCrossing,
      essCrossing,
      goalCrossing,
      turnpointCrossings,
      reachedGoal,
      lastTurnpointIndex,
      taskTimeS,
      distanceFlownKm: 0,  // populated by calculateDistances
    });
  }

  return ok(attempts);
}


// =============================================================================
// STAGE 3a: GEOMETRY ENGINE
// =============================================================================

export interface Point2D { x: number; y: number; }
export interface Segment2D { a: Point2D; b: Point2D; }

/**
 * Project WGS84 lat/lng to a local flat plane centred on origin.
 * Uses equirectangular approximation — accurate for distances < 20km.
 */
export function projectToLocal(
  lat: number, lng: number,
  originLat: number, originLng: number,
): Point2D {
  const R = 6371000;
  const x = R * (lng - originLng) * (Math.PI / 180) * Math.cos(originLat * Math.PI / 180);
  const y = R * (lat - originLat) * (Math.PI / 180);
  return { x, y };
}

/**
 * Does segment A→B intersect a circle of radius r centred at origin (0,0)?
 * Returns the interpolation parameter t ∈ [0,1] of the first intersection,
 * or null if no intersection.
 */
export function segmentIntersectsCircle(
  a: Point2D, b: Point2D, r: number,
): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const qa = dx * dx + dy * dy;
  if (qa === 0) {
    // Degenerate segment — check if point is on circle
    return null;
  }
  const qb = 2 * (a.x * dx + a.y * dy);
  const qc = a.x * a.x + a.y * a.y - r * r;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-qb - sqrtDisc) / (2 * qa);
  const t2 = (-qb + sqrtDisc) / (2 * qa);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/**
 * Does segment A→B cross a finite goal line?
 * Goal line is defined by its midpoint, half-length, and bearing (degrees from north).
 */
export function segmentIntersectsGoalLine(
  a: Point2D, b: Point2D,
  lineMidpoint: Point2D,
  halfLengthM: number,
  bearingDeg: number,
): number | null {
  // Build goal line endpoints from bearing and half-length
  const rad = bearingDeg * Math.PI / 180;
  const dx = Math.sin(rad) * halfLengthM;
  const dy = Math.cos(rad) * halfLengthM;
  const p1: Point2D = { x: lineMidpoint.x - dx, y: lineMidpoint.y - dy };
  const p2: Point2D = { x: lineMidpoint.x + dx, y: lineMidpoint.y + dy };

  // Segment-segment intersection: A + t*(B-A) = P1 + u*(P2-P1)
  const bax  = b.x - a.x;    const bay  = b.y - a.y;
  const p2p1x = p2.x - p1.x; const p2p1y = p2.y - p1.y;
  const denom = bax * p2p1y - bay * p2p1x;
  if (Math.abs(denom) < 1e-10) return null;  // parallel

  const p1ax = p1.x - a.x; const p1ay = p1.y - a.y;
  const t = (p1ax * p2p1y - p1ay * p2p1x) / denom;
  const u = (p1ax * bay  - p1ay * bax)   / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}

/**
 * Does segment A→B enter the semi-circular portion of the goal control zone?
 *
 * Per CIVL GAP 2025 §6.2.3.1, the full goal OZ is a D-shape: the chord (goal
 * line) plus a semi-circle of radius r on the inbound side. This function
 * detects entry through the curved arc boundary so pilots who fly into the
 * semi-circle without crossing the chord are still scored correctly.
 *
 * bearingDeg is the goal LINE bearing (perpendicular to the inbound track).
 */
export function segmentEntersGoalSemiCircle(
  a: Point2D, b: Point2D,
  centre: Point2D,
  radiusM: number,
  bearingDeg: number,
): number | null {
  // The inbound side is the half-space facing the previous TP.
  // direction from goal centre toward prev TP = goalLineBearing + 90°
  const towardPrevRad = ((bearingDeg + 90) % 360) * Math.PI / 180;
  const tpx = Math.sin(towardPrevRad);
  const tpy = Math.cos(towardPrevRad);
  const onInboundSide = (px: number, py: number) => px * tpx + py * tpy > 0;

  // Work in centre-relative coordinates
  const ax = a.x - centre.x, ay = a.y - centre.y;
  const bx = b.x - centre.x, by = b.y - centre.y;
  const dx = bx - ax, dy = by - ay;

  // Already inside the semi-circle at point A
  if (ax*ax + ay*ay <= radiusM*radiusM && onInboundSide(ax, ay)) return 0;

  // Find intersections of the segment with the bounding circle
  const A2 = dx*dx + dy*dy;
  if (A2 < 1e-10) return null;
  const B2 = 2*(ax*dx + ay*dy);
  const C2 = ax*ax + ay*ay - radiusM*radiusM;
  const disc = B2*B2 - 4*A2*C2;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  // Check entry (t1) then exit (t2); return earliest crossing on the inbound arc
  for (const t of [(-B2 - sqrtDisc) / (2*A2), (-B2 + sqrtDisc) / (2*A2)]) {
    if (t < 0 || t > 1) continue;
    if (onInboundSide(ax + t*dx, ay + t*dy)) return t;
  }
  return null;
}

/**
 * Interpolate the timestamp at parameter t along a segment between two fixes.
 */
export function interpolateCrossingTime(fixA: Fix, fixB: Fix, t: number): number {
  return fixA.timestamp + t * (fixB.timestamp - fixA.timestamp);
}

/**
 * WGS84 geodesic distance between two points in metres (haversine).
 */
export function geodesicDistanceM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000;
  const DEG = Math.PI / 180;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// =============================================================================
// STAGE 4: GROUND STATE CLASSIFICATION (Hike & Fly only)
// =============================================================================

const GROUND_SPEED_THRESHOLD_KMH = 15;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const GROUND_STATE_WINDOW_S = 30;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CROSSING_CHECK_WINDOW_S = 60;

export type GroundState = 'GROUND' | 'AIRBORNE' | 'UNKNOWN';

/**
 * Stage 4: classifyGroundState
 * XC tracks: pass through unchanged.
 */
export function classifyGroundState(
  fixes: Fix[],
  attempts: AttemptTrace[],
  competitionType: 'XC' | 'HIKE_AND_FLY',
): AttemptTrace[] {
  if (competitionType === 'XC') return attempts;
  // Hike & fly: check max speed in a window around each GROUND_ONLY crossing
  return attempts.map(attempt => ({
    ...attempt,
    turnpointCrossings: attempt.turnpointCrossings.map(crossing => {
      if (!crossing.groundCheckRequired) return crossing;
      const windowMs = 60_000;
      const relevant = fixes.filter(f =>
        Math.abs(f.timestamp - crossing.crossingTime) <= windowMs / 2,
      );
      const maxSpeed = relevant.reduce((m, f) => Math.max(m, f.derivedSpeedKmh ?? 0), 0);
      return {
        ...crossing,
        detectedMaxSpeedKmh: maxSpeed,
        groundConfirmed: maxSpeed < GROUND_SPEED_THRESHOLD_KMH,
      };
    }),
  }));
}


// =============================================================================
// STAGE 5: DISTANCE CALCULATION
// =============================================================================

/**
 * Stage 5: calculateDistances
 *
 * Goal pilots: distanceFlownKm = route.totalDistanceKm
 * Others: use computePartialDistanceKm from shared task-engine
 */
export function calculateDistances(
  attempts: AttemptTrace[],
  fixes: Fix[],
  task: TaskDefinition,
): AttemptTrace[] {
  if (task.turnpoints.length < 2) return attempts;

  const cylinders: Cylinder[] = task.turnpoints.map(tp => ({
    lat:  tp.lat,
    lng:  tp.lng,
    radiusM: tp.radiusM,
    type: tp.type,
    goalLineBearingDeg: tp.goalLineBearingDeg,
  }));

  let route: OptimisedRoute;
  try {
    route = optimiseRoute(cylinders);
  } catch {
    return attempts.map(a => ({ ...a, distanceFlownKm: 0 }));
  }

  return attempts.map(attempt => {
    if (attempt.reachedGoal) {
      return { ...attempt, distanceFlownKm: route.totalDistanceKm };
    }

    const sssTime = attempt.sssCrossing.crossingTime;
    const pilotFixes = fixes
      .filter(f => f.timestamp >= sssTime)
      .map(f => ({ lat: f.lat, lng: f.lng }));

    const dist = computePartialDistanceKm(route, cylinders, attempt.lastTurnpointIndex, pilotFixes);
    return { ...attempt, distanceFlownKm: dist };
  });
}


// =============================================================================
// STAGE 6: GAP SCORING
// =============================================================================

/**
 * Stage 6: scoreAttempts
 *
 * Distance points:
 *   Goal: distancePoints = MAX_POINTS
 *   Else: distancePoints = MAX_POINTS * sqrt(dist / bestDist)
 *
 * Time points (goal pilots only):
 *   timePoints = MAX_POINTS * (1 - ((t_pilot - t_min) / (t_max - t_min)) ^ (2/3))
 *   Sole finisher or all same time: timePoints = MAX_POINTS
 */
export function scoreAttempts(
  attempts: AttemptTrace[],
  existingGoalTimesS: number[],
  taskBestDistanceKm: number,
): ScoredAttempt[] {
  // Collect goal task times including this submission's attempts
  const newGoalTimesS = attempts
    .filter(a => a.reachedGoal && a.taskTimeS !== null)
    .map(a => a.taskTimeS!);
  const allGoalTimesS = [...existingGoalTimesS, ...newGoalTimesS];

  // Best distance across all pilots including this submission
  const thisBestDist = Math.max(
    taskBestDistanceKm,
    ...attempts.map(a => a.distanceFlownKm),
  );

  return attempts.map(attempt => {
    const dist = attempt.distanceFlownKm;
    const bestDist = Math.max(thisBestDist, dist);

    const distancePoints = computeDistancePoints(dist, bestDist, attempt.reachedGoal);
    const timePoints = attempt.reachedGoal && attempt.taskTimeS !== null
      ? computeTimePoints(attempt.taskTimeS, allGoalTimesS)
      : 0;

    return {
      attemptIndex:       attempt.attemptIndex,
      sssCrossing:        attempt.sssCrossing,
      essCrossing:        attempt.essCrossing,
      goalCrossing:       attempt.goalCrossing,
      turnpointCrossings: attempt.turnpointCrossings,
      reachedGoal:        attempt.reachedGoal,
      lastTurnpointIndex: attempt.lastTurnpointIndex,
      taskTimeS:          attempt.taskTimeS,
      distanceFlownKm:    dist,
      distancePoints,
      timePoints,
      totalPoints:        distancePoints + timePoints,
      hasFlaggedCrossings: attempt.turnpointCrossings.some(
        c => c.groundCheckRequired && !c.groundConfirmed,
      ),
    };
  });
}

/**
 * Rescore: recalculate time points for all goal attempts on a task.
 */
export function rescoreTimePoints(
  allTaskAttempts: ScoredAttempt[],
): ScoredAttempt[] {
  const goalTimes = allTaskAttempts
    .filter(a => a.reachedGoal && a.taskTimeS !== null)
    .map(a => a.taskTimeS!);

  return allTaskAttempts.map(attempt => {
    if (!attempt.reachedGoal || attempt.taskTimeS === null) {
      return { ...attempt, timePoints: 0, totalPoints: attempt.distancePoints };
    }
    const timePoints = computeTimePoints(attempt.taskTimeS, goalTimes);
    return {
      ...attempt,
      timePoints,
      totalPoints: attempt.distancePoints + timePoints,
    };
  });
}


// =============================================================================
// STAGE 7: SELECT BEST ATTEMPT
// =============================================================================

/**
 * Stage 7: selectBestAttempt
 *
 * Priority: 1) reached goal, 2) total points, 3) task time (lower = better)
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
// =============================================================================

export interface RescoreInput {
  taskId: string;
  allAttemptsForTask: ScoredAttempt[];
}

export interface RescoreOutput {
  updatedAttempts: ScoredAttempt[];
}

export function runRescore(input: RescoreInput): RescoreOutput {
  const updatedAttempts = rescoreTimePoints(input.allAttemptsForTask);
  return { updatedAttempts };
}


// =============================================================================
// ERROR MESSAGES
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
      break;
    case 'DATE':
      switch (error.error.code) {
        case 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW': return `Your flight date (${error.error.flightDate}) is outside the task window (${error.error.taskOpen} – ${error.error.taskClose}).`;
        case 'TASK_SCORES_FROZEN':              return `This task closed on ${error.error.frozenAt}. No further submissions are accepted.`;
      }
      break;
    case 'DETECTION':
      switch (error.error.code) {
        case 'NO_SSS_CROSSING': return 'No valid start cylinder crossing was detected in your track. Make sure you crossed the start cylinder before heading to the first turnpoint.';
      }
      break;
  }
  return 'An unexpected scoring error occurred.';
}
