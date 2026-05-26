// =============================================================================
// Pipeline parity fixture
// =============================================================================
//
// A synthetic IGC + task pair that exercises parse, date validation, attempt
// detection, distance calculation, and scoring. Imported by BOTH the backend
// vitest suite (tests/pipeline-parity.test.ts) and the frontend vitest suite
// (frontend/src/lib/previewPipeline.test.ts).
//
// The point of the parity test: same code path on both sides should produce
// numerically identical output. If Vite's bundling, esbuild's transpile, or
// igc-parser's interop ever drift between Node and browser, this catches it.
//
// Pure module — no Node or DOM globals. Safe to import from either side.
// =============================================================================

import type { PipelineInput, TurnpointDef } from './pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic IGC — 5 fixes traveling due north along -122°, one per minute.
// ─────────────────────────────────────────────────────────────────────────────
//
// Lat coords in IGC's DDMMmmm format (degrees + minutes×1000):
//   47.495° → 47°29.700′ → 4729700
//   47.500° → 47°30.000′ → 4730000
//   47.510° → 47°30.600′ → 4730600
//   47.520° → 47°31.200′ → 4731200
//   47.540° → 47°32.400′ → 4732400
//
// Geometry:
//   • Fix at 47.495 is south of and OUTSIDE SSS (47.50, r=400m).
//   • Fix at 47.500 is INSIDE SSS (at its centre).
//   • Fix at 47.510 is OUTSIDE SSS, between SSS and TP1.
//   • Fix at 47.520 is INSIDE TP1 (47.52, r=400m).
//   • Fix at 47.540 is INSIDE GOAL (47.54, r=400m).
//
// → Stage 3 detects an outward SSS crossing (inside→outside) between
//   fixes 1 and 2, a TP1 crossing between fixes 2 and 3, and a GOAL
//   crossing between fixes 3 and 4. Pilot reaches goal.

export const FIXTURE_IGC = [
  'AXLK00001',
  'HFDTE230126', // Flight date 2026-01-23
  'B1000004729700N12200000WA0050000500',
  'B1001004730000N12200000WA0050000500',
  'B1002004730600N12200000WA0050000500',
  'B1003004731200N12200000WA0050000500',
  'B1004004732400N12200000WA0050000500',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Task: 3 turnpoints in a straight line going north.
// ─────────────────────────────────────────────────────────────────────────────

export const FIXTURE_TURNPOINTS: TurnpointDef[] = [
  { id: 'sss', sequenceIndex: 0, lat: 47.5, lng: -122.0, radiusM: 400, type: 'SSS' },
  { id: 'tp1', sequenceIndex: 1, lat: 47.52, lng: -122.0, radiusM: 400, type: 'CYLINDER' },
  { id: 'goal', sequenceIndex: 2, lat: 47.54, lng: -122.0, radiusM: 400, type: 'GOAL_CYLINDER' },
];

export const FIXTURE_INPUT: PipelineInput = {
  igcText: FIXTURE_IGC,
  task: { id: 'fixture-task', turnpoints: FIXTURE_TURNPOINTS },
  existingGoalTimes: [120], // one prior finisher in 2 minutes — gives this attempt provisional time points
  competitionType: 'XC',
};

export const FIXTURE_TASK_OPEN_DATE = '2026-01-01';
export const FIXTURE_TASK_CLOSE_DATE = '2026-01-31';
export const FIXTURE_TASK_BEST_DISTANCE_KM = 4.4; // roughly the task length
