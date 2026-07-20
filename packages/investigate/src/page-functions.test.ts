import { describe, expect, it } from 'vitest';
import {
  assembleDescriptionMarkdown,
  collectAnchors,
  type MarkdownishNode,
  recoverEmbeddedDescription,
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

describe('assembleDescriptionMarkdown', () => {
  const assemble = (region: MarkdownishNode, maxChars = 20_000) =>
    assembleDescriptionMarkdown(region, serializeToMarkdown, maxChars);

  /** Order assertion helper: each needle appears, and in the given order. */
  const expectInOrder = (haystack: string, needles: string[]) => {
    let last = -1;
    for (const needle of needles) {
      const at = haystack.indexOf(needle);
      expect(at, `missing: ${needle}`).toBeGreaterThan(last);
      last = at;
    }
  };

  it('concatenates split JD sections (about + responsibilities + qualifications + pay) in DOM order', () => {
    // The TikTok shape: only ONE block is description/job-classed; the
    // others are anonymous sibling sections the old "largest single node"
    // heuristic silently dropped.
    const about = el(
      'div',
      [
        el('h2', [text('About the team')]),
        el('p', [
          text(
            'The Multimedia AI team focuses on building, researching, and applying large models to power global products at scale.',
          ),
        ]),
      ],
      { class: 'job-description' },
    );
    const responsibilities = el('section', [
      el('h2', [text('Responsibilities')]),
      el('ul', [
        el('li', [text('Support post-training strategies for LLMs')]),
        el('li', [text('Build robust evaluation pipelines')]),
      ]),
    ]);
    const qualifications = el('section', [
      el('h2', [text('Qualifications')]),
      el('ul', [
        el('li', [text('Currently pursuing a CS degree')]),
        el('li', [text('Strong Python and PyTorch experience')]),
      ]),
    ]);
    const pay = el('div', [
      el('p', [text('The hourly rate range for this position is $45 - $45.')]),
    ]);
    const region = el('main', [
      el('nav', [text('Home | Jobs')]),
      el('div', [about, responsibilities, qualifications, pay]),
      el('footer', [text('© MegaCorp')]),
    ]);

    const { markdown, truncated } = assemble(region);
    expectInOrder(markdown, [
      '## About the team',
      '## Responsibilities',
      '- Support post-training strategies',
      '## Qualifications',
      '- Currently pursuing a CS degree',
      'hourly rate range',
    ]);
    expect(markdown).not.toContain('Home | Jobs');
    expect(markdown).not.toContain('© MegaCorp');
    expect(truncated).toBe(false);
  });

  it('keeps a LARGE anonymous sibling alongside a small description-classed node (never shadowed)', () => {
    const bigText =
      'Design, build, and operate distributed systems that serve billions. '.repeat(
        80,
      );
    const small = el(
      'div',
      [el('p', [text('Pay Transparency: the hourly rate is $45 an hour.')])],
      { class: 'compensation-description' },
    );
    const large = el('div', [
      el('h2', [text('Responsibilities')]),
      el('p', [text(bigText)]),
    ]);
    const region = el('main', [el('div', [small, large])]);

    const { markdown } = assemble(region);
    expect(markdown).toContain('Pay Transparency');
    expect(markdown).toContain('## Responsibilities');
    expect(markdown.length).toBeGreaterThan(5_000);
    // DOM order: the small pay node comes first on this page.
    expect(markdown.indexOf('Pay Transparency')).toBeLessThan(
      markdown.indexOf('## Responsibilities'),
    );
  });

  it('never serializes a nested block twice (description node inside a posting node)', () => {
    const inner = el(
      'div',
      [
        el('p', [
          text(
            'The one true responsibilities paragraph, long enough to matter for the assembled description of this role.',
          ),
        ]),
      ],
      { class: 'job-description' },
    );
    const outer = el('div', [el('h2', [text('The role')]), inner], {
      class: 'posting-body',
    });
    const sibling = el('div', [
      el('p', [
        text(
          'Qualifications: TypeScript, strong systems fundamentals, and a demonstrated love of tests.',
        ),
      ]),
    ]);
    const region = el('main', [el('div', [outer, sibling])]);

    const { markdown } = assemble(region);
    const occurrences =
      markdown.split('one true responsibilities paragraph').length - 1;
    expect(occurrences).toBe(1);
    expect(markdown).toContain('Qualifications: TypeScript');
  });

  it('skips link-farm siblings (footer menus that are NOT inside nav/footer tags)', () => {
    // The lifeattiktok.com case: the site menu/footer is plain divs of
    // [label](url) link lists — mostly link syntax, so the density check
    // drops them even though no nav/footer tag marks them as chrome.
    const linkFarm = el('div', [
      el('h4', [text('Company')]),
      ...Array.from({ length: 8 }, (_, i) =>
        el('a', [text(`Link ${i}`)], {
          href: `https://example.com/some/deep/path-${i}`,
        }),
      ),
    ]);
    const jd = el(
      'div',
      [
        el('h2', [text('Responsibilities')]),
        el('p', [
          text(
            'Support the development and optimization of post-training strategies for large models, and help the team ship. '.repeat(
              3,
            ),
          ),
        ]),
      ],
      { class: 'job-description' },
    );
    const region = el('main', [el('div', [linkFarm, jd])]);

    const { markdown } = assemble(region);
    expect(markdown).toContain('## Responsibilities');
    expect(markdown).not.toContain('#### Company');
    expect(markdown).not.toContain('deep/path-');
  });

  it('serializes the whole region when nothing is description-classed', () => {
    const region = el('main', [
      el('h1', [text('SWE Intern')]),
      el('p', [
        text(
          'A plain page with no description-classed markup at all, but plenty of real content to serialize for the caller.',
        ),
      ]),
    ]);
    expect(assemble(region).markdown).toBe(
      serializeToMarkdown(region, 20_000).markdown,
    );
  });

  it('falls back to the whole region when the anchor family is tiny', () => {
    const region = el('main', [
      el('div', [el('p', [text('Short blurb.')])], { class: 'description' }),
      el('p', [
        text('Body copy that lives outside the anchor family... '.repeat(6)),
      ]),
    ]);
    // Family (anchor + its region-level sibling) and region agree here; the
    // point is that a tiny assembly yields the region serialization, never
    // an empty/near-empty description.
    expect(assemble(region).markdown).toBe(
      serializeToMarkdown(region, 20_000).markdown,
    );
  });

  it('caps the assembled markdown at maxChars and flags truncation', () => {
    const sections = Array.from({ length: 40 }, (_, i) =>
      el('section', [
        el('h2', [text(`Section ${i}`)]),
        el('p', [
          text(`Padding paragraph number ${i} with some text. `.repeat(4)),
        ]),
      ]),
    );
    const anchor = el(
      'div',
      [el('p', [text('About the role: build things that scale nicely.')])],
      { class: 'job-description' },
    );
    const region = el('main', [el('div', [anchor, ...sections])]);
    const { markdown, truncated } = assemble(region, 2_000);
    expect(truncated).toBe(true);
    expect(markdown.length).toBeLessThanOrEqual(2_000);
  });
});

/** Live-excerpt-shaped JD text (lifeattiktok.com/search/7631599293708126517). */
const TIKTOK_CHUNK_ONE = [
  'The Multimedia AI team at TikTok focuses on building, researching, and applying Large Language Models (LLMs) to power our global products. We believe the most impactful problems in AI arise at the intersection of research and real-world deployment—and post-training is where that intersection is sharpest.',
  '',
  'We are looking for talented individuals to join us for an internship in 2026. Internships at our Company aim to offer students industry exposure and hands-on experience. Watch your ambitions become reality as your inspiration brings infinite opportunities at our Company.',
  '',
  'Candidates can apply to a maximum of two positions and will be considered for jobs in the order you apply. Applications will be reviewed on a rolling basis - we encourage you to apply early. Please state your availability clearly in your resume (Start date, End date).',
  '',
  'Summer Start Dates:',
  'May 11th, 2026',
  'May 18th, 2026',
  'May 26th, 2026',
  'June 8th, 2026',
  'June 22nd, 2026',
  '',
  'Responsibilities',
  '- Support the development and optimization of post-training strategies, including instruction tuning, preference tuning (SFT/DPO/PPO), and model alignment.',
  '- Assist in building robust evaluation pipelines to measure model performance, helpfulness, and safety across diverse multimedia product use cases.',
  '- Participate in the research and implementation of cutting-edge methodologies in reward modeling and human preference learning.',
  '- Collaborate with engineering teams to bridge the gap between experimental research and production-ready AI applications (e.g., video understanding, translation, and content classification).',
  '- Analyze and process large-scale datasets to identify patterns that improve model behavior and alignment quality.',
].join('\n');

const TIKTOK_CHUNK_TWO = [
  'Minimum Qualifications:',
  '- Currently pursuing an Undergraduate or Master’s degree in Computer Science, Machine Learning, or a related technical discipline.',
  '- Strong programming skills in Python and experience with deep learning frameworks such as PyTorch or JAX.',
  '- Foundational understanding of Transformer architectures and LLM training principles.',
  '- Demonstrated ability to learn quickly in a fast-paced environment and a strong passion for AI "landing" and product application.',
  '- Able to commit to working for 12 weeks in 2026',
  '',
  'Preferred Qualifications:',
  '- Previous experience or research projects involving LLM fine-tuning, RLHF, or synthetic data generation.',
  '- Familiarity with distributed training tools (e.g., DeepSpeed, Megatron-LM).',
  '- Experience or interest in multimodal AI (integrating text with video or audio).',
].join('\n');

describe('recoverEmbeddedDescription', () => {
  const failingHtmlToMarkdown = (html: string): string => {
    throw new Error(`html conversion should not run for: ${html.slice(0, 40)}`);
  };

  it('recovers + unescapes a TikTok-shaped JD split across React-flight push chunks', () => {
    // The live case: the JD ships as escaped plain-text string literals in
    // SEPARATE `self.__next_f.push` script tags — neither chunk qualifies
    // alone (one marker / too short), the stitched candidate does.
    const scripts = [
      `self.__next_f.push([1,${JSON.stringify(TIKTOK_CHUNK_ONE)}])`,
      `self.__next_f.push([1,${JSON.stringify(`32:T479,${TIKTOK_CHUNK_TWO}33:T8f5,`)}])`,
    ];
    const result = recoverEmbeddedDescription(
      scripts,
      1_421,
      failingHtmlToMarkdown,
      20_000,
    );
    expect(result).not.toBeNull();
    const markdown = result?.markdown ?? '';
    // Unescaped: real newlines and `- ` bullets, no literal \n sequences.
    expect(markdown).toContain('The Multimedia AI team at TikTok');
    expect(markdown).toContain('Summer Start Dates:\nMay 11th, 2026');
    expect(markdown).toContain(
      'Responsibilities\n- Support the development and optimization',
    );
    expect(markdown).not.toContain('\\n');
    // Both chunks present, in document order; flight text refs stripped.
    expect(markdown.indexOf('Responsibilities')).toBeLessThan(
      markdown.indexOf('Minimum Qualifications:'),
    );
    expect(markdown).not.toContain('32:T479');
    expect(markdown).not.toContain('33:T8f5');
    // ≥2 distinct markers and ≥1.5× the 1,421-char DOM extraction.
    expect(markdown.length).toBeGreaterThan(2_132);
    expect(result?.truncated).toBe(false);
  });

  it('recovers the JD from a window.__DATA__ assignment payload', () => {
    const payload = {
      job: {
        id: '7631599293708126517',
        description: `${TIKTOK_CHUNK_ONE}\n\n${TIKTOK_CHUNK_TWO}`,
      },
    };
    const scripts = [
      `window.__DATA__ = ${JSON.stringify(payload)};${' '.repeat(400)}`,
    ];
    const result = recoverEmbeddedDescription(
      scripts,
      0,
      failingHtmlToMarkdown,
      20_000,
    );
    expect(result?.markdown).toContain('The Multimedia AI team at TikTok');
    expect(result?.markdown).toContain('Minimum Qualifications:');
    expect(result?.markdown).not.toContain('\\n');
  });

  it('recovers the JD from a bare JSON-blob script (JSON-LD style)', () => {
    const blob = JSON.stringify({
      '@type': 'JobPosting',
      title: 'ML Intern',
      description: `${TIKTOK_CHUNK_ONE}\n\n${TIKTOK_CHUNK_TWO}`,
    });
    const result = recoverEmbeddedDescription(
      [blob],
      500,
      failingHtmlToMarkdown,
      20_000,
    );
    expect(result?.markdown).toContain('Responsibilities');
    expect(result?.markdown).toContain('Preferred Qualifications:');
  });

  it('routes an HTML-valued payload through htmlToMarkdown', () => {
    const html = `<div class="editor-content"><h3>About the role</h3><p>${'Build multimedia AI products for a global audience. '.repeat(40)}</p><h3>Responsibilities</h3><ul><li>Ship models</li><li>Evaluate pipelines</li></ul><h3>Minimum Qualifications</h3><ul><li>Pursuing a CS degree</li></ul></div>`;
    const converted: string[] = [];
    const htmlToMarkdown = (value: string): string => {
      converted.push(value);
      return `### CONVERTED MARKDOWN ###\n\n${value.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ')}`;
    };
    const result = recoverEmbeddedDescription(
      [`window.__STATE__ = ${JSON.stringify({ jd: html })}`],
      0,
      htmlToMarkdown,
      20_000,
    );
    expect(converted).toEqual([html]);
    expect(result?.markdown).toContain('### CONVERTED MARKDOWN ###');
  });

  it('returns null when nothing qualifies (DOM result stands)', () => {
    // Long but markerless; marked but short; empty — none qualify.
    const lorem = 'All work and no play makes for dull descriptions here. ';
    expect(
      recoverEmbeddedDescription(
        [
          `self.__next_f.push([1,${JSON.stringify(lorem.repeat(60))}])`,
          `self.__next_f.push([1,${JSON.stringify('Responsibilities and Qualifications')}])`,
          '',
          null,
        ],
        1_000,
        failingHtmlToMarkdown,
        20_000,
      ),
    ).toBeNull();
  });

  it('returns null when the payload is not ≥1.5× the DOM extraction', () => {
    const jd = `${TIKTOK_CHUNK_ONE}\n\n${TIKTOK_CHUNK_TWO}`;
    const scripts = [`window.__DATA__ = ${JSON.stringify({ jd })}`];
    const domChars = Math.ceil(jd.length / 1.4); // 1.4x < required 1.5x
    expect(
      recoverEmbeddedDescription(
        scripts,
        domChars,
        failingHtmlToMarkdown,
        20_000,
      ),
    ).toBeNull();
  });

  it('discards JSON-structured payloads (React flight trees) even when they contain marker words', () => {
    const flightTree = `f:["$","div",null,{"className":"${'x'.repeat(1_600)}","children":["Responsibilities","Qualifications","Requirements"]}]`;
    expect(
      recoverEmbeddedDescription(
        [`self.__next_f.push([1,${JSON.stringify(flightTree)}])`],
        0,
        failingHtmlToMarkdown,
        20_000,
      ),
    ).toBeNull();
  });

  it('caps the recovered markdown at maxChars with a truncation flag', () => {
    const jd = `${TIKTOK_CHUNK_ONE}\n\n${TIKTOK_CHUNK_TWO}`;
    const result = recoverEmbeddedDescription(
      [`window.__DATA__ = ${JSON.stringify({ jd })}`],
      0,
      failingHtmlToMarkdown,
      600,
    );
    expect(result?.truncated).toBe(true);
    expect(result?.markdown.length).toBeLessThanOrEqual(600);
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
