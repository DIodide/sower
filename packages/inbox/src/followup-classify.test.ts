import { describe, expect, it } from 'vitest';
import {
  classifyFollowupMail,
  extractFollowupDueDate,
  type FollowupMailInput,
} from './followup-classify.js';

/** Mid-July arrival (EDT) — the anchor for relative/yearless due dates. */
const RECEIVED_AT = new Date('2026-07-18T15:00:00Z');

function mail(overrides: Partial<FollowupMailInput>): FollowupMailInput {
  return {
    subject: 'Hello',
    from: 'Recruiting <recruiting@example.com>',
    bodyText: '',
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe('classifyFollowupMail — assessment', () => {
  it('classifies a HackerRank invite (Akuna-shaped) with the platform link and a relative due date', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Akuna Capital - Online Assessment Invitation',
        from: 'Akuna Capital <no-reply@hackerrankforwork.com>',
        bodyText: [
          'Hi Ibraheem,',
          'Thank you for applying to the Software Engineer Intern position at Akuna Capital.',
          'Please complete your coding challenge within 7 days:',
          'https://www.hackerrankforwork.com/tests/abc123/login?email=x',
          'Good luck!',
        ].join('\n'),
      }),
    );
    expect(result).toEqual({
      kind: 'assessment',
      title: 'Assessment — Akuna Capital - Online Assessment Invitation',
      url: 'https://www.hackerrankforwork.com/tests/abc123/login?email=x',
      // Received ET July 18 + 7 days.
      dueDate: '2026-07-25',
    });
  });

  it('recognizes assessment wording without a platform link (take-home)', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Next step: take-home project',
        bodyText: 'We would like you to complete a short take-home project.',
      }),
    );
    expect(result?.kind).toBe('assessment');
    expect(result?.url).toBeUndefined();
  });

  it('matches codility/codesignal/testdome hosts (subdomains included)', () => {
    for (const url of [
      'https://app.codility.com/test-session/x',
      'https://app.codesignal.com/company-tests/y',
      'https://www.testdome.com/tests/z',
    ]) {
      const result = classifyFollowupMail(
        mail({
          subject: 'Your assessment awaits',
          bodyText: `Start here: ${url}`,
        }),
      );
      expect(result?.kind).toBe('assessment');
      expect(result?.url).toBe(url);
    }
  });

  it('never keeps an http (non-https) platform link as the url', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Online assessment',
        bodyText: 'Start: http://www.hackerrank.com/test/abc',
      }),
    );
    expect(result?.kind).toBe('assessment');
    expect(result?.url).toBeUndefined();
  });

  it('never matches a lookalike host (nothackerrank.com)', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'A message about your application',
        bodyText: 'See https://nothackerrank.com/x for details.',
      }),
    );
    expect(result?.kind).not.toBe('assessment');
  });
});

describe('classifyFollowupMail — interview', () => {
  it('classifies an interview request and keeps the calendly link', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Re: Interview with Stripe',
        from: 'Jane Doe <jane@stripe.com>',
        bodyText:
          'We would love to schedule a call. Pick a time: https://calendly.com/jane-stripe/30min',
      }),
    );
    expect(result).toEqual({
      kind: 'interview',
      title: 'Interview — Interview with Stripe',
      url: 'https://calendly.com/jane-stripe/30min',
    });
  });

  it('keeps a goodtime link and phone-screen wording', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Phone screen availability',
        bodyText: 'Book here: https://app.goodtime.io/invite/xyz',
      }),
    );
    expect(result?.kind).toBe('interview');
    expect(result?.url).toBe('https://app.goodtime.io/invite/xyz');
  });
});

describe('classifyFollowupMail — rejection / offer', () => {
  it('classifies a rejection, even when it mentions the interview it concludes', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Your application to Figma',
        bodyText:
          'Thank you for taking the time to interview. Unfortunately, we have decided to move forward with other candidates.',
      }),
    );
    expect(result?.kind).toBe('rejection');
    expect(result?.title).toBe('Rejection — Your application to Figma');
  });

  it("classifies 'not moving forward' phrasing", () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Application update',
        bodyText: 'We will not be moving forward with your candidacy.',
      }),
    );
    expect(result?.kind).toBe('rejection');
  });

  it('classifies an offer with an explicit deadline date', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Your offer from Acme',
        bodyText:
          'We are pleased to offer you the SWE Intern position. Please respond by August 4.',
      }),
    );
    expect(result).toEqual({
      kind: 'offer',
      title: 'Offer — Your offer from Acme',
      dueDate: '2026-08-04',
    });
  });
});

describe('classifyFollowupMail — recruiter fallback and noise', () => {
  it('classifies a plausible recruiter mail as recruiter', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Your application at Datadog',
        from: 'Talent Team <talent@datadoghq.com>',
        bodyText:
          'Thanks for applying! A recruiter will review your application shortly.',
      }),
    );
    expect(result?.kind).toBe('recruiter');
    expect(result?.title).toBe('Recruiter — Your application at Datadog');
  });

  it('returns null for LinkedIn noise (job digests)', () => {
    expect(
      classifyFollowupMail(
        mail({
          subject: 'Ibraheem, jobs for you at 10 companies',
          from: 'LinkedIn <jobs-noreply@linkedin.com>',
          bodyText: 'Software Engineer Intern roles you may be interested in.',
        }),
      ),
    ).toBeNull();
  });

  it('returns null for Indeed/Glassdoor senders regardless of wording', () => {
    for (const from of [
      'Indeed <no-reply@indeed.com>',
      'Glassdoor <notifications@mail.glassdoor.com>',
    ]) {
      expect(
        classifyFollowupMail(
          mail({
            from,
            subject: 'Interview tips for your application',
            bodyText: 'A recruiter viewed your profile.',
          }),
        ),
      ).toBeNull();
    }
  });

  it('returns null for newsletters/digests and for plain non-recruiting mail', () => {
    expect(
      classifyFollowupMail(
        mail({
          subject: 'The Pragmatic Engineer Newsletter #42',
          bodyText: 'This week in tech...',
        }),
      ),
    ).toBeNull();
    expect(
      classifyFollowupMail(
        mail({
          subject: 'Your receipt from Cloudflare',
          bodyText: 'Thanks for your payment of $5.00.',
        }),
      ),
    ).toBeNull();
  });
});

describe('classifyFollowupMail — titles', () => {
  it('strips stacked Re:/Fwd: prefixes from the subject', () => {
    const result = classifyFollowupMail(
      mail({
        subject: 'Re: Fwd: RE: Interview with Vercel',
        bodyText: 'Can we schedule a call this week?',
      }),
    );
    expect(result?.title).toBe('Interview — Interview with Vercel');
  });

  it('falls back to the bare kind label for an empty subject', () => {
    const result = classifyFollowupMail(
      mail({
        subject: '',
        bodyText: 'Please complete the online assessment.',
      }),
    );
    expect(result?.title).toBe('Assessment');
  });

  it('caps the title at 300 chars', () => {
    const result = classifyFollowupMail(
      mail({
        subject: `Interview ${'x'.repeat(400)}`,
        bodyText: 'schedule a call',
      }),
    );
    expect(result?.title.length).toBe(300);
  });
});

describe('extractFollowupDueDate', () => {
  it("handles 'within N days' and 'in the next N days' relative to the received ET date", () => {
    expect(extractFollowupDueDate('complete within 7 days', RECEIVED_AT)).toBe(
      '2026-07-25',
    );
    expect(
      extractFollowupDueDate('in the next 3 days please', RECEIVED_AT),
    ).toBe('2026-07-21');
  });

  it('anchors relative dates to the ET calendar day, not the UTC one', () => {
    // 03:00Z on July 19 is still ET July 18 (EDT, UTC-4).
    expect(
      extractFollowupDueDate('within 2 days', new Date('2026-07-19T03:00:00Z')),
    ).toBe('2026-07-20');
  });

  it("handles 'by <Month> <day>' with and without a year", () => {
    expect(extractFollowupDueDate('respond by August 4', RECEIVED_AT)).toBe(
      '2026-08-04',
    );
    expect(
      extractFollowupDueDate('respond by Aug 4th, 2027', RECEIVED_AT),
    ).toBe('2027-08-04');
  });

  it('resolves a yearless date already past into NEXT year', () => {
    // Received July 18, 2026 — "by January 5" means January 5, 2027.
    expect(extractFollowupDueDate('reply by January 5', RECEIVED_AT)).toBe(
      '2027-01-05',
    );
  });

  it("handles 'by MM/DD' (US month-first) forms", () => {
    expect(extractFollowupDueDate('finish by 08/04', RECEIVED_AT)).toBe(
      '2026-08-04',
    );
    expect(extractFollowupDueDate('finish by 8/4/2026', RECEIVED_AT)).toBe(
      '2026-08-04',
    );
  });

  it('returns undefined for impossible dates and for text with no deadline', () => {
    expect(
      extractFollowupDueDate('finish by February 30', RECEIVED_AT),
    ).toBeUndefined();
    expect(
      extractFollowupDueDate('no deadline mentioned here', RECEIVED_AT),
    ).toBeUndefined();
  });
});
