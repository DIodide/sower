import { describe, expect, it } from 'vitest';
import { decodeHtmlEntitiesDeep, htmlToMarkdown } from './html-to-markdown.js';

describe('decodeHtmlEntitiesDeep', () => {
  it('decodes the named entity set, numeric, and hex forms', () => {
    expect(decodeHtmlEntitiesDeep('A &mdash; B &ndash; C')).toBe('A — B – C');
    expect(decodeHtmlEntitiesDeep('&ldquo;hi&rdquo; &lsquo;yo&rsquo;')).toBe(
      '“hi” ‘yo’',
    );
    expect(decodeHtmlEntitiesDeep('caf&eacute; &hellip; &bull; &middot;')).toBe(
      'café … • ·',
    );
    expect(decodeHtmlEntitiesDeep('It&#39;s &#x27;quoted&#x27;')).toBe(
      "It's 'quoted'",
    );
    expect(decodeHtmlEntitiesDeep('&quot;x&quot; &apos;y&apos;')).toBe(
      '"x" \'y\'',
    );
    expect(decodeHtmlEntitiesDeep('a&nbsp;b')).toBe('a b');
  });

  it('decodes double-encoded entities iteratively (the greenhouse shape)', () => {
    expect(decodeHtmlEntitiesDeep('&amp;lt;p&amp;gt;')).toBe('<p>');
    expect(decodeHtmlEntitiesDeep('&amp;mdash;')).toBe('—');
    // Triple encoding resolves within the 3-pass cap.
    expect(decodeHtmlEntitiesDeep('&amp;amp;lt;')).toBe('<');
  });

  it('preserves unknown entities and lone ampersands verbatim', () => {
    expect(decodeHtmlEntitiesDeep('&notarealentity; R&D AT&T')).toBe(
      '&notarealentity; R&D AT&T',
    );
  });

  it('refuses control-character and out-of-range numeric entities', () => {
    expect(decodeHtmlEntitiesDeep('a&#0;b&#7;c')).toBe('a&#0;b&#7;c');
    expect(decodeHtmlEntitiesDeep('&#xD800;')).toBe('&#xD800;');
  });
});

describe('htmlToMarkdown', () => {
  it('converts the double-encoded greenhouse shape to structured markdown', () => {
    // Greenhouse boards-API `content`: entity-encoded HTML whose text
    // entities are encoded once more (&amp;mdash; = &mdash; after pass 1).
    const content =
      '&lt;h2&gt;Who we are&lt;/h2&gt;\n' +
      '&lt;p&gt;Databricks &amp;mdash; the data team.&lt;/p&gt;\n' +
      '&lt;h3&gt;What you&amp;#39;ll do&lt;/h3&gt;\n' +
      '&lt;ul&gt;\n&lt;li&gt;Ship features&amp;nbsp;&lt;/li&gt;\n' +
      '&lt;li&gt;Talk to users&lt;/li&gt;\n&lt;/ul&gt;';
    expect(htmlToMarkdown(content)).toBe(
      '## Who we are\n\n' +
        'Databricks — the data team.\n\n' +
        "### What you'll do\n\n" +
        '- Ship features\n' +
        '- Talk to users',
    );
  });

  it('never leaks tags or entities into the output', () => {
    const out = htmlToMarkdown(
      '&lt;p&gt;A &amp;mdash; B&amp;nbsp;&amp;amp; C&lt;/p&gt;',
    );
    expect(out).toBe('A — B & C');
    expect(out).not.toMatch(/<[^>]+>/);
    expect(out).not.toContain('&mdash;');
    expect(out).not.toContain('&amp;');
  });

  it('maps <p> to paragraphs and <br> to line breaks', () => {
    expect(htmlToMarkdown('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToMarkdown('<p>line a<br>line b</p>')).toBe('line a\nline b');
    expect(htmlToMarkdown('<p>line a<br/>line b</p>')).toBe('line a\nline b');
  });

  it('treats <div> runs as block separation (the lever intro shape)', () => {
    expect(
      htmlToMarkdown('<div>first</div><div><br></div><div>second</div>'),
    ).toBe('first\n\nsecond');
  });

  it('renders unordered, ordered, and nested lists with 2-space indents', () => {
    expect(
      htmlToMarkdown(
        '<ul><li>alpha</li><li>beta<ul><li>beta.1</li><li>beta.2</li></ul></li><li>gamma</li></ul>',
      ),
    ).toBe('- alpha\n- beta\n  - beta.1\n  - beta.2\n- gamma');
    expect(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')).toBe(
      '1. first\n2. second',
    );
    expect(
      htmlToMarkdown('<ol><li>outer<ol><li>inner</li></ol></li></ol>'),
    ).toBe('1. outer\n  1. inner');
  });

  it('groups a stray <li> run (no <ul> wrapper) into one list', () => {
    // Lever's `lists[].content` is exactly this: bare <li> fragments.
    expect(htmlToMarkdown('<li>be smart</li><li>be very smart</li>')).toBe(
      '- be smart\n- be very smart',
    );
  });

  it('clamps headings: floor ##, cap ######', () => {
    expect(htmlToMarkdown('<h1>Top</h1>')).toBe('## Top');
    expect(htmlToMarkdown('<h2>Two</h2>')).toBe('## Two');
    expect(htmlToMarkdown('<h4>Four</h4>')).toBe('#### Four');
    expect(htmlToMarkdown('<h6>Six</h6>')).toBe('###### Six');
  });

  it('renders bold/italic with whitespace outside the markers', () => {
    expect(htmlToMarkdown('<p>a <strong>bold</strong> b</p>')).toBe(
      'a **bold** b',
    );
    expect(htmlToMarkdown('<p>a <b>bold </b>b</p>')).toBe('a **bold** b');
    expect(htmlToMarkdown('<p><em>it</em> and <i>al</i></p>')).toBe(
      '*it* and *al*',
    );
    // Content-free emphasis vanishes instead of emitting bare markers.
    expect(htmlToMarkdown('<p>x <strong> </strong> y</p>')).toBe('x y');
  });

  it('keeps a bolded short header paragraph as its own **Header:** block', () => {
    // Greenhouse's typical section shape: a <p> that is ONLY a bolded label
    // ending in ':' followed by the list it introduces. It stays a bold
    // paragraph — never an invented heading level.
    expect(
      htmlToMarkdown(
        '<p><strong>Requirements:</strong></p><ul><li>Grit</li><li>Curiosity</li></ul>',
      ),
    ).toBe('**Requirements:**\n\n- Grit\n- Curiosity');
  });

  it('converts anchors to [text](href) for http(s) targets only', () => {
    expect(
      htmlToMarkdown(
        '<p>See <a rel="noopener" class="x" href="https://example.com/jobs">our jobs</a>.</p>',
      ),
    ).toBe('See [our jobs](https://example.com/jobs).');
    // Non-http(s) schemes keep the words and drop the link.
    expect(
      htmlToMarkdown('<p><a href="mailto:hi@x.com">email us</a></p>'),
    ).toBe('email us');
    expect(
      htmlToMarkdown('<p><a href="javascript:alert(1)">click</a></p>'),
    ).toBe('click');
    expect(htmlToMarkdown('<p><a href="/relative">here</a></p>')).toBe('here');
    // Parens/spaces in the URL are encoded so the renderer's regex matches.
    expect(
      htmlToMarkdown('<p><a href="https://x.com/a(1) b">odd</a></p>'),
    ).toBe('[odd](https://x.com/a%281%29%20b)');
  });

  it('strips junk tags but keeps their text; drops script/style contents', () => {
    expect(
      htmlToMarkdown(
        '<p><span style="color:red">kept</span> <img src="x.png"> tail</p>',
      ),
    ).toBe('kept tail');
    expect(
      htmlToMarkdown(
        '<p>before</p><script>alert("nope")</script><style>.x{color:red}</style><p>after</p>',
      ),
    ).toBe('before\n\nafter');
    // A script reconstructed from double-encoded entities is dropped too.
    expect(
      htmlToMarkdown(
        '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;&lt;p&gt;safe&lt;/p&gt;',
      ),
    ).toBe('safe');
  });

  it('collapses whitespace: nbsp runs, source newlines, 3+ blank lines', () => {
    // Workday-style non-breaking-space padding runs collapse away entirely.
    expect(
      htmlToMarkdown('<p>a\u00a0\u00a0\u00a0b</p><p>\u00a0\u00a0</p><p>c</p>'),
    ).toBe('a b\n\nc');
    // Source newlines inside a paragraph are HTML whitespace, not breaks.
    expect(htmlToMarkdown('<p>one\ntwo</p>')).toBe('one two');
    expect(htmlToMarkdown('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });

  it('handles deeply nested inline wrappers (the workday span soup)', () => {
    expect(
      htmlToMarkdown(
        '<h2><b><span class="emphasis">Big header</span></b></h2><p><span><span>body text</span></span></p>',
      ),
    ).toBe('## **Big header**\n\nbody text');
  });

  it('is idempotent: plain text and its own output pass through unchanged', () => {
    const plain = 'Just a plain description.\n\nSecond paragraph.';
    expect(htmlToMarkdown(plain)).toBe(plain);
    const markdown =
      '## Role\n\n**Requirements:**\n\n- 3 yrs\n  - nested\n- [site](https://x.com)';
    expect(htmlToMarkdown(markdown)).toBe(markdown);
    const converted = htmlToMarkdown(
      '<h2>Role</h2><p><strong>Requirements:</strong></p><ul><li>3 yrs</li></ul>',
    );
    expect(htmlToMarkdown(converted)).toBe(converted);
  });

  it('returns empty string for empty or whitespace-only input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('  \n   ')).toBe('');
    expect(htmlToMarkdown('<p> </p><div><br></div>')).toBe('');
  });
});
