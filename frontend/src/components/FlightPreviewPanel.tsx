import type { LeaderboardEntry } from '../api/tasks';
import type { PreviewError, PreviewResult } from '../lib/previewPipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTime(seconds: number | null) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
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

function delta(
  curr: number | null | undefined,
  prev: number | null | undefined,
  opts: { higherIsBetter?: boolean } = {},
) {
  if (curr == null || prev == null) return null;
  const d = curr - prev;
  if (Math.abs(d) < 0.05) return null;
  const better = (opts.higherIsBetter ?? true) ? d > 0 : d < 0;
  const sign = d > 0 ? '+' : '';
  return { text: `${sign}${d.toFixed(1)}`, color: better ? 'var(--gold)' : 'var(--danger)' };
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
          disabled={uploading || !!error || !result}
        >
          {uploading ? 'Submitting…' : 'Submit Flight'}
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
      <Row k="Task time" v={fmtTime(metrics.taskTimeS)} />
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
