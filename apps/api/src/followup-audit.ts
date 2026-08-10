import { OPEN_FOLLOWUP_STATES } from '@sower/core';
import { applicationTasks, followups, jobs } from '@sower/db';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { judgeFollowupMail } from './followup-judge.js';
import { applyFollowupTransition } from './followup-routes.js';
import type { Deps } from './types.js';

/**
 * One-time + reusable follow-up audit: re-judge every OPEN email-ingested
 * follow-up from its STORED source email (source_body) and DISMISS the ones
 * the LLM judge calls noise with HIGH confidence — the cleanup pass for
 * junk that reached the In-Play section before the judge existed. Each
 * dismissal goes through the shared transition path
 * (followup-routes applyFollowupTransition: state-guarded update +
 * FOLLOWUP_STATE event + calendar delete), with the judge's reason recorded
 * in the event data. Low-confidence noise and judge failures leave the row
 * untouched. Fully dormant ({enabled:false}) without
 * CLAUDE_CODE_OAUTH_TOKEN.
 */

/** Judgments per call — bounds each POST's spend and runtime. */
export const AUDIT_MAX_JUDGED = 30;

export interface FollowupAuditResult {
  enabled: boolean;
  /** Candidate rows examined this call (≤ AUDIT_MAX_JUDGED). */
  audited: number;
  /** Rows dismissed as high-confidence noise, with the judge's reason. */
  dismissed: { id: string; title: string; reason: string }[];
  /** Rows judged and left open ('followup', or low-confidence noise). */
  kept: number;
  /** Rows that could not be judged (unparseable source_body, judge
   *  failure/timeout, or a lost transition race) — left untouched. */
  unjudgeable: number;
}

/**
 * Parse the From:/Subject: header prefix back out of a stored source_body
 * (emailSourceBody's exact format: From/Subject/Date lines, a blank line,
 * then the sanitized plain-text body). Null when the shape doesn't match —
 * e.g. a body-cap truncation mid-header.
 */
export function parseEmailSourceBody(
  sourceBody: string,
): { from: string; subject: string; body: string } | null {
  const match =
    /^From: (.*)\nSubject: (.*)\nDate: [^\n]*(?:\n\n?([\s\S]*))?$/.exec(
      sourceBody,
    );
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { from: match[1], subject: match[2], body: match[3] ?? '' };
}

/** One audit pass over the oldest open email follow-ups. */
export async function runFollowupAudit(
  deps: Deps,
): Promise<FollowupAuditResult> {
  const { db, config } = deps;
  if (!config.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      enabled: false,
      audited: 0,
      dismissed: [],
      kept: 0,
      unjudgeable: 0,
    };
  }

  // Open email-ingested rows WITH a stored source email, joined with the
  // parent application for the judge's company/jobTitle context. Oldest
  // first so repeated calls walk the backlog deterministically (dismissed
  // rows leave OPEN states and drop out of the next call's candidates).
  const rows = await db
    .select({
      followup: followups,
      company: jobs.company,
      jobTitle: jobs.title,
    })
    .from(followups)
    .innerJoin(applicationTasks, eq(followups.taskId, applicationTasks.id))
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(
      and(
        inArray(followups.state, [...OPEN_FOLLOWUP_STATES]),
        eq(followups.source, 'email'),
        isNotNull(followups.sourceBody),
      ),
    )
    .orderBy(asc(followups.createdAt))
    .limit(AUDIT_MAX_JUDGED);

  const dismissed: FollowupAuditResult['dismissed'] = [];
  let kept = 0;
  let unjudgeable = 0;
  for (const row of rows) {
    const parsed = parseEmailSourceBody(row.followup.sourceBody ?? '');
    if (!parsed) {
      unjudgeable += 1;
      continue;
    }
    const judged = await judgeFollowupMail({
      subject: parsed.subject,
      from: parsed.from,
      bodyText: parsed.body,
      company: row.company ?? '',
      jobTitle: row.jobTitle ?? '',
      regexKind: row.followup.kind,
    });
    if (judged === null) {
      unjudgeable += 1;
      continue;
    }
    if (judged.verdict !== 'noise' || judged.confidence !== 'high') {
      kept += 1;
      continue;
    }
    // High-confidence noise ONLY is acted on — through the shared
    // transition machinery, judge reason recorded on the timeline event.
    const outcome = await applyFollowupTransition(
      deps,
      row.followup,
      'DISMISS',
      {
        reason: judged.reason,
        via: 'audit',
      },
    );
    if (outcome.kind === 'ok') {
      dismissed.push({
        id: row.followup.id,
        title: row.followup.title,
        reason: judged.reason,
      });
    } else {
      // Raced/blocked transition: the row moved on — leave it alone.
      unjudgeable += 1;
    }
  }
  return {
    enabled: true,
    audited: rows.length,
    dismissed,
    kept,
    unjudgeable,
  };
}
