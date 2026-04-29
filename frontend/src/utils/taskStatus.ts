import type { Task } from '../api/tasks';

export type TaskStatus = 'OPEN' | 'UPCOMING' | 'CLOSED' | 'DRAFT';

export function getTaskStatus(task: Task): TaskStatus {
  if (task.status === 'draft') return 'DRAFT';
  const now = Date.now();
  // Match server semantics: the upload handler rejects with `now > close_date`,
  // so the task is still considered open at the exact close timestamp. Using
  // `>` here (not `>=`) keeps the UI badge in lockstep with the server gate.
  if (now > new Date(task.closeDate).getTime()) return 'CLOSED';
  if (now >= new Date(task.openDate).getTime()) return 'OPEN';
  return 'UPCOMING';
}

export const STATUS_STYLE: Record<TaskStatus, { background: string; color: string; border: string }> = {
  OPEN: { background: 'rgba(93,184,122,0.15)', color: '#5db87a', border: 'rgba(93,184,122,0.3)' },
  UPCOMING: { background: 'rgba(74,158,255,0.12)', color: '#4a9eff', border: 'rgba(74,158,255,0.25)' },
  CLOSED: { background: 'rgba(232,168,66,0.12)', color: '#e8a842', border: 'rgba(232,168,66,0.25)' },
  DRAFT: { background: 'var(--bg3)', color: 'var(--text3)', border: 'var(--border)' },
};
