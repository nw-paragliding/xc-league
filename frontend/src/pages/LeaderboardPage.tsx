import { useState, useEffect } from 'react';
import { useTasks, useLeaderboard } from '../hooks/useTasks';
import { useAuth } from '../hooks/useAuth';

function fmtTime(seconds: number | null) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function SkeletonRow() {
  return (
    <tr>
      {[48, 160, 80, 80, 80, 80, 80, 60].map((w, i) => (
        <td key={i} style={{ padding: '12px 14px' }}>
          <div className="shimmer" style={{ height: 14, width: w, borderRadius: 3 }} />
        </td>
      ))}
    </tr>
  );
}

export default function LeaderboardPage() {
  const { user } = useAuth();
  const { data: tasks, isLoading: tasksLoading } = useTasks();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Auto-select first task
  useEffect(() => {
    if (tasks?.length && !selectedTaskId) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [tasks, selectedTaskId]);

  const { data: lb, isLoading: lbLoading, isFetching } = useLeaderboard(selectedTaskId);
  const task = lb?.task ?? tasks?.find(t => t.id === selectedTaskId);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <div className="page-title">Task Results</div>
          <div className="page-subtitle">
            {isFetching && !lbLoading
              ? 'Refreshing…'
              : task ? `${task.pilotCount} pilots · ${task.goalCount} in goal` : 'Select a task'}
          </div>
        </div>
      </div>

      <div className="page-body">
        {/* Task pills */}
        {tasksLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
            {[1,2,3].map(i => (
              <div key={i} className="shimmer" style={{ height: 62, borderRadius: 8 }} />
            ))}
          </div>
        ) : (
          <div className="task-list">
            {(tasks ?? []).map(t => (
              <div
                key={t.id}
                className={`task-pill${t.id === selectedTaskId ? ' selected' : ''}`}
                onClick={() => setSelectedTaskId(t.id)}
              >
                <div className="task-pill-left">
                  <div className="task-pill-name">{t.name}</div>
                  <div className="task-pill-meta">
                    {t.openDate} → {t.closeDate}
                    {t.scoresFrozenAt && <span style={{ marginLeft: 8, color: 'var(--text3)' }}>· Closed</span>}
                  </div>
                </div>
                <div className="task-pill-right" />
              </div>
            ))}
          </div>
        )}

        {/* Stats */}
        {task && (
          <div className="stats-row" style={{ marginBottom: 20 }}>
            <div className="stat-chip">
              <div className="stat-chip-label">Pilots</div>
              <div className="stat-chip-value">{task.pilotCount}</div>
            </div>
            <div className="stat-chip">
              <div className="stat-chip-label">Goal</div>
              <div className="stat-chip-value sky">{task.goalCount}</div>
            </div>
            {lb?.entries[0]?.taskTimeS && (
              <div className="stat-chip">
                <div className="stat-chip-label">Best Time</div>
                <div className="stat-chip-value" style={{ fontSize: 18 }}>
                  {fmtTime(lb.entries[0].taskTimeS)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Table */}
        <div className="card">
          <table className="lb-table">
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>Pilot</th>
                <th className="right">Dist</th>
                <th className="right">Time</th>
                <th className="right">Dist Pts</th>
                <th className="right">Time Pts</th>
                <th className="right">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lbLoading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                : (lb?.entries ?? []).map(row => (
                  <tr key={row.pilotId} className={`lb-row${row.pilotId === user?.id ? ' me' : ''}`}>
                    <td>
                      <span className={`rank-num${row.rank <= 3 ? ' top' : ''}`}>{row.rank}</span>
                    </td>
                    <td>
                      <span className={`pilot-name${row.pilotId === user?.id ? ' me' : ''}`}>
                        {row.pilotName}
                      </span>
                      {row.pilotId === user?.id && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--gold)', fontFamily: 'var(--font-mono)' }}>you</span>
                      )}
                    </td>
                    <td className="right">
                      <span className="mono" style={{ fontSize: 12 }}>{row.distanceFlownKm.toFixed(1)} km</span>
                    </td>
                    <td className="right">
                      <span className="time-str">{fmtTime(row.taskTimeS)}</span>
                    </td>
                    <td className="right"><span className="pts">{Math.round(row.distancePoints)}</span></td>
                    <td className="right">
                      <span className="pts">
                        {row.timePoints > 0
                          ? Math.round(row.timePoints)
                          : <span className="pts dim">—</span>}
                      </span>
                    </td>
                    <td className="right">
                      <span className="pts total">{Math.round(row.totalPoints)}</span>
                    </td>
                    <td>
                      {row.reachedGoal && <span className="badge badge-goal">goal</span>}
                      {row.hasFlaggedCrossings && (
                        <span className="badge badge-flag" style={{ marginLeft: 4 }}>⚑</span>
                      )}
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
