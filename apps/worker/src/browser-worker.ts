/**
 * Browser-tier scaffold (whitepaper T1/T2/T3). SCAFFOLD ONLY — nothing here
 * drives a real browser yet, and nothing here may ever submit an application.
 *
 * Tier ladder:
 * - T0 network (DONE, lives in @sower/platforms, runs inside apps/api):
 *   greenhouse/ashby/lever public-API discover + dry-run submit. No browser.
 * - T1 scripted: per-platform Playwright scripts fill known form layouts.
 * - T2 script+LLM: T1 scripts with an LLM fallback (Stagehand-style) for
 *   fields the script does not recognize.
 * - T3 agent: a browser agent handles arbitrary flows end to end.
 *
 * GUARDRAILS (apply to every future implementation of this interface):
 * - fill() operates on a task in the FILLING state and STOPS before any
 *   submit action. It emits artifacts; the caller records FILLED, which
 *   returns the task to REVIEW for human approval. Submission stays
 *   dryRunSubmit-only behind the SOWER_SUBMIT_ENABLED guard in
 *   @sower/platforms.
 * - Answers are typed into forms exactly as resolved (profile / bank /
 *   user / document) — a browser tier never invents values.
 * - All network evidence is captured redacted (HAR with content omitted,
 *   headers redacted per the @sower/platforms recorder rules).
 */
import type { TaskEvent, TaskState } from '@sower/core';
import type { ApplicationTask } from '@sower/db';
import type { ApiCallRecord } from '@sower/platforms';
import type { HarAttachmentPlan } from './har.js';

/** The deferred browser tiers. T0 (network) needs no browser worker. */
export type BrowserTier = 'T1' | 'T2' | 'T3';

/** The task state a browser tier operates in (REVIEW --APPROVED--> FILLING). */
export const BROWSER_TIER_STATE: TaskState = 'FILLING';

/**
 * Everything a browser tier hands back after filling (never submitting) an
 * application form.
 */
export interface FillArtifacts {
  /** Which tier produced the artifacts. */
  tier: BrowserTier;
  /** Vault storage keys of screenshots captured during the fill. */
  screenshotPaths: string[];
  /** Planned HAR attachment (documents row + storage upload), if recorded. */
  har: HarAttachmentPlan | null;
  /**
   * Redacted network calls to persist to the task's api_calls — the same
   * shape the T0 adapters record via @sower/platforms.
   */
  apiCalls: ApiCallRecord[];
  /** How many form fields were filled before stopping. */
  filledFieldCount: number;
  /**
   * Event the caller should apply to the task: FILLED (back to REVIEW for
   * human approval) or NEED_OTP (parked in AWAITING_OTP). Never SUBMIT_OK.
   */
  nextEvent: Extract<TaskEvent, 'FILLED' | 'NEED_OTP'>;
  /**
   * GUARDRAIL: always true. A browser tier fills forms and captures
   * evidence, then stops — it never clicks submit.
   */
  stoppedBeforeSubmit: true;
}

/**
 * The browser worker contract for T1-T3. `fill` receives a FILLING task
 * (jobSpec + resolution populated) and resolves with artifacts, having
 * stopped short of any submit action.
 */
export interface BrowserWorker {
  fill(task: ApplicationTask): Promise<FillArtifacts>;
}

/** Thrown by scaffold members that have no real implementation yet. */
export class NotImplementedError extends Error {
  constructor(member: string) {
    super(
      `${member} is not implemented — T1/T2/T3 browser tiers: scaffold only`,
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * Returns the scaffold worker: it is NOT implemented against real sites.
 * Calling fill() logs the scaffold notice and throws NotImplementedError
 * without performing any I/O (no browser, no fetch).
 */
export function createBrowserWorker(): BrowserWorker {
  return {
    fill(task: ApplicationTask): Promise<FillArtifacts> {
      console.log('T1/T2/T3 browser tiers: scaffold only');
      return Promise.reject(
        new NotImplementedError(`BrowserWorker.fill(task ${task.id})`),
      );
    },
  };
}
