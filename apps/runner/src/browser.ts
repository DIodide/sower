import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import {
  executeFill,
  type FillAction,
  planFill,
  type UploadFile,
} from './greenhouse-fill.js';
import type { OpenTabSession } from './opentab-client.js';
import type {
  DocumentContent,
  FillPayload,
  FillReportItem,
} from './sower-client.js';

/**
 * The playwright side of a fill: connect to the OpenTab instance over its
 * browser_http CDP endpoint, find the session's tab, run the filler, then
 * disconnect. The tab and session STAY OPEN — the human finishes there.
 */

const PAGE_FIND_TIMEOUT_MS = 30_000;

function allPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

/**
 * Origin + pathname with the trailing slash dropped: greenhouse redirects
 * append gh_* query params, so URL matching must ignore query strings.
 * Null when the string is not an absolute URL.
 */
export function normalizeUrlForMatch(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Match by CDP targetId (the session's own field); normalized URL as the fallback. */
export async function findSessionPage(
  browser: Browser,
  session: OpenTabSession,
): Promise<Page> {
  const deadline = Date.now() + PAGE_FIND_TIMEOUT_MS;
  const wantedUrl = normalizeUrlForMatch(session.url);
  for (;;) {
    for (const page of allPages(browser)) {
      try {
        const cdp = await page.context().newCDPSession(page);
        let targetId: string | null = null;
        try {
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          targetId = targetInfo.targetId;
        } finally {
          // The probe session must never leak, even when the probe throws.
          await cdp.detach().catch(() => {});
        }
        if (targetId === session.targetId) {
          return page;
        }
      } catch {
        // The page can close mid-scan; keep looking.
      }
    }
    const byUrl = allPages(browser).find(
      (page) =>
        wantedUrl !== null && normalizeUrlForMatch(page.url()) === wantedUrl,
    );
    if (byUrl) {
      return byUrl;
    }
    if (Date.now() > deadline) {
      throw new Error(`session tab ${session.targetId} not found over CDP`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Where a file question's bytes come from — the sower api, in production. */
export interface DocumentSource {
  document(id: string): Promise<DocumentContent>;
}

/**
 * Fetch every document the plan uploads before touching the page, so a
 * download failure is a per-question outcome ('failed', with the reason)
 * rather than a stall mid-form.
 */
async function downloadFiles(
  actions: FillAction[],
  documents: DocumentSource | undefined,
): Promise<Map<string, UploadFile | { error: string }>> {
  const files = new Map<string, UploadFile | { error: string }>();
  for (const action of actions) {
    if (action.kind !== 'file') {
      continue;
    }
    if (documents === undefined) {
      files.set(action.questionId, { error: 'no document source configured' });
      continue;
    }
    try {
      const content = await documents.document(action.document.id);
      files.set(action.questionId, {
        name: content.filename,
        mimeType: content.mimeType,
        buffer: content.bytes,
      });
    } catch (error) {
      files.set(action.questionId, {
        error: `document download failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return files;
}

export async function fillSessionOverCdp(
  session: OpenTabSession,
  payload: FillPayload,
  documents?: DocumentSource,
): Promise<FillReportItem[]> {
  const actions = planFill(payload.questions);
  const files = await downloadFiles(actions, documents);
  const browser = await chromium.connectOverCDP(session.urls.browser_http);
  try {
    const page = await findSessionPage(browser, session);
    await page.waitForLoadState('domcontentloaded');
    return await executeFill(page, actions, { files });
  } finally {
    // Disconnects this CDP client only; the OpenTab session keeps running.
    await browser.close().catch(() => {});
  }
}
