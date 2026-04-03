import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Turnpoint } from '../api/tasks';
import type { ReplayFix } from '../api/track';
import { optimiseRoute, computeDistanceKm, type Cylinder } from '../../../src/shared/task-engine';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────

const ESRI_TILES   = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const TOPO_TILES   = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

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

function toCylinder(tp: Turnpoint): Cylinder {
  return { lat: tp.latitude, lng: tp.longitude, radiusM: tp.radiusM, type: tp.type };
}

const LOCATION_TOL = 1e-4;
const COLOR_PRI: Record<string, number> = { '#4a9eff': 3, '#5db87a': 2, '#e8a842': 1 };

interface TpEntry { role: string; color: string; radiusM: number; isGoalLine: boolean; }
interface TpGroup { lng: number; lat: number; name: string; entries: TpEntry[]; }

function buildGroups(tps: Turnpoint[]): TpGroup[] {
  let cylIdx = 0;
  const groups: TpGroup[] = [];
  for (const tp of tps) {
    const isPlain = tp.type !== 'SSS' && tp.type !== 'ESS' && tp.type !== 'GOAL_CYLINDER' && tp.type !== 'GOAL_LINE';
    const role       = tpRole(tp, isPlain ? ++cylIdx : 0);
    const color      = tpColor(tp.type);
    const isGoalLine = tp.type === 'GOAL_LINE';
    const g = groups.find(g =>
      Math.abs(g.lng - tp.longitude) < LOCATION_TOL &&
      Math.abs(g.lat - tp.latitude)  < LOCATION_TOL,
    );
    if (g) g.entries.push({ role, color, radiusM: tp.radiusM, isGoalLine });
    else   groups.push({ lng: tp.longitude, lat: tp.latitude, name: tp.name, entries: [{ role, color, radiusM: tp.radiusM, isGoalLine }] });
  }
  return groups;
}

function mergeCircles(entries: TpEntry[]): { radiusM: number; color: string }[] {
  const m = new Map<number, string>();
  for (const { radiusM, color } of entries) {
    const prev = m.get(radiusM);
    if (!prev || (COLOR_PRI[color] ?? 0) > (COLOR_PRI[prev] ?? 0)) m.set(radiusM, color);
  }
  return Array.from(m.entries()).sort((a, b) => b[0] - a[0]).map(([radiusM, color]) => ({ radiusM, color }));
}

function optimisedRouteResult(tps: Turnpoint[]) {
  if (tps.length < 2) return null;
  try { return optimiseRoute(tps.map(toCylinder)); } catch { return null; }
}

const BASE_STYLE = {
  version: 8 as const,
  sources: {
    satellite: { type: 'raster' as const, tiles: [ESRI_TILES],  tileSize: 256, maxzoom: 19 },
    labels:    { type: 'raster' as const, tiles: [ESRI_LABELS], tileSize: 256, maxzoom: 19 },
    terrain:   { type: 'raster' as const, tiles: [TOPO_TILES],  tileSize: 256, maxzoom: 17 },
  },
  layers: [
    { id: 'satellite-layer', type: 'raster' as const, source: 'satellite' },
    { id: 'labels-layer',    type: 'raster' as const, source: 'labels' },
    { id: 'terrain-layer',   type: 'raster' as const, source: 'terrain',   layout: { visibility: 'none' as const } },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskMap
// ─────────────────────────────────────────────────────────────────────────────

interface TaskMapProps {
  turnpoints: Turnpoint[];
  height?:    number | string;
  track?:     ReplayFix[] | null;
}

export default function TaskMap({ turnpoints, height = 300, track }: TaskMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const markersRef   = useRef<maplibregl.Marker[]>([]);
  const [legendOpen, setLegendOpen] = useState<string | null>(null);
  const tpsRef       = useRef<Turnpoint[]>(turnpoints);
  const trackRef     = useRef<ReplayFix[] | null | undefined>(track);
  const [basemap, setBasemap]   = useState<'satellite' | 'terrain'>('satellite');
  const [mapReady, setMapReady] = useState(false);

  tpsRef.current   = turnpoints;
  trackRef.current = track;

  // Cache optimiseRoute result — recomputed only when turnpoints change, not on pan/zoom
  const cachedRoute = useMemo(() => optimisedRouteResult(turnpoints), [turnpoints]);
  const routeRef = useRef(cachedRoute);
  routeRef.current = cachedRoute;

  const drawSvg = useCallback(() => {
    const map = mapRef.current;
    const svg = svgRef.current;
    if (!map || !svg) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const tps    = tpsRef.current;
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

    // ── 1. Optimized route line ───────────────────────────────────────────────
    const routeResult = routeRef.current;
    const linePts = routeResult
      ? routeResult.touchPoints.map(p => [p.lng, p.lat] as [number, number])
      : tps.map(tp => [tp.longitude, tp.latitude] as [number, number]);
    if (linePts.length >= 2) {
      const sp = linePts.map(([lng, lat]) => map.project([lng, lat]));
      const d  = sp.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      mk('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      mk('path', { d, fill: 'none', stroke: 'rgba(255,255,255,0.9)', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

      for (let i = 0; i < sp.length - 1; i++) {
        const a = sp[i], b = sp[i + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const rad = Math.atan2(b.y - a.y, b.x - a.x);
        const angle = rad * (180 / Math.PI);
        const offset = 10;
        const px = mx + Math.cos(rad) * offset;
        const py = my + Math.sin(rad) * offset;
        const arrowPath = 'M-6,-4 L4,0 L-6,4 Z';
        const shadowEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shadowEl.setAttribute('d', arrowPath);
        shadowEl.setAttribute('fill', 'rgba(0,0,0,0.6)');
        shadowEl.setAttribute('transform', `translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${angle.toFixed(1)}) scale(1.4)`);
        svg.appendChild(shadowEl);
        const arrowEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrowEl.setAttribute('d', arrowPath);
        arrowEl.setAttribute('fill', 'rgba(255,255,255,0.9)');
        arrowEl.setAttribute('transform', `translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${angle.toFixed(1)})`);
        svg.appendChild(arrowEl);
      }
    }

    // ── 2. Goal line D-shape (chord + outbound semi-circle, CIVL GAP 2025 §6.2.3.1) ──
    const lastTp = tps[tps.length - 1];
    const glBearing = routeResult?.goalLineBearingDeg ?? lastTp?.goalLineBearingDeg;
    if (lastTp?.type === 'GOAL_LINE' && glBearing != null && linePts.length >= 2) {
      const brgRad  = glBearing * Math.PI / 180;
      const halfM   = lastTp.radiusM;
      const lat     = lastTp.latitude;
      const lng     = lastTp.longitude;
      const dlatDeg = Math.cos(brgRad) * halfM / 6371000 * (180 / Math.PI);
      const dlngDeg = Math.sin(brgRad) * halfM / (6371000 * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
      const ep1    = map.project([lng + dlngDeg, lat + dlatDeg]);
      const ep2    = map.project([lng - dlngDeg, lat - dlatDeg]);
      const goalPx = map.project([lng, lat]);

      // Sweep direction: arc curves toward the OUTBOUND side (away from p).
      // Per CIVL GAP 2025 §6.2.3.1, "behind the goal line when coming from p"
      // is the far side from p — the D opens away from the approach direction.
      // Cross product of chord direction × (prevTouchPt - goalCenter) in screen space.
      // cross < 0 → prevTouchPt is on the counterclockwise side → arc goes clockwise (sweep = 1).
      const prevLinePt = linePts[linePts.length - 2];
      const prevPx = map.project(prevLinePt as [number, number]);
      const cross  = (ep2.x - ep1.x) * (prevPx.y - goalPx.y)
                   - (ep2.y - ep1.y) * (prevPx.x - goalPx.x);
      const sweep = cross < 0 ? 1 : 0;

      // Arc radius in screen pixels
      const arcR = Math.hypot(ep1.x - goalPx.x, ep1.y - goalPx.y).toFixed(1);

      // D-shape: chord ep1→ep2, then semi-circle arc back to ep1
      const d = [
        `M${ep1.x.toFixed(1)},${ep1.y.toFixed(1)}`,
        `L${ep2.x.toFixed(1)},${ep2.y.toFixed(1)}`,
        `A${arcR},${arcR},0,0,${sweep},${ep1.x.toFixed(1)},${ep1.y.toFixed(1)}`,
        'Z',
      ].join(' ');

      mk('path', { d, fill: 'rgba(0,0,0,0.2)',       stroke: 'rgba(0,0,0,0.55)',  'stroke-width': 8, 'stroke-linejoin': 'round' });
      mk('path', { d, fill: 'rgba(93,184,122,0.15)', stroke: '#5db87a', 'stroke-width': 3, 'stroke-dasharray': '10 5', 'stroke-linejoin': 'round' });
    }

    // ── 3. IGC track line ─────────────────────────────────────────────────────
    const fixes = trackRef.current;
    if (fixes && fixes.length >= 2) {
      const pts = fixes.map(f => map.project([f.lng, f.lat]));
      const d   = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      mk('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.5)', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      mk('path', { d, fill: 'none', stroke: '#a78bfa', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    }

    // ── 4. Cylinder shadow rings ──────────────────────────────────────────────
    for (const group of groups) {
      for (const { radiusM } of mergeCircles(group.entries.filter(e => !e.isGoalLine))) {
        const { cx, cy, r } = projR(group.lng, group.lat, radiusM);
        if (r < 1) continue;
        mk('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: r.toFixed(1), fill: 'none', stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 8 });
      }
    }

    // ── 5. Coloured dashed rings ──────────────────────────────────────────────
    for (const group of groups) {
      for (const { radiusM, color } of mergeCircles(group.entries.filter(e => !e.isGoalLine))) {
        const { cx, cy, r } = projR(group.lng, group.lat, radiusM);
        if (r < 1) continue;
        mk('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: r.toFixed(1), fill: color + '28', stroke: color, 'stroke-width': 3, 'stroke-dasharray': '10 5' });
      }
    }

    // ── 6. Center dots ────────────────────────────────────────────────────────
    for (const group of groups) {
      const c = map.project([group.lng, group.lat]);
      const dotColor = [...group.entries].sort((a, b) => (COLOR_PRI[b.color] ?? 0) - (COLOR_PRI[a.color] ?? 0))[0]?.color ?? '#e8a842';
      mk('circle', { cx: c.x.toFixed(1), cy: c.y.toFixed(1), r: 5, fill: dotColor, stroke: 'rgba(0,0,0,0.7)', 'stroke-width': 2 });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE as maplibregl.StyleSpecification,
      center: [-121.976, 47.504],
      zoom: 10,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => setMapReady(true));
    map.on('move',   drawSvg);
    map.on('zoom',   drawSvg);
    map.on('resize', drawSvg);
    return () => {
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [drawSvg]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty('satellite-layer', 'visibility', basemap === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('labels-layer',    'visibility', basemap === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('terrain-layer',   'visibility', basemap === 'terrain'   ? 'visible' : 'none');
  }, [basemap, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    const groups = buildGroups(turnpoints);
    for (const group of groups) {
      const el = document.createElement('div');
      el.style.cssText = 'pointer-events:none;text-align:center;';

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
      const nameColor = [...group.entries].sort((a, b) => (COLOR_PRI[b.color] ?? 0) - (COLOR_PRI[a.color] ?? 0))[0]?.color ?? '#e8a842';
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

    const fitPts = cachedRoute
      ? cachedRoute.touchPoints.map(p => [p.lng, p.lat] as [number, number])
      : turnpoints.map(tp => [tp.longitude, tp.latitude] as [number, number]);
    if (fitPts.length >= 2) {
      const lons = fitPts.map(([lng]) => lng);
      const lats = fitPts.map(([, lat]) => lat);
      map.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 80, maxZoom: 14, duration: 600 },
      );
    }

    drawSvg();
    const tid = setTimeout(drawSvg, 700);
    return () => clearTimeout(tid);
  }, [turnpoints, mapReady, drawSvg]);

  // Redraw when track changes (no map move needed)
  useEffect(() => {
    if (mapReady) drawSvg();
  }, [track, mapReady, drawSvg]);

  return (
    <div style={{ width: '100%', height: height, position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <svg ref={svgRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />

      {/* Basemap toggle */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 4, zIndex: 10 }}>
        {(['satellite', 'terrain'] as const).map(b => (
          <button
            key={b}
            onClick={() => setBasemap(b)}
            style={{
              padding: '5px 10px', fontSize: 11,
              fontFamily: '"DM Mono", monospace', fontWeight: 700,
              border: `1px solid ${basemap === b ? 'rgba(232,168,66,0.6)' : 'rgba(255,255,255,0.2)'}`,
              borderRadius: 4,
              background: basemap === b ? 'rgba(232,168,66,0.2)' : 'rgba(0,0,0,0.45)',
              color: basemap === b ? '#e8a842' : 'rgba(255,255,255,0.75)',
              cursor: 'pointer', backdropFilter: 'blur(6px)',
            }}
          >
            {b === 'satellite' ? '🛰 Satellite' : '🗺 Terrain'}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 36, left: 12, zIndex: 10,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
        padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {[
          { color: '#4a9eff', label: 'SSS', tooltip: 'Start of Speed Section — the clock starts on exit.' },
          { color: '#e8a842', label: 'Turnpoint', tooltip: 'Intermediate turnpoint — pilots must enter this cylinder.' },
          { color: '#5db87a', label: 'ESS / Goal', tooltip: 'End of Speed Section / Goal — crossing ESS stops the clock.' },
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
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                  background: legendOpen === label ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.25)',
                  color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: 700,
                  cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1, padding: 0,
                }}
              >
                ?
              </button>
            </div>
            {legendOpen === label && (
              <div style={{
                position: 'absolute', left: 0, bottom: '100%', marginBottom: 6,
                width: 210, padding: '7px 10px',
                background: 'rgba(15,19,24,0.95)', backdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5,
                pointerEvents: 'none', zIndex: 20,
              }}>
                {tooltip}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* No-turnpoints notice */}
      {!turnpoints.length && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8,
          color: 'var(--text3)', pointerEvents: 'none',
          background: 'rgba(15,19,24,0.6)',
        }}>
          <div style={{ fontSize: 28 }}>◈</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>No turnpoints for this task</div>
        </div>
      )}
    </div>
  );
}

// Export toCylinder + computeDistanceKm helper for use in parent
export { toCylinder, computeDistanceKm };
