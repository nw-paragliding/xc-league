// =============================================================================
// Task Exporters
//
// Produces task file content in formats understood by popular paragliding apps:
//   • .xctsk  — XCTrack XML (also used by Paragliding Earth and others)
//   • .cup    — SeeYou waypoint + task CSV
//
// Also generates deep-link URLs for the QR code utility:
//   • xctrack://  — XCTrack task URL scheme
// =============================================================================

export interface ExportTurnpoint {
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  type: string; // SSS | ESS | GOAL_CYLINDER | GOAL_LINE | CYLINDER
  sequenceIndex: number;
}

export interface ExportTask {
  id: string;
  name: string;
  taskType: string;
  turnpoints: ExportTurnpoint[];
  rawContent?: string | null; // original imported content (if available)
  dataSource?: string | null; // 'xctsk' | 'cup' | null
}

// ─────────────────────────────────────────────────────────────────────────────
// .xctsk export (XCTrack v1 JSON)
//
// Spec: https://xctrack.org/Competition_Interfaces.html — "Task definition format"
//
// Modern XCTrack (and FlySkyHy) parse .xctsk files as JSON. The XML form is
// legacy and is rejected by current XCTrack with a Gson MalformedJsonException.
// QR codes use a separate v2 polyline format — see buildXctrackDeepLink.
//
// FlySkyHy is sensitive to top-level key order (see xctrack-public#928), so we
// emit keys in the order documented by the spec: taskType, version, earthModel,
// turnpoints, goal.
// ─────────────────────────────────────────────────────────────────────────────

interface XctskV1Waypoint {
  name: string;
  description: string;
  lat: number;
  lon: number;
  altSmoothed: number;
}

interface XctskV1Turnpoint {
  type?: 'SSS' | 'ESS';
  radius: number;
  waypoint: XctskV1Waypoint;
}

interface XctskV1File {
  taskType: 'CLASSIC';
  version: 1;
  earthModel: 'WGS84';
  turnpoints: XctskV1Turnpoint[];
  goal?: { type: 'CYLINDER' | 'LINE' };
}

export function exportXctsk(task: ExportTask): string {
  const tps = [...task.turnpoints].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  const turnpoints: XctskV1Turnpoint[] = tps.map((tp) => {
    const tpOut: XctskV1Turnpoint = {
      radius: Math.round(tp.radius_m),
      waypoint: {
        name: tp.name,
        description: tp.name,
        lat: tp.latitude,
        lon: tp.longitude,
        altSmoothed: 0,
      },
    };
    // Spec puts `type` before `radius`; insert it via a fresh object so JSON
    // key order matches the documented order.
    if (tp.type === 'SSS' || tp.type === 'ESS') {
      return { type: tp.type, ...tpOut };
    }
    return tpOut;
  });

  const out: XctskV1File = {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints,
  };

  const goalTp = tps.find((tp) => tp.type === 'GOAL_LINE' || tp.type === 'GOAL_CYLINDER');
  if (goalTp) {
    out.goal = { type: goalTp.type === 'GOAL_LINE' ? 'LINE' : 'CYLINDER' };
  }

  return JSON.stringify(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// .cup export (SeeYou waypoints + task)
//
// Format:
//   name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
//   -----Related Tasks-----
//   TaskName,WP1,WP2,...
// ─────────────────────────────────────────────────────────────────────────────

function toCupLat(deg: number): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  const dir = deg >= 0 ? 'N' : 'S';
  return `${String(d).padStart(2, '0')}${m.toFixed(3).padStart(6, '0')}${dir}`;
}

function toCupLon(deg: number): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  const dir = deg >= 0 ? 'E' : 'W';
  return `${String(d).padStart(3, '0')}${m.toFixed(3).padStart(6, '0')}${dir}`;
}

export function exportCup(task: ExportTask): string {
  const tps = [...task.turnpoints].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  const header = 'name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc';
  const waypointLines = tps.map(
    (tp) =>
      `"${tp.name}","${tp.name.slice(0, 8).replace(/\s/g, '')}","",${toCupLat(tp.latitude)},${toCupLon(tp.longitude)},0m,1,,,,""`,
  );

  const taskLine = `"${task.name}",${tps.map((tp) => `"${tp.name}"`).join(',')}`;

  return [header, ...waypointLines, '-----Related Tasks-----', taskLine].join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// QR code content for XCTrack, FlySkHy, and SeeYou Navigator
//
// All three apps share the XCTSK v2 format:
//   XCTSK:{"taskType":"CLASSIC","version":2,"t":[...],"s":{...},"o":{"v":2},"e":0}
//
// Each turnpoint's "z" field polyline-encodes [lon×1e5, lat×1e5, alt, radius]
// as four independent absolute integers (NOT deltas from each other).
// Turnpoint types: 2 = SSS, 3 = ESS (goal/cylinder have no type tag).
// ─────────────────────────────────────────────────────────────────────────────

/** Encode a single signed integer using Google's polyline algorithm. */
function polylineEncodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let result = '';
  while (v >= 32) {
    result += String.fromCharCode((32 | (v & 31)) + 63);
    v = v >>> 5;
  }
  result += String.fromCharCode(v + 63);
  return result;
}

/**
 * Encode a turnpoint's coordinates as an XCTSK v2 "z" string.
 * Encodes [lon×1e5, lat×1e5, alt, radius] as four independent absolute values.
 */
export function encodeXctskZ(lon: number, lat: number, alt: number, radius: number): string {
  return [Math.round(lon * 1e5), Math.round(lat * 1e5), alt, radius].map(polylineEncodeValue).join('');
}

/** Build an XCTSK v2 QR code content string for XCTrack, FlySkHy, and SeeYou. */
export function buildXctrackDeepLink(task: ExportTask): string {
  const tps = [...task.turnpoints].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  const turnpoints = tps.map((tp) => {
    const obj: Record<string, unknown> = {
      z: encodeXctskZ(tp.longitude, tp.latitude, 0, Math.round(tp.radius_m)),
      n: tp.name,
      d: tp.name, // description (mirrors name)
      o: { r: Math.round(tp.radius_m), a1: 180 }, // full-circle observation zone
    };
    if (tp.type === 'SSS') obj['t'] = 2;
    else if (tp.type === 'ESS') obj['t'] = 3;
    return obj;
  });

  const qrTask: Record<string, unknown> = {
    taskType: 'CLASSIC',
    version: 2,
    t: turnpoints,
    s: { d: 1, t: 1 }, // no time gates (omitting g avoids XCTrack "timeGates is empty" parse error)
    o: { v: 2 },
    e: 0, // WGS84
  };

  if (tps.some((tp) => tp.type === 'GOAL_LINE')) {
    qrTask['g'] = { t: 'LINE' };
  }

  return `XCTSK:${JSON.stringify(qrTask)}`;
}

/** Return a download URL for a task file (used as QR content for non-XCTrack apps). */
export function buildDownloadUrl(
  baseUrl: string,
  leagueSlug: string,
  seasonId: string,
  taskId: string,
  format: 'xctsk' | 'cup',
): string {
  return `${baseUrl}/api/v1/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/download?format=${format}`;
}
