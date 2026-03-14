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

export const leagueApi = {
  /** Create a new league (any authenticated user) */
  create: (data: CreateLeagueInput) =>
    api.post<{ league: League }>('/leagues', data),
  
  /** Join a league as a pilot */
  join: (leagueSlug: string) =>
    api.post<{ message: string }>(`/leagues/${leagueSlug}/join`),
  
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
};
