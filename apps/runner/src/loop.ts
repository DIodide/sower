import type { OpenTabClient, OpenTabSession } from './opentab-client.js';
import { liveViewUrl } from './opentab-client.js';
import { redactSecrets } from './redact.js';
import type {
  FillPayload,
  FillReportItem,
  SowerClient,
} from './sower-client.js';

/**
 * One poll tick with every effect injected, so claim/report/fail ordering
 * is testable without a browser or network. main.ts supplies the
 * playwright-backed fill. Two invariants live here: every outbound string
 * (fail errors, report details, log lines) passes through redactSecrets,
 * and once fill() has returned the session is NEVER destroyed — the
 * filled tab must stay alive for the human even when the ready report
 * fails. Destroy only on failures before/during the fill.
 */

export interface TickDeps {
  sower: SowerClient;
  opentab: OpenTabClient;
  fill(
    session: OpenTabSession,
    payload: FillPayload,
  ): Promise<FillReportItem[]>;
  log(line: string): void;
  /** Scrubbed from every outbound string via redactSecrets. */
  secrets?: readonly string[];
  heartbeatMs?: number;
  /** Session ttl (seconds); generous so the human can finish at leisure. */
  ttlSeconds?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TTL_SECONDS = 4 * 3600;
/** OpenTab profile the fill tabs live on — its own browsing identity. */
const FILL_PROFILE = 'sower';

/** Claim and process one job; false when the queue was empty. */
export async function runTick(deps: TickDeps): Promise<boolean> {
  const claimed = await deps.sower.claim();
  if (claimed === null) {
    return false;
  }
  const redact = (raw: string): string =>
    redactSecrets(raw, deps.secrets ?? []);
  const { job, payload } = claimed;
  deps.log(
    redact(
      `claimed ${job.id} (task ${job.taskId}): ${payload.company} — ${payload.title}`,
    ),
  );
  let session: OpenTabSession | null = null;
  // Flips the moment fill() returns: from then on the tab holds the
  // filled application and must survive any later failure.
  let fillCompleted = false;
  const heartbeat = setInterval(() => {
    deps.sower.heartbeat(job.id).catch(() => {});
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  try {
    session = await deps.opentab.createSession({
      // A dedicated, persistent profile: cookies and logins survive
      // between fills, which is what an application form wants (and what
      // an autofill extension will need). 'context' would have given each
      // fill a fresh incognito-style context that remembers nothing.
      isolation: 'profile',
      profile: FILL_PROFILE,
      // Headful: the tab exists to be handed to a person, who finishes the
      // application in a real window — on the host's screen or through the
      // live view. OpenTab locks a profile to one mode at a time, so a
      // headless instance holding this profile must be stopped first.
      headless: false,
      url: payload.applyUrl,
      ttl: deps.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    });
    await deps.sower.report(job.id, {
      status: 'running',
      liveViewUrl: liveViewUrl(session),
    });
    const rawReport = await deps.fill(session, payload);
    fillCompleted = true;
    const report = rawReport.map((item) =>
      item.detail === undefined
        ? item
        : { ...item, detail: redact(item.detail) },
    );
    await deps.sower.report(job.id, { status: 'ready', report });
    const filled = report.filter((item) => item.outcome === 'filled').length;
    deps.log(redact(`ready ${job.id}: ${filled}/${report.length} filled`));
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : String(error),
    );
    if (fillCompleted) {
      // The fill landed; only the ready report failed. Keep the session —
      // the human can still finish in the live view.
      await deps.sower
        .fail(job.id, `fill completed but the ready report failed: ${message}`)
        .catch(() => {});
    } else {
      if (session !== null) {
        await deps.opentab.destroySession(session.id).catch(() => {});
      }
      await deps.sower.fail(job.id, message).catch(() => {});
    }
    deps.log(redact(`failed ${job.id}: ${message}`));
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
