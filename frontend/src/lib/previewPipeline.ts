// Client-side IGC scoring preview.
//
// Runs the pilot's track through the same shared pipeline code the server
// runs (src/shared/pipeline.ts), then mirrors the server's task-level
// normalisation (rebuildTaskResults in src/job-queue.ts) from the
// leaderboard snapshot it was given. The server remains authoritative —
// this is just so the pilot can see what's going to happen first.

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
  /**
   * What the pilot's leaderboard row would show after this upload. The server
   * keeps a pilot's previous better attempt (compareBestAttempt in
   * src/job-queue.ts), so this is the better of (existing row, preview) —
   * `source: 'existing'` means the previewed flight would NOT displace the
   * pilot's current best.
   */
  predicted: PredictedStanding;
}

export interface PredictedStanding {
  source: 'preview' | 'existing';
  distanceFlownKm: number;
  reachedGoal: boolean;
  taskTimeS: number | null;
  distancePoints: number;
  timePoints: number;
  totalPoints: number;
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
 * Approach: pool the preview alongside the FULL existing leaderboard —
 * including the current pilot's own row. Uploads never replace prior
 * attempts server-side: rebuildTaskResults pools goal times and best
 * distance across ALL non-deleted attempts and keeps the pilot's previous
 * attempt as their result when it beats the new one (compareBestAttempt).
 * Dropping the pilot's row here would move t_best when they hold it —
 * e.g. pilot A holds t_best = 3600 s, B in goal at 4500 s, A previews a
 * 5400 s flight: the server keeps the pool at {3600, 4500, 5400} (A stays
 * winner at 1000, B keeps 685.0 raw time points), whereas a pool without
 * A's row would wrongly anchor t_best at 4500 s. The pilot's row and the
 * preview together contribute ONE winner-scale candidate: whichever of the
 * two the server would keep as their best attempt.
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Exported for tests. `preview` only needs the scoring-relevant fields of a
// ScoredAttempt so tests don't have to fabricate crossings.
export function normalizePreviewPoints(
  preview: Pick<ScoredAttempt, 'distanceFlownKm' | 'reachedGoal' | 'taskTimeS'>,
  leaderboard: LeaderboardEntry[],
  currentUserId: string | undefined,
  taskValue: number,
): { distancePoints: number; timePoints: number; totalPoints: number; predicted: PredictedStanding } {
  const existing = (currentUserId && leaderboard.find((e) => e.pilotId === currentUserId)) || null;
  const others = existing ? leaderboard.filter((e) => e !== existing) : leaderboard;

  // bestDist drives the non-goal distance points formula. Include the preview
  // — if it flew further than anyone else, it sets the new bestDist.
  // Caveat: leaderboard.distanceFlownKm is each pilot's best-ATTEMPT distance,
  // not their max across all attempts. In the (narrow) case where a pilot's
  // non-best attempt flew further than their best attempt, the server's
  // rebuildTaskResults would see a larger bestDist via MAX(distance_flown_km)
  // over flight_attempts. The preview can't observe that without an extra API.
  const bestDist = Math.max(preview.distanceFlownKm, ...leaderboard.map((e) => e.distanceFlownKm ?? 0), 0);
  // Time points use the global goal-time pool: every pilot's goal time —
  // the current pilot's existing one included — plus the preview's if it
  // reached goal. t_best is a min over the pool, so keeping both of the
  // current pilot's times matches the server's per-pilot-fastest pooling.
  const allGoalTimes: number[] = [
    ...leaderboard.filter((e) => e.reachedGoal && e.taskTimeS != null).map((e) => e.taskTimeS as number),
    ...(preview.reachedGoal && preview.taskTimeS != null ? [preview.taskTimeS] : []),
  ];

  const rawPoints = (d: number, reachedGoal: boolean, t: number | null) => {
    const dp = computeDistancePoints(d, bestDist > 0 ? bestDist : 1, reachedGoal);
    const tp = reachedGoal && t != null ? computeTimePoints(t, allGoalTimes) : 0;
    return { dp, tp };
  };
  // rebuildTaskResults keeps raw totals at full precision (rounding to 0.1
  // happens exactly once, on the persisted post-normalisation values) —
  // mirror that so the winner pick and scale match the server's.
  const rawTotal = (d: number, reachedGoal: boolean, t: number | null) => {
    const { dp, tp } = rawPoints(d, reachedGoal, t);
    return dp + tp;
  };

  const previewRaw = rawPoints(preview.distanceFlownKm, preview.reachedGoal, preview.taskTimeS);
  const previewRawTotal = previewRaw.dp + previewRaw.tp;

  // Server best-attempt order (compareBestAttempt in src/job-queue.ts):
  // reached goal first, then higher total, then lower task time — ties keep
  // the existing attempt.
  const existingRaw = existing ? rawPoints(existing.distanceFlownKm, existing.reachedGoal, existing.taskTimeS) : null;
  const existingRawTotal = existingRaw ? existingRaw.dp + existingRaw.tp : null;
  const existingWins =
    existing != null &&
    existingRawTotal != null &&
    (existing.reachedGoal !== preview.reachedGoal
      ? existing.reachedGoal
      : existingRawTotal !== previewRawTotal
        ? existingRawTotal > previewRawTotal
        : (existing.taskTimeS ?? Number.POSITIVE_INFINITY) <= (preview.taskTimeS ?? Number.POSITIVE_INFINITY));

  // Winner total across each pilot's would-be best attempt. The current
  // pilot contributes one candidate: whichever of (existing row, preview)
  // the server would keep.
  let winnerRaw = existingWins && existingRawTotal != null ? existingRawTotal : previewRawTotal;
  for (const e of others) {
    const r = rawTotal(e.distanceFlownKm, e.reachedGoal, e.taskTimeS);
    if (r > winnerRaw) winnerRaw = r;
  }

  const zero = { distancePoints: 0, timePoints: 0, totalPoints: 0 };
  if (winnerRaw <= 0) {
    return {
      ...zero,
      predicted: {
        source: existingWins ? 'existing' : 'preview',
        distanceFlownKm: existingWins && existing ? existing.distanceFlownKm : preview.distanceFlownKm,
        reachedGoal: existingWins && existing ? existing.reachedGoal : preview.reachedGoal,
        taskTimeS: existingWins && existing ? existing.taskTimeS : preview.taskTimeS,
        ...zero,
      },
    };
  }

  const scale = taskValue / winnerRaw;
  const normalize = (raw: { dp: number; tp: number }) => {
    const distancePoints = round1(raw.dp * scale);
    const timePoints = round1(raw.tp * scale);
    return { distancePoints, timePoints, totalPoints: round1(distancePoints + timePoints) };
  };

  const previewNormalized = normalize(previewRaw);
  const predicted: PredictedStanding =
    existingWins && existing && existingRaw
      ? {
          source: 'existing',
          distanceFlownKm: existing.distanceFlownKm,
          reachedGoal: existing.reachedGoal,
          taskTimeS: existing.taskTimeS,
          ...normalize(existingRaw),
        }
      : {
          source: 'preview',
          distanceFlownKm: preview.distanceFlownKm,
          reachedGoal: preview.reachedGoal,
          taskTimeS: preview.taskTimeS,
          ...previewNormalized,
        };

  return { ...previewNormalized, predicted };
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
  const { predicted, ...normalized } = normalizePreviewPoints(
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
      predicted,
    },
  };
}
