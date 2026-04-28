// =============================================================================
// XC / Hike & Fly League Platform — Job Queue
//
// Infrastructure: SQLiteJobQueue + JobWorker (better-sqlite3 native API).
// Scoring is fully synchronous (rebuildTaskResults runs inline on upload and
// delete paths) so the queue currently has no registered handlers. The
// infrastructure stays for future async work (notifications, reprocessing).
//
// Single-process design: Fastify API + worker loop share one SQLite connection.
// Worker wakes immediately on job enqueue via EventEmitter; polling fallback
// every 30 s catches jobs missed during restart.
// =============================================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { computeDistancePoints, computeTimePoints } from './shared/task-engine';

// ── Minimal typed EventEmitter (no @types/node dependency) ───────────────────

class TypedEmitter {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}

// =============================================================================
// JOB PAYLOAD TYPES
//
// No job types are registered today — scoring is synchronous. The generic
// JobType / JobPayload aliases let future async work (notifications, IGC
// re-parsing on turnpoint edits, etc.) plug into the same infrastructure.
// =============================================================================

export type JobType = string;
export type JobPayload = unknown;

export interface JobRecord {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueOptions {
  scheduledAt?: Date;
  maxAttempts?: number;
}

export interface JobQueue {
  enqueue<T>(type: string, payload: T, options?: EnqueueOptions): Promise<string>;
}

// =============================================================================
// RETRY SCHEDULE
// =============================================================================

const RETRY_DELAYS_MS = [30 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

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

  async enqueue<T>(type: string, payload: T, options: EnqueueOptions = {}): Promise<string> {
    const id = randomUUID();
    const scheduledAt = (options.scheduledAt ?? new Date()).toISOString();
    const maxAttempts = options.maxAttempts ?? 3;

    this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(id, type, JSON.stringify(payload), maxAttempts, scheduledAt);

    this.emit('job:enqueued', { id, type });
    return id;
  }
}

// =============================================================================
// WORKER
// =============================================================================

type JobHandler<T> = (payload: T, jobId: string) => Promise<void>;

export class JobWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, JobHandler<any>>();

  constructor(
    private readonly db: Database,
    private readonly queue: SQLiteJobQueue,
  ) {
    (queue as TypedEmitter).on('job:enqueued', () => this.processNext());
  }

  register<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    this.running = true;
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
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
       WHERE status = 'PENDING' AND datetime(scheduled_at) <= datetime('now')
       ORDER BY datetime(scheduled_at) ASC LIMIT 1`,
      )
      .get() as any;

    if (!row) return null;

    this.db
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', started_at = datetime('now'),
         attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`,
      )
      .run(row.id);

    return { ...row, payload: JSON.parse(row.payload) };
  }

  private completeJob(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'COMPLETE', completed_at = datetime('now'),
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(jobId);
  }

  private handleJobError(job: JobRecord, message: string): void {
    if (job.attempts >= job.maxAttempts) {
      this.failJob(job.id, message);
    } else {
      this.db
        .prepare(
          `UPDATE jobs SET status = 'PENDING', scheduled_at = ?, last_error = ?,
           updated_at = datetime('now') WHERE id = ?`,
        )
        .run(nextScheduledAt(job.attempts), message, job.id);
    }
  }

  private failJob(jobId: string, message: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'FAILED', last_error = ?,
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(message, jobId);
  }
}

// =============================================================================
// SHARED UTILITY: rebuild task_results
//
// Materialised best-attempt-per-pilot cache for a task. Re-scores from
// canonical inputs (current best distance + full goal-times set) every call,
// so the result reflects the live state of the task. Safe to call after
// any change to flight_attempts (upload, soft-delete, undelete).
//
// Wraps the DELETE + recompute + INSERTs in a transaction so callers never
// see a partially-rebuilt cache. better-sqlite3 transactions are reentrant
// (nested calls become savepoints), so this is safe whether or not the
// caller has already opened one.
// =============================================================================

interface ScoredAttemptRow {
  id: string;
  user_id: string;
  distance_flown_km: number;
  reached_goal: number;
  task_time_s: number | null;
  has_flagged_crossings: number;
  distance_points: number;
  time_points: number;
  total_points: number;
}

// Goal first, then highest points, then fastest time (NULLs last).
// Returns negative if a is the better attempt.
function compareBestAttempt(a: ScoredAttemptRow, b: ScoredAttemptRow): number {
  if (a.reached_goal !== b.reached_goal) return b.reached_goal - a.reached_goal;
  if (a.total_points !== b.total_points) return b.total_points - a.total_points;
  const at = a.task_time_s ?? Number.POSITIVE_INFINITY;
  const bt = b.task_time_s ?? Number.POSITIVE_INFINITY;
  return at - bt;
}

export function rebuildTaskResults(db: Database, taskId: string): void {
  db.transaction(() => rebuildTaskResultsInner(db, taskId))();
}

function rebuildTaskResultsInner(db: Database, taskId: string): void {
  db.prepare('DELETE FROM task_results WHERE task_id = ?').run(taskId);

  const attempts = db
    .prepare(
      `SELECT id, user_id, distance_flown_km, reached_goal, task_time_s, has_flagged_crossings
       FROM flight_attempts
       WHERE task_id = ? AND deleted_at IS NULL`,
    )
    .all(taskId) as Array<{
    id: string;
    user_id: string;
    distance_flown_km: number;
    reached_goal: number;
    task_time_s: number | null;
    has_flagged_crossings: number;
  }>;

  if (attempts.length === 0) return;

  // Re-score from canonical inputs. The previously-stored point values on
  // flight_attempts are ignored — they reflect submission-time state, not
  // current task state. This is the single source of truth for scoring.
  const bestDistKm = Math.max(...attempts.map((a) => a.distance_flown_km));
  const goalTimes = attempts
    .filter((a) => a.reached_goal === 1 && a.task_time_s !== null)
    .map((a) => a.task_time_s as number);

  const scored: ScoredAttemptRow[] = attempts.map((a) => {
    const distance_points = computeDistancePoints(a.distance_flown_km, bestDistKm, a.reached_goal === 1);
    const time_points =
      a.reached_goal === 1 && a.task_time_s !== null ? computeTimePoints(a.task_time_s, goalTimes) : 0;
    const total_points = Math.round((distance_points + time_points) * 10) / 10;
    return { ...a, distance_points, time_points, total_points };
  });

  // Pick best attempt per pilot.
  const bestByPilot = new Map<string, ScoredAttemptRow>();
  for (const a of scored) {
    const cur = bestByPilot.get(a.user_id);
    if (!cur || compareBestAttempt(a, cur) < 0) bestByPilot.set(a.user_id, a);
  }
  let bestList = Array.from(bestByPilot.values());

  // Optional task-level normalisation: scale distance_points and time_points
  // independently so the winner's total = normalized_score. Computing both
  // components under the same scale and re-deriving total preserves the
  // dp + tp = total invariant (the previous implementation rounded total and
  // dp separately, then derived tp = total - dp, drifting by ±1).
  const taskRow = db.prepare(`SELECT normalized_score FROM tasks WHERE id = ?`).get(taskId) as
    | { normalized_score: number | null }
    | undefined;
  const normalized = taskRow?.normalized_score ?? 1000;

  if (normalized !== null && bestList.length > 0) {
    const winnerTotal = Math.max(...bestList.map((r) => r.total_points));
    if (winnerTotal > 0) {
      const scale = normalized / winnerTotal;
      bestList = bestList.map((r) => {
        const distance_points = Math.round(r.distance_points * scale * 10) / 10;
        const time_points = Math.round(r.time_points * scale * 10) / 10;
        const total_points = Math.round((distance_points + time_points) * 10) / 10;
        return { ...r, distance_points, time_points, total_points };
      });
    }
  }

  // Rank by total_points DESC, task_time_s ASC (NULLs last), reached_goal DESC.
  // Ties share a rank (RANK semantics, matching the previous SQL window).
  bestList.sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    const at = a.task_time_s ?? Number.POSITIVE_INFINITY;
    const bt = b.task_time_s ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return b.reached_goal - a.reached_goal;
  });

  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO task_results (
      id, task_id, user_id, best_attempt_id,
      distance_flown_km, reached_goal, task_time_s,
      distance_points, time_points, total_points, has_flagged_crossings,
      rank, last_computed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let prevKey: string | null = null;
  let prevRank = 0;
  for (let i = 0; i < bestList.length; i++) {
    const r = bestList[i];
    const key = `${r.total_points}|${r.task_time_s ?? 'null'}|${r.reached_goal}`;
    const rank = key === prevKey ? prevRank : i + 1;
    prevKey = key;
    prevRank = rank;
    ins.run(
      randomUUID(),
      taskId,
      r.user_id,
      r.id,
      r.distance_flown_km,
      r.reached_goal,
      r.task_time_s,
      r.distance_points,
      r.time_points,
      r.total_points,
      r.has_flagged_crossings,
      rank,
      now,
      now,
      now,
    );
  }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

export function bootstrapWorker(db: Database, queue: SQLiteJobQueue): JobWorker {
  return new JobWorker(db, queue);
}
