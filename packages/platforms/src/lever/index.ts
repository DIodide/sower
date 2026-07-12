import type {
  JobSpec,
  PlatformRef,
  Question,
  ResolvedAnswer,
} from '@sower/core';
import type { PlatformAdapter, SubmitFile } from '../contract.js';
import { type Recorder, recordedFetch } from '../recorder.js';
import {
  buildAnswerPayload,
  guardedDryRunOnlySubmit,
  recordDryRunSubmit,
} from '../submit-common.js';

/**
 * Shape from the public Lever postings API:
 * GET https://api.lever.co/v0/postings/{org}/{id}?mode=json
 *
 * IMPORTANT (observed live on leverdemo, 2026-07): this payload carries job
 * CONTENT only. Its `lists` entries are description blocks ("Qualifications",
 * "Duties", ...) — they are NOT application questions, and the public API
 * exposes no application form / custom questions at all. TRUTHFULNESS rule:
 * we therefore always return questions: [] instead of fabricating fields
 * from description content; the task parks NEEDS_INPUT downstream.
 */
interface LeverPostingPayload {
  id: string;
  /** Posting title. */
  text: string;
  categories?: {
    commitment?: string | null;
    department?: string | null;
    location?: string | null;
    team?: string | null;
    allLocations?: string[] | null;
  } | null;
  country?: string | null;
  workplaceType?: string | null;
  hostedUrl?: string | null;
  applyUrl?: string | null;
  /** Description content blocks — never mapped to questions. */
  lists?: { text: string; content: string }[] | null;
}

export class LeverAdapter implements PlatformAdapter {
  readonly platform = 'lever' as const;

  async discover(
    ref: PlatformRef,
    url: string,
    opts?: { recorder?: Recorder },
  ): Promise<JobSpec> {
    const { tenant, externalId } = ref;
    if (!tenant || !externalId) {
      throw new Error(
        `lever discover requires a site tenant and posting id, got tenant=${JSON.stringify(
          tenant,
        )} externalId=${JSON.stringify(externalId)} for url ${url}`,
      );
    }

    const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(
      tenant,
    )}/${encodeURIComponent(externalId)}?mode=json`;
    const response = await recordedFetch(opts?.recorder, 'discover', endpoint, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Lever answers 404 {"ok":false,"error":"Document not found"} for
      // unknown/closed postings.
      throw new Error(
        `lever posting fetch failed with status ${response.status} for ${endpoint}`,
      );
    }
    const payload = (await response.json()) as LeverPostingPayload;
    if (typeof payload?.id !== 'string' || typeof payload?.text !== 'string') {
      throw new Error(
        `lever posting fetch returned an unexpected payload for ${endpoint}`,
      );
    }

    // The public postings API cannot enumerate the application form (its
    // `lists` are job-description content, not questions) — returning zero
    // questions is the only truthful option; never fabricate.
    const questions: Question[] = [];
    console.info(
      `[sower] lever: public postings API does not expose the application form for ${tenant}/${externalId}; returning 0 questions`,
    );

    const spec: JobSpec = {
      platform: 'lever',
      tenant,
      externalId,
      title: payload.text,
      // No display company name in the payload; the tenant slug is the only
      // truthful value available.
      company: tenant,
      applyUrl:
        payload.applyUrl ||
        (payload.hostedUrl ? `${payload.hostedUrl}/apply` : url),
      questions,
    };
    const location = payload.categories?.location ?? payload.country;
    if (location) {
      spec.location = location;
    }
    return spec;
  }

  buildSubmitPayload(
    _spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Record<string, unknown> {
    return buildAnswerPayload(answers);
  }

  /**
   * SAFETY: constructs and records the submission payload REPRESENTATION
   * only. ZERO network I/O — never calls fetch (or any other HTTP client).
   */
  async dryRunSubmit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files: SubmitFile[],
    opts?: { recorder?: Recorder },
  ): Promise<{ dryRun: true; payload: Record<string, unknown> }> {
    const payload = this.buildSubmitPayload(spec, answers);
    return recordDryRunSubmit(spec, payload, files, opts?.recorder);
  }

  /**
   * GUARDRAIL: throws unless SOWER_SUBMIT_ENABLED === 'true'; even then it
   * only logs the dry-run payload. No HTTP request is ever made here.
   */
  async submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Promise<{ dryRun: boolean }> {
    return guardedDryRunOnlySubmit(
      this.platform,
      spec,
      this.buildSubmitPayload(spec, answers),
    );
  }
}
