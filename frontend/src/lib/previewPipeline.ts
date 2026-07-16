// Client-side IGC scoring preview.
//
// Reuses the backend pipeline (src/shared/pipeline.ts) so the preview shown
// to the pilot before they submit is the same code that the server runs
// after they submit. The server remains authoritative — this is just so
// the pilot can see what's going to happen first.

import type { PipelineError, ScoredAttempt } from '../../../src/shared/pipeline';
import { parseAndValidate, runPipelineFromParsed } from '../../../src/shared/pipeline';
import { computeDistancePoints, computeTimePoints, MAX_POINTS } from '../../../src/shared/task-engine';
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
  stage: PipelineError['stage'] | 'PREVIEW' | 'UPLOAD';
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

/**
 * Mirror the task-level normalisation that `rebuildTaskResults` runs server-
 * side after every upload (src/job-queue.ts). The pipeline returns raw GAP
 * points (max 1000 each for dist + time); the leaderboard shows those points
 * rescaled so the winner's total equals the task's `normalized_score` (1000
 * by default). Without applying the same scale here, the preview's "Total
 * pts" would be on a different scale from the comparison panel's "Previous
 * Best" — leading to nonsense like "less distance = more points" when the
 * existing leaderboard has been heavily compressed.
 *
 * Approach: pool the preview alongside the existing leaderboard (excluding
 * the current pilot's stale row — the preview replaces it), recompute raw
 * dist + time points for everyone using the new bestDist and the new
 * goal-time pool, find the would-be winner's raw total, scale.
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalizePreviewPoints(
  preview: ScoredAttempt,
  leaderboard: LeaderboardEntry[],
  currentUserId: string | undefined,
  taskValue: number,
): { distancePoints: number; timePoints: number; totalPoints: number } {
  // Drop the current pilot's existing leaderboard row — their preview replaces
  // it as their best-attempt candidate. Keeping both would double-count this
  // pilot in the goal-time pool (potentially pinning t_best to their old,
  // faster time) and treat their old total as a separate "competitor"
  // against themselves.
  const others = currentUserId ? leaderboard.filter((e) => e.pilotId !== currentUserId) : leaderboard;

  // bestDist drives the non-goal distance points formula. Include the preview
  // — if it flew further than anyone else, it sets the new bestDist.
  // Caveat: leaderboard.distanceFlownKm is each pilot's best-ATTEMPT distance,
  // not their max across all attempts. In the (narrow) case where a pilot's
  // non-best attempt flew further than their best attempt, the server's
  // rebuildTaskResults would see a larger bestDist via MAX(distance_flown_km)
  // over flight_attempts. The preview can't observe that without an extra API.
  const bestDist = Math.max(preview.distanceFlownKm, ...others.map((e) => e.distanceFlownKm ?? 0), 0);
  // Time points use the global goal-time pool. Include the preview's time if
  // it reached goal.
  const allGoalTimes: number[] = [
    ...others.filter((e) => e.reachedGoal && e.taskTimeS != null).map((e) => e.taskTimeS as number),
    ...(preview.reachedGoal && preview.taskTimeS != null ? [preview.taskTimeS] : []),
  ];

  // rebuildTaskResults rounds each total to 0.1 BEFORE picking the winner.
  // Mirror that here so a floating-point ε doesn't shift the winner and
  // therefore the global scale.
  const rawTotal = (d: number, reachedGoal: boolean, t: number | null) => {
    const dp = computeDistancePoints(d, bestDist > 0 ? bestDist : 1, reachedGoal);
    const tp = reachedGoal && t != null ? computeTimePoints(t, allGoalTimes) : 0;
    return round1(dp + tp);
  };

  const previewRawDist = computeDistancePoints(
    preview.distanceFlownKm,
    bestDist > 0 ? bestDist : 1,
    preview.reachedGoal,
  );
  const previewRawTime =
    preview.reachedGoal && preview.taskTimeS != null ? computeTimePoints(preview.taskTimeS, allGoalTimes) : 0;
  const previewRawTotal = round1(previewRawDist + previewRawTime);

  // Winner total across (existing best per pilot) + (this preview). Same
  // formula rebuildTaskResults uses; we treat the preview as a candidate
  // attempt — if it wins, it becomes the basis for the new scale.
  let winnerRaw = previewRawTotal;
  for (const e of others) {
    const r = rawTotal(e.distanceFlownKm, e.reachedGoal, e.taskTimeS);
    if (r > winnerRaw) winnerRaw = r;
  }

  if (winnerRaw <= 0) {
    return { distancePoints: 0, timePoints: 0, totalPoints: 0 };
  }

  const scale = taskValue / winnerRaw;
  const distancePoints = round1(previewRawDist * scale);
  const timePoints = round1(previewRawTime * scale);
  return {
    distancePoints,
    timePoints,
    totalPoints: round1(distancePoints + timePoints),
  };
}

// Discriminated narrow on PipelineError.stage so the compiler surfaces
// breakage when a new stage is added or an existing stage's error shape
// changes. The cast-through-any version this replaced was silently losing
// DATE-stage details (DateValidationError has no `message` field).
function describePipelineError(e: PipelineError): PreviewError {
  switch (e.stage) {
    case 'PARSE':
      return { stage: 'PARSE', code: e.error.code, message: e.error.message };
    case 'DATE':
      return {
        stage: 'DATE',
        code: e.error.code,
        message: `Flight date ${e.error.flightDate} is outside the task window ${e.error.taskOpen} – ${e.error.taskClose}.`,
      };
    case 'DETECTION':
      return { stage: 'DETECTION', code: e.error.code, message: e.error.message };
  }
}

export async function previewSubmission(
  igcText: string,
  task: Task,
  season: Pick<Season, 'competitionType'>,
  leaderboardEntries: LeaderboardEntry[],
  currentUserId: string | undefined,
): Promise<{ ok: true; value: PreviewResult } | { ok: false; error: PreviewError }> {
  // Parse once up front. runPipelineFromParsed reuses this so we don't pay the
  // ~50-200 ms parse cost twice on multi-hour 1-Hz tracks.
  const parsed = parseAndValidate(igcText);
  if (!parsed.ok) {
    return { ok: false, error: { stage: 'PARSE', code: parsed.error.code, message: parsed.error.message } };
  }

  const taskBestDistanceKm = leaderboardEntries.reduce((m, e) => Math.max(m, e.distanceFlownKm ?? 0), 0);
  const existingGoalTimes = leaderboardEntries
    .filter((e) => e.reachedGoal && e.taskTimeS != null)
    .map((e) => e.taskTimeS as number);

  const result = await runPipelineFromParsed(
    parsed.value,
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
    return { ok: false, error: describePipelineError(result.error) };
  }

  const fixes: ReplayFix[] = parsed.value.fixes.map((f) => ({
    t: f.timestamp,
    lat: f.lat,
    lng: f.lng,
    alt: f.gpsAlt,
  }));

  // Apply task-level normalisation so the preview's points land in the same
  // scale as the leaderboard's "Previous Best" comparison shows.
  const bestIdx = result.value.bestAttemptIndex;
  const bestAttempt = result.value.scoredAttempts[bestIdx];
  const normalized = normalizePreviewPoints(
    bestAttempt,
    leaderboardEntries,
    currentUserId,
    task.taskValue ?? MAX_POINTS,
  );
  const normalizedAttempts = result.value.scoredAttempts.map((a, i) => (i === bestIdx ? { ...a, ...normalized } : a));

  return {
    ok: true,
    value: {
      attempts: normalizedAttempts,
      bestAttemptIndex: bestIdx,
      flightDate: result.value.flightDate,
      fixes,
    },
  };
}
