// =============================================================================
// task-parsers.test.ts — unit tests for parseCupAll and parseCup
// =============================================================================

import { describe, it, expect } from 'vitest';
import { parseCupAll, parseCup, parseXctsk } from './task-parsers';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal CUP file with two tasks, mirroring the NWXC 2025 format. */
const TWO_TASK_CUP = `name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc,userdata,pics
"TGL-5K",TGL-5K,,4729.927N,12200.505W,552.9m,1,,0.0m,0.0m,,"1772 ft",,""
"GRN-6K",GRN-6K,,4732.870N,12159.003W,0.0m,1,,0.0m,0.0m,,"Grand Ridge",,""
"HI-5K",HI-5K,,4735.808N,12202.029W,173.1m,1,,0.0m,0.0m,,"Road",,""
"TLZ-5K",TLZ-5K,,4730.048N,12201.314W,54.9m,1,,0.0m,0.0m,,"Tiger LZ",,""
-----Related Tasks-----
"Apr Drag Race","???","TGL-5K","GRN-6K","TGL-5K","TLZ-5K","???"
Options,Short=true,MultiStart=false
ObsZone=0,Style=2,R1=400m,A1=180
ObsZone=1,Style=1,R1=4000m,A1=180
ObsZone=2,Style=1,R1=300m,A1=180,SpeedStyle=2
ObsZone=3,Style=3,R1=200m,A1=180
"May Highlands","???","TGL-5K","HI-5K","TGL-5K","TLZ-5K","???"
Options,Short=true,MultiStart=false
ObsZone=0,Style=2,R1=400m,A1=180
ObsZone=1,Style=1,R1=6200m,A1=180
ObsZone=2,Style=1,R1=300m,A1=180,SpeedStyle=2
ObsZone=3,Style=3,R1=200m,A1=180
`;

/** Single task, no ObsZone lines — tests the fallback type-assignment. */
const SINGLE_TASK_NO_OBSZONES = `name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc
"TP-A",TP-A,,4730.000N,12200.000W,100.0m,1,,0.0m,0.0m,,"A"
"TP-B",TP-B,,4731.000N,12201.000W,200.0m,1,,0.0m,0.0m,,"B"
"TP-C",TP-C,,4732.000N,12202.000W,300.0m,1,,0.0m,0.0m,,"C"
-----Related Tasks-----
"My Task","???","TP-A","TP-B","TP-C","???"
Options,Short=true,MultiStart=false
`;

/** CUP file with a waypoint code that differs from its name. */
const CODE_VS_NAME_CUP = `name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc
"Blanchard Takeoff",NCT01,US,4836.582N,12225.561W,384.0m,1,0,0.0m,0.0m,,"TO"
"Blanchard LZ",NCL01,US,4835.572N,12225.275W,0.0m,1,0,0.0m,0.0m,,"LZ"
-----Related Tasks-----
"Code Task","???","NCT01","NCL01","???"
Options,Short=false,MultiStart=false
ObsZone=0,Style=2,R1=400m,A1=180
ObsZone=1,Style=3,R1=300m,A1=180
`;

// ── parseCupAll ────────────────────────────────────────────────────────────────

describe('parseCupAll', () => {
  it('returns one ParsedTask per task in the file', () => {
    const tasks = parseCupAll(TWO_TASK_CUP);
    expect(tasks).toHaveLength(2);
  });

  it('captures task names', () => {
    const tasks = parseCupAll(TWO_TASK_CUP);
    expect(tasks[0].name).toBe('Apr Drag Race');
    expect(tasks[1].name).toBe('May Highlands');
  });

  it('sets format to "cup" and taskType to RACE_TO_GOAL', () => {
    const tasks = parseCupAll(TWO_TASK_CUP);
    for (const t of tasks) {
      expect(t.format).toBe('cup');
      expect(t.taskType).toBe('RACE_TO_GOAL');
    }
  });

  it('skips ??? takeoff / landing placeholders', () => {
    const tasks = parseCupAll(TWO_TASK_CUP);
    // "Apr Drag Race" has TGL, GRN, TGL, TLZ — no ???
    expect(tasks[0].turnpoints).toHaveLength(4);
    for (const tp of tasks[0].turnpoints) {
      expect(tp.name).not.toBe('???');
    }
  });

  describe('ObsZone type mapping', () => {
    it('Style=2 → SSS', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      expect(turnpoints[0].type).toBe('SSS');
    });

    it('SpeedStyle=2 → ESS', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      // index 2 has SpeedStyle=2
      expect(turnpoints[2].type).toBe('ESS');
    });

    it('Style=3 → GOAL_CYLINDER', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      expect(turnpoints[3].type).toBe('GOAL_CYLINDER');
    });

    it('unlabelled middle turnpoint → CYLINDER', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      // index 1 is Style=1 with no SpeedStyle → plain CYLINDER
      expect(turnpoints[1].type).toBe('CYLINDER');
    });
  });

  describe('ObsZone radii', () => {
    it('reads R1 for each turnpoint', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      expect(turnpoints[0].radius_m).toBe(400);  // SSS
      expect(turnpoints[1].radius_m).toBe(4000); // big cylinder
      expect(turnpoints[2].radius_m).toBe(300);  // ESS
      expect(turnpoints[3].radius_m).toBe(200);  // Goal
    });

    it('radii are different per task when tasks differ', () => {
      const tasks = parseCupAll(TWO_TASK_CUP);
      // May Highlands TP-B has 6200m
      expect(tasks[1].turnpoints[1].radius_m).toBe(6200);
    });
  });

  describe('coordinate lookup', () => {
    it('resolves lat/lon from the waypoints section', () => {
      const { turnpoints } = parseCupAll(TWO_TASK_CUP)[0];
      // TGL-5K: 4729.927N → lat ≈ 47 + 29.927/60
      const expectedLat = 47 + 29.927 / 60;
      expect(turnpoints[0].latitude).toBeCloseTo(expectedLat, 4);
    });

    it('resolves by waypoint code when code ≠ name', () => {
      const tasks = parseCupAll(CODE_VS_NAME_CUP);
      expect(tasks).toHaveLength(1);
      const tp = tasks[0].turnpoints[0];
      // NCT01 lat: 4836.582N → 48 + 36.582/60
      const expectedLat = 48 + 36.582 / 60;
      expect(tp.latitude).toBeCloseTo(expectedLat, 4);
    });
  });

  describe('fallback when no ObsZone lines', () => {
    it('first turnpoint → SSS, last → GOAL_CYLINDER, middle → CYLINDER', () => {
      const tasks = parseCupAll(SINGLE_TASK_NO_OBSZONES);
      expect(tasks).toHaveLength(1);
      const tps = tasks[0].turnpoints;
      expect(tps[0].type).toBe('SSS');
      expect(tps[1].type).toBe('CYLINDER');
      expect(tps[2].type).toBe('GOAL_CYLINDER');
    });

    it('uses default 400m radius', () => {
      const tasks = parseCupAll(SINGLE_TASK_NO_OBSZONES);
      for (const tp of tasks[0].turnpoints) {
        expect(tp.radius_m).toBe(400);
      }
    });
  });

  it('returns an empty array for a CUP file with no tasks section', () => {
    const waypointsOnly = `name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc
"TP-A",TP-A,,4730.000N,12200.000W,100.0m,1,,0.0m,0.0m,,"A"
`;
    expect(parseCupAll(waypointsOnly)).toHaveLength(0);
  });

  it('tolerates unknown waypoint codes (lat/lon default to 0)', () => {
    const badWp = `name,code,country,lat,lon,elev
-----Related Tasks-----
"Bad Task","???","UNKNOWN","???"
Options
ObsZone=0,Style=2,R1=400m,A1=180
`;
    const tasks = parseCupAll(badWp);
    expect(tasks[0].turnpoints[0].latitude).toBe(0);
    expect(tasks[0].turnpoints[0].longitude).toBe(0);
  });
});

// ── parseCup (single-task wrapper) ────────────────────────────────────────────

describe('parseCup', () => {
  it('returns the first task from a multi-task file', () => {
    const task = parseCup(TWO_TASK_CUP);
    expect(task.name).toBe('Apr Drag Race');
  });

  it('correctly identifies SSS and goal on the returned task', () => {
    const { turnpoints } = parseCup(TWO_TASK_CUP);
    expect(turnpoints[0].type).toBe('SSS');
    expect(turnpoints[turnpoints.length - 1].type).toBe('GOAL_CYLINDER');
  });

  it('returns an empty-turnpoint task for an empty CUP file gracefully', () => {
    const task = parseCup('name,code\n');
    expect(task.turnpoints).toHaveLength(0);
    expect(task.format).toBe('cup');
  });
});

// ── parseXctsk — spot checks to guard against regressions ─────────────────────

describe('parseXctsk (JSON v1)', () => {
  const XCTSK_JSON = JSON.stringify({
    version: 1,
    taskType: 'CLASSIC',
    turnpoints: [
      { waypoint: { name: 'Launch', lat: 47.5, lon: -121.9 }, radius: 400 },
      { waypoint: { name: 'TP1',    lat: 47.52, lon: -121.85 }, radius: 1000 },
      { waypoint: { name: 'Goal',   lat: 47.48, lon: -121.8 }, radius: 400 },
    ],
  });

  it('parses task type CLASSIC → RACE_TO_GOAL', () => {
    const task = parseXctsk(XCTSK_JSON);
    expect(task.taskType).toBe('RACE_TO_GOAL');
  });

  it('assigns SSS to first untyped turnpoint', () => {
    const task = parseXctsk(XCTSK_JSON);
    expect(task.turnpoints[0].type).toBe('SSS');
  });

  it('assigns GOAL_CYLINDER to last untyped turnpoint', () => {
    const task = parseXctsk(XCTSK_JSON);
    expect(task.turnpoints[2].type).toBe('GOAL_CYLINDER');
  });

  it('preserves radii', () => {
    const task = parseXctsk(XCTSK_JSON);
    expect(task.turnpoints[1].radius_m).toBe(1000);
  });

  it('handles explicit ESS type tag', () => {
    const src = JSON.stringify({
      version: 1,
      turnpoints: [
        { waypoint: { name: 'S',   lat: 47.5,  lon: -122 }, radius: 400 },
        { waypoint: { name: 'ESS', lat: 47.52, lon: -121.9 }, radius: 400, type: 'ESS' },
        { waypoint: { name: 'G',   lat: 47.48, lon: -121.8 }, radius: 200 },
      ],
    });
    const task = parseXctsk(src);
    expect(task.turnpoints[1].type).toBe('ESS');
  });
});
