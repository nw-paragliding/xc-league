// =============================================================================
// SSS crossing direction — FAI §6.2.1 / §9.2.1
//
// §6.2.1: "The direction in which such a crossing occurs is irrelevant."
// §9.2.1: a valid crossing is "a crossing into or out of the turnpoint's
// tolerance zone, in any direction."
//
// Attempt detection must therefore spawn an attempt for EVERY boundary
// crossing of the SSS cylinder — entries, exits, and both legs of a
// graze-through — not just inside→outside transitions. Entry-style starts
// (start cylinder that does not contain launch) previously produced zero SSS
// crossings and rejected the whole upload with NO_SSS_CROSSING.
//
// XC movement gate: an XC start is flown, not walked. A boundary crossing
// only spawns an attempt when the crossing segment shows movement — the
// faster of its two endpoint fixes is ≥ 8 km/h. A pilot who walks across an
// entry-style start boundary (~4–6 km/h) before launching gets the explicit
// NO_SSS_CROSSING error, not a silently zeroed flight anchored at their
// launch-prep stillness. Accepted edge: a pilot parked exactly on the
// boundary in strong wind loses that particular crossing and starts on a
// later one. HAF is exempt — walking is the point of the game there.
//
// The greedy multi-attempt model is preserved: extra crossings mean extra
// attempts, and Stage 7 best-attempt selection picks the right one.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { calculateDistances, detectAttempts, type Fix, runPipeline, type TaskDefinition } from '../src/shared/pipeline';
import {
  FIXTURE_INPUT,
  FIXTURE_TASK_BEST_DISTANCE_KM,
  FIXTURE_TASK_CLOSE_DATE,
  FIXTURE_TASK_OPEN_DATE,
} from '../src/shared/pipeline-parity-fixture';

function fx(tSec: number, lat: number, lng = -122.0, speedKmh = 45): Fix {
  return {
    timestamp: tSec * 1000,
    lat,
    lng,
    gpsAlt: 500,
    pressureAlt: 500,
    valid: true,
    gspKmh: null,
    derivedSpeedKmh: speedKmh,
  };
}

// Entry-style start: a 5 km SSS cylinder whose interior contains the goal.
// Launch is outside; the normal flight profile enters and never exits.
const ENTRY_TASK: TaskDefinition = {
  id: 'task-entry-sss',
  turnpoints: [
    { id: 'sss', sequenceIndex: 0, lat: 47.6, lng: -122.0, radiusM: 5000, type: 'SSS' },
    { id: 'goal', sequenceIndex: 1, lat: 47.62, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
  ],
};

describe('entry-style SSS (launch outside the start cylinder)', () => {
  it('a pilot who flies in and reaches goal without ever exiting is scored', () => {
    // Northbound track: enters the SSS boundary (≈ 47.5548) between t=120
    // and t=180, crosses the goal boundary (≈ 47.6164) between t=360 and
    // t=420, and ends still inside the SSS cylinder.
    const fixes = [
      fx(0, 47.5),
      fx(60, 47.52),
      fx(120, 47.54),
      fx(180, 47.56), // SSS entered
      fx(240, 47.58),
      fx(300, 47.6),
      fx(360, 47.615),
      fx(420, 47.625), // goal reached, still inside SSS
    ];

    const res = detectAttempts(fixes, ENTRY_TASK, 'XC');
    expect(res.ok).toBe(true); // was: NO_SSS_CROSSING
    if (!res.ok) return;

    expect(res.value).toHaveLength(1);
    const [attempt] = res.value;
    // Start anchored at the inward crossing, between the straddling fixes.
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(120_000);
    expect(attempt.sssCrossing.crossingTime).toBeLessThan(180_000);
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.goalCrossing!.crossingTime).toBeGreaterThan(attempt.sssCrossing.crossingTime);
    expect(attempt.taskTimeS).toBeGreaterThan(0);
  });

  it('a pilot who enters and lands inside the cylinder gets partial distance', () => {
    const fixes = [fx(0, 47.5), fx(60, 47.53), fx(120, 47.56), fx(180, 47.59), fx(240, 47.61)];

    const res = detectAttempts(fixes, ENTRY_TASK, 'XC');
    expect(res.ok).toBe(true); // was: NO_SSS_CROSSING → zero score
    if (!res.ok) return;

    const [attempt] = calculateDistances(res.value, fixes, ENTRY_TASK);
    expect(attempt.reachedGoal).toBe(false);
    expect(attempt.lastTurnpointIndex).toBe(0);
    expect(attempt.distanceFlownKm).toBeGreaterThan(1);
  });
});

describe('XC movement gate on SSS crossings', () => {
  it('walk-in to an entry-style start, rig, fly inside: NO_SSS_CROSSING, not a silent 0 km', () => {
    // Pilot parks outside the 5 km entry SSS (boundary ≈ 47.5548), walks
    // north across it at 4 km/h, stands still 60 s rigging, then flies the
    // entire in-cylinder course through goal without ever re-crossing the
    // SSS boundary. The walked crossing is the ONLY boundary crossing in
    // the track; it must not spawn an attempt whose landing scan anchors at
    // the rigging stillness and silently zeroes the flight.
    const fixes: Fix[] = [
      fx(0, 47.554, -122.0, 0), // parked
      fx(60, 47.5546, -122.0, 4), // walking
      fx(120, 47.5552, -122.0, 4), // walked across the boundary ≈ t=81 s
      ...Array.from({ length: 7 }, (_, i) => fx(180 + i * 10, 47.5553, -122.0, 0.5)), // 60 s rigging
      fx(300, 47.56, -122.0, 30), // launches
      fx(360, 47.575, -122.0, 45),
      fx(420, 47.59, -122.0, 45),
      fx(480, 47.605, -122.0, 45),
      fx(540, 47.617, -122.0, 45), // goal reached, still inside SSS
    ];

    const res = detectAttempts(fixes, ENTRY_TASK, 'XC');
    // Explicit, pilot-visible error — the pre-branch behaviour for walk-ins.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NO_SSS_CROSSING');

    // HAF is exempt: the walked crossing is a legitimate start there.
    const hafRes = detectAttempts(fixes, ENTRY_TASK, 'HIKE_AND_FLY');
    expect(hafRes.ok).toBe(true);
    if (!hafRes.ok) return;
    expect(hafRes.value[0].reachedGoal).toBe(true);
  });

  it('parked-drift across the boundary is ignored; the flight starts on a later crossing', () => {
    // Accepted edge of the gate: a pilot parked on the SSS boundary in
    // strong wind drifts across it at ~3 km/h — that crossing is lost. The
    // subsequent flown crossings still spawn attempts.
    const task: TaskDefinition = {
      id: 'task-drift',
      turnpoints: [
        { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
        { id: 'goal', sequenceIndex: 1, lat: 47.6, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
      ],
    };
    const fixes: Fix[] = [
      fx(0, 47.503, -122.0, 3), // parked just inside the boundary (≈ 334 m)
      fx(60, 47.504, -122.0, 3), // drifted outside (≈ 445 m) — crossing gated out
      fx(120, 47.5035, -122.0, 25), // airborne now — flies back in ≈ t=103 s
      fx(180, 47.52, -122.0, 60), // and out again ≈ t=121 s
      fx(240, 47.55, -122.0, 60),
      fx(300, 47.58, -122.0, 60),
      fx(360, 47.61, -122.0, 60), // goal
    ];

    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Two flown crossings spawn attempts; the ~44 s drift crossing does not.
    expect(res.value).toHaveLength(2);
    for (const attempt of res.value) {
      expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(100_000);
      expect(attempt.reachedGoal).toBe(true);
    }
  });
});

describe('graze-through of the SSS cylinder (both fixes outside)', () => {
  it('spawns an attempt for each boundary crossing of the clipped segment', () => {
    const task: TaskDefinition = {
      id: 'task-graze',
      turnpoints: [
        { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
        { id: 'goal', sequenceIndex: 1, lat: 47.6, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
      ],
    };
    // Segment t=0 → t=60 passes clean through the SSS cylinder: both
    // endpoints are ≈ 1.1 km from the centre, well outside r+tol ≈ 405 m.
    const fixes = [fx(0, 47.49), fx(60, 47.51), fx(120, 47.55), fx(180, 47.59), fx(240, 47.61)];

    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true); // was: NO_SSS_CROSSING
    if (!res.ok) return;

    // One attempt per boundary crossing: the entry leg and the exit leg.
    expect(res.value).toHaveLength(2);
    const [entry, exit] = res.value;
    expect(entry.sssCrossing.crossingTime).toBeGreaterThan(0);
    expect(exit.sssCrossing.crossingTime).toBeGreaterThan(entry.sssCrossing.crossingTime);
    expect(exit.sssCrossing.crossingTime).toBeLessThan(60_000);
    for (const attempt of res.value) expect(attempt.reachedGoal).toBe(true);
  });
});

describe('exit-style SSS regression (parity fixture baseline)', () => {
  it('keeps the pre-change best-attempt numbers; the new entry attempt loses on points', async () => {
    const result = await runPipeline(
      FIXTURE_INPUT,
      FIXTURE_TASK_OPEN_DATE,
      FIXTURE_TASK_CLOSE_DATE,
      FIXTURE_TASK_BEST_DISTANCE_KM,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The fixture track enters then exits the SSS — two crossings, two
    // attempts (previously only the exit spawned one).
    expect(result.value.scoredAttempts).toHaveLength(2);

    // Best attempt is still the exit-anchored one (later start → shorter
    // task time → more time points), with the exact numbers the parity
    // tests pin.
    const best = result.value.scoredAttempts[result.value.bestAttemptIndex];
    const other = result.value.scoredAttempts.find((a) => a !== best)!;
    expect(best.sssCrossing.crossingTime).toBeGreaterThan(other.sssCrossing.crossingTime);
    expect(best.reachedGoal).toBe(true);
    expect(best.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
    expect(best.distanceFlownKm).toBeCloseTo(3.65, 2);
    expect(best.taskTimeS).toBeGreaterThan(0);
    expect(best.taskTimeS).toBeLessThan(other.taskTimeS!);
  });
});
