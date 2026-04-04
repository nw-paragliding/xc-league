import { useQuery } from '@tanstack/react-query';
import { tasksApi } from '../api/tasks';
import { useLeague } from './useLeague';

export function useTasks() {
  const { leagueSlug, seasonId } = useLeague();
  return useQuery({
    queryKey: ['tasks', leagueSlug, seasonId],
    queryFn: () => tasksApi.list(leagueSlug, seasonId),
    select: (res) => res.tasks,
    staleTime: 2 * 60 * 1000,
  });
}

export function useLeaderboard(taskId: string | null) {
  const { leagueSlug, seasonId } = useLeague();
  return useQuery({
    queryKey: ['leaderboard', leagueSlug, seasonId, taskId],
    queryFn: () => tasksApi.leaderboard(leagueSlug, seasonId, taskId!),
    enabled: taskId != null,
    staleTime: 30 * 1000, // 30s — rescore jobs run frequently while task open
  });
}

export function useMySubmissions(taskId: string | null) {
  const { leagueSlug, seasonId } = useLeague();
  return useQuery({
    queryKey: ['submissions', leagueSlug, seasonId, taskId],
    queryFn: () => submissionsApi.list(leagueSlug, seasonId, taskId!),
    enabled: taskId != null,
    select: (res) => res.submissions,
    staleTime: 10 * 1000,
  });
}

// Import here to avoid circular dependency
import { submissionsApi } from '../api/tasks';
