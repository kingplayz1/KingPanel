import crypto from 'crypto';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface JobProgressPatch {
  /** 0-100, or null when the stage has no measurable percentage. */
  percent?: number | null;
  stage?: string;
  message?: string;
}

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  report: (patch: JobProgressPatch) => void;
  /** Throws JobCancelledError when the operator cancelled the job. */
  throwIfCancelled: () => void;
}

export interface JobRecord {
  id: string;
  kind: string;
  title: string;
  serverId: string | null;
  serverName: string | null;
  status: JobStatus;
  progress: number | null;
  stage: string | null;
  message: string | null;
  error: string | null;
  actor: string;
  cancellable: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
}

export interface JobStartSpec {
  kind: string;
  title: string;
  serverId?: string;
  serverName?: string;
  actor?: string;
  cancellable?: boolean;
  /** Defaults to serverId. Lock keys are compared case-insensitively. */
  lockKey?: string;
  run: (ctx: JobContext) => Promise<unknown>;
}

export class JobCancelledError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

interface SqliteStatementLike {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}

interface SqliteLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatementLike;
}

interface LockHolder {
  jobId: string | null;
  label: string;
  acquiredAt: number;
}

const ACTIVE_STATUSES: JobStatus[] = ['queued', 'running', 'cancelling'];
const MAX_RETAINED_JOBS = 200;
const DB_WRITE_THROTTLE_MS = 250;

const isActive = (status: JobStatus) => ACTIVE_STATUSES.includes(status);

export class JobManager {
  private readonly db: SqliteLike | null;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly locks = new Map<string, LockHolder>();
  private readonly lastDbWrite = new Map<string, number>();

  constructor(db: SqliteLike | null) {
    this.db = db;
    if (this.db) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS operation_jobs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            server_id TEXT,
            server_name TEXT,
            status TEXT NOT NULL,
            progress INTEGER,
            stage TEXT,
            message TEXT,
            error TEXT,
            actor TEXT NOT NULL,
            cancellable INTEGER DEFAULT 1,
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_operation_jobs_server
            ON operation_jobs (server_id, created_at);
        `);
      } catch {
        // Keep running with the in-memory map if the table cannot be created.
      }
    }
    this.recoverInterrupted();
  }

  /**
   * Jobs left queued/running by a previous panel process are not still running —
   * their promises died with that process. Report them as interrupted instead of
   * leaving the UI waiting forever.
   */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    let changed = 0;
    if (this.db) {
      try {
        const rows = this.db
          .prepare(`SELECT id FROM operation_jobs WHERE status IN ('queued','running','cancelling')`)
          .all();
        for (const row of rows) {
          this.db
            .prepare(
              `UPDATE operation_jobs
               SET status='interrupted', error=?, updated_at=?, finished_at=?
               WHERE id=?`,
            )
            .run('The panel closed before this operation finished.', now, now, String(row.id));
          changed += 1;
        }
      } catch {
        // ignore
      }
    }
    for (const [id, job] of this.jobs.entries()) {
      if (isActive(job.status)) {
        this.jobs.set(id, {
          ...job,
          status: 'interrupted',
          error: 'The panel closed before this operation finished.',
          updatedAt: now,
          finishedAt: now,
        });
        changed += 1;
      }
    }
    return changed;
  }

  private lockKey(serverId?: string): string | null {
    const key = String(serverId || '').trim().toLowerCase();
    return key || null;
  }

  private persist(job: JobRecord, force = false): void {
    if (!this.db) return;
    const last = this.lastDbWrite.get(job.id) || 0;
    if (!force && Date.now() - last < DB_WRITE_THROTTLE_MS) return;
    this.lastDbWrite.set(job.id, Date.now());
    try {
      this.db
        .prepare(
          `INSERT INTO operation_jobs (
             id, kind, title, server_id, server_name, status, progress, stage, message,
             error, actor, cancellable, result_json, created_at, updated_at, started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status,
             progress=excluded.progress,
             stage=excluded.stage,
             message=excluded.message,
             error=excluded.error,
             cancellable=excluded.cancellable,
             result_json=excluded.result_json,
             updated_at=excluded.updated_at,
             started_at=excluded.started_at,
             finished_at=excluded.finished_at`,
        )
        .run(
          job.id,
          job.kind,
          job.title,
          job.serverId,
          job.serverName,
          job.status,
          job.progress,
          job.stage,
          job.message,
          job.error,
          job.actor,
          job.cancellable ? 1 : 0,
          job.result === undefined ? null : JSON.stringify(job.result),
          job.createdAt,
          job.updatedAt,
          job.startedAt,
          job.finishedAt,
        );
    } catch {
      // The in-memory record is still authoritative for this process.
    }
  }

  private prune(): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `DELETE FROM operation_jobs
           WHERE id NOT IN (
             SELECT id FROM operation_jobs ORDER BY created_at DESC LIMIT ${MAX_RETAINED_JOBS}
           )`,
        )
        .run();
    } catch {
      // ignore
    }
  }

  private fromRow(row: Record<string, unknown>): JobRecord {
    let result: unknown = null;
    if (row.result_json) {
      try {
        result = JSON.parse(String(row.result_json));
      } catch {
        result = null;
      }
    }
    return {
      id: String(row.id),
      kind: String(row.kind),
      title: String(row.title),
      serverId: row.server_id ? String(row.server_id) : null,
      serverName: row.server_name ? String(row.server_name) : null,
      status: String(row.status) as JobStatus,
      progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
      stage: row.stage ? String(row.stage) : null,
      message: row.message ? String(row.message) : null,
      error: row.error ? String(row.error) : null,
      actor: String(row.actor || 'Operator'),
      cancellable: Boolean(row.cancellable),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      result,
    };
  }

  get(id: string): JobRecord | null {
    const memory = this.jobs.get(id);
    if (memory) return memory;
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT * FROM operation_jobs WHERE id = ?').get(id);
      return row ? this.fromRow(row) : null;
    } catch {
      return null;
    }
  }

  list(opts: { serverId?: string; limit?: number } = {}): JobRecord[] {
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
    const filter = String(opts.serverId || '').trim();
    if (this.db) {
      try {
        const rows = filter
          ? this.db
              .prepare(
                `SELECT * FROM operation_jobs
                 WHERE lower(server_id) = lower(?)
                 ORDER BY created_at DESC LIMIT ?`,
              )
              .all(filter, limit)
          : this.db
              .prepare('SELECT * FROM operation_jobs ORDER BY created_at DESC LIMIT ?')
              .all(limit);
        if (rows.length) return rows.map((row) => this.fromRow(row));
      } catch {
        // fall through to memory
      }
    }
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (filter
      ? all.filter((j) => (j.serverId || '').toLowerCase() === filter.toLowerCase())
      : all
    ).slice(0, limit);
  }

  activeForServer(serverId: string): JobRecord | null {
    const key = this.lockKey(serverId);
    if (!key) return null;
    const holder = this.locks.get(key);
    if (!holder?.jobId) return null;
    const job = this.jobs.get(holder.jobId);
    return job && isActive(job.status) ? job : null;
  }

  /** Used by destructive synchronous work (delete) to exclude job runners. */
  isLocked(serverId: string): boolean {
    const key = this.lockKey(serverId);
    return Boolean(key && this.locks.has(key));
  }

  acquireLock(serverId: string, label: string): (() => void) | null {
    const key = this.lockKey(serverId);
    if (!key) return () => undefined;
    if (this.locks.has(key)) return null;
    this.locks.set(key, { jobId: null, label, acquiredAt: Date.now() });
    return () => {
      const holder = this.locks.get(key);
      if (holder?.label === label && !holder.jobId) this.locks.delete(key);
    };
  }

  start(spec: JobStartSpec): { ok: true; job: JobRecord } | { ok: false; code: string; active?: JobRecord } {
    const lockKey = this.lockKey(spec.lockKey ?? spec.serverId);
    if (lockKey && this.locks.has(lockKey)) {
      const holder = this.locks.get(lockKey);
      const active = holder?.jobId ? this.jobs.get(holder.jobId) || null : null;
      return {
        ok: false,
        code: 'SERVER_LOCKED',
        active: active || undefined,
      };
    }

    const id = `job-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const job: JobRecord = {
      id,
      kind: spec.kind,
      title: spec.title,
      serverId: spec.serverId ? String(spec.serverId) : null,
      serverName: spec.serverName ? String(spec.serverName) : null,
      status: 'queued',
      progress: 0,
      stage: 'queued',
      message: 'Waiting for the background worker…',
      error: null,
      actor: String(spec.actor || 'Operator'),
      cancellable: spec.cancellable !== false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      result: null,
    };
    this.jobs.set(id, job);
    if (lockKey) this.locks.set(lockKey, { jobId: id, label: `${spec.kind}:${id}`, acquiredAt: Date.now() });
    this.persist(job, true);
    this.prune();

    const controller = new AbortController();
    this.controllers.set(id, controller);

    void this.execute(job, spec, controller, lockKey);
    return { ok: true, job: { ...job } };
  }

  private update(job: JobRecord, patch: Partial<JobRecord>, force = false): JobRecord {
    const next: JobRecord = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(next.id, next);
    this.persist(next, force);
    return next;
  }

  private async execute(
    initial: JobRecord,
    spec: JobStartSpec,
    controller: AbortController,
    lockKey: string | null,
  ): Promise<void> {
    let job = initial;
    try {
      job = this.update(
        job,
        {
          status: 'running',
          startedAt: new Date().toISOString(),
          stage: 'starting',
          message: 'Operation started.',
        },
        true,
      );

      const ctx: JobContext = {
        jobId: job.id,
        signal: controller.signal,
        report: (patch) => {
          if (controller.signal.aborted) return;
          const percent =
            patch.percent === undefined
              ? job.progress
              : patch.percent === null
                ? null
                : Math.max(0, Math.min(100, Math.round(patch.percent)));
          job = this.update(job, {
            progress: percent,
            stage: patch.stage ?? job.stage,
            message: patch.message ?? job.message,
          });
        },
        throwIfCancelled: () => {
          if (controller.signal.aborted) throw new JobCancelledError();
        },
      };

      const result = await spec.run(ctx);

      if (controller.signal.aborted) {
        this.update(
          job,
          {
            status: 'cancelled',
            stage: 'cancelled',
            message: 'Cancelled by the operator.',
            finishedAt: new Date().toISOString(),
          },
          true,
        );
      } else {
        const finished = this.update(
          job,
          {
            status: 'succeeded',
            progress: 100,
            stage: 'done',
            message: 'Completed.',
            result: result ?? null,
            finishedAt: new Date().toISOString(),
          },
          true,
        );
        job = finished;
      }
    } catch (err) {
      const cancelled = controller.signal.aborted || err instanceof JobCancelledError;
      const message =
        cancelled
          ? 'Cancelled by the operator.'
          : err instanceof Error
            ? err.message
            : 'Operation failed';
      this.update(
        job,
        {
          status: cancelled ? 'cancelled' : 'failed',
          stage: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? null : message,
          message,
          finishedAt: new Date().toISOString(),
        },
        true,
      );
    } finally {
      this.controllers.delete(job.id);
      if (lockKey) {
        const holder = this.locks.get(lockKey);
        if (holder?.jobId === job.id) this.locks.delete(lockKey);
      }
    }
  }

  cancel(id: string): { ok: boolean; job?: JobRecord; error?: string } {
    const job = this.jobs.get(id) || this.get(id);
    if (!job) return { ok: false, error: 'Job not found' };
    if (!isActive(job.status)) return { ok: false, job, error: `Job already ${job.status}` };
    if (!job.cancellable) return { ok: false, job, error: 'This operation cannot be cancelled' };
    const controller = this.controllers.get(id);
    if (!controller) {
      const next = this.update(
        job,
        {
          status: 'cancelled',
          stage: 'cancelled',
          message: 'Cancelled by the operator.',
          finishedAt: new Date().toISOString(),
        },
        true,
      );
      return { ok: true, job: next };
    }
    const next = this.update(
      job,
      { status: 'cancelling', stage: 'cancelling', message: 'Cancelling…' },
      true,
    );
    controller.abort();
    return { ok: true, job: next };
  }
}
