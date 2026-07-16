import { describe, expect, it } from 'vitest';
import { computeDistancePoints, computeTimePoints, goalRatioWeights, MAX_POINTS } from '../src/shared/task-engine';

const hms = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

// FAI Sporting Code S7F 2025 §12.2:
//   SpeedFraction = max(0, 1 - ((T - BestTime) / sqrt(BestTime))^(5/6)), times in hours
// Pinned against the spec's own worked examples in §12.2.1 Table 2.
describe('computeTimePoints (FAI S7F §12.2)', () => {
  it('reproduces the §12.2.1 Table 2 sample distribution', () => {
    // Row 1: fastest time 1:00 → 80% at 1:08:42, 50% at 1:26:07, 0 at 2:00:00
    const best1 = hms(1, 0, 0);
    expect(computeTimePoints(best1, [best1])).toBe(MAX_POINTS);
    expect(computeTimePoints(hms(1, 8, 42), [best1])).toBeCloseTo(800, 0);
    expect(computeTimePoints(hms(1, 26, 7), [best1])).toBeCloseTo(500, 0);
    expect(computeTimePoints(hms(2, 0, 0), [best1])).toBe(0);

    // Row 2: fastest time 2:00 → 80% at 2:12:18, 50% at 2:36:56, 0 at 3:24:51
    const best2 = hms(2, 0, 0);
    expect(computeTimePoints(hms(2, 12, 18), [best2])).toBeCloseTo(800, 0);
    expect(computeTimePoints(hms(2, 36, 56), [best2])).toBeCloseTo(500, 0);
    expect(computeTimePoints(hms(3, 24, 51), [best2])).toBeCloseTo(0, 0);

    // Row 3: fastest time 3:00 → 80% at 3:15:04, 50% at 3:45:14, 0 at 4:43:55
    const best3 = hms(3, 0, 0);
    expect(computeTimePoints(hms(3, 15, 4), [best3])).toBeCloseTo(800, 0);
    expect(computeTimePoints(hms(3, 45, 14), [best3])).toBeCloseTo(500, 0);
    expect(computeTimePoints(hms(4, 43, 55), [best3])).toBeCloseTo(0, 0);
  });

  it('zero cutoff is absolute: BestTime + sqrt(BestTime), independent of other finishers', () => {
    const best = hms(1, 0, 0);
    // Just inside the cutoff scores > 0; at/beyond scores exactly 0.
    expect(computeTimePoints(hms(1, 59, 0), [best])).toBeGreaterThan(0);
    expect(computeTimePoints(hms(2, 0, 0), [best])).toBe(0);
    expect(computeTimePoints(hms(5, 0, 0), [best])).toBe(0);
    // The slowest actual finisher does NOT define the zero point: a pilot only
    // 12 minutes behind a ~39-minute best time keeps most of their points even
    // when they are last into goal.
    expect(computeTimePoints(3032, [2314, 3032])).toBeCloseTo(686.3, 1);
  });

  it('sole finisher and all-tied fields score full points', () => {
    expect(computeTimePoints(5000, [5000])).toBe(MAX_POINTS);
    expect(computeTimePoints(5000, [5000, 5000, 5000])).toBe(MAX_POINTS);
    expect(computeTimePoints(5000, [])).toBe(MAX_POINTS);
  });

  it('guards degenerate inputs', () => {
    // Zero best time: only a zero-time pilot matches it.
    expect(computeTimePoints(0, [0])).toBe(MAX_POINTS);
    expect(computeTimePoints(100, [0])).toBe(0);
    // A pilot faster than the pool minimum (should not happen — the pool
    // includes the pilot) clamps to full points rather than NaN.
    expect(computeTimePoints(3000, [3600])).toBe(MAX_POINTS);
  });
});

// FAI S7F §11: the distance/time split depends on the goal ratio.
//   DistanceWeight = 0.9 - 1.665*GR + 1.713*GR² - 0.587*GR³
// Leading and arrival points are deliberately dropped in this league, so
// TimeWeight absorbs the full remainder (1 - DistanceWeight).
describe('goalRatioWeights (FAI S7F §11)', () => {
  it('GR = 0 (nobody in goal): distance gets 90%, time the 10% remainder', () => {
    const { distanceWeight, timeWeight } = goalRatioWeights(0);
    expect(distanceWeight).toBeCloseTo(0.9, 12);
    expect(timeWeight).toBeCloseTo(0.1, 12);
  });

  it('GR = 0.5: DW = 0.9 - 0.8325 + 0.42825 - 0.073375 = 0.422375 exactly', () => {
    const { distanceWeight, timeWeight } = goalRatioWeights(0.5);
    expect(distanceWeight).toBeCloseTo(0.422375, 12);
    expect(timeWeight).toBeCloseTo(0.577625, 12);
  });

  it('GR = 1 (everyone in goal): DW = 0.9 - 1.665 + 1.713 - 0.587 = 0.361', () => {
    const { distanceWeight, timeWeight } = goalRatioWeights(1);
    expect(distanceWeight).toBeCloseTo(0.361, 12);
    expect(timeWeight).toBeCloseTo(0.639, 12);
  });

  it('weights always sum to 1 and clamp out-of-range ratios', () => {
    for (const gr of [0, 0.1, 0.25, 0.33, 0.5, 0.75, 0.9, 1]) {
      const { distanceWeight, timeWeight } = goalRatioWeights(gr);
      expect(distanceWeight + timeWeight).toBeCloseTo(1, 12);
      expect(distanceWeight).toBeGreaterThan(0);
      expect(distanceWeight).toBeLessThan(1);
    }
    expect(goalRatioWeights(-0.5)).toEqual(goalRatioWeights(0));
    expect(goalRatioWeights(1.5)).toEqual(goalRatioWeights(1));
  });
});

describe('availablePoints pools scale the compute functions linearly', () => {
  it('computeDistancePoints returns the pool for goal pilots and scales sqrt for the rest', () => {
    // GR = 0 → AvailableDistancePoints = 0.9 * 1000 = 900 raw.
    expect(computeDistancePoints(50, 50, true, 900)).toBe(900);
    expect(computeDistancePoints(25, 100, false, 900)).toBeCloseTo(450, 9);
    // Default remains MAX_POINTS for isolated unit use.
    expect(computeDistancePoints(50, 50, true)).toBe(MAX_POINTS);
  });

  it('computeTimePoints returns the pool for t_best and scales the fraction', () => {
    expect(computeTimePoints(3000, [3000, 3600], 639)).toBe(639);
    expect(computeTimePoints(3600, [3000, 3600], 639)).toBeCloseTo(0.639 * computeTimePoints(3600, [3000, 3600]), 9);
    // Sole/no finisher degenerate branch honours the pool too.
    expect(computeTimePoints(5000, [], 639)).toBe(639);
  });
});

// Rounding to one decimal happens exactly once, on the persisted value after
// normalisation (rebuildTaskResults) — the compute functions themselves must
// return full precision, or the later scale-then-round compounds two rounding
// errors (S7F round-once principle).
describe('compute functions return unrounded values', () => {
  it('computeTimePoints keeps full precision', () => {
    // A 0.1-pre-rounded return would collapse this to exactly 686.3.
    expect(computeTimePoints(3032, [2314, 3032])).toBeCloseTo(686.3155932494, 6);
  });

  it('computeDistancePoints keeps full precision', () => {
    // 1000 * sqrt(60.0089 / 80) — a 0.1-pre-rounded return would give 866.1.
    expect(computeDistancePoints(60.0089, 80, false)).toBeCloseTo(866.089631620192, 6);
  });
});
