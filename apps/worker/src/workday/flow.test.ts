import type { Question, ResolvedAnswer } from '@sower/core';
import { describe, expect, it, vi } from 'vitest';
import { type FakeScreen, FakeWorkdayPage } from './fake-page.js';
import { type FillContext, runApplyFlow } from './flow.js';

const cred = { email: 'ibraheem.amin2@gmail.com', password: 'S3cret-pw!' };

/** A resolver that answers a fixed map of question id -> value. */
function resolverFor(
  map: Record<string, ResolvedAnswer['value']>,
): (questions: Question[]) => ResolvedAnswer[] {
  return (questions) =>
    questions
      .filter((q) => q.id in map)
      .map((q) => ({
        questionId: q.id,
        source: 'profile' as const,
        value: map[q.id] ?? null,
      }));
}

function ctxFor(overrides: Partial<FillContext> = {}): FillContext {
  const saveScreenshot = vi.fn(
    async (_png: Uint8Array, label: string) =>
      `tasks/t1/screenshots/${label}.png`,
  );
  return {
    applyUrl: 'https://cadence.wd1.myworkdayjobs.com/external_careers/job/X',
    credential: cred,
    accountIntent: 'create',
    resolve: resolverFor({}),
    getFileBytes: async () => new Uint8Array([1, 2, 3]),
    saveScreenshot,
    maxSteps: 10,
    ...overrides,
  };
}

/** The screens for a full create -> 2 question pages -> review run. */
function happyScreens(): FakeScreen[] {
  return [
    // 0: job posting with Apply entry points
    {
      heading: 'Software Intern',
      present: ['adventureButton', 'applyManually'],
      advancesOn: ['applyManually'],
    },
    // 1: create-account page
    {
      present: [
        'email',
        'password',
        'verifyPassword',
        'createAccountCheckbox',
        'createAccountSubmitButton',
      ],
      advancesOn: ['createAccountSubmitButton'],
    },
    // 2: questionnaire page 1
    {
      heading: 'My Information',
      present: ['pageFooterNextButton'],
      fields: [
        {
          automationId: 'firstName',
          label: 'First name',
          control: 'text',
          required: true,
        },
      ],
      advancesOn: ['next'],
    },
    // 3: questionnaire page 2
    {
      heading: 'Application Questions',
      present: ['pageFooterNextButton'],
      fields: [
        {
          automationId: 'whyUs',
          label: 'Why do you want to work here?',
          control: 'textarea',
          required: false,
        },
      ],
      advancesOn: ['next'],
    },
    // 4: Review — the hard stop
    { heading: 'Step 3 of 3: Review' },
  ];
}

describe('runApplyFlow — happy path', () => {
  it('creates the account, fills each page, stops at Review, never submits', async () => {
    const page = new FakeWorkdayPage(happyScreens());
    const ctx = ctxFor({
      resolve: resolverFor({ firstName: 'Ada', whyUs: 'Great team.' }),
    });

    const result = await runApplyFlow(page, ctx);

    expect(result.outcome).toBe('filled');
    expect(result.reachedReview).toBe(true);
    expect(result.filledFieldCount).toBe(2);
    // Filled with the resolved values, verbatim.
    expect(page.log.applied).toEqual([
      {
        kind: 'text',
        questionId: 'firstName',
        label: 'First name',
        value: 'Ada',
      },
      {
        kind: 'text',
        questionId: 'whyUs',
        label: 'Why do you want to work here?',
        value: 'Great team.',
      },
    ]);
    // Final screenshot is the review stop; no submit control was ever clicked.
    expect(result.screenshotPaths.at(-1)).toContain('review-stop');
    expect(page.log.clicked).not.toContain('pageFooterSubmitButton');
    expect(page.log.clicked).not.toContain('bottom-navigation-submit-button');
  });

  it('leaves unresolved questions blank (never invents)', async () => {
    const page = new FakeWorkdayPage(happyScreens());
    // Only firstName resolves; whyUs stays blank.
    const ctx = ctxFor({ resolve: resolverFor({ firstName: 'Ada' }) });

    const result = await runApplyFlow(page, ctx);

    expect(page.log.applied).toEqual([
      {
        kind: 'text',
        questionId: 'firstName',
        label: 'First name',
        value: 'Ada',
      },
    ]);
    expect(result.filledFieldCount).toBe(1);
    // whyUs is optional, so no required question was skipped.
    expect(result.skippedRequired).toBe(0);
  });

  it('captures a screenshot per page plus the stop', async () => {
    const page = new FakeWorkdayPage(happyScreens());
    const result = await runApplyFlow(page, ctxFor());
    // 2 questionnaire pages + the review stop.
    expect(result.screenshotPaths).toHaveLength(3);
    expect(page.log.screenshots).toBe(3);
  });
});

describe('runApplyFlow — OTP wall', () => {
  it('returns needs-otp with a screenshot when verification is required', async () => {
    const page = new FakeWorkdayPage([
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      // 2: OTP wall
      { present: ['verificationCode', 'verifyEmailSubmitButton'] },
    ]);

    const result = await runApplyFlow(page, ctxFor());

    expect(result.outcome).toBe('needs-otp');
    expect(result.screenshotPaths.at(-1)).toContain('otp-wall');
    expect(result.filledFieldCount).toBe(0);
  });

  it('resumes past the wall when a pending code clears it', async () => {
    const page = new FakeWorkdayPage([
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      // 2: OTP wall — submitting the code advances past it
      {
        present: ['verificationCode', 'verifyEmailSubmitButton'],
        advancesOn: ['verifyEmailSubmitButton'],
      },
      // 3: first questionnaire page after verification
      {
        heading: 'My Information',
        present: ['pageFooterNextButton'],
        fields: [
          {
            automationId: 'firstName',
            label: 'First name',
            control: 'text',
            required: true,
          },
        ],
        advancesOn: ['next'],
      },
      { heading: 'Review' },
    ]);

    const result = await runApplyFlow(
      page,
      ctxFor({
        pendingOtp: '482913',
        resolve: resolverFor({ firstName: 'Ada' }),
      }),
    );

    expect(result.outcome).toBe('filled');
    expect(result.reachedReview).toBe(true);
    expect(page.log.filled).toContainEqual({
      id: 'verificationCode',
      value: '482913',
    });
  });

  it('returns needs-otp again when the pending code is rejected', async () => {
    const page = new FakeWorkdayPage([
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      // OTP wall that does NOT advance (code rejected → still present)
      { present: ['verificationCode', 'verifyEmailSubmitButton'] },
    ]);

    const result = await runApplyFlow(page, ctxFor({ pendingOtp: '000000' }));

    expect(result.outcome).toBe('needs-otp');
    expect(result.detail).toMatch(/not accepted/);
  });
});

describe('runApplyFlow — failure + caps', () => {
  it('returns failed when the auth form is absent', async () => {
    const page = new FakeWorkdayPage([
      { heading: 'Software Intern', present: [], advancesOn: [] },
    ]);
    const result = await runApplyFlow(page, ctxFor());
    expect(result.outcome).toBe('failed');
    expect(result.screenshotPaths.at(-1)).toContain('auth-failed');
  });

  it('honors maxSteps so a never-ending flow cannot loop forever', async () => {
    // A page that always offers Next and never becomes Review.
    const loopScreen: FakeScreen = {
      heading: 'My Experience',
      present: ['pageFooterNextButton'],
      fields: [],
      advancesOn: [], // clickNext returns false immediately... so use a self-loop
    };
    // Build 20 identical non-review pages; maxSteps caps the walk.
    const screens: FakeScreen[] = [
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
    ];
    for (let i = 0; i < 20; i++) {
      screens.push({ ...loopScreen, advancesOn: ['next'] });
    }
    const page = new FakeWorkdayPage(screens);

    const result = await runApplyFlow(page, ctxFor({ maxSteps: 3 }));

    expect(result.outcome).toBe('filled');
    expect(result.reachedReview).toBe(false);
    // Exactly maxSteps "Next" clicks, then a stop screenshot.
    expect(page.log.nextClicks).toBe(3);
    expect(result.screenshotPaths.at(-1)).toContain('filled-stop');
  });
});
