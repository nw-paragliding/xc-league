// =============================================================================
// task-exporters.test.ts — unit tests for exportXctsk (v1 JSON file format)
// =============================================================================

import { describe, expect, it } from 'vitest';
import { type ExportTask, exportXctsk } from './task-exporters';
import { parseXctsk } from './task-parsers';

const baseTask: ExportTask = {
  id: 'task-1',
  name: 'Test Task',
  taskType: 'RACE_TO_GOAL',
  turnpoints: [
    { name: 'TLK-6K', latitude: 47.5114, longitude: -121.991, radius_m: 400, type: 'SSS', sequenceIndex: 0 },
    { name: 'GRN-6K', latitude: 47.5478, longitude: -121.9834, radius_m: 400, type: 'CYLINDER', sequenceIndex: 1 },
    { name: 'SQT-5K', latitude: 47.5043, longitude: -122.0475, radius_m: 1000, type: 'ESS', sequenceIndex: 2 },
    { name: 'TLZ-5K', latitude: 47.5008, longitude: -122.0219, radius_m: 400, type: 'GOAL_CYLINDER', sequenceIndex: 3 },
  ],
};

describe('exportXctsk — v1 JSON', () => {
  it('emits valid JSON (not XML)', () => {
    const out = exportXctsk(baseTask);
    expect(out.trimStart().startsWith('{')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('includes required top-level fields', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    expect(json.taskType).toBe('CLASSIC');
    expect(json.version).toBe(1);
    expect(json.earthModel).toBe('WGS84');
    expect(Array.isArray(json.turnpoints)).toBe(true);
    expect(json.turnpoints).toHaveLength(4);
  });

  it('emits top-level keys in spec order (FlySkyHy compatibility)', () => {
    const out = exportXctsk(baseTask);
    const order = Object.keys(JSON.parse(out));
    // spec: taskType, version, earthModel, turnpoints, [goal]
    expect(order).toEqual(['taskType', 'version', 'earthModel', 'turnpoints', 'goal']);
  });

  it('preserves coordinates as decimal degrees', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    const wp = json.turnpoints[0].waypoint;
    expect(wp.lat).toBeCloseTo(47.5114, 4);
    expect(wp.lon).toBeCloseTo(-121.991, 4);
  });

  it('marks ESS turnpoints with type tag', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    expect(json.turnpoints[2].type).toBe('ESS');
  });

  it('leaves SSS implicit (XCTrack/parser treat first TP as start)', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    expect(json.turnpoints[0]).not.toHaveProperty('type');
  });

  it('omits type tag for cylinder and goal turnpoints', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    expect(json.turnpoints[1]).not.toHaveProperty('type');
    expect(json.turnpoints[3]).not.toHaveProperty('type');
  });

  it('puts type before radius in turnpoint object (spec order)', () => {
    const out = exportXctsk(baseTask);
    const ess = JSON.parse(out).turnpoints[2];
    expect(Object.keys(ess)).toEqual(['type', 'radius', 'waypoint']);
  });

  it('encodes goal as top-level goal.type=CYLINDER for cylinder goal', () => {
    const json = JSON.parse(exportXctsk(baseTask));
    expect(json.goal).toEqual({ type: 'CYLINDER' });
  });

  it('encodes goal as top-level goal.type=LINE for line goal', () => {
    const lineTask: ExportTask = {
      ...baseTask,
      turnpoints: baseTask.turnpoints.map((tp, i) =>
        i === baseTask.turnpoints.length - 1 ? { ...tp, type: 'GOAL_LINE' } : tp,
      ),
    };
    const json = JSON.parse(exportXctsk(lineTask));
    expect(json.goal).toEqual({ type: 'LINE' });
  });

  it('omits goal field when no goal turnpoint exists', () => {
    const noGoal: ExportTask = {
      ...baseTask,
      turnpoints: baseTask.turnpoints.slice(0, 3), // SSS + cylinder + ESS, no goal
    };
    const json = JSON.parse(exportXctsk(noGoal));
    expect(json.goal).toBeUndefined();
  });

  it('round-trips through parseXctsk', () => {
    const parsed = parseXctsk(exportXctsk(baseTask));
    expect(parsed.format).toBe('xctsk');
    expect(parsed.taskType).toBe('RACE_TO_GOAL');
    expect(parsed.turnpoints).toHaveLength(4);
    expect(parsed.turnpoints[0].type).toBe('SSS');
    expect(parsed.turnpoints[0].name).toBe('TLK-6K');
    expect(parsed.turnpoints[0].latitude).toBeCloseTo(47.5114, 4);
    expect(parsed.turnpoints[2].type).toBe('ESS');
    expect(parsed.turnpoints[3].type).toBe('GOAL_CYLINDER');
    expect(parsed.turnpoints[3].radius_m).toBe(400);
  });

  it('round-trips a line-goal task (preserves GOAL_LINE)', () => {
    const lineTask: ExportTask = {
      ...baseTask,
      turnpoints: baseTask.turnpoints.map((tp, i) =>
        i === baseTask.turnpoints.length - 1 ? { ...tp, type: 'GOAL_LINE' } : tp,
      ),
    };
    const parsed = parseXctsk(exportXctsk(lineTask));
    expect(parsed.turnpoints[parsed.turnpoints.length - 1].type).toBe('GOAL_LINE');
  });

  it('emits CLASSIC even for OPEN_DISTANCE tasks (spec only documents CLASSIC)', () => {
    const openTask: ExportTask = { ...baseTask, taskType: 'OPEN_DISTANCE' };
    const json = JSON.parse(exportXctsk(openTask));
    expect(json.taskType).toBe('CLASSIC');
  });

  it('respects sequenceIndex ordering', () => {
    const shuffled: ExportTask = {
      ...baseTask,
      turnpoints: [...baseTask.turnpoints].reverse(),
    };
    const json = JSON.parse(exportXctsk(shuffled));
    expect(json.turnpoints.map((tp: any) => tp.waypoint.name)).toEqual(['TLK-6K', 'GRN-6K', 'SQT-5K', 'TLZ-5K']);
  });
});
