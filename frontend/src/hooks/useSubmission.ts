import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { submissionsApi, type SubmissionResponse } from '../api/tasks';
import { useLeague } from './useLeague';

interface UploadState {
  progress:  number;          // 0–100
  status:    'idle' | 'uploading' | 'processing' | 'done' | 'error';
  result:    SubmissionResponse | null;
  error:     string | null;
}

const INITIAL: UploadState = {
  progress: 0,
  status:   'idle',
  result:   null,
  error:    null,
};

export function useUpload() {
  const { leagueSlug, seasonId } = useLeague();
  const queryClient = useQueryClient();
  const [state, setState] = useState<UploadState>(INITIAL);

  const upload = useCallback(async (file: File, taskId: string) => {
    setState({ progress: 0, status: 'uploading', result: null, error: null });

    try {
      const res = await submissionsApi.upload(
        leagueSlug,
        seasonId,
        taskId,
        file,
        (pct) => {
          // Once upload hits 100%, server is processing — show processing state
          if (pct === 100) {
            setState(s => ({ ...s, progress: 100, status: 'processing' }));
          } else {
            setState(s => ({ ...s, progress: pct }));
          }
        },
      );

      setState({ progress: 100, status: 'done', result: res.submission, error: null });

      // Invalidate leaderboard and submissions so they refetch with new data
      queryClient.invalidateQueries({ queryKey: ['leaderboard', leagueSlug, seasonId, taskId] });
      queryClient.invalidateQueries({ queryKey: ['submissions', leagueSlug, seasonId, taskId] });

    } catch (err: any) {
      const message = err?.message ?? err?.error?.message ?? 'Upload failed. Please try again.';
      setState({ progress: 0, status: 'error', result: null, error: message });
    }
  }, [leagueSlug, seasonId, queryClient]);

  const reset = useCallback(() => setState(INITIAL), []);

  return { ...state, upload, reset };
}
