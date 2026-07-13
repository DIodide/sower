import { type Recorder, recordedFetch } from '../recorder.js';
import {
  parseQuestionnaireDefinition,
  type WorkdayQuestionnaireField,
} from './questionnaire.js';

/**
 * A captured Workday candidate session — everything the calypso API needs to
 * authenticate. Established ONCE per tenant by a browser login (the only
 * reCAPTCHA-gated step; see workday-calypso-api.md) and then replayed for
 * every application over HTTP. Sessions expire, so `capturedAt` lets the caller
 * refresh proactively.
 *
 * SECURITY: `cookie` + `csrfToken` are session secrets — persist them in the
 * vault (never the DB), and the recorder redacts them from api_calls.
 */
export interface WorkdaySession {
  /** e.g. 'datasite.wd1.myworkdayjobs.com'. */
  host: string;
  /** e.g. 'datasite'. */
  tenant: string;
  /** Full Cookie header value (PLAY_SESSION, CALYPSO_SESSION, CSRF, …). */
  cookie: string;
  /** The x-calypso-csrf-token (mirrors the CALYPSO_CSRF_TOKEN cookie). */
  csrfToken: string;
  /** ISO timestamp the session was captured (optional; for expiry heuristics). */
  capturedAt?: string;
}

/** Thrown when a calypso call comes back unauthenticated (session expired). */
export class WorkdaySessionExpiredError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(
      `workday session rejected (HTTP ${status}) for ${url} — re-capture the tenant session`,
    );
    this.name = 'WorkdaySessionExpiredError';
    this.status = status;
  }
}

/** Thrown by finalize() unless the real-submit gate is open. */
export class WorkdayFinalizeGateError extends Error {
  constructor() {
    super(
      'workday finalize refused: SOWER_SUBMIT_ENABLED !== "true". Submission is double-gated and human-approved.',
    );
    this.name = 'WorkdayFinalizeGateError';
  }
}

export interface CalypsoClientOptions {
  fetchImpl?: typeof fetch;
  recorder?: Recorder;
  /** Env lookup (injectable for tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * HTTP client for the Workday calypso application API. Reads the questionnaire
 * and drives every section over plain HTTP using a captured session — no
 * browser, no per-apply captcha.
 *
 * GUARDRAIL: `finalize` (the one call that SUBMITS) throws unless
 * SOWER_SUBMIT_ENABLED === 'true'. Every other method is safe: starting a
 * draft and filling sections never submits an application.
 */
export class CalypsoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly recorder?: Recorder;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly session: WorkdaySession,
    options: CalypsoClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.recorder = options.recorder;
    this.env = options.env ?? process.env;
  }

  private get base(): string {
    return `https://${this.session.host}`;
  }

  private headers(): Record<string, string> {
    return {
      cookie: this.session.cookie,
      'x-calypso-csrf-token': this.session.csrfToken,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private async call(
    phase: string,
    method: 'POST' | 'PUT' | 'GET',
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await recordedFetch(
      this.recorder,
      phase,
      url,
      {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
      this.fetchImpl,
    );
    // 401/403 (and Workday's 302→login) mean the session is dead.
    if (response.status === 401 || response.status === 403) {
      throw new WorkdaySessionExpiredError(response.status, url);
    }
    if (!response.ok) {
      throw new Error(
        `calypso ${method} ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * Start a draft application for a job posting slug (the
   * `{title-slug}_{reqId}` last segment of the job's externalPath). Returns the
   * new jobApplicationId. Does NOT submit.
   */
  async startApplication(
    jobSlug: string,
  ): Promise<{ jobApplicationId: string }> {
    const url = `${this.base}/wday/cxs/${this.session.tenant}/jobpostings/${encodeURIComponent(
      jobSlug,
    )}/jobapplications`;
    const body = (await this.call('start', 'POST', url, {})) as {
      id?: string;
    };
    if (!body.id) {
      throw new Error(
        `calypso start returned no application id for ${jobSlug}`,
      );
    }
    return { jobApplicationId: body.id };
  }

  /** Read + parse a questionnaire definition into fields. */
  async getQuestionnaire(
    questionnaireId: string,
  ): Promise<WorkdayQuestionnaireField[]> {
    const url = `${this.base}/wday/calypso/cxs/common/${this.session.tenant}/questionnaire/${questionnaireId}/definition`;
    const schema = await this.call('questionnaire', 'POST', url, {});
    return parseQuestionnaireDefinition(schema as Record<string, unknown>);
  }

  /**
   * POST one application section (name/emailaddress/phonenumber/address/
   * workexperiences/educations/questionnaireresponses/selfidentify/…). Returns
   * the server's echo. Never submits.
   */
  async fillSection(
    jobApplicationId: string,
    section: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.base}/wday/calypso/cxs/jobapplication/${this.session.tenant}/jobapplication/${jobApplicationId}/${section}`;
    return this.call(`section:${section}`, 'POST', url, body);
  }

  /** Validate the current package (Workday runs this between steps). */
  async validate(jobApplicationId: string): Promise<void> {
    const url = `${this.base}/wday/calypso/cxs/jobapplication/${this.session.tenant}/package/${jobApplicationId}/validate`;
    await this.call('validate', 'PUT', url, {});
  }

  /**
   * Cheap read-only probe that the session is still valid: GET the candidate
   * home applications list. Returns true on 200, false on any error (including
   * the HTTP 500 datasite returns for an expired session). This is the
   * "verify before you trust" primitive the session broker runs before storing
   * a freshly-captured session — a single capture is never assumed good.
   */
  async checkSession(): Promise<boolean> {
    const url = `${this.base}/wday/calypso/cxs/candidatehome/${this.session.tenant}/${this.session.tenant}/applications`;
    try {
      await this.call('checksession', 'GET', url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * SUBMIT the application (POST .../finalize). DOUBLE-GATED: throws unless
   * SOWER_SUBMIT_ENABLED === 'true'. This is the only method that submits;
   * callers must additionally have human approval before opening the gate.
   */
  async finalize(jobApplicationId: string): Promise<{ submitted: true }> {
    if (this.env.SOWER_SUBMIT_ENABLED !== 'true') {
      throw new WorkdayFinalizeGateError();
    }
    const url = `${this.base}/wday/cxs/${this.session.tenant}/jobapplication/${jobApplicationId}/finalize`;
    await this.call('finalize', 'POST', url, {});
    return { submitted: true };
  }
}
