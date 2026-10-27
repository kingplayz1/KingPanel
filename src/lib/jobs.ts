export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface OperationJob {
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
  result?: unknown;
}

export interface JobOutcome<T> {
  ok: boolean;
  job: OperationJob | null;
  result: T | null;
  error?: string;
  /** HTTP status of the submitting request (202 for queued work). */
  status: number;
}

export interface FollowJobOptions {
  onProgress?: (job: OperationJob) => void;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const terminal = (status: JobStatus) =>
  status === 'succeeded' ||
  status === 'failed' ||
  status === 'cancelled' ||
  status === 'interrupted';

export async function cancelJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok && data?.ok !== false, error: data?.error };
  } catch {
    return { ok: false, error: 'Could not reach the panel backend.' };
  }
}

export async function waitForJob<T>(
  jobId: string,
  opts: FollowJobOptions = {},
): Promise<JobOutcome<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
  const pollMs = Math.max(250, opts.pollMs ?? 700);
  let job: OperationJob | null = null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { ok: false, job, result: null, error: 'Cancelled', status: 202 };
    }
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        return {
          ok: false,
          job,
          result: null,
          error: String(data?.error || `Job lookup failed (HTTP ${res.status})`),
          status: res.status,
        };
      }
      job = data.job as OperationJob;
      opts.onProgress?.(job);
      if (job.status === 'succeeded') {
        return { ok: true, job, result: (job.result as T) ?? null, status: 200 };
      }
      if (terminal(job.status)) {
        return {
          ok: false,
          job,
          result: null,
          error:
            job.status === 'cancelled'
              ? 'Operation cancelled.'
              : job.status === 'interrupted'
                ? job.error || 'The panel closed before this operation finished.'
                : job.error || job.message || 'Operation failed.',
          status: 200,
        };
      }
    } catch {
      // Transient poll failure; keep trying until the deadline.
    }
    await sleep(pollMs, opts.signal);
  }

  return {
    ok: false,
    job,
    result: null,
    error: 'The operation is taking longer than expected. Check the server workspace again shortly.',
    status: 202,
  };
}

/**
 * Post an operation endpoint. Feature endpoints answer 202 with a job id; the
 * legacy validation errors still return their normal status and JSON body.
 */
export async function submitJob<T>(
  url: string,
  body: unknown,
  opts: FollowJobOptions = {},
): Promise<JobOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      ok: false,
      job: null,
      result: null,
      error: err instanceof Error ? err.message : 'Could not reach the panel backend.',
      status: 0,
    };
  }

  const data = (await res.json().catch(() => null)) as
    | ({ ok?: boolean; jobId?: string; job?: OperationJob; error?: string; code?: string } & Record<
        string,
        unknown
      >)
    | null;

  if (res.status === 202 && data?.jobId) {
    if (data.job) opts.onProgress?.(data.job);
    return waitForJob<T>(data.jobId, opts);
  }

  return {
    ok: res.ok && data?.ok !== false,
    job: data?.job ?? null,
    result: (data as T) ?? null,
    error: data?.error,
    status: res.status,
  };
}
