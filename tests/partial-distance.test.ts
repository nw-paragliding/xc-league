// =============================================================================
// computePartialDistanceKm — FAI Sporting Code §9.3 (Flown distance)
//
// §9.3: "we determine for each point where the pilot is still flying the
// remaining distance to goal from that point, considering any previously
// reached control zones … Then we calculate the flight distance as the task
// distance minus the smallest of those remaining distances."
//
// These tests pin the behaviour the spec demands. The pre-fix implementation
// projected fixes onto a single next-leg direction vector and clamped to
// legLen — which (a) silently capped credit at the next TP for pilots who
// flew past without tagging it, (b) ignored perpendicular excursions and so
// gave identical scores to laterally-divergent tracks with the same axial
// progress. The §9.3 algorithm — re-run the route optimiser from each fix
// through the unreached cylinders — fixes both.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { type Cylinder, computePartialDistanceKm, optimiseRoute } from '../src/shared/task-engine';

// ── Shared task geometry ────────────────────────────────────────────────────
// Four collinear cylinders along the −122° meridian, 0.1° (≈ 11.12 km) apart,
// each 400 m radius. The chord SSS_centre → GOAL_centre passes through every
// cylinder, so the optimised route walks the meridian touching SSS's north
// boundary, both interior centres, and GOAL's south boundary.

const TASK: Cylinder[] = [
  { lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
  { lat: 47.6, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
  { lat: 47.7, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
  { lat: 47.8, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
];

const ROUTE = optimiseRoute(TASK);
const TASK_KM = ROUTE.totalDistanceKm;

// Crossings: SSS at t=0, TP1 at t=100_000 ms.
const CROSS_SSS_TP1 = [
  { sequenceIndex: 0, crossingTime: 0 },
  { sequenceIndex: 1, crossingTime: 100_000 },
];

function fix(lat: number, lng: number, tMs: number) {
  return { lat, lng, timestamp: tMs };
}

// ── Sanity ──────────────────────────────────────────────────────────────────

describe('computePartialDistanceKm — sanity', () => {
  it('returns 0 for an empty fix list', () => {
    expect(computePartialDistanceKm(ROUTE, TASK, [], [])).toBe(0);
  });

  it('task distance is approximately 32.56 km (anchors the absolute scale)', () => {
    // 0.1°(lat) × 111.194 km/° × 3 legs − 2×400 m (SSS + GOAL boundary offsets)
    // = 33.358 − 0.800 = 32.558 km
    expect(TASK_KM).toBeCloseTo(32.558, 2);
  });
});

// ── Anchoring behaviour: each fix maps to an expected distance ──────────────

describe('computePartialDistanceKm — anchor points on the optimised line', () => {
  it('pilot stationary at SSS exit gets ~0 km credit', () => {
    const fixes = [fix(47.503596, -122.0, 0)]; // SSS boundary north
    const d = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1.slice(0, 1), fixes);
    expect(d).toBeCloseTo(0, 1);
  });

  it('pilot tagged TP1 and stopped there gets ~SSS→TP1 leg distance (≈ 10.72 km)', () => {
    const fixes = [fix(47.503596, -122.0, 0), fix(47.6, -122.0, 100_000)];
    const d = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1, fixes);
    expect(d).toBeCloseTo(10.72, 1);
  });

  it('pilot tagged TP1 and landed halfway to TP2 gets ~SSS→TP1 + half leg (≈ 16.28 km)', () => {
    const fixes = [
      fix(47.503596, -122.0, 0),
      fix(47.6, -122.0, 100_000),
      fix(47.65, -122.0, 200_000), // 5.56 km past TP1 along the leg
    ];
    const d = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1, fixes);
    expect(d).toBeCloseTo(16.28, 1);
  });

  it('pilot drifted onto GOAL boundary without entering gets ~full task distance', () => {
    // Pilot tagged SSS, TP1, TP2; landed on the south face of the goal cylinder.
    const crossings = [
      { sequenceIndex: 0, crossingTime: 0 },
      { sequenceIndex: 1, crossingTime: 100_000 },
      { sequenceIndex: 2, crossingTime: 200_000 },
    ];
    const fixes = [
      fix(47.503596, -122.0, 0),
      fix(47.6, -122.0, 100_000),
      fix(47.7, -122.0, 200_000),
      fix(47.796404, -122.0, 300_000), // GOAL boundary south, didn't enter
    ];
    const d = computePartialDistanceKm(ROUTE, TASK, crossings, fixes);
    expect(d).toBeCloseTo(TASK_KM, 1);
  });
});

// ── The bug: tracks that diverge laterally must get DIFFERENT distances ─────

describe('computePartialDistanceKm — lateral divergence (was: same score)', () => {
  // Two pilots, identical reached set (SSS + TP1), identical axial progress
  // (both reach 47.65 latitude = 5.56 km past TP1 along the leg direction),
  // but pilot WIDE lands 0.05° east of the leg (≈ 3.74 km off-line) while
  // pilot NARROW only 0.01° east (≈ 0.75 km off-line).
  //
  // Old code: projects both onto legDir = (0, 1); both report bestM ≈ 5.56 km,
  // → identical distanceFlownKm.
  // §9.3:    routes the remaining task through TP2 from each landing point;
  // WIDE has to fly further to reach TP2, so its remaining distance is larger
  // and its credited bestDistance is smaller. NARROW gets MORE credit.

  const fixesNarrow = [fix(47.503596, -122.0, 0), fix(47.6, -122.0, 100_000), fix(47.65, -122.01, 200_000)];
  const fixesWide = [fix(47.503596, -122.0, 0), fix(47.6, -122.0, 100_000), fix(47.65, -122.05, 200_000)];

  it('NARROW (closer to optimised line) gets more credit than WIDE', () => {
    const dN = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1, fixesNarrow);
    const dW = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1, fixesWide);
    expect(dN).toBeGreaterThan(dW);
    // The gap is the difference in "extra detour" needed to reach TP2 — bounded
    // below by (wide_offset − narrow_offset) projected through TP2 geometry.
    expect(dN - dW).toBeGreaterThan(0.5);
  });
});

// ── The bug: tracks that overshoot past an un-tagged TP must NOT clamp ──────

describe('computePartialDistanceKm — overshoot past an unreached TP', () => {
  // Pilot CLOSE: flies past TP2 latitude but stays 1 km east of the meridian,
  // so they never enter TP2. Best moment was while east of TP2 boundary
  // (≈ 0.6 km outside).
  // Pilot FAR: same east-offset profile but they wing it 5 km past TP2 latitude
  // before veering further east. Their closest approach to TP2 is similar to
  // CLOSE's (≈ same offset at the same latitude band), so §9.3 puts them on
  // similar bestDistance. But the OLD projection-and-clamp would have given
  // both exactly legLenM credit on the TP1→TP2 leg regardless of the lateral
  // miss — overstating progress by ~1 km.
  //
  // Concrete assertion: §9.3 must give STRICTLY LESS than SSS→TP2-edge for
  // a pilot who flew past TP2 without entering. The old leg-clamp pinned this
  // to exactly leg(SSS→TP1)+leg(TP1→TP2).

  it('pilot overshoots TP2 latitude but never tags it → distance < SSS→TP2 sum', () => {
    const ssToTp1 = ROUTE.legDistancesKm[0];
    const tp1ToTp2 = ROUTE.legDistancesKm[1];
    const oldClampValue = ssToTp1 + tp1ToTp2;

    const fixes = [
      fix(47.503596, -122.0, 0),
      fix(47.6, -122.0, 100_000),
      fix(47.65, -122.01, 200_000),
      fix(47.7, -122.012, 300_000), // east of TP2 by ≈ 0.9 km — outside cylinder
      fix(47.75, -122.015, 400_000),
      fix(47.78, -122.02, 500_000),
    ];
    const d = computePartialDistanceKm(ROUTE, TASK, CROSS_SSS_TP1, fixes);

    // §9.3: the pilot still has to fly the residual perpendicular distance to
    // TP2 boundary on top of TP2→GOAL — so they get less than the full
    // SSS→TP2 sum.
    expect(d).toBeLessThan(oldClampValue);
    // Sanity: they did make real progress (well beyond just tagging TP1).
    expect(d).toBeGreaterThan(ssToTp1 + 5);
  });
});
