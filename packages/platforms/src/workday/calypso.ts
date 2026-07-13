import { type Recorder, recordedFetch } from '../recorder.js';
import {
  parseWorkdayQuestionnaire,
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
  /**
   * The capturing browser's fingerprint, so the HTTP replay can impersonate the
   * SAME Chrome (TLS target + UA/client-hint headers) — a UA/JA3 contradiction
   * is itself a bot signal. Absent on sessions captured before this existed.
   */
  fingerprint?: WorkdaySessionFingerprint;
}

export interface WorkdaySessionFingerprint {
  /** navigator.userAgent from the capturing browser. */
  userAgent?: string;
  /** Chrome major version (drives the curl-impersonate target). */
  chromeMajor?: number;
  /** Accept-Language the browser sent. */
  acceptLanguage?: string;
  /** The sec-ch-ua client hint string. */
  secChUa?: string;
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
   * POST a multipart body (file upload). Unlike `call`, it does NOT set a
   * content-type header — fetch derives `multipart/form-data; boundary=…` from
   * the FormData itself. Same session auth + dead-session handling as `call`.
   */
  private async callMultipart(
    phase: string,
    url: string,
    form: FormData,
  ): Promise<unknown> {
    const response = await recordedFetch(
      this.recorder,
      phase,
      url,
      {
        method: 'POST',
        headers: {
          cookie: this.session.cookie,
          'x-calypso-csrf-token': this.session.csrfToken,
          accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(30_000),
      },
      this.fetchImpl,
    );
    if (response.status === 401 || response.status === 403) {
      throw new WorkdaySessionExpiredError(response.status, url);
    }
    if (!response.ok) {
      throw new Error(
        `calypso multipart POST ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * Attach a résumé to the application, in the two-step calypso flow observed
   * live (datasite HAR):
   *   1. multipart POST the bytes to `common/{tenant}/attachments` (field
   *      `file`) -> the attachment descriptor `{ file: "oms-attachments/{uuid}",
   *      … }`;
   *   2. JSON POST `{ attachments: [<descriptor>] }` to the application's
   *      `resumeattachments` section, referencing the uploaded file.
   * Never submits. Throws WorkdaySessionExpiredError on a dead session; a
   * missing file ref in the step-1 response throws a clear error.
   */
  async uploadResume(
    jobApplicationId: string,
    resume: { fileName: string; contentType: string; bytes: Uint8Array },
  ): Promise<void> {
    // Step 1: upload the bytes; the response carries the oms attachment ref.
    const uploadUrl = `${this.base}/wday/calypso/cxs/common/${this.session.tenant}/attachments`;
    const form = new FormData();
    // Copy into a fresh ArrayBuffer-backed view so the Blob part is typed
    // ArrayBuffer (not the generic ArrayBufferLike) — resume-sized copy is
    // negligible.
    form.append(
      'file',
      new Blob([Uint8Array.from(resume.bytes)], { type: resume.contentType }),
      resume.fileName,
    );
    const descriptor = (await this.callMultipart(
      'resume:upload',
      uploadUrl,
      form,
    )) as { file?: string; descriptor?: string; id?: string };
    const fileRef = descriptor.file ?? descriptor.descriptor ?? descriptor.id;
    if (typeof fileRef !== 'string' || fileRef.length === 0) {
      throw new Error(
        'calypso resume upload returned no attachment file reference',
      );
    }

    // Step 2: associate the uploaded file with the application's resume section.
    const attachUrl = `${this.base}/wday/calypso/cxs/jobapplication/${this.session.tenant}/jobapplication/${jobApplicationId}/resumeattachments`;
    await this.call('resume:attach', 'POST', attachUrl, {
      attachments: [
        {
          fileName: resume.fileName,
          fileLength: resume.bytes.byteLength,
          contentType: { id: `Content_Type_ID=${resume.contentType}` },
          file: fileRef,
        },
      ],
    });
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

  /**
   * Read the questionnaire fields WITH options + conditional branches. Uses
   * `GET .../questionnaire/{id}` (NOT the shallow `/definition` POST, which
   * omits options and 500s out of context) — validated live against CACI.
   */
  async getQuestionnaire(
    questionnaireId: string,
  ): Promise<WorkdayQuestionnaireField[]> {
    const url = `${this.base}/wday/calypso/cxs/common/${this.session.tenant}/questionnaire/${questionnaireId}`;
    const response = await this.call('questionnaire', 'GET', url);
    return parseWorkdayQuestionnaire(response as { questions?: unknown[] });
  }

  /**
   * Fetch the questionnaire fields WITH choice options attached, in the
   * application context. The definition schema is shallow (no options), so the
   * options come from the live in-context call. `attachOptions` is injected by
   * the caller that knows the (tenant-specific, live-discovered) option source;
   * when omitted, fields come back without options (choice questions then fall
   * to the human).
   */
  async getQuestionnaireFields(
    _jobApplicationId: string,
    questionnaireId: string,
    attachOptions?: (
      fields: WorkdayQuestionnaireField[],
    ) => Promise<WorkdayQuestionnaireField[]>,
  ): Promise<WorkdayQuestionnaireField[]> {
    const fields = await this.getQuestionnaire(questionnaireId);
    return attachOptions ? attachOptions(fields) : fields;
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
   * home USER PROFILE. Returns true on 200, false on any error. This is the
   * "verify before you trust" primitive the session broker runs before storing
   * a freshly-captured session — a single capture is never assumed good.
   *
   * NB: uses `userprofile`, NOT `applications` — the applications endpoint
   * returns HTTP 500 for a fresh/empty candidate home even on a VALID session
   * (observed live), so it is a false-negative health check. userprofile is a
   * reliable authenticated 200.
   */
  async checkSession(): Promise<boolean> {
    const url = `${this.base}/wday/calypso/cxs/candidatehome/${this.session.tenant}/${this.session.tenant}/userprofile`;
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
