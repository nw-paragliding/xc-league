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
import type { LeaderboardEntry, Task, Turnpoint } from '../api/tasks';
import { normalizePreviewPoints, previewSubmission } from './previewPipeline';

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

function mkEntry(overrides: Partial<LeaderboardEntry> & { pilotId: string }): LeaderboardEntry {
  return {
    rank: 1,
    pilotName: overrides.pilotId,
    submissionId: null,
    distanceFlownKm: 0,
    reachedGoal: false,
    taskTimeS: null,
    distancePoints: 0,
    timePoints: 0,
    totalPoints: 0,
    hasFlaggedCrossings: false,
    ...overrides,
  };
}

// Match FIXTURE_INPUT.existingGoalTimes ([120]) — previewSubmission derives
// existingGoalTimes from leaderboard entries with reachedGoal && taskTimeS.
const leaderboardEntries = [
  mkEntry({ pilotId: 'prior', pilotName: 'Prior Finisher', distanceFlownKm: 3.65, reachedGoal: true, taskTimeS: 120 }),
];

describe('previewSubmission parity — frontend wraps runPipeline against shared fixture', () => {
  it('parses, scores, and reaches goal with numbers identical to the backend snapshot', async () => {
    // currentUserId='new-pilot' so we don't dedup against the prior finisher
    // (different pilotId), keeping the leaderboard's goal time + total in the
    // pool for the normalisation calc.
    const res = await previewSubmission(
      FIXTURE_INPUT.igcText,
      task,
      { competitionType: 'XC' },
      leaderboardEntries,
      'new-pilot',
    );

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
    //   - preview: goal at ~147 s → raw 1000 dist + 929.6 time (§12.2,
    //     anchored at t_best = 120 s)
    //   - winner raw = 2000 → scale = 1000 / 2000 = 0.5
    //   - preview normalised: 500 dist + 464.8 time = 964.8
    // If this assertion ever drifts, either the normalisation logic changed
    // or the underlying scoring formulas did — both cases want a closer look
    // because the backend's rebuildTaskResults would have followed suit.
    expect(best.distancePoints).toBeCloseTo(500, 1);
    expect(best.timePoints).toBeCloseTo(464.8, 1);
    expect(best.totalPoints).toBeCloseTo(964.8, 1);

    // First submission for 'new-pilot' — the preview itself is the pilot's
    // predicted leaderboard row.
    expect(res.value.predicted.source).toBe('preview');
    expect(res.value.predicted.totalPoints).toBeCloseTo(964.8, 1);

    // Frontend-only: previewSubmission also surfaces fixes for the map. Each
    // B record should produce one fix.
    expect(res.value.fixes).toHaveLength(5);
    expect(res.value.fixes[0].lat).toBeCloseTo(47.495, 3);
    expect(res.value.fixes[4].lat).toBeCloseTo(47.54, 3);
  });

  it("keeps the current pilot's standing goal time in the t_best pool when they preview a slower flight", async () => {
    // Pilot 'me' holds t_best = 100 s and previews the fixture flight
    // (goal at ~147.2 s). The server never discards the old attempt, so:
    //   - goal-time pool stays {100, 120, 147.2} → preview raw time = 879.8
    //   - me's existing attempt (raw 2000) stays their best AND the winner
    //   - scale = 1000 / 2000 = 0.5 → preview shows 500 + 439.9 = 939.9
    //   - predicted row = the existing attempt at the full 1000
    // The pre-fix code dropped me's row, anchoring t_best at 120 s (preview
    // time 464.8 normalised) and predicting the preview as me's new row.
    const entries = [
      mkEntry({ pilotId: 'me', distanceFlownKm: 3.65, reachedGoal: true, taskTimeS: 100 }),
      mkEntry({ pilotId: 'other', distanceFlownKm: 3.65, reachedGoal: true, taskTimeS: 120 }),
    ];
    const res = await previewSubmission(FIXTURE_INPUT.igcText, task, { competitionType: 'XC' }, entries, 'me');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const best = res.value.attempts[res.value.bestAttemptIndex];
    expect(best.distancePoints).toBeCloseTo(500, 1);
    expect(best.timePoints).toBeCloseTo(439.9, 1);
    expect(best.totalPoints).toBeCloseTo(939.9, 1);

    expect(res.value.predicted.source).toBe('existing');
    expect(res.value.predicted.taskTimeS).toBe(100);
    expect(res.value.predicted.distancePoints).toBeCloseTo(500, 1);
    expect(res.value.predicted.timePoints).toBeCloseTo(500, 1);
    expect(res.value.predicted.totalPoints).toBeCloseTo(1000, 1);
  });
});

describe('normalizePreviewPoints — pool parity with rebuildTaskResults', () => {
  it('matches the server when the previewing pilot holds t_best (verifier worked example)', () => {
    // A holds t_best = 3600 s, B in goal at 4500 s, A previews 5400 s,
    // taskValue 1000. Server truth: pool stays {3600, 4500, 5400}, A's best
    // attempt remains the 3600 s one → A stays winner at 1000 and B keeps
    // 685.0 raw time points. The preview's own §12.2 time points anchor at
    // 3600 s → raw 438.8, scaled by 1000/2000 → 219.4 (NOT the 856.5 total
    // the pre-fix pool {4500, 5400} produced).
    const entries = [
      mkEntry({ pilotId: 'A', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600 }),
      mkEntry({ pilotId: 'B', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 4500 }),
    ];
    const r = normalizePreviewPoints({ distanceFlownKm: 50, reachedGoal: true, taskTimeS: 5400 }, entries, 'A', 1000);

    expect(r.distancePoints).toBeCloseTo(500, 1);
    expect(r.timePoints).toBeCloseTo(219.4, 1);
    expect(r.totalPoints).toBeCloseTo(719.4, 1);

    expect(r.predicted.source).toBe('existing');
    expect(r.predicted.taskTimeS).toBe(3600);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('predicts the preview as the new row when it beats the existing one (goal beats non-goal)', () => {
    // compareBestAttempt order: reached goal first. Existing non-goal row
    // loses to a goal preview even at a matching distance.
    const entries = [
      mkEntry({ pilotId: 'me', distanceFlownKm: 50, reachedGoal: false }),
      mkEntry({ pilotId: 'other', distanceFlownKm: 40, reachedGoal: false }),
    ];
    const r = normalizePreviewPoints({ distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600 }, entries, 'me', 1000);

    // Preview wins → winner raw = 1000 dist + 1000 time (sole goal time) =
    // 2000, scale 0.5.
    expect(r.predicted.source).toBe('preview');
    expect(r.predicted.reachedGoal).toBe(true);
    expect(r.totalPoints).toBeCloseTo(1000, 1);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('sole pilot with a stored non-goal 30 km row previewing a goal flight: predicted is the preview at the full task value', () => {
    // Confirmed UI repro: the leaderboard stores the pilot's non-goal 30 km at
    // 1000 pts (pre-upload scale). Previewing a goal flight must NOT render
    // "1000 vs 1000, delta 0" — post-upload the goal flight is strictly
    // better and becomes the pilot's row at the (rescaled) task value. The
    // panel now sources the pilot's post-upload row from `predicted` instead
    // of the stored pre-upload points.
    const entries = [mkEntry({ pilotId: 'me', distanceFlownKm: 30, reachedGoal: false, totalPoints: 1000 })];
    const r = normalizePreviewPoints({ distanceFlownKm: 30, reachedGoal: true, taskTimeS: 3600 }, entries, 'me', 1000);

    // Preview raw: 1000 dist (full task distance in goal) + 1000 time (sole
    // goal time) = 2000 → winner → scale 0.5 → normalized 1000.
    expect(r.totalPoints).toBeCloseTo(1000, 1);
    expect(r.predicted.source).toBe('preview');
    expect(r.predicted.reachedGoal).toBe(true);
    expect(r.predicted.taskTimeS).toBe(3600);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('keeps the existing further non-goal flight as the predicted row and in the bestDist pool', () => {
    // me's standing 30 km row stays in the bestDist pool (server pools
    // MAX(distance) over ALL attempts), so the 10 km preview scores
    // sqrt(10/30) of 1000, and the standing row remains the winner.
    const entries = [mkEntry({ pilotId: 'me', distanceFlownKm: 30, reachedGoal: false })];
    const r = normalizePreviewPoints({ distanceFlownKm: 10, reachedGoal: false, taskTimeS: null }, entries, 'me', 1000);

    expect(r.distancePoints).toBeCloseTo(577.4, 1);
    expect(r.totalPoints).toBeCloseTo(577.4, 1);
    expect(r.predicted.source).toBe('existing');
    expect(r.predicted.distanceFlownKm).toBe(30);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('treats the preview as the only candidate when the pilot has no leaderboard row', () => {
    const entries = [mkEntry({ pilotId: 'other', distanceFlownKm: 40, reachedGoal: false })];
    const r = normalizePreviewPoints({ distanceFlownKm: 20, reachedGoal: false, taskTimeS: null }, entries, 'me', 1000);

    expect(r.predicted.source).toBe('preview');
    // bestDist = 40 → preview raw = 1000·sqrt(20/40) = 707.1; winner is
    // 'other' at raw 1000 → scale 1.
    expect(r.totalPoints).toBeCloseTo(707.1, 1);
  });
});
