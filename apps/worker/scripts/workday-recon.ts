/**
 * Workday selector reconnaissance — READ-ONLY. Run LOCALLY (headful).
 *
 *   pnpm --filter @sower/worker exec tsx scripts/workday-recon.ts <job-url>
 *
 * Loads a real Workday job posting, clicks "Apply", and dumps the auth page's
 * structure so the account/nav selectors in selectors.ts can be verified for a
 * tenant. It NEVER creates an account and NEVER submits anything — it stops at
 * the sign-in / create-account wall and prints what it sees.
 *
 * To also validate the QUESTIONNAIRE scrape, pass --after-login: the script
 * pauses after clicking Apply so you can sign in by hand, then press Enter in
 * the terminal and it dumps the scraped fields from the current page.
 */
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { PlaywrightWorkdayPage } from '../src/workday/playwright-page.js';
import { anyAutomationId, WORKDAY_IDS } from '../src/workday/selectors.js';

const urlArg = process.argv[2];
if (!urlArg) {
  console.error(
    'usage: tsx scripts/workday-recon.ts <job-url> [--after-login]',
  );
  process.exit(1);
}
const afterLogin = process.argv.includes('--after-login');

async function main(url: string): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const wd = new PlaywrightWorkdayPage(page);

  console.log(`\nOpening ${url}`);
  await wd.open(url);
  console.log(`heading: ${JSON.stringify(await wd.heading())}`);
  console.log(
    `apply button present: ${await wd.isPresent(WORKDAY_IDS.applyButton)}`,
  );

  // Click into the application (Apply, then Apply Manually if offered).
  await wd.clickFirst(WORKDAY_IDS.applyButton);
  await wd.clickFirst(WORKDAY_IDS.applyManually);
  console.log(`\nafter Apply — url: ${page.url()}`);
  console.log(`heading: ${JSON.stringify(await wd.heading())}`);

  // Which known account/nav selectors are present on the auth wall.
  console.log('\nknown-selector presence:');
  for (const [name, variants] of Object.entries(WORKDAY_IDS)) {
    const present = await page
      .locator(anyAutomationId(variants))
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    console.log(`  ${present ? '✓' : '·'} ${name}: [${variants.join(', ')}]`);
  }

  // Dump every automation-id on the page for manual comparison.
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-automation-id]'))
      .map((el) => ({
        id: el.getAttribute('data-automation-id') ?? '',
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') ?? '',
      }))
      .filter((e) => e.id),
  );
  console.log(`\nall data-automation-ids on the auth page (${ids.length}):`);
  for (const e of ids.slice(0, 120)) {
    console.log(`  ${e.id}  <${e.tag}${e.type ? ` type=${e.type}` : ''}>`);
  }

  if (afterLogin) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question(
      '\n>>> Sign in by hand in the browser, navigate to the first questionnaire page, then press Enter to dump scraped fields... ',
    );
    rl.close();
    console.log(`\nheading: ${JSON.stringify(await wd.heading())}`);
    const fields = await wd.scrapeFields();
    console.log(`scraped ${fields.length} field(s):`);
    for (const f of fields) {
      console.log(
        `  [${f.control}${f.required ? ', required' : ''}] ${JSON.stringify(
          f.label,
        )}  (id=${f.automationId})${
          f.options ? ` options=${f.options.length}` : ''
        }`,
      );
    }
  }

  console.log(
    '\nRecon complete. NO account was created and NOTHING was submitted.',
  );
  console.log('Close the browser window (or Ctrl-C) when done inspecting.');
  // Leave the browser open for inspection; exit on SIGINT.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
  });
  await browser.close();
}

main(urlArg).catch((error) => {
  console.error('recon failed:', error);
  process.exit(1);
});
