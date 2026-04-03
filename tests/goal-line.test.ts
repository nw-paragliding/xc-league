import { describe, it, expect } from 'vitest';
import { segmentIntersectsGoalLine, segmentEntersGoalSemiCircle } from '../src/pipeline';
import { optimiseRoute, type Cylinder } from '../src/shared/task-engine';

// =============================================================================
// Coordinate convention used throughout:
//   x = east, y = north (standard geo projection)
//   bearingDeg = clockwise from north
//
// For bearingDeg = 90 (east-west chord):
//   chord: (-r, 0) → (+r, 0) along x-axis
//   inbound (approach) side: y < 0  (pilot approaches from the south)
//   outbound side:           y > 0  (semi-circle extends north)
// =============================================================================

const ORIGIN = { x: 0, y: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// segmentIntersectsGoalLine
// ─────────────────────────────────────────────────────────────────────────────

describe('segmentIntersectsGoalLine', () => {
  // East-west chord at origin, half-length 100 m, bearing 90°
  const R = 100;
  const BRG = 90;

  it('detects a perpendicular crossing through the chord midpoint', () => {
    // Straight south→north through (0,0)
    const t = segmentIntersectsGoalLine({ x: 0, y: -50 }, { x: 0, y: 50 }, ORIGIN, R, BRG);
    expect(t).toBeCloseTo(0.5, 5);
  });

  it('detects a crossing off-centre', () => {
    // Crossing at x=80, well within the chord (±100)
    const t = segmentIntersectsGoalLine({ x: 80, y: -20 }, { x: 80, y: 20 }, ORIGIN, R, BRG);
    expect(t).toBeCloseTo(0.5, 5);
  });

  it('returns null when segment is parallel to chord', () => {
    const t = segmentIntersectsGoalLine({ x: -50, y: 10 }, { x: 50, y: 10 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('returns null when segment crosses the chord line but outside its extent', () => {
    // x=150 is outside the ±100 chord endpoints
    const t = segmentIntersectsGoalLine({ x: 150, y: -20 }, { x: 150, y: 20 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('returns null when segment is too far away', () => {
    const t = segmentIntersectsGoalLine({ x: 0, y: 200 }, { x: 0, y: 300 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('detects crossing at the chord endpoint (edge case)', () => {
    // Segment passes through (100, 0) — exact endpoint of the chord
    const t = segmentIntersectsGoalLine({ x: 100, y: -10 }, { x: 100, y: 10 }, ORIGIN, R, BRG);
    expect(t).toBeCloseTo(0.5, 5);
  });

  it('crossing direction is irrelevant (north→south)', () => {
    // Same as first test but reversed — GAP 2025 §6.2.1 says direction is irrelevant
    const t = segmentIntersectsGoalLine({ x: 0, y: 50 }, { x: 0, y: -50 }, ORIGIN, R, BRG);
    expect(t).toBeCloseTo(0.5, 5);
  });

  it('works with a north-south chord (bearingDeg = 0)', () => {
    // Chord along y-axis: (0, -100) → (0, 100). Crossing east→west through origin.
    const t = segmentIntersectsGoalLine({ x: -50, y: 0 }, { x: 50, y: 0 }, ORIGIN, R, 0);
    expect(t).toBeCloseTo(0.5, 5);
  });

  it('works with a diagonal chord (bearingDeg = 45)', () => {
    // Chord along NE-SW (45°). A perpendicular segment (SE→NW) should cross it.
    const t = segmentIntersectsGoalLine({ x: 50, y: -50 }, { x: -50, y: 50 }, ORIGIN, R, 45);
    expect(t).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// segmentEntersGoalSemiCircle
// ─────────────────────────────────────────────────────────────────────────────

describe('segmentEntersGoalSemiCircle', () => {
  // East-west chord (bearing 90°), radius 100.
  // Outbound side (semi-circle) is y > 0 (north).
  const R = 100;
  const BRG = 90;

  it('detects entry through the outbound arc (approaching from the north)', () => {
    // Segment from well outside (north) straight toward centre
    const t = segmentEntersGoalSemiCircle({ x: 0, y: 200 }, { x: 0, y: 50 }, ORIGIN, R, BRG);
    expect(t).not.toBeNull();
    // Entry at y=100: t = (200-100)/(200-50) = 100/150 = 2/3
    expect(t).toBeCloseTo(2 / 3, 4);
  });

  it('returns null when entering the circle on the inbound side', () => {
    // Segment from south, enters circle on inbound side (y < 0)
    const t = segmentEntersGoalSemiCircle({ x: 0, y: -200 }, { x: 0, y: -50 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('returns 0 when point A is already inside the semi-circle', () => {
    // A at (0, 50) — inside circle (dist=50 < 100) and on outbound side (y > 0)
    const t = segmentEntersGoalSemiCircle({ x: 0, y: 50 }, { x: 0, y: -50 }, ORIGIN, R, BRG);
    expect(t).toBe(0);
  });

  it('returns null when point A is inside the circle but on the inbound side', () => {
    // A at (0, -50) — inside circle but on inbound side (y < 0)
    // B at (0, -150) — outside circle on inbound side
    const t = segmentEntersGoalSemiCircle({ x: 0, y: -50 }, { x: 0, y: -150 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('returns null when segment is entirely outside the circle', () => {
    const t = segmentEntersGoalSemiCircle({ x: 0, y: 200 }, { x: 0, y: 150 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('detects entry from an oblique angle on the outbound side', () => {
    // Approaching from the northeast, entering the arc on the north side
    const t = segmentEntersGoalSemiCircle({ x: 80, y: 200 }, { x: 80, y: 0 }, ORIGIN, R, BRG);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
    expect(t!).toBeLessThan(1);
    // At the crossing point, distance from origin should be ~100
    const py = 200 + t! * (0 - 200);
    expect(Math.sqrt(80 ** 2 + py ** 2)).toBeCloseTo(R, 0);
  });

  it('returns 0 for a zero-length segment when point is inside the semi-circle', () => {
    const t = segmentEntersGoalSemiCircle({ x: 0, y: 50 }, { x: 0, y: 50 }, ORIGIN, R, BRG);
    // A is inside the semi-circle → the "already inside" check fires
    expect(t).toBe(0);
  });

  it('returns null for a zero-length segment outside the circle', () => {
    const t = segmentEntersGoalSemiCircle({ x: 0, y: 200 }, { x: 0, y: 200 }, ORIGIN, R, BRG);
    expect(t).toBeNull();
  });

  it('works with a north-south chord (bearingDeg = 0)', () => {
    // Chord along y-axis. Outbound side: towardPrevRad = (0+90)%360 = 90°
    // towardPrev dir = (sin90, cos90) = (1, 0) — prev TP is to the east.
    // Outbound side: dot(P, (1,0)) < 0 → x < 0 (west side).
    // Segment from west (outbound) entering the circle:
    const t = segmentEntersGoalSemiCircle({ x: -200, y: 0 }, { x: -50, y: 0 }, ORIGIN, R, 0);
    expect(t).not.toBeNull();
    expect(t).toBeCloseTo(100 / 150, 4); // entry at x=-100
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined chord + semi-circle scoring (the full D-shape)
// ─────────────────────────────────────────────────────────────────────────────

describe('goal D-shape: chord + semi-circle together', () => {
  const R = 100;
  const BRG = 90;

  it('chord crossing scores earlier than arc entry when both occur', () => {
    // Segment from south to north — crosses chord at y=0, reaches arc at y=+100.
    // Chord crossing at t=0.5 (y goes -100→100, chord at y=0).
    const tChord = segmentIntersectsGoalLine({ x: 0, y: -100 }, { x: 0, y: 100 }, ORIGIN, R, BRG);
    const tArc = segmentEntersGoalSemiCircle({ x: 0, y: -100 }, { x: 0, y: 100 }, ORIGIN, R, BRG);
    expect(tChord).not.toBeNull();
    expect(tChord).toBeCloseTo(0.5, 5);
    // The semi-circle intersection occurs at the outbound boundary point y=+100, i.e. t=1.
    expect(tArc).not.toBeNull();
    expect(tArc!).toBeCloseTo(1, 5);
    expect(tChord!).toBeLessThan(tArc!);
  });

  it('pilot approaching from the outbound side scores via semi-circle (not chord)', () => {
    // Pilot comes from the north (outbound side) straight to centre — enters arc, never crosses chord
    const tChord = segmentIntersectsGoalLine({ x: 0, y: 200 }, { x: 0, y: 10 }, ORIGIN, R, BRG);
    const tArc = segmentEntersGoalSemiCircle({ x: 0, y: 200 }, { x: 0, y: 10 }, ORIGIN, R, BRG);

    // Chord is at y=0, segment goes to y=10 — doesn't cross y=0 → chord miss
    expect(tChord).toBeNull();
    // Arc entry at y=100: t = (200-100)/(200-10) ≈ 0.526
    expect(tArc).not.toBeNull();
    expect(tArc!).toBeCloseTo(100 / 190, 3);
  });

  it('pilot approaching from the inbound side who does not cross the chord does not score', () => {
    // Pilot comes from south, enters circle on inbound side, but stops before chord
    const tChord = segmentIntersectsGoalLine({ x: 0, y: -200 }, { x: 0, y: -10 }, ORIGIN, R, BRG);
    const tArc = segmentEntersGoalSemiCircle({ x: 0, y: -200 }, { x: 0, y: -10 }, ORIGIN, R, BRG);
    expect(tChord).toBeNull();
    expect(tArc).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// optimiseRoute with GOAL_LINE
// ─────────────────────────────────────────────────────────────────────────────

describe('optimiseRoute with GOAL_LINE', () => {
  it('returns a non-zero goalLineBearingDeg for a GOAL_LINE task', () => {
    const cylinders: Cylinder[] = [
      { lat: 47.5, lng: -121.9, radiusM: 400, type: 'SSS' },
      { lat: 47.6, lng: -121.8, radiusM: 200, type: 'GOAL_LINE' },
    ];
    const result = optimiseRoute(cylinders);
    expect(result.goalLineBearingDeg).not.toBe(0);
    expect(result.touchPoints).toHaveLength(2);
    expect(result.totalDistanceKm).toBeGreaterThan(0);
  });

  it('returns goalLineBearingDeg = 0 for a GOAL_CYLINDER task', () => {
    const cylinders: Cylinder[] = [
      { lat: 47.5, lng: -121.9, radiusM: 400, type: 'SSS' },
      { lat: 47.6, lng: -121.8, radiusM: 200, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);
    expect(result.goalLineBearingDeg).toBe(0);
  });

  it('goal line bearing is perpendicular to the inbound leg', () => {
    // Place SSS due south of goal — inbound bearing should be ~0° (north),
    // so goal line bearing should be ~90° (east-west chord)
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 48.0, lng: -122.0, radiusM: 200, type: 'GOAL_LINE' },
    ];
    const result = optimiseRoute(cylinders);
    // Inbound is roughly north (0°), so goal line bearing ≈ 90°
    expect(result.goalLineBearingDeg).toBeCloseTo(90, 0);
  });

  it('goal line bearing updates when inbound direction changes', () => {
    // SSS due west of goal — inbound ≈ 90° (east), so goal line ≈ 180° (north-south)
    const cylinders: Cylinder[] = [
      { lat: 47.5, lng: -123.0, radiusM: 400, type: 'SSS' },
      { lat: 47.5, lng: -122.0, radiusM: 200, type: 'GOAL_LINE' },
    ];
    const result = optimiseRoute(cylinders);
    expect(result.goalLineBearingDeg).toBeCloseTo(180, 0);
  });

  it('multi-TP task: bearing uses optimised touch point, not raw TP centre', () => {
    // SSS → intermediate TP (offset east) → GOAL_LINE
    // The inbound to goal should be from the intermediate TP's optimised touch point,
    // not a straight line from SSS to goal.
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.5, lng: -121.5, radiusM: 400, type: 'CYLINDER' },
      { lat: 48.0, lng: -122.0, radiusM: 200, type: 'GOAL_LINE' },
    ];
    const result = optimiseRoute(cylinders);
    // With the dogleg, the inbound to goal comes from the NE, so the bearing
    // should NOT be ~90° (which it would be if using SSS→goal directly)
    expect(result.goalLineBearingDeg).not.toBeCloseTo(90, 0);
    expect(result.goalLineBearingDeg).toBeGreaterThan(0);
    expect(result.goalLineBearingDeg).toBeLessThan(360);
  });
});
