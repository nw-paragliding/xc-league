import type { LeaderboardEntry } from '../api/tasks';
import type { PreviewError, PreviewResult } from '../lib/previewPipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTime(seconds: number | null) {
  if (seconds == null) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPts(n: number | null | undefined) {
  if (n == null) return '—';
  return Math.round(n).toString();
}

function fmtKm(km: number | null | undefined) {
  if (km == null) return '—';
  return `${km.toFixed(1)} km`;
}

// Generic delta for "higher is better" metrics (distance, points). Time uses
// the dedicated formatTimeDelta below — inverted polarity + units-aware text.
function delta(curr: number | null | undefined, prev: number | null | undefined) {
  if (curr == null || prev == null) return null;
  const d = curr - prev;
  if (Math.abs(d) < 0.05) return null;
  const sign = d > 0 ? '+' : '';
  return { text: `${sign}${d.toFixed(1)}`, color: d > 0 ? 'var(--gold)' : 'var(--danger)' };
}

function formatTimeDelta(currS: number, prevS: number) {
  const d = currS - prevS;
  if (Math.abs(d) < 1) return null;
  const abs = Math.floor(Math.abs(d));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const formatted =
    h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  const sign = d > 0 ? '+' : '−';
  // Faster (negative delta) is better — green; slower is red.
  return { text: `${sign}${formatted}`, color: d < 0 ? 'var(--gold)' : 'var(--danger)' };
}

// ─────────────────────────────────────────────────────────────────────────────
// FlightPreviewPanel
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  filename: string;
  /** Result from previewPipeline. null while loading. */
  result: PreviewResult | null;
  error: PreviewError | null;
  /** The pilot's current best on this task. null = first submission for this pilot. */
  previousBest: LeaderboardEntry | null;
  uploading: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

export default function FlightPreviewPanel({
  filename,
  result,
  error,
  previousBest,
  uploading,
  onSubmit,
  onCancel,
}: Props) {
  const best = result?.attempts[result.bestAttemptIndex];

  // Total turnpoints crossed by the preview attempt
  const previewMetrics = best
    ? {
        distance: best.distanceFlownKm,
        totalPoints: best.totalPoints,
        distancePoints: best.distancePoints,
        timePoints: best.timePoints,
        reachedGoal: best.reachedGoal,
        turnpointsCrossed: best.turnpointCrossings.length,
        taskTimeS: best.taskTimeS,
      }
    : null;

  return (
    <div
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(16,185,129,0.06)',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>👁️</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#10b981',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Preview
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>
          {filename}
        </span>
      </div>

      <div style={{ padding: 12 }}>
        {error ? (
          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(224,82,82,0.08)',
              border: '1px solid rgba(224,82,82,0.2)',
              borderRadius: 'var(--r)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--danger)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{error.stage}</div>
            <div>{error.message}</div>
          </div>
        ) : !result ? (
          <div
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text2)',
              textAlign: 'center',
              padding: 16,
            }}
          >
            Analysing flight…
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'var(--font-mono)' }}>
            <Column
              label="Previous Best"
              violet
              metrics={
                previousBest
                  ? {
                      distance: previousBest.distanceFlownKm,
                      totalPoints: previousBest.totalPoints,
                      distancePoints: previousBest.distancePoints,
                      timePoints: previousBest.timePoints,
                      reachedGoal: previousBest.reachedGoal,
                      taskTimeS: previousBest.taskTimeS,
                    }
                  : null
              }
            />
            <Column
              label="This Flight"
              green
              metrics={previewMetrics}
              previousMetrics={
                previousBest
                  ? {
                      distance: previousBest.distanceFlownKm,
                      totalPoints: previousBest.totalPoints,
                      distancePoints: previousBest.distancePoints,
                      timePoints: previousBest.timePoints,
                      reachedGoal: previousBest.reachedGoal,
                      taskTimeS: previousBest.taskTimeS,
                    }
                  : null
              }
            />
          </div>
        )}
      </div>

      <div
        style={{
          padding: '10px 12px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          className="btn btn-ghost"
          style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
          onClick={onCancel}
          disabled={uploading}
        >
          Cancel
        </button>
        <button
          className="btn btn-primary"
          style={{ flex: 2, justifyContent: 'center', fontSize: 13 }}
          onClick={onSubmit}
          // Parse/preview errors are unrecoverable without a different file —
          // disable Submit. UPLOAD errors (network blip, server 5xx) are
          // retryable against the same file so we keep Submit enabled.
          disabled={uploading || !result || (!!error && error.stage !== 'UPLOAD')}
        >
          {uploading ? 'Submitting…' : error?.stage === 'UPLOAD' ? 'Retry submit' : 'Submit Flight'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Column
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnMetrics {
  distance: number;
  totalPoints: number;
  distancePoints: number;
  timePoints: number;
  reachedGoal: boolean;
  turnpointsCrossed?: number;
  taskTimeS: number | null;
}

function Column({
  label,
  metrics,
  previousMetrics,
  violet,
  green,
}: {
  label: string;
  metrics: ColumnMetrics | null;
  previousMetrics?: ColumnMetrics | null;
  violet?: boolean;
  green?: boolean;
}) {
  const accent = violet ? '#a78bfa' : green ? '#10b981' : 'var(--text)';
  if (!metrics) {
    return (
      <div
        style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', fontSize: 11 }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: accent,
            marginBottom: 8,
          }}
        >
          {label}
        </div>
        No previous submission for this task.
      </div>
    );
  }

  const dDist = previousMetrics ? delta(metrics.distance, previousMetrics.distance) : null;
  const dTotal = previousMetrics ? delta(metrics.totalPoints, previousMetrics.totalPoints) : null;
  // Task time is inverse: faster (lower) is better. Format the delta as a
  // signed h:mm:ss / mm:ss so it sits next to the H:MM:SS readout sensibly
  // (a "+45.0" raw-seconds delta next to "1:23:45" reads awkwardly).
  const dTime =
    previousMetrics && metrics.taskTimeS != null && previousMetrics.taskTimeS != null
      ? formatTimeDelta(metrics.taskTimeS, previousMetrics.taskTimeS)
      : null;

  return (
    <div style={{ padding: 10, border: `1px solid ${accent}55`, borderRadius: 6 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: accent,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <Row k="Distance" v={fmtKm(metrics.distance)} delta={dDist} />
      <Row k="Total pts" v={fmtPts(metrics.totalPoints)} delta={dTotal} bold />
      <Row k="Dist pts" v={fmtPts(metrics.distancePoints)} />
      <Row k="Time pts" v={fmtPts(metrics.timePoints)} />
      <Row k="Goal" v={metrics.reachedGoal ? '✓' : '✗'} />
      {metrics.turnpointsCrossed != null && <Row k="Turnpoints" v={String(metrics.turnpointsCrossed)} />}
      <Row k="Task time" v={fmtTime(metrics.taskTimeS)} delta={dTime} />
    </div>
  );
}

function Row({
  k,
  v,
  delta: d,
  bold,
}: {
  k: string;
  v: string;
  delta?: { text: string; color: string } | null;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 11,
        padding: '2px 0',
        fontWeight: bold ? 700 : 400,
      }}
    >
      <span style={{ color: 'var(--text3)' }}>{k}</span>
      <span style={{ color: 'var(--text)' }}>
        {v}
        {d && <span style={{ marginLeft: 4, fontSize: 10, color: d.color }}>{d.text}</span>}
      </span>
    </div>
  );
}
