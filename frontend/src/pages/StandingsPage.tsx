import { useStandings } from '../hooks/useStandings';
import { useAuth } from '../hooks/useAuth';
import { useTasks } from '../hooks/useTasks';

export default function StandingsPage() {
  const { user } = useAuth();
  const { data, isLoading } = useStandings();
  const { data: tasks } = useTasks();

  const standings = data?.standings ?? [];
  const season    = data?.season;
  const maxPts    = standings[0]?.totalPoints ?? 1;
  const taskCount = tasks?.length ?? season?.taskCount ?? 0;

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <div className="page-title">Season Standings</div>
          <div className="page-subtitle">
            {season
              ? `${season.name} · ${taskCount} task${taskCount !== 1 ? 's' : ''}`
              : 'Loading…'}
          </div>
        </div>
      </div>

      <div className="page-body">
        {/* Top 3 podium */}
        {isLoading ? (
          <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
            {[1,2,3].map(i => (
              <div key={i} className="shimmer" style={{ flex: 1, height: 110, borderRadius: 10 }} />
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
            {standings.slice(0, 3).map((p, i) => (
              <div key={p.pilotId} style={{
                flex: 1,
                background: i === 0
                  ? 'linear-gradient(135deg, rgba(232,168,66,0.12), rgba(232,168,66,0.04))'
                  : 'var(--bg2)',
                border: `1px solid ${i === 0 ? 'var(--gold-dim)' : 'var(--border)'}`,
                borderRadius: 10,
                padding: '18px 20px',
              }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>{['🥇','🥈','🥉'][i]}</div>
                <div style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: p.pilotId === user?.id ? 'var(--gold)' : 'var(--text)',
                }}>
                  {p.pilotName}
                  {p.pilotId === user?.id && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--gold)', fontFamily: 'var(--font-mono)' }}>you</span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--text)', marginTop: 4 }}>
                  {p.totalPoints.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginTop: 2 }}>
                  {p.tasksFlown} tasks · {p.tasksWithGoal} goals
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Full standings */}
        <div className="card">
          <table className="lb-table">
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>Pilot</th>
                <th>Progress</th>
                <th className="right">Tasks</th>
                <th className="right">Goals</th>
                <th className="right">Total Pts</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {[48, 160, 120, 60, 60, 80].map((w, j) => (
                      <td key={j} style={{ padding: '12px 14px' }}>
                        <div className="shimmer" style={{ height: 14, width: w, borderRadius: 3 }} />
                      </td>
                    ))}
                  </tr>
                ))
                : standings.map(row => (
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
                    <td style={{ minWidth: 120 }}>
                      <div style={{ background: 'var(--bg3)', borderRadius: 2, height: 4, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${(row.totalPoints / maxPts) * 100}%`,
                          background: row.pilotId === user?.id ? 'var(--gold)' : 'var(--text3)',
                          borderRadius: 2,
                          transition: 'width 0.6s ease',
                        }} />
                      </div>
                    </td>
                    <td className="right">
                      <span className="mono" style={{ fontSize: 12, color: 'var(--text2)' }}>
                        {row.tasksFlown}/{taskCount}
                      </span>
                    </td>
                    <td className="right">
                      <span className="mono" style={{ fontSize: 12, color: 'var(--sky)' }}>{row.tasksWithGoal}</span>
                    </td>
                    <td className="right">
                      <span className="pts total">{row.totalPoints.toLocaleString()}</span>
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
