import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type CreateTaskInput, leagueApi, type Task } from '../api/leagues';
import TaskExportModal from '../components/TaskExportModal';
import TaskImportModal from '../components/TaskImportModal';
import { useLeague } from '../hooks/useLeague';

export default function TaskManagementPage() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [exportingTask, setExportingTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch seasons
  const { data: seasonsData, isLoading: seasonsLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
  });

  // Fetch tasks for selected season
  const { data: tasksData, isLoading: tasksLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'],
    queryFn: () => leagueApi.listTasks(leagueSlug, selectedSeasonId!),
    enabled: !!selectedSeasonId,
  });

  const updateMutation = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: any }) =>
      leagueApi.updateTask(leagueSlug, selectedSeasonId!, taskId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'] });
      setEditingTask(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to update task');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.deleteTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to delete task');
    },
  });

  const publishMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.publishTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to publish task');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: (taskId: string) => leagueApi.unpublishTask(leagueSlug, selectedSeasonId!, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to unpublish task');
    },
  });

  const seasons = seasonsData?.seasons || [];
  const tasks = tasksData?.tasks || [];
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);

  if (seasonsLoading) {
    return (
      <div style={{ padding: '2rem' }}>
        <div className="shimmer" style={{ width: '100%', height: 400 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>Task Management</h1>
        <p style={{ color: 'var(--text2)' }}>Create and manage tasks for competition seasons</p>
      </header>

      {error && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 6,
            color: '#c00',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#c00',
              cursor: 'pointer',
              fontSize: '1.25rem',
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Season Selector */}
      <div style={{ marginBottom: '2rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Select Season</label>
        {seasons.length === 0 ? (
          <div
            style={{
              padding: '1rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg2)',
              color: 'var(--text2)',
              fontSize: '0.875rem',
            }}
          >
            No seasons available. Create a season first in Season Management.
          </div>
        ) : (
          <select
            value={selectedSeasonId || ''}
            onChange={(e) => setSelectedSeasonId(e.target.value || null)}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '1rem',
              background: 'var(--bg1)',
              color: 'var(--text1)',
            }}
          >
            <option value="">-- Select a season --</option>
            {seasons.map((season) => (
              <option key={season.id} value={season.id}>
                {season.name} ({new Date(season.startDate).getFullYear()})
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedSeasonId && (
        <>
          {/* Create Task Buttons */}
          <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Tasks for {selectedSeason?.name}</h2>
            <button
              onClick={() => setIsImporting(true)}
              style={{
                padding: '0.5rem 1rem',
                border: 'none',
                borderRadius: 4,
                background: 'var(--primary)',
                color: 'white',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              + New Task
            </button>
          </div>

          {/* Import Modal */}
          {isImporting && (
            <TaskImportModal
              leagueSlug={leagueSlug}
              seasonId={selectedSeasonId}
              onSuccess={() => {
                setIsImporting(false);
                queryClient.invalidateQueries({
                  queryKey: ['leagues', leagueSlug, 'seasons', selectedSeasonId, 'tasks'],
                });
              }}
              onClose={() => setIsImporting(false)}
            />
          )}

          {/* Edit Task Form */}
          {editingTask && (
            <TaskForm
              task={editingTask}
              onSubmit={(input) => updateMutation.mutate({ taskId: editingTask.id, input })}
              onCancel={() => setEditingTask(null)}
              isSubmitting={updateMutation.isPending}
            />
          )}

          {/* Tasks List */}
          {tasksLoading ? (
            <div className="shimmer" style={{ width: '100%', height: 200 }} />
          ) : (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              {tasks.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text2)' }}>
                  No tasks yet. Create your first task to get started.
                </div>
              ) : (
                tasks.map((task, i) => (
                  <div
                    key={task.id}
                    style={{
                      padding: '1.5rem',
                      borderBottom: i < tasks.length - 1 ? '1px solid var(--border)' : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: task.scoresFrozenAt ? 'var(--bg2)' : 'transparent',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          marginBottom: '0.5rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>{task.name}</span>
                        {/* Status badge */}
                        {task.status === 'published' ? (
                          <span
                            style={{
                              padding: '0.125rem 0.5rem',
                              background: '#dcfce7',
                              color: '#166534',
                              borderRadius: 4,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              letterSpacing: '0.05em',
                            }}
                          >
                            PUBLISHED
                          </span>
                        ) : (
                          <span
                            style={{
                              padding: '0.125rem 0.5rem',
                              background: '#f3f4f6',
                              color: '#6b7280',
                              borderRadius: 4,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              letterSpacing: '0.05em',
                            }}
                          >
                            DRAFT
                          </span>
                        )}
                        {task.scoresFrozenAt && (
                          <span
                            style={{
                              padding: '0.125rem 0.5rem',
                              background: '#e0f2fe',
                              color: '#0369a1',
                              borderRadius: 4,
                              fontSize: '0.75rem',
                              fontWeight: 500,
                            }}
                          >
                            FROZEN
                          </span>
                        )}
                      </div>
                      {task.description && (
                        <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.5rem' }}>
                          {task.description}
                        </div>
                      )}
                      <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                        Type: {task.taskType === 'RACE_TO_GOAL' ? 'Race to Goal' : 'Open Distance'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                        {new Date(task.openDate).toLocaleString()} - {new Date(task.closeDate).toLocaleString()}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                        {(task.turnpointCount ?? 0) > 0 ? (
                          `${task.turnpointCount} turnpoints`
                        ) : (
                          <span style={{ color: '#c00' }}>No turnpoints — import a task file to enable publishing</span>
                        )}
                        {(task.pilotCount ?? 0) > 0 &&
                          ` • ${task.pilotCount} submission${task.pilotCount !== 1 ? 's' : ''}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {/* Publish / Unpublish */}
                      {!task.scoresFrozenAt && task.status !== 'published' && (
                        <button
                          onClick={() => {
                            if (confirm(`Publish "${task.name}"? Pilots will be able to see this task.`)) {
                              publishMutation.mutate(task.id);
                            }
                          }}
                          disabled={publishMutation.isPending}
                          style={{
                            padding: '0.5rem 1rem',
                            border: '1px solid #86efac',
                            borderRadius: 4,
                            background: '#dcfce7',
                            color: '#166534',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                          }}
                        >
                          Publish
                        </button>
                      )}
                      {!task.scoresFrozenAt && task.status === 'published' && (task.pilotCount ?? 0) === 0 && (
                        <button
                          onClick={() => {
                            if (confirm(`Unpublish "${task.name}"? It will revert to draft.`)) {
                              unpublishMutation.mutate(task.id);
                            }
                          }}
                          disabled={unpublishMutation.isPending}
                          style={{
                            padding: '0.5rem 1rem',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            background: 'var(--bg1)',
                            color: 'var(--text2)',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                          }}
                        >
                          Unpublish
                        </button>
                      )}

                      {/* Edit & management buttons — only for draft tasks */}
                      {!task.scoresFrozenAt && task.status !== 'published' && (
                        <>
                          <button
                            onClick={() => setEditingTask(task)}
                            disabled={updateMutation.isPending}
                            style={{
                              padding: '0.5rem 1rem',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              background: 'var(--bg1)',
                              color: 'var(--text1)',
                              cursor: 'pointer',
                              fontSize: '0.875rem',
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Delete task "${task.name}"? This cannot be undone.`)) {
                                deleteMutation.mutate(task.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            style={{
                              padding: '0.5rem 1rem',
                              border: '1px solid #fcc',
                              borderRadius: 4,
                              background: 'var(--bg1)',
                              color: '#c00',
                              cursor: 'pointer',
                              fontSize: '0.875rem',
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}

                      {/* Export — available for published tasks */}
                      {task.status === 'published' && (
                        <button
                          onClick={() => setExportingTask(task)}
                          style={{
                            padding: '0.5rem 1rem',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            background: 'var(--bg2)',
                            color: 'var(--text1)',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                          }}
                        >
                          Export / QR
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Export Modal */}
          {exportingTask && selectedSeasonId && (
            <TaskExportModal task={exportingTask} leagueSlug={leagueSlug} onClose={() => setExportingTask(null)} />
          )}
        </>
      )}
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

  // Format datetime-local input values (YYYY-MM-DDTHH:mm)
  const formatDateTimeLocal = (isoString?: string) => {
    if (!isoString) return '';
    return isoString.slice(0, 16); // Takes YYYY-MM-DDTHH:mm from ISO string
  };

  const [openDate, setOpenDate] = useState(formatDateTimeLocal(task?.openDate) || '');
  const [closeDate, setCloseDate] = useState(formatDateTimeLocal(task?.closeDate) || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      description: description || undefined,
      taskType,
      openDate: openDate + ':00Z', // Add seconds and Z for ISO 8601
      closeDate: closeDate + ':00Z',
    });
  };

  return (
    <div
      style={{
        marginBottom: '2rem',
        padding: '1.5rem',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg2)',
      }}
    >
      <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>
        {task ? 'Edit Task' : 'Create New Task'}
      </h3>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
            Task Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Task 1: Mont Blanc to Chamonix"
            required
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '0.875rem',
              background: 'var(--bg1)',
              color: 'var(--text1)',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional task description"
            rows={3}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '0.875rem',
              background: 'var(--bg1)',
              color: 'var(--text1)',
              resize: 'vertical',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
            Task Type *
          </label>
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value as 'RACE_TO_GOAL' | 'OPEN_DISTANCE')}
            required
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '0.875rem',
              background: 'var(--bg1)',
              color: 'var(--text1)',
            }}
          >
            <option value="RACE_TO_GOAL">Race to Goal</option>
            <option value="OPEN_DISTANCE">Open Distance</option>
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              Open Date & Time *
            </label>
            <input
              type="datetime-local"
              value={openDate}
              onChange={(e) => setOpenDate(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)',
                colorScheme: 'dark',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              Close Date & Time *
            </label>
            <input
              type="datetime-local"
              value={closeDate}
              onChange={(e) => setCloseDate(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)',
                colorScheme: 'dark',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              padding: '0.5rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg1)',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !name || !openDate || !closeDate}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: 4,
              background: isSubmitting || !name || !openDate || !closeDate ? 'var(--border)' : 'var(--primary)',
              color: 'white',
              cursor: isSubmitting || !name || !openDate || !closeDate ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            {isSubmitting ? 'Saving...' : task ? 'Update Task' : 'Create Task'}
          </button>
        </div>
      </form>
    </div>
  );
}
