// =============================================================================
// Admin API Client
// Functions for super admin management endpoints
// =============================================================================

import { api } from './client';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  details?: string;
  createdAt: string;
  actorEmail: string;
  actorName: string;
  targetEmail: string;
  targetName: string;
}

export interface LeagueSummary {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string;
  createdAt: string;
}

export const adminApi = {
  /** List all users (super admin only) */
  listUsers: () => api.get<{ users: User[] }>('/admin/users'),

  /** List all leagues (super admin only) */
  listLeagues: () => api.get<{ leagues: LeagueSummary[] }>('/admin/leagues'),

  /** Soft-delete a league (super admin only) */
  deleteLeague: (leagueSlug: string) => api.delete<{ message: string }>(`/admin/leagues/${leagueSlug}`),

  /** Promote user to super admin */
  promoteToSuperAdmin: (userId: string) => api.post<{ message: string }>(`/admin/users/${userId}/promote`),

  /** Demote super admin to regular user */
  demoteFromSuperAdmin: (userId: string) => api.post<{ message: string }>(`/admin/users/${userId}/demote`),

  /** Get admin audit log */
  getAuditLog: (limit = 100, offset = 0) =>
    api.get<{ logs: AuditLogEntry[] }>('/admin/audit-log', { params: { limit, offset } }),
};
