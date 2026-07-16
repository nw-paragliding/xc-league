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
import { parseAndValidate, runPipelineFromParsed, type ScoredAttempt } from '../../../src/shared/pipeline';
import {
  FIXTURE_INPUT,
  FIXTURE_TASK_CLOSE_DATE,
  FIXTURE_TASK_OPEN_DATE,
  FIXTURE_TURNPOINTS,
} from '../../../src/shared/pipeline-parity-fixture';
import type { LeaderboardEntry, Task, Turnpoint } from '../api/tasks';
import { normalizePreviewPoints, previewSubmission } from './previewPipeline';

// Mirror previewPipeline's rounding so scale-application assertions are exact.
const round1 = (n: number) => Math.round(n * 10) / 10;

// normalizePreviewPoints takes a Pick of ScoredAttempt including
// hasFlaggedCrossings; most tests here don't care about the flag.
function att(
  overrides: Pick<ScoredAttempt, 'distanceFlownKm' | 'reachedGoal' | 'taskTimeS'> &
    Partial<Pick<ScoredAttempt, 'hasFlaggedCrossings'>>,
): Pick<ScoredAttempt, 'distanceFlownKm' | 'reachedGoal' | 'taskTimeS' | 'hasFlaggedCrossings'> {
  return { hasFlaggedCrossings: false, ...overrides };
}

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
    //   - both pilots in goal → §11 goal ratio 1 → DW 0.361 / TW 0.639
    //   - prior finisher: goal at 120 s → raw 361 dist + 639 time = 1000
    //   - preview: goal at ~147 s → raw 361 dist + 594.0 time (§12.2,
    //     anchored at t_best = 120 s, over the 639 pool)
    //   - winner raw = 1000 → scale = 1000 / 1000 = 1
    //   - preview normalised: 361 dist + 594.0 time = 955.0
    // If this assertion ever drifts, either the normalisation logic changed
    // or the underlying scoring formulas did — both cases want a closer look
    // because the backend's rebuildTaskResults would have followed suit.
    expect(best.distancePoints).toBeCloseTo(361, 1);
    expect(best.timePoints).toBeCloseTo(594.0, 1);
    expect(best.totalPoints).toBeCloseTo(955.0, 1);

    // First submission for 'new-pilot' — the preview itself is the pilot's
    // predicted leaderboard row.
    expect(res.value.predicted.source).toBe('preview');
    expect(res.value.predicted.totalPoints).toBeCloseTo(955.0, 1);

    // Frontend-only: previewSubmission also surfaces fixes for the map. Each
    // B record should produce one fix.
    expect(res.value.fixes).toHaveLength(5);
    expect(res.value.fixes[0].lat).toBeCloseTo(47.495, 3);
    expect(res.value.fixes[4].lat).toBeCloseTo(47.54, 3);
  });

  it("keeps the current pilot's standing goal time in the t_best pool when they preview a slower flight", async () => {
    // Pilot 'me' holds t_best = 100 s and previews the fixture flight
    // (goal at ~147.2 s). Everyone is in goal → GR 1 → DW 0.361 / TW 0.639.
    // The server never discards the old attempt, so:
    //   - goal-time pool stays {100, 120, 147.2} → preview raw time = 562.2
    //     (§12.2 SpeedFraction over the 639 pool)
    //   - me's existing attempt (raw 361 + 639 = 1000) stays their best AND
    //     the winner → scale = 1000 / 1000 = 1
    //   - preview shows 361 + 562.2 = 923.2
    //   - predicted row = the existing attempt at the full 1000
    // The pre-fix code dropped me's row, anchoring t_best at 120 s and
    // predicting the preview as me's new row.
    const entries = [
      mkEntry({ pilotId: 'me', distanceFlownKm: 3.65, reachedGoal: true, taskTimeS: 100 }),
      mkEntry({ pilotId: 'other', distanceFlownKm: 3.65, reachedGoal: true, taskTimeS: 120 }),
    ];
    const res = await previewSubmission(FIXTURE_INPUT.igcText, task, { competitionType: 'XC' }, entries, 'me');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const best = res.value.attempts[res.value.bestAttemptIndex];
    expect(best.distancePoints).toBeCloseTo(361, 1);
    expect(best.timePoints).toBeCloseTo(562.2, 1);
    expect(best.totalPoints).toBeCloseTo(923.2, 1);

    expect(res.value.predicted.source).toBe('existing');
    expect(res.value.predicted.taskTimeS).toBe(100);
    expect(res.value.predicted.distancePoints).toBeCloseTo(361, 1);
    expect(res.value.predicted.timePoints).toBeCloseTo(639, 1);
    expect(res.value.predicted.totalPoints).toBeCloseTo(1000, 1);
  });
});

describe('normalizePreviewPoints — pool parity with rebuildTaskResults', () => {
  it('matches the server when the previewing pilot holds t_best (verifier worked example)', () => {
    // A holds t_best = 3600 s, B in goal at 4500 s, A previews 5400 s,
    // taskValue 1000. Both pilots in goal → GR 1 → DW 0.361 / TW 0.639.
    // Server truth: pool stays {3600, 4500, 5400}, A's best attempt remains
    // the 3600 s one → A stays winner at raw 361 + 639 = 1000 (scale 1) and
    // B keeps 437.7 raw time points. The preview's own §12.2 time points
    // anchor at 3600 s → 280.4 over the 639 pool (NOT the larger figure a
    // pool without A's row, anchored at 4500 s, would produce).
    const entries = [
      mkEntry({ pilotId: 'A', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600 }),
      mkEntry({ pilotId: 'B', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 4500 }),
    ];
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 50, reachedGoal: true, taskTimeS: 5400 }),
      entries,
      'A',
      1000,
    );

    expect(r.distancePoints).toBeCloseTo(361, 1);
    expect(r.timePoints).toBeCloseTo(280.4, 1);
    expect(r.totalPoints).toBeCloseTo(641.4, 1);

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
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600 }),
      entries,
      'me',
      1000,
    );

    // Preview wins → GR = 1/2 (me in goal via the preview, other not) →
    // DW 0.422375; winner raw = 422.375 dist + 577.625 time (sole goal
    // time) = 1000, scale 1.
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
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 30, reachedGoal: true, taskTimeS: 3600 }),
      entries,
      'me',
      1000,
    );

    // Sole pilot, now in goal → GR 1 → DW 0.361. Preview raw: 361 dist +
    // 639 time (sole goal time) = 1000 → winner → scale 1 → normalized 1000.
    expect(r.totalPoints).toBeCloseTo(1000, 1);
    expect(r.predicted.source).toBe('preview');
    expect(r.predicted.reachedGoal).toBe(true);
    expect(r.predicted.taskTimeS).toBe(3600);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('keeps the existing further non-goal flight as the predicted row and in the bestDist pool', () => {
    // me's standing 30 km row stays in the bestDist pool (server pools
    // MAX(distance) over ALL attempts), so the 10 km preview scores
    // sqrt(10/30) of the winner's 1000, and the standing row remains the
    // winner. (GR = 0 → the 0.9 distance weight scales winner and preview
    // alike, so normalization washes it out of the ratio.)
    const entries = [mkEntry({ pilotId: 'me', distanceFlownKm: 30, reachedGoal: false })];
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 10, reachedGoal: false, taskTimeS: null }),
      entries,
      'me',
      1000,
    );

    expect(r.distancePoints).toBeCloseTo(577.4, 1);
    expect(r.totalPoints).toBeCloseTo(577.4, 1);
    expect(r.predicted.source).toBe('existing');
    expect(r.predicted.distanceFlownKm).toBe(30);
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });

  it('treats the preview as the only candidate when the pilot has no leaderboard row', () => {
    const entries = [mkEntry({ pilotId: 'other', distanceFlownKm: 40, reachedGoal: false })];
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 20, reachedGoal: false, taskTimeS: null }),
      entries,
      'me',
      1000,
    );

    expect(r.predicted.source).toBe('preview');
    // GR = 0 → pool 900. bestDist = 40 → preview raw = 900·√(20/40) =
    // 636.4; winner is 'other' at raw 900 → scale 1000/900 → 707.1.
    expect(r.totalPoints).toBeCloseTo(707.1, 1);
  });

  it('a goal preview moves the goal ratio and reproduces the server rebuild exactly', () => {
    // Companion to the standings.test.ts case "GR-changing upload parity":
    // one non-goal pilot at 40 km is on the board (GR = 0); pilot 'me'
    // previews a goal flight at 50 km / 3600 s. Post-upload the server field
    // is 2 pilots with 1 in goal → GR = 0.5 → DW = 0.422375 / TW = 0.577625,
    // and the rebuild persists 422.4 + 577.6 = 1000 for the goal pilot. The
    // preview must show those exact numbers — a 50/50 (or GR = 0) split
    // would not.
    const entries = [mkEntry({ pilotId: 'other', distanceFlownKm: 40, reachedGoal: false })];
    const r = normalizePreviewPoints({ distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600 }, entries, 'me', 1000);

    expect(r.distancePoints).toBeCloseTo(422.4, 1);
    expect(r.timePoints).toBeCloseTo(577.6, 1);
    expect(r.totalPoints).toBeCloseTo(1000, 1);
    expect(r.predicted.source).toBe('preview');
    expect(r.predicted.totalPoints).toBeCloseTo(1000, 1);
  });
});

// =============================================================================
// hasFlaggedCrossings on the predicted row
// =============================================================================

describe('normalizePreviewPoints — predicted row carries hasFlaggedCrossings', () => {
  it("wires the preview attempt's flag when the preview becomes the pilot's row", () => {
    const entries = [mkEntry({ pilotId: 'other', distanceFlownKm: 40, reachedGoal: false })];
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 20, reachedGoal: false, taskTimeS: null, hasFlaggedCrossings: true }),
      entries,
      'me',
      1000,
    );

    expect(r.predicted.source).toBe('preview');
    expect(r.predicted.hasFlaggedCrossings).toBe(true);
  });

  it("wires the existing row's flag when the previous best stays the pilot's row", () => {
    // Existing goal row beats a non-goal preview; the row keeps ITS flag
    // state (flagged here), not the clean preview's.
    const entries = [
      mkEntry({ pilotId: 'me', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600, hasFlaggedCrossings: true }),
    ];
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 20, reachedGoal: false, taskTimeS: null }),
      entries,
      'me',
      1000,
    );

    expect(r.predicted.source).toBe('existing');
    expect(r.predicted.hasFlaggedCrossings).toBe(true);
  });

  it('keeps the predicted row clean when neither the winning candidate nor the preview is flagged', () => {
    const entries = [
      mkEntry({ pilotId: 'me', distanceFlownKm: 50, reachedGoal: true, taskTimeS: 3600, hasFlaggedCrossings: false }),
    ];
    // Flagged preview LOSES to the clean existing row — the flag must not
    // leak onto the predicted (existing) row.
    const r = normalizePreviewPoints(
      att({ distanceFlownKm: 20, reachedGoal: false, taskTimeS: null, hasFlaggedCrossings: true }),
      entries,
      'me',
      1000,
    );

    expect(r.predicted.source).toBe('existing');
    expect(r.predicted.hasFlaggedCrossings).toBe(false);
  });
});

describe('previewSubmission — flagged flight surfaces hasFlaggedCrossings (metrics + predicted path)', () => {
  it('HAF ground-check failure flags the best attempt and the predicted row', async () => {
    // HIKE_AND_FLY season with TP1 force-ground. The fixture track flies
    // through TP1 at ~60 km/h with no 20 s sub-5 km/h window inside the
    // cylinder, so Stage 4 leaves the crossing unconfirmed and flags the
    // attempt — exactly what the leaderboard renders as ⚑. The preview panel
    // reads the flag off attempts[bestAttemptIndex] (metrics path) and off
    // predicted (after-upload note), so both must carry it.
    const hafTask: Task = {
      ...task,
      turnpoints: turnpoints.map((tp) => (tp.sequenceIndex === 1 ? { ...tp, forceGround: true } : tp)),
    };
    const res = await previewSubmission(FIXTURE_INPUT.igcText, hafTask, { competitionType: 'HIKE_AND_FLY' }, [], 'me');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const best = res.value.attempts[res.value.bestAttemptIndex];
    expect(best.hasFlaggedCrossings).toBe(true);

    expect(res.value.predicted.source).toBe('preview');
    expect(res.value.predicted.hasFlaggedCrossings).toBe(true);
  });

  it('clean XC flight previews unflagged on both paths', async () => {
    const res = await previewSubmission(
      FIXTURE_INPUT.igcText,
      task,
      { competitionType: 'XC' },
      leaderboardEntries,
      'new-pilot',
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.attempts[res.value.bestAttemptIndex].hasFlaggedCrossings).toBe(false);
    expect(res.value.predicted.hasFlaggedCrossings).toBe(false);
  });
});

// =============================================================================
// One scale across all previewed attempts
// =============================================================================

// A track that spawns THREE attempts: north out of the SSS to TP1, back south
// INTO the SSS (second crossing), out again (third crossing), then TP1 and
// goal. Crossing direction is irrelevant (§6.2.1) and attempts are not
// bounded by later SSS crossings, so all three attempts greedily reach goal
// with different task times. Every inter-fix speed is ≥ ~33 km/h — no
// stillness, so no landing cutoff, no suppression, no flags.
//
// Lat in IGC DDMMmmm: 47.495→4729700, 47.500→4730000, 47.510→4730600,
// 47.520→4731200, 47.540→4732400 (same geometry as the parity fixture).
const MULTI_ATTEMPT_IGC = [
  'AXLK00001',
  'HFDTE230126',
  'B1000004729700N12200000WA0050000500', // 47.495 outside SSS
  'B1001004730000N12200000WA0050000500', // 47.500 inside SSS
  'B1002004730600N12200000WA0050000500', // 47.510 out → SSS crossing #1
  'B1003004731200N12200000WA0050000500', // 47.520 TP1
  'B1004004730000N12200000WA0050000500', // 47.500 back in → SSS crossing #2
  'B1005004730600N12200000WA0050000500', // 47.510 out again → SSS crossing #3
  'B1006004731200N12200000WA0050000500', // 47.520 TP1
  'B1007004732400N12200000WA0050000500', // 47.540 GOAL
].join('\n');

describe('previewSubmission — every attempt shares the post-upload scale', () => {
  it('applies the single taskValue/winnerRaw scale to non-best attempts (no raw-1000-scale leftovers)', async () => {
    // Prior finisher at 120 s holds the winner raw total (2000), so the
    // normalisation scale is well below 1 — any attempt left on the raw
    // pipeline scale would stick out.
    const res = await previewSubmission(
      MULTI_ATTEMPT_IGC,
      task,
      { competitionType: 'XC' },
      leaderboardEntries,
      'new-pilot',
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.attempts.length).toBeGreaterThanOrEqual(2);

    // Raw pipeline run with the exact inputs previewSubmission derives from
    // the task + leaderboard (existingGoalTimes [120], best distance 3.65).
    const parsed = parseAndValidate(MULTI_ATTEMPT_IGC);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const raw = await runPipelineFromParsed(
      parsed.value,
      {
        igcText: MULTI_ATTEMPT_IGC,
        task: { id: task.id, turnpoints: FIXTURE_TURNPOINTS },
        existingGoalTimes: [120],
        competitionType: 'XC',
      },
      FIXTURE_TASK_OPEN_DATE,
      FIXTURE_TASK_CLOSE_DATE,
      3.65,
    );
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;

    const bestIdx = res.value.bestAttemptIndex;
    expect(raw.value.bestAttemptIndex).toBe(bestIdx);
    expect(raw.value.scoredAttempts).toHaveLength(res.value.attempts.length);

    // The scale previewSubmission applied — recomputed through the same
    // exported entry point it uses.
    const { scale, ...bestNormalized } = normalizePreviewPoints(
      raw.value.scoredAttempts[bestIdx],
      leaderboardEntries,
      'new-pilot',
      1000,
    );
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1); // guard: the scale actually moves the numbers

    res.value.attempts.forEach((a, i) => {
      const r = raw.value.scoredAttempts[i];
      if (i === bestIdx) {
        // Best attempt: the fully pooled recomputation (leaderboard values).
        expect(a.distancePoints).toBeCloseTo(bestNormalized.distancePoints, 5);
        expect(a.timePoints).toBeCloseTo(bestNormalized.timePoints, 5);
        expect(a.totalPoints).toBeCloseTo(bestNormalized.totalPoints, 5);
      } else {
        // Non-best attempts: raw pipeline points × the SAME scale. Before
        // the fix these came back untouched on the raw 1000-point scale.
        expect(r.totalPoints).toBeGreaterThan(0);
        expect(a.distancePoints).toBeCloseTo(round1(r.distancePoints * scale), 5);
        expect(a.timePoints).toBeCloseTo(round1(r.timePoints * scale), 5);
        expect(a.totalPoints).toBeCloseTo(round1(a.distancePoints + a.timePoints), 5);
        expect(a.totalPoints).toBeLessThan(r.totalPoints);
      }
    });
  });
});
