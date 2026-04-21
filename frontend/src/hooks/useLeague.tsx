/**
 * League context.
 *
 * Reads leagueSlug from the URL via React Router's useParams(); falls back to
 * the context value set by LeagueProvider when no URL param is available.
 * Both fall back to empty strings when neither is present — callers that
 * construct URLs from these values should either be inside a LeagueProvider
 * or check for emptiness.
 *
 * URL structure: /leagues/:leagueSlug/...
 */
import { createContext, type ReactNode, useContext } from 'react';
import { useParams } from 'react-router-dom';

interface LeagueContextValue {
  leagueSlug: string;
  seasonId: string;
}

const LeagueContext = createContext<LeagueContextValue>({
  leagueSlug: '',
  seasonId: '',
});

export function LeagueProvider({ leagueSlug, seasonId, children }: LeagueContextValue & { children: ReactNode }) {
  return <LeagueContext.Provider value={{ leagueSlug, seasonId }}>{children}</LeagueContext.Provider>;
}

/**
 * Returns the current league slug and season ID.
 * URL params take precedence over context values, allowing deep-links
 * like /leagues/alps-xc-2025 to work correctly.
 */
export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  // useParams is safe to call here — BrowserRouter is mounted in main.tsx
  const params = useParams<{ leagueSlug?: string; seasonId?: string }>();
  return {
    leagueSlug: params.leagueSlug ?? ctx.leagueSlug,
    seasonId: params.seasonId ?? ctx.seasonId,
  };
}
