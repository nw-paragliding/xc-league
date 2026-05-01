import { describe, expect, it } from 'vitest';
import { type Cylinder, computeDistanceKm, haversineKm, optimiseRoute } from '../src/shared/task-engine';

// =============================================================================
// optimiseRoute — chord vs tangent (hit case vs miss case)
//
// Background: §6.2.1 GAP says any point on or inside a control zone counts as
// a touch. So when the straight prev→next segment already passes through a
// cylinder, the optimal route through that cylinder is the straight chord —
// no detour to the cylinder boundary.
//
// Issue #38: the optimiser used to always project the interior touch point
// to the cylinder boundary (the angle-bisector tangent), which is correct
// for the "miss" case but over-counts distance and adds a phantom detour
// for the "hit" case.
// =============================================================================

describe('optimiseRoute — hit case (prev→next segment passes through cylinder)', () => {
  it('three TPs collinear, middle cylinder large enough to be hit by the chord — no detour', () => {
    // SSS at 47.0, ESS at 47.4, both due-north of each other.
    // Middle TP centred halfway between them at (47.2, -122.0) with a
    // radius of 5 km — the great-circle line from SSS centre to ESS
    // centre obviously passes straight through it.
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.2, lng: -122.0, radiusM: 5000, type: 'CYLINDER' },
      { lat: 47.4, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);

    // Optimal path: SSS boundary (north) → straight line through TP2 → ESS boundary (south).
    // SSS exit is r=400 m north of (47.0, -122.0); ESS entry is r=400 m south of (47.4, -122.0).
    // Distance between the two endpoints ≈ haversine(47.0, 47.4) − 2*0.4 km.
    const ssToEssCentreKm = haversineKm(47.0, -122.0, 47.4, -122.0);
    const expectedKm = ssToEssCentreKm - 0.4 - 0.4; // subtract one radius from each end

    // The result should match the straight-line distance, not the
    // "tangent on side" detour the bug used to produce.
    expect(result.totalDistanceKm).toBeCloseTo(expectedKm, 1);

    // Middle touch point should land on the chord between the two
    // outer touch points, i.e. very close to the chord midpoint and
    // strictly inside the 5 km cylinder.
    const tp2 = result.touchPoints[1];
    expect(tp2.lng).toBeCloseTo(-122.0, 3); // chord runs along this meridian
    const tp2DistFromCentreKm = haversineKm(tp2.lat, tp2.lng, 47.2, -122.0);
    expect(tp2DistFromCentreKm).toBeLessThan(5); // inside the cylinder
  });

  it('three TPs offset, middle cylinder big enough to swallow the chord — straight line', () => {
    // SSS in NW corner, ESS in SE corner, middle TP centred between them
    // with a 6 km radius. The straight chord from SSS → ESS passes through
    // the middle. Optimal: straight chord, no detour.
    const cylinders: Cylinder[] = [
      { lat: 47.5, lng: -122.5, radiusM: 400, type: 'SSS' },
      { lat: 47.4, lng: -122.4, radiusM: 6000, type: 'CYLINDER' },
      { lat: 47.3, lng: -122.3, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);

    // Compare against a "no middle" path (just SSS boundary → ESS boundary)
    // by removing the middle and re-optimising. With the hit-case fix the
    // routes are geometrically identical; the only source of difference is
    // iteration convergence (CONVERGENCE_M = 0.1 m per touch point), which
    // is well under 1 m on the 13 km total. Use digits=3 → ≤ 0.5 m
    // tolerance — tight enough that the bug's ~100 m detour would fail
    // here, generous enough that floating-point noise can't.
    const direct = optimiseRoute([cylinders[0], cylinders[2]]);
    expect(result.totalDistanceKm).toBeCloseTo(direct.totalDistanceKm, 3);
  });

  it('chord exactly tangent to cylinder — touch lands on the boundary', () => {
    // Three collinear TPs along a meridian. Place the middle cylinder
    // offset east by exactly its radius so the chord SSS→ESS grazes the
    // western edge. Derive the longitude offset from the same spherical
    // projection task-engine uses (EARTH_R_M = 6_371_000 m, equirectangular
    // around the task centroid) so the geometry is exact relative to what
    // optimiseRoute sees — not via a hard-coded "111 320 m/degree" that
    // would mis-align by ~0.1% (≈ 1 m at r = 1 km) and tip the result
    // into the hit or miss branch unpredictably.
    const r = 1000; // 1 km
    const EARTH_R_M = 6_371_000;
    const DEG = Math.PI / 180;
    const centroidLat = 47.2;
    const offsetDegLng = r / (EARTH_R_M * DEG * Math.cos(centroidLat * DEG));
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.2, lng: -122.0 + offsetDegLng, radiusM: r, type: 'CYLINDER' },
      { lat: 47.4, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);

    const tp2 = result.touchPoints[1];
    const tp2Centre = { lat: 47.2, lng: -122.0 + offsetDegLng };
    const distM = haversineKm(tp2.lat, tp2.lng, tp2Centre.lat, tp2Centre.lng) * 1000;
    // At the boundary of the hit/miss branches both produce a touch on
    // (or fractionally inside) the cylinder edge. Tolerate either side
    // by a generous amount that still catches regressions where the
    // touch is far from the boundary (haversine vs equirectangular at
    // ~1 km on lat 47° introduces <10 cm of mismatch).
    expect(Math.abs(distM - r)).toBeLessThan(5);
  });
});

describe('optimiseRoute — miss case (regression: tangent still works)', () => {
  it('three TPs with middle cylinder far enough off the chord — angle-bisector tangent', () => {
    // Middle TP offset 8 km east of the SSS→ESS line, with a 1 km radius.
    // Chord misses the cylinder by ~7 km, so optimum is a tangent
    // boundary touch on the western (closer) side of the cylinder.
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.2, lng: -121.9, radiusM: 1000, type: 'CYLINDER' },
      { lat: 47.4, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);

    // Touch point should sit on the cylinder boundary (tangent case).
    const tp2 = result.touchPoints[1];
    const distFromCentreKm = haversineKm(tp2.lat, tp2.lng, 47.2, -121.9);
    expect(distFromCentreKm).toBeCloseTo(1.0, 1); // ~1 km radius

    // Touch should be on the western edge (closer to the SSS→ESS chord).
    expect(tp2.lng).toBeLessThan(-121.9);
  });

  it('two cylinders with no overlap — simple boundary-to-boundary path', () => {
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.4, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    const result = optimiseRoute(cylinders);
    const ssToEssKm = haversineKm(47.0, -122.0, 47.4, -122.0);
    expect(result.totalDistanceKm).toBeCloseTo(ssToEssKm - 0.4 - 0.4, 1);
  });
});

describe('computeDistanceKm — wrapper around optimiseRoute', () => {
  it('matches optimiseRoute().totalDistanceKm', () => {
    const cylinders: Cylinder[] = [
      { lat: 47.0, lng: -122.0, radiusM: 400, type: 'SSS' },
      { lat: 47.2, lng: -122.0, radiusM: 5000, type: 'CYLINDER' },
      { lat: 47.4, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ];
    expect(computeDistanceKm(cylinders)).toBeCloseTo(optimiseRoute(cylinders).totalDistanceKm, 6);
  });
});
