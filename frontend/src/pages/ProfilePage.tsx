import { useAuth } from '../hooks/useAuth';
import { useStandings } from '../hooks/useStandings';
import { useTasks, useMySubmissions } from '../hooks/useTasks';
import { useState } from 'react';

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function fmtTime(seconds: number | null) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// Per-task results sub-component — loads submissions for one task
function TaskResultRow({ taskId, taskName, leagueSlug, seasonId }: {
  taskId: string;
  taskName: string;
  leagueSlug: string;
  seasonId: string;
}) {
  const { data: submissions, isLoading } = useMySubmissions(taskId);
  const best = submissions?.[0]; // API returns sorted by best score

  return (
    <tr className="lb-row">
      <td><span className="pilot-name">{taskName}</span></td>
      <td className="right">
        {isLoading
          ? <div className="shimmer" style={{ height: 12, width: 60, borderRadius: 3, marginLeft: 'auto' }} />
          : <span className="mono" style={{ fontSize: 12 }}>
              {best ? `${best.bestAttempt.distanceFlownKm.toFixed(1)} km` : '—'}
            </span>}
      </td>
      <td className="right">
        <span className="time-str">{best ? fmtTime(best.bestAttempt.taskTimeS) : '—'}</span>
      </td>
      <td className="right">
        {best
          ? <span className="pts total">{Math.round(best.bestAttempt.totalPoints)}</span>
          : <span className="pts dim">DNS</span>}
      </td>
      <td>
        {best?.bestAttempt.reachedGoal && <span className="badge badge-goal">goal</span>}
      </td>
    </tr>
  );
}

export default function ProfilePage() {
  const { user, logout, login } = useAuth();
  const { data: standingsData } = useStandings();
  const { data: tasks } = useTasks();
  const [editName, setEditName] = useState(false);

  if (!user) {
    return (
      <div style={{ padding: '80px 36px', textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>👤</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Sign in to view profile</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', fontFamily: 'var(--font-mono)', marginBottom: 24 }}>
          See your standings, results, and flight history
        </div>
        <button className="btn btn-primary" onClick={login}>Continue with Google</button>
      </div>
    );
  }

  const myStanding = standingsData?.standings.find(s => s.pilotId === user.id);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div className="page-title">Pilot Profile</div>
      </div>

      <div className="page-body" style={{ maxWidth: 680 }}>
        {/* Hero */}
        <div className="profile-hero">
          <div className="avatar-lg">{initials(user.displayName)}</div>
          <div style={{ flex: 1 }}>
            <div className="profile-name">{user.displayName}</div>
            <div className="profile-meta">{user.email}</div>
            {myStanding && (
              <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Rank</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 800, color: 'var(--gold)' }}>#{myStanding.rank}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Points</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 800 }}>{myStanding.totalPoints.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Tasks Flown</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 800 }}>{myStanding.tasksFlown}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Goals</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 800, color: 'var(--sky)' }}>{myStanding.tasksWithGoal}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Per-task results */}
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          My Results
        </div>
        <div className="card" style={{ marginBottom: 24 }}>
          <table className="lb-table">
            <thead>
              <tr>
                <th>Task</th>
                <th className="right">Distance</th>
                <th className="right">Time</th>
                <th className="right">Points</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(tasks ?? []).map(t => (
                <TaskResultRow
                  key={t.id}
                  taskId={t.id}
                  taskName={t.name}
                  leagueSlug="alps-xc-2025"
                  seasonId="season-1"
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Account actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn btn-ghost"
            onClick={logout}
            style={{ color: 'var(--danger)', borderColor: 'rgba(224,82,82,0.3)' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
