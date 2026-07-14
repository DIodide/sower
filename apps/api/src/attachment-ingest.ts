import { randomUUID } from 'node:crypto';
import { documents } from '@sower/db';
import type { DiscordChannelMessage } from '@sower/notify';
import { createStorage } from '@sower/storage';
import { ingestJob } from './ingest.js';
import { assertSafeFetchTarget } from './link-extract.js';
import type { Deps } from './types.js';

/**
 * Ingest job-posting screenshots that arrive as Discord image attachments.
 * Tier 1 of screenshot ingest: the image is downloaded into the vault and the
 * message is parked as a NEEDS_INPUT task (via ingestJob's unknown-platform
 * path) so the screenshot is visible on the dashboard for manual triage.
 *
 * Same invariant as the link path: NOTHING is silently dropped. Even when the
 * image download fails, the attachment URL is still recorded + parked
 * (`stored: false`), so the posting survives for a human to chase.
 */

const FETCH_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 10_000_000;
const SOURCE = 'discord';

export interface AttachmentOutcome {
  kind: 'screenshot';
  jobId: string;
  filename: string;
  /** False when the image download/store failed but the task was still parked. */
  stored: boolean;
}

type MessageAttachment = NonNullable<
  DiscordChannelMessage['attachments']
>[number];

/** The image attachments on a message (the ones screenshot ingest handles). */
export function imageAttachments(
  message: Pick<DiscordChannelMessage, 'attachments'>,
): MessageAttachment[] {
  return (message.attachments ?? []).filter((attachment) =>
    attachment.content_type?.startsWith('image/'),
  );
}

/** Mirrors the dashboard upload sanitizer: storage keys stay vault-safe. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 120);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

/**
 * Download an attachment's bytes, best-effort: SSRF-guarded (the URL comes
 * from a user-posted message), time-capped, and size-capped both by the
 * content-length header and by the actual bytes read. Any failure returns
 * null — the caller still parks the task, it just can't store the image.
 */
async function fetchImage(
  url: string,
): Promise<{ buffer: Buffer; contentType: string; size: number } | null> {
  try {
    assertSafeFetchTarget(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      return null;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        // The header lied (or was absent): stop reading and skip the store.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType:
        response.headers.get('content-type') ?? 'application/octet-stream',
      size,
    };
  } catch {
    return null;
  }
}

/**
 * Store + park every image attachment on a message. Returns one outcome per
 * image; non-image attachments (resumes, zips, ...) are ignored here.
 */
export async function ingestMessageAttachments(
  deps: Deps,
  message: DiscordChannelMessage,
): Promise<AttachmentOutcome[]> {
  const images = imageAttachments(message);
  if (images.length === 0) {
    return [];
  }

  const outcomes: AttachmentOutcome[] = [];
  for (const attachment of images) {
    const filename = sanitizeFilename(attachment.filename);

    // 1. Download + vault the bytes (best-effort; null on any failure).
    const image = await fetchImage(attachment.url);
    let storagePath: string | null = null;
    if (image) {
      try {
        const path = `screenshots/${randomUUID()}/${filename}`;
        await createStorage().put(path, image.buffer, image.contentType);
        storagePath = path;
      } catch {
        // Storage down: still park the task below so nothing is dropped.
      }
    }

    // 2. Park via the shared ingest pipeline (dedupe + park logic in one
    // place). resolve:false records the CDN URL as-is — no re-download — and
    // the unknown platform parks the task in NEEDS_INPUT.
    const result = await ingestJob(deps, {
      url: attachment.url,
      source: SOURCE,
      resolve: false,
      title: filename,
    });

    // 3. Link the stored image to the job so the task page can render it.
    if (image && storagePath) {
      await deps.db.insert(documents).values({
        kind: 'screenshot',
        filename,
        storagePath,
        contentType: image.contentType,
        sizeBytes: image.size,
        jobId: result.jobId,
      });
    }

    outcomes.push({
      kind: 'screenshot',
      jobId: result.jobId,
      filename,
      stored: image !== null && storagePath !== null,
    });
  }
  return outcomes;
}
