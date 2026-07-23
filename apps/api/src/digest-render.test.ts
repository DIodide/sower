import { describe, expect, it } from 'vitest';
import type { WeeklyDigest } from './digest.js';
import {
  EMAIL_DASHBOARD_BASE_URL,
  renderDigestDiscord,
  renderDigestDiscordEmbed,
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

describe('renderDigestDiscordEmbed', () => {
  /** Total chars Discord counts toward the 6000-char embed cap. */
  function embedSize(embed: ReturnType<typeof renderDigestDiscordEmbed>) {
    return (
      (embed.title?.length ?? 0) +
      (embed.fields ?? []).reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      )
    );
  }

  it('renders one field per section with the same lines as the text digest', () => {
    const embed = renderDigestDiscordEmbed(
      filledDigest(),
      'https://dash.example/',
    );

    expect(embed.title).toBe('Sower weekly — Jul 18');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.timestamp).toBe(NOW.toISOString());
    // One field per section; names carry counts but no markdown bold.
    expect(embed.fields?.map((field) => field.name)).toEqual([
      '📤 Submitted (2)',
      '📥 New — 12 ingested · 3 auto-discarded',
      '⏳ Waiting on you (4)',
      '⏰ Deadlines this week (2)',
      '🎯 In play (2)',
      '🕸 Going stale (1)',
    ]);
    const submitted = embed.fields?.[0]?.value ?? '';
    // Field values keep the markdown links + escaping (embeds render them).
    expect(submitted).toContain(`(https://dash.example/tasks/${T1})`);
    expect(submitted).toContain('SWE Intern \\[2027\\] \\*special\\*');
    const waiting = embed.fields?.[2]?.value ?? '';
    expect(waiting).not.toContain('@everyone');
    expect(waiting).toContain('@​everyone');
    const inPlay = embed.fields?.[4]?.value ?? '';
    expect(inPlay).toContain(`(https://dash.example/followups/${F1})`);
  });

  it('renders an empty pipeline with placeholder values (never an empty field)', () => {
    const embed = renderDigestDiscordEmbed(
      emptyDigest(),
      'https://dash.example',
    );
    expect(embed.fields).toHaveLength(6);
    for (const field of embed.fields ?? []) {
      expect(field.value.length).toBeGreaterThan(0);
    }
    expect(embed.fields?.[0]).toEqual({ name: '📤 Submitted (0)', value: '—' });
    expect(JSON.stringify(embed)).not.toContain('undefined');
  });

  it('keeps every field value ≤1024 (… and N more) and the total ≤5800', () => {
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

    const embed = renderDigestDiscordEmbed(digest, 'https://dash.example');

    for (const field of embed.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(embedSize(embed)).toBeLessThanOrEqual(5800);
    const deadlines = embed.fields?.[3];
    // The full count survives in the name; the value collapses.
    expect(deadlines?.name).toBe('⏰ Deadlines this week (40)');
    expect(deadlines?.value).toContain('… and ');
  });

  it('shrinks EVERY section together when the embed total would overflow', () => {
    const digest = filledDigest();
    const longTitle = 'T'.repeat(180);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        taskId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
        company: `C${i}`,
        title: longTitle,
        at: new Date('2026-07-15T12:00:00Z'),
      }));
    digest.submitted = { count: 30, items: many(30) };
    digest.deadlines = many(30).map((item) => ({
      kind: 'task' as const,
      id: item.taskId,
      company: item.company,
      title: item.title,
      due: new Date('2026-07-20T04:00:00Z'),
    }));
    digest.stale = {
      count: 30,
      oldest: many(30).map((item) => ({
        taskId: item.taskId,
        company: item.company,
        title: item.title,
        days: 10,
      })),
    };

    const embed = renderDigestDiscordEmbed(digest, 'https://dash.example');

    expect(embedSize(embed)).toBeLessThanOrEqual(5800);
    expect(embed.fields).toHaveLength(6);
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
