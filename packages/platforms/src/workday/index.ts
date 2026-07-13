import type { JobSpec, PlatformRef, ResolvedAnswer } from '@sower/core';
import type {
  PlatformAdapter,
  SubmitFile,
  SubmitOptions,
  SubmitResult,
} from '../contract.js';
import { htmlEntityEncodedToPlainText } from '../description.js';
import { type Recorder, recordedFetch } from '../recorder.js';

/**
 * Workday adapter — READ TIER ONLY (whitepaper Phase 0).
 *
 * Workday exposes an unofficial `cxs` JSON API that serves the job posting
 * (title, description, location, questionnaire IDs) WITHOUT auth. That is the
 * whole of what this adapter does: normalize a posting into a JobSpec so the
 * job is triageable in the pipeline.
 *
 * It deliberately does NOT — and cannot at this tier — reach the application
 * form: Workday's questions live behind an authenticated, per-tenant candidate
 * account and an Akamai-protected browser session (see research/platforms/
 * workday.md). So `discover` returns `formAccess: 'account-required'` with an
 * empty `questions` array, and every submit path throws
 * WorkdayBrowserTierRequiredError. The account + browser tiers (Phases 1-2)
 * land in apps/worker; nothing here ever submits.
 */

const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/;
/** Optional leading locale path segment, e.g. `en-US`, `en-GB`, `fr-CA`. */
const LOCALE_SEG_RE = /^[a-z]{2}-[A-Za-z]{2}$/;

/** Fields we read off the cxs job-detail response. */
interface WorkdayJobPostingInfo {
  title: string;
  jobDescription?: string | null;
  location?: string | null;
  jobReqId?: string | null;
  jobPostingId?: string | null;
  externalUrl?: string | null;
  questionnaireId?: string | null;
  secondaryQuestionnaireId?: string | null;
  canApply?: boolean | null;
  includeResumeParsing?: boolean | null;
}

interface WorkdayJobResponse {
  jobPostingInfo?: WorkdayJobPostingInfo | null;
  hiringOrganization?: { name?: string | null } | null;
}

/** The pieces of a Workday job URL needed to reach the cxs detail endpoint. */
export interface WorkdayJobUrlParts {
  host: string;
  tenant: string;
  /** Career-site path segment, e.g. `Capital_One`, `external_careers`. */
  site: string;
  /** cxs job path, always `/job/...`, reused as the detail path suffix. */
  externalPath: string;
  /** Fully-qualified cxs job-detail URL. */
  cxsDetailUrl: string;
}

/**
 * Thrown when a Workday posting is no longer publicly available. The cxs
 * detail endpoint answers 403 (NOT 404) for jobs that have been unpublished or
 * filled, which is common for the aging URLs that arrive from the listing
 * sources — the caller should treat this as "posting gone", not a transient
 * fault to retry.
 */
export class WorkdayJobUnavailableError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`workday posting is no longer available (HTTP ${status}): ${url}`);
    this.name = 'WorkdayJobUnavailableError';
    this.url = url;
    this.status = status;
  }
}

/** Thrown by every submit path — Workday apply needs the browser/account tier. */
export class WorkdayBrowserTierRequiredError extends Error {
  constructor(action: string) {
    super(
      `workday ${action} requires the account + browser tier (not implemented at the network tier); see research/platforms/workday-plan.md`,
    );
    this.name = 'WorkdayBrowserTierRequiredError';
  }
}

/**
 * Parse a public Workday job URL into the pieces needed to fetch its cxs
 * detail. Handles the observed real-world shapes:
 *   {tenant}.wd{N}.myworkdayjobs.com/[locale/]{site}/(job|details)/{path...}
 * The `{path...}` is reconstructed as the cxs `/job/{path...}` suffix (the cxs
 * API is served under `/wday/cxs/{tenant}/{site}` and always uses `/job/`).
 */
export function parseWorkdayJobUrl(url: string): WorkdayJobUrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid workday url: ${JSON.stringify(url)}`);
  }
  const host = parsed.hostname.toLowerCase();
  const match = host.match(WORKDAY_HOST_RE);
  if (!match?.[1]) {
    throw new Error(`not a workday job url: ${JSON.stringify(url)}`);
  }
  const tenant = match[1];

  let segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments[0] && LOCALE_SEG_RE.test(segments[0])) {
    segments = segments.slice(1);
  }
  const site = segments[0];
  if (!site || segments.length < 2) {
    throw new Error(
      `cannot derive workday site/job path from ${JSON.stringify(url)}`,
    );
  }
  let rest = segments.slice(1);
  // Drop the leading route keyword ('job' or 'details') — cxs always wants
  // '/job/{...}' regardless of which the human-facing URL used.
  if (rest[0] === 'job' || rest[0] === 'details') {
    rest = rest.slice(1);
  }
  if (rest.length === 0) {
    throw new Error(
      `workday job path is empty after the site segment in ${JSON.stringify(url)}`,
    );
  }
  const externalPath = `/job/${rest.join('/')}`;
  const cxsDetailUrl = `https://${host}/wday/cxs/${tenant}/${site}${externalPath}`;
  return { host, tenant, site, externalPath, cxsDetailUrl };
}

export class WorkdayAdapter implements PlatformAdapter {
  readonly platform = 'workday' as const;

  async discover(
    ref: PlatformRef,
    url: string,
    opts?: { recorder?: Recorder },
  ): Promise<JobSpec> {
    const parts = parseWorkdayJobUrl(url);
    const tenant = ref.tenant ?? parts.tenant;

    const response = await recordedFetch(
      opts?.recorder,
      'discover',
      parts.cxsDetailUrl,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    // 403 (unpublished/filled) and 404 both mean "not a live posting anymore".
    if (response.status === 403 || response.status === 404) {
      throw new WorkdayJobUnavailableError(url, response.status);
    }
    if (!response.ok) {
      throw new Error(
        `workday job fetch failed with status ${response.status} for ${parts.cxsDetailUrl}`,
      );
    }
    const payload = (await response.json()) as WorkdayJobResponse;
    const info = payload.jobPostingInfo;
    if (!info?.title) {
      throw new Error(
        `workday job response missing jobPostingInfo.title for ${parts.cxsDetailUrl}`,
      );
    }

    const externalId =
      ref.externalId ??
      info.jobReqId ??
      info.jobPostingId ??
      parts.externalPath;

    const spec: JobSpec = {
      platform: 'workday',
      tenant,
      externalId,
      title: info.title,
      // The human-facing job URL is the right apply landing page; prefer the
      // canonical externalUrl the response advertises when present.
      applyUrl: info.externalUrl ?? url,
      // The real questions live behind the account/browser tier (Phase 2).
      questions: [],
      formAccess: 'account-required',
      meta: {
        site: parts.site,
        externalPath: parts.externalPath,
        questionnaireId: info.questionnaireId ?? null,
        secondaryQuestionnaireId: info.secondaryQuestionnaireId ?? null,
        canApply: info.canApply ?? null,
        includeResumeParsing: info.includeResumeParsing ?? null,
      },
    };

    const company = payload.hiringOrganization?.name?.trim();
    if (company) {
      spec.company = company;
    }
    const location = info.location?.trim();
    if (location) {
      spec.location = location;
    }
    // Workday's jobDescription is raw HTML; the shared helper strips tags (and
    // defensively re-strips any tag reconstructed from encoded entities).
    if (info.jobDescription) {
      spec.descriptionHtml = info.jobDescription;
      spec.description = htmlEntityEncodedToPlainText(info.jobDescription);
    }
    return spec;
  }

  /**
   * GUARDRAIL: there is no network-tier submission payload for Workday — the
   * form is only reachable via an authenticated browser session. Throws so no
   * caller can mistake this adapter for a submittable one.
   */
  buildSubmitPayload(
    _spec: JobSpec,
    _answers: ResolvedAnswer[],
  ): Record<string, unknown> {
    throw new WorkdayBrowserTierRequiredError('payload build');
  }

  async dryRunSubmit(
    _spec: JobSpec,
    _answers: ResolvedAnswer[],
    _files: SubmitFile[],
    _opts?: { recorder?: Recorder },
  ): Promise<{ dryRun: true; payload: Record<string, unknown> }> {
    throw new WorkdayBrowserTierRequiredError('dry-run submit');
  }

  async submit(
    _spec: JobSpec,
    _answers: ResolvedAnswer[],
    _files?: SubmitFile[],
    _opts?: SubmitOptions,
  ): Promise<SubmitResult> {
    throw new WorkdayBrowserTierRequiredError('submit');
  }
}
