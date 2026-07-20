import { canonicalizeUrl } from '@sower/core';
import {
  applicationTasks,
  ingestionRuns,
  investigationRuns,
  jobs,
} from '@sower/db';
import { detectPlatform } from '@sower/platforms';
import { fetchListings, filterListings, SOURCES } from '@sower/sources';
import { and, asc, eq, inArray, notExists } from 'drizzle-orm';
import { ingestJob } from './ingest.js';
import { triggerInvestigation } from './investigate-trigger.js';
import type { Db, Deps } from './types.js';

/**
 * Honest funnel accounting for a single poll. This is both the HTTP response
 * of POST /sources/simplify/poll (spread into IngestionPollResult) and the
 * breakdown recorded under the reserved `funnel` key of the run row's
 * by_platform jsonb (no migration; old rows simply lack the key).
 */
export interface IngestionFunnel {
  /** Listings fetched across all sources, before any filter. */
  fetched: number;
  /** Listings surviving the term + active/visible filter. */
  filtered: number;
  /** Filtered listings whose canonical URL is not already in `jobs`. */
  fresh: number;
  /** Fresh listings ingested AND queued for auto-processing this run. */
  ingested: number;
  /**
   * Fresh listings recorded but parked NEEDS_INPUT (unknown platform, or a
   * tenant-less greenhouse URL whose probe failed) — captured as tasks and
   * eligible for browser-agent form discovery, never silently dropped.
   */
  parked: number;
  /**
   * Attempted listings ingestJob reported as already known — its resolve /
   * tenant-probe canonicalization can reach jobs the cheap canonical-URL
   * pre-skip cannot see.
   */
  duplicates: number;
  /**
   * Tier-2 form-discovery Jobs actually fired this run: this run's fresh
   * unknown-platform parks first (file order), then the oldest
   * never-investigated parked backlog, SOURCE_INVESTIGATE_PER_RUN total.
   */
  investigationsTriggered: number;
  /** Fresh listings beyond SIMPLIFY_MAX_PER_RUN, deferred to later polls. */
  capDeferred: number;
}

/** The funnel a single poll produces (also the HTTP response of the route). */
export interface IngestionPollResult extends IngestionFunnel {
  /** Per-platform counts across all filtered listings. */
  byPlatform: Record<string, number>;
}

const ZERO_FUNNEL: IngestionFunnel = {
  fetched: 0,
  filtered: 0,
  fresh: 0,
  ingested: 0,
  parked: 0,
  duplicates: 0,
  investigationsTriggered: 0,
  capDeferred: 0,
};

/**
 * Poll every configured Summer 2027 source, normalize + filter by term, then
 * hand EVERY filtered listing to `ingestJob` — no supported-platform gate.
 * Supported platforms (greenhouse, ashby, lever, workday) parse + queue as
 * before; unknown platforms are recorded + parked NEEDS_INPUT; tenant-less
 * custom-domain greenhouse URLs are auto-upgraded by ingestJob's verified
 * tenant probe when possible (parked otherwise). Nothing matched is dropped.
 *
 * Listings already ingested (by canonical URL) are skipped BEFORE the per-run
 * cap, so each poll makes progress on NEW listings. Without this the cap
 * always slices the same newest N — once those are ingested every later run
 * re-attempts the same duplicates and the rest of the file never ingests.
 * ingestJob still dedups authoritatively; fresh ingests per run are bounded
 * by SIMPLIFY_MAX_PER_RUN and the remainder is recorded as capDeferred (a
 * ~40-listing backlog drains over a few hourly runs).
 *
 * Freshly-parked unknown-platform tasks get browser-agent form discovery via
 * a throttled drip (see runInvestigationDrip) instead of a ~40-Job burst.
 *
 * Records exactly one `ingestion_runs` row for the dashboard — including
 * failures — best-effort so an audit hiccup never blocks ingestion.
 */
export async function runIngestionPoll(
  deps: Deps,
): Promise<IngestionPollResult> {
  const { config, db } = deps;
  const startedAt = Date.now();
  const terms = config.SIMPLIFY_TERMS.split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  const sources = SOURCES.map((source) => source.name);

  try {
    const listings = await fetchListings();
    const filtered = filterListings(listings, { terms, activeOnly: true });

    const byPlatform: Record<string, number> = {};
    for (const listing of filtered) {
      const ref = detectPlatform(listing.url);
      byPlatform[ref.platform] = (byPlatform[ref.platform] ?? 0) + 1;
    }

    const knownRows = await db
      .select({ canonicalUrl: jobs.canonicalUrl })
      .from(jobs);
    const known = new Set(knownRows.map((row) => row.canonicalUrl));
    const fresh = filtered.filter(
      (listing) => !known.has(canonicalizeUrl(listing.url)),
    );
    const batch = fresh.slice(0, config.SIMPLIFY_MAX_PER_RUN);
    const capDeferred = fresh.length - batch.length;

    let ingested = 0;
    let parked = 0;
    let duplicates = 0;
    /** This run's freshly-parked unknown-platform task ids, in file order. */
    const freshParked: string[] = [];
    for (const listing of batch) {
      const result = await ingestJob(deps, {
        url: listing.url,
        source: listing.source,
        company: listing.company ?? undefined,
        title: listing.title,
        terms: listing.term ? [listing.term] : undefined,
      });
      if (result.duplicate) {
        duplicates += 1;
      } else if (result.state === 'NEEDS_INPUT') {
        parked += 1;
        // Only unknown-platform parks join the form-discovery drip; a parked
        // supported-platform task (e.g. a greenhouse URL whose tenant probe
        // failed) waits for manual triage like any other park.
        if (detectPlatform(listing.url).platform === 'unknown') {
          freshParked.push(result.taskId);
        }
      } else {
        ingested += 1;
      }
    }

    const investigationsTriggered = await runInvestigationDrip(
      deps,
      sources,
      freshParked,
    );

    const funnel: IngestionFunnel = {
      fetched: listings.length,
      filtered: filtered.length,
      fresh: fresh.length,
      ingested,
      parked,
      duplicates,
      investigationsTriggered,
      capDeferred,
    };
    await recordIngestionRun(db, {
      funnel,
      byPlatform,
      terms,
      sources,
      durationMs: Date.now() - startedAt,
      ok: true,
      error: null,
    });
    return { ...funnel, byPlatform };
  } catch (error) {
    // Record the failed poll so the dashboard shows it, then rethrow (the
    // route surfaces a 500 and the scheduler retries next hour).
    await recordIngestionRun(db, {
      funnel: ZERO_FUNNEL,
      byPlatform: {},
      terms,
      sources,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Throttled Tier-2 form-discovery drip: fire at most
 * config.SOURCE_INVESTIGATE_PER_RUN investigations per poll. This run's fresh
 * unknown-platform parks go first (file order); whatever budget remains picks
 * up the OLDEST source-ingested parked unknown-platform tasks that have no
 * investigation_runs row yet, so backlog parks from earlier runs drain a few
 * per hour instead of bursting dozens of browser Jobs at once. Fresh parks
 * beyond the budget are covered by that same backlog query on LATER polls
 * (triggering inserts a run row, so already-triggered tasks self-exclude).
 *
 * Returns the number of investigations actually fired. Best-effort: gated off
 * with SCREENSHOT_INVESTIGATION_ENABLED, and a backlog-query failure only
 * warns — the poll (and its parked tasks) must never be at risk.
 */
async function runInvestigationDrip(
  deps: Deps,
  sources: string[],
  freshParked: string[],
): Promise<number> {
  const { config, db } = deps;
  const budget = config.SOURCE_INVESTIGATE_PER_RUN;
  if (!config.SCREENSHOT_INVESTIGATION_ENABLED || budget <= 0) {
    return 0;
  }

  let triggered = 0;
  const freshTargets = freshParked.slice(0, budget);
  for (const taskId of freshTargets) {
    if (await triggerInvestigation(deps, taskId)) {
      triggered += 1;
    }
  }

  // Attempts (not successes) consume the budget, so a misconfigured trigger
  // can never cascade into an unbounded backlog sweep within one run.
  const remainder = budget - freshTargets.length;
  if (remainder <= 0) {
    return triggered;
  }
  try {
    const backlog = await db
      .select({ taskId: applicationTasks.id })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(
        and(
          eq(applicationTasks.state, 'NEEDS_INPUT'),
          eq(jobs.platform, 'unknown'),
          inArray(jobs.source, sources),
          notExists(
            db
              .select({ id: investigationRuns.id })
              .from(investigationRuns)
              .where(eq(investigationRuns.taskId, applicationTasks.id)),
          ),
        ),
      )
      .orderBy(asc(applicationTasks.createdAt))
      .limit(remainder);
    for (const row of backlog) {
      if (await triggerInvestigation(deps, row.taskId)) {
        triggered += 1;
      }
    }
  } catch (error) {
    console.warn(
      '[sower] parked-backlog investigation query failed (drip skipped):',
      error,
    );
  }
  return triggered;
}

/** Persist one ingestion-run row. Best-effort: a write failure only warns. */
async function recordIngestionRun(
  db: Db,
  row: {
    funnel: IngestionFunnel;
    byPlatform: Record<string, number>;
    terms: string[];
    sources: string[];
    durationMs: number;
    ok: boolean;
    error: string | null;
  },
): Promise<void> {
  const { funnel } = row;
  try {
    await db.insert(ingestionRuns).values({
      terms: row.terms,
      sources: row.sources,
      // Legacy integer columns, kept populated with sensible values for old
      // readers: scanned = post-filter listings (unchanged); matched = fresh
      // (every filtered listing is auto-ingestable now, so "new to the
      // pipeline" is the honest candidate count); ingested = ALL new jobs
      // recorded this run (queued + parked); skipped = fresh listings the
      // per-run cap deferred to later polls (nothing is dropped anymore).
      scanned: funnel.filtered,
      matched: funnel.fresh,
      ingested: funnel.ingested + funnel.parked,
      duplicates: funnel.duplicates,
      skipped: funnel.capDeferred,
      // by_platform jsonb: flat platform counts as before, plus the full
      // funnel breakdown under the reserved `funnel` key (platform names come
      // from detectPlatform's fixed union, so no collision is possible).
      // Backward compatible without a migration: old rows lack the key, and
      // readers iterating platform counts must skip non-number values. The
      // cast bridges the column's Record<string, number> drizzle type.
      byPlatform: {
        ...row.byPlatform,
        funnel,
      } as unknown as Record<string, number>,
      durationMs: row.durationMs,
      ok: row.ok,
      error: row.error,
    });
  } catch (error) {
    console.warn('[sower] failed to record ingestion run:', error);
  }
}
