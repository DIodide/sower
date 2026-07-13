import { describe, expect, it } from 'vitest';
import {
  anyAutomationId,
  automationId,
  isReviewStep,
  normalizeStep,
  REVIEW_STEP,
  WORKDAY_IDS,
} from './selectors.js';

describe('automationId / anyAutomationId', () => {
  it('builds a data-automation-id CSS selector', () => {
    expect(automationId('email')).toBe('[data-automation-id="email"]');
  });

  it('comma-joins a variant list', () => {
    expect(anyAutomationId(WORKDAY_IDS.signInSubmit)).toBe(
      '[data-automation-id="signInSubmitButton"], [data-automation-id="click_filter"]',
    );
  });
});

describe('normalizeStep', () => {
  it('recognizes the known steps regardless of numbering/casing', () => {
    expect(normalizeStep('My Information')).toBe('my information');
    expect(normalizeStep('Step 3 of 5: Application Questions')).toBe(
      'application questions',
    );
    expect(normalizeStep('  VOLUNTARY DISCLOSURES ')).toBe(
      'voluntary disclosures',
    );
    expect(normalizeStep('4/6 Review')).toBe('review');
  });

  it('returns null for an unrecognized heading', () => {
    expect(normalizeStep('Some Custom Tenant Page')).toBeNull();
  });
});

describe('isReviewStep', () => {
  it('is true only for the Review step (the hard stop)', () => {
    expect(isReviewStep('Review')).toBe(true);
    expect(isReviewStep('Step 6 of 6 — Review')).toBe(true);
    expect(isReviewStep('My Experience')).toBe(false);
    // An unknown page is conservatively NOT review, so the flow never treats
    // it as the safe stopping point.
    expect(isReviewStep('Mystery Page')).toBe(false);
    expect(REVIEW_STEP).toBe('review');
  });
});
