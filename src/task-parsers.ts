// =============================================================================
// Task File Parsers
//
// Parses task definitions from two formats:
//   • .xctsk  — XCTrack task XML (used by XCTrack / many paragliding apps)
//   • .cup    — SeeYou Cup waypoint CSV (used by SeeYou Navigator and others)
//
// Both produce a ParsedTask with a list of turnpoints that can be inserted
// into the database.
// =============================================================================

export interface ParsedTurnpoint {
  name: string;
  latitude: number; // WGS84 decimal degrees
  longitude: number; // WGS84 decimal degrees
  radius_m: number; // cylinder / observation zone radius in metres
  type: 'SSS' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE' | 'CYLINDER';
  forceGround?: boolean; // hike & fly: pilot must arrive on foot (name prefixed with [GND])
  goalLineBearingDeg?: number; // GOAL_LINE only
}

// Hike-and-fly naming convention: a `[GND]` prefix in a turnpoint name marks
// it as ground-only (pilot must arrive on foot). Case-insensitive, tolerates
// leading/trailing whitespace. Marker is preserved in the stored name so it
// round-trips through the exporter untouched.
const GND_MARKER = /^\s*\[gnd\]/i;

function detectForceGround(name: string): boolean {
  return GND_MARKER.test(name);
}

export interface ParsedTask {
  name?: string;
  taskType?: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  turnpoints: ParsedTurnpoint[];
  /** Raw file content preserved for re-export */
  rawContent: string;
  format: 'xctsk' | 'cup';
}

// ─────────────────────────────────────────────────────────────────────────────
// .xctsk parser
//
// XCTrack task files come in two formats:
//
//   JSON (version 1) — produced by XCTrack Android ≥ 4.x:
//     { "version": 1, "taskType": "CLASSIC", "turnpoints": [
//         { "waypoint": { "name", "lat", "lon", "altSmoothed" },
//           "radius": 400,
//           "type": "SSS" | "ESS" | undefined }   ← only special types tagged
//     ]}
//     First TP with no type = SSS (implicit), last TP with no type = GOAL.
//
//   XML — older XCTrack / third-party tools:
//     <xctrack><task type="RACE_TO_GOAL">
//       <turnpoints><turnpoint>
//         <waypoint name lat lon />
//         <observation-zone type radius />
//       </turnpoint></turnpoints>
//       <sss index /> <ess index /> <goal index />
//     </task></xctrack>
//
// ─────────────────────────────────────────────────────────────────────────────

// ── JSON (.xctsk v1) ──────────────────────────────────────────────────────────

interface XctskJsonWaypoint {
  name: string;
  lat: number;
  lon: number;
  altSmoothed?: number;
  description?: string;
}

interface XctskJsonTurnpoint {
  waypoint: XctskJsonWaypoint;
  radius: number;
  /** Only present for special waypoints: 'SSS' | 'ESS' | 'GOAL' */
  type?: string;
}

interface XctskJsonV1 {
  version: number;
  taskType?: string; // 'CLASSIC' | 'FREE_FLIGHT' | 'OPEN_DISTANCE' | …
  turnpoints: XctskJsonTurnpoint[];
}

function parseXctskJson(content: string): ParsedTask {
  const raw: XctskJsonV1 = JSON.parse(content);

  // Map taskType string → our enum
  let taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE' | undefined;
  if (raw.taskType) {
    const t = raw.taskType.toUpperCase();
    if (t === 'CLASSIC' || t === 'RACE_TO_GOAL') taskType = 'RACE_TO_GOAL';
    else if (t === 'OPEN_DISTANCE' || t === 'FREE_FLIGHT') taskType = 'OPEN_DISTANCE';
  }

  const tps = raw.turnpoints ?? [];

  // In the JSON format, only ESS (and sometimes SSS) are explicitly typed.
  // The convention is:
  //   - first TP without a type tag  = SSS (start)
  //   - last  TP without a type tag  = Goal
  //   - any TP with type === 'ESS'   = ESS
  //   - any TP with type === 'SSS'   = SSS (explicit override)
  // Find first and last untyped indices so we can assign SSS / Goal:
  const firstUntyped = tps.findIndex((tp) => !tp.type);
  const lastUntyped = tps.length - 1 - [...tps].reverse().findIndex((tp) => !tp.type);

  const turnpoints: ParsedTurnpoint[] = tps.map((tp, idx) => {
    const { waypoint, radius } = tp;
    let lat = waypoint.lat;
    let lon = waypoint.lon;

    // Guard against coordinates stored ×10^7 (shouldn't happen in v1 JSON but be safe)
    if (Math.abs(lat) > 180) lat /= 1e7;
    if (Math.abs(lon) > 360) lon /= 1e7;

    let type: ParsedTurnpoint['type'] = 'CYLINDER';
    const rawType = tp.type?.toUpperCase();
    if (rawType === 'SSS') {
      type = 'SSS';
    } else if (rawType === 'ESS') {
      type = 'ESS';
    } else if (!tp.type) {
      if (idx === firstUntyped) type = 'SSS';
      else if (idx === lastUntyped && lastUntyped !== firstUntyped) type = 'GOAL_CYLINDER';
    }

    const name = waypoint.name || `TP${idx + 1}`;
    return {
      name,
      latitude: lat,
      longitude: lon,
      radius_m: typeof radius === 'number' && radius > 0 ? radius : 400,
      type,
      forceGround: detectForceGround(name),
    };
  });

  // If no explicit goal was assigned (e.g. all TPs were typed), mark last as goal
  const hasGoal = turnpoints.some((tp) => tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE');
  if (!hasGoal && turnpoints.length > 1) {
    turnpoints[turnpoints.length - 1].type = 'GOAL_CYLINDER';
  }

  return { taskType, turnpoints, rawContent: content, format: 'xctsk' };
}

// ── XML (.xctsk legacy) ───────────────────────────────────────────────────────

/** Minimal hand-rolled XML attribute extractor (avoids a DOM dependency) */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = re.exec(tag);
  return m ? m[1] : null;
}

function parseXctskXml(content: string): ParsedTask {
  // Task type
  const taskTypeMatch = /type="([^"]+)"/i.exec(content);
  let taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE' | undefined;
  if (taskTypeMatch) {
    const raw = taskTypeMatch[1].toUpperCase().replace(/-/g, '_');
    if (raw === 'RACE_TO_GOAL' || raw === 'OPEN_DISTANCE') taskType = raw;
  }

  // Find SSS / ESS / goal indices by looking at <sss>, <ess>, <goal> tags
  const sssIdxMatch = /<sss[^/]*index="(\d+)"/i.exec(content);
  const essIdxMatch = /<ess[^/]*index="(\d+)"/i.exec(content);
  const goalIdxMatch = /<goal[^/]*index="(\d+)"/i.exec(content);
  const sssIdx = sssIdxMatch ? parseInt(sssIdxMatch[1]) : null;
  const essIdx = essIdxMatch ? parseInt(essIdxMatch[1]) : null;
  const goalIdx = goalIdxMatch ? parseInt(goalIdxMatch[1]) : null;

  // Extract all <turnpoint ...> blocks
  const tpBlockRe = /<turnpoint([\s\S]*?)<\/turnpoint>/gi;
  const waypointRe = /<waypoint([^/]*)\/>/i;
  const ozRe = /<observation-zone([^/]*)\/>/i;

  const turnpoints: ParsedTurnpoint[] = [];
  let m: RegExpExecArray | null;

  while ((m = tpBlockRe.exec(content)) !== null) {
    const block = m[0];
    const idx = turnpoints.length;

    const wpMatch = waypointRe.exec(block);
    if (!wpMatch) continue;
    const wpTag = wpMatch[1];

    const name = attr(wpTag, 'name') ?? `TP${idx + 1}`;

    let lat = parseFloat(attr(wpTag, 'lat') ?? '0');
    let lon = parseFloat(attr(wpTag, 'lon') ?? '0');
    if (Math.abs(lat) > 180) lat /= 1e7;
    if (Math.abs(lon) > 360) lon /= 1e7;

    const ozMatch = ozRe.exec(block);
    let radius_m = 400;
    if (ozMatch) {
      const r = parseFloat(attr(ozMatch[1], 'radius') ?? '400');
      if (!isNaN(r) && r > 0) radius_m = r;
    }

    let type: ParsedTurnpoint['type'] = 'CYLINDER';
    if (idx === sssIdx) type = 'SSS';
    else if (idx === essIdx) type = 'ESS';
    else if (idx === goalIdx) {
      const ozTypeMatch = ozMatch ? attr(ozMatch[1], 'type') : null;
      type = ozTypeMatch?.toLowerCase() === 'line' ? 'GOAL_LINE' : 'GOAL_CYLINDER';
    }

    turnpoints.push({ name, latitude: lat, longitude: lon, radius_m, type, forceGround: detectForceGround(name) });
  }

  // Fallback: first = SSS, last = GOAL_CYLINDER
  if (sssIdx === null && turnpoints.length > 0) {
    if (turnpoints[0].type === 'CYLINDER') turnpoints[0].type = 'SSS';
  }
  if (goalIdx === null && turnpoints.length > 1) {
    const last = turnpoints[turnpoints.length - 1];
    if (last.type === 'CYLINDER') last.type = 'GOAL_CYLINDER';
  }

  return { taskType, turnpoints, rawContent: content, format: 'xctsk' };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export function parseXctsk(content: string): ParsedTask {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseXctskJson(content);
  }
  return parseXctskXml(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// .cup parser
//
// SeeYou waypoint CSV format. Relevant columns (0-indexed):
//   0: name
//   1: code (short name)
//   2: country
//   3: latitude   — DDMM.mmN/S  (e.g. 4603.123N)
//   4: longitude  — DDDMM.mmE/W (e.g. 00722.456E)
//   5: elevation  — e.g. 1500m
//   6: style      — 1=Normal, 2=Airfield, 3=Outlanding, 4=Glider site
//   7: rwDir      — runway direction (if airfield)
//   8: rwLen      — runway length (if airfield)
//   9: freq
//  10: description
//
// Task section follows the waypoint list and starts with "-----Related Tasks-----"
// Task lines look like: "TaskName","WPName","WPName","WPName"
// We infer SSS = first WP, GOAL = last WP.
// ─────────────────────────────────────────────────────────────────────────────

function parseCupCoord(raw: string): number {
  // DDMM.mmN → decimal degrees
  // DDDMM.mmE → decimal degrees
  raw = raw.trim();
  const dir = raw.slice(-1).toUpperCase(); // N/S/E/W
  const numeric = raw.slice(0, -1);
  // Degrees: first 2 (lat) or 3 (lon) chars
  const isLon = dir === 'E' || dir === 'W';
  const degLen = isLon ? 3 : 2;
  const deg = parseFloat(numeric.slice(0, degLen));
  const min = parseFloat(numeric.slice(degLen));
  let dd = deg + min / 60;
  if (dir === 'S' || dir === 'W') dd = -dd;
  return dd;
}

/** Split a .cup CSV line respecting quoted fields */
function splitCupLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

/** Internal structure for a task parsed from the Related Tasks section */
interface RawCupTask {
  name: string;
  wpNames: string[];
  obszones: Map<number, { style: number; r1: number; isEss: boolean }>;
}

/**
 * Parse a SeeYou .cup file and return ALL tasks found in the Related Tasks
 * section. Each task's ObsZone lines are used for proper radii and SSS/ESS/Goal
 * type assignment:
 *   Style=2        → SSS
 *   Style=3        → GOAL_CYLINDER
 *   SpeedStyle=2   → ESS
 *
 * '???' entries (takeoff / landing placeholders) are skipped.
 */
export function parseCupAll(content: string): ParsedTask[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const waypointMap = new Map<string, { lat: number; lon: number }>();
  const rawTasks: RawCupTask[] = [];
  let currentTask: RawCupTask | null = null;
  let inTaskSection = false;

  for (const line of lines) {
    if (line.startsWith('-----')) {
      inTaskSection = true;
      continue;
    }

    if (!inTaskSection) {
      if (/^name,/i.test(line)) continue; // header row
      const parts = splitCupLine(line);
      if (parts.length < 5) continue;
      const name = parts[0].replace(/^"|"$/g, '');
      const code = parts[1]?.replace(/^"|"$/g, '') ?? '';
      const latRaw = parts[3].replace(/^"|"$/g, '');
      const lonRaw = parts[4].replace(/^"|"$/g, '');
      if (!latRaw || !lonRaw) continue;
      try {
        const lat = parseCupCoord(latRaw);
        const lon = parseCupCoord(lonRaw);
        if (!isNaN(lat) && !isNaN(lon)) {
          if (name) waypointMap.set(name, { lat, lon });
          if (code && code !== name) waypointMap.set(code, { lat, lon });
        }
      } catch {
        /* skip malformed lines */
      }
    } else {
      if (/^Options,/i.test(line)) continue;

      // ObsZone=N,Style=S,R1=Rm,[SpeedStyle=X]
      //
      // SeeYou CUP Style values we care about:
      //   2 = "To Start Point"     → the SSS marker
      //   3 = "To End Point"       → the goal marker
      //   1 / others               → intermediate cylinder
      //
      // SpeedStyle=2 marks the ESS (end of speed section). Earlier code treated
      // *any* SpeedStyle value as ESS, which false-positives on files that
      // emit SpeedStyle=1 (default / AAT) on every zone.
      const ozMatch = /^ObsZone=(\d+),(.+)$/i.exec(line);
      if (ozMatch && currentTask) {
        const idx = parseInt(ozMatch[1]);
        const props = ozMatch[2];
        const styleMatch = /Style=(\d+)/i.exec(props);
        const r1Match = /R1=(\d+)m/i.exec(props);
        const speedMatch = /SpeedStyle=(\d+)/i.exec(props);
        currentTask.obszones.set(idx, {
          style: styleMatch ? parseInt(styleMatch[1]) : 1,
          r1: r1Match ? parseInt(r1Match[1]) : 400,
          isEss: speedMatch !== null && parseInt(speedMatch[1]) === 2,
        });
        continue;
      }

      // Task definition line: "TaskName","???","WP1",...,"???"
      const parts = splitCupLine(line);
      if (parts.length < 2) continue;
      const taskName = parts[0].replace(/^"|"$/g, '');
      if (!taskName) continue;

      const wpNames: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const wp = parts[i].replace(/^"|"$/g, '');
        if (wp && wp !== '???') wpNames.push(wp);
      }
      if (wpNames.length > 0) {
        currentTask = { name: taskName, wpNames, obszones: new Map() };
        rawTasks.push(currentTask);
      }
    }
  }

  return rawTasks.map((task) => {
    const turnpoints: ParsedTurnpoint[] = task.wpNames.map((wpName, idx) => {
      const coord = waypointMap.get(wpName);
      const oz = task.obszones.get(idx);

      let type: ParsedTurnpoint['type'];
      if (oz) {
        if (oz.style === 2) type = 'SSS';
        else if (oz.style === 3) type = 'GOAL_CYLINDER';
        else if (oz.isEss) type = 'ESS';
        else type = 'CYLINDER';
      } else {
        type = idx === 0 ? 'SSS' : idx === task.wpNames.length - 1 ? 'GOAL_CYLINDER' : 'CYLINDER';
      }

      return {
        name: wpName,
        latitude: coord?.lat ?? 0,
        longitude: coord?.lon ?? 0,
        radius_m: oz?.r1 ?? 400,
        type,
        forceGround: detectForceGround(wpName),
      };
    });

    return {
      name: task.name,
      taskType: 'RACE_TO_GOAL',
      turnpoints,
      rawContent: content,
      format: 'cup',
    };
  });
}

export function parseCup(content: string): ParsedTask {
  const all = parseCupAll(content);
  if (all.length > 0) return all[0];

  // Fallback: empty task
  return { taskType: 'RACE_TO_GOAL', turnpoints: [], rawContent: content, format: 'cup' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export function parseTaskFile(content: string, filename: string): ParsedTask {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'xctsk') return parseXctsk(content);
  if (ext === 'cup') return parseCup(content);
  throw new Error(`Unsupported file format: .${ext}. Supported formats: .xctsk, .cup`);
}
