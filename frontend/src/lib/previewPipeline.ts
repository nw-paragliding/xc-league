// Client-side IGC scoring preview.
//
// Reuses the backend pipeline (src/pipeline.ts) so the preview shown to the
// pilot before they submit is the same code that the server runs after they
// submit. The server remains authoritative — this is just so the pilot can
// see what's going to happen first.

import type { ScoredAttempt } from '../../../src/pipeline';
import { parseAndValidate, runPipeline } from '../../../src/pipeline';
import type { Season } from '../api/leagues';
import type { LeaderboardEntry, Task, Turnpoint } from '../api/tasks';
import type { ReplayFix } from '../api/track';

export interface PreviewResult {
  attempts: ScoredAttempt[];
  bestAttemptIndex: number;
  flightDate: string;
  fixes: ReplayFix[];
}

export interface PreviewError {
  stage: string;
  code: string;
  message: string;
}

function turnpointToDef(tp: Turnpoint) {
  // Preview-only synthetic ID — does NOT round-trip to the server's
  // turnpoints.id. We only use it locally to satisfy the pipeline's
  // TurnpointDef shape; everything the UI keys off comes back through
  // sequenceIndex (which IS stable across client and server).
  return {
    id: `tp-${tp.sequenceIndex}`,
    sequenceIndex: tp.sequenceIndex,
    lat: tp.latitude,
    lng: tp.longitude,
    radiusM: tp.radiusM,
    type: tp.type,
    forceGround: tp.forceGround,
    goalLineBearingDeg: tp.goalLineBearingDeg ?? undefined,
  };
}

export async function previewSubmission(
  igcText: string,
  task: Task,
  season: Pick<Season, 'competitionType'>,
  leaderboardEntries: LeaderboardEntry[],
): Promise<{ ok: true; value: PreviewResult } | { ok: false; error: PreviewError }> {
  const taskBestDistanceKm = leaderboardEntries.reduce((m, e) => Math.max(m, e.distanceFlownKm ?? 0), 0);
  const existingGoalTimes = leaderboardEntries
    .filter((e) => e.reachedGoal && e.taskTimeS != null)
    .map((e) => e.taskTimeS as number);

  const result = await runPipeline(
    {
      igcText,
      task: {
        id: task.id,
        turnpoints: task.turnpoints.map(turnpointToDef),
      },
      existingGoalTimes,
      competitionType: season.competitionType,
    },
    task.openDate,
    task.closeDate,
    taskBestDistanceKm,
  );

  if (!result.ok) {
    const e = result.error;
    return {
      ok: false,
      error: {
        stage: e.stage,
        // PipelineError shapes vary by stage — extract code/message where present
        code: (e.error as { code?: string }).code ?? e.stage,
        message: (e.error as { message?: string }).message ?? 'Preview failed',
      },
    };
  }

  // Re-parse to surface the fix array for the map overlay. parseAndValidate is
  // pure and idempotent so this is essentially free.
  const parsed = parseAndValidate(igcText);
  const fixes: ReplayFix[] = parsed.ok
    ? parsed.value.fixes.map((f) => ({ t: f.timestamp, lat: f.lat, lng: f.lng, alt: f.gpsAlt }))
    : [];

  return {
    ok: true,
    value: {
      attempts: result.value.scoredAttempts,
      bestAttemptIndex: result.value.bestAttemptIndex,
      flightDate: result.value.flightDate,
      fixes,
    },
  };
}
