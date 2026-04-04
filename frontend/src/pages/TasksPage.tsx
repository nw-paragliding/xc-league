// =============================================================================
// TasksPage — browse tasks, get the task file, upload IGC, see scores
//
// Layout: left scrollable panel (task list + action panel) + right MapLibre map
// =============================================================================

import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type Cylinder, computeDistanceKm, optimiseRoute } from '../../../src/shared/task-engine';
import type { SubmissionResponse, Task, Turnpoint } from '../api/tasks';
import TaskExportModal from '../components/TaskExportModal';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { useUpload } from '../hooks/useSubmission';
import { useLeaderboard, useMySubmissions, useTasks } from '../hooks/useTasks';
import { useTrack } from '../hooks/useTrack';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(seconds: number | null) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPts(n: number) {
  return Math.round(n).toString();
}

type TaskStatus = 'OPEN' | 'UPCOMING' | 'FROZEN' | 'DRAFT';

function getTaskStatus(task: Task): TaskStatus {
  if (task.status === 'draft') return 'DRAFT';
  if (task.isFrozen) return 'FROZEN';
  const now = Date.now();
  if (now >= new Date(task.openDate).getTime() && now < new Date(task.closeDate).getTime()) return 'OPEN';
  return 'UPCOMING';
}

const STATUS_STYLE: Record<TaskStatus, { background: string; color: string; border: string }> = {
  OPEN: { background: 'rgba(93,184,122,0.15)', color: '#5db87a', border: 'rgba(93,184,122,0.3)' },
  UPCOMING: { background: 'rgba(74,158,255,0.12)', color: '#4a9eff', border: 'rgba(74,158,255,0.25)' },
  FROZEN: { background: 'rgba(232,168,66,0.12)', color: '#e8a842', border: 'rgba(232,168,66,0.25)' },
  DRAFT: { background: 'var(--bg3)', color: 'var(--text3)', border: 'var(--border)' },
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskMap — MapLibre map with satellite / terrain basemaps + turnpoint layers
// ─────────────────────────────────────────────────────────────────────────────

const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TOPO_TILES = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

function tpColor(type: string) {
  if (type === 'SSS') return '#4a9eff';
  if (type === 'ESS' || type === 'GOAL_CYLINDER' || type === 'GOAL_LINE') return '#5db87a';
  return '#e8a842';
}

function tpRole(tp: Turnpoint, cylIndex: number): string {
  if (tp.type === 'SSS') return 'SSS';
  if (tp.type === 'ESS') return 'ESS';
  if (tp.type === 'GOAL_CYLINDER' || tp.type === 'GOAL_LINE') return 'GOAL';
  return `D${cylIndex}`;
}

// ── Shared task-engine helpers ────────────────────────────────────────────────

function toCylinder(tp: Turnpoint): Cylinder {
  return { lat: tp.latitude, lng: tp.longitude, radiusM: tp.radiusM, type: tp.type };
}

/** Optimal touch-point polyline as [lng, lat] pairs (for map drawing). */
function optimizedLinePts(tps: Turnpoint[]): [number, number][] {
  if (tps.length < 2) return tps.map((tp) => [tp.longitude, tp.latitude]);
  try {
    const route = optimiseRoute(tps.map(toCylinder));
    return route.touchPoints.map((p) => [p.lng, p.lat]);
  } catch {
    return tps.map((tp) => [tp.longitude, tp.latitude]);
  }
}

// ── Turnpoint grouping ────────────────────────────────────────────────────────
// Turnpoints at the same physical location (within ~11 m) are merged into one
// group so we can draw concentric cylinders and a single label correctly.

const LOCATION_TOL = 1e-4; // degrees ≈ 11 m
const COLOR_PRI: Record<string, number> = { '#4a9eff': 3, '#5db87a': 2, '#e8a842': 1 };

interface TpEntry {
  role: string;
  color: string;
  radiusM: number;
}
interface TpGroup {
  lng: number;
  lat: number;
  name: string;
  entries: TpEntry[];
}

function buildGroups(tps: Turnpoint[]): TpGroup[] {
  let cylIdx = 0;
  const groups: TpGroup[] = [];
  for (const tp of tps) {
    const isPlain = tp.type !== 'SSS' && tp.type !== 'ESS' && tp.type !== 'GOAL_CYLINDER' && tp.type !== 'GOAL_LINE';
    const role = tpRole(tp, isPlain ? ++cylIdx : 0);
    const color = tpColor(tp.type);
    const g = groups.find(
      (g) => Math.abs(g.lng - tp.longitude) < LOCATION_TOL && Math.abs(g.lat - tp.latitude) < LOCATION_TOL,
    );
    if (g) g.entries.push({ role, color, radiusM: tp.radiusM });
    else
      groups.push({
        lng: tp.longitude,
        lat: tp.latitude,
        name: tp.name,
        entries: [{ role, color, radiusM: tp.radiusM }],
      });
  }
  return groups;
}

/** Deduplicate circles at the same radius, keeping highest-priority color. Returns largest-first. */
function mergeCircles(entries: TpEntry[]): { radiusM: number; color: string }[] {
  const m = new Map<number, string>();
  for (const { radiusM, color } of entries) {
    const prev = m.get(radiusM);
    if (!prev || (COLOR_PRI[color] ?? 0) > (COLOR_PRI[prev] ?? 0)) m.set(radiusM, color);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([radiusM, color]) => ({ radiusM, color }));
}

const BASE_STYLE = {
  version: 8 as const,
  sources: {
    satellite: { type: 'raster' as const, tiles: [ESRI_TILES], tileSize: 256, maxzoom: 19 },
    terrain: { type: 'raster' as const, tiles: [TOPO_TILES], tileSize: 256, maxzoom: 17 },
  },
  layers: [
    { id: 'satellite-layer', type: 'raster' as const, source: 'satellite', layout: { visibility: 'none' as const } },
    { id: 'terrain-layer', type: 'raster' as const, source: 'terrain' },
  ],
};

export function TaskMap({ turnpoints, trackCoords }: { turnpoints: Turnpoint[]; trackCoords?: [number, number][] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [legendOpen, setLegendOpen] = useState<string | null>(null);
  const tpsRef = useRef<Turnpoint[]>(turnpoints);
  const trackRef = useRef<[number, number][] | undefined>(trackCoords);
  const [basemap, setBasemap] = useState<'satellite' | 'terrain'>('terrain');
  const [mapReady, setMapReady] = useState(false);

  // Keep refs current without stale-closure issues in map event handlers
  tpsRef.current = turnpoints;
  trackRef.current = trackCoords;

  // Draw the SVG overlay: optimized route line, then cylinder rings, then dots.
  // SVG z-order = DOM order (later = on top), so we do: line → shadows → rings → dots.
  const drawSvg = useCallback(() => {
    const map = mapRef.current;
    const svg = svgRef.current;
    if (!map || !svg) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const tps = tpsRef.current;
    const groups = buildGroups(tps);

    const mk = (tag: string, attrs: Record<string, string | number>) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    };

    const projR = (lng: number, lat: number, radiusM: number) => {
      const c = map.project([lng, lat]);
      const e = map.project([lng, lat + (radiusM / 6371000) * (180 / Math.PI)]);
      return { cx: c.x, cy: c.y, r: Math.hypot(c.x - e.x, c.y - e.y) };
    };

    // ── 0. Flight track ───────────────────────────────────────────────────────
    const track = trackRef.current;
    if (track && track.length >= 2) {
      const tp = track.map(([lng, lat]) => map.project([lng, lat]));
      const td = tp.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      mk('path', {
        d: td,
        fill: 'none',
        stroke: 'rgba(0,0,0,0.5)',
        'stroke-width': 3,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      mk('path', {
        d: td,
        fill: 'none',
        stroke: '#ff6b35',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-opacity': '0.9',
      });
    }

    // ── 1. Optimized route line ───────────────────────────────────────────────
    const linePts = optimizedLinePts(tps);
    if (linePts.length >= 2) {
      const sp = linePts.map(([lng, lat]) => map.project([lng, lat]));
      const d = sp.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      // Dark shadow for contrast
      mk('path', {
        d,
        fill: 'none',
        stroke: 'rgba(0,0,0,0.6)',
        'stroke-width': 4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      // White route line
      mk('path', {
        d,
        fill: 'none',
        stroke: 'rgba(255,255,255,0.9)',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });

      // Directional arrows — one per segment, placed at midpoint
      for (let i = 0; i < sp.length - 1; i++) {
        const a = sp[i],
          b = sp[i + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const rad = Math.atan2(b.y - a.y, b.x - a.x);
        const angle = rad * (180 / Math.PI);
        // Offset along travel direction from midpoint so opposite legs don't overlap
        const offset = 10;
        const px = mx + Math.cos(rad) * offset;
        const py = my + Math.sin(rad) * offset;
        // Arrow: a small filled triangle pointing in travel direction
        const arrowPath = 'M-6,-4 L4,0 L-6,4 Z';
        // Shadow
        const shadowEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shadowEl.setAttribute('d', arrowPath);
        shadowEl.setAttribute('fill', 'rgba(0,0,0,0.6)');
        shadowEl.setAttribute(
          'transform',
          `translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${angle.toFixed(1)}) scale(1.4)`,
        );
        svg.appendChild(shadowEl);
        // White arrow
        const arrowEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrowEl.setAttribute('d', arrowPath);
        arrowEl.setAttribute('fill', 'rgba(255,255,255,0.9)');
        arrowEl.setAttribute('transform', `translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${angle.toFixed(1)})`);
        svg.appendChild(arrowEl);
      }
    }

    // ── 2. Cylinder shadow rings ──────────────────────────────────────────────
    for (const group of groups) {
      for (const { radiusM } of mergeCircles(group.entries)) {
        const { cx, cy, r } = projR(group.lng, group.lat, radiusM);
        if (r < 1) continue;
        mk('circle', {
          cx: cx.toFixed(1),
          cy: cy.toFixed(1),
          r: r.toFixed(1),
          fill: 'none',
          stroke: 'rgba(0,0,0,0.55)',
          'stroke-width': 8,
        });
      }
    }

    // ── 3. Coloured dashed rings ──────────────────────────────────────────────
    for (const group of groups) {
      for (const { radiusM, color } of mergeCircles(group.entries)) {
        const { cx, cy, r } = projR(group.lng, group.lat, radiusM);
        if (r < 1) continue;
        mk('circle', {
          cx: cx.toFixed(1),
          cy: cy.toFixed(1),
          r: r.toFixed(1),
          fill: color + '28',
          stroke: color,
          'stroke-width': 3,
          'stroke-dasharray': '10 5',
        });
      }
    }

    // ── 4. Center dots ────────────────────────────────────────────────────────
    for (const group of groups) {
      const c = map.project([group.lng, group.lat]);
      const dotColor =
        [...group.entries].sort((a, b) => (COLOR_PRI[b.color] ?? 0) - (COLOR_PRI[a.color] ?? 0))[0]?.color ?? '#e8a842';
      mk('circle', {
        cx: c.x.toFixed(1),
        cy: c.y.toFixed(1),
        r: 5,
        fill: dotColor,
        stroke: 'rgba(0,0,0,0.7)',
        'stroke-width': 2,
      });
    }
  }, []);

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE as maplibregl.StyleSpecification,
      center: [10, 47],
      zoom: 7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => setMapReady(true));
    map.on('move', drawSvg);
    map.on('zoom', drawSvg);
    map.on('resize', drawSvg);
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [drawSvg]);

  // Basemap visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty('satellite-layer', 'visibility', basemap === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('terrain-layer', 'visibility', basemap === 'terrain' ? 'visible' : 'none');
  }, [basemap, mapReady]);

  // Redraw SVG when track changes (trackRef is already updated above)
  useEffect(() => {
    if (mapReady) drawSvg();
  }, [trackCoords, mapReady, drawSvg]);

  // Update markers + SVG when turnpoints change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // HTML label markers — one per unique location, badges for all roles at that point
    const groups = buildGroups(turnpoints);
    for (const group of groups) {
      const el = document.createElement('div');
      el.style.cssText = 'pointer-events:none;text-align:center;';

      // Badge row — one badge per unique role at this location
      const badgeRow = document.createElement('div');
      badgeRow.style.cssText = 'display:flex;gap:3px;justify-content:center;margin-bottom:2px;flex-wrap:wrap;';
      const seenRoles = new Set<string>();
      for (const { role, color } of group.entries) {
        if (seenRoles.has(role)) continue;
        seenRoles.add(role);
        const badge = document.createElement('div');
        badge.textContent = role;
        badge.style.cssText = `
          display:inline-block;
          background:${color}22;color:${color};
          border:1px solid ${color}99;
          font-family:"DM Mono",monospace;font-size:10px;font-weight:800;letter-spacing:0.05em;
          padding:1px 5px;border-radius:3px;
        `;
        badgeRow.appendChild(badge);
      }

      const nameEl = document.createElement('div');
      nameEl.textContent = group.name;
      const nameColor =
        [...group.entries].sort((a, b) => (COLOR_PRI[b.color] ?? 0) - (COLOR_PRI[a.color] ?? 0))[0]?.color ?? '#e8a842';
      nameEl.style.cssText = `
        color:${nameColor};font-family:"DM Mono",monospace;font-size:10px;font-weight:600;
        text-shadow:0 0 4px rgba(0,0,0,1),0 0 8px rgba(0,0,0,0.8);white-space:nowrap;
      `;

      el.appendChild(badgeRow);
      el.appendChild(nameEl);

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -10] })
        .setLngLat([group.lng, group.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }

    // Fit viewport to the optimized line (not the full cylinders — pilots fly the line, not the rings)
    const linePts = optimizedLinePts(turnpoints);
    if (linePts.length >= 2) {
      const lons = linePts.map(([lng]) => lng);
      const lats = linePts.map(([, lat]) => lat);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 80, maxZoom: 14, duration: 600 },
      );
    }

    drawSvg();
    // Redraw after fly animation ends
    const tid = setTimeout(drawSvg, 700);
    return () => clearTimeout(tid);
  }, [turnpoints, mapReady, drawSvg]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* SVG overlay — circles drawn via map.project(), stays in sync on move/zoom */}
      <svg
        ref={svgRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/* Basemap toggle */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 4, zIndex: 10 }}>
        {(['satellite', 'terrain'] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBasemap(b)}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              fontFamily: '"DM Mono", monospace',
              fontWeight: 700,
              border: `1px solid ${basemap === b ? 'rgba(232,168,66,0.6)' : 'rgba(255,255,255,0.2)'}`,
              borderRadius: 4,
              background: basemap === b ? 'rgba(232,168,66,0.2)' : 'rgba(0,0,0,0.45)',
              color: basemap === b ? '#e8a842' : 'rgba(255,255,255,0.75)',
              cursor: 'pointer',
              backdropFilter: 'blur(6px)',
            }}
          >
            {b === 'satellite' ? '🛰 Satellite' : '🗺 Terrain'}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          bottom: 36,
          left: 12,
          zIndex: 10,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {[
          {
            color: '#4a9eff',
            label: 'SSS',
            tooltip:
              'Start of Speed Section — the clock starts on exit. Pilots may restart multiple times; we score the best attempt (furthest distance, then fastest time).',
          },
          {
            color: '#e8a842',
            label: 'Turnpoint',
            tooltip: 'Intermediate turnpoint — pilots must enter this cylinder to validate the leg',
          },
          {
            color: '#5db87a',
            label: 'ESS / Goal',
            tooltip: 'End of Speed Section / Goal — crossing ESS stops the clock; Goal is the finish',
          },
        ].map(({ color, label, tooltip }) => (
          <div key={label} style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontFamily: '"DM Mono", monospace', color: 'rgba(255,255,255,0.75)' }}>
                {label}
              </span>
              <button
                onMouseEnter={() => setLegendOpen(label)}
                onMouseLeave={() => setLegendOpen(null)}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: legendOpen === label ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.25)',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 9,
                  fontWeight: 700,
                  cursor: 'default',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ?
              </button>
            </div>
            {legendOpen === label && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  bottom: '100%',
                  marginBottom: 6,
                  width: 210,
                  padding: '7px 10px',
                  background: 'rgba(15,19,24,0.95)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 6,
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.85)',
                  lineHeight: 1.5,
                  pointerEvents: 'none',
                  zIndex: 20,
                }}
              >
                {tooltip}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScoreResult — displays upload outcome
// ─────────────────────────────────────────────────────────────────────────────

function ScoreResult({ result, onReset }: { result: SubmissionResponse; onReset: () => void }) {
  if ('errorCode' in result) {
    return (
      <div className="result-panel fade-in">
        <div className="result-status">
          <div className="result-icon">⚠️</div>
          <div>
            <div className="result-title error">Invalid submission</div>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text2)', marginTop: 2 }}>
              {result.igcFilename}
            </div>
          </div>
        </div>
        <div
          style={{
            background: 'rgba(224,82,82,0.08)',
            border: '1px solid rgba(224,82,82,0.2)',
            borderRadius: 'var(--r)',
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--danger)',
          }}
        >
          {result.errorMessage}
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 8, fontSize: 12 }} onClick={onReset}>
          Try again
        </button>
      </div>
    );
  }

  const best = result.bestAttempt;
  return (
    <div className="result-panel fade-in">
      <div className="result-status">
        <div className="result-icon">✈️</div>
        <div>
          <div className="result-title success">Flight Scored</div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text2)', marginTop: 2 }}>
            {result.igcFilename} · {fmtFileSize(result.igcSizeBytes)}
          </div>
        </div>
      </div>
      <div className="score-grid">
        <div className="score-cell">
          <div className="score-cell-label">Distance</div>
          <div className="score-cell-value">{fmtPts(best.distancePoints)}</div>
        </div>
        <div className="score-cell">
          <div className="score-cell-label">Time</div>
          <div className={`score-cell-value ${result.timePointsProvisional ? 'prov' : ''}`}>
            {result.timePointsProvisional ? '—' : fmtPts(best.timePoints)}
          </div>
        </div>
        <div className="score-cell" style={{ border: '1px solid var(--gold-dim)' }}>
          <div className="score-cell-label">Total</div>
          <div className="score-cell-value gold">{fmtPts(best.totalPoints)}</div>
        </div>
      </div>
      {best.reachedGoal && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="badge badge-goal">✓ Goal</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text2)' }}>
            {best.distanceFlownKm.toFixed(1)} km · {fmtTime(best.taskTimeS)}
          </span>
        </div>
      )}
      {result.timePointsProvisional && (
        <div className="provisional-note" style={{ marginTop: 8 }}>
          ⏳ Time points provisional — final when task closes
        </div>
      )}
      <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12 }} onClick={onReset}>
        Upload another
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadZone — drag-drop IGC uploader for a specific task
// ─────────────────────────────────────────────────────────────────────────────

function UploadZone({ taskId, onSubmission }: { taskId: string; onSubmission?: (id: string) => void }) {
  const { status, progress, result, error, upload, reset } = useUpload();
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'done' && result && !('errorCode' in result)) {
      onSubmission?.(result.id);
    }
  }, [status, result, onSubmission]);

  const handleFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.igc')) {
      alert('Please select a .igc file');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      alert('File too large — maximum 5MB');
      return;
    }
    setFile(f);
    reset();
  };

  const handleReset = useCallback(() => {
    setFile(null);
    reset();
    if (fileRef.current) fileRef.current.value = '';
  }, [reset]);

  useEffect(() => {
    handleReset();
  }, [taskId, handleReset]);

  if (status === 'done' && result) {
    return <ScoreResult result={result} onReset={handleReset} />;
  }

  return (
    <div>
      <div
        className={`upload-zone${drag ? ' drag-over' : ''}`}
        style={{ padding: '16px', minHeight: 'unset' }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => !file && fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".igc"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {file ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{file.name}</div>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}>
              {fmtFileSize(file.size)}
            </div>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 8, fontSize: 11 }}
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
                reset();
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              ✕ Remove
            </button>
          </div>
        ) : (
          <>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(93,184,122,0.1)',
                border: '1px solid rgba(93,184,122,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                margin: '0 auto 8px',
              }}
            >
              ⬆
            </div>
            <div className="upload-title" style={{ fontSize: 13 }}>
              Drop IGC file here
            </div>
            <div className="upload-sub" style={{ fontSize: 11 }}>
              or click to browse · max 5MB
            </div>
          </>
        )}
      </div>

      {status === 'error' && error && (
        <div
          style={{
            marginTop: 8,
            padding: '8px 12px',
            background: 'rgba(224,82,82,0.08)',
            border: '1px solid rgba(224,82,82,0.2)',
            borderRadius: 'var(--r)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}

      {file && (
        <div style={{ marginTop: 8 }}>
          {status === 'uploading' || status === 'processing' ? (
            <div>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                {status === 'uploading' ? `Uploading… ${progress}%` : 'Analysing flight…'}
              </div>
              <div className="progress-bar" style={{ marginTop: 6 }}>
                {status === 'processing' ? (
                  <div className="progress-fill" />
                ) : (
                  <div
                    style={{
                      height: '100%',
                      width: `${progress}%`,
                      background: 'var(--gold)',
                      borderRadius: 2,
                      transition: 'width 0.2s',
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', fontSize: 13 }}
              onClick={() => upload(file, taskId)}
            >
              Submit Flight
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskActionPanel — upload + export + mini leaderboard for selected task
// ─────────────────────────────────────────────────────────────────────────────

function TaskActionPanel({
  task,
  taskStatus,
  leagueSlug,
  onSubmission,
}: {
  task: Task;
  taskStatus: TaskStatus;
  leagueSlug: string;
  onSubmission?: (id: string) => void;
}) {
  const { user, login } = useAuth();
  const [showExport, setShowExport] = useState(false);
  const { data: lb } = useLeaderboard(task.id);

  const isOpen = taskStatus === 'OPEN';

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Get Task button */}
      {task.status === 'published' && (
        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => setShowExport(true)}
        >
          Get Task File / QR
        </button>
      )}

      {/* Upload zone — only for open tasks */}
      {isOpen && (
        <div
          style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r)',
            overflow: 'hidden',
          }}
        >
          {/* Section header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              background: 'rgba(93,184,122,0.06)',
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>✈️</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: '#5db87a',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Submit Flight
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text3)',
                background: 'rgba(93,184,122,0.12)',
                border: '1px solid rgba(93,184,122,0.25)',
                borderRadius: 3,
                padding: '1px 6px',
              }}
            >
              IGC
            </span>
          </div>
          <div style={{ padding: 12 }}>
            {user ? (
              <UploadZone taskId={task.id} onSubmission={onSubmission} />
            ) : (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>Sign in to submit a flight</div>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={login}>
                  Sign in
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mini leaderboard */}
      {lb && lb.entries.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text3)',
              fontFamily: 'var(--font-mono)',
              marginBottom: 8,
            }}
          >
            Leaderboard
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {lb.entries.slice(0, 8).map((e) => (
              <div
                key={e.pilotId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 'var(--r)',
                  background: 'var(--bg3)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text3)',
                    width: 20,
                    flexShrink: 0,
                  }}
                >
                  {e.rank}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.pilotName}
                </span>
                {e.reachedGoal && <span style={{ fontSize: 10, color: 'var(--success)', flexShrink: 0 }}>✓</span>}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--gold)',
                    flexShrink: 0,
                  }}
                >
                  {Math.round(e.totalPoints)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Export modal */}
      {showExport && (
        <TaskExportModal task={task as any} leagueSlug={leagueSlug} onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TasksPage
// ─────────────────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { leagueSlug } = useLeague();
  const { data: tasks, isLoading } = useTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadedSubmissionId, setUploadedId] = useState<string | null>(null);

  // Auto-select first published task on load
  useEffect(() => {
    if (!selectedId && tasks?.length) {
      const first = tasks.find((t) => t.status === 'published') ?? tasks[0];
      setSelectedId(first.id);
    }
  }, [tasks, selectedId]);

  // Clear uploaded track when switching tasks
  useEffect(() => {
    setUploadedId(null);
  }, [selectedId]);

  // Fetch user's existing submissions for the selected task
  const { data: mySubmissions } = useMySubmissions(selectedId);

  // Prefer the freshly-uploaded submission; fall back to most recent existing one
  const submissionId = uploadedSubmissionId ?? mySubmissions?.[0]?.id ?? null;

  const { data: track } = useTrack(selectedId, submissionId);
  const trackCoords = track?.fixes.map((f) => [f.lng, f.lat] as [number, number]);

  const selectedTask = tasks?.find((t) => t.id === selectedId) ?? null;
  const taskStatus = selectedTask ? getTaskStatus(selectedTask) : null;

  return (
    <div className="fade-in" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left panel */}
      <div
        style={{
          width: 380,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 20px 12px', flexShrink: 0 }}>
          <div className="page-title">Tasks</div>
          <div className="page-subtitle">
            {tasks ? `${tasks.length} task${tasks.length !== 1 ? 's' : ''}` : 'Loading…'}
          </div>
        </div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="shimmer" style={{ height: 64, borderRadius: 'var(--r)', marginBottom: 6 }} />
            ))
          ) : !tasks?.length ? (
            <div style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              No tasks in this season yet
            </div>
          ) : (
            tasks.map((task) => {
              const ts = getTaskStatus(task);
              const ss = STATUS_STYLE[ts];
              const isSelected = task.id === selectedId;
              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedId(task.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    marginBottom: 3,
                    borderRadius: 'var(--r)',
                    cursor: 'pointer',
                    background: isSelected
                      ? 'linear-gradient(90deg, rgba(232,168,66,0.11) 0%, rgba(232,168,66,0.04) 100%)'
                      : 'var(--bg2)',
                    border: `1px solid ${isSelected ? 'rgba(232,168,66,0.4)' : 'var(--border)'}`,
                    boxShadow: isSelected ? 'inset 3px 0 0 var(--gold)' : 'none',
                    transition: 'all 0.12s',
                  }}
                >
                  {/* Name — truncates to fill available space */}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      fontWeight: isSelected ? 700 : 500,
                      color: isSelected ? 'var(--gold)' : 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {task.name}
                  </div>

                  {/* Distance — computed from turnpoints */}
                  {task.turnpoints.length >= 2 && (
                    <div
                      style={{
                        flexShrink: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text2)',
                      }}
                    >
                      {computeDistanceKm(task.turnpoints.map(toCylinder)).toFixed(1)}
                      <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}> km</span>
                    </div>
                  )}

                  {/* Status badge inline */}
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 5px',
                      borderRadius: 3,
                      background: ss.background,
                      color: ss.color,
                      border: `1px solid ${ss.border}`,
                    }}
                  >
                    {ts}
                  </span>
                </div>
              );
            })
          )}

          {/* Action panel for selected task */}
          {selectedTask && taskStatus && (
            <div style={{ padding: '4px 4px 20px' }}>
              <TaskActionPanel
                task={selectedTask}
                taskStatus={taskStatus}
                leagueSlug={leagueSlug}
                onSubmission={setUploadedId}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right panel — MapLibre map */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <TaskMap turnpoints={selectedTask?.turnpoints ?? []} trackCoords={trackCoords} />

        {/* Task name chip — top-left, over the map */}
        {selectedTask && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div className="map-chip">
              <span style={{ fontWeight: 600, fontSize: 13 }}>{selectedTask.name}</span>
              {selectedTask.turnpoints.length >= 2 && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text2)', marginLeft: 8 }}>
                  {computeDistanceKm(selectedTask.turnpoints.map(toCylinder)).toFixed(1)} km
                </span>
              )}
            </div>
          </div>
        )}

        {/* No-turnpoints notice */}
        {selectedTask && !selectedTask.turnpoints.length && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--text3)',
              pointerEvents: 'none',
              background: 'rgba(15,19,24,0.6)',
            }}
          >
            <div style={{ fontSize: 28 }}>◈</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>No turnpoints for this task</div>
          </div>
        )}
      </div>
    </div>
  );
}
