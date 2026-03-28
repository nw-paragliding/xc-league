// =============================================================================
// League API Client
// Functions for league creation and member management endpoints
// =============================================================================

import { api, apiFetch } from './client';

export interface League {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string;
  fullDescription?: string | null;
  logoUrl?: string;
  createdAt: string;
}

export interface LeagueMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'pilot' | 'admin';
  joinedAt: string;
}

export interface CreateLeagueInput {
  name:              string;
  slug:              string;
  shortDescription?: string;
  fullDescription?:  string;
  logo_url?:         string;
}

export interface UpdateLeagueInput {
  name?: string;
  slug?: string;
  shortDescription?: string;
  fullDescription?: string;
  logoUrl?: string;
}

export interface Season {
  id: string;
  name: string;
  competitionType: 'XC' | 'HIKE_AND_FLY';
  startDate: string;
  endDate: string;
  nominalDistanceKm: number;
  nominalTimeS: number;
  nominalGoalRatio: number;
  status?: 'draft' | 'open' | 'closed';
  createdAt: string;
  updatedAt?: string;
  taskCount?: number;
  registeredPilotCount?: number;
}

export interface CreateSeasonInput {
  name: string;
  competitionType: 'XC' | 'HIKE_AND_FLY';
  startDate: string;
  endDate: string;
  nominalDistanceKm?: number;
  nominalTimeS?: number;
  nominalGoalRatio?: number;
}

export interface UpdateSeasonInput {
  name?: string;
  competitionType?: 'XC' | 'HIKE_AND_FLY';
  startDate?: string;
  endDate?: string;
  nominalDistanceKm?: number;
  nominalTimeS?: number;
  nominalGoalRatio?: number;
}

export interface Task {
  id: string;
  seasonId: string;
  name: string;
  description?: string;
  taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  openDate: string;
  closeDate: string;
  isFrozen?: boolean;
  scoresFrozenAt?: string;
  taskValue?: number | null;
  status?: 'draft' | 'published';
  createdAt: string;
  updatedAt?: string;
  pilotCount?: number;
  goalCount?: number;
  turnpointCount?: number;
}

export interface CupPreviewTurnpoint {
  name:      string;
  latitude:  number;
  longitude: number;
  radius_m:  number;
  type:      string;
}

export interface CupPreviewTask {
  index:          number;
  name:           string;
  turnpointCount: number;
  turnpoints:     CupPreviewTurnpoint[];
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  openDate: string;
  closeDate: string;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  taskType?: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  openDate?: string;
  closeDate?: string;
  taskValue?: number | null;
}

export const leagueApi = {
  // ── League Management ──────────────────────────────────────────────────

  /** List all public leagues */
  list: () =>
    api.get<{ leagues: League[] }>('/leagues'),
  
  /** Create a new league (any authenticated user) */
  create: (data: CreateLeagueInput) =>
    api.post<{ league: League }>('/leagues', data),
  
  /** Update league details (league admin only) */
  update: (leagueSlug: string, data: UpdateLeagueInput) =>
    api.put<{ league: League }>(`/leagues/${leagueSlug}`, data),
  
  /** Join a league as a pilot */
  join: (leagueSlug: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/join`),
  
  // ── Member Management ──────────────────────────────────────────────────
  
  /** List all members of a league */
  listMembers: (leagueSlug: string) =>
    api.get<{ members: LeagueMember[] }>(`/leagues/${leagueSlug}/members`),
  
  /** Promote a member to admin (league admin only) */
  promoteMember: (leagueSlug: string, userId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/members/${userId}/promote`),
  
  /** Demote an admin to pilot (league admin only) */
  demoteMember: (leagueSlug: string, userId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/members/${userId}/demote`),
  
  /** Remove a member from the league (league admin only) */
  removeMember: (leagueSlug: string, userId: string) =>
    api.delete<{ message: string }>(`/leagues/${leagueSlug}/members/${userId}`),
  
  // ── Season Management ──────────────────────────────────────────────────
  
  /** List all seasons for a league */
  listSeasons: (leagueSlug: string) =>
    api.get<{ seasons: Season[] }>(`/leagues/${leagueSlug}/seasons`),
  
  /** Create a new season (league admin only) */
  createSeason: (leagueSlug: string, data: CreateSeasonInput) =>
    api.post<{ season: Season }>(`/leagues/${leagueSlug}/seasons`, data),
  
  /** Update a season (league admin only) */
  updateSeason: (leagueSlug: string, seasonId: string, data: UpdateSeasonInput) =>
    api.put<{ season: Season }>(`/leagues/${leagueSlug}/seasons/${seasonId}`, data),
  
  /** Delete a season (league admin only) */
  deleteSeason: (leagueSlug: string, seasonId: string) =>
    api.delete<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}`),
  
  /** Open a season (league admin only) */
  openSeason: (leagueSlug: string, seasonId: string) =>
    api.post<{ season: Season }>(`/leagues/${leagueSlug}/seasons/${seasonId}/open`),
  
  /** Close a season (league admin only) */
  closeSeason: (leagueSlug: string, seasonId: string) =>
    api.post<{ season: Season }>(`/leagues/${leagueSlug}/seasons/${seasonId}/close`),
  
  /** Register pilot for season */
  registerForSeason: (leagueSlug: string, seasonId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/register`),
  
  /** Get season registration status */
  getSeasonRegistration: (leagueSlug: string, seasonId: string) =>
    api.get<{ isRegistered: boolean; registrationCount: number }>(`/leagues/${leagueSlug}/seasons/${seasonId}/registration`),
  
  /** List pilots registered for season (admin only) */
  listSeasonRegistrations: (leagueSlug: string, seasonId: string) =>
    api.get<{ pilots: Array<{ userId: string; email: string; displayName: string; registeredAt: string }> }>(`/leagues/${leagueSlug}/seasons/${seasonId}/registrations`),
  
  // ── Task Management ────────────────────────────────────────────────────
  
  /** List all tasks for a season */
  listTasks: (leagueSlug: string, seasonId: string) =>
    api.get<{ tasks: Task[] }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks`),
  
  /** Create a new task (league admin only) */
  createTask: (leagueSlug: string, seasonId: string, data: CreateTaskInput) =>
    api.post<{ task: Task }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks`, data),
  
  /** Update a task (league admin only) */
  updateTask: (leagueSlug: string, seasonId: string, taskId: string, data: UpdateTaskInput) =>
    api.put<{ task: Task }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}`, data),
  
  /** Delete a task (league admin only) */
  deleteTask: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.delete<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}`),
  
  /** Publish task (league admin only) */
  publishTask: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/publish`),
  
  /** Unpublish task (league admin only) */
  unpublishTask: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/unpublish`),

  /** Reorder tasks (league admin only) */
  reorderTasks: (leagueSlug: string, seasonId: string, order: { id: string; sortOrder: number }[]) =>
    api.put<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/reorder`, { order }),

  /** Download task file (.xctsk or .cup). Returns a Blob for client-side download. */
  downloadTask: (leagueSlug: string, seasonId: string, taskId: string, format: 'xctsk' | 'cup'): Promise<Blob> =>
    fetch(`/api/v1/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/download?format=${format}`, {
      credentials: 'include',
    }).then(res => {
      if (!res.ok) throw new Error('Download failed');
      return res.blob();
    }),

  /** Get QR code image URL for task (returns a URL string to use in <img src>) */
  getTaskQrUrl: (leagueSlug: string, seasonId: string, taskId: string, app: 'xctrack' | 'download', format: 'xctsk' | 'cup' = 'xctsk'): string =>
    `/api/v1/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/qr?app=${app}&format=${format}`,

  /** Import task from a .xctsk or .cup file (league admin only) */
  importTask: (
    leagueSlug: string,
    seasonId: string,
    file: File,
    options?: { name?: string; openDate?: string; closeDate?: string },
  ): Promise<{ task: Task; turnpoints: Array<{ id: string; name: string; latitude: number; longitude: number; radiusM: number; type: string; sequenceIndex: number }> }> => {
    const form = new FormData();
    form.append('taskFile', file, file.name);

    const params = new URLSearchParams();
    if (options?.name)      params.set('name', options.name);
    if (options?.openDate)  params.set('openDate', options.openDate);
    if (options?.closeDate) params.set('closeDate', options.closeDate);
    const qs = params.toString() ? `?${params}` : '';

    return apiFetch(
      `/leagues/${leagueSlug}/seasons/${seasonId}/tasks/import${qs}`,
      { method: 'POST', body: form },
    );
  },

  /** Preview all tasks in a .cup file without creating anything */
  cupPreview: (
    leagueSlug: string,
    seasonId: string,
    file: File,
  ): Promise<{ tasks: CupPreviewTask[] }> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return apiFetch(
      `/leagues/${leagueSlug}/seasons/${seasonId}/tasks/cup-preview`,
      { method: 'POST', body: form },
    );
  },

  /** Bulk-create multiple tasks from a .cup file */
  bulkImport: (
    leagueSlug: string,
    seasonId: string,
    file: File,
    tasks: Array<{ index: number; name?: string; openDate?: string; closeDate?: string }>,
  ): Promise<{ created: number; taskIds: string[] }> => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('tasks', JSON.stringify(tasks));
    return apiFetch(
      `/leagues/${leagueSlug}/seasons/${seasonId}/tasks/bulk-import`,
      { method: 'POST', body: form },
    );
  },
};
