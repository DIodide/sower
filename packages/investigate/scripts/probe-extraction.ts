/**
 * Run the REAL serialized form-control extraction (extractionExpression from
 * discover-form.ts — the exact code discoverForm evaluates in the page)
 * against a LIVE url with the same hardened browser posture, and print the
 * extracted controls with their detected answer limits.
 *
 * Usage: pnpm --filter @sower/investigate exec tsx scripts/probe-extraction.ts <url>
 */
import { chromium } from 'playwright';
import { extractionExpression } from '../src/discover-form.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: tsx scripts/probe-extraction.ts <url>');
  process.exit(1);
}

const browser = await (async () => {
  const options = {
    headless: true,
    timeout: 60_000,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launch({ ...options, channel: 'chromium' });
  } catch {
    return chromium.launch(options);
  }
})();

const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
});
await context.addInitScript({
  content:
    "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}",
});

const page = await context.newPage();
const resp = await page.goto(url, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});
console.log(`HTTP ${resp?.status()} -> ${page.url()}`);
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
await page
  .waitForSelector('form, input, select, textarea', { timeout: 5_000 })
  .catch(() => {});

const extraction = (await page.evaluate(extractionExpression())) as {
  controls: {
    label: string;
    name: string;
    inputType: string;
    required: boolean;
    limit?: { kind: string; max: number };
  }[];
  formCount: number;
  iframeCount: number;
  looksLikeApplicationForm: boolean;
};

console.log(
  `\n${extraction.controls.length} controls (${extraction.formCount} <form> tags, ${extraction.iframeCount} iframes), looksLikeApplicationForm=${extraction.looksLikeApplicationForm}`,
);
for (const c of extraction.controls) {
  const limit = c.limit ? `  LIMIT ${c.limit.max} ${c.limit.kind}` : '';
  console.log(
    `- [${c.inputType}${c.required ? '*' : ''}] ${(c.label || c.name || '(unlabeled)').slice(0, 90)}${limit}`,
  );
}
const withLimits = extraction.controls.filter((c) => c.limit);
console.log(`\ncontrols with limits: ${withLimits.length}`);

await browser.close();
