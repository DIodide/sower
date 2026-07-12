import type {
  JobSpec,
  PlatformRef,
  Question,
  QuestionOption,
  ResolvedAnswer,
} from '@sower/core';
import type { PlatformAdapter, SubmitFile } from '../contract.js';
import { type Recorder, recordedFetch } from '../recorder.js';
import {
  buildAnswerPayload,
  guardedDryRunOnlySubmit,
  recordDryRunSubmit,
} from '../submit-common.js';

// Lever's hosted apply page is behind Cloudflare and rejects non-browser
// clients; a realistic UA gets the server-rendered form HTML. (From a
// datacenter IP the CDN may still challenge — that is the whitepaper's
// datacenter-IP limitation, handled by falling back to zero questions.)
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Options for a radio/checkbox group with the given field name: each is an
 * `<input name="{nid}" value="X"><span class="application-answer-alternative">X`.
 * Filtering by name keeps a later field's options from bleeding in.
 */
function extractChoiceOptions(block: string, nid: string): QuestionOption[] {
  const options: QuestionOption[] = [];
  const re = new RegExp(
    `name="${nid}"[^>]*value="([^"]*)"[^>]*\\/?>\\s*<span class="application-answer-alternative"[^>]*>([\\s\\S]*?)<\\/span>`,
    'g',
  );
  for (const m of block.matchAll(re)) {
    const label = stripTags(m[2] ?? '');
    // Lever uses the human text as both label and submit value.
    if (label) options.push({ label, value: m[1] ?? label });
  }
  return options;
}

/** Options for a native <select>. */
function extractSelectOptions(block: string): QuestionOption[] {
  const options: QuestionOption[] = [];
  for (const m of block.matchAll(
    /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g,
  )) {
    const label = stripTags(m[2] ?? '');
    // Skip the empty placeholder option.
    if (label && m[1]) options.push({ label, value: m[1] });
  }
  return options;
}

/**
 * Parse Lever's server-rendered application form. Each field is a
 * `<li class="application-question">` carrying a label, a primary input whose
 * `name` is the submit key, and (for choices) radio/checkbox/select options.
 * Deterministic and truthful: fields with no label or input are skipped, never
 * fabricated. EEO/demographic inputs live outside these blocks and are left to
 * the human by design.
 */
export function parseLeverApplicationForm(html: string): Question[] {
  const questions: Question[] = [];
  const marker = '<li class="application-question';
  // Split on the question marker rather than matching balanced <li> tags:
  // choice fields nest an <li> per option, which a non-greedy </li> would
  // truncate. Each segment runs until the next question begins.
  const segments = html.split(marker).slice(1);
  for (const raw of segments) {
    // Trim trailing content past this question's field list.
    const endIdx = raw.indexOf('</ul></form>');
    const block = endIdx === -1 ? raw : raw.slice(0, endIdx);

    const labelMatch = block.match(
      /class="application-label[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="application-field/,
    );
    const rawLabel = stripTags(labelMatch?.[1] ?? '');
    const nameMatch = block.match(/name="([^"]+)"/);
    if (!rawLabel || !nameMatch) continue;
    // Lever marks required fields with a trailing ✱; strip it from the label
    // and use its presence as the required signal.
    const required =
      rawLabel.includes('✱') ||
      /<(?:input|textarea|select)[^>]*\brequired\b/.test(block);
    const label = rawLabel.replace(/[✱*]\s*$/, '').trim();
    const id = nameMatch[1] as string;
    // Scope type/option detection to THIS field's name — a segment can also
    // contain the following EEO/demographic inputs, whose options must not
    // bleed into a plain URL/text field.
    const nid = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasName = (frag: string) =>
      new RegExp(`<${frag}[^>]*name="${nid}"`).test(block);

    let type: Question['type'] = 'text';
    let options: QuestionOption[] | undefined;
    if (
      id === 'resume' ||
      new RegExp(`type="file"[^>]*name="${nid}"`).test(block)
    ) {
      // Lever's resume/CV upload — resolves from a stored document by kind.
      type = 'file';
    } else if (hasName('textarea')) {
      type = 'textarea';
    } else if (hasName('select')) {
      type = 'select';
      const sel = block.match(
        new RegExp(`<select[^>]*name="${nid}"[\\s\\S]*?</select>`),
      );
      options = extractSelectOptions(sel?.[0] ?? '');
    } else if (new RegExp(`type="checkbox"[^>]*name="${nid}"`).test(block)) {
      type = 'multiselect';
      options = extractChoiceOptions(block, nid);
    } else if (new RegExp(`type="radio"[^>]*name="${nid}"`).test(block)) {
      type = 'select';
      options = extractChoiceOptions(block, nid);
    }

    const question: Question = { id, label, type, required };
    if (options && options.length > 0) question.options = options;
    questions.push(question);
  }
  return questions;
}

/**
 * Fetch and parse Lever's hosted apply-page form. Returns [] on any failure
 * (non-200, Cloudflare challenge from a datacenter IP, parse miss) — never
 * fabricates questions.
 */
export async function fetchLeverApplicationForm(
  applyUrl: string,
  recorder?: Recorder,
): Promise<Question[]> {
  const response = await recordedFetch(recorder, 'discover_form', applyUrl, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];
  const html = await response.text();
  return parseLeverApplicationForm(html);
}

/**
 * Shape from the public Lever postings API:
 * GET https://api.lever.co/v0/postings/{org}/{id}?mode=json
 *
 * IMPORTANT (observed live on leverdemo, 2026-07): this payload carries job
 * CONTENT only. Its `lists` entries are description blocks ("Qualifications",
 * "Duties", ...) — NOT application questions. The real form is parsed from the
 * hosted apply page's HTML (parseLeverApplicationForm); the postings API is
 * used only for the title/company/location.
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

    // The postings JSON carries no form; parse it from the hosted apply page's
    // server-rendered HTML (its `lists` are job-description content, not
    // questions). Any fetch/parse failure yields zero questions — never
    // fabricated — and the task parks NEEDS_INPUT downstream.
    const applyUrl =
      payload.applyUrl ||
      (payload.hostedUrl
        ? `${payload.hostedUrl}/apply`
        : `https://jobs.lever.co/${tenant}/${externalId}/apply`);
    const questions = await fetchLeverApplicationForm(applyUrl, opts?.recorder);
    if (questions.length === 0) {
      console.info(
        `[sower] lever: could not read the application form for ${tenant}/${externalId} (Cloudflare challenge or empty form); returning 0 questions`,
      );
    }

    const spec: JobSpec = {
      platform: 'lever',
      tenant,
      externalId,
      title: payload.text,
      // No display company name in the payload; the tenant slug is the only
      // truthful value available.
      company: tenant,
      applyUrl,
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
