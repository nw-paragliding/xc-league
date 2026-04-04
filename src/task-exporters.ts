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
// .xctsk export (XCTrack XML)
// ─────────────────────────────────────────────────────────────────────────────

/** Format decimal degrees × 10^7 for xctsk (some apps require integer form) */
function toXctskCoord(deg: number): number {
  return Math.round(deg * 1e7);
}

export function exportXctsk(task: ExportTask): string {
  const tps = [...task.turnpoints].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  const sssIdx = tps.findIndex((t) => t.type === 'SSS');
  const essIdx = tps.findIndex((t) => t.type === 'ESS');
  const goalIdx = tps.findIndex((t) => t.type === 'GOAL_CYLINDER' || t.type === 'GOAL_LINE');

  const turnpointsXml = tps
    .map((tp, i) => {
      const ozType = tp.type === 'GOAL_LINE' ? 'line' : 'cylinder';
      return [
        `    <turnpoint index="${i}">`,
        `      <waypoint name="${escapeXml(tp.name)}" lat="${toXctskCoord(tp.latitude)}" lon="${toXctskCoord(tp.longitude)}" />`,
        `      <observation-zone type="${ozType}" radius="${Math.round(tp.radius_m)}" />`,
        `    </turnpoint>`,
      ].join('\n');
    })
    .join('\n');

  const sssTag = sssIdx >= 0 ? `  <sss index="${sssIdx}" />` : '';
  const essTag = essIdx >= 0 ? `  <ess index="${essIdx}" />` : '';
  const goalTag = goalIdx >= 0 ? `  <goal index="${goalIdx}" />` : '';

  const typeAttr = task.taskType === 'OPEN_DISTANCE' ? 'OPEN_DISTANCE' : 'RACE_TO_GOAL';

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<xctrack>`,
    `  <task type="${typeAttr}" version="1">`,
    `    <turnpoints>`,
    turnpointsXml,
    `    </turnpoints>`,
    sssTag,
    essTag,
    goalTag,
    `  </task>`,
    `</xctrack>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
