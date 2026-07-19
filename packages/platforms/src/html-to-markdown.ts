/**
 * Dependency-free HTML → markdown converter for ATS job descriptions.
 *
 * The sources hand us well-formed HTML with a small tag vocabulary
 * (Greenhouse additionally entity-encodes the whole document, sometimes
 * twice), and the dashboard renders job_descriptions.content through its own
 * minimal markdown renderer (apps/dashboard/lib/markdown.tsx: #–######
 * headings, -/1. lists with 2-space nesting, **bold**, *italic*,
 * [text](url), paragraphs). This module targets exactly that subset so the
 * stored description keeps the posting's structure instead of collapsing to
 * a wall of text.
 *
 * Pipeline: decode entities iteratively until stable (max 3 passes — covers
 * Greenhouse's double encoding), then, if the result contains tags, parse
 * and render:
 *   <p>/<div>/other block tags → paragraphs      <br> → line break
 *   <ul>/<ol>/<li> → -/1. items (2-space nesting; stray <li> runs grouped)
 *   <h1>–<h6> → ##-clamped headings (floor ##, cap ######)
 *   <strong>/<b> → **  <em>/<i> → *   <a href> → [text](href) (http(s) only)
 *   <script>/<style>/comments → dropped INCLUDING contents
 *   everything else (span/img/…) → stripped, text kept
 * Input with no tags (already plain text/markdown) passes through with only
 * newline normalization, so the conversion is idempotent.
 *
 * SAFETY: the output is markdown TEXT. The dashboard renderer builds React
 * elements from plain strings (never raw HTML), so a tag reconstructed from
 * double-encoded entities can never execute — here it is simply parsed and
 * stripped like any other tag.
 */

/* ------------------------------------------------------------------ entities */

/**
 * The named entities the ATS sources emit (plus the common HTML set).
 * Unknown names are preserved verbatim rather than guessed.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  bull: '•',
  middot: '·',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  aring: 'å',
  oslash: 'ø',
  aelig: 'æ',
  szlig: 'ß',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  cent: '¢',
  pound: '£',
  euro: '€',
  yen: '¥',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
};

const ENTITY_RE =
  /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,30});/g;

function decodeEntity(whole: string, body: string): string {
  if (body.startsWith('#')) {
    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    // Refuse control characters (except tab/newline), surrogates, and
    // out-of-range code points — the entity stays verbatim.
    if (
      !Number.isFinite(code) ||
      code > 0x10ffff ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return whole;
    }
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body] ?? whole;
}

/**
 * Decode HTML entities repeatedly until the string stops changing (max 3
 * passes). Greenhouse double-encodes (`&amp;lt;p&amp;gt;` → `&lt;p&gt;` →
 * `<p>`), so a single pass is not enough; the cap keeps pathological input
 * from looping.
 */
export function decodeHtmlEntitiesDeep(input: string): string {
  let out = input;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(ENTITY_RE, decodeEntity);
    if (next === out) {
      return out;
    }
    out = next;
  }
  return out;
}

/* ------------------------------------------------------------------- parsing */

interface ElementNode {
  kind: 'element';
  tag: string;
  attrs: string;
  children: HtmlNode[];
}

interface TextNode {
  kind: 'text';
  text: string;
}

type HtmlNode = ElementNode | TextNode;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * Drop comments and <script>/<style> elements INCLUDING their contents —
 * code must never leak into a job description. An unterminated <script> or
 * <style> would swallow the rest of the document either way, so it is
 * dropped to the end of input.
 */
function stripDroppedRegions(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, ' ');
}

const TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;

/**
 * Minimal tree parse for the well-formed HTML the ATS sources emit.
 * Tolerances: unmatched close tags are ignored; an unclosed element runs to
 * the end of its parent; a repeated <li>/<p> open implicitly closes the
 * previous one. Anything `< ` that does not look like a tag stays text.
 */
function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = {
    kind: 'element',
    tag: '#root',
    attrs: '',
    children: [],
  };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1] as ElementNode;
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(html); m !== null; m = TOKEN_RE.exec(html)) {
    if (m.index > last) {
      top().children.push({ kind: 'text', text: html.slice(last, m.index) });
    }
    last = m.index + m[0].length;
    const tag = (m[1] ?? '').toLowerCase();
    if (m[0].startsWith('</')) {
      // Pop to the matching open tag; an unmatched close is ignored.
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if ((stack[i] as ElementNode).tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    // `<li><li>` / `<p><p>` without explicit closes: close the previous one.
    if ((tag === 'li' || tag === 'p') && top().tag === tag) {
      stack.pop();
    }
    const node: ElementNode = {
      kind: 'element',
      tag,
      attrs: m[2] ?? '',
      children: [],
    };
    top().children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(m[2] ?? '')) {
      stack.push(node);
    }
  }
  if (last < html.length) {
    top().children.push({ kind: 'text', text: html.slice(last) });
  }
  return root.children;
}

function hrefOf(attrs: string): string | null {
  const m = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

/* ----------------------------------------------------------------- rendering */

const HEADING_TAG_RE = /^h([1-6])$/;

/** Tags treated as paragraph-level containers (beyond p/div themselves). */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'main',
  'nav',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);

/** Collapse spaces/tabs and trim — single-line tidy. */
function tidyLine(text: string): string {
  return text.replace(/[^\S\n]+/g, ' ').trim();
}

/**
 * Wrap inline content in a markdown marker, moving surrounding whitespace
 * OUTSIDE the markers (` **x** ` not `** x **`) so the renderer's regex
 * matches. Content-free wraps vanish; embedded line breaks become spaces
 * (the renderer parses inline markup per line).
 */
function wrapMarker(marker: string, inner: string): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const lead = m?.[1] ?? '';
  const core = (m?.[2] ?? '').replace(/\s*\n\s*/g, ' ');
  const tail = m?.[3] ?? '';
  if (core === '') {
    return lead + tail;
  }
  return `${lead}${marker}${core}${marker}${tail}`;
}

/** Spaces/parens would break `[text](url)` parsing — percent-encode them. */
function encodeHrefForMarkdown(href: string): string {
  return href.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Render nodes as one inline run: whitespace runs (including source
 * newlines) collapse to a single space; only <br> contributes a real '\n'.
 * Unknown tags keep their text (block-ish ones get a breathing space).
 */
function inlineText(nodes: HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.text.replace(/\s+/g, ' ');
      continue;
    }
    switch (node.tag) {
      case 'br':
        out += '\n';
        break;
      case 'strong':
      case 'b':
        out += wrapMarker('**', inlineText(node.children));
        break;
      case 'em':
      case 'i':
        out += wrapMarker('*', inlineText(node.children));
        break;
      case 'a': {
        const text = tidyLine(inlineText(node.children).replace(/\n+/g, ' '));
        if (text === '') {
          break;
        }
        const href = hrefOf(node.attrs);
        // Only absolute http(s) targets become links; anything else
        // (mailto:, javascript:, relative) keeps just the words.
        out +=
          href && /^https?:\/\//i.test(href)
            ? `[${text}](${encodeHrefForMarkdown(href)})`
            : text;
        break;
      }
      default:
        if (
          BLOCK_TAGS.has(node.tag) ||
          node.tag === 'ul' ||
          node.tag === 'ol' ||
          node.tag === 'li' ||
          HEADING_TAG_RE.test(node.tag)
        ) {
          out += ` ${inlineText(node.children)} `;
        } else {
          out += inlineText(node.children);
        }
    }
  }
  return out;
}

/** One <li> → its marker line plus any nested list lines. */
function renderListItem(
  node: ElementNode,
  depth: number,
  marker: string,
): string[] {
  const inlineNodes: HtmlNode[] = [];
  const nested: string[] = [];
  for (const child of node.children) {
    if (
      child.kind === 'element' &&
      (child.tag === 'ul' || child.tag === 'ol')
    ) {
      const sub = renderList(child, depth + 1, child.tag === 'ol');
      if (sub !== '') {
        nested.push(sub);
      }
    } else {
      inlineNodes.push(child);
    }
  }
  // A list item stays on one line: internal <br>/<p> breaks become spaces.
  const text = tidyLine(inlineText(inlineNodes).replace(/\n+/g, ' '));
  const lines: string[] = [];
  if (text !== '') {
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
  }
  lines.push(...nested);
  return lines;
}

function renderList(
  node: ElementNode,
  depth: number,
  ordered: boolean,
): string {
  const lines: string[] = [];
  let index = 1;
  for (const child of node.children) {
    if (child.kind !== 'element') {
      continue; // inter-item whitespace/text
    }
    if (child.tag === 'li') {
      lines.push(...renderListItem(child, depth, ordered ? `${index}.` : '-'));
      index += 1;
    } else if (child.tag === 'ul' || child.tag === 'ol') {
      // A list nested directly under a list (missing the wrapper <li>).
      const sub = renderList(child, depth + 1, child.tag === 'ol');
      if (sub !== '') {
        lines.push(sub);
      }
    }
  }
  return lines.join('\n');
}

/** Paragraph tidy: per-line trim, keep <br> breaks, drop empty edges. */
function tidyParagraph(text: string): string {
  return text
    .split('\n')
    .map((line) => tidyLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * Render a block scope: consecutive inline content accumulates into a
 * paragraph; block elements flush it and contribute their own block(s).
 * Blocks join with a blank line.
 */
function renderBlocks(nodes: HtmlNode[]): string {
  const blocks: string[] = [];
  let inline = '';
  const flush = () => {
    const tidy = tidyParagraph(inline);
    if (tidy !== '') {
      blocks.push(tidy);
    }
    inline = '';
  };
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) {
      continue;
    }
    if (node.kind === 'text') {
      inline += node.text.replace(/\s+/g, ' ');
      continue;
    }
    const { tag } = node;
    if (tag === 'br') {
      inline += '\n';
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push('---');
      continue;
    }
    const heading = tag.match(HEADING_TAG_RE);
    if (heading) {
      flush();
      const text = tidyLine(inlineText(node.children).replace(/\n+/g, ' '));
      if (text !== '') {
        // Floor at ## — the JD's own headings must not compete with the
        // page's h1 chrome — and cap at ###### (markdown's maximum).
        const level = Math.min(Math.max(Number(heading[1]), 2), 6);
        blocks.push(`${'#'.repeat(level)} ${text}`);
      }
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const list = renderList(node, 0, tag === 'ol');
      if (list !== '') {
        blocks.push(list);
      }
      continue;
    }
    if (tag === 'li') {
      // Stray <li> siblings outside any <ul>/<ol> (Lever's `lists[].content`
      // fragments): group the consecutive run into ONE unordered list.
      flush();
      const lines: string[] = [];
      while (i < nodes.length) {
        const sibling = nodes[i];
        if (sibling?.kind === 'text' && sibling.text.trim() === '') {
          i += 1;
          continue;
        }
        if (sibling?.kind !== 'element' || sibling.tag !== 'li') {
          break;
        }
        lines.push(...renderListItem(sibling, 0, '-'));
        i += 1;
      }
      i -= 1; // the for-loop increments past the non-li sibling otherwise
      if (lines.length > 0) {
        blocks.push(lines.join('\n'));
      }
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      const chunk = renderBlocks(node.children);
      if (chunk !== '') {
        blocks.push(chunk);
      }
      continue;
    }
    // Inline element (strong/em/a/span/…).
    inline += inlineText([node]);
  }
  flush();
  return blocks.join('\n\n');
}

/* --------------------------------------------------------------------- entry */

const TAG_DETECT_RE = /<[a-zA-Z][^>]*>/;

/**
 * Convert ATS-shaped HTML (optionally entity-encoded, possibly twice) to
 * markdown the dashboard's renderer understands. Input that contains no
 * tags after decoding is treated as already-plain text and passes through
 * with only whitespace normalization — the function is idempotent.
 */
export function htmlToMarkdown(input: string): string {
  const decoded = decodeHtmlEntitiesDeep(input);
  if (!TAG_DETECT_RE.test(decoded)) {
    return decoded
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  const markdown = renderBlocks(parseHtml(stripDroppedRegions(decoded)));
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}
