// =============================================================================
// Unit tests for pipeline Stage 4 (classifyGroundState).
// Focuses on the HAF sustained-stillness ground check.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { CylinderCrossing, Fix, TaskDefinition } from './pipeline';
import { classifyGroundState } from './pipeline';

// ── Helpers ────────────────────────────────────────────────────────────────

const TP_LAT = 47.5;
const TP_LNG = -122.0;

function fix(tSec: number, speedKmh: number, lat = TP_LAT, lng = TP_LNG): Fix {
  return {
    timestamp: tSec * 1000,
    lat,
    lng,
    gpsAlt: 100,
    pressureAlt: 100,
    valid: true,
    gspKmh: null,
    derivedSpeedKmh: speedKmh,
  };
}

function buildTask(): TaskDefinition {
  return {
    id: 'task-1',
    closeDate: Date.now() + 86_400_000,
    turnpoints: [
      {
        id: 'tp-sss',
        sequenceIndex: 0,
        lat: TP_LAT - 0.01,
        lng: TP_LNG - 0.01,
        radiusM: 400,
        type: 'SSS',
      },
      {
        id: 'tp-ground',
        sequenceIndex: 1,
        lat: TP_LAT,
        lng: TP_LNG,
        radiusM: 400,
        type: 'CYLINDER',
        forceGround: true,
      },
      {
        id: 'tp-goal',
        sequenceIndex: 2,
        lat: TP_LAT + 0.01,
        lng: TP_LNG + 0.01,
        radiusM: 400,
        type: 'GOAL_CYLINDER',
      },
    ],
  };
}

function buildAttempt(crossings: CylinderCrossing[]) {
  return [
    {
      attemptIndex: 0,
      sssCrossing: crossings[0],
      essCrossing: null,
      goalCrossing: null,
      turnpointCrossings: crossings,
      reachedGoal: false,
      lastTurnpointIndex: crossings.length - 1,
      taskTimeS: null,
      distanceFlownKm: 0,
    },
  ];
}

function groundCrossing(timestamp: number): CylinderCrossing {
  return {
    turnpointId: 'tp-ground',
    sequenceIndex: 1,
    crossingTime: timestamp,
    segmentStartFix: fix(timestamp / 1000, 30),
    segmentEndFix: fix(timestamp / 1000 + 1, 30),
    groundCheckRequired: true,
    detectedMaxSpeedKmh: null,
    groundConfirmed: false,
  };
}

const sssCrossing: CylinderCrossing = {
  turnpointId: 'tp-sss',
  sequenceIndex: 0,
  crossingTime: 0,
  segmentStartFix: fix(0, 30),
  segmentEndFix: fix(1, 30),
  groundCheckRequired: false,
  detectedMaxSpeedKmh: null,
  groundConfirmed: true,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyGroundState', () => {
  it('XC mode: passes attempts through unchanged', () => {
    const task = buildTask();
    const crossing = groundCrossing(1000);
    const attempts = buildAttempt([sssCrossing, crossing]);
    // A fix that would fail the HAF check still reads as groundConfirmed=false here
    const out = classifyGroundState([fix(1, 30)], attempts, 'XC', task);
    expect(out[0].turnpointCrossings[1]).toEqual(crossing);
  });

  it('confirms ground on sustained stillness (20s at walking speed)', () => {
    const task = buildTask();
    const crossing = groundCrossing(60_000);
    const fixes: Fix[] = [];
    // Fly in at 30 km/h briefly
    fixes.push(fix(58, 30), fix(59, 30), fix(60, 30));
    // 25s of near-stationary samples inside the cylinder
    for (let t = 61; t <= 85; t++) fixes.push(fix(t, 1));
    // Take off and leave
    fixes.push(fix(86, 30), fix(90, 40));

    const out = classifyGroundState(fixes, buildAttempt([sssCrossing, crossing]), 'HIKE_AND_FLY', task);
    expect(out[0].turnpointCrossings[1].groundConfirmed).toBe(true);
    expect(out[0].turnpointCrossings[1].detectedMaxSpeedKmh).toBe(1);
  });

  it('rejects a brief dip that never sustains stillness (headwind-hover)', () => {
    const task = buildTask();
    const crossing = groundCrossing(60_000);
    const fixes: Fix[] = [];
    // Enter the cylinder at flight speed with oscillating GPS speed
    // (typical of a glider hovering in shifty wind): dips below 5 for a
    // second or two then rebounds.
    const pattern = [12, 8, 4, 7, 11, 9, 3, 8, 14, 10, 2, 6, 13];
    for (let i = 0; i < pattern.length; i++) fixes.push(fix(60 + i, pattern[i]));

    const out = classifyGroundState(fixes, buildAttempt([sssCrossing, crossing]), 'HIKE_AND_FLY', task);
    expect(out[0].turnpointCrossings[1].groundConfirmed).toBe(false);
  });

  it('rejects continuous low speed that is shorter than the required window', () => {
    const task = buildTask();
    const crossing = groundCrossing(60_000);
    const fixes: Fix[] = [];
    // 15 seconds of low speed — not quite the 20s threshold
    for (let t = 60; t <= 75; t++) fixes.push(fix(t, 2));

    const out = classifyGroundState(fixes, buildAttempt([sssCrossing, crossing]), 'HIKE_AND_FLY', task);
    expect(out[0].turnpointCrossings[1].groundConfirmed).toBe(false);
  });

  it('ignores fixes outside the cylinder radius', () => {
    const task = buildTask();
    const crossing = groundCrossing(60_000);
    // Fixes 10 km away at walking speed don't count
    const fixes: Fix[] = [];
    for (let t = 60; t <= 85; t++) fixes.push(fix(t, 1, TP_LAT + 0.1, TP_LNG));
    const out = classifyGroundState(fixes, buildAttempt([sssCrossing, crossing]), 'HIKE_AND_FLY', task);
    expect(out[0].turnpointCrossings[1].groundConfirmed).toBe(false);
  });

  it('leaves non-ground crossings untouched', () => {
    const task = buildTask();
    const nonGround: CylinderCrossing = { ...groundCrossing(60_000), groundCheckRequired: false };
    const out = classifyGroundState([], buildAttempt([sssCrossing, nonGround]), 'HIKE_AND_FLY', task);
    expect(out[0].turnpointCrossings[1]).toBe(nonGround);
  });
});
