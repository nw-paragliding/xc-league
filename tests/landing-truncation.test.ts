// =============================================================================
// Landing truncation — FAI §9.3 / §12.1
//
// §9.3: flown distance considers "each point where the pilot is still flying";
// §12.1: distance counts "up until the pilot landed or the task deadline was
// reached". For XC seasons the pipeline finds the landing GLOBALLY, once per
// track: the start of the first landing-stillness window — ≥ 30 s in which
// every fix is below 5 km/h AND the gpsAlt spread stays under 15 m — at/after
// the accepted anchor SSS crossing. Everything from that timestamp onward is
// dead: no turnpoint or goal crossings, no distance credit, and an SSS
// crossing at/after the cutoff can't even start an attempt (a §12.1 XC flight
// ends at the first landing, so a retrieve car that re-crosses the start
// boundary spawns nothing).
//
// The anchor is SELF-CORRECTING: a stillness window is only accepted as THE
// landing when the attempts in front of it show flight evidence — a turnpoint
// crossing beyond the SSS, or ≥ 0.5 km of §9.3 course progress — before the
// cutoff. A no-evidence window is pre-flight ground time (car up the hill,
// hike-in); its crossings are discarded and the scan re-anchors at the first
// crossing past the window, or errors NO_SSS_CROSSING when none exists.
//
// The altitude-flatness requirement keeps a glider parked in ridge lift
// (steady 0–4 km/h over the ground but bobbing in the lift band) from being
// read as landed; a landed pilot's GPS altitude is flat within noise.
//
// A truncation that voids an otherwise-valid crossing of the attempt's own
// scan raises the attempt's ⚑ (hasFlaggedCrossings); a suppressed
// post-landing SSS crossing flags only the surviving attempts that did NOT
// reach goal (a sealed goal score cannot have been affected by it).
// Distance-only truncation stays quiet.
//
// HAF seasons are exempt from all of this — travelling on the ground is part
// of the game.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  calculateDistances,
  detectAttempts,
  type Fix,
  runPipeline,
  scoreAttempts,
  selectBestAttempt,
  type TaskDefinition,
} from '../src/shared/pipeline';
import { type Cylinder, optimiseRoute } from '../src/shared/task-engine';

// ── Shared geometry ──────────────────────────────────────────────────────────
// Four collinear cylinders along the −122° meridian, 0.1° (≈ 11.12 km) apart,
// 400 m radius each (same shape as tests/partial-distance.test.ts).

const TASK: TaskDefinition = {
  id: 'task-landing',
  turnpoints: [
    { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
    { id: 'tp1', sequenceIndex: 1, lat: 47.6, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
    { id: 'tp2', sequenceIndex: 2, lat: 47.7, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
    { id: 'goal', sequenceIndex: 3, lat: 47.8, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
  ],
};

const CYLINDERS: Cylinder[] = TASK.turnpoints.map((tp) => ({
  lat: tp.lat,
  lng: tp.lng,
  radiusM: tp.radiusM,
  type: tp.type,
}));
const TASK_KM = optimiseRoute(CYLINDERS).totalDistanceKm; // ≈ 32.56

function fx(tSec: number, lat: number, speedKmh: number, alt = 500, lng = -122.0): Fix {
  return {
    timestamp: tSec * 1000,
    lat,
    lng,
    gpsAlt: alt,
    pressureAlt: alt,
    valid: true,
    gspKmh: null,
    derivedSpeedKmh: speedKmh,
  };
}

function detect(fixes: Fix[], competitionType: 'XC' | 'HIKE_AND_FLY') {
  const res = detectAttempts(fixes, TASK, competitionType);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unreachable');
  return calculateDistances(res.value, fixes, TASK);
}

// Pilot launches inside SSS, flies north, tags TP1, touches down at 47.65
// (between TP1 and TP2), goes still for 30 s (flat altitude), then the
// retrieve car drives north along the courseline straight through TP2 and
// beyond.
function retrieveAlongCourseTrack(): Fix[] {
  const fixes: Fix[] = [
    fx(0, 47.5, 40),
    fx(60, 47.51, 40), // SSS exited ≈ t=22 s
    fx(120, 47.53, 40),
    fx(180, 47.55, 40),
    fx(240, 47.57, 40),
    fx(300, 47.59, 40),
    fx(360, 47.6, 40), // TP1 tagged ≈ t=338 s
    fx(420, 47.62, 40),
    fx(480, 47.65, 40), // touch-down
  ];
  for (let t = 485; t <= 515; t += 5) fixes.push(fx(t, 47.65, 0.5)); // 30 s still, alt flat
  fixes.push(fx(570, 47.66, 60));
  fixes.push(fx(630, 47.67, 60));
  fixes.push(fx(690, 47.69, 65));
  fixes.push(fx(750, 47.71, 65)); // car crosses TP2 (boundary ≈ 47.6964)
  fixes.push(fx(810, 47.73, 65));
  fixes.push(fx(870, 47.75, 65));
  return fixes;
}

describe('landing truncation — retrieve along the courseline (XC)', () => {
  it('stops crossings and distance at the stillness-window start, and flags the voided TP', () => {
    const [attempt] = detect(retrieveAlongCourseTrack(), 'XC');

    // Landing = first still fix, not the end of the window.
    expect(attempt.landingCutoffMs).toBe(485_000);

    // TP2 was only "crossed" by the car — must not count.
    expect(attempt.lastTurnpointIndex).toBe(1);
    expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0, 1]);
    expect(attempt.reachedGoal).toBe(false);

    // The truncation voided an otherwise-valid TP2 crossing — not silent.
    expect(attempt.truncationVoidedCrossing).toBe(true);
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(true);

    // Distance credit ends at the landing spot (47.65, halfway TP1→TP2):
    // ≈ 16.28 km, not the ≈ 27.4 km the drive to 47.75 would give.
    expect(attempt.distanceFlownKm).toBeCloseTo(16.28, 1);
    expect(attempt.distanceFlownKm).toBeLessThan(20);
  });

  it('HAF season is exempt: the same track keeps its ground progress', () => {
    const [attempt] = detect(retrieveAlongCourseTrack(), 'HIKE_AND_FLY');

    expect(attempt.landingCutoffMs).toBeNull();
    // Ground travel is legitimate: TP2 counts, and so does the distance.
    expect(attempt.lastTurnpointIndex).toBe(2);
    expect(attempt.distanceFlownKm).toBeCloseTo(27.4, 1);
    expect(attempt.truncationVoidedCrossing).toBeFalsy();
  });
});

describe('landing truncation — retrieve car re-crossing the SSS boundary (XC)', () => {
  // The poison-vector regression: pilot exits SSS, sinks back into the
  // cylinder, lands and goes still ≥ 30 s; the retrieve car then drives OUT
  // of the SSS cylinder (a boundary crossing that would previously spawn a
  // fresh attempt whose per-attempt stillness scan started after the
  // landing) and up the valley road through TP1, TP2 and goal. The global
  // cutoff suppresses the car-spawned attempt entirely, so the car can
  // never set reachedGoal or contribute a taskTimeS to the t_best pool.
  function carRetrieveTrack(): Fix[] {
    const fixes: Fix[] = [
      fx(0, 47.5, 40), // launch at the SSS centre
      fx(60, 47.51, 40), // SSS exited ≈ t=21.9 s
      fx(120, 47.502, 20), // sinks back INSIDE the cylinder ≈ t=107.7 s
    ];
    for (let t = 130; t <= 165; t += 5) fixes.push(fx(t, 47.502, 1)); // lands, 35 s still, alt flat
    fixes.push(fx(225, 47.503, 10)); // retrieve car sets off
    fixes.push(fx(285, 47.51, 45)); // car exits the SSS cylinder ≈ t=230 s
    fixes.push(fx(345, 47.55, 80));
    fixes.push(fx(405, 47.61, 80)); // car through TP1
    fixes.push(fx(465, 47.66, 80));
    fixes.push(fx(525, 47.71, 80)); // car through TP2
    fixes.push(fx(585, 47.76, 80));
    fixes.push(fx(645, 47.81, 80)); // car through goal
    return fixes;
  }

  it('suppresses the car-spawned attempt; the genuine truncated flight is best; no car t_best', () => {
    const attempts = detect(carRetrieveTrack(), 'XC');

    // Only the two airborne SSS crossings (exit + sink-back re-entry) spawn
    // attempts; the car's post-landing exit crossing is suppressed.
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);

    for (const attempt of attempts) {
      expect(attempt.landingCutoffMs).toBe(130_000);
      expect(attempt.sssCrossing.crossingTime).toBeLessThan(130_000);
      // Nothing the car did counts: no goal, no task time, no TPs.
      expect(attempt.reachedGoal).toBe(false);
      expect(attempt.taskTimeS).toBeNull();
      expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0]);
      // The suppression + the car's would-be TP crossings are visible.
      expect(attempt.truncationVoidedCrossing).toBe(true);
    }

    const scored = scoreAttempts(attempts, [], TASK_KM);
    const best = scored[selectBestAttempt(scored)];
    expect(best.reachedGoal).toBe(false);
    expect(best.taskTimeS).toBeNull();
    expect(best.hasFlaggedCrossings).toBe(true);
    // Genuine flight progress only reached 47.51 — a sliver of the course.
    expect(best.distanceFlownKm).toBeLessThan(2);
    // The t_best pool gets nothing from this upload.
    expect(scored.every((a) => !a.reachedGoal && a.taskTimeS === null)).toBe(true);
  });

  it('HAF season is exempt: the car-exit crossing still spawns a scoreable attempt', () => {
    const attempts = detect(carRetrieveTrack(), 'HIKE_AND_FLY');
    expect(attempts).toHaveLength(3);
    expect(attempts.some((a) => a.reachedGoal)).toBe(true);
  });
});

describe('landing truncation — walking across goal (XC)', () => {
  // Pilot lands ~500 m short of the goal centre (~100 m short of the tag
  // boundary), packs up for 30 s, then walks across the goal cylinder.
  function walkAcrossGoalTrack(): Fix[] {
    const fixes: Fix[] = [
      fx(0, 47.5, 40),
      fx(60, 47.52, 60),
      fx(120, 47.55, 60),
      fx(180, 47.58, 60),
      fx(240, 47.61, 60), // TP1 tagged ≈ t=213 s
      fx(300, 47.64, 60),
      fx(360, 47.67, 60),
      fx(420, 47.7, 60), // TP2 tagged ≈ t=413 s
      fx(480, 47.73, 60),
      fx(540, 47.76, 60),
      fx(600, 47.79, 60),
      fx(604, 47.7955, 15), // final glide, touch-down
    ];
    for (let t = 610; t <= 640; t += 5) fixes.push(fx(t, 47.7955, 0.6)); // 30 s still, alt flat
    fixes.push(fx(700, 47.7965, 4)); // walks into the goal cylinder
    fixes.push(fx(760, 47.798, 4));
    fixes.push(fx(820, 47.8, 4));
    return fixes;
  }

  it('the walked goal crossing is void, flagged, and distance stops at the landing', () => {
    const [attempt] = detect(walkAcrossGoalTrack(), 'XC');

    expect(attempt.landingCutoffMs).toBe(610_000);
    expect(attempt.reachedGoal).toBe(false);
    expect(attempt.goalCrossing).toBeNull();
    expect(attempt.lastTurnpointIndex).toBe(2);

    // Voiding the walked goal crossing must not be silent.
    expect(attempt.truncationVoidedCrossing).toBe(true);
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(true);

    // Credit up to the touch-down fix at 47.7955 — ~100 m of remaining
    // distance to the goal boundary, not the full task distance.
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM - 0.1, 1);
    expect(attempt.distanceFlownKm).toBeLessThan(TASK_KM - 0.05);
  });
});

describe('landing truncation — distance-only truncation is not flagged', () => {
  it('landing then a retrieve that never crosses anything truncates quietly', () => {
    const fixes: Fix[] = [
      fx(0, 47.5, 40),
      fx(60, 47.51, 40),
      fx(120, 47.54, 60),
      fx(180, 47.57, 60),
      fx(240, 47.6, 60), // TP1 tagged
      fx(300, 47.63, 60),
      fx(360, 47.65, 40), // touch-down between TP1 and TP2
    ];
    for (let t = 365; t <= 400; t += 5) fixes.push(fx(t, 47.65, 0.5)); // 35 s still, alt flat
    // Retrieve drives EAST, away from the courseline — no TP2, no goal.
    fixes.push(fx(460, 47.65, 50, 500, -121.95));
    fixes.push(fx(520, 47.65, 50, 500, -121.9));

    const [attempt] = detect(fixes, 'XC');
    expect(attempt.landingCutoffMs).toBe(365_000);
    expect(attempt.lastTurnpointIndex).toBe(1);
    expect(attempt.reachedGoal).toBe(false);
    expect(attempt.distanceFlownKm).toBeCloseTo(16.28, 1);

    // No otherwise-valid crossing was voided — no ⚑.
    expect(attempt.truncationVoidedCrossing).toBeFalsy();
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(false);
  });
});

describe('landing truncation — genuine slow flight is NOT a landing', () => {
  it('15 s of near-zero ground speed (scratchy low save) does not truncate', () => {
    const fixes: Fix[] = [
      fx(0, 47.5, 40),
      fx(60, 47.51, 40),
      fx(120, 47.54, 60),
      fx(180, 47.57, 60),
      // 15 s below the stillness speed — far shorter than the 30 s window
      fx(240, 47.59, 3),
      fx(245, 47.5901, 2),
      fx(250, 47.5902, 2),
      fx(255, 47.5903, 2),
      // climbs away and finishes the task
      fx(260, 47.591, 8),
      fx(320, 47.6, 45),
      fx(380, 47.63, 60),
      fx(440, 47.67, 60),
      fx(500, 47.71, 60),
      fx(560, 47.75, 60),
      fx(620, 47.79, 60),
      fx(680, 47.81, 60),
    ];
    const [attempt] = detect(fixes, 'XC');

    expect(attempt.landingCutoffMs).toBeNull();
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
  });

  it('a noisy 3–7 km/h hover (headwind soaring) does not truncate', () => {
    const hoverSpeeds = [3, 7, 4, 6, 3, 8, 4, 6, 2, 7]; // > 45 s, never 30 s below 5
    const fixes: Fix[] = [
      fx(0, 47.5, 40),
      fx(60, 47.51, 40),
      fx(120, 47.54, 60),
      fx(180, 47.57, 60),
      ...hoverSpeeds.map((speed, i) => fx(240 + i * 5, 47.59 + i * 0.0001, speed)),
      fx(300, 47.6, 45),
      fx(360, 47.63, 60),
      fx(420, 47.67, 60),
      fx(480, 47.71, 60),
      fx(540, 47.75, 60),
      fx(600, 47.79, 60),
      fx(660, 47.81, 60),
    ];
    const [attempt] = detect(fixes, 'XC');

    expect(attempt.landingCutoffMs).toBeNull();
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
  });

  it('parked ridge-soaring (30+ s at 2–4 km/h, gpsAlt bobbing > 15 m) does not truncate', () => {
    // Steady laminar wind: ground speed sits at 2–4 km/h for 35 s straight —
    // the speed signature alone reads as landed. The glider is riding the
    // lift band though, so its GPS altitude bobs by ~20 m; the flatness
    // requirement keeps the flight alive.
    const parkedAlts = [595, 615, 595, 613, 597, 615, 596, 614];
    const fixes: Fix[] = [
      fx(0, 47.5, 40, 500),
      fx(60, 47.51, 40, 520),
      fx(120, 47.54, 60, 560),
      fx(180, 47.57, 60, 600),
      ...parkedAlts.map((alt, i) => fx(240 + i * 5, 47.59 + i * 0.00001, 2 + (i % 3), alt)),
      fx(280, 47.591, 10, 620), // pushes forward out of the park
      fx(340, 47.6, 45, 700),
      fx(400, 47.63, 60, 800),
      fx(460, 47.67, 60, 900),
      fx(520, 47.71, 60, 900),
      fx(580, 47.75, 60, 800),
      fx(640, 47.79, 60, 700),
      fx(700, 47.81, 60, 600),
    ];
    const [attempt] = detect(fixes, 'XC');

    expect(attempt.landingCutoffMs).toBeNull();
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
    expect(attempt.truncationVoidedCrossing).toBeFalsy();
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(false);
  });

  it('the identical stop with FLAT altitude is a landing: truncated AND flagged', () => {
    // Same track shape as the ridge-soaring case, but the 35 s stop has a
    // flat GPS altitude — a top-landing. The later "flight" (a relaunch the
    // §12.1 flight model does not credit) is voided and flagged.
    const fixes: Fix[] = [
      fx(0, 47.5, 40, 500),
      fx(60, 47.51, 40, 520),
      fx(120, 47.54, 60, 560),
      fx(180, 47.57, 60, 600),
      ...Array.from({ length: 8 }, (_, i) => fx(240 + i * 5, 47.59 + i * 0.00001, 2 + (i % 3), 600)),
      fx(280, 47.591, 10, 620),
      fx(340, 47.6, 45, 700),
      fx(400, 47.63, 60, 800),
      fx(460, 47.67, 60, 900),
      fx(520, 47.71, 60, 900),
      fx(580, 47.75, 60, 800),
      fx(640, 47.79, 60, 700),
      fx(700, 47.81, 60, 600),
    ];
    const [attempt] = detect(fixes, 'XC');

    expect(attempt.landingCutoffMs).toBe(240_000);
    expect(attempt.reachedGoal).toBe(false);
    // TP1 (boundary ≈ 47.5964) was never reached before the landing.
    expect(attempt.lastTurnpointIndex).toBe(0);
    expect(attempt.distanceFlownKm).toBeLessThan(TASK_KM / 2);

    // The voided post-landing TP1 crossing surfaces as ⚑ for review.
    expect(attempt.truncationVoidedCrossing).toBe(true);
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(true);
  });
});

describe('self-correcting anchor — pre-flight ground movement across the SSS (XC)', () => {
  // Finding 1 regression: the logger is running before launch and the drive
  // up the hill crosses the SSS cylinder at vehicle speed. Rigging stillness
  // at launch must NOT be accepted as the landing — the drive shows no course
  // progress, so the scan re-anchors at the first in-flight crossing and the
  // genuine flight scores in full (it scored 0.0 before this fix).
  function driveUpThenFlyTrack(): Fix[] {
    const fixes: Fix[] = [
      fx(0, 47.49, 30), // car driving up the hill, south of the SSS
      fx(60, 47.4945, 30),
      fx(120, 47.499, 30), // crossed the SSS boundary (≈ 47.4964) ≈ t=85 s
    ];
    for (let t = 125; t <= 200; t += 5) fixes.push(fx(t, 47.4995, 0.5)); // 75 s rigging, alt flat
    fixes.push(fx(260, 47.505, 30)); // launches; exits the SSS in flight ≈ t=245 s
    fixes.push(fx(320, 47.52, 50));
    fixes.push(fx(380, 47.55, 55));
    fixes.push(fx(440, 47.58, 55));
    fixes.push(fx(500, 47.61, 55)); // TP1
    fixes.push(fx(560, 47.64, 55));
    fixes.push(fx(620, 47.67, 55));
    fixes.push(fx(680, 47.7, 55)); // TP2
    fixes.push(fx(740, 47.73, 55));
    fixes.push(fx(800, 47.76, 55));
    fixes.push(fx(860, 47.79, 55));
    fixes.push(fx(920, 47.81, 55)); // goal
    return fixes;
  }

  it('drive-up at 30 km/h through the SSS + rigging stillness: the flight still scores goal', () => {
    const attempts = detect(driveUpThenFlyTrack(), 'XC');

    // The car's crossing spawned nothing; only the in-flight exit survives.
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(200_000);
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.taskTimeS).toBeGreaterThan(0);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
    // Re-anchored past the rigging window; no landing after launch.
    expect(attempt.landingCutoffMs).toBeNull();
    expect(attempt.truncationVoidedCrossing).toBeFalsy();

    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(false);
  });

  it('HAF season is exempt: the driven crossing is a legitimate start', () => {
    const attempts = detect(driveUpThenFlyTrack(), 'HIKE_AND_FLY');
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.landingCutoffMs).toBeNull();
      expect(attempt.reachedGoal).toBe(true);
    }
  });

  it('hike-in whose walking crossing has a GPS-jitter fix above walking pace: same rescue', () => {
    // The walk across the boundary is 4 km/h with one 9 km/h jitter endpoint
    // on the crossing segment — fast enough to defeat any walking-pace speed
    // gate (it defeated the old 8 km/h one). The walk itself then reads as a
    // stillness window (< 5 km/h); with no course progress in front of it the
    // scan re-anchors at the in-flight exit and the flight scores in full.
    const fixes: Fix[] = [
      fx(0, 47.495, 4), // walking north toward the boundary
      fx(60, 47.4957, 4),
      fx(120, 47.497, 9), // jitter endpoint; crossed ≈ 47.4964 ≈ t=92 s
      fx(180, 47.4977, 4),
      fx(240, 47.4984, 4),
    ];
    for (let t = 245; t <= 320; t += 5) fixes.push(fx(t, 47.4985, 0.4)); // 75 s rigging, alt flat
    fixes.push(fx(380, 47.506, 30)); // launches; exits the SSS in flight ≈ t=361 s
    fixes.push(fx(440, 47.52, 50));
    fixes.push(fx(500, 47.55, 55));
    fixes.push(fx(560, 47.58, 55));
    fixes.push(fx(620, 47.61, 55)); // TP1
    fixes.push(fx(680, 47.64, 55));
    fixes.push(fx(740, 47.67, 55));
    fixes.push(fx(800, 47.7, 55)); // TP2
    fixes.push(fx(860, 47.73, 55));
    fixes.push(fx(920, 47.76, 55));
    fixes.push(fx(980, 47.79, 55));
    fixes.push(fx(1040, 47.81, 55)); // goal
    const attempts = detect(fixes, 'XC');

    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt.sssCrossing.crossingTime).toBeGreaterThan(320_000);
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
    expect(attempt.landingCutoffMs).toBeNull();

    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(false);
  });
});

describe('suppression flag scoping — post-landing SSS re-cross (XC)', () => {
  it('a clean goal flight is NOT flagged when the retrieve re-crosses the SSS', () => {
    // The most common clean profile at hill sites: fly the task to goal,
    // land, go still, then the retrieve car drives home back through the
    // start cylinder. The car crossing is suppressed, but the goal score was
    // sealed at the goal crossing — flagging it would bury real flags.
    const fixes: Fix[] = [
      fx(0, 47.5, 40), // launch at the SSS centre; exits ≈ t=22 s
      fx(60, 47.52, 60),
      fx(120, 47.55, 60),
      fx(180, 47.58, 60),
      fx(240, 47.61, 60), // TP1
      fx(300, 47.64, 60),
      fx(360, 47.67, 60),
      fx(420, 47.7, 60), // TP2
      fx(480, 47.73, 60),
      fx(540, 47.76, 60),
      fx(600, 47.79, 60),
      fx(660, 47.8, 40), // goal crossed ≈ t=638 s, lands
    ];
    for (let t = 665; t <= 700; t += 5) fixes.push(fx(t, 47.8, 0.5)); // 35 s still, alt flat
    fixes.push(fx(760, 47.7, 80)); // retrieve drives south
    fixes.push(fx(820, 47.6, 80));
    fixes.push(fx(880, 47.52, 80));
    fixes.push(fx(940, 47.5, 80)); // car re-enters the SSS cylinder ≈ t=907 s

    const attempts = detect(fixes, 'XC');

    // Car crossing suppressed; only the flown attempt survives.
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt.landingCutoffMs).toBe(665_000);
    expect(attempt.reachedGoal).toBe(true);
    expect(attempt.taskTimeS).toBeGreaterThan(0);
    expect(attempt.distanceFlownKm).toBeCloseTo(TASK_KM, 2);
    // Goal attempts are exempt from the suppression flag.
    expect(attempt.truncationVoidedCrossing).toBeFalsy();
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(false);
  });

  it('a partial flight IS still flagged when a post-landing crossing is suppressed', () => {
    // Lands mid-course (no TP beyond the SSS), retrieve re-crosses the SSS.
    // The suppressed crossing might have been the real flight, so the ⚑
    // stays on the partial attempt.
    const fixes: Fix[] = [
      fx(0, 47.5, 40), // exits SSS ≈ t=11 s
      fx(60, 47.52, 40),
      fx(120, 47.55, 60),
      fx(180, 47.56, 20), // touch-down short of TP1
    ];
    for (let t = 185; t <= 220; t += 5) fixes.push(fx(t, 47.56, 0.5)); // 35 s still, alt flat
    fixes.push(fx(280, 47.53, 60)); // retrieve drives back south
    fixes.push(fx(340, 47.5, 60)); // re-enters the SSS cylinder ≈ t=333 s

    const attempts = detect(fixes, 'XC');

    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt.landingCutoffMs).toBe(185_000);
    expect(attempt.reachedGoal).toBe(false);
    expect(attempt.lastTurnpointIndex).toBe(0);
    // ~6.3 km of genuine course progress (47.5036 → 47.56), then dead.
    expect(attempt.distanceFlownKm).toBeCloseTo(6.27, 1);
    // Suppression flags the non-goal survivor.
    expect(attempt.truncationVoidedCrossing).toBe(true);
    const [scored] = scoreAttempts([attempt], [], TASK_KM);
    expect(scored.hasFlaggedCrossings).toBe(true);
  });
});

describe('accepted residual — pre-flight vehicle making course progress (XC)', () => {
  // Documented limitation, pinned so it stays deliberate: a pre-flight car
  // that crosses the SSS and drives MORE than the 0.5 km flight-evidence
  // epsilon ALONG the course line before stopping at launch defeats the
  // no-progress test. The rigging stillness is then accepted as THE landing:
  // the genuine flight (whose SSS exit postdates it) is suppressed and every
  // surviving car attempt is truncated at the cutoff and flagged. The flight
  // is lost — visibly (⚑ for admin review), never silently scored off the
  // car's track.
  function carAlongCourseThenFlyTrack(): Fix[] {
    const fixes: Fix[] = [
      fx(0, 47.49, 30), // car enters from the south, crossing ≈ t=73 s
      fx(60, 47.4945, 30),
      fx(120, 47.503, 30),
      fx(180, 47.512, 30), // exits the far side ≈ t=124 s, driving up the course
      fx(240, 47.5215, 30), // ≈ 2.0 km of course progress
      fx(300, 47.512, 30), // drives back toward launch
      fx(360, 47.503, 30), // re-enters ≈ t=356 s
      fx(420, 47.4995, 10), // parks at launch inside the cylinder
    ];
    for (let t = 425; t <= 495; t += 5) fixes.push(fx(t, 47.4995, 0.5)); // 70 s rigging, alt flat
    fixes.push(fx(555, 47.5045, 25)); // launches; SSS exit ≈ t=544 s — SUPPRESSED
    fixes.push(fx(615, 47.52, 45));
    fixes.push(fx(675, 47.55, 55));
    fixes.push(fx(735, 47.58, 55));
    fixes.push(fx(795, 47.61, 55)); // TP1 (voided — post-cutoff)
    fixes.push(fx(855, 47.65, 55));
    fixes.push(fx(915, 47.7, 55)); // TP2 (voided)
    fixes.push(fx(975, 47.75, 55));
    fixes.push(fx(1035, 47.81, 55)); // goal (voided)
    return fixes;
  }

  it('the flight is suppressed-and-flagged, never scored as the car attempt reaching goal', () => {
    const attempts = detect(carAlongCourseThenFlyTrack(), 'XC');

    // The three pre-cutoff car crossings all spawn (truncated) attempts; the
    // in-flight exit at ≈ 544 s postdates the rigging cutoff and spawns none.
    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) {
      expect(attempt.landingCutoffMs).toBe(425_000);
      expect(attempt.sssCrossing.crossingTime).toBeLessThan(425_000);
      // Nothing flown counts: no goal, no task time, no TPs beyond the SSS.
      expect(attempt.reachedGoal).toBe(false);
      expect(attempt.taskTimeS).toBeNull();
      expect(attempt.turnpointCrossings.map((c) => c.sequenceIndex)).toEqual([0]);
      // Both the suppression and the voided TP/goal crossings raise the ⚑.
      expect(attempt.truncationVoidedCrossing).toBe(true);
    }

    const scored = scoreAttempts(attempts, [], TASK_KM);
    const best = scored[selectBestAttempt(scored)];
    // The persisted best is the car's truncated course progress (~2 km) —
    // NOT the full flown task — and it is flagged for review.
    expect(best.reachedGoal).toBe(false);
    expect(best.distanceFlownKm).toBeCloseTo(2.0, 1);
    expect(best.distanceFlownKm).toBeLessThan(TASK_KM / 4);
    expect(best.hasFlaggedCrossings).toBe(true);
    // The t_best pool gets nothing from this upload.
    expect(scored.every((a) => !a.reachedGoal && a.taskTimeS === null)).toBe(true);
  });
});

// ── End-to-end through runPipeline (IGC bytes → scored attempts) ─────────────
// Pilot exits SSS, flies to 47.52, sits still for 35 s (identical B records →
// derived ground speed 0, flat altitude), then the retrieve drives through
// the goal cylinder.

const LANDING_IGC = [
  'AXLK00001',
  'HFDTE230126',
  'B1000004730000N12200000WA0050000500', // 47.500 — inside SSS
  'B1001004730600N12200000WA0050000500', // 47.510 — SSS exited
  'B1002004731200N12200000WA0050000500', // 47.520 — touch-down
  'B1002054731200N12200000WA0050000500',
  'B1002104731200N12200000WA0050000500',
  'B1002154731200N12200000WA0050000500',
  'B1002204731200N12200000WA0050000500',
  'B1002254731200N12200000WA0050000500',
  'B1002304731200N12200000WA0050000500',
  'B1002354731200N12200000WA0050000500',
  'B1002404731200N12200000WA0050000500', // 35 s stationary
  'B1004004732400N12200000WA0050000500', // 47.540 — car through goal
].join('\n');

const SHORT_TASK: TaskDefinition = {
  id: 'task-short',
  turnpoints: [
    { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
    { id: 'goal', sequenceIndex: 1, lat: 47.54, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
  ],
};

describe('landing truncation — end-to-end runPipeline', () => {
  it('XC: the driven goal crossing is void, flagged, and distance stops at the landing', async () => {
    const result = await runPipeline(
      { igcText: LANDING_IGC, task: SHORT_TASK, existingGoalTimes: [], competitionType: 'XC' },
      '2026-01-01',
      '2026-01-31',
      3.65,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const best = result.value.scoredAttempts[result.value.bestAttemptIndex];
    expect(best.reachedGoal).toBe(false);
    expect(best.goalCrossing).toBeNull();
    // The voided goal crossing raises the review flag.
    expect(best.hasFlaggedCrossings).toBe(true);
    // Flown to 47.52: task ≈ 3.65 km minus ≈ 1.82 km remaining to goal.
    expect(best.distanceFlownKm).toBeCloseTo(1.82, 1);
  });

  it('HAF: the identical track keeps its post-touch-down goal crossing', async () => {
    const result = await runPipeline(
      { igcText: LANDING_IGC, task: SHORT_TASK, existingGoalTimes: [], competitionType: 'HIKE_AND_FLY' },
      '2026-01-01',
      '2026-01-31',
      3.65,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const best = result.value.scoredAttempts[result.value.bestAttemptIndex];
    expect(best.reachedGoal).toBe(true);
    expect(best.distanceFlownKm).toBeCloseTo(3.65, 1);
    expect(best.hasFlaggedCrossings).toBe(false);
  });
});
