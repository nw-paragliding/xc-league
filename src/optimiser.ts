// =============================================================================
// Task Optimiser
// Computes the shortest path through an ordered sequence of cylinders.
// Used for: task distance display, per-leg distances for partial scoring,
//           goal line bearing computation.
//
// Algorithm: Coordinate-descent over cylinder boundary crossing angles.
// Each iteration updates all crossing points; repeats until convergence.
// Runs in a local flat projection centred on the task centroid.
// =============================================================================

// geographiclib-geodesic used in pipeline.ts for fix distances.
// The optimiser uses equirectangular projection internally for speed.
const CONVERGENCE_THRESHOLD_M = 0.1;  // stop when no point moves more than this
const MAX_ITERATIONS = 500;           // safety cap — should converge in < 50 normally
const EARTH_RADIUS_M = 6371000;

// =============================================================================
// TYPES
// =============================================================================

export interface CylinderDef {
  id: string;
  lat: number;           // WGS84 decimal degrees
  lng: number;
  radiusM: number;
  type: 'SSS' | 'CYLINDER' | 'AIR_OR_GROUND' | 'GROUND_ONLY' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE';
  goalLineBearingDeg?: number;  // stored after optimisation; input is ignored
}

export interface OptimisedTask {
  totalDistanceKm: number;
  legs: OptimisedLeg[];           // one per adjacent cylinder pair
  crossingPoints: CrossingPoint[]; // one per cylinder, in order
  goalLineBearingDeg: number;     // perpendicular to final inbound leg; 0 if no goal line
  converged: boolean;
  iterations: number;
}

export interface OptimisedLeg {
  fromCylinderId: string;
  toCylinderId: string;
  distanceKm: number;             // optimal distance for this leg (>= 0)
  overlapping: boolean;           // true if cylinders overlap — leg distance is 0
}

export interface CrossingPoint {
  cylinderId: string;
  lat: number;
  lng: number;
  angleRad: number;               // angle on cylinder boundary (radians from north)
}

// Local 2D point in the flat projection
interface Vec2 { x: number; y: number; }

// =============================================================================
// COORDINATE UTILITIES
// =============================================================================

/**
 * Equirectangular projection centred on origin (originLat, originLng).
 * Returns (x, y) in metres. Accurate for distances < ~500km from origin.
 */
function project(lat: number, lng: number, originLat: number, originLng: number): Vec2 {
  const x = EARTH_RADIUS_M * (lng - originLng) * (Math.PI / 180)
          * Math.cos(originLat * Math.PI / 180);
  const y = EARTH_RADIUS_M * (lat - originLat) * (Math.PI / 180);
  return { x, y };
}

/**
 * Inverse equirectangular — local (x, y) back to WGS84.
 */
function unproject(p: Vec2, originLat: number, originLng: number): { lat: number; lng: number } {
  const lat = originLat + (p.y / EARTH_RADIUS_M) * (180 / Math.PI);
  const lng = originLng + (p.x / EARTH_RADIUS_M) * (180 / Math.PI)
            / Math.cos(originLat * Math.PI / 180);
  return { lat, lng };
}

function dist2D(a: Vec2, b: Vec2): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
function scale(v: Vec2, s: number): Vec2 { return { x: v.x * s, y: v.y * s }; }
function norm(v: Vec2): number { return Math.sqrt(v.x ** 2 + v.y ** 2); }
function normalise(v: Vec2): Vec2 { const n = norm(v); return n === 0 ? { x: 0, y: 1 } : scale(v, 1 / n); }

/**
 * Point on a circle (centre c, radius r) in the direction of target t.
 * If t === c (degenerate), returns the northernmost point on the circle.
 */
function pointOnCircleToward(c: Vec2, r: number, t: Vec2): Vec2 {
  const dir = normalise(sub(t, c));
  return add(c, scale(dir, r));
}

/**
 * Point on a circle (centre c, radius r) away from target t (opposite side).
 * Used for the SSS cylinder — pilot approaches from outside, so the optimal
 * exit point is on the far side relative to the next TP.
 * Actually for our rules (just cross the cylinder), the optimal point is
 * the boundary point CLOSEST to the next TP, same as other cylinders.
 */
function closestPointOnCircle(c: Vec2, r: number, t: Vec2): Vec2 {
  return pointOnCircleToward(c, r, t);
}

/**
 * Closest point on a finite line segment (p1→p2) to point q.
 */
function closestPointOnSegment(p1: Vec2, p2: Vec2, q: Vec2): Vec2 {
  const seg = sub(p2, p1);
  const segLenSq = seg.x ** 2 + seg.y ** 2;
  if (segLenSq === 0) return p1; // degenerate segment
  const t = Math.max(0, Math.min(1, ((q.x - p1.x) * seg.x + (q.y - p1.y) * seg.y) / segLenSq));
  return add(p1, scale(seg, t));
}

// =============================================================================
// GOAL LINE HELPERS
// =============================================================================

/**
 * Compute the bearing of the final inbound leg (second-to-last crossing → goal centre).
 * Returns degrees from north, clockwise.
 */
function computeInboundBearing(prev: Vec2, goalCentre: Vec2): number {
  const dx = goalCentre.x - prev.x;
  const dy = goalCentre.y - prev.y;
  const bearingRad = Math.atan2(dx, dy); // atan2(east, north) = bearing from north
  return ((bearingRad * 180 / Math.PI) + 360) % 360;
}

/**
 * Compute goal line bearing (perpendicular to inbound bearing).
 */
function goalLineBearing(inboundBearing: number): number {
  return (inboundBearing + 90) % 360;
}

/**
 * Endpoint pair for a goal line given its centre, half-length, and bearing (perpendicular to inbound).
 */
function goalLineEndpoints(centre: Vec2, halfLengthM: number, lineBearingDeg: number): [Vec2, Vec2] {
  const rad = lineBearingDeg * Math.PI / 180;
  const dir: Vec2 = { x: Math.sin(rad), y: Math.cos(rad) };
  return [
    sub(centre, scale(dir, halfLengthM)),
    add(centre, scale(dir, halfLengthM)),
  ];
}

// =============================================================================
// OPTIMAL INTERIOR POINT
// For an interior cylinder i, given fixed neighbours prev (Pᵢ₋₁) and next (Pᵢ₊₁),
// the optimal Pᵢ on cylinder i's boundary is the point collinear with prev and next,
// on the side facing them (i.e., minimising prev→Pᵢ + Pᵢ→next).
//
// Geometric proof: The minimum of f(θ) = |prev - P(θ)| + |P(θ) - next| over
// a circle occurs when P lies on the line segment prev→next (if that segment
// intersects the circle) or at the boundary point closest to both (if not).
//
// Case 1: Line prev→next passes through the circle.
//   Both intersection points are candidates; the one between prev and next is optimal.
//   If prev and next are on opposite sides: take the intersection point closer to the
//   midpoint of prev→next.
//
// Case 2: Line prev→next does not intersect the circle.
//   The optimal point is on the boundary, minimising the sum of distances.
//   This is found by the point where the angle bisector of the two directions
//   from the centre meets the boundary — equivalent to the point on the circle
//   in the direction of the midpoint of (unit vector to prev + unit vector to next).
// =============================================================================

function optimalInteriorPoint(centre: Vec2, radius: number, prev: Vec2, next: Vec2): Vec2 {
  // Direction from centre toward the "combined" target
  const dirToPrev = normalise(sub(prev, centre));
  const dirToNext = normalise(sub(next, centre));
  const combined = add(dirToPrev, dirToNext);

  if (norm(combined) < 1e-10) {
    // prev and next are diametrically opposite relative to centre
    // Any point is equally valid; use direction toward prev
    return add(centre, scale(dirToPrev, radius));
  }

  return add(centre, scale(normalise(combined), radius));
}

// =============================================================================
// MAIN OPTIMISER
// =============================================================================

export function optimiseTask(cylinders: CylinderDef[]): OptimisedTask {
  if (cylinders.length < 2) {
    throw new Error('Task must have at least 2 cylinders (SSS and goal)');
  }

  const n = cylinders.length;

  // Compute centroid for projection origin
  const originLat = cylinders.reduce((s, c) => s + c.lat, 0) / n;
  const originLng = cylinders.reduce((s, c) => s + c.lng, 0) / n;

  // Project all cylinder centres to local flat space
  const centres: Vec2[] = cylinders.map(c => project(c.lat, c.lng, originLat, originLng));
  const radii: number[] = cylinders.map(c => c.radiusM);

  // Detect goal line configuration
  const goalIsLine = cylinders[n - 1].type === 'GOAL_LINE';

  // ==========================================================================
  // INITIALISATION
  // Each crossing point starts at the boundary point facing the next cylinder.
  // Last point (goal) faces toward the previous cylinder.
  // ==========================================================================

  const points: Vec2[] = new Array(n);

  // SSS: face toward TP1
  points[0] = closestPointOnCircle(centres[0], radii[0], centres[1]);

  // Interior TPs: face toward next
  for (let i = 1; i < n - 1; i++) {
    points[i] = closestPointOnCircle(centres[i], radii[i], centres[i + 1]);
  }

  // Goal: face toward previous TP
  if (goalIsLine) {
    // Initial goal crossing: closest point on the goal line to the previous cylinder centre
    // Goal line bearing not yet known at init — use centre as initial crossing point
    points[n - 1] = { ...centres[n - 1] };
  } else {
    points[n - 1] = closestPointOnCircle(centres[n - 1], radii[n - 1], centres[n - 2]);
  }

  // ==========================================================================
  // ITERATIVE OPTIMISATION
  // ==========================================================================

  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations++;
    let maxMovement = 0;

    const newPoints: Vec2[] = [...points];

    // SSS (index 0): optimal point toward P[1]
    newPoints[0] = closestPointOnCircle(centres[0], radii[0], points[1]);

    // Interior cylinders: optimal point given P[i-1] and P[i+1]
    for (let i = 1; i < n - 1; i++) {
      newPoints[i] = optimalInteriorPoint(centres[i], radii[i], points[i - 1], points[i + 1]);
    }

    // Goal cylinder or line
    if (goalIsLine) {
      // Compute current inbound bearing from P[n-2] to goal centre
      const inboundBrg = computeInboundBearing(newPoints[n - 2], centres[n - 1]);
      const lineBrg = goalLineBearing(inboundBrg);
      const halfLen = radii[n - 1]; // goal line half-length = goal cylinder radius
      const [ep1, ep2] = goalLineEndpoints(centres[n - 1], halfLen, lineBrg);
      // Optimal crossing: closest point on goal line to P[n-2]
      newPoints[n - 1] = closestPointOnSegment(ep1, ep2, newPoints[n - 2]);
    } else {
      newPoints[n - 1] = closestPointOnCircle(centres[n - 1], radii[n - 1], newPoints[n - 2]);
    }

    // Check convergence
    for (let i = 0; i < n; i++) {
      const movement = dist2D(points[i], newPoints[i]);
      if (movement > maxMovement) maxMovement = movement;
    }

    for (let i = 0; i < n; i++) points[i] = newPoints[i];

    if (maxMovement < CONVERGENCE_THRESHOLD_M) {
      converged = true;
      break;
    }
  }

  // ==========================================================================
  // BUILD RESULT
  // ==========================================================================

  // Convert crossing points back to WGS84
  const crossingPoints: CrossingPoint[] = points.map((p, i) => {
    const { lat, lng } = unproject(p, originLat, originLng);
    const angle = Math.atan2(p.x - centres[i].x, p.y - centres[i].y);
    return { cylinderId: cylinders[i].id, lat, lng, angleRad: angle };
  });

  // Compute per-leg distances
  const legs: OptimisedLeg[] = [];
  let totalDistanceM = 0;

  for (let i = 0; i < n - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const centreDistM = dist2D(centres[i], centres[i + 1]);
    const overlapping = centreDistM < radii[i] + radii[i + 1];

    let legDistM: number;
    if (overlapping) {
      legDistM = 0;
    } else if (i === n - 2 && goalIsLine) {
      // Final leg to goal line: distance from P[n-2] to the crossing point on the line
      legDistM = Math.max(0, dist2D(from, to));
    } else {
      legDistM = Math.max(0, dist2D(from, to));
    }

    totalDistanceM += legDistM;

    legs.push({
      fromCylinderId: cylinders[i].id,
      toCylinderId: cylinders[i + 1].id,
      distanceKm: legDistM / 1000,
      overlapping,
    });
  }

  // Goal line bearing from final inbound leg
  const inboundBearing = computeInboundBearing(points[n - 2], centres[n - 1]);
  const computedGoalLineBearing = goalIsLine ? goalLineBearing(inboundBearing) : 0;

  return {
    totalDistanceKm: totalDistanceM / 1000,
    legs,
    crossingPoints,
    goalLineBearingDeg: computedGoalLineBearing,
    converged,
    iterations,
  };
}

// =============================================================================
// PARTIAL DISTANCE CALCULATOR
// Given a pilot who achieved lastTurnpointIndex TPs, computes their best
// distance along the optimal route.
//
// Uses the optimised crossing points from the task definition.
// The per-leg distances from OptimisedTask.legs are accumulated up to the
// last achieved TP, then the pilot's closest approach to the next cylinder
// is projected onto the remaining leg.
// =============================================================================

export interface PartialDistanceInput {
  optimisedTask: OptimisedTask;
  cylinders: CylinderDef[];
  lastTurnpointIndex: number;    // index of last TP achieved (0 = only SSS crossed)
  pilotFixes: Array<{ lat: number; lng: number }>;  // pilot's track after SSS crossing
  originLat: number;
  originLng: number;
}

export function computePartialDistance(input: PartialDistanceInput): number {
  const { optimisedTask, cylinders, lastTurnpointIndex, pilotFixes, originLat, originLng } = input;

  // Sum of completed legs
  const completedLegsDistanceKm = optimisedTask.legs
    .slice(0, lastTurnpointIndex)
    .reduce((sum, leg) => sum + leg.distanceKm, 0);

  // If pilot achieved the last TP (goal), return full task distance
  if (lastTurnpointIndex >= cylinders.length - 1) {
    return optimisedTask.totalDistanceKm;
  }

  // Find the next unachieved cylinder
  const nextCylinder = cylinders[lastTurnpointIndex + 1];
  const nextCentre = project(nextCylinder.lat, nextCylinder.lng, originLat, originLng);

  // The last achieved crossing point
  const lastCrossing = optimisedTask.crossingPoints[lastTurnpointIndex];
  const lastCrossingLocal = project(lastCrossing.lat, lastCrossing.lng, originLat, originLng);

  // Leg direction: last crossing → next cylinder boundary
  const nextOptimalPoint = project(
    optimisedTask.crossingPoints[lastTurnpointIndex + 1].lat,
    optimisedTask.crossingPoints[lastTurnpointIndex + 1].lng,
    originLat,
    originLng,
  );
  const legDir = normalise(sub(nextOptimalPoint, lastCrossingLocal));
  const legLengthM = optimisedTask.legs[lastTurnpointIndex].distanceKm * 1000;

  // Find pilot's best projection onto this leg
  let bestProjectionM = 0;

  for (const fix of pilotFixes) {
    const fixLocal = project(fix.lat, fix.lng, originLat, originLng);
    const toFix = sub(fixLocal, lastCrossingLocal);

    // Project fix onto leg direction
    const projection = toFix.x * legDir.x + toFix.y * legDir.y;

    // Clamp to [0, legLengthM] — don't credit the pilot beyond the next cylinder
    const clampedProjection = Math.max(0, Math.min(legLengthM, projection));

    if (clampedProjection > bestProjectionM) {
      bestProjectionM = clampedProjection;
    }
  }

  return completedLegsDistanceKm + (bestProjectionM / 1000);
}

// =============================================================================
// TASK OPTIMISER ENTRY POINT
// Called on task save / turnpoint edit.
// Returns updated task fields to persist to DB.
// =============================================================================

export interface TaskOptimisationResult {
  optimisedDistanceKm: number;
  goalLineBearingDeg: number;     // stored on the goal turnpoint
  legDistancesKm: number[];       // stored as JSON on the task for partial scoring
  crossingPoints: CrossingPoint[]; // stored as JSON on the task
  converged: boolean;
  iterations: number;
}

export function computeTaskOptimisation(cylinders: CylinderDef[]): TaskOptimisationResult {
  const result = optimiseTask(cylinders);

  return {
    optimisedDistanceKm: result.totalDistanceKm,
    goalLineBearingDeg: result.goalLineBearingDeg,
    legDistancesKm: result.legs.map(l => l.distanceKm),
    crossingPoints: result.crossingPoints,
    converged: result.converged,
    iterations: result.iterations,
  };
}
