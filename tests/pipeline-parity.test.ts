// =============================================================================
// Pipeline parity — backend half
// =============================================================================
//
// Runs the shared fixture through runPipeline on the Node side and asserts
// the raw pipeline output (distance ≈ 3.65 km, reaches goal, expected
// turnpoint sequence). The frontend half (frontend/src/lib/previewPipeline.test.ts)
// runs the same fixture through previewSubmission (which adds task-level
// normalisation on top) and locks down the post-normalisation numbers. Together
// the two tests guard the path from IGC bytes → leaderboard-scale points; if
// Vite, esbuild, or igc-parser ever drift between Node and the browser, both
// tests diverge in lockstep — the failure points straight at the bundler.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/shared/pipeline';
import {
  FIXTURE_INPUT,
  FIXTURE_TASK_BEST_DISTANCE_KM,
  FIXTURE_TASK_CLOSE_DATE,
  FIXTURE_TASK_OPEN_DATE,
} from '../src/shared/pipeline-parity-fixture';

describe('pipeline parity — backend runPipeline against shared fixture', () => {
  it('parses, scores, and reaches goal with deterministic numbers', async () => {
    const result = await runPipeline(
      FIXTURE_INPUT,
      FIXTURE_TASK_OPEN_DATE,
      FIXTURE_TASK_CLOSE_DATE,
      FIXTURE_TASK_BEST_DISTANCE_KM,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.flightDate).toBe('2026-01-23');

    const best = result.value.scoredAttempts[result.value.bestAttemptIndex];
    expect(best.reachedGoal).toBe(true);
    expect(best.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
    expect(best.taskTimeS).not.toBeNull();

    // Snapshot the numeric outputs that previewSubmission also reports. The
    // frontend test asserts these same numbers — divergence = bundler drift.
    // 3.65 km = optimised cylinder-to-cylinder path: 4.45 km centre-to-centre
    // (SSS at 47.50, GOAL at 47.54) minus one 400 m radius off each end.
    expect(best.distanceFlownKm).toBeCloseTo(3.65, 2);
    expect(best.distancePoints).toBeGreaterThan(0);
    expect(best.totalPoints).toBeGreaterThan(0);
    expect(best.taskTimeS).toBeGreaterThan(0);
  });
});
