// =============================================================================
// XC / Hike & Fly League Platform — Job Queue Architecture
//
// Design:
//   - Single Node.js process: Fastify API + worker loop run together
//   - Jobs stored in SQLite `jobs` table (already in schema)
//   - Worker wakes immediately on job enqueue via EventEmitter
//   - Polling fallback every 30s to catch missed events (e.g. after restart)
//   - Concurrency: one job at a time (SQLite single-writer constraint)
//   - Retry: up to 3 attempts with exponential backoff (30s, 5min, 30min)
//   - SQLite write pattern: read → compute (outside tx) → short write tx
// =============================================================================

import type { ScoredAttempt, PipelineError } from './pipeline';

// Minimal EventEmitter inline — avoids @types/node dependency
class TypedEmitter {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(fn => fn(...args));
  }
}


// =============================================================================
// JOB PAYLOAD TYPES
// Each job type has a typed payload. The `jobs.payload` column stores JSON.
// =============================================================================

export type JobType =
  | 'RESCORE_TASK'
  | 'FREEZE_TASK_SCORES'
  | 'REBUILD_STANDINGS'
  | 'REPROCESS_ALL_SUBMISSIONS'
  | 'NOTIFY_PILOTS';

// Recalculate time points for all goal attempts on a task.
// Enqueued by: API after a new goal submission is processed.
// Also enqueued by: REPROCESS_ALL_SUBMISSIONS after all IGC files re-scored.
export interface RescoreTaskPayload {
  taskId: string;
  leagueId: string;
  triggeredBySubmissionId: string;
}

// Lock task scores at close_date. Scheduled at task creation.
// Re-scheduled if close_date is edited.
export interface FreezeTaskScoresPayload {
  taskId: string;
  leagueId: string;
}

// Recompute season_standings and task_results rank for a season.
// Enqueued by: RESCORE_TASK on completion.
export interface RebuildStandingsPayload {
  seasonId: string;
  leagueId: string;
}

// Re-parse and re-score all IGC files for a task after turnpoints change.
// Enqueued by: PATCH /tasks/:taskId?force=true.
// Spawns one synchronous pipeline call per submission, then enqueues RESCORE_TASK.
export interface ReprocessAllSubmissionsPayload {
  taskId: string;
  leagueId: string;
  submissionIds: string[];  // all submission IDs for this task at enqueue time
}

// Fan-out notifications to affected pilots after a rescore.
// Enqueued by: RESCORE_TASK on completion.
export interface NotifyPilotsPayload {
  taskId: string;
  leagueId: string;
  taskName: string;
  // Map of userId → { oldTotalPoints, newTotalPoints }
  // Only pilots whose score changed are included.
  scoreChanges: Record<string, { oldTotalPoints: number; newTotalPoints: number }>;
}

// Extended ScoredAttempt with DB-level fields (added when written to DB)
interface StoredAttempt extends ScoredAttempt {
  id: string;
  userId: string;
}

// Helper to extract a human-readable message from any pipeline error variant
function pipelineErrorMessage(err: PipelineError): string {
  const e = err.error as any;
  return e.message ?? `Pipeline error: ${e.code}`;
}

export type JobPayload =
  | RescoreTaskPayload
  | FreezeTaskScoresPayload
  | RebuildStandingsPayload
  | ReprocessAllSubmissionsPayload
  | NotifyPilotsPayload;

// =============================================================================
// JOB RECORD (mirrors the `jobs` table)
// =============================================================================

export interface JobRecord {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduledAt: string;   // ISO 8601 — worker ignores jobs with scheduledAt in the future
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// RETRY SCHEDULE
// Delay before next attempt: 30s, 5min, 30min
// =============================================================================

const RETRY_DELAYS_MS = [
  30 * 1000,        // attempt 2: 30 seconds
  5 * 60 * 1000,    // attempt 3: 5 minutes
  30 * 60 * 1000,   // attempt 4: 30 minutes (final — then FAILED)
];

function nextScheduledAt(attemptNumber: number): string {
  const delayMs = RETRY_DELAYS_MS[attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return new Date(Date.now() + delayMs).toISOString();
}

// =============================================================================
// JOB QUEUE — enqueueing interface
// Used by the API layer to insert jobs.
// =============================================================================

export interface EnqueueOptions {
  scheduledAt?: Date;   // defaults to now; use future date for FREEZE_TASK_SCORES
  maxAttempts?: number; // defaults to 3
}

export interface JobQueue {
  enqueue<T extends JobPayload>(type: JobType, payload: T, options?: EnqueueOptions): Promise<string>;
}

/**
 * SQLiteJobQueue
 *
 * Implements JobQueue against the `jobs` table.
 * Emits 'job:enqueued' after inserting so the worker wakes immediately.
 */
export class SQLiteJobQueue extends TypedEmitter implements JobQueue {
  constructor(private db: Database) {
    super();
  }

  async enqueue<T extends JobPayload>(
    type: JobType,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const scheduledAt = (options.scheduledAt ?? new Date()).toISOString();
    const maxAttempts = options.maxAttempts ?? 3;

    this.db.run(
      `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?, datetime('now'), datetime('now'))`,
      [id, type, JSON.stringify(payload), maxAttempts, scheduledAt],
    );

    this.emit('job:enqueued', { id, type });
    return id;
  }
}

// =============================================================================
// WORKER LOOP
// Polls for pending jobs and processes them one at a time.
// =============================================================================

// Handler function type — each job type maps to one of these
type JobHandler<T extends JobPayload> = (payload: T, jobId: string) => Promise<void>;

export class JobWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<JobType, JobHandler<any>>();

  constructor(
    private db: Database,
    private queue: SQLiteJobQueue,
  ) {
    // Wake immediately when a job is enqueued
    (queue as TypedEmitter).on('job:enqueued', () => this.processNext());
  }

  /**
   * Register a handler for a job type.
   * Called during application startup before start() is called.
   */
  register<T extends JobPayload>(type: JobType, handler: JobHandler<T>): void {
    this.handlers.set(type, handler);
  }

  /**
   * Start the worker. Sets up the polling fallback.
   */
  start(): void {
    this.running = true;
    // Fallback poll every 30s — catches jobs missed during startup or crash recovery
    this.pollTimer = setInterval(() => this.processNext(), 30_000);
    // Process any jobs pending from before startup
    this.processNext();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  /**
   * Claim and process the next available job.
   * Uses a UPDATE...WHERE to atomically claim a job (SQLite single-writer makes this safe).
   * Processes one job then checks if another is waiting.
   */
  private async processNext(): Promise<void> {
    if (!this.running) return;

    // Claim the next PENDING job whose scheduledAt is in the past
    // Using a transaction to atomically find-and-claim
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.handleJobError(job, errorMessage);
    }

    // Immediately check for another pending job
    setTimeout(() => this.processNext(), 0);
  }

  private claimNextJob(): JobRecord | null {
    // Single transaction: find next due job and mark it RUNNING
    // SQLite's single-writer guarantee makes this race-free in a single process
    const row = this.db.get<any>(
      `SELECT * FROM jobs
       WHERE status = 'PENDING'
         AND scheduled_at <= datetime('now')
       ORDER BY scheduled_at ASC
       LIMIT 1`,
    );
    if (!row) return null;

    this.db.run(
      `UPDATE jobs SET status = 'RUNNING', started_at = datetime('now'),
        attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`,
      [row.id],
    );

    return {
      ...row,
      payload: JSON.parse(row.payload),
    };
  }

  private completeJob(jobId: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'COMPLETE', completed_at = datetime('now'),
        updated_at = datetime('now') WHERE id = ?`,
      [jobId],
    );
  }

  private handleJobError(job: JobRecord, errorMessage: string): void {
    const attemptsUsed = job.attempts; // already incremented in claimNextJob
    if (attemptsUsed >= job.maxAttempts) {
      this.failJob(job.id, errorMessage);
    } else {
      // Schedule retry with backoff
      const retryAt = nextScheduledAt(attemptsUsed);
      this.db.run(
        `UPDATE jobs SET status = 'PENDING', scheduled_at = ?, last_error = ?,
          updated_at = datetime('now') WHERE id = ?`,
        [retryAt, errorMessage, job.id],
      );
    }
  }

  private failJob(jobId: string, errorMessage: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'FAILED', last_error = ?,
        updated_at = datetime('now') WHERE id = ?`,
      [errorMessage, jobId],
    );
    // TODO: notify super-admin of FAILED job
  }
}

// =============================================================================
// JOB HANDLERS
// One function per job type. Each follows the pattern:
//   1. Read all needed data (outside any transaction)
//   2. Compute (pure — no DB writes)
//   3. Write results in a single short transaction
// =============================================================================

/**
 * RESCORE_TASK
 *
 * Recalculates time points for all goal attempts on a task.
 * Triggered after any new goal submission is processed.
 *
 * Steps:
 *   1. Check task is not frozen — if frozen, no-op and complete
 *   2. Load all flight_attempts for the task (reached_goal = true) with current scores
 *   3. Call rescoreTimePoints() from pipeline — pure function, no DB
 *   4. Diff old vs new scores — build scoreChanges map
 *   5. Write updated time_points + total_points in a single transaction
 *   6. Rebuild task_results (best attempt per pilot) in same transaction
 *   7. Enqueue REBUILD_STANDINGS
 *   8. Enqueue NOTIFY_PILOTS with scoreChanges (only if any scores changed)
 */
export async function handleRescoreTask(
  payload: RescoreTaskPayload,
  _jobId: string,
  db: Database,
  queue: JobQueue,
  taskRepo: TaskRepository,
  attemptRepo: AttemptRepository,
): Promise<void> {
  // Step 1: Check freeze
  const task = await taskRepo.findById(payload.taskId);
  if (!task || task.scoresFrozenAt) return; // frozen or deleted — no-op

  // Step 2: Load all attempts for the task
  const allAttempts = await attemptRepo.findAllForTask(payload.taskId) as StoredAttempt[];
  const oldScores = new Map(allAttempts.map(a => [a.id, a.totalPoints]));

  // Step 3: Rescore (pure computation, no DB)
  const { rescoreTimePoints } = await import('./pipeline');
  const updatedAttempts = rescoreTimePoints(allAttempts) as StoredAttempt[];

  // Step 4: Build score change map
  const scoreChanges: Record<string, { oldTotalPoints: number; newTotalPoints: number }> = {};
  for (const attempt of updatedAttempts) {
    const old = oldScores.get(attempt.id) ?? 0;
    if (Math.abs(attempt.totalPoints - old) > 0.001) {
      scoreChanges[attempt.userId] = {
        oldTotalPoints: old,
        newTotalPoints: attempt.totalPoints,
      };
    }
  }

  // Step 5 + 6: Write in single transaction
  db.transaction(() => {
    for (const attempt of updatedAttempts) {
      db.run(
        `UPDATE flight_attempts
         SET time_points = ?, total_points = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [attempt.timePoints, attempt.totalPoints, attempt.id],
      );
    }
    // Rebuild task_results (best attempt per pilot)
    rebuildTaskResults(db, payload.taskId);
  })();

  // Step 7: Enqueue downstream jobs
  await queue.enqueue<RebuildStandingsPayload>('REBUILD_STANDINGS', {
    seasonId: task.seasonId,
    leagueId: payload.leagueId,
  });

  // Step 8: Notify only if scores changed
  if (Object.keys(scoreChanges).length > 0) {
    await queue.enqueue<NotifyPilotsPayload>('NOTIFY_PILOTS', {
      taskId: payload.taskId,
      leagueId: payload.leagueId,
      taskName: task.name,
      scoreChanges,
    });
  }
}

/**
 * FREEZE_TASK_SCORES
 *
 * Scheduled at task creation for the task's close_date.
 * Sets scores_frozen_at, preventing further rescoring.
 *
 * Steps:
 *   1. Check task exists and is not already frozen
 *   2. Set scores_frozen_at = now in a single write
 *   3. Enqueue a final RESCORE_TASK to lock in current time points
 *      (in case any submissions came in between the last rescore and now)
 */
export async function handleFreezeTaskScores(
  payload: FreezeTaskScoresPayload,
  _jobId: string,
  db: Database,
  queue: JobQueue,
): Promise<void> {
  const now = new Date().toISOString();

  const result = db.run(
    `UPDATE tasks
     SET scores_frozen_at = ?, updated_at = datetime('now')
     WHERE id = ? AND scores_frozen_at IS NULL AND deleted_at IS NULL`,
    [now, payload.taskId],
  );

  if (result.changes === 0) return; // already frozen or deleted

  // Final rescore to lock in time points at the moment of freeze
  await queue.enqueue<RescoreTaskPayload>('RESCORE_TASK', {
    taskId: payload.taskId,
    leagueId: payload.leagueId,
    triggeredBySubmissionId: 'FREEZE',
  });
}

/**
 * REBUILD_STANDINGS
 *
 * Recomputes season_standings from task_results.
 * Pure aggregation — sum of best task scores per pilot, then rank.
 *
 * Steps:
 *   1. Load all task_results for all tasks in the season
 *   2. Group by userId — sum total_points across tasks
 *   3. Rank by total_points descending
 *   4. Upsert season_standings in a single transaction
 */
export async function handleRebuildStandings(
  payload: RebuildStandingsPayload,
  _jobId: string,
  db: Database,
): Promise<void> {
  // Aggregate in SQL for efficiency — avoids loading every row into JS
  const standings = db.all<any>(
    `SELECT
       tr.user_id,
       SUM(tr.total_points)    AS total_points,
       COUNT(tr.task_id)       AS tasks_flown,
       SUM(tr.reached_goal)    AS tasks_with_goal
     FROM task_results tr
     JOIN tasks t ON t.id = tr.task_id
     WHERE t.season_id = ?
       AND t.deleted_at IS NULL
       AND tr.deleted_at IS NULL  -- task_results don't have deleted_at but guard anyway
     GROUP BY tr.user_id
     ORDER BY total_points DESC`,
    [payload.seasonId],
  );

  db.transaction(() => {
    standings.forEach((row: any, index: number) => {
      db.run(
        `INSERT INTO season_standings
           (id, season_id, user_id, league_id, total_points, tasks_flown,
            tasks_with_goal, rank, last_computed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
         ON CONFLICT (season_id, user_id) DO UPDATE SET
           total_points     = excluded.total_points,
           tasks_flown      = excluded.tasks_flown,
           tasks_with_goal  = excluded.tasks_with_goal,
           rank             = excluded.rank,
           last_computed_at = excluded.last_computed_at,
           updated_at       = excluded.updated_at`,
        [
          crypto.randomUUID(),
          payload.seasonId,
          row.user_id,
          payload.leagueId,
          row.total_points,
          row.tasks_flown,
          row.tasks_with_goal,
          index + 1, // rank is 1-based
        ],
      );
    });
  })();
}

/**
 * REPROCESS_ALL_SUBMISSIONS
 *
 * Re-parses and re-scores all IGC files for a task after turnpoints change.
 * This is the most expensive job — runs the full pipeline per submission.
 *
 * Steps:
 *   1. Load updated task definition (new turnpoints, new optimised distances)
 *   2. For each submissionId:
 *      a. Load raw IGC from object storage
 *      b. Run full pipeline (parseAndValidate → detectAttempts → score)
 *      c. Delete old flight_attempts and turnpoint_crossings for this submission
 *      d. Write new results in a single transaction
 *   3. After all submissions processed, enqueue RESCORE_TASK
 *      (time points need recalculation with the new field)
 *
 * Important: processes submissions sequentially, not in parallel.
 * Each pipeline run + write transaction must complete before the next starts.
 * This keeps SQLite write contention minimal.
 *
 * If any single submission fails, it logs the error and continues with the rest.
 * The job itself succeeds even if some submissions failed — individual
 * submission errors are recorded on the flight_submission.status_message.
 */
export async function handleReprocessAllSubmissions(
  payload: ReprocessAllSubmissionsPayload,
  _jobId: string,
  db: Database,
  queue: JobQueue,
  taskRepo: TaskRepository,
  storageClient: StorageClient,
): Promise<void> {
  const task = await taskRepo.findByIdWithTurnpoints(payload.taskId);
  if (!task) throw new Error(`Task ${payload.taskId} not found`);

  const { runPipeline } = await import('./pipeline');

  for (const submissionId of payload.submissionIds) {
    try {
      const submission = db.get<any>(
        `SELECT * FROM flight_submissions WHERE id = ? AND deleted_at IS NULL`,
        [submissionId],
      );
      if (!submission) continue;

      // Fetch raw IGC from object storage
      const igcText = await storageClient.get(submission.igc_storage_key);

      // Load current goal times excluding this pilot (for fair time point recalc)
      // These will be recalculated properly by the subsequent RESCORE_TASK job
      const existingGoalTimes: number[] = [];

      const result = await runPipeline(
        {
          igcText,
          task: taskDefinitionFromRecord(task),
          existingGoalTimes,
          competitionType: task.competitionType,
        },
        task.openDate,
        task.closeDate,
        task.scoresFrozenAt,
        0, // bestDistanceKm — will be corrected by RESCORE_TASK
      );

      // Write results in a single transaction
      db.transaction(() => {
        // Clear old attempts for this submission
        db.run(
          `DELETE FROM turnpoint_crossings
           WHERE attempt_id IN (
             SELECT id FROM flight_attempts WHERE submission_id = ?
           )`,
          [submissionId],
        );
        db.run(
          `DELETE FROM flight_attempts WHERE submission_id = ?`,
          [submissionId],
        );

        if (!result.ok) {
          db.run(
            `UPDATE flight_submissions
             SET status = 'INVALID', status_message = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [pipelineErrorMessage(result.error), submissionId],
          );
          return;
        }

        // Write new attempts
        writeAttemptsToDB(db, submissionId, task.id, result.value);

        const bestAttempt = result.value.scoredAttempts[result.value.bestAttemptIndex] as StoredAttempt | undefined;
        db.run(
          `UPDATE flight_submissions
           SET status = 'PROCESSED', best_attempt_id = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [bestAttempt?.id ?? null, submissionId],
        );
      })();

    } catch (err) {
      // Log and continue — don't let one bad submission abort the whole job
      console.error(`Failed to reprocess submission ${submissionId}:`, err);
      db.run(
        `UPDATE flight_submissions
         SET status = 'ERROR', status_message = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [String(err), submissionId],
      );
    }
  }

  // Final rescore to recalculate time points across the new field
  await queue.enqueue<RescoreTaskPayload>('RESCORE_TASK', {
    taskId: payload.taskId,
    leagueId: payload.leagueId,
    triggeredBySubmissionId: 'REPROCESS',
  });
}

/**
 * NOTIFY_PILOTS
 *
 * Fan-out: insert a notification row per affected pilot.
 * Deliberately runs after standings are rebuilt so score values are current.
 *
 * Simple bulk insert — no complex logic.
 */
export async function handleNotifyPilots(
  payload: NotifyPilotsPayload,
  _jobId: string,
  db: Database,
): Promise<void> {
  db.transaction(() => {
    for (const [userId, change] of Object.entries(payload.scoreChanges)) {
      db.run(
        `INSERT INTO notifications (id, user_id, type, payload, created_at)
         VALUES (?, ?, 'SCORE_UPDATED', ?, datetime('now'))`,
        [
          crypto.randomUUID(),
          userId,
          JSON.stringify({
            taskId: payload.taskId,
            taskName: payload.taskName,
            leagueName: payload.leagueId, // resolved to name by notification renderer
            oldTotalPoints: change.oldTotalPoints,
            newTotalPoints: change.newTotalPoints,
            reason: 'RESCORE',
          }),
        ],
      );
    }
  })();
}

// =============================================================================
// JOB DEPENDENCY GRAPH
// Shows which jobs enqueue other jobs.
// =============================================================================

/**
 *
 *  API: new goal submission processed
 *       │
 *       ▼
 *  RESCORE_TASK ──────────────────────────────────────────┐
 *       │                                                  │
 *       ├──► REBUILD_STANDINGS                            │
 *       │                                                  │
 *       └──► NOTIFY_PILOTS (if any scores changed)        │
 *                                                          │
 *  API: task created                                       │
 *       │                                                  │
 *       └──► FREEZE_TASK_SCORES (scheduled at close_date) │
 *                 │                                        │
 *                 └──────────────────────────────────────►┘
 *                    (triggers final RESCORE_TASK)
 *
 *  API: admin edits turnpoints (?force=true)
 *       │
 *       ▼
 *  REPROCESS_ALL_SUBMISSIONS
 *       │
 *       └──► RESCORE_TASK (after all files reprocessed)
 *                 │
 *                 ├──► REBUILD_STANDINGS
 *                 └──► NOTIFY_PILOTS
 */

// =============================================================================
// APPLICATION BOOTSTRAP
// Wires everything together at startup.
// =============================================================================

export function bootstrapWorker(db: Database, queue: SQLiteJobQueue): JobWorker {
  const worker = new JobWorker(db, queue);

  // Repositories and clients injected here (omitted for brevity)
  const taskRepo = new TaskRepository(db);
  const attemptRepo = new AttemptRepository(db);
  const storageClient = new StorageClient();

  worker.register<RescoreTaskPayload>('RESCORE_TASK', (payload, jobId) =>
    handleRescoreTask(payload, jobId, db, queue, taskRepo, attemptRepo));

  worker.register<FreezeTaskScoresPayload>('FREEZE_TASK_SCORES', (payload, jobId) =>
    handleFreezeTaskScores(payload, jobId, db, queue));

  worker.register<RebuildStandingsPayload>('REBUILD_STANDINGS', (payload, jobId) =>
    handleRebuildStandings(payload, jobId, db));

  worker.register<ReprocessAllSubmissionsPayload>('REPROCESS_ALL_SUBMISSIONS', (payload, jobId) =>
    handleReprocessAllSubmissions(payload, jobId, db, queue, taskRepo, storageClient));

  worker.register<NotifyPilotsPayload>('NOTIFY_PILOTS', (payload, jobId) =>
    handleNotifyPilots(payload, jobId, db));

  return worker;
}

// =============================================================================
// STARTUP SEQUENCE (in server entry point)
// =============================================================================

/**
 * async function main() {
 *   const db = openDatabase('./league.db');
 *   const queue = new SQLiteJobQueue(db);
 *   const worker = bootstrapWorker(db, queue);
 *
 *   const app = buildFastifyApp(db, queue);
 *
 *   worker.start();
 *   await app.listen({ port: 3000 });
 *
 *   // Reschedule any FREEZE_TASK_SCORES jobs whose scheduled_at
 *   // passed while the server was down — mark them PENDING so
 *   // the worker picks them up immediately
 *   db.run(
 *     `UPDATE jobs SET status = 'PENDING', updated_at = datetime('now')
 *      WHERE type = 'FREEZE_TASK_SCORES'
 *        AND status = 'PENDING'
 *        AND scheduled_at <= datetime('now')`,
 *   );
 * }
 */

// =============================================================================
// PLACEHOLDER TYPES (implemented elsewhere in the codebase)
// =============================================================================

declare class Database {
  run(sql: string, params?: any[]): { changes: number };
  get<T>(sql: string, params?: any[]): T | null;
  all<T>(sql: string, params?: any[]): T[];
  transaction(fn: () => void): () => void;
}

declare class TaskRepository {
  constructor(db: Database);
  findById(id: string): Promise<any>;
  findByIdWithTurnpoints(id: string): Promise<any>;
}

declare class AttemptRepository {
  constructor(db: Database);
  findAllForTask(taskId: string): Promise<any[]>;
}

declare class StorageClient {
  get(key: string): Promise<string>;
}

declare function rebuildTaskResults(db: Database, taskId: string): void;
declare function writeAttemptsToDB(db: Database, submissionId: string, taskId: string, result: any): void;
declare function taskDefinitionFromRecord(task: any): any;
