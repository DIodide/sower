import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@sower/storage';
import { chromium } from 'playwright';
import { buildRecordHarOptions, planHarAttachment } from '../har.js';
import { PlaywrightWorkdayPage } from './playwright-page.js';
import type { OpenWorkdayPage, WorkdayPageSession } from './worker.js';

export interface LauncherOptions {
  /** Headful for the recon/observed run; default headless. */
  headful?: boolean;
  /** Residential proxy server (e.g. 'http://user:pass@host:port'), optional. */
  proxyServer?: string;
  /** documents-row inserter for the captured HAR (best-effort). */
  attachHar?: (plan: HarDocumentInsert) => Promise<void>;
}

export interface HarDocumentInsert {
  taskId: string;
  kind: string;
  filename: string;
  storagePath: string;
  contentType: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * The default OpenWorkdayPage: launches Chromium (Akamai posture note —
 * datacenter IPs may be challenged; set proxyServer for residential egress),
 * records a redacted HAR (content omitted), and on close uploads the HAR to
 * the vault. Requires `pnpm --filter @sower/worker exec playwright install
 * chromium` once.
 */
export function createPlaywrightOpener(
  storage: Storage,
  options: LauncherOptions = {},
): OpenWorkdayPage {
  return async (taskId: string): Promise<WorkdayPageSession> => {
    const harDir = await mkdtemp(join(tmpdir(), `sower-har-${taskId}-`));
    const browser = await chromium.launch({
      headless: !options.headful,
      ...(options.proxyServer
        ? { proxy: { server: options.proxyServer } }
        : {}),
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      recordHar: buildRecordHarOptions(taskId, harDir),
    });
    const page = await context.newPage();

    return {
      page: new PlaywrightWorkdayPage(page),
      async close() {
        // Closing the context flushes the HAR to disk.
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      },
      async finalizeHar() {
        try {
          const plan = planHarAttachment(taskId);
          const localPath = join(harDir, `task-${taskId}.har`);
          const bytes = await readFile(localPath);
          await storage.put(plan.storagePath, bytes, plan.contentType);
          if (options.attachHar) {
            await options.attachHar({
              taskId: plan.taskId,
              kind: plan.kind,
              filename: plan.filename,
              storagePath: plan.storagePath,
              contentType: plan.contentType,
            });
          }
          return plan;
        } catch {
          return null;
        } finally {
          await rm(harDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  };
}
