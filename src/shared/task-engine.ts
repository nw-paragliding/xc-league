// =============================================================================
// Task Engine — shared task geometry and GAP scoring
//
// Pure TypeScript, no runtime dependencies.
// Used by both the Node.js backend (scoring, pipeline) and the
// Vite/React frontend (map rendering, distance display).
// =============================================================================

// =============================================================================
// FAI §9.1.1 cylinder tolerance (S7F 2025)
//
//   relativeTolerance = 0.1 %   (from GAP 2026: 0.0 %)
//   absoluteTolerance = 5 m
//   outerRadius = max(radius * (1 + relativeTolerance), radius + absoluteTolerance)
//
// i.e. the tolerance is max(5 m, 0.1 % of the radius). §9.1.3 applies the
// same tolerance separately to the goal-line chord and semi-circle. The
// boundary effectively shifts outward by `tagToleranceM(r)` — a fix at
// distance ≤ r + tolerance is considered inside. The optimised-route
// geometry continues to use the strict radius; tolerance only governs
// whether a track tags the cylinder.
// =============================================================================

export function tagToleranceM(radiusM: number): number {
  return Math.max(5, radiusM * 0.001);
}

// =============================================================================
// TYPES
// =============================================================================

export type CylinderRole = 'SSS' | 'CYLINDER' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE';

export interface Cylinder {
  lat: number;
  lng: number;
  radiusM: number;
  type: CylinderRole;
  forceGround?: boolean; // hike & fly: pilot must arrive on foot (any role)
  goalLineBearingDeg?: number;
}

export interface TouchPoint {
  lat: number;
  lng: number;
}

export interface OptimisedRoute {
  totalDistanceKm: number;
  legDistancesKm: number[]; // one per adjacent cylinder pair
  touchPoints: TouchPoint[]; // optimal boundary crossing point per cylinder, in order
  goalLineBearingDeg: number; // perpendicular to final inbound leg; 0 for cylinder goal
}

// =============================================================================
// INTERNAL VECTOR MATH  (equirectangular flat projection)
// =============================================================================

const EARTH_R_M = 6_371_000;
const DEG = Math.PI / 180;

interface Vec2 {
  x: number;
  y: number;
}

function project(lat: number, lng: number, oLat: number, oLng: number): Vec2 {
  return {
    x: EARTH_R_M * (lng - oLng) * DEG * Math.cos(oLat * DEG),
    y: EARTH_R_M * (lat - oLat) * DEG,
  };
}

function unproject(p: Vec2, oLat: number, oLng: number): TouchPoint {
  return {
    lat: oLat + p.y / EARTH_R_M / DEG,
    lng: oLng + p.x / EARTH_R_M / DEG / Math.cos(oLat * DEG),
  };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}
function norm(v: Vec2): number {
  return Math.sqrt(v.x ** 2 + v.y ** 2);
}
function normalise(v: Vec2): Vec2 {
  const n = norm(v);
  return n < 1e-10 ? { x: 0, y: 1 } : scale(v, 1 / n);
}
function dist2d(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Point on circle (centre c, radius r) in the direction of target t. */
function pointToward(c: Vec2, r: number, t: Vec2): Vec2 {
  return add(c, scale(normalise(sub(t, c)), r));
}

/** Closest point on segment p1→p2 to point q. */
function closestOnSegment(p1: Vec2, p2: Vec2, q: Vec2): Vec2 {
  const seg = sub(p2, p1);
  const len2 = seg.x ** 2 + seg.y ** 2;
  if (len2 === 0) return p1;
  const t = Math.max(0, Math.min(1, ((q.x - p1.x) * seg.x + (q.y - p1.y) * seg.y) / len2));
  return add(p1, scale(seg, t));
}

/**
 * Optimal interior point for cylinder i given fixed neighbours prev and next.
 *
 * There are two regimes:
 *   - "hit": the straight prev→next segment passes through the cylinder.
 *     Any point on that segment that lies inside the cylinder satisfies
 *     the touch requirement, and the optimal path is just the straight
 *     line — `prev → next` with no detour. The closest point on the
 *     segment to the centre is the canonical (tightest) pick and lets
 *     the iterative coordinate-descent settle on the chord.
 *   - "miss": the segment doesn't intersect the cylinder. The optimum is
 *     the boundary tangent point on the angle-bisector of directions from
 *     centre to each neighbour, which the existing fixed-point iteration
 *     converges to.
 *
 * Without the hit-case branch, the angle-bisector returns a boundary
 * tangent even when the cylinder is large enough that the straight chord
 * already touches it — over-counting distance and steering the rendered
 * optimised route around the cylinder it doesn't need to detour around.
 */
function optimalInteriorPoint(c: Vec2, r: number, prev: Vec2, next: Vec2): Vec2 {
  const closest = closestOnSegment(prev, next, c);
  if (dist2d(closest, c) <= r) return closest;

  const combined = add(normalise(sub(prev, c)), normalise(sub(next, c)));
  if (norm(combined) < 1e-10) {
    return add(c, scale(normalise(sub(prev, c)), r)); // diametrically opposite — use prev direction
  }
  return add(c, scale(normalise(combined), r));
}

// ── Goal line helpers ─────────────────────────────────────────────────────────

function inboundBearing(from: Vec2, to: Vec2): number {
  return ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360;
}

function goalLineBearing(inbound: number): number {
  return (inbound + 90) % 360;
}

function goalLineEndpoints(centre: Vec2, halfLenM: number, bearingDeg: number): [Vec2, Vec2] {
  const r = bearingDeg * DEG;
  const dir: Vec2 = { x: Math.sin(r), y: Math.cos(r) };
  return [sub(centre, scale(dir, halfLenM)), add(centre, scale(dir, halfLenM))];
}

// =============================================================================
// ROUTE OPTIMISATION
// Coordinate-descent over cylinder boundary crossing angles.
// Converges to the shortest path through the ordered sequence of cylinders.
// =============================================================================

const CONVERGENCE_M = 0.1;
const MAX_ITERS = 500;

export function optimiseRoute(cylinders: Cylinder[]): OptimisedRoute {
  const n = cylinders.length;
  if (n < 2) throw new Error('Task must have at least 2 cylinders');

  // Project centred on task centroid
  const oLat = cylinders.reduce((s, c) => s + c.lat, 0) / n;
  const oLng = cylinders.reduce((s, c) => s + c.lng, 0) / n;

  const centres = cylinders.map((c) => project(c.lat, c.lng, oLat, oLng));
  const radii = cylinders.map((c) => c.radiusM);
  const goalIsLine = cylinders[n - 1].type === 'GOAL_LINE';

  // Initialise: each boundary point facing its neighbour
  const pts: Vec2[] = new Array(n);
  pts[0] = pointToward(centres[0], radii[0], centres[1]);
  for (let i = 1; i < n - 1; i++) {
    pts[i] = pointToward(centres[i], radii[i], centres[i + 1]);
  }
  pts[n - 1] = goalIsLine ? { ...centres[n - 1] } : pointToward(centres[n - 1], radii[n - 1], centres[n - 2]);

  // Iterate until convergence
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const next: Vec2[] = [...pts];

    next[0] = pointToward(centres[0], radii[0], pts[1]);

    for (let i = 1; i < n - 1; i++) {
      next[i] = optimalInteriorPoint(centres[i], radii[i], pts[i - 1], pts[i + 1]);
    }

    if (goalIsLine) {
      const brg = goalLineBearing(inboundBearing(next[n - 2], centres[n - 1]));
      const [ep1, ep2] = goalLineEndpoints(centres[n - 1], radii[n - 1], brg);
      next[n - 1] = closestOnSegment(ep1, ep2, next[n - 2]);
    } else {
      next[n - 1] = pointToward(centres[n - 1], radii[n - 1], next[n - 2]);
    }

    const maxMove = pts.reduce((m, p, i) => Math.max(m, dist2d(p, next[i])), 0);
    for (let i = 0; i < n; i++) pts[i] = next[i];
    if (maxMove < CONVERGENCE_M) break;
  }

  // Build result
  const touchPoints = pts.map((p) => unproject(p, oLat, oLng));
  const legDistancesKm: number[] = [];
  let totalM = 0;
  for (let i = 0; i < n - 1; i++) {
    const legM = Math.max(0, dist2d(pts[i], pts[i + 1]));
    legDistancesKm.push(legM / 1000);
    totalM += legM;
  }

  const finalGoalLineBearing = goalIsLine ? goalLineBearing(inboundBearing(pts[n - 2], centres[n - 1])) : 0;

  return {
    totalDistanceKm: totalM / 1000,
    legDistancesKm,
    touchPoints,
    goalLineBearingDeg: finalGoalLineBearing,
  };
}

// =============================================================================
// DISTANCE HELPERS
// =============================================================================

/** Haversine distance in km between two WGS84 points. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Optimise a route and return its total distance in km. */
export function computeDistanceKm(cylinders: Cylinder[]): number {
  return optimiseRoute(cylinders).totalDistanceKm;
}

// =============================================================================
// FLOWN DISTANCE  (non-goal pilots) — FAI Sporting Code §9.3
//
// §9.3: "we determine for each point where the pilot is still flying the
//  remaining distance to goal from that point, considering any previously
//  reached control zones. For this the same method is used as for calculating
//  the task distance. Then we calculate the flight distance as the task
//  distance minus the smallest of those remaining distances."
//
// Algorithm: at every post-SSS fix, build the *remaining task* as
//   [fix-as-0-radius-cylinder, ...cylinders after the last reached one],
// run the route optimiser on it, and remember the smallest remaining
// distance seen. The pilot's flown distance is taskDistance minus that
// minimum.
//
// This supersedes the previous "project the fix onto the next leg's
// direction vector and clamp to legLen" approximation, which (a) hid all
// extra progress past an un-tagged next TP, and (b) over-credited tracks
// that drifted laterally off-line.
//
// The `crossings` argument carries the (sequenceIndex, crossingTime) pairs
// in time order, so the loop can keep `reachedIdx` in sync with each fix's
// timestamp in a single O(N) sweep.
// =============================================================================

export function computePartialDistanceKm(
  route: OptimisedRoute,
  cylinders: Cylinder[],
  crossings: Array<{ sequenceIndex: number; crossingTime: number }>,
  pilotFixes: Array<{ lat: number; lng: number; timestamp: number }>,
): number {
  if (pilotFixes.length === 0) return 0;
  const n = cylinders.length;
  if (n < 2) return 0;

  const taskKm = route.totalDistanceKm;

  // Walk crossings alongside the fix stream so reachedIdx tracks how many
  // cylinders the pilot has tagged by each fix's timestamp.
  let crossingPtr = 0;
  let reachedIdx = -1;
  let minRemainingKm = taskKm;

  for (const f of pilotFixes) {
    while (crossingPtr < crossings.length && crossings[crossingPtr].crossingTime <= f.timestamp) {
      const idx = crossings[crossingPtr].sequenceIndex;
      if (idx > reachedIdx) reachedIdx = idx;
      crossingPtr++;
    }

    // Goal-tagged attempts are handled by calculateDistances (it short-circuits
    // to the full route distance), but guard here too.
    if (reachedIdx >= n - 1) {
      minRemainingKm = 0;
      break;
    }

    // Defensive: when only GOAL remains and the fix is geographically inside
    // the goal cylinder, the pilot has effectively reached goal. Normally the
    // detector tags this directly (reachedGoal=true → handled upstream) but
    // if a missed goal tag leaks through, the 2-cylinder optimiseRoute would
    // route from the 0-radius anchor to the goal-boundary touch point on the
    // near side and report a small positive remaining distance — under-
    // crediting the pilot. Treat this case as 0 remaining explicitly.
    //
    // GOAL_LINE is excluded: §9.3 defines line-goal remaining distance as the
    // optimised distance to the goal *point* with no radius term, and for a
    // line radiusM holds the half line-length — proximity to the goal centre
    // says nothing about having crossed the line (a fix 150 m short on the
    // near side is within radiusM but has 150 m still to fly). The unguarded
    // optimiser path below already computes exactly the §9.3 line formula.
    if (reachedIdx === n - 2) {
      const goal = cylinders[n - 1];
      if (goal.type !== 'GOAL_LINE' && haversineKm(f.lat, f.lng, goal.lat, goal.lng) * 1000 <= goal.radiusM) {
        minRemainingKm = 0;
        break;
      }
    }

    // Remaining task: pilot's current point as a 0-radius "cylinder" anchor,
    // followed by every cylinder the pilot has not yet tagged (including
    // GOAL). Run the same route optimiser used for the task itself.
    const start: Cylinder = { lat: f.lat, lng: f.lng, radiusM: 0, type: 'CYLINDER' };
    const remaining: Cylinder[] = [start, ...cylinders.slice(reachedIdx + 1)];

    let remDistKm: number;
    try {
      remDistKm = optimiseRoute(remaining).totalDistanceKm;
    } catch {
      continue;
    }

    if (remDistKm < minRemainingKm) minRemainingKm = remDistKm;
  }

  return Math.max(0, taskKm - minRemainingKm);
}

// =============================================================================
// GAP SCORING  (no validity, no lead-out)
// =============================================================================

export const MAX_POINTS = 1000;

/**
 * FAI S7F §11 points allocation — goal-ratio-dependent distance/time split.
 *
 *   GoalRatio      = NumberOfPilotsInGoal / NumberOfPilotsFlying
 *   DistanceWeight = 0.9 - 1.665*GR + 1.713*GR² - 0.587*GR³
 *
 * Full FAI PG then carves the (1 - DistanceWeight) remainder into leading
 * (LeadingTimeRatio, default 26 %), arrival (0 for PG) and time weights:
 *   TimeWeight = 1 - DistanceWeight - LeadingWeight - ArrivalWeight
 *
 * This league deliberately drops leading and arrival points (see
 * src/shared/SCORING.md), so time absorbs the full remainder:
 *   TimeWeight = 1 - DistanceWeight
 *
 * Available points are the weights * MAX_POINTS. §11 rounds the available
 * pools to whole points; we keep full precision here because per-task
 * normalisation (rebuildTaskResults) rescales everything afterwards and the
 * S7F round-once principle puts the single rounding on the persisted value.
 */
export function goalRatioWeights(goalRatio: number): { distanceWeight: number; timeWeight: number } {
  const gr = Math.min(1, Math.max(0, goalRatio));
  const distanceWeight = 0.9 - 1.665 * gr + 1.713 * gr ** 2 - 0.587 * gr ** 3;
  const timeWeight = 1 - distanceWeight;
  return { distanceWeight, timeWeight };
}

/**
 * Distance points for one pilot.
 *   Goal:     availablePoints
 *   Non-goal: availablePoints * sqrt(dist / bestDist)
 *
 * `availablePoints` is the §11 AvailableDistancePoints pool
 * (DistanceWeight * 1000 — see goalRatioWeights). It defaults to MAX_POINTS
 * for isolated unit-test use; every production call site passes the
 * goal-ratio-weighted pool.
 *
 * Returns full precision — rounding to one decimal happens exactly once, on
 * the final persisted value after task-level normalisation
 * (rebuildTaskResults in src/job-queue.ts), per the S7F round-once principle.
 */
export function computeDistancePoints(
  distKm: number,
  bestDistKm: number,
  reachedGoal: boolean,
  availablePoints: number = MAX_POINTS,
): number {
  if (reachedGoal) return availablePoints;
  if (bestDistKm <= 0) return 0;
  return availablePoints * Math.sqrt(distKm / bestDistKm);
}

/**
 * Time points for one goal pilot — FAI Sporting Code S7F §12.2.
 *
 *   SpeedFraction = max(0, 1 - ((T - BestTime) / sqrt(BestTime)) ^ (5/6))
 *   TimePoints    = SpeedFraction * availablePoints
 *
 * Times in the formula are in HOURS (per the spec). BestTime is the fastest
 * task time among goal pilots. A pilot scores zero only when their time is at
 * or beyond BestTime + sqrt(BestTime) — an absolute cutoff anchored to the
 * winner's time, not to the slowest finisher.
 *
 * `availablePoints` is the §11 AvailableTimePoints pool
 * (TimeWeight * 1000 — see goalRatioWeights). It defaults to MAX_POINTS for
 * isolated unit-test use; every production call site passes the
 * goal-ratio-weighted pool.
 *
 * Returns full precision — see computeDistancePoints for where rounding
 * happens.
 *
 * @param taskTimeS       This pilot's task time in seconds
 * @param allGoalTimesS   All goal pilots' task times including this one
 * @param availablePoints AvailableTimePoints pool (defaults to MAX_POINTS)
 */
export function computeTimePoints(
  taskTimeS: number,
  allGoalTimesS: number[],
  availablePoints: number = MAX_POINTS,
): number {
  if (allGoalTimesS.length === 0) return availablePoints;
  const bestTimeH = Math.min(...allGoalTimesS) / 3600;
  if (bestTimeH <= 0) return taskTimeS <= 0 ? availablePoints : 0;
  const excessH = Math.max(0, taskTimeS / 3600 - bestTimeH);
  const speedFraction = Math.max(0, 1 - (excessH / Math.sqrt(bestTimeH)) ** (5 / 6));
  return availablePoints * speedFraction;
}
