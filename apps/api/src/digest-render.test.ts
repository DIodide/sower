import { describe, expect, it } from 'vitest';
import type { WeeklyDigest } from './digest.js';
import {
  EMAIL_DASHBOARD_BASE_URL,
  renderDigestDiscord,
  renderDigestEmail,
} from './digest-render.js';

/** Noon ET on July 18, 2026. */
const NOW = new Date('2026-07-18T16:00:00Z');

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const F1 = 'bbbbbbbb-0000-4000-8000-000000000001';

function emptyDigest(): WeeklyDigest {
  return {
    now: NOW,
    submitted: { count: 0, items: [] },
    ingested: { created: 0, autoDiscarded: 0 },
    waiting: { count: 0, top: [] },
    deadlines: [],
    inPlay: { count: 0, byState: {} },
    stale: { count: 0, oldest: [] },
  };
}

/** A digest with every section populated — titles deliberately hostile. */
function filledDigest(): WeeklyDigest {
  return {
    now: NOW,
    submitted: {
      count: 2,
      items: [
        {
          taskId: T1,
          company: 'Acme',
          title: 'SWE Intern [2027] *special*',
          at: new Date('2026-07-15T12:00:00Z'),
        },
        {
          taskId: 'aaaaaaaa-0000-4000-8000-000000000002',
          company: 'Globex',
          title: null,
          at: new Date('2026-07-17T12:00:00Z'),
        },
      ],
    },
    ingested: { created: 12, autoDiscarded: 3 },
    waiting: {
      count: 4,
      top: [
        {
          taskId: 'aaaaaaaa-0000-4000-8000-000000000003',
          company: '<script>alert(1)</script> Corp',
          title: 'Intern @everyone',
          priority: 2,
          due: new Date('2026-07-20T04:00:00Z'),
        },
        {
          taskId: 'aaaaaaaa-0000-4000-8000-000000000004',
          company: 'Initech',
          title: 'PM Intern',
          priority: 0,
          due: null,
        },
      ],
    },
    deadlines: [
      {
        kind: 'task',
        id: T1,
        company: 'Acme',
        title: 'SWE Intern [2027] *special*',
        due: new Date('2026-07-20T04:00:00Z'),
      },
      {
        kind: 'followup',
        id: F1,
        company: 'Akuna Capital',
        title: 'HackerRank OA',
        due: new Date('2026-07-22T04:00:00Z'),
      },
    ],
    inPlay: {
      count: 2,
      byState: {
        ACTION_NEEDED: [
          {
            followupId: F1,
            kind: 'assessment',
            company: 'Akuna Capital',
            title: 'HackerRank OA',
          },
        ],
        WAITING: [
          {
            followupId: 'bbbbbbbb-0000-4000-8000-000000000002',
            kind: 'recruiter',
            company: 'Acme',
            title: 'Recruiter reply',
          },
        ],
      },
    },
    stale: {
      count: 1,
      oldest: [
        {
          taskId: 'aaaaaaaa-0000-4000-8000-000000000005',
          company: 'Stale Co',
          title: 'Old Role',
          days: 13,
        },
      ],
    },
  };
}

describe('renderDigestDiscord', () => {
  it('renders every section with counts, dashboard links, and escaped labels', () => {
    const text = renderDigestDiscord(filledDigest(), 'https://dash.example/');

    expect(text).toContain('**Sower weekly** — Jul 18');
    expect(text).toContain('📤 **Submitted** (2)');
    expect(text).toContain('📥 **New** — 12 ingested · 3 auto-discarded');
    expect(text).toContain('⏳ **Waiting on you** (4)');
    expect(text).toContain('⏰ **Deadlines this week** (2)');
    expect(text).toContain('🎯 **In play** (2)');
    expect(text).toContain('🕸 **Going stale** (1)');
    // Trailing slash on the base is normalized; ids are only link targets.
    expect(text).toContain(`(https://dash.example/tasks/${T1})`);
    expect(text).toContain(`(https://dash.example/followups/${F1})`);
    // Markdown-breaking title characters are escaped inside the link…
    expect(text).toContain('SWE Intern \\[2027\\] \\*special\\*');
    // …and mentions are neutralized (zero-width space after '@').
    expect(text).not.toContain('@everyone');
    expect(text).toContain('@​everyone');
    // Group labels and priority labels render.
    expect(text).toContain('Action needed: ');
    expect(text).toContain('— Highest · due Jul 20');
    expect(text).toContain('untouched 13 days');
    expect(text.length).toBeLessThanOrEqual(1900);
  });

  it('degrades to bold labels when no dashboard base URL is configured', () => {
    const text = renderDigestDiscord(filledDigest());
    expect(text).not.toContain('](');
    expect(text).toContain('**Acme — SWE Intern \\[2027\\] \\*special\\***');
  });

  it('renders an empty pipeline sensibly (headers with zero counts, no bullets)', () => {
    const text = renderDigestDiscord(emptyDigest(), 'https://dash.example');
    expect(text).toContain('📤 **Submitted** (0)');
    expect(text).toContain('📥 **New** — 0 ingested · 0 auto-discarded');
    expect(text).not.toContain('•');
    expect(text).not.toContain('undefined');
    expect(text.length).toBeLessThanOrEqual(1900);
  });

  it('truncates whole sections ("… and N more") to stay under the 1900 cap', () => {
    const digest = filledDigest();
    const longTitle = 'Very Long Software Engineering Internship Title'.repeat(
      3,
    );
    digest.deadlines = Array.from({ length: 40 }, (_, i) => ({
      kind: 'task' as const,
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      company: `Company Number ${i}`,
      title: longTitle,
      due: new Date('2026-07-20T04:00:00Z'),
    }));

    const text = renderDigestDiscord(digest, 'https://dash.example');

    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain('… and ');
    // The section header (with its full count) always survives.
    expect(text).toContain('⏰ **Deadlines this week** (40)');
  });
});

describe('renderDigestEmail', () => {
  it('builds the subject from the headline counts and the ET date', () => {
    expect(renderDigestEmail(filledDigest()).subject).toBe(
      'Sower weekly — 2 sent, 2 deadlines, 2 in play (Jul 18)',
    );
    const one = filledDigest();
    one.deadlines = one.deadlines.slice(0, 1);
    expect(renderDigestEmail(one).subject).toContain('1 deadline,');
  });

  it('renders self-contained HTML with escaped labels and absolute dashboard links', () => {
    const { html } = renderDigestEmail(filledDigest());

    expect(html).toContain('<!doctype html>');
    // Untrusted titles are HTML-escaped everywhere they appear.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Corp');
    // Links are absolute to the public dashboard.
    expect(html).toContain(`${EMAIL_DASHBOARD_BASE_URL}/tasks/${T1}`);
    expect(html).toContain(`${EMAIL_DASHBOARD_BASE_URL}/followups/${F1}`);
    // Inline styles only — no external assets of any kind.
    expect(html).not.toContain('<link');
    expect(html).not.toContain('src=');
    expect(html).toContain('📤 Submitted (2)');
    expect(html).toContain('🕸 Going stale (1)');
  });

  it('mirrors the sections as plain text', () => {
    const { text } = renderDigestEmail(filledDigest());
    expect(text).toContain('Sower weekly — Jul 18');
    expect(text).toContain('📤 Submitted (2)');
    expect(text).toContain(
      `  - Acme — SWE Intern [2027] *special* — Jul 15 <${EMAIL_DASHBOARD_BASE_URL}/tasks/${T1}>`,
    );
    expect(text).toContain('📥 New — 12 ingested, 3 auto-discarded');
    expect(text).not.toContain('<a ');
  });

  it('renders an empty pipeline sensibly in both bodies', () => {
    const { subject, html, text } = renderDigestEmail(emptyDigest());
    expect(subject).toBe(
      'Sower weekly — 0 sent, 0 deadlines, 0 in play (Jul 18)',
    );
    expect(html).toContain('Nothing sent this week.');
    expect(html).toContain('No deadlines in the next 7 days.');
    expect(text).toContain('Nothing is waiting on you.');
    expect(html).not.toContain('undefined');
    expect(text).not.toContain('undefined');
  });
});
