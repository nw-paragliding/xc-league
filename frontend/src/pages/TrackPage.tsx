import { useState, useEffect } from 'react';
import { useTrack } from '../hooks/useTrack';
import { useTasks, useMySubmissions } from '../hooks/useTasks';
import { useAuth } from '../hooks/useAuth';
import { TaskMap } from './TasksPage';

function fmtTime(seconds: number | null) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

export default function TrackPage() {
  const { user, login } = useAuth();
  const { data: tasks } = useTasks();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);

  const { data: submissions } = useMySubmissions(selectedTaskId);
  const { data: track, isLoading, error } = useTrack(selectedTaskId, selectedSubmissionId);

  const selectedTask  = tasks?.find(t => t.id === selectedTaskId) ?? null;
  const trackCoords   = track?.fixes.map(f => [f.lng, f.lat] as [number, number]);

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
          <div className="map-container" style={{ flex: 1, position: 'relative' }}>
            <TaskMap turnpoints={selectedTask?.turnpoints ?? []} trackCoords={trackCoords} />
            {!selectedSubmissionId && !isLoading && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 13,
                background: 'rgba(15,19,24,0.6)', pointerEvents: 'none',
              }}>
                Select a task and submission to view track
              </div>
            )}
            {isLoading && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 13,
                background: 'rgba(15,19,24,0.6)', pointerEvents: 'none',
              }}>
                Loading track…
              </div>
            )}
            {(error as any) && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 13,
                background: 'rgba(15,19,24,0.6)', pointerEvents: 'none',
              }}>
                {(error as any).message ?? 'Failed to load track'}
              </div>
            )}
            {track && (
              <div className="map-overlay">
                <div className="map-chip"><strong>Duration</strong> {fmtTime(track.meta.durationS)}</div>
                <div className="map-chip"><strong>Points</strong> {track.meta.totalPoints}</div>
              </div>
            )}
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
