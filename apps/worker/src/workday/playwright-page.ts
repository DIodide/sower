import type { Page } from 'playwright';
import type { RawField } from './field-map.js';
import type { FillAction, WorkdayPage } from './page.js';
import { anyAutomationId, automationId, WORKDAY_IDS } from './selectors.js';

/**
 * The Playwright-backed WorkdayPage. This is the ONE module that touches a
 * real browser DOM; all decision logic lives in the pure modules
 * (flow/account/field-map/fill-plan) that are unit-tested against a fake page.
 *
 * The account/navigation selectors are Workday's stable automation-ids
 * (selectors.ts). The QUESTIONNAIRE scrape (`scrapeFields`) reads whatever
 * controls a tenant's form renders; it is best-effort and TUNED against real
 * tenants via the recon script (scripts/workday-recon.ts) — treat its output
 * as advisory until validated for a given tenant.
 *
 * GUARDRAIL: there is no method here that clicks the application Submit
 * control. `clickNext` targets only the per-page "Next" button.
 */
export class PlaywrightWorkdayPage implements WorkdayPage {
  constructor(
    private readonly page: Page,
    /** Short per-check visibility timeout (ms). */
    private readonly probeTimeoutMs = 2_000,
  ) {}

  private async settle(): Promise<void> {
    // Workday is a SPA; wait for XHR to quiesce, tolerating the occasional
    // long-poll that never idles.
    await this.page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => {});
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await this.settle();
  }

  async heading(): Promise<string> {
    // Prefer the active progress-bar STEP (its text is the step name, e.g.
    // "My Information"/"Review"). Only fall back to page headings when there
    // is no progress bar — the job title (an <h2>) persists across the whole
    // apply flow and must NOT be mistaken for the current step.
    const candidates = [
      anyAutomationId(WORKDAY_IDS.progressActiveStep),
      `${anyAutomationId(WORKDAY_IDS.progressBar)} [aria-current="step"]`,
      'h1',
      'h2',
    ];
    for (const selector of candidates) {
      const text = await this.page
        .locator(selector)
        .first()
        .innerText({ timeout: this.probeTimeoutMs })
        .catch(() => '');
      if (text.trim()) {
        return text.trim();
      }
    }
    return '';
  }

  async isPresent(idVariants: readonly string[]): Promise<boolean> {
    return this.page
      .locator(anyAutomationId(idVariants))
      .first()
      .isVisible({ timeout: this.probeTimeoutMs })
      .catch(() => false);
  }

  async clickFirst(idVariants: readonly string[]): Promise<boolean> {
    for (const id of idVariants) {
      const locator = this.page.locator(automationId(id)).first();
      if (
        await locator
          .isVisible({ timeout: this.probeTimeoutMs })
          .catch(() => false)
      ) {
        await locator.click({ timeout: 10_000 }).catch(() => {});
        await this.settle();
        return true;
      }
    }
    return false;
  }

  async fillFirst(
    idVariants: readonly string[],
    value: string,
  ): Promise<boolean> {
    for (const id of idVariants) {
      const locator = this.page.locator(automationId(id)).first();
      if (
        await locator
          .isVisible({ timeout: this.probeTimeoutMs })
          .catch(() => false)
      ) {
        await locator.fill(value, { timeout: 10_000 }).catch(() => {});
        return true;
      }
    }
    return false;
  }

  async checkFirst(idVariants: readonly string[]): Promise<boolean> {
    for (const id of idVariants) {
      const locator = this.page.locator(automationId(id)).first();
      if (
        await locator
          .isVisible({ timeout: this.probeTimeoutMs })
          .catch(() => false)
      ) {
        await locator.check({ timeout: 10_000 }).catch(() => {});
        return true;
      }
    }
    return false;
  }

  async scrapeFields(): Promise<RawField[]> {
    // tsx/esbuild instruments named functions with a module-level `__name`
    // helper. Playwright serializes the evaluate callback via toString(), so
    // those `__name(...)` calls reach the browser where the helper is
    // undefined — a ReferenceError. Define a no-op shim in the page first
    // (passed as a STRING so it is not itself instrumented).
    await this.page.evaluate(
      'globalThis.__name = globalThis.__name || function (f) { return f; };',
    );
    // Runs in the browser context; must be self-contained (no imports).
    return this.page.evaluate(() => {
      const results: Array<{
        automationId: string;
        label: string;
        control: string;
        required: boolean;
        options?: { label: string; value: string }[];
      }> = [];

      const labelFor = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria?.trim()) return aria.trim();
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
          if (parts) return parts;
        }
        const id = el.getAttribute('id');
        if (id) {
          const lbl = document.querySelector(`label[for="${id}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim();
        }
        // Closest labelled group (Workday wraps a control + its label).
        const group = el.closest(
          '[role="group"], fieldset, [data-automation-id]',
        );
        const legend = group?.querySelector('legend, label');
        return legend?.textContent?.trim() ?? '';
      };

      const isVisible = (el: Element): boolean => {
        const html = el as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        // Honeypots hide via visibility/opacity while keeping layout size;
        // an aria-hidden or hidden-typed input is never human-facing.
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.getAttribute('type') === 'hidden') return false;
        const style = window.getComputedStyle(html);
        return style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const controls = Array.from(
        document.querySelectorAll('input, textarea, select'),
      ).filter((el) => isVisible(el)) as HTMLElement[];

      for (const el of controls) {
        const automation =
          el.getAttribute('data-automation-id') ??
          el
            .closest('[data-automation-id]')
            ?.getAttribute('data-automation-id') ??
          '';
        if (!automation) continue;

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        let control = 'unknown';
        if (tag === 'textarea') control = 'textarea';
        else if (tag === 'select') control = 'select';
        else if (type === 'file') control = 'file';
        else if (type === 'checkbox') control = 'checkbox';
        else if (type === 'radio') control = 'radio';
        else if (type === 'date') control = 'date';
        else if (tag === 'input') control = 'text';

        const required =
          el.getAttribute('aria-required') === 'true' ||
          el.hasAttribute('required');

        let options: { label: string; value: string }[] | undefined;
        if (tag === 'select') {
          options = Array.from((el as HTMLSelectElement).options)
            .filter((o) => o.value !== '')
            .map((o) => ({
              label: o.textContent?.trim() ?? '',
              value: o.value,
            }));
        }

        results.push({
          automationId: automation,
          label: labelFor(el),
          control,
          required,
          options,
        });
      }
      return results as unknown as RawField[];
    });
  }

  async applyAction(
    action: FillAction,
    fileBytes?: Uint8Array,
  ): Promise<boolean> {
    const locator = this.page.locator(automationId(action.questionId)).first();
    if (
      !(await locator
        .isVisible({ timeout: this.probeTimeoutMs })
        .catch(() => false))
    ) {
      return false;
    }
    try {
      switch (action.kind) {
        case 'text':
          await locator.fill(action.value, { timeout: 10_000 });
          return true;
        case 'select':
          // Native <select>; Workday custom prompts need the listbox path,
          // which the recon script validates per tenant.
          await locator.selectOption(action.optionValue, { timeout: 10_000 });
          return true;
        case 'multiselect':
          await locator.selectOption(action.optionValues, { timeout: 10_000 });
          return true;
        case 'file': {
          if (!fileBytes) return false;
          await locator.setInputFiles(
            {
              name: 'resume.pdf',
              mimeType: 'application/pdf',
              buffer: Buffer.from(fileBytes),
            },
            { timeout: 15_000 },
          );
          return true;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  async clickNext(): Promise<boolean> {
    return this.clickFirst(WORKDAY_IDS.nextButton);
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ fullPage: true });
  }
}
