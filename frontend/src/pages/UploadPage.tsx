import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUpload } from '../hooks/useSubmission';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { leagueApi } from '../api/leagues';
import { tasksApi } from '../api/tasks';
import type { SubmissionResponse } from '../api/tasks';
import { TaskMap } from './TasksPage';

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
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtPts(n: number) { return Math.round(n).toString(); }

function ScoreResult({ result }: { result: SubmissionResponse }) {
  if ('errorCode' in result) {
    return (
      <div className="result-panel fade-in">
        <div className="result-status">
          <div className="result-icon">⚠️</div>
          <div>
            <div className="result-title error">Submission Invalid</div>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text2)', marginTop: 2 }}>
              {result.igcFilename}
            </div>
          </div>
        </div>
        <div style={{
          background: 'rgba(224,82,82,0.08)',
          border: '1px solid rgba(224,82,82,0.2)',
          borderRadius: 'var(--r)',
          padding: '12px 16px',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--danger)',
        }}>
          {result.errorMessage}
        </div>
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
          <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text2)', marginTop: 2 }}>
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
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="badge badge-goal">✓ Goal</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text2)' }}>
            {best.distanceFlownKm.toFixed(1)} km · {fmtTime(best.taskTimeS)}
          </span>
        </div>
      )}

      {best.hasFlaggedCrossings && (
        <div style={{ marginTop: 10 }}>
          <span className="badge badge-flag">⚑ Flagged crossings — check ground declaration</span>
        </div>
      )}

      {result.timePointsProvisional && (
        <div className="provisional-note">
          ⏳ Time points are provisional — will be updated once the task closes
        </div>
      )}

      {result.allAttempts.length > 1 && (
        <div style={{ marginTop: 14, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>
          {result.allAttempts.length} attempts detected in this IGC file — best scoring attempt shown
        </div>
      )}
    </div>
  );
}

export default function UploadPage() {
  const { user, login } = useAuth();
  const { leagueSlug } = useLeague();
  const { status, progress, result, error, upload, reset } = useUpload();

  const [file, setFile] = useState<File | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  // Fetch open seasons
  const { data: seasonsData, isLoading: seasonsLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
    enabled: !!user,
  });

  const openSeasons = (seasonsData?.seasons ?? []).filter(s => s.status === 'open');

  // Fetch tasks for the selected season
  const { data: tasksData, isLoading: tasksLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'],
    queryFn: () => leagueApi.listTasks(leagueSlug, selectedSeasonId!),
    enabled: !!selectedSeasonId,
  });

  // Fetch turnpoints for the selected task (to draw on map)
  const { data: taskDetail } = useQuery({
    queryKey: ['task', leagueSlug, selectedSeasonId, selectedTaskId],
    queryFn: () => tasksApi.get(leagueSlug, selectedSeasonId!, selectedTaskId!),
    enabled: !!selectedTaskId && !!selectedSeasonId,
    staleTime: 5 * 60 * 1000,
  });

  // Check registration for the selected season
  const { data: regData, isLoading: regLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'registration'],
    queryFn: () => leagueApi.getSeasonRegistration(leagueSlug, selectedSeasonId!),
    enabled: !!selectedSeasonId && !!user,
  });

  const tasks = tasksData?.tasks ?? [];
  const isRegistered = regData?.isRegistered ?? false;

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

  const handleSubmit = () => {
    if (!file || !selectedTaskId || !selectedSeasonId) return;
    upload(file, selectedTaskId);
  };

  const handleReset = () => {
    setFile(null);
    setSelectedTaskId(null);
    setSelectedSeasonId(null);
    reset();
  };

  if (!user) {
    return (
      <div style={{ padding: '80px 36px', textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>🔒</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Sign in to upload</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', fontFamily: 'var(--font-mono)', marginBottom: 24 }}>
          You need to be logged in to submit flights
        </div>
        <button className="btn btn-primary" onClick={login}>Continue with Google</button>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <div className="page-title">Submit Flight</div>
          <div className="page-subtitle">Upload your IGC file for scoring</div>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 640 }}>
        {status === 'done' && result ? (
          <>
            <ScoreResult result={result} />
            <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleReset}>Upload Another</button>
            </div>
          </>
        ) : (
          <>
            {/* Drop zone */}
            <div
              className={`upload-zone${drag ? ' drag-over' : ''}`}
              onDragEnter={() => { dragDepthRef.current++; setDrag(true); }}
              onDragOver={e => e.preventDefault()}
              onDragLeave={() => { dragDepthRef.current--; if (dragDepthRef.current === 0) setDrag(false); }}
              onDrop={e => { e.preventDefault(); dragDepthRef.current = 0; setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => { if (fileRef.current) fileRef.current.value = ''; fileRef.current?.click(); }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".igc"
                style={{ display: 'none' }}
                onChange={e => handleFile(e.target.files?.[0])}
              />
              {file ? (
                <div>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{file.name}</div>
                  <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 4 }}>
                    {fmtFileSize(file.size)}
                  </div>
                  <button
                    className="btn btn-ghost"
                    style={{ marginTop: 12, fontSize: 12 }}
                    onClick={e => { e.stopPropagation(); setFile(null); reset(); }}
                  >
                    ✕ Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="upload-icon">📁</div>
                  <div className="upload-title">Drop your IGC file here</div>
                  <div className="upload-sub">or click to browse</div>
                  <div className="upload-limit">Max 5MB · .igc files only</div>
                </>
              )}
            </div>

            {/* Error */}
            {status === 'error' && error && (
              <div style={{
                marginTop: 12,
                padding: '10px 14px',
                background: 'rgba(224,82,82,0.08)',
                border: '1px solid rgba(224,82,82,0.2)',
                borderRadius: 'var(--r)',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                color: 'var(--danger)',
              }}>
                {error}
              </div>
            )}

            {/* Season + Task selection */}
            {file && (
              <div className="fade-in" style={{ marginTop: 24 }}>
                {/* Season picker */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
                    Select Season
                  </div>
                  {seasonsLoading ? (
                    <div style={{ height: 48, borderRadius: 'var(--r)' }} className="shimmer" />
                  ) : openSeasons.length === 0 ? (
                    <div style={{
                      padding: '0.75rem 1rem',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r)',
                      fontSize: 13,
                      color: 'var(--text2)',
                    }}>
                      No open seasons. Ask your league admin to open a season.
                    </div>
                  ) : (
                    <div className="task-select-list">
                      {openSeasons.map(s => (
                        <div
                          key={s.id}
                          className={`task-select-item${selectedSeasonId === s.id ? ' sel' : ''}`}
                          onClick={() => {
                            setSelectedSeasonId(s.id);
                            setSelectedTaskId(null);
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}>
                              {new Date(s.startDate).toLocaleDateString()} – {new Date(s.endDate).toLocaleDateString()}
                            </div>
                          </div>
                          {selectedSeasonId === s.id && <span style={{ color: 'var(--gold)' }}>✓</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Registration check */}
                {selectedSeasonId && !regLoading && !isRegistered && (
                  <div style={{
                    padding: '10px 14px',
                    marginBottom: 16,
                    background: 'rgba(234,179,8,0.08)',
                    border: '1px solid rgba(234,179,8,0.3)',
                    borderRadius: 'var(--r)',
                    fontSize: 13,
                    color: '#92400e',
                  }}>
                    You are not registered for this season.{' '}
                    <strong>Go to My Seasons to register before uploading.</strong>
                  </div>
                )}

                {/* Task picker — only when registered */}
                {selectedSeasonId && isRegistered && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
                      Select Task
                    </div>
                    {tasksLoading ? (
                      <div style={{ height: 48, borderRadius: 'var(--r)' }} className="shimmer" />
                    ) : (
                      <div className="task-select-list">
                        {tasks
                          .filter(t => !t.scoresFrozenAt && new Date(t.closeDate) > new Date())
                          .map(t => (
                            <div
                              key={t.id}
                              className={`task-select-item${selectedTaskId === t.id ? ' sel' : ''}`}
                              onClick={() => setSelectedTaskId(t.id)}
                            >
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.name}</div>
                                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}>
                                  Closes {new Date(t.closeDate).toLocaleString()}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {selectedTaskId === t.id && <span style={{ color: 'var(--gold)' }}>✓</span>}
                              </div>
                            </div>
                          ))}
                        {tasks.filter(t => !t.scoresFrozenAt && new Date(t.closeDate) > new Date()).length === 0 && (
                          <div style={{ padding: '0.75rem 1rem', fontSize: 13, color: 'var(--text2)' }}>
                            No open tasks in this season.
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Task map — shown when a task is selected */}
            {selectedTaskId && taskDetail?.task?.turnpoints?.length ? (
              <div className="fade-in" style={{ marginTop: 24 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
                  Task Map
                </div>
                <div style={{ height: 340, borderRadius: 'var(--r)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                  <TaskMap turnpoints={taskDetail.task.turnpoints} />
                </div>
              </div>
            ) : null}

            {/* Submit / progress */}
            {file && selectedTaskId && selectedSeasonId && isRegistered && (
              <div className="fade-in" style={{ marginTop: 8 }}>
                {status === 'uploading' || status === 'processing' ? (
                  <div>
                    <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                      {status === 'uploading' ? `Uploading… ${progress}%` : 'Analysing flight…'}
                    </div>
                    <div className="progress-bar" style={{ marginTop: 10 }}>
                      {status === 'processing' ? (
                        <div className="progress-fill" />
                      ) : (
                        <div style={{ height: '100%', width: `${progress}%`, background: 'var(--gold)', borderRadius: 2, transition: 'width 0.2s' }} />
                      )}
                    </div>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={handleSubmit}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    Submit Flight
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
