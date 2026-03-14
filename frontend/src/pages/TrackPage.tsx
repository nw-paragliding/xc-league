import { useState, useEffect, useRef } from 'react';
import { useTrack } from '../hooks/useTrack';
import { useTasks, useMySubmissions } from '../hooks/useTasks';
import { useAuth } from '../hooks/useAuth';
import type { TrackReplay } from '../api/track';
import type { Fix } from '../api/track';

function fmtTime(seconds: number | null) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function TrackCanvas({ track }: { track: TrackReplay }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { fixes, crossings, bounds } = track;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    canvas.width = W; canvas.height = H;

    const pad = 40;
    const toX = (lng: number) => pad + ((lng - bounds.west) / (bounds.east - bounds.west)) * (W - pad * 2);
    const toY = (lat: number) => pad + ((bounds.north - lat) / (bounds.north - bounds.south)) * (H - pad * 2);

    ctx.fillStyle = '#0f1318';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = pad + (i / 4) * (W - pad * 2);
      const y = pad + (i / 4) * (H - pad * 2);
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, H - pad); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    }

    // Altitude-coloured track
    if (fixes.length > 1) {
      const alts = fixes.map(f => f.alt);
      const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
      for (let i = 1; i < fixes.length; i++) {
        const f0 = fixes[i - 1], f1 = fixes[i];
        const t = (f1.alt - minAlt) / (maxAlt - minAlt || 1);
        const r = Math.round(74  + t * (232 - 74));
        const g = Math.round(158 + t * (168 - 158));
        const b = Math.round(255 + t * (66  - 255));
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(toX(f0.lng), toY(f0.lat));
        ctx.lineTo(toX(f1.lng), toY(f1.lat));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Cylinders
    crossings.forEach(c => {
      const cx = toX(c.longitude), cy = toY(c.latitude);
      const radiusPx = (c.radiusM / 111320) / (bounds.east - bounds.west) * (W - pad * 2);
      const color = c.type === 'SSS' ? '#4a9eff' : c.type.includes('GOAL') ? '#5db87a' : '#e8a842';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(radiusPx, 6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = color;
      ctx.font = '11px DM Mono, monospace';
      ctx.globalAlpha = 0.8;
      ctx.fillText(c.turnpointName, cx + 8, cy - 4);
      ctx.globalAlpha = 1;
    });

    // Start dot
    if (fixes.length > 0) {
      const f = fixes[0];
      ctx.fillStyle = '#4a9eff';
      ctx.beginPath();
      ctx.arc(toX(f.lng), toY(f.lat), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [track]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}

export default function TrackPage() {
  const { user, login } = useAuth();
  const { data: tasks } = useTasks();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);

  const { data: submissions } = useMySubmissions(selectedTaskId);
  const { data: track, isLoading, error } = useTrack(selectedTaskId, selectedSubmissionId);

  // Auto-select first submission when submissions load
  useEffect(() => {
    if (submissions?.length && !selectedSubmissionId) {
      setSelectedSubmissionId(submissions[0].id);
    }
  }, [submissions, selectedSubmissionId]);

  if (!user) {
    return (
      <div style={{ padding: '80px 36px', textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>🗺️</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Sign in to view tracks</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', fontFamily: 'var(--font-mono)', marginBottom: 24 }}>
          Track replay is available for your own submissions
        </div>
        <button className="btn btn-primary" onClick={login}>Continue with Google</button>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <div className="page-title">Track Replay</div>
          <div className="page-subtitle">
            {track
              ? `${track.pilotName} · ${track.flightDate} · ${track.meta.fixCount.toLocaleString()} fixes`
              : 'Select a task and submission'}
          </div>
        </div>
        {track?.meta.reachedGoal && <span className="badge badge-goal" style={{ alignSelf: 'center' }}>✓ Goal</span>}
      </div>

      <div className="page-body" style={{ flex: 1, display: 'flex', gap: 20, overflow: 'hidden', minHeight: 0 }}>
        {/* Map */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <div className="map-container" style={{ flex: 1 }}>
            {isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                Loading track…
              </div>
            )}
            {(error as any) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                {(error as any).message ?? 'Failed to load track'}
              </div>
            )}
            {!selectedSubmissionId && !isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                Select a task and submission to view track
              </div>
            )}
            {track && <TrackCanvas track={track} />}
            {track && (
              <div className="map-overlay">
                <div className="map-chip"><strong>Duration</strong> {fmtTime(track.meta.durationS)}</div>
                <div className="map-chip"><strong>Points</strong> {track.meta.totalPoints}</div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', flexShrink: 0 }}>
            <div style={{ width: 60, height: 3, background: 'linear-gradient(to right, #4a9eff, #e8a842)', borderRadius: 2 }} />
            <span>Low alt → High alt</span>
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ width: 260, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Task picker */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
              Task
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(tasks ?? []).map(t => (
                <div
                  key={t.id}
                  onClick={() => { setSelectedTaskId(t.id); setSelectedSubmissionId(null); }}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--r)',
                    cursor: 'pointer',
                    background: selectedTaskId === t.id ? 'var(--gold-glow)' : 'var(--bg3)',
                    border: `1px solid ${selectedTaskId === t.id ? 'var(--gold-dim)' : 'var(--border)'}`,
                    fontSize: 12,
                    fontWeight: 600,
                    color: selectedTaskId === t.id ? 'var(--gold)' : 'var(--text2)',
                    transition: 'all 0.15s',
                  }}
                >
                  {t.name}
                </div>
              ))}
            </div>
          </div>

          {/* Submission picker */}
          {selectedTaskId && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
                Submission
              </div>
              {!submissions?.length ? (
                <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>
                  No submissions for this task
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {submissions.map(s => (
                    <div
                      key={s.id}
                      onClick={() => setSelectedSubmissionId(s.id)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 'var(--r)',
                        cursor: 'pointer',
                        background: selectedSubmissionId === s.id ? 'var(--gold-glow)' : 'var(--bg3)',
                        border: `1px solid ${selectedSubmissionId === s.id ? 'var(--gold-dim)' : 'var(--border)'}`,
                        fontSize: 12,
                        transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ fontWeight: 600, color: selectedSubmissionId === s.id ? 'var(--gold)' : 'var(--text2)' }}>
                        {s.igcFilename}
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}>
                        {new Date(s.submittedAt).toLocaleDateString()} · {Math.round(s.bestAttempt.totalPoints)} pts
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Crossings */}
          {track?.crossings.length ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
                Crossings
              </div>
              <div className="crossing-list">
                {track.crossings.map((c, i) => {
                  const dotClass = c.type === 'SSS' ? 'sss' : c.type.includes('GOAL') ? 'goal' : 'tp';
                  return (
                    <div key={i} className="crossing-item">
                      <div className={`crossing-dot ${dotClass}`} />
                      <div className="crossing-name">{c.turnpointName}</div>
                      <div className="crossing-time">
                        {new Date(c.crossingTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
