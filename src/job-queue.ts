// =============================================================================
// XC / Hike & Fly League Platform — Job Queue
//
// Infrastructure: SQLiteJobQueue + JobWorker (better-sqlite3 native API).
// Handlers: RESCORE_TASK, FREEZE_TASK_SCORES, REBUILD_STANDINGS, NOTIFY_PILOTS.
//
// Single-process design: Fastify API + worker loop share one SQLite connection.
// Worker wakes immediately on job enqueue via EventEmitter; polling fallback
// every 30 s catches jobs missed during restart.
// =============================================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { computeTimePoints } from './shared/task-engine';

// ── Minimal typed EventEmitter (no @types/node dependency) ───────────────────

class TypedEmitter {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(fn => fn(...args));
  }
}


// =============================================================================
// JOB PAYLOAD TYPES
// =============================================================================

export type JobType =
  | 'RESCORE_TASK'
  | 'FREEZE_TASK_SCORES'
  | 'REBUILD_STANDINGS'
  | 'REPROCESS_ALL_SUBMISSIONS'
  | 'NOTIFY_PILOTS';

/** Recalculate time points for all goal attempts on a task. */
export interface RescoreTaskPayload {
  taskId:                  string;
  leagueId:                string;
  triggeredBySubmissionId: string;
}

/** Lock task scores at close_date. */
export interface FreezeTaskScoresPayload {
  taskId:   string;
  leagueId: string;
}

/** Recompute season_standings from task_results. */
export interface RebuildStandingsPayload {
  seasonId: string;
  leagueId: string;
}

/** Re-parse and re-score all IGC files for a task after turnpoints change. */
export interface ReprocessAllSubmissionsPayload {
  taskId:        string;
  leagueId:      string;
  submissionIds: string[];
}

/** Fan-out notifications to pilots whose score changed. */
export interface NotifyPilotsPayload {
  taskId:       string;
  leagueId:     string;
  taskName:     string;
  scoreChanges: Record<string, { oldTotalPoints: number; newTotalPoints: number }>;
}

export type JobPayload =
  | RescoreTaskPayload
  | FreezeTaskScoresPayload
  | RebuildStandingsPayload
  | ReprocessAllSubmissionsPayload
  | NotifyPilotsPayload;

export interface JobRecord {
  id:          string;
  type:        JobType;
  payload:     JobPayload;
  status:      'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  attempts:    number;
  maxAttempts: number;
  lastError:   string | null;
  scheduledAt: string;
  startedAt:   string | null;
  completedAt: string | null;
  createdAt:   string;
  updatedAt:   string;
}

export interface EnqueueOptions {
  scheduledAt?: Date;
  maxAttempts?: number;
}

export interface JobQueue {
  enqueue<T extends JobPayload>(type: JobType, payload: T, options?: EnqueueOptions): Promise<string>;
}


// =============================================================================
// RETRY SCHEDULE
// =============================================================================

const RETRY_DELAYS_MS = [
  30 * 1000,
  5  * 60 * 1000,
  30 * 60 * 1000,
];

function nextScheduledAt(attemptNumber: number): string {
  const delay = RETRY_DELAYS_MS[attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return new Date(Date.now() + delay).toISOString();
}


// =============================================================================
// JOB QUEUE
// =============================================================================

export class SQLiteJobQueue extends TypedEmitter implements JobQueue {
  constructor(private readonly db: Database) {
    super();
  }

  async enqueue<T extends JobPayload>(
    type: JobType,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const id          = randomUUID();
    const scheduledAt = (options.scheduledAt ?? new Date()).toISOString();
    const maxAttempts = options.maxAttempts ?? 3;

    this.db.prepare(
      `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, type, JSON.stringify(payload), maxAttempts, scheduledAt);

    this.emit('job:enqueued', { id, type });
    return id;
  }
}


// =============================================================================
// WORKER
// =============================================================================

type JobHandler<T extends JobPayload> = (payload: T, jobId: string) => Promise<void>;

export class JobWorker {
  private running    = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private handlers   = new Map<JobType, JobHandler<any>>();

  constructor(
    private readonly db:    Database,
    private readonly queue: SQLiteJobQueue,
  ) {
    (queue as TypedEmitter).on('job:enqueued', () => this.processNext());
  }

  register<T extends JobPayload>(type: JobType, handler: JobHandler<T>): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    this.running   = true;
    this.pollTimer = setInterval(() => this.processNext(), 30_000);
    this.processNext();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async processNext(): Promise<void> {
    if (!this.running) return;

    const job = this.claimNextJob();
    if (!job) return;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.failJob(job.id, `No handler registered for job type: ${job.type}`);
      return;
    }

    try {
      await handler(job.payload, job.id);
      this.completeJob(job.id);
    } catch (err) {
      this.handleJobError(job, err instanceof Error ? err.message : String(err));
    }

    setTimeout(() => this.processNext(), 0);
  }

  private claimNextJob(): JobRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM jobs
       WHERE status = 'PENDING' AND datetime(scheduled_at) <= datetime('now')
       ORDER BY datetime(scheduled_at) ASC LIMIT 1`,
    ).get() as any;

    if (!row) return null;

    this.db.prepare(
      `UPDATE jobs SET status = 'RUNNING', started_at = datetime('now'),
         attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`,
    ).run(row.id);

    return { ...row, payload: JSON.parse(row.payload) };
  }

  private completeJob(jobId: string): void {
    this.db.prepare(
      `UPDATE jobs SET status = 'COMPLETE', completed_at = datetime('now'),
         updated_at = datetime('now') WHERE id = ?`,
    ).run(jobId);
  }

  private handleJobError(job: JobRecord, message: string): void {
    if (job.attempts >= job.maxAttempts) {
      this.failJob(job.id, message);
    } else {
      this.db.prepare(
        `UPDATE jobs SET status = 'PENDING', scheduled_at = ?, last_error = ?,
           updated_at = datetime('now') WHERE id = ?`,
      ).run(nextScheduledAt(job.attempts), message, job.id);
    }
  }

  private failJob(jobId: string, message: string): void {
    this.db.prepare(
      `UPDATE jobs SET status = 'FAILED', last_error = ?,
         updated_at = datetime('now') WHERE id = ?`,
    ).run(message, jobId);
  }
}


// =============================================================================
// SHARED UTILITY: rebuild task_results
//
// Materialised best-attempt-per-pilot cache for a task.
// Called from: upload handler (immediate) + RESCORE_TASK (after rescore).
// Must be called inside an existing transaction or starts its own.
// =============================================================================

export function rebuildTaskResults(db: Database, taskId: string): void {
  // Full rebuild: delete old rows, recompute from flight_attempts.
  db.prepare('DELETE FROM task_results WHERE task_id = ?').run(taskId);

  // Best attempt per pilot: goal first, then highest points, then fastest time.
  // Then rank all pilots by total_points DESC.
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        id, user_id, league_id,
        distance_flown_km, reached_goal, task_time_s,
        distance_points, time_points, total_points, has_flagged_crossings,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY reached_goal DESC, total_points DESC,
                   CASE WHEN task_time_s IS NULL THEN 1 ELSE 0 END,
                   task_time_s ASC
        ) AS rn
      FROM flight_attempts
      WHERE task_id = ? AND deleted_at IS NULL
    )
    SELECT
      id, user_id, league_id, distance_flown_km, reached_goal, task_time_s,
      distance_points, time_points, total_points, has_flagged_crossings,
      RANK() OVER (
        ORDER BY total_points DESC,
                 CASE WHEN task_time_s IS NULL THEN 1 ELSE 0 END,
                 task_time_s ASC
      ) AS pilot_rank
    FROM ranked WHERE rn = 1
  `).all(taskId) as Array<{
    id: string; user_id: string; league_id: string;
    distance_flown_km: number; reached_goal: number; task_time_s: number | null;
    distance_points: number; time_points: number; total_points: number;
    has_flagged_crossings: number; pilot_rank: number;
  }>;

  // Apply score normalization if configured on this task.
  const taskRow = db.prepare(
    `SELECT normalized_score FROM tasks WHERE id = ?`
  ).get(taskId) as { normalized_score: number | null } | undefined;
  const normalized = taskRow?.normalized_score ?? 1000;

  let finalRows = rows;
  if (normalized !== null && rows.length > 0) {
    const winnerTotal = Math.max(...rows.map(r => r.total_points));
    if (winnerTotal > 0) {
      const scale = normalized / winnerTotal;
      finalRows = rows.map(r => {
        const total = Math.round(r.total_points * scale);
        const dp    = Math.round(r.distance_points * scale);
        const tp    = total - dp;
        return { ...r, distance_points: dp, time_points: tp, total_points: total };
      });
    }
  }

  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO task_results (
      id, task_id, user_id, league_id, best_attempt_id,
      distance_flown_km, reached_goal, task_time_s,
      distance_points, time_points, total_points, has_flagged_crossings,
      rank, last_computed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of finalRows) {
    ins.run(
      randomUUID(), taskId, r.user_id, r.league_id, r.id,
      r.distance_flown_km, r.reached_goal, r.task_time_s,
      r.distance_points, r.time_points, r.total_points, r.has_flagged_crossings,
      r.pilot_rank, now, now, now,
    );
  }
}


// =============================================================================
// HANDLER: RESCORE_TASK
//
// 1. Bail if task is frozen or deleted.
// 2. Load all goal attempts for the task.
// 3. Recompute time_points using the full set of goal times.
// 4. Write updated scores + rebuild task_results in one transaction.
// 5. Enqueue REBUILD_STANDINGS.
// =============================================================================

async function handleRescoreTask(
  payload: RescoreTaskPayload,
  db:      Database,
  queue:   SQLiteJobQueue,
): Promise<void> {
  const task = db.prepare(
    `SELECT id, season_id, scores_frozen_at FROM tasks WHERE id = ? AND deleted_at IS NULL`,
  ).get(payload.taskId) as { id: string; season_id: string; scores_frozen_at: string | null } | undefined;

  if (!task || task.scores_frozen_at !== null) return;

  // Load all goal attempts (reached_goal = 1) with their current scores
  const goalAttempts = db.prepare(
    `SELECT id, task_time_s, distance_points, total_points
     FROM flight_attempts
     WHERE task_id = ? AND reached_goal = 1 AND deleted_at IS NULL`,
  ).all(payload.taskId) as Array<{
    id: string; task_time_s: number | null; distance_points: number; total_points: number;
  }>;

  const goalTimes = goalAttempts
    .filter(a => a.task_time_s != null)
    .map(a => a.task_time_s!);

  db.transaction(() => {
    const update = db.prepare(
      `UPDATE flight_attempts
       SET time_points = ?, total_points = ?, updated_at = datetime('now')
       WHERE id = ?`,
    );

    for (const attempt of goalAttempts) {
      const tp = computeTimePoints(attempt.task_time_s ?? 0, goalTimes);
      update.run(tp, attempt.distance_points + tp, attempt.id);
    }

    rebuildTaskResults(db, payload.taskId);
  })();

  await queue.enqueue<RebuildStandingsPayload>('REBUILD_STANDINGS', {
    seasonId: task.season_id,
    leagueId: payload.leagueId,
  });
}


// =============================================================================
// HANDLER: FREEZE_TASK_SCORES
//
// Sets scores_frozen_at on the task, then enqueues a final RESCORE_TASK to
// lock in time points at the exact moment of close.
// =============================================================================

async function handleFreezeTaskScores(
  payload: FreezeTaskScoresPayload,
  db:      Database,
  queue:   SQLiteJobQueue,
): Promise<void> {
  const result = db.prepare(
    `UPDATE tasks SET scores_frozen_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND scores_frozen_at IS NULL AND deleted_at IS NULL`,
  ).run(payload.taskId);

  if (result.changes === 0) return; // already frozen or deleted

  await queue.enqueue<RescoreTaskPayload>('RESCORE_TASK', {
    taskId:                  payload.taskId,
    leagueId:                payload.leagueId,
    triggeredBySubmissionId: 'FREEZE',
  });
}


// =============================================================================
// HANDLER: REBUILD_STANDINGS
//
// Aggregates task_results per pilot across all tasks in a season, then
// upserts season_standings with updated totals and ranks.
// =============================================================================

async function handleRebuildStandings(
  payload: RebuildStandingsPayload,
  db:      Database,
): Promise<void> {
  const rows = db.prepare(`
    SELECT
      tr.user_id,
      SUM(tr.total_points)  AS total_points,
      COUNT(tr.task_id)     AS tasks_flown,
      SUM(tr.reached_goal)  AS tasks_with_goal
    FROM task_results tr
    JOIN tasks t ON t.id = tr.task_id
    WHERE t.season_id = ? AND t.deleted_at IS NULL
    GROUP BY tr.user_id
    ORDER BY total_points DESC
  `).all(payload.seasonId) as Array<{
    user_id: string; total_points: number; tasks_flown: number; tasks_with_goal: number;
  }>;

  const now = new Date().toISOString();

  db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO season_standings
        (id, season_id, user_id, league_id, total_points, tasks_flown, tasks_with_goal,
         rank, last_computed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (season_id, user_id) DO UPDATE SET
        total_points     = excluded.total_points,
        tasks_flown      = excluded.tasks_flown,
        tasks_with_goal  = excluded.tasks_with_goal,
        rank             = excluded.rank,
        last_computed_at = excluded.last_computed_at,
        updated_at       = excluded.updated_at
    `);

    rows.forEach((row, i) => {
      upsert.run(
        randomUUID(), payload.seasonId, row.user_id, payload.leagueId,
        row.total_points, row.tasks_flown, row.tasks_with_goal,
        i + 1,
        now, now, now,
      );
    });
  })();
}


// =============================================================================
// HANDLER: NOTIFY_PILOTS
// Placeholder — notification delivery not yet implemented.
// =============================================================================

async function handleNotifyPilots(
  _payload: NotifyPilotsPayload,
  _db:      Database,
): Promise<void> {
  // TODO: implement push / email notifications
}


// =============================================================================
// BOOTSTRAP
// Wires all handlers into the worker and returns it ready to start().
// =============================================================================

export function bootstrapWorker(db: Database, queue: SQLiteJobQueue): JobWorker {
  const worker = new JobWorker(db, queue);

  worker.register<RescoreTaskPayload>(
    'RESCORE_TASK',
    (payload) => handleRescoreTask(payload, db, queue),
  );

  worker.register<FreezeTaskScoresPayload>(
    'FREEZE_TASK_SCORES',
    (payload) => handleFreezeTaskScores(payload, db, queue),
  );

  worker.register<RebuildStandingsPayload>(
    'REBUILD_STANDINGS',
    (payload) => handleRebuildStandings(payload, db),
  );

  worker.register<NotifyPilotsPayload>(
    'NOTIFY_PILOTS',
    (payload) => handleNotifyPilots(payload, db),
  );

  // REPROCESS_ALL_SUBMISSIONS is not yet triggered by any API endpoint
  worker.register<ReprocessAllSubmissionsPayload>(
    'REPROCESS_ALL_SUBMISSIONS',
    async () => { /* not yet implemented */ },
  );

  return worker;
}
