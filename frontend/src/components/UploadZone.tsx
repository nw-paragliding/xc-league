import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmissionResponse, Task } from '../api/tasks';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { useUpload } from '../hooks/useSubmission';
import type { TaskStatus } from '../utils/taskStatus';
import TaskExportModal from './TaskExportModal';

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

// ─────────────────────────────────────────────────────────────────────────────
// ScoreResult
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
// UploadZone
// ─────────────────────────────────────────────────────────────────────────────

interface UploadZoneProps {
  taskId: string;
  taskStatus: TaskStatus;
  task: Task;
  onSubmission?: (id: string) => void;
}

export default function UploadZone({ taskId, taskStatus, task, onSubmission }: UploadZoneProps) {
  const { user, login } = useAuth();
  const { leagueSlug } = useLeague();
  const [showExport, setShowExport] = useState(false);
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

  const isDisabled = taskStatus !== 'OPEN';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Action row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {task.status === 'published' && (
          <button
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => setShowExport(true)}
          >
            Get Task ↓
          </button>
        )}
      </div>

      {/* Upload area */}
      {isDisabled ? (
        <div
          style={{
            padding: '14px 16px',
            background: 'var(--bg3)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r)',
            textAlign: 'center',
            opacity: 0.75,
          }}
        >
          {taskStatus === 'UPCOMING' && (
            <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
              Opens{' '}
              {new Date(task.openDate).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          )}
          {taskStatus === 'CLOSED' && (
            <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
              Scoring is final — submissions closed
            </div>
          )}
          {taskStatus === 'DRAFT' && (
            <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Not yet published</div>
          )}
        </div>
      ) : (
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
            {!user ? (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>Sign in to submit a flight</div>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={login}>
                  Sign in
                </button>
              </div>
            ) : status === 'done' && result ? (
              <ScoreResult result={result} onReset={handleReset} />
            ) : (
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
                      <div
                        style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}
                      >
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
            )}
          </div>
        </div>
      )}

      {showExport && (
        <TaskExportModal task={task as any} leagueSlug={leagueSlug} onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}
