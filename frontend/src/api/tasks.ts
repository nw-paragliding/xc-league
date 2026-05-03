import { API_BASE, api, apiFetch } from './client';

// =============================================================================
// SHARED TYPES
// =============================================================================

export interface Turnpoint {
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  type: 'SSS' | 'ESS' | 'GOAL_CYLINDER' | 'GOAL_LINE' | 'CYLINDER';
  forceGround?: boolean; // hike & fly: pilot must arrive on foot (any role)
  sequenceIndex: number;
  goalLineBearingDeg?: number | null;
}

export interface Task {
  id: string;
  name: string;
  description: string | null;
  taskType: 'RACE_TO_GOAL' | 'OPEN_DISTANCE';
  status: 'draft' | 'published';
  openDate: string;
  closeDate: string;
  taskValue: number | null;
  pilotCount: number;
  goalCount: number;
  turnpoints: Turnpoint[];
}

export interface AttemptResult {
  attemptIndex: number;
  reachedGoal: boolean;
  distanceFlownKm: number;
  taskTimeS: number | null;
  distancePoints: number;
  timePoints: number;
  totalPoints: number;
  hasFlaggedCrossings: boolean;
  turnpointsCrossed: number;
}

/**
 * Per-submission attempt facts. Same shape as AttemptResult minus the score
 * fields — those would mix submission-time numbers with the live per-pilot
 * scoring and could read as stale or impossible. The leaderboard's
 * `bestAttempt` is the source of truth for points.
 */
export interface SubmissionAttemptFacts {
  attemptIndex: number;
  reachedGoal: boolean;
  distanceFlownKm: number;
  lastTurnpointIndex: number;
  taskTimeS: number | null;
  hasFlaggedCrossings: boolean;
}

export interface Submission {
  id: string;
  status: 'PROCESSED' | 'INVALID' | 'PENDING' | 'PROCESSING' | 'ERROR';
  submittedAt: string;
  igcFilename: string;
  igcSizeBytes: number;
  igcDate: string | null;
  bestAttempt: AttemptResult;
  allAttempts: AttemptResult[];
  /** Facts about *this* submission's own best attempt (not the leaderboard's). */
  thisSubmission: SubmissionAttemptFacts | null;
  /** True iff this submission's best attempt is the one currently on the leaderboard. */
  isCurrentBest: boolean;
  timePointsProvisional: boolean;
}

export interface InvalidSubmission {
  id: string;
  status: 'INVALID';
  submittedAt: string;
  igcFilename: string;
  igcSizeBytes: number;
  errorCode: string;
  errorMessage: string;
}

export type SubmissionResponse = Submission | InvalidSubmission;

export interface LeaderboardEntry {
  rank: number;
  pilotName: string;
  pilotId: string;
  submissionId: string | null;
  distanceFlownKm: number;
  reachedGoal: boolean;
  taskTimeS: number | null;
  distancePoints: number;
  timePoints: number;
  totalPoints: number;
  hasFlaggedCrossings: boolean;
}

export interface LeaderboardResponse {
  task: Task;
  entries: LeaderboardEntry[];
}

// =============================================================================
// API CALLS
// =============================================================================

export const tasksApi = {
  /** List all tasks for a season — returns each task with turnpoints nested. */
  list: (leagueSlug: string, seasonId: string) =>
    api.get<{ tasks: Task[] }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks`),

  /** Get task leaderboard */
  leaderboard: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.get<LeaderboardResponse>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/leaderboard`),
};

export const submissionsApi = {
  /**
   * Upload an IGC file for a task.
   * Processes synchronously — response includes scored result.
   * Uses raw fetch (not api.post) to handle multipart/form-data.
   */
  upload: async (
    leagueSlug: string,
    seasonId: string,
    taskId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ submission: SubmissionResponse }> => {
    const form = new FormData();
    form.append('igcFile', file, file.name);

    // XMLHttpRequest for upload progress — fetch doesn't support it yet
    if (onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/submissions`);
        xhr.withCredentials = true;

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        });

        xhr.addEventListener('load', () => {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(body);
          } else {
            reject({ status: xhr.status, ...body?.error });
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.send(form);
      });
    }

    // No progress needed — use regular fetch
    return apiFetch(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/submissions`, {
      method: 'POST',
      body: form,
    });
  },

  /** List all submissions by the authenticated pilot for a task */
  list: (leagueSlug: string, seasonId: string, taskId: string) =>
    api.get<{ submissions: Submission[] }>(`/leagues/${leagueSlug}/seasons/${seasonId}/tasks/${taskId}/submissions`),
};
