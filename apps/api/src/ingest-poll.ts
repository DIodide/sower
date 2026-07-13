import { ingestionRuns } from '@sower/db';
import { detectPlatform, getAdapter } from '@sower/platforms';
import {
  fetchListings,
  filterListings,
  type NormalizedListing,
  SOURCES,
} from '@sower/sources';
import { ingestJob } from './ingest.js';
import type { Db, Deps } from './types.js';

/** The funnel a single poll produces (also the HTTP response of the route). */
export interface IngestionPollResult {
  /** Listings matching the term filter (after activeOnly). */
  scanned: number;
  /** Per-platform counts across all scanned listings. */
  byPlatform: Record<string, number>;
  /** Auto-ingestable candidates (supported platform + resolvable tenant). */
  matched: number;
  /** New jobs created this run (bounded by SIMPLIFY_MAX_PER_RUN). */
  ingested: number;
  /** Candidates already known (dedupe hits). */
  duplicates: number;
  /** Listings not auto-ingested (no adapter or no tenant). */
  skipped: number;
}

/**
 * Poll every configured Summer 2027 source, normalize + filter by term, then
 * auto-ingest listings on any platform we have an adapter for (greenhouse,
 * ashby, lever, workday) that carry a resolvable tenant — each deduped by
 * `computeDedupeKey` inside `ingestJob`. Ingestion per run is bounded by
 * SIMPLIFY_MAX_PER_RUN, so `matched` may exceed `ingested + duplicates`: the
 * remainder is picked up on later hourly runs (dedupe makes re-polls cheap).
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
    const candidates: NormalizedListing[] = [];
    let skipped = 0;
    for (const listing of filtered) {
      const ref = detectPlatform(listing.url);
      byPlatform[ref.platform] = (byPlatform[ref.platform] ?? 0) + 1;
      // Auto-ingest anything with a working adapter AND a resolvable tenant
      // (discovery needs the tenant; gh_jid custom domains lack it).
      if (getAdapter(ref.platform) && ref.tenant !== null) {
        candidates.push(listing);
      } else {
        skipped += 1;
      }
    }

    const batch = candidates.slice(0, config.SIMPLIFY_MAX_PER_RUN);
    let ingested = 0;
    let duplicates = 0;
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
      } else {
        ingested += 1;
      }
    }

    const summary: IngestionPollResult = {
      scanned: filtered.length,
      byPlatform,
      matched: candidates.length,
      ingested,
      duplicates,
      skipped,
    };
    await recordIngestionRun(db, {
      ...summary,
      terms,
      sources,
      durationMs: Date.now() - startedAt,
      ok: true,
      error: null,
    });
    return summary;
  } catch (error) {
    // Record the failed poll so the dashboard shows it, then rethrow (the
    // route surfaces a 500 and the scheduler retries next hour).
    await recordIngestionRun(db, {
      scanned: 0,
      byPlatform: {},
      matched: 0,
      ingested: 0,
      duplicates: 0,
      skipped: 0,
      terms,
      sources,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Persist one ingestion-run row. Best-effort: a write failure only warns. */
async function recordIngestionRun(
  db: Db,
  row: IngestionPollResult & {
    terms: string[];
    sources: string[];
    durationMs: number;
    ok: boolean;
    error: string | null;
  },
): Promise<void> {
  try {
    await db.insert(ingestionRuns).values({
      terms: row.terms,
      sources: row.sources,
      scanned: row.scanned,
      matched: row.matched,
      ingested: row.ingested,
      duplicates: row.duplicates,
      skipped: row.skipped,
      byPlatform: row.byPlatform,
      durationMs: row.durationMs,
      ok: row.ok,
      error: row.error,
    });
  } catch (error) {
    console.warn('[sower] failed to record ingestion run:', error);
  }
}
