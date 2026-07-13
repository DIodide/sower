import type { FillAction, RawField, WorkdayPage } from './page.js';

/**
 * A scriptable in-memory WorkdayPage for tests. A "screen" declares which
 * automation-id variants are present, the current heading, and the fields a
 * scrape returns. Clicking a nav control (or any id listed in a screen's
 * `advancesOn`) moves to the next screen, so a multi-page flow can be
 * simulated deterministically without a browser.
 */
export interface FakeScreen {
  heading?: string;
  /** Automation-ids present on this screen (any variant string). */
  present?: string[];
  /** Fields a scrapeFields() returns on this screen. */
  fields?: RawField[];
  /** Clicking any of these ids advances to the next screen. */
  advancesOn?: string[];
}

export interface FakeLog {
  opened: string[];
  filled: Array<{ id: string; value: string }>;
  clicked: string[];
  checked: string[];
  applied: FillAction[];
  nextClicks: number;
  screenshots: number;
}

export class FakeWorkdayPage implements WorkdayPage {
  private index = 0;
  readonly log: FakeLog = {
    opened: [],
    filled: [],
    clicked: [],
    checked: [],
    applied: [],
    nextClicks: 0,
    screenshots: 0,
  };

  constructor(private readonly screens: FakeScreen[]) {}

  private get screen(): FakeScreen {
    return this.screens[this.index] ?? {};
  }

  private presentSet(): Set<string> {
    return new Set(this.screen.present ?? []);
  }

  private advance(id: string): void {
    if ((this.screen.advancesOn ?? []).includes(id)) {
      this.index = Math.min(this.index + 1, this.screens.length - 1);
    }
  }

  async open(url: string): Promise<void> {
    this.log.opened.push(url);
  }

  async heading(): Promise<string> {
    return this.screen.heading ?? '';
  }

  async isPresent(idVariants: readonly string[]): Promise<boolean> {
    const present = this.presentSet();
    return idVariants.some((id) => present.has(id));
  }

  private firstPresent(idVariants: readonly string[]): string | null {
    const present = this.presentSet();
    return idVariants.find((id) => present.has(id)) ?? null;
  }

  async clickFirst(idVariants: readonly string[]): Promise<boolean> {
    const id = this.firstPresent(idVariants);
    if (id === null) {
      return false;
    }
    this.log.clicked.push(id);
    this.advance(id);
    return true;
  }

  async fillFirst(
    idVariants: readonly string[],
    value: string,
  ): Promise<boolean> {
    const id = this.firstPresent(idVariants);
    if (id === null) {
      return false;
    }
    this.log.filled.push({ id, value });
    return true;
  }

  async checkFirst(idVariants: readonly string[]): Promise<boolean> {
    const id = this.firstPresent(idVariants);
    if (id === null) {
      return false;
    }
    this.log.checked.push(id);
    return true;
  }

  async scrapeFields(): Promise<RawField[]> {
    return this.screen.fields ?? [];
  }

  async applyAction(
    action: FillAction,
    _fileBytes?: Uint8Array,
  ): Promise<boolean> {
    this.log.applied.push(action);
    return true;
  }

  async clickNext(): Promise<boolean> {
    this.log.nextClicks += 1;
    // 'next' is a synthetic advance trigger.
    if ((this.screen.advancesOn ?? []).includes('next')) {
      this.index = Math.min(this.index + 1, this.screens.length - 1);
      return true;
    }
    return false;
  }

  async screenshot(): Promise<Uint8Array> {
    this.log.screenshots += 1;
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "\x89PNG"
  }
}
