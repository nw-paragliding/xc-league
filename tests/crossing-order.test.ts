// =============================================================================
// Crossing order — FAI §9.2.1.2
//
// A valid crossing must be recorded "a. after the valid crossing of the
// previous cylinder in the task definition, b. not earlier than the start
// time". The greedy scan re-checks the same fix segment after tagging a
// turnpoint, and its already-inside shortcut (crossT = 0 → segment-START
// timestamp) could previously stamp a crossing at or before the previous
// crossing — before the start itself on the SSS exit segment — producing
// non-monotonic crossing sequences and negative task times that poisoned
// BestTime for every other pilot on the task.
//
// Crossing timestamps within an attempt must now be strictly increasing; a
// premature candidate does NOT abandon its segment — §6.2.1 makes every
// boundary root a crossing in its own right, so the scan re-consults ALL of
// the segment's boundary roots and accepts the earliest one that postdates
// the previous crossing (covering a graze-through whose entry root is
// pre-start but whose exit root is valid, and an already-inside segment-start
// fix where the pilot exits the zone before the next fix). Only when no root
// on the segment qualifies does the scan move on; a pilot still inside the
// cylinder then picks the tag up at the first fix that postdates the
// previous crossing.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { type AttemptTrace, detectAttempts, type Fix, type TaskDefinition } from '../src/shared/pipeline';

function fx(tSec: number, lat: number, lng = -122.0, speedKmh = 35): Fix {
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

function expectStrictlyIncreasingCrossings(attempt: AttemptTrace) {
  const times = attempt.turnpointCrossings.map((c) => c.crossingTime);
  for (let i = 1; i < times.length; i++) {
    expect(times[i]).toBeGreaterThan(times[i - 1]);
  }
}

describe('goal cylinder overlapping the SSS exit (negative task time repro)', () => {
  // 2-TP task whose goal cylinder overlaps the SSS exit point. On the SSS
  // exit segment the goal boundary sits BEFORE the SSS boundary, so the old
  // code tagged goal at ≈ t=44.8 s against an SSS crossing at ≈ t=48.6 s:
  // taskTimeS ≈ −3.9 s, reachedGoal=true — and computeTimePoints' bestTime<=0
  // branch then gave this attempt 1000 points and every honest finisher 0.
  const task: TaskDefinition = {
    id: 'task-overlap-goal',
    turnpoints: [
      { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
      { id: 'goal', sequenceIndex: 1, lat: 47.507, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ],
  };
  const fixes = [fx(0, 47.5), fx(60, 47.5045), fx(120, 47.5055), fx(180, 47.506)];

  it('rejects the pre-start goal candidate and tags goal after the SSS crossing', () => {
    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toHaveLength(1);
    const [attempt] = res.value;

    // SSS exit interpolates to ≈ 48.6 s on the first segment.
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(40_000);
    expect(attempt.sssCrossing.crossingTime).toBeLessThan(55_000);

    // Goal still counts — the pilot genuinely flew into it — but at the
    // first fix after the start (t=60 s), not at the segment start (t=0).
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.goalCrossing!.crossingTime).toBe(60_000);
    expect(attempt.goalCrossing!.crossingTime).toBeGreaterThan(attempt.sssCrossing.crossingTime);

    // The poison vector: task time can no longer be negative (or zero).
    expect(attempt.taskTimeS).not.toBeNull();
    expect(attempt.taskTimeS!).toBeGreaterThan(0);
    expectStrictlyIncreasingCrossings(attempt);
  });
});

describe('overlapping intermediate cylinders (same-segment re-check)', () => {
  // TP2 (r=2000) contains fix a of the segment on which TP1 is crossed at an
  // interpolated ≈ t=79 s. The old already-inside shortcut stamped TP2 at the
  // segment START (t=60 s) — before TP1, violating §9.2.1.2a.
  const task: TaskDefinition = {
    id: 'task-overlap-tps',
    turnpoints: [
      { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
      { id: 'tp1', sequenceIndex: 1, lat: 47.53, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
      { id: 'tp2', sequenceIndex: 2, lat: 47.532, lng: -122.0, radiusM: 2000, type: 'CYLINDER' },
      { id: 'goal', sequenceIndex: 3, lat: 47.6, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ],
  };
  const fixes = [fx(0, 47.5), fx(60, 47.52), fx(120, 47.54), fx(180, 47.56), fx(240, 47.58), fx(300, 47.6)];

  it('defers the overlapped TP to the first fix after the previous crossing', () => {
    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [attempt] = res.value;
    expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2, 3]);

    const [, tp1, tp2] = attempt.turnpointCrossings;
    // TP1 interpolates mid-segment (t=60 → t=120).
    expect(tp1.crossingTime).toBeGreaterThan(60_000);
    expect(tp1.crossingTime).toBeLessThan(120_000);
    // TP2 previously stamped at 60_000 (the segment start, before TP1);
    // now it lands on the next fix, after TP1.
    expect(tp2.crossingTime).toBe(120_000);

    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.taskTimeS!).toBeGreaterThan(0);
    expectStrictlyIncreasingCrossings(attempt);
  });
});

// 1° of latitude in the pipeline's local projection (R = 6 371 000 m).
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const latAtM = (m: number, originLat: number) => originLat + m / M_PER_DEG_LAT;

describe('same-segment root retry — graze-through straddling the SSS boundary', () => {
  // TP1 (r=200, effR 205) straddles the SSS boundary (r=3000, effR 3015).
  // One 30 s segment (2700 m → 3300 m along the courseline) contains, in
  // order: TP1's entry root (2805 m, ≈ t=105.3 s), the SSS exit crossing
  // (3015 m, ≈ t=115.8 s), and TP1's exit root (3215 m, ≈ t=125.8 s). The
  // entry root predates the start and is rejected (§9.2.1.2b) — but the
  // exit root is a valid §9.2.1 crossing in its own right and the pilot
  // must be tagged there, not forfeit TP1 (and everything downstream)
  // because the first root happened to be premature.
  const ORIGIN = 47.5;
  const task: TaskDefinition = {
    id: 'task-straddle-graze',
    turnpoints: [
      { id: 'sss', sequenceIndex: 0, lat: ORIGIN, lng: -122.0, radiusM: 3000, type: 'SSS' },
      { id: 'tp1', sequenceIndex: 1, lat: latAtM(3010, ORIGIN), lng: -122.0, radiusM: 200, type: 'CYLINDER' },
      { id: 'goal', sequenceIndex: 2, lat: latAtM(8000, ORIGIN), lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ],
  };
  const fixes = [
    fx(0, latAtM(0, ORIGIN)),
    fx(60, latAtM(1500, ORIGIN)),
    fx(100, latAtM(2700, ORIGIN)),
    fx(130, latAtM(3300, ORIGIN)), // the straddle segment
    fx(190, latAtM(5000, ORIGIN)),
    fx(250, latAtM(7000, ORIGIN)),
    fx(310, latAtM(8200, ORIGIN)), // through goal (boundary at 7595 m)
  ];

  it('tags TP1 at the same-segment exit root and reaches goal', () => {
    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toHaveLength(1);
    const [attempt] = res.value;

    // SSS exit ≈ 115.8 s.
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(110_000);
    expect(attempt.sssCrossing.crossingTime).toBeLessThan(120_000);

    // TP1 tagged at the exit root (≈ 125.8 s) — within the same segment,
    // strictly after the start.
    expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
    const tp1 = attempt.turnpointCrossings[1];
    expect(tp1.crossingTime).toBeGreaterThan(attempt.sssCrossing.crossingTime);
    expect(tp1.crossingTime).toBeLessThan(130_000);

    // Downstream goal is reached with a positive task time.
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.taskTimeS).not.toBeNull();
    expect(attempt.taskTimeS!).toBeGreaterThan(0);
    expectStrictlyIncreasingCrossings(attempt);
  });
});

describe('same-segment root retry — concentric SSS inside TP1, exit within one segment', () => {
  // SSS (r=400) sits at the centre of TP1 (r=2000). On the very first
  // segment the pilot crosses the SSS boundary at ≈ 11.5 s AND exits TP1 at
  // ≈ 57.1 s. TP1's already-inside candidate (segment-start fix, t=0) is
  // premature; the exit root — the pilot's genuine §9.2.1 boundary crossing,
  // strictly after the start — must be accepted instead of TP1 (and the
  // whole downstream course) being forfeited, since the next fix is already
  // outside TP1 and the tag can never be picked up later.
  const task: TaskDefinition = {
    id: 'task-concentric',
    turnpoints: [
      { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
      { id: 'tp1', sequenceIndex: 1, lat: 47.5, lng: -122.0, radiusM: 2000, type: 'CYLINDER' },
      { id: 'goal', sequenceIndex: 2, lat: 47.6, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ],
  };
  const fixes = [
    fx(0, 47.5),
    fx(60, 47.519), // SSS exit ≈ 11.5 s and TP1 exit ≈ 57.1 s, one segment
    fx(120, 47.538),
    fx(180, 47.557),
    fx(240, 47.576),
    fx(300, 47.595),
    fx(360, 47.614), // through goal (boundary ≈ 47.5964)
  ];

  it('tags TP1 at the same-segment exit root and reaches goal', () => {
    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toHaveLength(1);
    const [attempt] = res.value;

    // SSS exit ≈ 11.5 s.
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(10_000);
    expect(attempt.sssCrossing.crossingTime).toBeLessThan(13_000);

    // TP1 tagged at its exit root ≈ 57.1 s — after the start, before the
    // segment-end fix.
    expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
    const tp1 = attempt.turnpointCrossings[1];
    expect(tp1.crossingTime).toBeGreaterThan(attempt.sssCrossing.crossingTime);
    expect(tp1.crossingTime).toBeLessThan(60_000);

    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.taskTimeS!).toBeGreaterThan(0);
    expectStrictlyIncreasingCrossings(attempt);
  });
});

describe('equal-timestamp candidates and pre-start candidates', () => {
  // TP1 and TP2 are both 2 km cylinders containing fix t=60. TP1's boundary
  // intersection on the SSS exit segment (≈ t=11.5 s) precedes the SSS
  // crossing (≈ t=21.9 s) and must be rejected (§9.2.1.2b: not earlier than
  // the start). TP1 then tags already-inside at t=60; TP2's candidate at the
  // same t=60 is equal, not after — it must wait for the next fix.
  const task: TaskDefinition = {
    id: 'task-equal-times',
    turnpoints: [
      { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
      { id: 'tp1', sequenceIndex: 1, lat: 47.52, lng: -122.0, radiusM: 2000, type: 'CYLINDER' },
      { id: 'tp2', sequenceIndex: 2, lat: 47.523, lng: -122.0, radiusM: 2000, type: 'CYLINDER' },
      { id: 'goal', sequenceIndex: 3, lat: 47.6, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
    ],
  };
  const fixes = [fx(0, 47.5), fx(60, 47.51), fx(120, 47.515), fx(180, 47.518)];

  it('every crossing is strictly after the start and the previous crossing', () => {
    const res = detectAttempts(fixes, task, 'XC');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [attempt] = res.value;
    expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);

    const [sss, tp1, tp2] = attempt.turnpointCrossings;
    expect(sss.crossingTime).toBeGreaterThan(0);
    expect(sss.crossingTime).toBeLessThan(60_000);
    // TP1's pre-start boundary intersection (≈ 11.5 s) was rejected; the
    // already-inside tag lands on the first fix after the start.
    expect(tp1.crossingTime).toBe(60_000);
    // TP2 may not share TP1's timestamp — strictly after means the next fix.
    expect(tp2.crossingTime).toBe(120_000);

    expect(attempt.lastTurnpointIndex).toBe(2);
    expectStrictlyIncreasingCrossings(attempt);
  });
});
