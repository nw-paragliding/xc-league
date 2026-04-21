// =============================================================================
// Task Engine — shared task geometry and GAP scoring
//
// Pure TypeScript, no runtime dependencies.
// Used by both the Node.js backend (scoring, pipeline) and the
// Vite/React frontend (map rendering, distance display).
// =============================================================================

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
 * Uses the angle-bisector of directions from centre to each neighbour.
 * This is exact for the "miss" case (line prev→next doesn't intersect the
 * cylinder) and converges to the exact solution under iteration for the
 * "hit" case (line intersects the cylinder).
 */
function optimalInteriorPoint(c: Vec2, r: number, prev: Vec2, next: Vec2): Vec2 {
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
// PARTIAL DISTANCE  (non-goal pilots)
// Compute best achieved distance along the optimal route for a pilot who
// did not reach goal, given their GPS track from the SSS crossing onward.
// =============================================================================

export function computePartialDistanceKm(
  route: OptimisedRoute,
  cylinders: Cylinder[],
  lastTpIdx: number, // index of last TP achieved (0 = only SSS crossed)
  pilotFixes: Array<{ lat: number; lng: number }>,
): number {
  const n = cylinders.length;

  const completedKm = route.legDistancesKm.slice(0, lastTpIdx).reduce((s, d) => s + d, 0);

  if (lastTpIdx >= n - 1) return route.totalDistanceKm;

  // Project into local flat space
  const oLat = cylinders.reduce((s, c) => s + c.lat, 0) / n;
  const oLng = cylinders.reduce((s, c) => s + c.lng, 0) / n;

  const lastLocal = project(route.touchPoints[lastTpIdx].lat, route.touchPoints[lastTpIdx].lng, oLat, oLng);
  const nextLocal = project(route.touchPoints[lastTpIdx + 1].lat, route.touchPoints[lastTpIdx + 1].lng, oLat, oLng);

  const legDir = normalise(sub(nextLocal, lastLocal));
  const legLenM = route.legDistancesKm[lastTpIdx] * 1000;

  let bestM = 0;
  for (const fix of pilotFixes) {
    const fixLocal = project(fix.lat, fix.lng, oLat, oLng);
    const dot = (fixLocal.x - lastLocal.x) * legDir.x + (fixLocal.y - lastLocal.y) * legDir.y;
    const clamped = Math.max(0, Math.min(legLenM, dot));
    if (clamped > bestM) bestM = clamped;
  }

  return completedKm + bestM / 1000;
}

// =============================================================================
// GAP SCORING  (no validity, no lead-out)
// =============================================================================

export const MAX_POINTS = 1000;

/**
 * Distance points for one pilot.
 *   Goal:     MAX_POINTS
 *   Non-goal: MAX_POINTS * sqrt(dist / bestDist)
 */
export function computeDistancePoints(distKm: number, bestDistKm: number, reachedGoal: boolean): number {
  if (reachedGoal) return MAX_POINTS;
  if (bestDistKm <= 0) return 0;
  return Math.round(MAX_POINTS * Math.sqrt(distKm / bestDistKm) * 10) / 10;
}

/**
 * Time points for one goal pilot.
 *   Sole finisher or all same time: MAX_POINTS
 *   Otherwise: MAX_POINTS * (1 - ((t - t_min) / (t_max - t_min)) ^ (2/3))
 *
 * @param taskTimeS      This pilot's task time in seconds
 * @param allGoalTimesS  All goal pilots' task times including this one
 */
export function computeTimePoints(taskTimeS: number, allGoalTimesS: number[]): number {
  if (allGoalTimesS.length === 0) return MAX_POINTS;
  const tMin = Math.min(...allGoalTimesS);
  const tMax = Math.max(...allGoalTimesS);
  if (tMin === tMax) return MAX_POINTS;
  const ratio = (taskTimeS - tMin) / (tMax - tMin);
  return Math.round(MAX_POINTS * (1 - ratio ** (2 / 3)) * 10) / 10;
}
