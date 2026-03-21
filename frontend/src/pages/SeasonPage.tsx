// =============================================================================
// SeasonPage — Results: Overall score matrix + per-task breakdown tabs
// =============================================================================

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTasks } from '../hooks/useTasks';
import { useStandings } from '../hooks/useStandings';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { tasksApi } from '../api/tasks';
import type { LeaderboardEntry, Task } from '../api/tasks';
import type { StandingsEntry } from '../api/standings';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTime(s: number | null) {
  if (!s) return '—';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared table styles
// ─────────────────────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: 13,
};

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 22, height: 22,
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 700,
      fontFamily: 'var(--font-mono)',
      background: top ? 'rgba(59,130,246,0.15)' : 'transparent',
      color: top ? 'var(--accent)' : 'var(--text3)',
    }}>
      {rank}
    </span>
  );
}

function PilotCell({ name, isMe }: { name: string; isMe: boolean }) {
  return (
    <td style={TD}>
      <span style={{ fontWeight: isMe ? 700 : 400, color: isMe ? 'var(--accent)' : 'var(--text)' }}>
        {name}
      </span>
      {isMe && (
        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', opacity: 0.7 }}>
          you
        </span>
      )}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab button
// ─────────────────────────────────────────────────────────────────────────────

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 16px',
        background: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        color: active ? 'var(--text)' : 'var(--text3)',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'color 0.15s',
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overall tab — pilot × task score matrix
// ─────────────────────────────────────────────────────────────────────────────

interface OverallTabProps {
  standings: StandingsEntry[];
  tasks:     Task[];
  scoreMap:  Map<string, Map<string, number>>;
  maxByTask: Record<string, number>;
  myId:      string | undefined;
}

function OverallTab({ standings, tasks, scoreMap, maxByTask, myId }: OverallTabProps) {
  if (!standings.length) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
        No pilots have flown yet this season
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400, width: 'auto' }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 36 }}>#</th>
            <th style={{ ...TH, minWidth: 160 }}>Pilot</th>
            <th style={{ ...TH, textAlign: 'right', paddingRight: 24, whiteSpace: 'nowrap' }}>Total</th>
            {tasks.map(t => (
              <th key={t.id} style={{ ...TH, textAlign: 'center', width: 80 }}>
                <div style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 80,
                }}>
                  {t.name}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {standings.map(row => {
            const isMe = row.pilotId === myId;
            return (
              <tr key={row.pilotId} style={{ background: isMe ? 'rgba(59,130,246,0.07)' : undefined }}>
                <td style={TD}><RankBadge rank={row.rank} /></td>
                <PilotCell name={row.pilotName} isMe={isMe} />

                <td style={{ ...TD, textAlign: 'right', paddingRight: 24 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                    {row.totalPoints.toLocaleString()}
                  </span>
                </td>

                {tasks.map(task => {
                  const pts   = scoreMap.get(task.id)?.get(row.pilotId);
                  const max   = maxByTask[task.id] ?? 1;
                  const ratio = pts != null ? pts / max : 0;
                  return (
                    <td key={task.id} style={{ ...TD, textAlign: 'center', width: 80 }}>
                      {pts != null ? (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 7px',
                          borderRadius: 4,
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                          fontSize: 12,
                          background: `rgba(59,130,246,${(0.07 + ratio * 0.25).toFixed(2)})`,
                          color: ratio >= 0.5 ? '#93c5fd' : 'var(--text2)',
                        }}>
                          {Math.round(pts)}
                        </span>
                      ) : (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text3)' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task tab — per-task score breakdown
// ─────────────────────────────────────────────────────────────────────────────

interface TaskTabProps {
  entries:   LeaderboardEntry[];
  isLoading: boolean;
  myId:      string | undefined;
}

function TaskTab({ entries, isLoading, myId }: TaskTabProps) {
  if (isLoading) {
    return (
      <div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="shimmer" style={{ height: 42, borderRadius: 6, marginBottom: 6 }} />
        ))}
      </div>
    );
  }

  if (!entries.length) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
        No submissions yet for this task
      </div>
    );
  }

  const anyFlagged = entries.some(e => e.hasFlaggedCrossings);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: 'auto', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 36 }}>#</th>
            <th style={TH}>Pilot</th>
            <th style={{ ...TH, textAlign: 'center', width: 56 }}>Goal</th>
            <th style={{ ...TH, textAlign: 'right' }}>Distance</th>
            <th style={{ ...TH, textAlign: 'right' }}>Time</th>
            <th style={{ ...TH, textAlign: 'right' }}>Dist Pts</th>
            <th style={{ ...TH, textAlign: 'right' }}>Time Pts</th>
            <th style={{ ...TH, textAlign: 'right' }}>Total</th>
            {anyFlagged && <th style={{ ...TH, textAlign: 'center', width: 36 }}>⚑</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(e => {
            const isMe = e.pilotId === myId;
            return (
              <tr key={e.pilotId} style={{ background: isMe ? 'rgba(59,130,246,0.07)' : undefined }}>
                <td style={TD}><RankBadge rank={e.rank} /></td>
                <PilotCell name={e.pilotName} isMe={isMe} />

                <td style={{ ...TD, textAlign: 'center' }}>
                  {e.reachedGoal
                    ? <span style={{ color: '#5db87a', fontWeight: 700, fontSize: 15 }}>✓</span>
                    : <span style={{ color: 'var(--text3)', fontSize: 15 }}>✗</span>
                  }
                </td>

                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {e.distanceFlownKm.toFixed(1)} km
                </td>

                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {fmtTime(e.taskTimeS)}
                </td>

                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {Math.round(e.distancePoints)}
                </td>

                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {Math.round(e.timePoints)}
                </td>

                <td style={{ ...TD, textAlign: 'right' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text)' }}>
                    {Math.round(e.totalPoints)}
                  </span>
                </td>

                {anyFlagged && (
                  <td style={{ ...TD, textAlign: 'center', color: 'var(--warning)', fontSize: 14 }}>
                    {e.hasFlaggedCrossings ? '⚑' : ''}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SeasonPage
// ─────────────────────────────────────────────────────────────────────────────

export default function SeasonPage() {
  const [activeTab, setActiveTab] = useState<'overall' | string>('overall');

  const { user }                                       = useAuth();
  const { leagueSlug, seasonId }                       = useLeague();
  const { data: tasks,        isLoading: tasksLoading } = useTasks();
  const { data: standingsData, isLoading: standingsLoading } = useStandings();

  const standings      = standingsData?.standings ?? [];
  const season         = standingsData?.season;
  const publishedTasks = (tasks ?? []).filter(t => t.status === 'published');

  // Fetch all task leaderboards in parallel (shared by both Overall and task tabs)
  const leaderboardQueries = useQueries({
    queries: publishedTasks.map(task => ({
      queryKey:  ['leaderboard', leagueSlug, seasonId, task.id],
      queryFn:   () => tasksApi.leaderboard(leagueSlug, seasonId, task.id),
      staleTime: 60 * 1000,
    })),
  });

  // scoreMap: taskId → (pilotId → totalPoints) — for Overall tab cells
  const scoreMap = new Map<string, Map<string, number>>();
  publishedTasks.forEach((task, i) => {
    const byPilot = new Map<string, number>();
    for (const e of leaderboardQueries[i]?.data?.entries ?? []) {
      byPilot.set(e.pilotId, e.totalPoints);
    }
    scoreMap.set(task.id, byPilot);
  });

  // Per-task max score for heat-map intensity
  const maxByTask: Record<string, number> = {};
  publishedTasks.forEach(task => {
    let max = 0;
    scoreMap.get(task.id)?.forEach(v => { if (v > max) max = v; });
    maxByTask[task.id] = max || 1;
  });

  const isLoading      = tasksLoading || standingsLoading;
  const activeTaskIdx  = publishedTasks.findIndex(t => t.id === activeTab);
  const activeQuery    = activeTaskIdx >= 0 ? leaderboardQueries[activeTaskIdx] : null;

  return (
    <div className="fade-in" style={{ height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div className="page-header">
        <div className="page-title">Results</div>
        <div style={{ color: 'var(--text2)', fontSize: 14, marginTop: 4 }}>
          {season
            ? `${season.name} · ${standings.length} pilot${standings.length !== 1 ? 's' : ''} · ${publishedTasks.length} task${publishedTasks.length !== 1 ? 's' : ''}`
            : isLoading ? 'Loading…' : 'No active season'}
        </div>
      </div>

      <div className="page-body">
        {/* Tab bar */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          marginBottom: 24,
          overflowX: 'auto',
        }}>
          <TabButton label="Overall" active={activeTab === 'overall'} onClick={() => setActiveTab('overall')} />
          {publishedTasks.map(task => (
            <TabButton
              key={task.id}
              label={task.name}
              active={activeTab === task.id}
              onClick={() => setActiveTab(task.id)}
            />
          ))}
        </div>

        {/* Content */}
        {isLoading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="shimmer" style={{ height: 42, borderRadius: 6, marginBottom: 6 }} />
            ))}
          </div>
        ) : activeTab === 'overall' ? (
          <OverallTab
            standings={standings}
            tasks={publishedTasks}
            scoreMap={scoreMap}
            maxByTask={maxByTask}
            myId={user?.id}
          />
        ) : (
          <TaskTab
            entries={activeQuery?.data?.entries ?? []}
            isLoading={activeQuery?.isLoading ?? false}
            myId={user?.id}
          />
        )}
      </div>
    </div>
  );
}
