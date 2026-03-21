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
  name:       string;
  latitude:   number;  // WGS84 decimal degrees
  longitude:  number;  // WGS84 decimal degrees
  radius_m:   number;  // cylinder / observation zone radius in metres
  type:       'SSS' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE' | 'CYLINDER';
  goalLineBearingDeg?: number;  // GOAL_LINE only
}

export interface ParsedTask {
  name?:        string;
  taskType?:    'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  turnpoints:   ParsedTurnpoint[];
  /** Raw file content preserved for re-export */
  rawContent:   string;
  format:       'xctsk' | 'cup';
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
  name:        string;
  lat:         number;
  lon:         number;
  altSmoothed?: number;
  description?: string;
}

interface XctskJsonTurnpoint {
  waypoint: XctskJsonWaypoint;
  radius:   number;
  /** Only present for special waypoints: 'SSS' | 'ESS' | 'GOAL' */
  type?:    string;
}

interface XctskJsonV1 {
  version:    number;
  taskType?:  string;  // 'CLASSIC' | 'FREE_FLIGHT' | 'OPEN_DISTANCE' | …
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
  const firstUntyped = tps.findIndex(tp => !tp.type);
  const lastUntyped  = tps.length - 1 - [...tps].reverse().findIndex(tp => !tp.type);

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

    return {
      name:      waypoint.name || `TP${idx + 1}`,
      latitude:  lat,
      longitude: lon,
      radius_m:  typeof radius === 'number' && radius > 0 ? radius : 400,
      type,
    };
  });

  // If no explicit goal was assigned (e.g. all TPs were typed), mark last as goal
  const hasGoal = turnpoints.some(tp => tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE');
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
  const sssIdx  = sssIdxMatch  ? parseInt(sssIdxMatch[1])  : null;
  const essIdx  = essIdxMatch  ? parseInt(essIdxMatch[1])  : null;
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
      type = (ozTypeMatch?.toLowerCase() === 'line') ? 'GOAL_LINE' : 'GOAL_CYLINDER';
    }

    turnpoints.push({ name, latitude: lat, longitude: lon, radius_m, type });
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

export function parseCup(content: string): ParsedTask {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Build a map of waypoint name → coord
  const waypointMap = new Map<string, { lat: number; lon: number }>();
  let inTask = false;
  let taskName: string | undefined;
  const taskWpNames: string[] = [];

  for (const line of lines) {
    if (line.startsWith('-----')) {
      inTask = true;
      continue;
    }

    if (!inTask) {
      // Waypoint line — skip header
      if (line.toLowerCase().startsWith('name')) continue;
      const parts = splitCupLine(line);
      if (parts.length < 5) continue;
      const name = parts[0].replace(/^"|"$/g, '');
      const latRaw = parts[3].replace(/^"|"$/g, '');
      const lonRaw = parts[4].replace(/^"|"$/g, '');
      if (!latRaw || !lonRaw) continue;
      try {
        const lat = parseCupCoord(latRaw);
        const lon = parseCupCoord(lonRaw);
        if (!isNaN(lat) && !isNaN(lon)) {
          waypointMap.set(name, { lat, lon });
        }
      } catch { /* skip malformed lines */ }
    } else {
      // Task line: "TaskName","WP1","WP2",...
      const parts = splitCupLine(line);
      if (parts.length < 2) continue;
      if (!taskName) taskName = parts[0].replace(/^"|"$/g, '');
      for (let i = 1; i < parts.length; i++) {
        const wpName = parts[i].replace(/^"|"$/g, '');
        if (wpName) taskWpNames.push(wpName);
      }
    }
  }

  // Build turnpoints from task WP names
  const turnpoints: ParsedTurnpoint[] = taskWpNames.map((name, idx) => {
    const coord = waypointMap.get(name);
    let type: ParsedTurnpoint['type'] = 'CYLINDER';
    if (idx === 0) type = 'SSS';
    else if (idx === taskWpNames.length - 1) type = 'GOAL_CYLINDER';

    return {
      name,
      latitude: coord?.lat ?? 0,
      longitude: coord?.lon ?? 0,
      radius_m: 400, // .cup doesn't encode radius; use sensible default
      type,
    };
  });

  return {
    name: taskName,
    taskType: 'RACE_TO_GOAL',
    turnpoints,
    rawContent: content,
    format: 'cup',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export function parseTaskFile(content: string, filename: string): ParsedTask {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'xctsk') return parseXctsk(content);
  if (ext === 'cup')   return parseCup(content);
  throw new Error(`Unsupported file format: .${ext}. Supported formats: .xctsk, .cup`);
}
