// =============================================================================
// Pipeline parity — frontend half
// =============================================================================
//
// Runs the shared fixture through previewSubmission (which wraps the same
// runPipeline the backend uses) and asserts the same numbers the backend
// parity test asserts in tests/pipeline-parity.test.ts.
//
// If Vite's CJS interop, esbuild's transpile, or any browser-vs-Node JS
// quirk ever drifts the two runtime paths, both tests start diverging
// against the same fixture — the failure points straight at the bundler.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  FIXTURE_INPUT,
  FIXTURE_TASK_CLOSE_DATE,
  FIXTURE_TASK_OPEN_DATE,
  FIXTURE_TURNPOINTS,
} from '../../../src/shared/pipeline-parity-fixture';
import type { Task, Turnpoint } from '../api/tasks';
import { previewSubmission } from './previewPipeline';

// Adapt the pipeline-shaped fixture turnpoints to the frontend's API shape.
// previewSubmission re-maps them via its own turnpointToDef, so this is the
// inverse of that mapping and exercises the full client surface.
const turnpoints: Turnpoint[] = FIXTURE_TURNPOINTS.map((tp) => ({
  name: tp.id,
  latitude: tp.lat,
  longitude: tp.lng,
  radiusM: tp.radiusM,
  type: tp.type,
  sequenceIndex: tp.sequenceIndex,
  forceGround: tp.forceGround,
  goalLineBearingDeg: tp.goalLineBearingDeg ?? null,
}));

const task: Task = {
  id: FIXTURE_INPUT.task.id,
  name: 'Parity Fixture',
  description: null,
  taskType: 'RACE_TO_GOAL',
  status: 'published',
  openDate: FIXTURE_TASK_OPEN_DATE,
  closeDate: FIXTURE_TASK_CLOSE_DATE,
  taskValue: null,
  pilotCount: 0,
  goalCount: 1,
  turnpoints,
};

// Match FIXTURE_INPUT.existingGoalTimes ([120]) — previewSubmission derives
// existingGoalTimes from leaderboard entries with reachedGoal && taskTimeS.
const leaderboardEntries = [
  {
    rank: 1,
    pilotName: 'Prior Finisher',
    pilotId: 'prior',
    submissionId: null,
    distanceFlownKm: 3.65,
    reachedGoal: true,
    taskTimeS: 120,
    distancePoints: 0,
    timePoints: 0,
    totalPoints: 0,
    hasFlaggedCrossings: false,
  },
];

describe('previewSubmission parity — frontend wraps runPipeline against shared fixture', () => {
  it('parses, scores, and reaches goal with numbers identical to the backend snapshot', async () => {
    const res = await previewSubmission(FIXTURE_INPUT.igcText, task, { competitionType: 'XC' }, leaderboardEntries);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.flightDate).toBe('2026-01-23');

    const best = res.value.attempts[res.value.bestAttemptIndex];
    expect(best.reachedGoal).toBe(true);
    expect(best.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
    expect(best.taskTimeS).not.toBeNull();

    // Same parsing/distance/timing numbers as tests/pipeline-parity.test.ts.
    // Divergence here = client and server scoring drift.
    expect(best.distanceFlownKm).toBeCloseTo(3.65, 2);
    expect(best.taskTimeS).toBeGreaterThan(0);

    // previewSubmission also applies the same task-level normalisation that
    // rebuildTaskResults runs server-side. Fixture setup:
    //   - prior finisher: goal at 120 s → raw 1000 dist + 1000 time = 2000
    //   - preview: goal at ~148 s → raw 1000 dist + 0 time = 1000
    //   - winner raw = 2000 → scale = 1000 / 2000 = 0.5
    //   - preview normalised: 500 dist + 0 time = 500
    // If this assertion ever drifts, either the normalisation logic changed
    // or the underlying scoring formulas did — both cases want a closer look
    // because the backend's rebuildTaskResults would have followed suit.
    expect(best.distancePoints).toBeCloseTo(500, 0);
    expect(best.timePoints).toBeCloseTo(0, 0);
    expect(best.totalPoints).toBeCloseTo(500, 0);

    // Frontend-only: previewSubmission also surfaces fixes for the map. Each
    // B record should produce one fix.
    expect(res.value.fixes).toHaveLength(5);
    expect(res.value.fixes[0].lat).toBeCloseTo(47.495, 3);
    expect(res.value.fixes[4].lat).toBeCloseTo(47.54, 3);
  });
});
