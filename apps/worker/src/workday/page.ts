import type { RawField } from './field-map.js';
import type { FillAction } from './fill-plan.js';

/**
 * The narrow set of browser operations the Workday apply flow needs. The
 * orchestration (account.ts, worker.ts) is written against THIS interface,
 * not Playwright directly, so it is unit-testable with a scripted fake page.
 * The real implementation (playwright-page.ts) wraps a Playwright `Page`.
 *
 * Every method that acts on the page is expected to settle (wait for
 * navigation / network idle) before resolving, so the orchestration never
 * races the DOM.
 *
 * GUARDRAIL: this interface has NO "submit application" method. The only
 * submit-ish control it can touch is the per-page "Next" button; the final
 * "Submit" is never exposed, so no orchestration path can click it.
 */
export interface WorkdayPage {
  /** Navigate to a URL and settle. */
  open(url: string): Promise<void>;

  /** The current step/page heading (e.g. "My Information"), '' if none. */
  heading(): Promise<string>;

  /** True when ANY of the automation-id variants is present and visible. */
  isPresent(idVariants: readonly string[]): Promise<boolean>;

  /**
   * Click the first present control among the variants; returns false when
   * none is present (so callers can branch instead of throwing).
   */
  clickFirst(idVariants: readonly string[]): Promise<boolean>;

  /** Fill the first present input among the variants; false when none present. */
  fillFirst(idVariants: readonly string[], value: string): Promise<boolean>;

  /** Check the first present checkbox among the variants; false when absent. */
  checkFirst(idVariants: readonly string[]): Promise<boolean>;

  /** Scrape all answerable controls on the current questionnaire page. */
  scrapeFields(): Promise<RawField[]>;

  /**
   * Perform ONE fill action against its control. `fileBytes` is provided only
   * for file actions (the resume bytes read from the vault). Returns whether
   * the control was found and filled.
   */
  applyAction(action: FillAction, fileBytes?: Uint8Array): Promise<boolean>;

  /** Advance to the next questionnaire page (the per-page "Next" button). */
  clickNext(): Promise<boolean>;

  /** Capture a full-page screenshot (PNG bytes). */
  screenshot(): Promise<Uint8Array>;
}

export type { FillAction, RawField };
