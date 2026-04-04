import { api } from './client';

export interface ReplayFix {
  t: number; // Unix ms
  lat: number;
  lng: number;
  alt: number;
}

export interface ReplayCrossing {
  turnpointId: string;
  turnpointName: string;
  sequenceIndex: number;
  crossingTimeMs: number;
  type: string;
  radiusM: number;
  latitude: number;
  longitude: number;
  groundConfirmed: boolean;
  groundCheckRequired: boolean;
}

export interface TrackReplay {
  submissionId: string;
  taskId: string;
  pilotId: string;
  pilotName: string;
  flightDate: string;
  fixes: ReplayFix[];
  crossings: ReplayCrossing[];
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  meta: {
    fixCount: number;
    durationS: number | null;
    reachedGoal: boolean;
    totalPoints: number;
  };
}

export const trackApi = {
  get: (leagueSlug: string, seasonId: string, taskId: string, submissionId: string) =>
    api.get<TrackReplay>(
      `/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/submissions/${submissionId}/track`,
    ),
};
