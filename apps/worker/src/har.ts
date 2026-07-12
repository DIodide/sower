/**
 * HAR capture helpers for the browser tiers (T1-T3). INTERFACE ONLY.
 *
 * When a browser tier runs a Playwright context with `recordHar`, the
 * resulting HAR is evidence of everything the browser did. These helpers
 * describe (a) how that context should be configured and (b) how the HAR
 * would be attached to a task's documents/api_calls afterwards. No I/O
 * happens here — the attach step ships with the first real browser tier.
 *
 * The `playwright` import below is TYPE-ONLY: it is erased at compile time,
 * so importing this module never loads Playwright (and never touches a
 * browser). Unit tests exercise only the pure helpers.
 */
import type { BrowserContextOptions } from 'playwright';

/**
 * Playwright's `recordHar` option shape (the `recordHar` field of
 * `browser.newContext(options)`), derived from Playwright's own types so it
 * can never drift.
 */
export type RecordHarOptions = NonNullable<BrowserContextOptions['recordHar']>;

/** documents.content_type for stored HAR files (HAR is a JSON format). */
export const HAR_CONTENT_TYPE = 'application/json';

/** documents.kind for stored HAR files. */
export const HAR_DOCUMENT_KIND = 'har';

/**
 * Task ids come from the database (uuids), but they end up in filesystem and
 * storage paths, so reject anything that could escape a directory.
 */
function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(taskId)) {
    throw new Error(`Invalid task id for HAR path: ${JSON.stringify(taskId)}`);
  }
}

/** Local HAR filename for a task, also used as the documents.filename. */
export function harFilename(taskId: string): string {
  assertSafeTaskId(taskId);
  return `task-${taskId}.har`;
}

/**
 * Build the `recordHar` options a browser tier must pass to
 * `browser.newContext()`.
 *
 * SAFETY: `content: 'omit'` is deliberate and load-bearing — HARs otherwise
 * embed full response bodies and request/response headers can carry cookies
 * and tokens. Bodies are never captured; when the attach step lands, headers
 * are additionally redacted with the same rules as the @sower/platforms
 * recorder before anything is persisted.
 *
 * @param taskId  the application task the capture belongs to
 * @param harDir  local directory Playwright writes the HAR into
 */
export function buildRecordHarOptions(
  taskId: string,
  harDir: string,
): RecordHarOptions {
  const dir = harDir.replace(/\/+$/, '');
  return {
    path: `${dir}/${harFilename(taskId)}`,
    // 'minimal' keeps only the fields needed for replay/audit.
    mode: 'minimal',
    // Never embed response bodies (see SAFETY note above).
    content: 'omit',
  };
}

/**
 * The persistence a browser tier will perform for a captured HAR:
 * upload the file to vault storage and insert a `documents` row. Pure data —
 * computing a plan performs no I/O.
 */
export interface HarAttachmentPlan {
  /** Task the capture belongs to (linkage column lands with the tiers). */
  taskId: string;
  /** documents.kind */
  kind: typeof HAR_DOCUMENT_KIND;
  /** documents.filename */
  filename: string;
  /** Vault storage key the HAR body will be uploaded to. */
  storagePath: string;
  /** documents.content_type */
  contentType: typeof HAR_CONTENT_TYPE;
}

/**
 * Plan how a task's recorded HAR gets attached: storage key
 * `tasks/<taskId>/har/task-<taskId>.har` plus the documents-row fields.
 */
export function planHarAttachment(taskId: string): HarAttachmentPlan {
  const filename = harFilename(taskId);
  return {
    taskId,
    kind: HAR_DOCUMENT_KIND,
    filename,
    storagePath: `tasks/${taskId}/har/${filename}`,
    contentType: HAR_CONTENT_TYPE,
  };
}

/**
 * The attach step itself — INTERFACE ONLY, implemented alongside the first
 * browser tier. An implementation will:
 *
 * 1. read the HAR Playwright wrote at `localHarPath` (context close flushes it),
 * 2. redact headers using the @sower/platforms recorder rules,
 * 3. upload it to `plan.storagePath` via @sower/storage,
 * 4. insert a `documents` row from the plan, and
 * 5. optionally fold notable HAR entries into the task's `api_calls`
 *    (same redacted `ApiCallRecord` shape the T0 adapters record).
 *
 * It must never re-issue any request found in the HAR.
 */
export interface HarAttacher {
  attach(plan: HarAttachmentPlan, localHarPath: string): Promise<void>;
}
