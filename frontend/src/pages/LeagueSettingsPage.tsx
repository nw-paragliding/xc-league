// =============================================================================
// League Settings Page — tabbed admin panel for a league
//
// Tabs:
//   Settings  — league details + member management
//   Seasons   — create / edit / open / close seasons
//   Tasks     — create / edit / publish / freeze tasks per season
// =============================================================================

import { useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leagueApi, type LeagueMember, type UpdateLeagueInput, type Season, type CreateSeasonInput, type Task, type CreateTaskInput } from '../api/leagues';
import { useLeague } from '../hooks/useLeague';
import TaskImportModal from '../components/TaskImportModal';
import TaskExportModal from '../components/TaskExportModal';

type Tab = 'settings' | 'seasons' | 'tasks';

// ─────────────────────────────────────────────────────────────────────────────
// Root page with tab shell
// ─────────────────────────────────────────────────────────────────────────────

export default function LeagueSettingsPage() {
  const [tab, setTab] = useState<Tab>('settings');

  const tabStyle = (id: Tab): React.CSSProperties => ({
    padding: '0.625rem 1.25rem',
    border: 'none',
    borderBottom: `2px solid ${tab === id ? 'var(--primary)' : 'transparent'}`,
    background: 'none',
    color: tab === id ? 'var(--primary)' : 'var(--text2)',
    cursor: 'pointer',
    fontSize: '0.9375rem',
    fontWeight: tab === id ? 600 : 400,
  });

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.25rem' }}>
          League Admin
        </h1>
        <p style={{ color: 'var(--text2)' }}>
          Manage settings, seasons, and tasks for this league
        </p>
      </header>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '2rem' }}>
        <button style={tabStyle('settings')} onClick={() => setTab('settings')}>Settings</button>
        <button style={tabStyle('seasons')} onClick={() => setTab('seasons')}>Seasons</button>
        <button style={tabStyle('tasks')} onClick={() => setTab('tasks')}>Tasks</button>
      </div>

      {tab === 'settings' && <SettingsTab />}
      {tab === 'seasons' && <SeasonsTab />}
      {tab === 'tasks' && <TasksTab />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab — league details + member management
// ─────────────────────────────────────────────────────────────────────────────

function SettingsTab() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [selectedMember, setSelectedMember] = useState<LeagueMember | null>(null);
  const [action, setAction] = useState<'promote' | 'demote' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditingDetails, setIsEditingDetails] = useState(false);

  const { data: leagueData } = useQuery({
    queryKey: ['leagues', leagueSlug],
    queryFn: async () => {
      const response = await fetch(`/api/v1/leagues/${leagueSlug}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch league');
      return response.json();
    },
  });

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['leagues', leagueSlug, 'members'],
    queryFn: () => leagueApi.listMembers(leagueSlug),
  });

  const updateLeagueMutation = useMutation({
    mutationFn: (input: UpdateLeagueInput) => leagueApi.update(leagueSlug, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug] });
      setIsEditingDetails(false);
      setError(null);
    },
    onError: (err: any) => setError(err.message || 'Failed to update league'),
  });

  const promoteMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.promoteMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null); setAction(null); setError(null);
    },
    onError: (err: any) => setError(err.message || 'Failed to promote member'),
  });

  const demoteMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.demoteMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null); setAction(null); setError(null);
    },
    onError: (err: any) => setError(err.message || 'Failed to demote member'),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.removeMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null); setAction(null); setError(null);
    },
    onError: (err: any) => setError(err.message || 'Failed to remove member'),
  });

  const handleAction = () => {
    if (!selectedMember) return;
    if (action === 'promote') promoteMutation.mutate(selectedMember.userId);
    if (action === 'demote')  demoteMutation.mutate(selectedMember.userId);
    if (action === 'remove')  removeMutation.mutate(selectedMember.userId);
  };

  if (isLoading) return <div className="shimmer" style={{ width: '100%', height: 400 }} />;

  if (queryError) {
    return (
      <div style={{ padding: '1rem', background: '#fee', border: '1px solid #fcc', borderRadius: 8, color: '#c00' }}>
        Error loading members: {queryError.message}
      </div>
    );
  }

  const members = data?.members || [];
  const admins = members.filter(m => m.role === 'admin');
  const pilots = members.filter(m => m.role === 'pilot');

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* League Details */}
      <section style={{ marginBottom: '3rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>League Details</h2>
          {!isEditingDetails && (
            <button
              onClick={() => setIsEditingDetails(true)}
              style={secondaryBtn}
            >
              Edit Details
            </button>
          )}
        </div>

        {isEditingDetails ? (
          <LeagueDetailsForm
            league={leagueData?.league}
            onSubmit={(input) => updateLeagueMutation.mutate(input)}
            onCancel={() => setIsEditingDetails(false)}
            isSubmitting={updateLeagueMutation.isPending}
          />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1.5rem', background: 'var(--bg2)' }}>
            <DetailRow label="League Name" value={leagueData?.league?.name || leagueSlug} />
            <DetailRow label="URL Slug" value={leagueData?.league?.slug || leagueSlug} mono />
            {leagueData?.league?.description && (
              <DetailRow label="Description" value={leagueData.league.description} />
            )}
            {leagueData?.league?.logoUrl && (
              <DetailRow label="Logo URL" value={leagueData.league.logoUrl} mono />
            )}
          </div>
        )}
      </section>

      {/* Admins */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Administrators ({admins.length})
        </h2>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {admins.length === 0 ? (
            <EmptyState message="No administrators" />
          ) : (
            admins.map((member, i) => (
              <MemberRow
                key={member.id}
                member={member}
                isLast={i === admins.length - 1}
                background="var(--bg2)"
                actions={
                  <>
                    <button style={secondaryBtn} onClick={() => { setSelectedMember(member); setAction('demote'); }}>Demote</button>
                    <button style={dangerBtn}    onClick={() => { setSelectedMember(member); setAction('remove'); }}>Remove</button>
                  </>
                }
              />
            ))
          )}
        </div>
      </section>

      {/* Members */}
      <section>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Members ({pilots.length})
        </h2>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {pilots.length === 0 ? (
            <EmptyState message="No members yet" />
          ) : (
            pilots.map((member, i) => (
              <MemberRow
                key={member.id}
                member={member}
                isLast={i === pilots.length - 1}
                actions={
                  <>
                    <button style={primaryBtn}   onClick={() => { setSelectedMember(member); setAction('promote'); }}>Promote to Admin</button>
                    <button style={secondaryBtn} onClick={() => { setSelectedMember(member); setAction('remove'); }}>Remove</button>
                  </>
                }
              />
            ))
          )}
        </div>
      </section>

      {/* Confirmation dialog */}
      {selectedMember && action && (
        <ConfirmDialog
          title={
            action === 'promote' ? `Promote ${selectedMember.displayName}?` :
            action === 'demote'  ? `Demote ${selectedMember.displayName}?`  :
                                   `Remove ${selectedMember.displayName}?`
          }
          body={
            action === 'promote' ? 'This user will be able to manage league members and settings.' :
            action === 'demote'  ? 'This user will no longer have admin privileges for this league.' :
                                   'This user will be removed from the league and lose access to all league data.'
          }
          danger={action === 'remove'}
          onCancel={() => { setSelectedMember(null); setAction(null); }}
          onConfirm={handleAction}
          isPending={promoteMutation.isPending || demoteMutation.isPending || removeMutation.isPending}
          confirmLabel={action === 'promote' ? 'Promote' : action === 'demote' ? 'Demote' : 'Remove'}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seasons tab
// ─────────────────────────────────────────────────────────────────────────────

function SeasonsTab() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingSeason, setEditingSeason] = useState<Season | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
  });

  const inv = () => queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });

  const createMutation = useMutation({
    mutationFn: (input: CreateSeasonInput) => leagueApi.createSeason(leagueSlug, input),
    onSuccess: () => { inv(); setIsCreating(false); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to create season'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ seasonId, input }: { seasonId: string; input: any }) =>
      leagueApi.updateSeason(leagueSlug, seasonId, input),
    onSuccess: () => { inv(); setEditingSeason(null); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to update season'),
  });

  const deleteMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.deleteSeason(leagueSlug, seasonId),
    onSuccess: () => { inv(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to delete season'),
  });

  const openMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.openSeason(leagueSlug, seasonId),
    onSuccess: () => { inv(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to open season'),
  });

  const closeMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.closeSeason(leagueSlug, seasonId),
    onSuccess: () => { inv(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to close season'),
  });

  if (isLoading) return <div className="shimmer" style={{ width: '100%', height: 400 }} />;

  if (queryError) {
    return (
      <div style={{ padding: '1rem', background: '#fee', border: '1px solid #fcc', borderRadius: 8, color: '#c00' }}>
        Error loading seasons: {queryError.message}
      </div>
    );
  }

  const seasons = data?.seasons || [];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Seasons</h2>
        <button onClick={() => setIsCreating(true)} style={primaryBtn}>+ New Season</button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {isCreating && (
        <SeasonForm
          onSubmit={(input) => createMutation.mutate(input)}
          onCancel={() => setIsCreating(false)}
          isSubmitting={createMutation.isPending}
        />
      )}

      {editingSeason && (
        <SeasonForm
          season={editingSeason}
          onSubmit={(input) => updateMutation.mutate({ seasonId: editingSeason.id, input })}
          onCancel={() => setEditingSeason(null)}
          isSubmitting={updateMutation.isPending}
        />
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {seasons.length === 0 ? (
          <EmptyState message="No seasons yet. Create your first season to get started." />
        ) : (
          seasons.map((season, i) => (
            <div
              key={season.id}
              style={{
                padding: '1.5rem',
                borderBottom: i < seasons.length - 1 ? '1px solid var(--border)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>{season.name}</span>
                  <StatusBadge status={season.status} />
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.25rem' }}>
                  {season.competitionType === 'XC' ? 'Cross Country' : 'Hike & Fly'}
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                  {new Date(season.startDate).toLocaleDateString()} – {new Date(season.endDate).toLocaleDateString()}
                </div>
                {season.taskCount !== undefined && (
                  <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                    {season.taskCount} task{season.taskCount !== 1 ? 's' : ''} &bull; {season.registeredPilotCount || 0} pilot{season.registeredPilotCount !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {season.status === 'draft' && (
                  <button
                    onClick={() => { if (confirm(`Open season "${season.name}"? Pilots will be able to register and view tasks.`)) openMutation.mutate(season.id); }}
                    disabled={openMutation.isPending}
                    style={{ padding: '0.5rem 1rem', border: '1px solid #86efac', borderRadius: 4, background: '#d1fae5', color: '#065f46', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}
                  >
                    Open Season
                  </button>
                )}
                {season.status === 'open' && (
                  <button
                    onClick={() => { if (confirm(`Close season "${season.name}"? This cannot be undone.`)) closeMutation.mutate(season.id); }}
                    disabled={closeMutation.isPending}
                    style={{ padding: '0.5rem 1rem', border: '1px solid #fca5a5', borderRadius: 4, background: '#fee', color: '#991b1b', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}
                  >
                    Close Season
                  </button>
                )}
                {season.status !== 'closed' && (
                  <button onClick={() => setEditingSeason(season)} disabled={updateMutation.isPending} style={secondaryBtn}>
                    Edit
                  </button>
                )}
                {season.status === 'draft' && (
                  <button
                    onClick={() => { if (confirm(`Delete season "${season.name}"? This cannot be undone.`)) deleteMutation.mutate(season.id); }}
                    disabled={deleteMutation.isPending}
                    style={{ padding: '0.5rem 1rem', border: '1px solid #fcc', borderRadius: 4, background: 'var(--bg1)', color: '#c00', cursor: 'pointer', fontSize: '0.875rem' }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks tab
// ─────────────────────────────────────────────────────────────────────────────

function TasksTab() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [exportingTask, setExportingTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drag-to-reorder state
  const [localTasks, setLocalTasks] = useState<Task[] | null>(null);
  const [dropIndicator, setDropIndicator] = useState<number | null>(null); // index to show line above
  const dragIndex = useRef<number | null>(null);

  const { data: seasonsData, isLoading: seasonsLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
  });

  const { data: tasksData, isLoading: tasksLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'],
    queryFn: () => leagueApi.listTasks(leagueSlug, selectedSeasonId!),
    enabled: !!selectedSeasonId,
  });

  const invTasks = () => queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'] });

  const createMutation = useMutation({
    mutationFn: (input: CreateTaskInput) => leagueApi.createTask(leagueSlug, selectedSeasonId!, input),
    onSuccess: () => { invTasks(); setIsCreating(false); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to create task'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: any }) =>
      leagueApi.updateTask(leagueSlug, selectedSeasonId!, taskId, input),
    onSuccess: () => { invTasks(); setEditingTask(null); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to update task'),
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.deleteTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => { invTasks(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to delete task'),
  });

  const freezeMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.freezeTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => { invTasks(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to freeze task'),
  });

  const publishMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.publishTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => { invTasks(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to publish task'),
  });

  const unpublishMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.unpublishTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => { invTasks(); setError(null); },
    onError: (err: any) => setError(err.message || 'Failed to unpublish task'),
  });

  const reorderMutation = useMutation({
    mutationFn: (order: { id: string; sortOrder: number }[]) =>
      leagueApi.reorderTasks(leagueSlug, selectedSeasonId!, order),
    onSuccess: () => invTasks(),
    onError: (err: any) => setError(err.message || 'Failed to reorder tasks'),
  });

  const seasons = seasonsData?.seasons || [];
  // Use localTasks (optimistic drag state) when available, fall back to server data
  const serverTasks = tasksData?.tasks || [];
  const tasks = localTasks ?? serverTasks;

  // Reset localTasks when server data refreshes (after a save)
  const prevTasksRef = useRef<Task[] | undefined>(undefined);
  if (tasksData?.tasks !== prevTasksRef.current) {
    prevTasksRef.current = tasksData?.tasks;
    if (localTasks !== null) setLocalTasks(null);
  }

  const handleDragStart = useCallback((index: number) => {
    dragIndex.current = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    // Only update a single integer — no array mutation during drag, which would
    // re-render and kill the browser's native drag state.
    setDropIndicator(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex.current;
    const to = dropIndicator;
    setDropIndicator(null);
    dragIndex.current = null;

    if (from === null || to === null || from === to) return;

    const list = [...(localTasks ?? serverTasks)];
    const [moved] = list.splice(from, 1);
    // Insert before `to` (adjusted for the splice)
    const insertAt = from < to ? to - 1 : to;
    list.splice(insertAt, 0, moved);

    setLocalTasks(list);
    reorderMutation.mutate(list.map((t, i) => ({ id: t.id, sortOrder: i })));
  }, [dropIndicator, localTasks, serverTasks, reorderMutation]);

  const handleDragEnd = useCallback(() => {
    dragIndex.current = null;
    setDropIndicator(null);
  }, []);
  const selectedSeason = seasons.find(s => s.id === selectedSeasonId);

  if (seasonsLoading) return <div className="shimmer" style={{ width: '100%', height: 400 }} />;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Season selector */}
      <div style={{ marginBottom: '2rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Season</label>
        {seasons.length === 0 ? (
          <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text2)', fontSize: '0.875rem' }}>
            No seasons available. Create a season in the Seasons tab first.
          </div>
        ) : (
          <select
            value={selectedSeasonId || ''}
            onChange={(e) => setSelectedSeasonId(e.target.value || null)}
            style={{ width: '100%', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 4, fontSize: '1rem', background: 'var(--bg1)', color: 'var(--text1)' }}
          >
            <option value="">-- Select a season --</option>
            {seasons.map(season => (
              <option key={season.id} value={season.id}>
                {season.name} ({new Date(season.startDate).getFullYear()})
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedSeasonId && (
        <>
          <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
              Tasks — {selectedSeason?.name}
            </h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setIsImporting(true)} style={secondaryBtn}>↑ Import</button>
              <button onClick={() => setIsCreating(true)} style={primaryBtn}>+ New Task</button>
            </div>
          </div>

          {isImporting && (
            <TaskImportModal
              leagueSlug={leagueSlug}
              seasonId={selectedSeasonId}
              onSuccess={() => { setIsImporting(false); invTasks(); }}
              onClose={() => setIsImporting(false)}
            />
          )}

          {isCreating && (
            <TaskForm
              onSubmit={(input) => createMutation.mutate(input)}
              onCancel={() => setIsCreating(false)}
              isSubmitting={createMutation.isPending}
            />
          )}

          {editingTask && (
            <TaskForm
              task={editingTask}
              onSubmit={(input) => updateMutation.mutate({ taskId: editingTask.id, input })}
              onCancel={() => setEditingTask(null)}
              isSubmitting={updateMutation.isPending}
            />
          )}

          {tasksLoading ? (
            <div className="shimmer" style={{ width: '100%', height: 200 }} />
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {tasks.length === 0 ? (
                <EmptyState message="No tasks yet. Create your first task to get started." />
              ) : (
                tasks.map((task, i) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    style={{
                      padding: '1.5rem',
                      borderTop: dropIndicator === i && dragIndex.current !== i
                        ? '2px solid var(--primary)' : '2px solid transparent',
                      borderBottom: i < tasks.length - 1 ? '1px solid var(--border)' : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: task.scoresFrozenAt ? 'var(--bg2)' : 'transparent',
                      cursor: 'grab',
                      userSelect: 'none',
                    }}
                  >
                    {/* Drag handle */}
                    <div style={{
                      flexShrink: 0, marginRight: 12,
                      color: 'var(--text3)', fontSize: 16, lineHeight: 1,
                      cursor: 'grab', display: 'flex', flexDirection: 'column', gap: 3,
                    }}>
                      <div style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 1 }} />
                      <div style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 1 }} />
                      <div style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 1 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>{task.name}</span>
                        <TaskStatusBadge task={task} />
                      </div>
                      {task.description && (
                        <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.5rem' }}>{task.description}</div>
                      )}
                      <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                        {task.taskType === 'RACE_TO_GOAL' ? 'Race to Goal' : 'Open Distance'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                        {new Date(task.openDate).toLocaleString()} – {new Date(task.closeDate).toLocaleString()}
                      </div>
                      {(task.pilotCount !== undefined || task.optimisedDistanceKm) && (
                        <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                          {task.pilotCount || 0} submission{task.pilotCount !== 1 ? 's' : ''}
                          {task.optimisedDistanceKm && ` \u2022 ${task.optimisedDistanceKm.toFixed(2)} km optimal`}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {!task.scoresFrozenAt && task.status !== 'published' && (
                        <button
                          onClick={() => { if (confirm(`Publish "${task.name}"? Pilots will be able to see this task.`)) publishMutation.mutate(task.id); }}
                          disabled={publishMutation.isPending}
                          style={{ padding: '0.5rem 1rem', border: '1px solid #86efac', borderRadius: 4, background: '#dcfce7', color: '#166534', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}
                        >
                          Publish
                        </button>
                      )}
                      {!task.scoresFrozenAt && task.status === 'published' && (task.pilotCount ?? 0) === 0 && (
                        <button
                          onClick={() => { if (confirm(`Unpublish "${task.name}"? It will revert to draft.`)) unpublishMutation.mutate(task.id); }}
                          disabled={unpublishMutation.isPending}
                          style={secondaryBtn}
                        >
                          Unpublish
                        </button>
                      )}
                      {!task.scoresFrozenAt && task.status !== 'published' && (
                        <>
                          <button onClick={() => setEditingTask(task)} disabled={updateMutation.isPending} style={secondaryBtn}>
                            Edit
                          </button>
                          <button
                            onClick={() => { if (confirm(`Delete task "${task.name}"? This cannot be undone.`)) deleteMutation.mutate(task.id); }}
                            disabled={deleteMutation.isPending}
                            style={{ padding: '0.5rem 1rem', border: '1px solid #fcc', borderRadius: 4, background: 'var(--bg1)', color: '#c00', cursor: 'pointer', fontSize: '0.875rem' }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                      {!task.scoresFrozenAt && task.status === 'published' && (
                        <button
                          onClick={() => { if (confirm(`Freeze scores for "${task.name}"? This cannot be undone.`)) freezeMutation.mutate(task.id); }}
                          disabled={freezeMutation.isPending}
                          style={{ padding: '0.5rem 1rem', border: '1px solid #bae6fd', borderRadius: 4, background: '#e0f2fe', color: '#0369a1', cursor: 'pointer', fontSize: '0.875rem' }}
                        >
                          Freeze
                        </button>
                      )}
                      {task.scoresFrozenAt && (
                        <div style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', color: 'var(--text2)' }}>
                          Frozen {new Date(task.scoresFrozenAt).toLocaleDateString()}
                        </div>
                      )}
                      {task.status === 'published' && (
                        <button onClick={() => setExportingTask(task)} style={{ ...secondaryBtn, background: 'var(--bg2)' }}>
                          Export / QR
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {exportingTask && selectedSeasonId && (
            <TaskExportModal
              task={exportingTask}
              leagueSlug={leagueSlug}
              seasonId={selectedSeasonId}
              onClose={() => setExportingTask(null)}
            />
          )}
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Forms
// ─────────────────────────────────────────────────────────────────────────────

interface SeasonFormProps {
  season?: Season;
  onSubmit: (input: CreateSeasonInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

function SeasonForm({ season, onSubmit, onCancel, isSubmitting }: SeasonFormProps) {
  const [name, setName] = useState(season?.name || '');
  const [competitionType, setCompetitionType] = useState<'XC' | 'HIKE_AND_FLY'>(season?.competitionType || 'XC');
  const [startDate, setStartDate] = useState(season?.startDate?.split('T')[0] || '');
  const [endDate, setEndDate] = useState(season?.endDate?.split('T')[0] || '');
  const [nominalDistanceKm, setNominalDistanceKm] = useState(season?.nominalDistanceKm?.toString() || '70');
  const [nominalTimeS, setNominalTimeS] = useState(season?.nominalTimeS?.toString() || '5400');
  const [nominalGoalRatio, setNominalGoalRatio] = useState(season?.nominalGoalRatio?.toString() || '0.3');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, competitionType, startDate, endDate, nominalDistanceKm: parseFloat(nominalDistanceKm), nominalTimeS: parseInt(nominalTimeS, 10), nominalGoalRatio: parseFloat(nominalGoalRatio) });
  };

  return (
    <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
        {season ? 'Edit Season' : 'Create New Season'}
      </h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Season Name *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Summer 2025" required style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Competition Type *</label>
            <select value={competitionType} onChange={(e) => setCompetitionType(e.target.value as 'XC' | 'HIKE_AND_FLY')} required style={inputStyle}>
              <option value="XC">Cross Country (XC)</option>
              <option value="HIKE_AND_FLY">Hike & Fly</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Start Date *</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>End Date *</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required style={inputStyle} />
          </div>
        </div>
        <details style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Advanced GAP Settings</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div>
              <label style={labelStyle}>Nominal Distance (km)</label>
              <input type="number" step="0.1" value={nominalDistanceKm} onChange={(e) => setNominalDistanceKm(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Nominal Time (seconds)</label>
              <input type="number" value={nominalTimeS} onChange={(e) => setNominalTimeS(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Nominal Goal Ratio</label>
              <input type="number" step="0.01" value={nominalGoalRatio} onChange={(e) => setNominalGoalRatio(e.target.value)} style={inputStyle} />
            </div>
          </div>
        </details>
        <FormActions
          onCancel={onCancel}
          isSubmitting={isSubmitting}
          disabled={!name || !startDate || !endDate}
          submitLabel={season ? 'Update Season' : 'Create Season'}
        />
      </form>
    </div>
  );
}

interface TaskFormProps {
  task?: Task;
  onSubmit: (input: CreateTaskInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

function TaskForm({ task, onSubmit, onCancel, isSubmitting }: TaskFormProps) {
  const [name, setName] = useState(task?.name || '');
  const [description, setDescription] = useState(task?.description || '');
  const [taskType, setTaskType] = useState<'RACE_TO_GOAL' | 'OPEN_DISTANCE'>(task?.taskType || 'RACE_TO_GOAL');
  const fmt = (iso?: string) => iso ? iso.slice(0, 16) : '';
  const [openDate, setOpenDate] = useState(fmt(task?.openDate));
  const [closeDate, setCloseDate] = useState(fmt(task?.closeDate));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description: description || undefined, taskType, openDate: openDate + ':00Z', closeDate: closeDate + ':00Z' });
  };

  return (
    <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
      <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>
        {task ? 'Edit Task' : 'Create New Task'}
      </h3>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <label style={labelStyle}>Task Name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Task 1: Mont Blanc to Chamonix" required style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional task description" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        <div>
          <label style={labelStyle}>Task Type *</label>
          <select value={taskType} onChange={(e) => setTaskType(e.target.value as 'RACE_TO_GOAL' | 'OPEN_DISTANCE')} required style={inputStyle}>
            <option value="RACE_TO_GOAL">Race to Goal</option>
            <option value="OPEN_DISTANCE">Open Distance</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Open Date & Time *</label>
            <input type="datetime-local" value={openDate} onChange={(e) => setOpenDate(e.target.value)} required style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Close Date & Time *</label>
            <input type="datetime-local" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} required style={inputStyle} />
          </div>
        </div>
        <FormActions
          onCancel={onCancel}
          isSubmitting={isSubmitting}
          disabled={!name || !openDate || !closeDate}
          submitLabel={task ? 'Update Task' : 'Create Task'}
        />
      </form>
    </div>
  );
}

interface LeagueDetailsFormProps {
  league: any;
  onSubmit: (input: UpdateLeagueInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

function LeagueDetailsForm({ league, onSubmit, onCancel, isSubmitting }: LeagueDetailsFormProps) {
  const [name, setName] = useState(league?.name || '');
  const [slug, setSlug] = useState(league?.slug || '');
  const [description, setDescription] = useState(league?.description || '');
  const [logoUrl, setLogoUrl] = useState(league?.logoUrl || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const input: UpdateLeagueInput = {};
    if (name !== league?.name)                        input.name = name;
    if (slug !== league?.slug)                        input.slug = slug;
    if (description !== (league?.description ?? ''))  input.description = description;
    if (logoUrl !== (league?.logoUrl ?? ''))          input.logoUrl = logoUrl;
    onSubmit(input);
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1.5rem', background: 'var(--bg2)' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <label style={labelStyle}>League Name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>URL Slug *</label>
          <input type="text" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} pattern="[a-z0-9-]+" required style={{ ...inputStyle, fontFamily: 'monospace' }} />
          <div style={{ fontSize: '0.75rem', color: 'var(--text2)', marginTop: '0.25rem' }}>Lowercase letters, numbers, and hyphens only</div>
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        <div>
          <label style={labelStyle}>Logo URL</label>
          <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://example.com/logo.png" style={{ ...inputStyle, fontFamily: 'monospace' }} />
        </div>
        <FormActions
          onCancel={onCancel}
          isSubmitting={isSubmitting}
          disabled={!name || !slug}
          submitLabel="Save Changes"
        />
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared components
// ─────────────────────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: '#fee', border: '1px solid #fcc', borderRadius: 6, color: '#c00', fontSize: '0.875rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span>{message}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: '#c00', cursor: 'pointer', fontSize: '1.25rem', padding: 0, lineHeight: 1 }}>×</button>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text2)' }}>{message}</div>;
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ fontWeight: 500, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

function MemberRow({ member, isLast, background, actions }: { member: LeagueMember; isLast: boolean; background?: string; actions: React.ReactNode }) {
  return (
    <div style={{ padding: '1rem', borderBottom: isLast ? 'none' : '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: background }}>
      <div>
        <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{member.displayName}</div>
        <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>{member.email}</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '0.25rem' }}>
          Joined {new Date(member.joinedAt).toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>{actions}</div>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const styles: Record<string, React.CSSProperties> = {
    draft:  { background: '#e0e0e0', color: '#666' },
    open:   { background: '#d1fae5', color: '#065f46' },
    closed: { background: '#fee',    color: '#991b1b' },
  };
  return (
    <span style={{ padding: '0.25rem 0.5rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500, ...styles[status] }}>
      {status.toUpperCase()}
    </span>
  );
}

function TaskStatusBadge({ task }: { task: Task }) {
  return (
    <>
      {task.status === 'published' ? (
        <span style={{ padding: '0.125rem 0.5rem', background: '#dcfce7', color: '#166534', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600 }}>PUBLISHED</span>
      ) : (
        <span style={{ padding: '0.125rem 0.5rem', background: '#f3f4f6', color: '#6b7280', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600 }}>DRAFT</span>
      )}
      {task.scoresFrozenAt && (
        <span style={{ padding: '0.125rem 0.5rem', background: '#e0f2fe', color: '#0369a1', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500 }}>FROZEN</span>
      )}
    </>
  );
}

function ConfirmDialog({ title, body, danger, onCancel, onConfirm, isPending, confirmLabel }: {
  title: string; body: string; danger?: boolean;
  onCancel: () => void; onConfirm: () => void;
  isPending: boolean; confirmLabel: string;
}) {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg1)', padding: '2rem', borderRadius: 8, maxWidth: 400, width: '90%' }}>
        <h3 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>{title}</h3>
        <p style={{ marginBottom: '1.5rem', color: 'var(--text2)' }}>{body}</p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '0.5rem 1rem', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text)', cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            style={{ padding: '0.5rem 1rem', border: 'none', borderRadius: 4, background: danger ? 'var(--danger, #dc2626)' : 'var(--primary)', color: 'white', cursor: 'pointer' }}
          >
            {isPending ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormActions({ onCancel, isSubmitting, disabled, submitLabel }: { onCancel: () => void; isSubmitting: boolean; disabled: boolean; submitLabel: string }) {
  const isDisabled = isSubmitting || disabled;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
      <button type="button" onClick={onCancel} disabled={isSubmitting} style={secondaryBtn}>Cancel</button>
      <button
        type="submit"
        disabled={isDisabled}
        style={{ padding: '0.5rem 1rem', border: 'none', borderRadius: 4, background: isDisabled ? 'var(--border)' : 'var(--primary)', color: 'white', cursor: isDisabled ? 'not-allowed' : 'pointer', fontSize: '0.875rem', fontWeight: 500 }}
      >
        {isSubmitting ? 'Saving...' : submitLabel}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared style objects
// ─────────────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.5rem',
  fontWeight: 500,
  fontSize: '0.875rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: '0.875rem',
  background: 'var(--bg1)',
  color: 'var(--text1)',
};

const primaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem',
  border: 'none',
  borderRadius: 4,
  background: 'var(--primary)',
  color: 'white',
  cursor: 'pointer',
  fontSize: '0.875rem',
  fontWeight: 500,
};

const secondaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg1)',
  color: 'var(--text1)',
  cursor: 'pointer',
  fontSize: '0.875rem',
};

const dangerBtn: React.CSSProperties = {
  padding: '0.5rem 1rem',
  border: '1px solid var(--danger, #dc2626)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--danger, #dc2626)',
  cursor: 'pointer',
  fontSize: '0.875rem',
};
