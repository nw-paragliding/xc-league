import { api } from './client';

export interface StandingsEntry {
  rank: number;
  pilotName: string;
  pilotId: string;
  totalPoints: number;
  tasksFlown: number;
  tasksWithGoal: number;
}

export interface Season {
  id: string;
  name: string;
  competitionType: 'XC' | 'HIKE_AND_FLY';
  startDate: string;
  endDate: string;
  taskCount: number;
}

export interface StandingsResponse {
  season: Season;
  standings: StandingsEntry[];
}

export const standingsApi = {
  get: (leagueSlug: string, seasonId: string) =>
    api.get<StandingsResponse>(`/leagues/${leagueSlug}/seasons/${seasonId}/standings`),

  seasons: (leagueSlug: string) => api.get<{ seasons: Season[] }>(`/leagues/${leagueSlug}/seasons`),
};
