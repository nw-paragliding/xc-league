import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authApi, initiateGoogleLogin, type User } from '../api/auth';

export const AUTH_KEY = ['auth', 'me'] as const;

/**
 * Core auth hook. Returns current user and auth actions.
 *
 * On mount, checks for ?auth=success in the URL (set by the server after
 * the OAuth callback redirect). If present, strips it from the URL and
 * refetches the user — the HttpOnly cookie is already set at this point.
 */
export function useAuth() {
  const queryClient = useQueryClient();

  const { data: user, isLoading, isFetched } = useQuery({
    queryKey: AUTH_KEY,
    queryFn:  authApi.me,
    retry:    false,
    staleTime: 5 * 60 * 1000, // 5 min — re-check user occasionally
  });

  // Handle ?auth=success redirect from OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      // Clean up URL without triggering a reload
      const clean = window.location.pathname;
      window.history.replaceState({}, '', clean);
      // Invalidate user cache to force re-fetch with new cookie
      queryClient.invalidateQueries({ queryKey: AUTH_KEY });
    }
  }, [queryClient]);

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      // Clear all cached data on logout
      queryClient.clear();
    },
  });

  const updateMeMutation = useMutation({
    mutationFn: authApi.updateMe,
    onSuccess: (res) => {
      queryClient.setQueryData(AUTH_KEY, res.user);
    },
  });

  return {
    user:      user ?? null,
    isLoading,
    isFetched,
    isLoggedIn: user != null,
    login:      initiateGoogleLogin,
    logout:     () => logoutMutation.mutate(),
    updateMe:   updateMeMutation.mutate,
  };
}

// Re-export type for convenience
export type { User };
