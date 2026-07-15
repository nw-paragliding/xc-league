// =============================================================================
// XC / Hike & Fly League — IGC Processing Pipeline
// Language: TypeScript
// Architecture: Sequential synchronous pipeline with typed stage outputs
// Each stage is a pure function: Input → Result<Output, Error>
// Errors are typed and propagate without throwing
// =============================================================================

import IGCParser from 'igc-parser';
import {
  type Cylinder,
  computeDistancePoints,
  computePartialDistanceKm,
  computeTimePoints,
  type OptimisedRoute,
  optimiseRoute,
  tagToleranceM,
} from './task-engine';

// =============================================================================
// SCORER VERSION
//
// Bump on any change that affects detection or scoring numbers. The boot
// re-process loop in src/server.ts re-runs the pipeline against every IGC
// whose stored flight_attempts.scorer_version differs from this constant.
// =============================================================================

export const SCORER_VERSION = '1.3';

// Re-export so existing `import { tagToleranceM } from './shared/pipeline'`
// paths keep working. The canonical helper lives in `./task-engine`.
export { tagToleranceM };

// =============================================================================
// SHARED TYPES
// =============================================================================

/** A single GPS fix from a B record */
export interface Fix {
  timestamp: number; // Unix ms, UTC — derived from HFDTE + B record time
  lat: number; // WGS84 decimal degrees
  lng: number; // WGS84 decimal degrees
  gpsAlt: number; // metres
  pressureAlt: number; // metres
  valid: boolean; // IGC validity flag (A = valid, V = invalid)
  gspKmh: number | null; // ground speed km/h from GSP extension if present; else null
  derivedSpeedKmh: number | null; // computed from distance to previous fix / time delta
}

/** A cylinder crossing event detected by segment-circle intersection */
export interface CylinderCrossing {
  turnpointId: string;
  sequenceIndex: number;
  crossingTime: number; // interpolated Unix ms
  segmentStartFix: Fix; // fix before crossing
  segmentEndFix: Fix; // fix after crossing
  groundCheckRequired: boolean;
  detectedMaxSpeedKmh: number | null; // max speed in 60s window around crossing
  groundConfirmed: boolean; // true if speed check passed or not required
}

/** One complete or partial task attempt extracted from a track */
export interface ScoredAttempt {
  attemptIndex: number;
  sssCrossing: CylinderCrossing;
  essCrossing: CylinderCrossing | null;
  goalCrossing: CylinderCrossing | null;
  turnpointCrossings: CylinderCrossing[]; // all TPs achieved in order, including SSS/ESS/goal
  reachedGoal: boolean;
  lastTurnpointIndex: number;
  taskTimeS: number | null; // ESS time - SSS time in seconds; null if no ESS
  distanceFlownKm: number;
  distancePoints: number;
  timePoints: number; // 0 until task field is known; set by scorer
  totalPoints: number;
  hasFlaggedCrossings: boolean;
}

/** Result type — all pipeline stages return this */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

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
  igcText: string; // raw file contents
  task: TaskDefinition;
  existingGoalTimes: number[]; // task times (seconds) of all pilots who already reached goal
  // used to compute time points for this submission
  competitionType: 'XC' | 'HIKE_AND_FLY';
}

export interface TaskDefinition {
  id: string;
  turnpoints: TurnpointDef[]; // ordered: [SSS, TP1, TP2, ..., ESS/goal]
}

export interface TurnpointDef {
  id: string;
  sequenceIndex: number;
  lat: number;
  lng: number;
  radiusM: number;
  type: 'SSS' | 'CYLINDER' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE';
  forceGround?: boolean; // hike & fly: pilot must touch down inside the cylinder
  goalLineBearingDeg?: number; // GOAL_LINE only
}

// =============================================================================
// STAGE 1: PARSE & VALIDATE
// Responsibility: Turn raw IGC text into a validated fix array.
// Uses igc-parser under the hood. Does NOT know about tasks.
// =============================================================================

export type ParseError =
  | { code: 'MISSING_DATE_HEADER'; message: string }
  | { code: 'NO_VALID_FIXES'; message: string }
  | { code: 'NON_MONOTONIC_TIME'; message: string; atTimestamp: number }
  | { code: 'INSUFFICIENT_DURATION'; message: string; durationS: number }
  | { code: 'PARSE_FAILURE'; message: string; detail: unknown };

export interface ParsedTrack {
  flightDate: string; // 'YYYY-MM-DD' from HFDTE
  fixes: Fix[]; // validated, monotonic, with derivedSpeedKmh populated
  gapCount: number; // number of gaps > 5 minutes between fixes (informational)
}

/**
 * Stage 1: parseAndValidate
 */
export function parseAndValidate(igcText: string): Result<ParsedTrack, ParseError> {
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

export type DateValidationError = {
  code: 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW';
  flightDate: string;
  taskOpen: string;
  taskClose: string;
};

export function validateFlightDate(
  track: ParsedTrack,
  taskOpenDate: string,
  taskCloseDate: string,
): Result<ParsedTrack, DateValidationError> {
  // Compare YYYY-MM-DD strings lexicographically (safe for ISO date format)
  const openDay = taskOpenDate.slice(0, 10);
  const closeDay = taskCloseDate.slice(0, 10);

  if (track.flightDate < openDay || track.flightDate > closeDay) {
    return err({
      code: 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW',
      flightDate: track.flightDate,
      taskOpen: openDay,
      taskClose: closeDay,
    });
  }

  return ok(track);
}

// =============================================================================
// STAGE 3: ATTEMPT DETECTION
// =============================================================================

export type AttemptDetectionError = { code: 'NO_SSS_CROSSING'; message: string };

export interface AttemptTrace {
  attemptIndex: number;
  sssCrossing: CylinderCrossing;
  essCrossing: CylinderCrossing | null;
  goalCrossing: CylinderCrossing | null;
  turnpointCrossings: CylinderCrossing[]; // all achieved TPs in order (includes SSS, ESS, goal)
  reachedGoal: boolean;
  lastTurnpointIndex: number;
  taskTimeS: number | null; // (ESS or goal crossing time - SSS crossing time) / 1000
  distanceFlownKm: number; // populated by calculateDistances (initialised to 0 here)
  // XC only: the GLOBAL landing cutoff for the whole track — the start of the
  // first landing-stillness window (≥ 30 s of every fix below 5 km/h with a
  // gpsAlt range under 15 m) that begins at/after the track's first valid SSS
  // crossing. A §12.1 XC flight ends at the first landing, so the same cutoff
  // applies to every attempt: fixes and crossings from this timestamp onward
  // are post-landing and dead, and attempts whose SSS crossing postdates the
  // cutoff are suppressed before they exist. null when the pilot never went
  // still, or for HAF where ground travel is legitimate.
  landingCutoffMs?: number | null;
  // Set when the landing cutoff voided at least one otherwise-valid crossing
  // (a turnpoint/goal crossing past the cutoff, or a whole suppressed
  // attempt). Surfaces as hasFlaggedCrossings (⚑) so admins can review the
  // truncation instead of it failing silently. Distance-only truncation
  // (no voided crossing) does not set it.
  truncationVoidedCrossing?: boolean;
}

/**
 * Stage 3: detectAttempts
 *
 * For each SSS boundary crossing (either direction — §6.2.1/§9.2.1 make the
 * crossing direction irrelevant, so entry-style starts work too):
 *   - Greedily match remaining TPs forward using segment-circle intersection
 *   - Build an AttemptTrace per SSS crossing
 */
export function detectAttempts(
  fixes: Fix[],
  task: TaskDefinition,
  competitionType: 'XC' | 'HIKE_AND_FLY',
): Result<AttemptTrace[], AttemptDetectionError> {
  if (task.turnpoints.length < 2) {
    return err({ code: 'NO_SSS_CROSSING', message: 'Task has fewer than 2 turnpoints' });
  }

  const sss = task.turnpoints[0];

  // ── Step 1: Find all SSS boundary crossings ─────────────────────────────────
  // FAI Sporting Code S7F §9.1.3 tolerance: a fix at distance d from the
  // cylinder centre is "inside" iff d ≤ r + tolerance. The boundary effectively
  // shifts outward by `tagToleranceM(r)` — pilots get the benefit of the doubt
  // near the boundary.
  //
  // §6.2.1/§9.2.1: a valid crossing is "into or out of the turnpoint's
  // tolerance zone, in any direction". Every boundary crossing — entry, exit,
  // or both legs of a graze-through — spawns an attempt; Stage 7 picks the
  // best, so extra attempts are harmless.
  //
  // Movement gate (XC only): an XC start is flown, not walked. A boundary
  // crossing only spawns an attempt when the crossing segment shows movement
  // — the faster of its two endpoint fixes is at least
  // SSS_CROSSING_MIN_SPEED_KMH. This ignores on-foot crossings (~4–6 km/h
  // walk-in to an entry-style start) and parked-drift crossings, which
  // previously anchored the landing scan at launch prep and silently zeroed
  // the whole flight; a walk-in track now gets the explicit NO_SSS_CROSSING
  // error again. Accepted edge: a pilot parked exactly on the boundary in
  // strong wind loses that particular crossing and starts on a later one. A
  // fix with an unknown speed passes the gate (benefit of the doubt). HAF is
  // exempt — travelling on foot is the point of the game there.
  const sssCrossings: Array<{ fixIndex: number; t: number; crossingTime: number }> = [];
  const sssEffectiveR = sss.radiusM + tagToleranceM(sss.radiusM);
  const applyMovementGate = competitionType === 'XC';

  for (let i = 0; i < fixes.length - 1; i++) {
    const a = fixes[i];
    const b = fixes[i + 1];
    const segmentMaxSpeed = Math.max(
      a.derivedSpeedKmh ?? Number.POSITIVE_INFINITY,
      b.derivedSpeedKmh ?? Number.POSITIVE_INFINITY,
    );
    if (applyMovementGate && segmentMaxSpeed < SSS_CROSSING_MIN_SPEED_KMH) continue;
    const aLocal = projectToLocal(a.lat, a.lng, sss.lat, sss.lng);
    const bLocal = projectToLocal(b.lat, b.lng, sss.lat, sss.lng);

    for (const t of segmentCircleBoundaryCrossings(aLocal, bLocal, sssEffectiveR)) {
      sssCrossings.push({ fixIndex: i, t, crossingTime: interpolateCrossingTime(a, b, t) });
    }
  }

  if (sssCrossings.length === 0) {
    return err({ code: 'NO_SSS_CROSSING', message: 'No SSS cylinder crossing was detected in the track' });
  }

  // XC: a landed pilot's later fixes (packing up, walking, car retrieve)
  // must not earn crossings or distance — §9.3 counts only points "where
  // the pilot is still flying", §12.1 only "up until the pilot landed".
  // The landing is GLOBAL to the track: the start of the first
  // landing-stillness window (≥ 30 s in which every fix is below 5 km/h
  // AND the gpsAlt range stays under 15 m — a glider parked in ridge lift
  // bobs in altitude; a landed pilot's GPS alt is flat within noise) that
  // begins at/after the FIRST valid SSS crossing. Anchoring at the first
  // crossing keeps pre-launch rigging stillness out of scope; using one
  // cutoff for every attempt means a post-landing retrieve that re-crosses
  // the SSS boundary can never spawn a scoreable attempt.
  // HAF is exempt: travelling on the ground is part of the game there.
  const landingCutoffMs =
    competitionType === 'XC'
      ? findLandingCutoffMs(fixes.filter((f) => f.timestamp >= sssCrossings[0].crossingTime))
      : null;

  // ── Step 2: For each SSS crossing, greedily match remaining TPs ────────────
  const attempts: AttemptTrace[] = [];
  // §12.1: the XC flight ended at the landing, so an SSS crossing at/after
  // the cutoff is on the ground and can never start a valid attempt. The
  // suppressed crossing itself passed the movement gate, so the suppression
  // voids an otherwise-valid crossing — flag the surviving attempts (⚑) so
  // the truncation is visible for review.
  let suppressedAttempt = false;

  for (let ai = 0; ai < sssCrossings.length; ai++) {
    const sssCross = sssCrossings[ai];
    if (landingCutoffMs !== null && sssCross.crossingTime >= landingCutoffMs) {
      suppressedAttempt = true;
      continue;
    }

    const sssCrossing: CylinderCrossing = {
      turnpointId: sss.id,
      sequenceIndex: sss.sequenceIndex,
      crossingTime: sssCross.crossingTime,
      segmentStartFix: fixes[sssCross.fixIndex],
      segmentEndFix: fixes[sssCross.fixIndex + 1],
      groundCheckRequired: false,
      detectedMaxSpeedKmh: null,
      groundConfirmed: true,
    };

    const turnpointCrossings: CylinderCrossing[] = [sssCrossing];
    let tpIdx = 1; // next TP to look for (0 = SSS already done)
    let reachedGoal = false;
    let essCrossing: CylinderCrossing | null = null;
    let goalCrossing: CylinderCrossing | null = null;

    // §9.2.1.2a: each crossing must be recorded strictly after the previous
    // cylinder's crossing (and hence after the start itself).
    let lastCrossingTimeMs = sssCrossing.crossingTime;

    // Set when the landing cutoff voids an otherwise-valid crossing for
    // this attempt — surfaces as ⚑ instead of a silent rescore.
    let truncationVoidedCrossing = false;

    // Pre-compute goal line bearing once per attempt (avoid re-running optimiseRoute per segment)
    const goalTp = task.turnpoints[task.turnpoints.length - 1];
    let cachedGoalBearing: number | undefined;
    if (goalTp?.type === 'GOAL_LINE') {
      cachedGoalBearing = goalTp.goalLineBearingDeg ?? undefined;
      if (cachedGoalBearing == null) {
        try {
          const cyls: Cylinder[] = task.turnpoints.map((t) => ({
            lat: t.lat,
            lng: t.lng,
            radiusM: t.radiusM,
            type: t.type,
          }));
          cachedGoalBearing = optimiseRoute(cyls).goalLineBearingDeg;
        } catch {
          const prevTp = task.turnpoints[task.turnpoints.length - 2];
          if (prevTp) {
            const prevLocal = projectToLocal(prevTp.lat, prevTp.lng, goalTp.lat, goalTp.lng);
            const inboundAngle = (Math.atan2(-prevLocal.x, -prevLocal.y) * 180) / Math.PI;
            cachedGoalBearing = (inboundAngle + 90 + 360) % 360;
          }
        }
      }
    }

    // Use while loop so we can re-check the same fix-pair after a TP is achieved.
    // The scan deliberately continues PAST the landing cutoff: a would-be
    // crossing found beyond it is voided (never recorded), but its existence
    // flags the attempt so the truncation is visible for review.
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

      // Apply FAI §9.1.3 tolerance to the inward tag detection. The boundary
      // is treated as r + tolerance for the in/out check; the optimised route
      // and partial-distance geometry continue to use the strict radius.
      const tolerance = tagToleranceM(tp.radiusM);
      const effectiveR = tp.radiusM + tolerance;

      if (tp.type === 'GOAL_LINE' && cachedGoalBearing != null) {
        const bearingDeg = cachedGoalBearing;
        // Per §9.1.3 tolerance applies separately to the chord and the
        // semi-circle. The chord gets a perpendicular "stadium" thickness
        // of `tolerance` (segmentNearGoalLine); the semi-circle gets the
        // same tolerance as a radius extension (effectiveR).
        const tChord = segmentNearGoalLine(aLocal, bLocal, { x: 0, y: 0 }, tp.radiusM, bearingDeg, tolerance);
        const tArc = segmentEntersGoalSemiCircle(aLocal, bLocal, { x: 0, y: 0 }, effectiveR, bearingDeg);
        if (tChord !== null || tArc !== null) {
          crossT = Math.min(tChord !== null ? tChord : Infinity, tArc !== null ? tArc : Infinity);
          crossed = true;
        }
      } else if (distA <= effectiveR) {
        // Already inside this cylinder (within tolerance) — immediately tagged.
        // §9.1.3 contract: a fix at distance d is "inside" iff d ≤ r + tolerance.
        crossT = 0;
        crossed = true;
      } else {
        // Look for inward crossing (outside → inside, or graze-through)
        const t = segmentIntersectsCircle(aLocal, bLocal, effectiveR);
        if (t !== null) {
          crossT = t;
          crossed = true;
        }
      }

      if (crossed && crossT !== null) {
        let crossingTime = interpolateCrossingTime(a, b, crossT);
        // §9.2.1.2a: a crossing must be recorded strictly after the previous
        // cylinder's crossing (and hence after the start itself) — same-
        // segment re-checks and already-inside tags can otherwise stamp a
        // time at or before the previous crossing, shortening (or negating)
        // task time. A premature candidate does NOT abandon the segment:
        // §6.2.1 makes every boundary root a crossing in its own right, so
        // re-consult ALL of the segment's boundary roots and accept the
        // earliest one that postdates the previous crossing. This covers a
        // graze-through whose entry root is pre-start but whose exit root is
        // valid, and an already-inside segment-start fix where the pilot
        // exits the zone before the next fix. Only when no root on the
        // segment qualifies do we advance to the next fix (a pilot still
        // inside the cylinder then picks the tag up at the first fix that
        // postdates the previous crossing). GOAL_LINE candidates come from
        // chord/arc geometry rather than a cylinder boundary, so they have
        // no extra roots to retry.
        if (crossingTime <= lastCrossingTimeMs) {
          let retriedTime: number | null = null;
          if (tp.type !== 'GOAL_LINE') {
            for (const t of segmentCircleBoundaryCrossings(aLocal, bLocal, effectiveR)) {
              const candidateTime = interpolateCrossingTime(a, b, t);
              if (candidateTime > lastCrossingTimeMs) {
                retriedTime = candidateTime;
                break;
              }
            }
          }
          if (retriedTime === null) {
            fixI++;
            continue;
          }
          crossingTime = retriedTime;
        }

        // §9.3/§12.1: a crossing at/after the landing cutoff is on the
        // ground. It is otherwise valid (in order, past the gate), so void
        // it, flag the attempt for review, and stop — everything beyond the
        // landing is dead for scoring.
        if (landingCutoffMs !== null && crossingTime >= landingCutoffMs) {
          truncationVoidedCrossing = true;
          break;
        }

        const groundCheckRequired = tp.forceGround === true;
        const crossing: CylinderCrossing = {
          turnpointId: tp.id,
          sequenceIndex: tp.sequenceIndex,
          crossingTime,
          segmentStartFix: a,
          segmentEndFix: b,
          groundCheckRequired,
          detectedMaxSpeedKmh: null,
          groundConfirmed: !groundCheckRequired,
        };
        lastCrossingTimeMs = crossingTime;

        turnpointCrossings.push(crossing);

        if (tp.type === 'ESS') essCrossing = crossing;

        const isGoal = tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE';
        if (isGoal) {
          goalCrossing = crossing;
          reachedGoal = true;
          tpIdx++;
          break; // done for this attempt
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
    const taskTimeS = timingCrossing !== null ? (timingCrossing.crossingTime - sssCrossing.crossingTime) / 1000 : null;

    attempts.push({
      // attempts.length, not the crossing index: suppressed crossings leave
      // gaps in `ai`, and attemptIndex must stay contiguous for persistence.
      attemptIndex: attempts.length,
      sssCrossing,
      essCrossing,
      goalCrossing,
      turnpointCrossings,
      reachedGoal,
      lastTurnpointIndex,
      taskTimeS,
      distanceFlownKm: 0, // populated by calculateDistances
      landingCutoffMs,
      truncationVoidedCrossing,
    });
  }

  if (attempts.length === 0) {
    // Every gate-passing SSS crossing postdated the landing — degenerate,
    // but surface the same explicit error a crossing-free track gets.
    return err({
      code: 'NO_SSS_CROSSING',
      message: 'No SSS cylinder crossing was detected before the landing',
    });
  }

  if (suppressedAttempt) {
    // A whole attempt was voided by the landing cutoff — make the
    // suppression visible on everything that survives.
    for (const attempt of attempts) attempt.truncationVoidedCrossing = true;
  }

  return ok(attempts);
}

// =============================================================================
// STAGE 3a: GEOMETRY ENGINE
// =============================================================================

export interface Point2D {
  x: number;
  y: number;
}
export interface Segment2D {
  a: Point2D;
  b: Point2D;
}

/**
 * Project WGS84 lat/lng to a local flat plane centred on origin.
 * Uses equirectangular approximation — accurate for distances < 20km.
 */
export function projectToLocal(lat: number, lng: number, originLat: number, originLng: number): Point2D {
  const R = 6371000;
  const x = R * (lng - originLng) * (Math.PI / 180) * Math.cos((originLat * Math.PI) / 180);
  const y = R * (lat - originLat) * (Math.PI / 180);
  return { x, y };
}

/**
 * Does segment A→B intersect a circle of radius r centred at origin (0,0)?
 * Returns the interpolation parameter t ∈ [0,1] of the first intersection,
 * or null if no intersection.
 */
export function segmentIntersectsCircle(a: Point2D, b: Point2D, r: number): number | null {
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
 * Every parameter t ∈ [0,1] at which segment A→B crosses the boundary of a
 * circle of radius r centred at origin, in ascending order (0, 1, or 2
 * entries). Unlike `segmentIntersectsCircle`, this reports both legs of a
 * graze-through (both endpoints outside, segment clipping the circle) — each
 * root is a boundary crossing in its own right. A tangent touch (zero
 * discriminant) is not a crossing and yields no entries.
 */
export function segmentCircleBoundaryCrossings(a: Point2D, b: Point2D, r: number): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const qa = dx * dx + dy * dy;
  if (qa === 0) return [];
  const qb = 2 * (a.x * dx + a.y * dy);
  const qc = a.x * a.x + a.y * a.y - r * r;
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return [];
  const sqrtDisc = Math.sqrt(disc);
  return [(-qb - sqrtDisc) / (2 * qa), (-qb + sqrtDisc) / (2 * qa)].filter((t) => t >= 0 && t <= 1);
}

/**
 * Does segment A→B cross a finite goal line?
 * Goal line is defined by its midpoint, half-length, and bearing (degrees from north).
 */
export function segmentIntersectsGoalLine(
  a: Point2D,
  b: Point2D,
  lineMidpoint: Point2D,
  halfLengthM: number,
  bearingDeg: number,
): number | null {
  // Build goal line endpoints from bearing and half-length
  const rad = (bearingDeg * Math.PI) / 180;
  const dx = Math.sin(rad) * halfLengthM;
  const dy = Math.cos(rad) * halfLengthM;
  const p1: Point2D = { x: lineMidpoint.x - dx, y: lineMidpoint.y - dy };
  const p2: Point2D = { x: lineMidpoint.x + dx, y: lineMidpoint.y + dy };

  // Segment-segment intersection: A + t*(B-A) = P1 + u*(P2-P1)
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const p2p1x = p2.x - p1.x;
  const p2p1y = p2.y - p1.y;
  const denom = bax * p2p1y - bay * p2p1x;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const p1ax = p1.x - a.x;
  const p1ay = p1.y - a.y;
  const t = (p1ax * p2p1y - p1ay * p2p1x) / denom;
  const u = (p1ax * bay - p1ay * bax) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}

/**
 * Does segment A→B enter the goal-line "stadium"?
 *
 * Per FAI §9.1.3 the chord gets its own benefit-of-doubt tolerance applied
 * separately from the semi-circle. Treating that tolerance as a perpendicular
 * thickness — i.e. the chord becomes a "stadium" (chord segment Minkowski-
 * summed with a disk of radius toleranceM) — handles two cases that bare
 * line-line intersection misses:
 *   - a track segment ending just short of the chord (GPS noise)
 *   - a track segment passing parallel to the chord at < tolerance offset.
 *
 * Returns the smallest t ∈ [0,1] on A→B at which the segment first enters
 * the stadium (matching the entry-time semantics of `segmentIntersectsCircle`
 * and `segmentEntersGoalSemiCircle`), or null if no point on A→B is within
 * tolerance of the chord. Returns 0 if A is already inside the stadium.
 */
export function segmentNearGoalLine(
  a: Point2D,
  b: Point2D,
  lineMidpoint: Point2D,
  halfLengthM: number,
  bearingDeg: number,
  toleranceM: number,
): number | null {
  // Rotate into a local frame where the chord lies along the x-axis from
  // (-L, 0) to (+L, 0). Bearing is clockwise from north → chord direction
  // unit vector is (sin, cos); the perpendicular (rotated -90° so positive
  // y is "right of the chord direction") is (cos, -sin).
  const rad = (bearingDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = Math.cos(rad);
  const px = uy;
  const py = -ux;
  const toLocal = (pt: Point2D): Point2D => {
    const dx = pt.x - lineMidpoint.x;
    const dy = pt.y - lineMidpoint.y;
    return { x: dx * ux + dy * uy, y: dx * px + dy * py };
  };

  const A = toLocal(a);
  const B = toLocal(b);
  const L = halfLengthM;
  const tol = toleranceM;
  const tol2 = tol * tol;

  // The stadium = {(x, y) | distance((x, y), chord segment) ≤ tol}, which
  // decomposes into a 2L × 2*tol rectangle plus two end-cap disks of
  // radius tol centred at (±L, 0).
  const insideStadium = (p: Point2D): boolean => {
    if (Math.abs(p.x) <= L) return Math.abs(p.y) <= tol;
    const dxCap = p.x > L ? p.x - L : p.x + L;
    return dxCap * dxCap + p.y * p.y <= tol2;
  };

  if (insideStadium(A)) return 0;

  // Collect every t ∈ [0,1] at which AB crosses the stadium boundary, then
  // return the earliest. The boundary has 4 pieces:
  //   - top edge:    y = +tol, |x| ≤ L
  //   - bottom edge: y = -tol, |x| ≤ L
  //   - right cap:   (x - L)² + y² = tol², x ≥ L
  //   - left cap:    (x + L)² + y² = tol², x ≤ -L
  const dxAB = B.x - A.x;
  const dyAB = B.y - A.y;
  const candidates: number[] = [];

  // Top / bottom edges
  if (dyAB !== 0) {
    for (const yEdge of [tol, -tol]) {
      const t = (yEdge - A.y) / dyAB;
      if (t < 0 || t > 1) continue;
      const xAtT = A.x + t * dxAB;
      if (xAtT >= -L && xAtT <= L) candidates.push(t);
    }
  }

  // End caps (right at x = L, left at x = -L)
  const a2 = dxAB * dxAB + dyAB * dyAB;
  if (a2 >= 1e-12) {
    for (const xCenter of [-L, L]) {
      const b2 = 2 * ((A.x - xCenter) * dxAB + A.y * dyAB);
      const c2 = (A.x - xCenter) * (A.x - xCenter) + A.y * A.y - tol2;
      const disc = b2 * b2 - 4 * a2 * c2;
      if (disc < 0) continue;
      const sqd = Math.sqrt(disc);
      for (const t of [(-b2 - sqd) / (2 * a2), (-b2 + sqd) / (2 * a2)]) {
        if (t < 0 || t > 1) continue;
        const xAtT = A.x + t * dxAB;
        // Only count the part of each disk that lives outside the rectangle —
        // the half inside is already covered by the top/bottom edges and
        // counting it would yield a t past the actual boundary.
        if (xCenter === -L && xAtT > -L) continue;
        if (xCenter === L && xAtT < L) continue;
        candidates.push(t);
      }
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/**
 * Does segment A→B enter the semi-circular portion of the goal control zone?
 *
 * Per CIVL GAP 2025 §6.2.3.1, the full goal OZ is a D-shape: the chord (goal
 * line) plus a semi-circle of radius r on the OUTBOUND side (away from p —
 * "behind the goal line when coming from p"). This function detects entry
 * through the curved arc boundary so pilots who reach the D from any direction
 * (e.g. approaching from past the goal) are still scored correctly.
 *
 * bearingDeg is the goal LINE bearing (perpendicular to the inbound track).
 */
export function segmentEntersGoalSemiCircle(
  a: Point2D,
  b: Point2D,
  centre: Point2D,
  radiusM: number,
  bearingDeg: number,
): number | null {
  // The semi-circle is on the OUTBOUND side — behind the goal line when coming
  // from p (CIVL GAP 2025 §6.2.3.1). "Behind" means the far side from p: the
  // side the pilot is on *after* crossing the chord.
  // direction from goal centre toward prev TP = goalLineBearing + 90°
  // outbound = opposite direction, so dot product with towardPrev must be < 0
  const towardPrevRad = (((bearingDeg + 90) % 360) * Math.PI) / 180;
  const tpx = Math.sin(towardPrevRad);
  const tpy = Math.cos(towardPrevRad);
  const onOutboundSide = (px: number, py: number) => px * tpx + py * tpy < 0;

  // Work in centre-relative coordinates
  const ax = a.x - centre.x,
    ay = a.y - centre.y;
  const bx = b.x - centre.x,
    by = b.y - centre.y;
  const dx = bx - ax,
    dy = by - ay;

  // Already inside the semi-circle at point A
  if (ax * ax + ay * ay <= radiusM * radiusM && onOutboundSide(ax, ay)) return 0;

  // Find intersections of the segment with the bounding circle
  const A2 = dx * dx + dy * dy;
  if (A2 < 1e-10) return null;
  const B2 = 2 * (ax * dx + ay * dy);
  const C2 = ax * ax + ay * ay - radiusM * radiusM;
  const disc = B2 * B2 - 4 * A2 * C2;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  // Check entry (t1) then exit (t2); return earliest crossing on the outbound arc
  for (const t of [(-B2 - sqrtDisc) / (2 * A2), (-B2 + sqrtDisc) / (2 * A2)]) {
    if (t < 0 || t > 1) continue;
    if (onOutboundSide(ax + t * dx, ay + t * dy)) return t;
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
export function geodesicDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const DEG = Math.PI / 180;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =============================================================================
// STAGE 4: GROUND STATE CLASSIFICATION (Hike & Fly only)
// =============================================================================

const SUSTAINED_STILLNESS_WINDOW_S = 20;
const SUSTAINED_STILLNESS_SPEED_KMH = 5;
// XC landing detection (Stage 3). Deliberately stricter than HAF ground
// confirmation: a HAF false negative merely flags a crossing for review,
// whereas an XC landing false positive silently discards flight. The longer
// window plus altitude flatness keeps a glider parked in ridge lift (steady
// 0–4 km/h ground speed but bobbing in lift) from reading as landed.
const LANDING_STILLNESS_WINDOW_S = 30;
const LANDING_MAX_ALT_RANGE_M = 15;
// Stage 3 movement gate: minimum endpoint ground speed for an SSS boundary
// crossing to spawn an attempt. Walking pace is ~4–6 km/h; slow flight in
// wind stays comfortably above this.
const SSS_CROSSING_MIN_SPEED_KMH = 8;
const EARTH_RADIUS_M = 6_371_000;
const DEG_RAD = Math.PI / 180;

export type GroundState = 'GROUND' | 'AIRBORNE' | 'UNKNOWN';

/** Haversine distance from a GPS fix to a turnpoint centre, in metres. */
function fixDistanceToTpM(fix: Fix, tp: TurnpointDef): number {
  const dLat = (fix.lat - tp.lat) * DEG_RAD;
  const dLng = (fix.lng - tp.lng) * DEG_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(tp.lat * DEG_RAD) * Math.cos(fix.lat * DEG_RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Start timestamp of the first continuous run of at least
 * SUSTAINED_STILLNESS_WINDOW_S seconds in which every fix has ground speed
 * below SUSTAINED_STILLNESS_SPEED_KMH, or null if the fixes contain no such
 * run. Expects fixes in ascending time order.
 *
 * Stage 4 uses this to confirm a HAF touch-down inside a force-ground
 * cylinder. Stage 3's XC landing detection uses the stricter
 * `findLandingCutoffMs` instead — see the constants above for why the two
 * signatures differ.
 */
function findSustainedStillnessStartMs(fixes: Fix[]): number | null {
  const windowMs = SUSTAINED_STILLNESS_WINDOW_S * 1000;
  let runStart: number | null = null;
  for (const f of fixes) {
    const speed = f.derivedSpeedKmh ?? Number.POSITIVE_INFINITY;
    if (speed < SUSTAINED_STILLNESS_SPEED_KMH) {
      if (runStart === null) runStart = f.timestamp;
      else if (f.timestamp - runStart >= windowMs) return runStart;
    } else {
      runStart = null;
    }
  }
  return null;
}

/**
 * Does the fix sequence contain a continuous run of at least
 * SUSTAINED_STILLNESS_WINDOW_S seconds where every fix has ground speed
 * below SUSTAINED_STILLNESS_SPEED_KMH? Expects fixes in ascending time order.
 */
function hasSustainedStillness(fixes: Fix[]): boolean {
  return findSustainedStillnessStartMs(fixes) !== null;
}

/**
 * XC landing detection: start timestamp of the first landing-stillness
 * window in the fix sequence, or null when the pilot never landed on camera.
 *
 * A landing-stillness window is ≥ LANDING_STILLNESS_WINDOW_S seconds in
 * which EVERY fix has ground speed below SUSTAINED_STILLNESS_SPEED_KMH AND
 * the gpsAlt spread across the window is under LANDING_MAX_ALT_RANGE_M.
 * Speed alone false-positives on a glider parked in strong laminar wind
 * (steady 0–4 km/h over the ground); the altitude-flatness requirement
 * breaks that case, because a parked glider rides the lift band up and down
 * while a landed pilot's GPS altitude is flat within receiver noise.
 *
 * The caller pre-filters the fixes to those at/after the first valid SSS
 * crossing, so a window straddling that boundary only counts from its
 * post-crossing portion. Expects fixes in ascending time order.
 */
function findLandingCutoffMs(fixes: Fix[]): number | null {
  const windowMs = LANDING_STILLNESS_WINDOW_S * 1000;

  // Walk the low-speed runs; within each, look for the earliest sub-window
  // that satisfies both the duration and the altitude-flatness constraints.
  let runStartIdx: number | null = null;
  for (let i = 0; i <= fixes.length; i++) {
    const isStill =
      i < fixes.length && (fixes[i].derivedSpeedKmh ?? Number.POSITIVE_INFINITY) < SUSTAINED_STILLNESS_SPEED_KMH;
    if (isStill) {
      if (runStartIdx === null) runStartIdx = i;
      continue;
    }
    if (runStartIdx !== null) {
      const start = earliestFlatWindowStartMs(fixes, runStartIdx, i - 1, windowMs);
      if (start !== null) return start;
      runStartIdx = null;
    }
  }
  return null;
}

/**
 * Earliest window start within fixes[lo..hi] (an all-below-stillness-speed
 * run) whose duration reaches windowMs while the gpsAlt spread stays under
 * LANDING_MAX_ALT_RANGE_M, or null. O(run × window) — runs are seconds-to-
 * minutes of 1 Hz fixes, so this is cheap.
 */
function earliestFlatWindowStartMs(fixes: Fix[], lo: number, hi: number, windowMs: number): number | null {
  for (let i = lo; i <= hi; i++) {
    let minAlt = fixes[i].gpsAlt;
    let maxAlt = fixes[i].gpsAlt;
    for (let j = i + 1; j <= hi; j++) {
      minAlt = Math.min(minAlt, fixes[j].gpsAlt);
      maxAlt = Math.max(maxAlt, fixes[j].gpsAlt);
      if (maxAlt - minAlt >= LANDING_MAX_ALT_RANGE_M) break; // this start can't flatten out again
      if (fixes[j].timestamp - fixes[i].timestamp >= windowMs) return fixes[i].timestamp;
    }
  }
  return null;
}

/**
 * Stage 4: classifyGroundState
 *
 * For HAF tasks, some turnpoints are force-ground — the pilot must touch
 * down somewhere inside the cylinder. Both entry and exit may be airborne
 * (fly in, land on a hillside, relaunch) as long as the track shows them
 * on the ground at some point inside.
 *
 * To distinguish an actual touch-down from a paraglider hovering in a
 * steady headwind (low ground speed but still flying), we look for a
 * *sustained stillness* signature: a continuous 20-second window where
 * every fix inside the cylinder has ground speed < 5 km/h. GPS-speed
 * jitter and shifting wind make such a window very hard to fake in the
 * air, and easy to satisfy on the ground.
 *
 * True per-fix AGL would be more rigorous but requires DEM lookup (see
 * issue backlog); for our league-scale use case stillness is plenty.
 *
 * XC tasks pass through unchanged.
 */
export function classifyGroundState(
  fixes: Fix[],
  attempts: AttemptTrace[],
  competitionType: 'XC' | 'HIKE_AND_FLY',
  task: TaskDefinition,
): AttemptTrace[] {
  if (competitionType === 'XC') return attempts;
  const tpById = new Map(task.turnpoints.map((tp) => [tp.id, tp]));
  return attempts.map((attempt) => ({
    ...attempt,
    turnpointCrossings: attempt.turnpointCrossings.map((crossing) => {
      if (!crossing.groundCheckRequired) return crossing;
      const tp = tpById.get(crossing.turnpointId);
      if (!tp) return { ...crossing, groundConfirmed: false };

      // Fixes that are geographically inside the cylinder after the crossing.
      // Use the same effective radius as the tag-detection step so a pilot
      // who tagged "within tolerance" has their fixes counted for the
      // ground-state check too.
      const groundCheckR = tp.radiusM + tagToleranceM(tp.radiusM);
      const insideFixes = fixes.filter(
        (f) => f.timestamp >= crossing.crossingTime && fixDistanceToTpM(f, tp) <= groundCheckR,
      );

      // Slowest observed ground speed — informational, stored on the crossing.
      const minSpeed = insideFixes.reduce(
        (m, f) => Math.min(m, f.derivedSpeedKmh ?? Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      );
      const resolvedMin = Number.isFinite(minSpeed) ? minSpeed : null;

      return {
        ...crossing,
        // Field is named `detectedMaxSpeedKmh` for backward compatibility with
        // existing DB column `detected_max_speed_kmh`; it now stores the minimum
        // ground speed observed inside the cylinder. Rename tracked in #26.
        detectedMaxSpeedKmh: resolvedMin,
        groundConfirmed: hasSustainedStillness(insideFixes),
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
export function calculateDistances(attempts: AttemptTrace[], fixes: Fix[], task: TaskDefinition): AttemptTrace[] {
  if (task.turnpoints.length < 2) return attempts;

  const cylinders: Cylinder[] = task.turnpoints.map((tp) => ({
    lat: tp.lat,
    lng: tp.lng,
    radiusM: tp.radiusM,
    type: tp.type,
    forceGround: tp.forceGround,
    goalLineBearingDeg: tp.goalLineBearingDeg,
  }));

  let route: OptimisedRoute;
  try {
    route = optimiseRoute(cylinders);
  } catch {
    return attempts.map((a) => ({ ...a, distanceFlownKm: 0 }));
  }

  return attempts.map((attempt) => {
    if (attempt.reachedGoal) {
      return { ...attempt, distanceFlownKm: route.totalDistanceKm };
    }

    const sssTime = attempt.sssCrossing.crossingTime;
    // §9.3 sweeps only points "where the pilot is still flying": lower-bound
    // the scan at this attempt's start and upper-bound it at the landing
    // cutoff detectAttempts found (null for HAF and for pilots who never went
    // still), so retrieve fixes can't shrink the remaining distance.
    const cutoffMs = attempt.landingCutoffMs ?? null;
    const pilotFixes = fixes
      .filter((f) => f.timestamp >= sssTime && (cutoffMs === null || f.timestamp < cutoffMs))
      .map((f) => ({ lat: f.lat, lng: f.lng, timestamp: f.timestamp }));

    // FAI §9.3: feed the ordered (sequenceIndex, crossingTime) pairs so the
    // distance routine can advance reachedIdx fix-by-fix.
    const crossings = attempt.turnpointCrossings.map((c) => ({
      sequenceIndex: c.sequenceIndex,
      crossingTime: c.crossingTime,
    }));

    const dist = computePartialDistanceKm(route, cylinders, crossings, pilotFixes);
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
 * Time points (goal pilots only) — FAI S7F §12.2:
 *   timePoints = MAX_POINTS * max(0, 1 - ((t_pilot - t_best) / sqrt(t_best)) ^ (5/6))
 *   (times in hours; t_best = fastest goal time; sole finisher gets MAX_POINTS)
 */
export function scoreAttempts(
  attempts: AttemptTrace[],
  existingGoalTimesS: number[],
  taskBestDistanceKm: number,
): ScoredAttempt[] {
  // Collect goal task times including this submission's attempts
  const newGoalTimesS = attempts.filter((a) => a.reachedGoal && a.taskTimeS !== null).map((a) => a.taskTimeS!);
  const allGoalTimesS = [...existingGoalTimesS, ...newGoalTimesS];

  // Best distance across all pilots including this submission
  const thisBestDist = Math.max(taskBestDistanceKm, ...attempts.map((a) => a.distanceFlownKm));

  return attempts.map((attempt) => {
    const dist = attempt.distanceFlownKm;
    const bestDist = Math.max(thisBestDist, dist);

    const distancePoints = computeDistancePoints(dist, bestDist, attempt.reachedGoal);
    const timePoints =
      attempt.reachedGoal && attempt.taskTimeS !== null ? computeTimePoints(attempt.taskTimeS, allGoalTimesS) : 0;

    return {
      attemptIndex: attempt.attemptIndex,
      sssCrossing: attempt.sssCrossing,
      essCrossing: attempt.essCrossing,
      goalCrossing: attempt.goalCrossing,
      turnpointCrossings: attempt.turnpointCrossings,
      reachedGoal: attempt.reachedGoal,
      lastTurnpointIndex: attempt.lastTurnpointIndex,
      taskTimeS: attempt.taskTimeS,
      distanceFlownKm: dist,
      distancePoints,
      timePoints,
      totalPoints: distancePoints + timePoints,
      // ⚑ for review: a HAF ground check failed, or the XC landing cutoff
      // voided an otherwise-valid crossing (truncation must not be silent).
      hasFlaggedCrossings:
        attempt.turnpointCrossings.some((c) => c.groundCheckRequired && !c.groundConfirmed) ||
        attempt.truncationVoidedCrossing === true,
    };
  });
}

/**
 * Rescore: recalculate time points for all goal attempts on a task.
 */
export function rescoreTimePoints(allTaskAttempts: ScoredAttempt[]): ScoredAttempt[] {
  const goalTimes = allTaskAttempts.filter((a) => a.reachedGoal && a.taskTimeS !== null).map((a) => a.taskTimeS!);

  return allTaskAttempts.map((attempt) => {
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

    if (candidate.reachedGoal && !current.reachedGoal) {
      bestIdx = i;
      continue;
    }
    if (!candidate.reachedGoal && current.reachedGoal) {
      continue;
    }
    if (candidate.totalPoints > current.totalPoints) {
      bestIdx = i;
      continue;
    }
    if (
      candidate.totalPoints === current.totalPoints &&
      candidate.taskTimeS !== null &&
      current.taskTimeS !== null &&
      candidate.taskTimeS < current.taskTimeS
    ) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

// =============================================================================
// PIPELINE ORCHESTRATOR
// =============================================================================

export type PipelineError =
  | { stage: 'PARSE'; error: ParseError }
  | { stage: 'DATE'; error: DateValidationError }
  | { stage: 'DETECTION'; error: AttemptDetectionError };

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
  taskBestDistanceKm: number,
): Promise<Result<PipelineResult, PipelineError>> {
  const parseResult = parseAndValidate(input.igcText);
  if (!parseResult.ok) return err({ stage: 'PARSE', error: parseResult.error });
  return runPipelineFromParsed(parseResult.value, input, taskOpenDate, taskCloseDate, taskBestDistanceKm);
}

/**
 * Run stages 2-7 against an already-parsed track. Use this when the caller
 * already has a `ParsedTrack` in hand and would otherwise pay the IGC parse
 * cost a second time. The client-side preview is the only current caller —
 * it needs the parsed `fixes` for the map overlay AND the scored result,
 * and parsing a 1-Hz multi-hour track twice dominates preview latency.
 */
export async function runPipelineFromParsed(
  track: ParsedTrack,
  input: PipelineInput,
  taskOpenDate: string,
  taskCloseDate: string,
  taskBestDistanceKm: number,
): Promise<Result<PipelineResult, PipelineError>> {
  // Stage 2: Date validation
  const dateResult = validateFlightDate(track, taskOpenDate, taskCloseDate);
  if (!dateResult.ok) return err({ stage: 'DATE', error: dateResult.error });

  // Stage 3: Attempt detection
  const detectionResult = detectAttempts(track.fixes, input.task, input.competitionType);
  if (!detectionResult.ok) return err({ stage: 'DETECTION', error: detectionResult.error });
  let attempts = detectionResult.value;

  // Stage 4: Ground state (hike & fly only — no-op for XC)
  attempts = classifyGroundState(track.fixes, attempts, input.competitionType, input.task);

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
        case 'MISSING_DATE_HEADER':
          return 'Your IGC file is missing a valid date header (HFDTE). Please check your flight recorder settings.';
        case 'NO_VALID_FIXES':
          return 'Your IGC file contains no valid GPS fixes. The file may be corrupt.';
        case 'NON_MONOTONIC_TIME':
          return 'Your IGC file contains timestamps that go backwards. The file may be corrupt.';
        case 'INSUFFICIENT_DURATION':
          return `Your IGC file contains less than 2 minutes of valid fixes (${error.error.durationS}s found). Please check your recorder logged the full flight.`;
        case 'PARSE_FAILURE':
          return 'Your IGC file could not be read. Please ensure it is a valid IGC file.';
      }
      break;
    case 'DATE':
      switch (error.error.code) {
        case 'FLIGHT_DATE_OUTSIDE_TASK_WINDOW':
          return `Your flight date (${error.error.flightDate}) is outside the task window (${error.error.taskOpen} – ${error.error.taskClose}).`;
      }
      break;
    case 'DETECTION':
      switch (error.error.code) {
        case 'NO_SSS_CROSSING':
          return 'No valid start cylinder crossing was detected in your track. Make sure you crossed the start cylinder before heading to the first turnpoint.';
      }
      break;
  }
  return 'An unexpected scoring error occurred.';
}
