// =============================================================================
// League API Client
// Functions for league creation and member management endpoints
// =============================================================================

import { api } from './client';

export interface League {
  id: string;
  name: string;
  slug: string;
  description?: string;
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
  name: string;
  slug: string;
  description?: string;
  logo_url?: string;
}

export interface UpdateLeagueInput {
  name?: string;
  slug?: string;
  description?: string;
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
  name: string;
  description?: string;
  taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  openDate: string;
  closeDate: string;
  optimisedDistanceKm?: number;
  isFrozen?: boolean;
  scoresFrozenAt?: string;
  createdAt: string;
  updatedAt?: string;
  pilotCount?: number;
  goalCount?: number;
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
}

export const leagueApi = {
  // ── League Management ──────────────────────────────────────────────────
  
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
  
  /** Freeze task scores (league admin only) */
  freezeTask: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/freeze`),
};
