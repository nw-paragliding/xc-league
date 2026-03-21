// =============================================================================
// HomePage — unified league home: standings matrix + per-task split view
// =============================================================================

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useTasks } from '../hooks/useTasks';
import { useStandings } from '../hooks/useStandings';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { tasksApi } from '../api/tasks';
import { trackApi } from '../api/track';
import type { League } from '../api/leagues';
import type { ReplayFix } from '../api/track';
import { getTaskStatus, STATUS_STYLE } from '../utils/taskStatus';
import { computeDistanceKm } from '../components/TaskMap';
import { toCylinder } from '../components/TaskMap';
import ReactMarkdown from 'react-markdown';
import LeagueSwitcher from '../components/LeagueSwitcher';
import ScoringExplainer from '../components/ScoringExplainer';
import StandingsMatrix from '../components/StandingsMatrix';
import TaskLeaderboard from '../components/TaskLeaderboard';
import TaskMap from '../components/TaskMap';
import UploadZone from '../components/UploadZone';
import type { Task, LeaderboardEntry } from '../api/tasks';

// ─────────────────────────────────────────────────────────────────────────────
// TabBar
// ─────────────────────────────────────────────────────────────────────────────

function TabBar({
  publishedTasks,
  activeTab,
  onSelect,
}: {
  publishedTasks: Task[];
  activeTab: 'overall' | string;
  onSelect: (id: 'overall' | string) => void;
}) {
  return (
    <div style={{
      display: 'flex',
      borderBottom: '1px solid var(--border)',
      marginBottom: 24,
      overflowX: 'auto',
      position: 'sticky',
      top: 0,
      background: 'var(--bg)',
      zIndex: 10,
    }}>
      <TabButton label="Overall" active={activeTab === 'overall'} onClick={() => onSelect('overall')} />
      {publishedTasks.map(task => (
        <TabButton
          key={task.id}
          label={task.name}
          active={activeTab === task.id}
          onClick={() => onSelect(task.id)}
        />
      ))}
    </div>
  );
}

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
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskLeftPanel — left column content for a single task tab
// ─────────────────────────────────────────────────────────────────────────────

function TaskLeftPanel({
  task,
  leaderboardEntries,
  leaderboardLoading,
  myId,
  selectedPilotId,
  trackLoading,
  onSelectPilot,
}: {
  task: Task;
  leaderboardEntries: LeaderboardEntry[];
  leaderboardLoading: boolean;
  myId: string | undefined;
  selectedPilotId: string | undefined;
  trackLoading: boolean;
  onSelectPilot: (entry: LeaderboardEntry) => void;
}) {
  const taskStatus = getTaskStatus(task);
  const ss = STATUS_STYLE[taskStatus];
  const distKm = task.turnpoints.length >= 2
    ? computeDistanceKm(task.turnpoints.map(toCylinder)).toFixed(1)
    : null;

  const activeEntry = leaderboardEntries.find(e => e.pilotId === selectedPilotId) ?? null;

  return (
    <>
      {/* Task header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{task.name}</span>
          <span style={{
            fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)',
            padding: '2px 6px', borderRadius: 3,
            background: ss.background, color: ss.color, border: `1px solid ${ss.border}`,
          }}>
            {taskStatus}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          {new Date(task.openDate).toLocaleDateString()} – {new Date(task.closeDate).toLocaleDateString()}
          {distKm && <span style={{ marginLeft: 8, color: 'var(--text2)' }}>{distKm} km</span>}
        </div>
      </div>

      {/* Leaderboard */}
      <div style={{ marginBottom: 20 }}>
        {activeEntry && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
            Showing track for{' '}
            <span style={{ color: '#a78bfa', fontWeight: 600 }}>
              {trackLoading ? '…' : activeEntry.pilotName}
            </span>
            {' '}— click a row to switch
          </div>
        )}
        <TaskLeaderboard
          entries={leaderboardEntries}
          isLoading={leaderboardLoading}
          myId={myId}
          selectedPilotId={selectedPilotId}
          onSelectPilot={onSelectPilot}
        />
      </div>

      {/* Upload zone */}
      <UploadZone taskId={task.id} taskStatus={taskStatus} task={task} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HomePage
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);

  const activeTab = searchParams.get('task') ?? 'overall';
  const setActiveTab = (tab: 'overall' | string) => {
    setSelectedEntry(null);
    if (tab === 'overall') {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ task: tab }, { replace: true });
    }
  };

  const { user }                                            = useAuth();
  const { leagueSlug, seasonId }                            = useLeague();
  const { data: tasks, isLoading: tasksLoading }            = useTasks();
  const { data: standingsData, isLoading: standingsLoading } = useStandings();

  const { data: leagueData } = useQuery({
    queryKey: ['leagues', leagueSlug],
    queryFn: async () => {
      const response = await fetch(`/api/v1/leagues/${leagueSlug}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch league');
      return response.json() as Promise<{ league: League }>;
    },
    staleTime: 5 * 60 * 1000,
  });

  const standings      = standingsData?.standings ?? [];
  const season         = standingsData?.season;
  const publishedTasks = (tasks ?? []).filter(t => t.status === 'published');

  // Fetch all task leaderboards in parallel
  const leaderboardQueries = useQueries({
    queries: publishedTasks.map(task => ({
      queryKey:  ['leaderboard', leagueSlug, seasonId, task.id],
      queryFn:   () => tasksApi.leaderboard(leagueSlug, seasonId, task.id),
      staleTime: 60 * 1000,
    })),
  });

  const activeTaskIdx = publishedTasks.findIndex(t => t.id === activeTab);
  const activeTask    = activeTaskIdx >= 0 ? publishedTasks[activeTaskIdx] : null;
  const activeQuery   = activeTaskIdx >= 0 ? leaderboardQueries[activeTaskIdx] : null;
  const activeEntries = activeQuery?.data?.entries ?? [];


  // Auto-select default entry when leaderboard loads
  const defaultEntry = activeEntries.find(e => e.pilotId === user?.id && e.submissionId)
    ?? activeEntries.find(e => e.submissionId) ?? null;
  const activeEntry = selectedEntry ?? defaultEntry;

  // Fetch track for selected pilot
  const { data: trackData, isFetching: trackLoading } = useQuery({
    queryKey: ['track', leagueSlug, seasonId, activeTask?.id, activeEntry?.submissionId],
    queryFn:  () => trackApi.get(leagueSlug, seasonId, activeTask!.id, activeEntry!.submissionId!),
    enabled:  !!activeTask && !!activeEntry?.submissionId,
    staleTime: 5 * 60 * 1000,
  });
  const track: ReplayFix[] | null = trackData?.fixes ?? null;

  // scoreMap: taskId → (pilotId → totalPoints) — for Overall tab
  const scoreMap = new Map<string, Map<string, number>>();
  publishedTasks.forEach((task, i) => {
    const byPilot = new Map<string, number>();
    for (const e of leaderboardQueries[i]?.data?.entries ?? []) {
      byPilot.set(e.pilotId, e.totalPoints);
    }
    scoreMap.set(task.id, byPilot);
  });

  const maxByTask: Record<string, number> = {};
  publishedTasks.forEach(task => {
    let max = 0;
    scoreMap.get(task.id)?.forEach(v => { if (v > max) max = v; });
    maxByTask[task.id] = max || 1;
  });

  const isLoading = tasksLoading || standingsLoading;

  return (
    <div className="fade-in" style={{ display: 'flex', height: '100%' }}>

      {/* ── Left scrollable column ── */}
      <div style={{
        flex: '0 0 520px',
        overflowY: 'auto',
        overflowX: 'auto',
        padding: '2rem',
        borderRight: '1px solid var(--border)',
        minWidth: 0,
      }}>
        {/* League header / switcher */}
        <div style={{ marginBottom: '1rem', maxWidth: 320 }}>
          <LeagueSwitcher />
          {leagueData?.league?.shortDescription && (
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>
              {leagueData.league.shortDescription}
            </div>
          )}
        </div>

        {/* Season subtitle */}
        {season && (
          <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: '1rem', marginTop: '-0.75rem', fontFamily: 'var(--font-mono)' }}>
            {season.name} · {standings.length} pilot{standings.length !== 1 ? 's' : ''} · {publishedTasks.length} task{publishedTasks.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Tab bar */}
        <TabBar
          publishedTasks={publishedTasks}
          activeTab={activeTab}
          onSelect={setActiveTab}
        />

        {/* Left content */}
        {isLoading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="shimmer" style={{ height: 42, borderRadius: 6, marginBottom: 6 }} />
            ))}
          </div>
        ) : activeTab === 'overall' ? (
          <StandingsMatrix
            standings={standings}
            tasks={publishedTasks}
            scoreMap={scoreMap}
            maxByTask={maxByTask}
            myId={user?.id}
          />
        ) : activeTask ? (
          <TaskLeftPanel
            task={activeTask}
            leaderboardEntries={activeEntries}
            leaderboardLoading={activeQuery?.isLoading ?? false}
            myId={user?.id}
            selectedPilotId={activeEntry?.pilotId}
            trackLoading={trackLoading}
            onSelectPilot={setSelectedEntry}
          />
        ) : null}
      </div>

      {/* ── Right sticky column — full viewport height ── */}
      <div style={{
        flex: '1 1 0',
        position: 'sticky',
        top: 0,
        height: '100vh',
        overflow: 'hidden',
      }}>
        {activeTab === 'overall' ? (
          <div style={{
            height: '100%',
            overflowY: 'auto',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}>
            {leagueData?.league?.fullDescription && (
              <div className="prose" style={{
                padding: '16px 20px',
                background: 'var(--bg2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.75,
                color: 'var(--text2)',
              }}>
                <ReactMarkdown>{leagueData.league.fullDescription}</ReactMarkdown>
              </div>
            )}
            <div style={{
              padding: '16px 20px',
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--text3)',
                fontFamily: 'var(--font-mono)', marginBottom: 14,
              }}>
                How Scoring Works
              </div>
              <ScoringExplainer />
            </div>
          </div>
        ) : activeTask ? (
          <TaskMap turnpoints={activeTask.turnpoints} height="100%" track={track} />
        ) : null}
      </div>

    </div>
  );
}
