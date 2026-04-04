import { api } from './client';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  windRating: string | null;
  gliderManufacturer: string | null;
  gliderModel: string | null;
  gliderWeightRating: number | null;
}

export interface MeResponse {
  user: User;
}

export interface UpdateMeBody {
  displayName?: string;
  avatarUrl?: string | null;
  windRating?: string | null;
  gliderManufacturer?: string | null;
  gliderModel?: string | null;
  gliderWeightRating?: number | null;
}

// Redirect browser to Google consent screen.
// Server sets cookie on callback, then redirects to /?auth=success.
export function initiateGoogleLogin(): void {
  window.location.href = '/api/v1/auth/oauth/google';
}

export const authApi = {
  /** Get current authenticated user. Returns null on 401 (not logged in). */
  me: async (): Promise<User | null> => {
    try {
      const res = await api.get<MeResponse>('/auth/me');
      return res.user;
    } catch (err: any) {
      if (err?.status === 401) return null;
      throw err;
    }
  },

  updateMe: (body: UpdateMeBody) => api.patch<MeResponse>('/auth/me', body),

  logout: () => api.post<void>('/auth/logout'),

  /** Immediately invalidate all tokens for a user (own tokens if no userId). */
  revoke: (userId?: string) => api.post<void>('/auth/revoke', userId ? { userId } : {}),
};
