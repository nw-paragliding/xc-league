// =============================================================================
// HomePage — unified league home: standings matrix + per-task split view
// =============================================================================

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useSeasons } from '../hooks/useStandings';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { tasksApi } from '../api/tasks';
import { standingsApi } from '../api/standings';
import { trackApi } from '../api/track';
import type { League } from '../api/leagues';
import type { ReplayFix } from '../api/track';
import { getTaskStatus, STATUS_STYLE } from '../utils/taskStatus';
import { computeDistanceKm } from '../components/TaskMap';
import { toCylinder } from '../components/TaskMap';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
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
      overflowY: 'hidden',
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

function MobileViewToggle({ showMap, onToggle }: { showMap: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="mobile-view-toggle">
      <button
        className={`mobile-view-btn${!showMap ? ' active' : ''}`}
        onClick={() => onToggle(false)}
      >
        List
      </button>
      <button
        className={`mobile-view-btn${showMap ? ' active' : ''}`}
        onClick={() => onToggle(true)}
      >
        Map
      </button>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 16px',
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
        minHeight: 44,
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
  const [mobileShowMap, setMobileShowMap] = useState(false);

  const activeTab = searchParams.get('task') ?? 'overall';
  const setActiveTab = (tab: 'overall' | string) => {
    setSelectedEntry(null);
    setMobileShowMap(false);
    const season = searchParams.get('season');
    const next: Record<string, string> = {};
    if (season) next.season = season;
    if (tab !== 'overall') next.task = tab;
    setSearchParams(next, { replace: true });
  };

  const { user }                    = useAuth();
  const { leagueSlug, seasonId: contextSeasonId } = useLeague();
  const { data: seasons }           = useSeasons();

  // Use ?season= param if present, otherwise fall back to the active season from context
  const seasonId = searchParams.get('season') ?? contextSeasonId;

  const setSeasonId = (id: string) => {
    setSelectedEntry(null);
    setMobileShowMap(false);
    setSearchParams({ season: id }, { replace: true });
  };

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: ['tasks', leagueSlug, seasonId],
    queryFn:  () => tasksApi.list(leagueSlug, seasonId),
    select:   (res) => res.tasks,
    staleTime: 2 * 60 * 1000,
  });

  const { data: standingsData, isLoading: standingsLoading } = useQuery({
    queryKey: ['standings', leagueSlug, seasonId],
    queryFn:  () => standingsApi.get(leagueSlug, seasonId),
    staleTime: 60 * 1000,
  });

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

  const rightContent = activeTab === 'overall' ? (
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
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{leagueData.league.fullDescription}</ReactMarkdown>
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
  ) : null;

  return (
    <div className="fade-in home-layout">

      {/* ── Left scrollable column ── */}
      <div className="home-left">
        {/* League header / switcher — always visible */}
        <div style={{ marginBottom: '1rem', maxWidth: 320 }}>
          <LeagueSwitcher />
          {leagueData?.league?.shortDescription && (
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>
              {leagueData.league.shortDescription}
            </div>
          )}
        </div>

        {/* Season selector — always visible */}
        {seasons && seasons.length > 1 && (
          <div style={{ marginBottom: '0.75rem' }}>
            <select
              value={seasonId}
              onChange={e => setSeasonId(e.target.value)}
              style={{
                padding: '0.3rem 0.6rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                background: 'var(--bg2)',
                color: 'var(--text1)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {seasons.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Season subtitle — always visible */}
        {season && (
          <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: '1rem', marginTop: '-0.25rem', fontFamily: 'var(--font-mono)' }}>
            {standings.length} pilot{standings.length !== 1 ? 's' : ''} · {publishedTasks.length} task{publishedTasks.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Tab bar */}
        <TabBar
          publishedTasks={publishedTasks}
          activeTab={activeTab}
          onSelect={setActiveTab}
        />

        {/* Mobile List/Map toggle — only shown on mobile when a task is selected */}
        {activeTask && (
          <MobileViewToggle showMap={mobileShowMap} onToggle={setMobileShowMap} />
        )}

        {/* Left content — hidden on mobile when map is shown */}
        {!mobileShowMap && (
          isLoading ? (
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
          ) : null
        )}

        {/* Map — rendered inline on mobile when map view is active */}
        <div className={`home-map-mobile${mobileShowMap && activeTask ? '' : ' hidden'}`}>
          {activeTask && (
            <TaskMap turnpoints={activeTask.turnpoints} height="100%" track={track} />
          )}
        </div>
      </div>

      {/* ── Right column — desktop only (hidden on mobile via CSS) ── */}
      <div className="home-right">
        {rightContent}
      </div>

    </div>
  );
}
