import { describe, expect, it } from 'vitest';
import { computeTimePoints, MAX_POINTS } from '../src/shared/task-engine';

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
