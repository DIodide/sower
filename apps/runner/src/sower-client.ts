/**
 * Client for the sower api's fill-jobs routes. Shapes follow the fill
 * contract verbatim (apps/api owns the routes); fetch is injected so the
 * mapping is testable without a network. The token travels only in the
 * x-api-key header.
 */

export type FillQuestionType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'file';

export interface FillOption {
  label: string;
  value: string;
}

export interface FillQuestion {
  id: string;
  label: string;
  type: FillQuestionType;
  required: boolean;
  options: FillOption[];
  /** Raw input values to enter; null when unanswered (file questions always null). */
  values: string[] | null;
}

export interface ClaimedFillJob {
  id: string;
  taskId: string;
}

export interface FillPayload {
  applyUrl: string;
  company: string;
  title: string;
  questions: FillQuestion[];
}

export type FillOutcome = 'filled' | 'skipped' | 'failed';

export interface FillReportItem {
  questionId: string;
  label: string;
  outcome: FillOutcome;
  detail?: string;
}

export interface FillReportBody {
  status: 'running' | 'ready';
  liveViewUrl?: string;
  report?: FillReportItem[];
}

export interface SowerClient {
  /** null when the queue is empty. */
  claim(): Promise<{ job: ClaimedFillJob; payload: FillPayload } | null>;
  report(jobId: string, body: FillReportBody): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
}

export interface SowerClientDeps {
  base: string;
  token: string;
  fetch: typeof fetch;
}

async function post(
  deps: SowerClientDeps,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await deps.fetch(`${deps.base}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': deps.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error body: the status alone names the failure.
  }
  if (!response.ok) {
    const message =
      data !== null &&
      typeof data === 'object' &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return data;
}

export function makeSowerClient(deps: SowerClientDeps): SowerClient {
  return {
    async claim() {
      const data = (await post(deps, '/fill-jobs/claim')) as {
        job: ClaimedFillJob | null;
        payload?: FillPayload;
      };
      if (data.job === null || data.job === undefined) {
        return null;
      }
      if (data.payload === undefined) {
        throw new Error('/fill-jobs/claim returned a job without a payload');
      }
      return { job: data.job, payload: data.payload };
    },
    async report(jobId, body) {
      await post(deps, `/fill-jobs/${jobId}/report`, body);
    },
    async fail(jobId, error) {
      await post(deps, `/fill-jobs/${jobId}/fail`, {
        error: error.slice(0, 2000),
      });
    },
    async heartbeat(jobId) {
      await post(deps, `/fill-jobs/${jobId}/heartbeat`);
    },
  };
}
