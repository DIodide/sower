import { describe, expect, it } from 'vitest';
import {
  collectAnchors,
  type MarkdownishNode,
  scoreApplyControlText,
  serializeToMarkdown,
} from './page-functions.js';

describe('scoreApplyControlText', () => {
  it('scores exact apply-style phrases highest (3), any case/punctuation', () => {
    for (const text of [
      'Apply',
      'Apply now',
      'APPLY NOW',
      'Apply for this job',
      'Apply for this role',
      'Start Application',
      'Start your application',
      'Begin Application',
      'Submit Application',
      "I'm interested", // apostrophe stripped by normalization
      'I am interested',
      'Apply →',
    ]) {
      expect(scoreApplyControlText(text), text).toBe(3);
    }
  });

  it('scores apply-prefixed and "continue to application" as 2', () => {
    expect(scoreApplyControlText('Apply for the SWE Intern role')).toBe(2);
    expect(scoreApplyControlText('Apply with LinkedIn profile')).toBe(2);
    expect(scoreApplyControlText('Continue to application')).toBe(2);
  });

  it('scores a bare generic "continue" as 1', () => {
    expect(scoreApplyControlText('Continue')).toBe(1);
  });

  it('scores non-apply controls 0', () => {
    for (const text of [
      'Learn more',
      'Sign in',
      'Search jobs',
      'Save job',
      'Share',
      '',
      null,
      undefined,
      'x'.repeat(80), // over the length cap
    ]) {
      expect(scoreApplyControlText(text), String(text)).toBe(0);
    }
  });

  it('ranks "Start Application" above "Continue"', () => {
    expect(scoreApplyControlText('Start Application')).toBeGreaterThan(
      scoreApplyControlText('Continue'),
    );
  });
});

/** Fake-node builders — the serializer works on any structural node tree. */
function text(t: string): MarkdownishNode {
  return { nodeType: 3, textContent: t };
}

function el(
  tag: string,
  children: MarkdownishNode[] = [],
  attrs: Record<string, string> = {},
): MarkdownishNode {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    className: attrs.class ?? '',
    id: attrs.id ?? '',
    href: attrs.href,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

function md(node: MarkdownishNode, maxChars = 20_000): string {
  return serializeToMarkdown(node, maxChars).markdown;
}

describe('serializeToMarkdown', () => {
  it('renders headings and paragraphs', () => {
    const root = el('div', [
      el('h1', [text('Software Engineer Intern')]),
      el('h2', [text('About the role')]),
      el('p', [text('You will build systems.')]),
      el('h3', [text('Requirements')]),
      el('p', [text('You know TypeScript.')]),
    ]);
    expect(md(root)).toBe(
      [
        '# Software Engineer Intern',
        '',
        '## About the role',
        '',
        'You will build systems.',
        '',
        '### Requirements',
        '',
        'You know TypeScript.',
      ].join('\n'),
    );
  });

  it('renders unordered, ordered, and nested lists', () => {
    const root = el('div', [
      el('ul', [
        el('li', [text('First bullet')]),
        el('li', [
          text('Second bullet'),
          el('ul', [el('li', [text('Nested bullet')])]),
        ]),
      ]),
      el('ol', [el('li', [text('Step one')]), el('li', [text('Step two')])]),
    ]);
    expect(md(root)).toBe(
      [
        '- First bullet',
        '- Second bullet',
        '  - Nested bullet',
        '',
        '1. Step one',
        '2. Step two',
      ].join('\n'),
    );
  });

  it('renders strong/em/links/br inline formatting', () => {
    const root = el('div', [
      el('p', [
        text('We want '),
        el('strong', [text('great')]),
        text(' and '),
        el('em', [text('curious')]),
        text(' people. See '),
        el('a', [text('our site')], { href: 'https://example.com/about' }),
        text('.'),
      ]),
      el('p', [text('Line one'), el('br'), text('Line two')]),
    ]);
    expect(md(root)).toBe(
      [
        'We want **great** and *curious* people. See [our site](https://example.com/about).',
        '',
        'Line one',
        'Line two',
      ].join('\n'),
    );
  });

  it('renders anchors without an absolute http(s) href as plain text', () => {
    const root = el('p', [
      el('a', [text('apply here')], { href: 'javascript:void(0)' }),
    ]);
    expect(md(el('div', [root]))).toBe('apply here');
  });

  it('renders tables as pipe rows with a separator after the first row', () => {
    const root = el('table', [
      el('thead', [
        el('tr', [el('th', [text('Location')]), el('th', [text('Salary')])]),
      ]),
      el('tbody', [
        el('tr', [el('td', [text('NYC')]), el('td', [text('$120k')])]),
        el('tr', [el('td', [text('Chicago')]), el('td', [text('$110k')])]),
      ]),
    ]);
    expect(md(root)).toBe(
      [
        '| Location | Salary |',
        '| --- | --- |',
        '| NYC | $120k |',
        '| Chicago | $110k |',
      ].join('\n'),
    );
  });

  it('skips scripts, nav/header/footer/aside, forms, and cookie banners', () => {
    const root = el('div', [
      el('script', [text('window.tracker = 1;')]),
      el('nav', [text('Home | Jobs | About')]),
      el('header', [text('MegaCorp Careers')]),
      el('div', [text('We use cookies to improve your experience.')], {
        class: 'cookie-banner',
      }),
      el('div', [text('Manage consent preferences')], { id: 'gdpr-consent' }),
      el('form', [text('Email: subscribe now')]),
      el('div', [text('Menu')], { role: 'navigation' }),
      el('p', [text('The real description.')]),
      el('footer', [text('© MegaCorp')]),
    ]);
    expect(md(root)).toBe('The real description.');
  });

  it('skips hidden elements (checkVisibility false)', () => {
    const hidden = el('p', [text('hidden boilerplate')]);
    hidden.checkVisibility = () => false;
    const root = el('div', [hidden, el('p', [text('visible text')])]);
    expect(md(root)).toBe('visible text');
  });

  it('collapses blank runs to at most one empty line', () => {
    const root = el('div', [
      el('div', []),
      el('p', [text('one')]),
      el('div', [el('div', []), el('div', [])]),
      el('p', [text('two')]),
    ]);
    expect(md(root)).toBe('one\n\ntwo');
  });

  it('caps output at maxChars and flags truncation (cutting at a line break)', () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) =>
      el('p', [text(`Paragraph number ${i} with some padding text.`)]),
    );
    const { markdown, truncated } = serializeToMarkdown(
      el('div', paragraphs),
      500,
    );
    expect(truncated).toBe(true);
    expect(markdown.length).toBeLessThanOrEqual(500);
    expect(markdown.endsWith('.')).toBe(true); // cut on a whole line
  });

  it('does not flag truncation under the cap', () => {
    const { markdown, truncated } = serializeToMarkdown(
      el('p', [text('short')]),
      500,
    );
    expect(markdown).toBe('short');
    expect(truncated).toBe(false);
  });
});

describe('collectAnchors', () => {
  const anchor = (href: string, label: string) =>
    el('a', [text(label)], { href });

  it('collects content anchors and skips nav/header/footer/aside and cookie-banner chrome', () => {
    // An SPA-ish listing page: job cards in main, chrome links around them.
    const root = el('div', [
      el('nav', [anchor('https://example.com/about', 'About')]),
      el('header', [anchor('https://example.com', 'MegaCorp Careers')]),
      el('div', [
        el('div', [
          anchor(
            'https://example.com/careers/jobs/swe-intern-1234',
            'Software Engineer Intern',
          ),
        ]),
        el('div', [
          anchor(
            'https://example.com/careers/jobs/pm-intern-5678',
            'Product Manager Intern',
          ),
        ]),
      ]),
      el('div', [anchor('https://example.com/privacy', 'cookie policy')], {
        class: 'cookie-banner',
      }),
      el('div', [anchor('https://example.com/menu', 'Menu')], {
        role: 'navigation',
      }),
      el('footer', [anchor('https://example.com/legal', 'Legal')]),
    ]);
    expect(collectAnchors(root, 100)).toEqual([
      {
        href: 'https://example.com/careers/jobs/swe-intern-1234',
        text: 'Software Engineer Intern',
      },
      {
        href: 'https://example.com/careers/jobs/pm-intern-5678',
        text: 'Product Manager Intern',
      },
    ]);
  });

  it('skips hidden anchors and non-http(s) hrefs', () => {
    const hidden = anchor('https://example.com/jobs/1', 'Hidden job');
    hidden.checkVisibility = () => false;
    const root = el('div', [
      hidden,
      el('a', [text('apply')], { href: 'javascript:void(0)' }),
      el('a', [text('mail us')], { href: 'mailto:jobs@example.com' }),
      el('a', [text('no href')]),
      anchor('https://example.com/jobs/2', 'Visible job'),
    ]);
    expect(collectAnchors(root, 100)).toEqual([
      { href: 'https://example.com/jobs/2', text: 'Visible job' },
    ]);
  });

  it('normalizes whitespace in nested anchor text (job-card markup)', () => {
    const card = el(
      'a',
      [
        el('h3', [text('  Software Engineer\n  Intern ')]),
        el('span', [text(' New York ')]),
      ],
      { href: 'https://example.com/jobs/3' },
    );
    expect(collectAnchors(el('div', [card]), 100)).toEqual([
      {
        href: 'https://example.com/jobs/3',
        text: 'Software Engineer Intern New York',
      },
    ]);
  });

  it('caps the collection at maxAnchors', () => {
    const root = el(
      'div',
      Array.from({ length: 20 }, (_, i) =>
        anchor(`https://example.com/jobs/${i}`, `Job ${i}`),
      ),
    );
    expect(collectAnchors(root, 5)).toHaveLength(5);
  });
});
