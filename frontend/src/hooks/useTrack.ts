import { useQuery } from '@tanstack/react-query';
import { trackApi } from '../api/track';
import { useLeague } from './useLeague';

export function useTrack(taskId: string | null, submissionId: string | null) {
  const { leagueSlug, seasonId } = useLeague();
  return useQuery({
    queryKey: ['track', leagueSlug, seasonId, taskId, submissionId],
    queryFn: () => trackApi.get(leagueSlug, seasonId, taskId!, submissionId!),
    enabled: taskId != null && submissionId != null,
    staleTime: Infinity, // track data never changes after processing
    gcTime: 5 * 60 * 1000, // keep in cache 5 min — replay data is large
  });
}
