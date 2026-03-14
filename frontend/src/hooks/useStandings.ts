import { useQuery } from '@tanstack/react-query';
import { standingsApi } from '../api/standings';
import { useLeague } from './useLeague';

export function useStandings() {
  const { leagueSlug, seasonId } = useLeague();
  return useQuery({
    queryKey: ['standings', leagueSlug, seasonId],
    queryFn:  () => standingsApi.get(leagueSlug, seasonId),
    staleTime: 60 * 1000, // standings change less often than leaderboard
  });
}

export function useSeasons() {
  const { leagueSlug } = useLeague();
  return useQuery({
    queryKey: ['seasons', leagueSlug],
    queryFn:  () => standingsApi.seasons(leagueSlug),
    select:   res => res.seasons,
    staleTime: 10 * 60 * 1000,
  });
}
