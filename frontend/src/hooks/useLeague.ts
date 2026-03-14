/**
 * League context.
 *
 * At club scale there's typically one league and one active season.
 * These values come from the URL in a full router setup, but here we
 * expose them via a context so pages don't need to thread them as props.
 *
 * In production, replace the defaults with values parsed from the URL
 * using React Router's useParams(), or from a league-picker UI.
 */
import { createContext, useContext, type ReactNode } from 'react';

interface LeagueContextValue {
  leagueSlug: string;
  seasonId:   string;
}

const LeagueContext = createContext<LeagueContextValue>({
  leagueSlug: 'alps-xc-2025',
  seasonId:   'season-1',
});

export function LeagueProvider({
  leagueSlug,
  seasonId,
  children,
}: LeagueContextValue & { children: ReactNode }) {
  return (
    <LeagueContext.Provider value={{ leagueSlug, seasonId }}>
      {children}
    </LeagueContext.Provider>
  );
}

export function useLeague() {
  return useContext(LeagueContext);
}
