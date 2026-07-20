/**
 * Self-contained functions that are SERIALIZED into the page (via
 * Function.prototype.toString inside page.evaluate expressions — see
 * discover-form.ts). They must reference nothing from module scope, only
 * their own parameters and standard browser/JS globals, and they avoid
 * DOM-only APIs (querySelectorAll, Node.TEXT_NODE, …) where a plain
 * structural node tree suffices — which is also what makes them unit-testable
 * in Node with fake node objects, no jsdom needed.
 */

/**
 * Score how strongly a clickable control's text reads as THE "apply" action.
 *   3 — exact apply-style phrases ("apply now", "start application", …)
 *   2 — apply-prefixed text or "continue to application"
 *   1 — a bare generic "continue"
 *   0 — not an apply control
 * Takes the RAW text (any case/punctuation); normalizes internally.
 */
export function scoreApplyControlText(
  rawText: string | null | undefined,
): number {
  const text = (rawText ?? '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 60) return 0;
  const exact = [
    'apply',
    'apply now',
    'apply today',
    'apply here',
    'apply online',
    'apply for job',
    'apply for this job',
    'apply for this position',
    'apply for this role',
    'apply for this opening',
    'apply to this job',
    'apply to this position',
    'apply to this role',
    'im interested',
    'i am interested',
    'start application',
    'start your application',
    'begin application',
    'submit application',
  ];
  if (exact.includes(text)) return 3;
  if (text.startsWith('apply')) return 2;
  if (text === 'continue to application') return 2;
  if (text === 'continue') return 1;
  return 0;
}

/**
 * Minimal structural view of a DOM node — real Elements satisfy it, and so
 * do plain test fixtures. Only what the markdown serializer touches.
 */
export interface MarkdownishNode {
  nodeType: number;
  textContent?: string | null;
  tagName?: string;
  childNodes?: ArrayLike<MarkdownishNode>;
  className?: unknown;
  id?: unknown;
  href?: unknown;
  getAttribute?(name: string): string | null;
  checkVisibility?(): boolean;
}

/** One anchor collected from the rendered DOM (href absolute, text inline). */
export interface AnchorCandidate {
  href: string;
  text: string;
}

/**
 * Collect candidate anchors from a rendered DOM subtree, skipping page
 * chrome: nav/header/footer/aside containers (and their landmark roles),
 * script/style/form/dialog subtrees, cookie/consent banners, and hidden
 * elements. Returns at most `maxAnchors` `{href, text}` pairs in document
 * order — only http(s) hrefs (a real DOM anchor's `href` property is already
 * RESOLVED absolute). Self-contained (serialized into the page via
 * toString, see discover-form.ts) and structural-node testable like
 * serializeToMarkdown; the ATS/job-detail filtering happens Node-side in
 * listing-links.ts, where detectPlatform is available.
 */
export function collectAnchors(
  rootNode: MarkdownishNode,
  maxAnchors: number,
): AnchorCandidate[] {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'NAV',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'FORM',
    'DIALOG',
    'SELECT',
    'SVG',
  ]);
  const SKIP_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'dialog',
    'alertdialog',
    'search',
  ]);

  const out: AnchorCandidate[] = [];

  const kids = (node: MarkdownishNode): MarkdownishNode[] => {
    const list = node.childNodes;
    const children: MarkdownishNode[] = [];
    if (!list) return children;
    for (let i = 0; i < list.length; i += 1) {
      const child = list[i];
      if (child) children.push(child);
    }
    return children;
  };

  const skipped = (node: MarkdownishNode): boolean => {
    if (SKIP_TAGS.has((node.tagName ?? '').toUpperCase())) return true;
    const role = node.getAttribute ? (node.getAttribute('role') ?? '') : '';
    if (SKIP_ROLES.has(role.toLowerCase())) return true;
    const className = typeof node.className === 'string' ? node.className : '';
    const id = typeof node.id === 'string' ? node.id : '';
    if (/(cookie|consent|gdpr)/i.test(`${className} ${id}`)) return true;
    if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) {
      return true;
    }
    return false;
  };

  const textOf = (node: MarkdownishNode): string => {
    if (node.nodeType === TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== ELEMENT_NODE) return '';
    return kids(node).map(textOf).join(' ');
  };

  const walk = (node: MarkdownishNode): void => {
    if (out.length >= maxAnchors) return;
    if (node.nodeType !== ELEMENT_NODE || skipped(node)) return;
    if ((node.tagName ?? '').toUpperCase() === 'A') {
      const href = typeof node.href === 'string' ? node.href : '';
      if (/^https?:\/\//i.test(href)) {
        out.push({ href, text: textOf(node).replace(/\s+/g, ' ').trim() });
      }
      return; // anchors never nest
    }
    for (const child of kids(node)) {
      walk(child);
      if (out.length >= maxAnchors) return;
    }
  };

  walk(rootNode);
  return out;
}

/**
 * Assemble a job description from a content REGION (a substantial
 * main/[role=main], else body) by collecting ALL the content blocks around
 * description-classed nodes instead of picking a single "largest" one — job
 * pages routinely split the JD across sibling blocks (about /
 * responsibilities / qualifications / pay), and a 300-char pay-transparency
 * node must never shadow a 5,000-char responsibilities section.
 *
 * Anchors are elements whose class/id/data-testid reads
 * description/posting-ish, plus article and job-classed section/div. The
 * collected block set is each anchor plus the content-bearing element
 * siblings of the anchor AND of every ancestor up to the region — i.e. the
 * whole content column the anchors live in. Blocks are serialized in DOM
 * order and concatenated; a block nested inside another collected block is
 * never serialized twice (the emission walk does not descend into an
 * emitted block). When no anchor exists, or the assembly stays tiny, the
 * whole region is serialized instead. Skips the same page chrome as the
 * serializer (nav/header/footer/aside, cookie banners, hidden elements) so
 * anchors inside chrome never pull it in. Output is capped at maxChars with
 * a truncation flag. Self-contained (serialized into the page via toString,
 * see discover-form.ts) and structural-node testable like
 * serializeToMarkdown.
 */
export function assembleDescriptionMarkdown(
  region: MarkdownishNode,
  serialize: (
    node: MarkdownishNode,
    maxChars: number,
  ) => { markdown: string; truncated: boolean },
  maxChars: number,
): { markdown: string; truncated: boolean } {
  const ELEMENT_NODE = 1;
  /** Below this, the anchor-family assembly falls back to the region. */
  const MIN_ASSEMBLED_CHARS = 200;
  /** A sibling with less serialized content than this is not a block. */
  const MIN_SIBLING_CHARS = 4;
  const MAX_ANCHORS = 25;
  const MAX_BLOCKS = 80;
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'NAV',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'FORM',
    'DIALOG',
    'SELECT',
    'SVG',
  ]);
  const SKIP_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'dialog',
    'alertdialog',
    'search',
  ]);

  const kids = (node: MarkdownishNode): MarkdownishNode[] => {
    const list = node.childNodes;
    const out: MarkdownishNode[] = [];
    if (!list) return out;
    for (let i = 0; i < list.length; i += 1) {
      const child = list[i];
      if (child) out.push(child);
    }
    return out;
  };

  const tagOf = (node: MarkdownishNode): string =>
    (node.tagName ?? '').toUpperCase();

  const skipped = (node: MarkdownishNode): boolean => {
    if (SKIP_TAGS.has(tagOf(node))) return true;
    const role = node.getAttribute ? (node.getAttribute('role') ?? '') : '';
    if (SKIP_ROLES.has(role.toLowerCase())) return true;
    const className = typeof node.className === 'string' ? node.className : '';
    const id = typeof node.id === 'string' ? node.id : '';
    if (/(cookie|consent|gdpr)/i.test(`${className} ${id}`)) return true;
    if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) {
      return true;
    }
    return false;
  };

  const isAnchor = (node: MarkdownishNode): boolean => {
    const tag = tagOf(node);
    if (tag === 'ARTICLE') return true;
    const className = typeof node.className === 'string' ? node.className : '';
    const id = typeof node.id === 'string' ? node.id : '';
    const testId = node.getAttribute
      ? (node.getAttribute('data-testid') ?? '')
      : '';
    if (/(description|posting)/i.test(`${className} ${id} ${testId}`)) {
      return true;
    }
    return (tag === 'SECTION' || tag === 'DIV') && /job/i.test(className);
  };

  // Pass 1 — one DFS for parent links and the anchors, in document order.
  const parents = new Map<MarkdownishNode, MarkdownishNode>();
  const anchors: MarkdownishNode[] = [];
  const index = (node: MarkdownishNode): void => {
    for (const child of kids(node)) {
      if (child.nodeType !== ELEMENT_NODE || skipped(child)) continue;
      parents.set(child, node);
      if (anchors.length < MAX_ANCHORS && isAnchor(child)) anchors.push(child);
      index(child);
    }
  };
  index(region);
  if (anchors.length === 0) return serialize(region, maxChars);

  const cache = new Map<
    MarkdownishNode,
    { markdown: string; truncated: boolean }
  >();
  const rendered = (
    node: MarkdownishNode,
  ): { markdown: string; truncated: boolean } => {
    const hit = cache.get(node);
    if (hit) return hit;
    const result = serialize(node, maxChars);
    cache.set(node, result);
    return result;
  };

  // Content test for SIBLING blocks: enough NON-LINK text, and not a link
  // farm. Menus/footers are not always inside nav/footer tags — a block
  // whose markdown is mostly [label](url) syntax is site chrome, and the
  // stripped label text barely shrinks real prose (JD sections have few
  // links), so the density check never drops a real section.
  const contentBearing = (markdown: string): boolean => {
    if (markdown.length < MIN_SIBLING_CHARS) return false;
    const linkless = markdown.replace(/\[([^\]]*)\]\([^()\s]*\)/g, '$1');
    return (
      linkless.length >= MIN_SIBLING_CHARS &&
      linkless.length >= markdown.length * 0.5
    );
  };

  // Pass 2 — the block set: each anchor plus the content-bearing element
  // siblings of the anchor and of every ancestor below the region.
  const blocks = new Set<MarkdownishNode>();
  for (const anchor of anchors) {
    blocks.add(anchor);
    let node: MarkdownishNode | undefined = anchor;
    while (node && node !== region && blocks.size < MAX_BLOCKS) {
      const parent = parents.get(node);
      if (!parent) break;
      for (const sibling of kids(parent)) {
        if (sibling === node) continue;
        if (sibling.nodeType !== ELEMENT_NODE || skipped(sibling)) continue;
        if (blocks.size >= MAX_BLOCKS) break;
        if (contentBearing(rendered(sibling).markdown)) {
          blocks.add(sibling);
        }
      }
      node = parent;
    }
  }

  // Pass 3 — emit blocks in DOM order; never descend into an emitted block,
  // so a nested block inside another collected block is serialized ONCE.
  const parts: string[] = [];
  let blockTruncated = false;
  let emittedChars = 0;
  const emit = (node: MarkdownishNode): void => {
    for (const child of kids(node)) {
      if (emittedChars > maxChars) return;
      if (child.nodeType !== ELEMENT_NODE || skipped(child)) continue;
      if (blocks.has(child)) {
        const result = rendered(child);
        if (result.markdown) {
          parts.push(result.markdown);
          emittedChars += result.markdown.length;
          if (result.truncated) blockTruncated = true;
        }
        continue;
      }
      emit(child);
    }
  };
  emit(region);

  let markdown = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (markdown.length < MIN_ASSEMBLED_CHARS) return serialize(region, maxChars);
  let truncated = blockTruncated;
  if (markdown.length > maxChars) {
    truncated = true;
    const cut = markdown.lastIndexOf('\n', maxChars);
    markdown = markdown
      .slice(0, cut > maxChars - 400 ? cut : maxChars)
      .replace(/\s+$/, '');
  }
  return { markdown, truncated };
}

/**
 * Serialize a DOM subtree to markdown: h1–h6 → #s, p → paragraphs, ul/ol/li
 * → -/1. (nested lists indented), strong/b → **, em/i → *, a → [text](href)
 * for absolute http(s) hrefs, br → newline, tables → pipe rows. Skips page
 * chrome (nav/header/footer/aside, script/style, forms/buttons, cookie and
 * consent banners) and hidden elements. Blank runs are collapsed; the output
 * is capped at maxChars with a truncation flag.
 */
export function serializeToMarkdown(
  rootNode: MarkdownishNode,
  maxChars: number,
): { markdown: string; truncated: boolean } {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'NAV',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'BUTTON',
    'FORM',
    'IFRAME',
    'SVG',
    'SELECT',
    'INPUT',
    'TEXTAREA',
    'LABEL',
    'DIALOG',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'OBJECT',
    'EMBED',
  ]);
  const SKIP_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'dialog',
    'alertdialog',
    'search',
  ]);

  const kids = (node: MarkdownishNode): MarkdownishNode[] => {
    const list = node.childNodes;
    const out: MarkdownishNode[] = [];
    if (!list) return out;
    for (let i = 0; i < list.length; i += 1) {
      const child = list[i];
      if (child) out.push(child);
    }
    return out;
  };

  const tagOf = (node: MarkdownishNode): string =>
    (node.tagName ?? '').toUpperCase();

  const skipped = (node: MarkdownishNode): boolean => {
    if (SKIP_TAGS.has(tagOf(node))) return true;
    const role = node.getAttribute ? (node.getAttribute('role') ?? '') : '';
    if (SKIP_ROLES.has(role.toLowerCase())) return true;
    const className = typeof node.className === 'string' ? node.className : '';
    const id = typeof node.id === 'string' ? node.id : '';
    if (/(cookie|consent|gdpr)/i.test(`${className} ${id}`)) return true;
    if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) {
      return true;
    }
    return false;
  };

  const inline = (node: MarkdownishNode): string => {
    if (node.nodeType === TEXT_NODE) {
      return (node.textContent ?? '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== ELEMENT_NODE || skipped(node)) return '';
    const tag = tagOf(node);
    if (tag === 'BR') return '\n';
    const inner = kids(node).map(inline).join('');
    const core = inner.trim();
    if (!core) return inner ? ' ' : '';
    const lead = /^\s/.test(inner) ? ' ' : '';
    const trail = /\s$/.test(inner) ? ' ' : '';
    if (tag === 'STRONG' || tag === 'B') return `${lead}**${core}**${trail}`;
    if (tag === 'EM' || tag === 'I') return `${lead}*${core}*${trail}`;
    if (tag === 'A') {
      const href = typeof node.href === 'string' ? node.href : '';
      if (/^https?:\/\//.test(href)) return `${lead}[${core}](${href})${trail}`;
      return inner;
    }
    return inner;
  };

  /** Inline content flattened to one line (headings, table cells). */
  const inlineOf = (node: MarkdownishNode): string =>
    kids(node).map(inline).join('').replace(/\s+/g, ' ').trim();

  /** Inline content with <br> newlines preserved (paragraphs). */
  const inlineBlockOf = (node: MarkdownishNode): string =>
    kids(node)
      .map(inline)
      .join('')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();

  const listItems = (
    node: MarkdownishNode,
    depth: number,
    ordered: boolean,
  ): string => {
    let index = 0;
    let out = '';
    for (const child of kids(node)) {
      if (child.nodeType !== ELEMENT_NODE || tagOf(child) !== 'LI') continue;
      if (skipped(child)) continue;
      index += 1;
      const marker = ordered ? `${index}. ` : '- ';
      let itemText = '';
      let nested = '';
      for (const grand of kids(child)) {
        const grandTag = grand.nodeType === ELEMENT_NODE ? tagOf(grand) : '';
        if (grandTag === 'UL' || grandTag === 'OL') {
          if (!skipped(grand)) {
            nested += listItems(grand, depth + 1, grandTag === 'OL');
          }
        } else {
          itemText += inline(grand);
        }
      }
      const line = itemText.replace(/\s+/g, ' ').trim();
      if (line) out += `${'  '.repeat(depth)}${marker}${line}\n`;
      out += nested;
    }
    return out;
  };

  const collectRows = (
    node: MarkdownishNode,
    rows: MarkdownishNode[],
  ): void => {
    for (const child of kids(node)) {
      if (child.nodeType !== ELEMENT_NODE || skipped(child)) continue;
      const tag = tagOf(child);
      if (tag === 'TR') rows.push(child);
      else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
        collectRows(child, rows);
      }
    }
  };

  const tableOf = (node: MarkdownishNode): string => {
    const rows: MarkdownishNode[] = [];
    collectRows(node, rows);
    if (rows.length === 0) return '';
    let out = '\n\n';
    let rowIndex = 0;
    for (const row of rows.slice(0, 40)) {
      const cells = kids(row)
        .filter(
          (cell) =>
            cell.nodeType === ELEMENT_NODE &&
            (tagOf(cell) === 'TH' || tagOf(cell) === 'TD') &&
            !skipped(cell),
        )
        .map((cell) => inlineOf(cell).replace(/\|/g, '\\|'));
      if (cells.length === 0) continue;
      out += `| ${cells.join(' | ')} |\n`;
      if (rowIndex === 0) {
        out += `| ${cells.map(() => '---').join(' | ')} |\n`;
      }
      rowIndex += 1;
    }
    return `${out}\n`;
  };

  const INLINE_TAGS = new Set([
    'STRONG',
    'B',
    'EM',
    'I',
    'A',
    'SPAN',
    'CODE',
    'U',
    'S',
    'SMALL',
    'SUP',
    'SUB',
    'MARK',
    'ABBR',
    'TIME',
    'BR',
  ]);

  const block = (node: MarkdownishNode, depth: number): string => {
    if (node.nodeType === TEXT_NODE) {
      return (node.textContent ?? '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== ELEMENT_NODE || skipped(node)) return '';
    const tag = tagOf(node);
    const heading = tag.match(/^H([1-6])$/);
    if (heading) {
      const text = inlineOf(node);
      const level = Number(heading[1] ?? '1');
      return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE') {
      const text = inlineBlockOf(node);
      return text ? `\n\n${text}\n\n` : '';
    }
    if (tag === 'BR') return '\n';
    if (tag === 'UL' || tag === 'OL') {
      const items = listItems(node, depth, tag === 'OL');
      return items ? `\n\n${items}\n` : '';
    }
    if (tag === 'TABLE') return tableOf(node);
    if (tag === 'LI') {
      // Stray li outside a list container.
      const text = inlineBlockOf(node);
      return text ? `\n- ${text}\n` : '';
    }
    if (INLINE_TAGS.has(tag)) return inline(node);
    // Generic container (div/section/article/…): soft block boundaries.
    const inner = kids(node)
      .map((child) => block(child, depth))
      .join('');
    return inner ? `\n${inner}\n` : '';
  };

  let markdown = block(rootNode, 0)
    .replace(/[ \t]+\n/g, '\n')
    // Strip stray leading indentation, but keep intentional nested-list
    // indent (lines whose first non-space char is a list marker or digit).
    .replace(/\n +(?=[^-\d\s])/g, '\n')
    .replace(/(?<=\S)[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let truncated = false;
  if (markdown.length > maxChars) {
    truncated = true;
    const cut = markdown.lastIndexOf('\n', maxChars);
    markdown = markdown
      .slice(0, cut > maxChars - 400 ? cut : maxChars)
      .replace(/\s+$/, '');
  }
  return { markdown, truncated };
}

/** A job description recovered from embedded script data (markdown-ish). */
export interface EmbeddedDescription {
  markdown: string;
  truncated: boolean;
}

/**
 * Recover a job description that lives INSIDE the page's <script> payloads
 * (SSR/hydration state, React flight streams, JSON-LD) rather than in the
 * DOM the extractor saw. Fallback for when the DOM-extracted description is
 * missing or suspiciously small: career SPAs routinely ship the full JD as
 * escaped string values in embedded data.
 *
 * Candidate strings come from three routes, all capped:
 *   - a script body that IS a JSON blob (or a `window.__X__ = {...}`-style
 *     assignment — the prefix is stripped): its long string VALUES;
 *   - a tolerant regex over any other script text for long escaped string
 *     literals, unescaped afterwards (\n, \t, \uXXXX, \", \\);
 *   - a stitched candidate: every prose/HTML piece across all scripts in
 *     document order — SSR streams (e.g. React flight `__next_f.push`
 *     chunks) split one JD across several script tags.
 * Structured payloads (serialized component trees / JSON state — quoted
 * keys glued with `:` or `,`) are DISCARDED even when they contain marker
 * words or HTML fragments: recovering them would emit JSON syntax as a
 * "description".
 *
 * A candidate qualifies only when it contains ≥2 distinct JD markers
 * (responsibilit / qualificat / requirement / about the role|team|job /
 * what you'll do / minimum qualifications) AND is ≥1.5× the DOM
 * extraction's length; the longest qualifier wins. HTML-valued pieces go
 * through the injected htmlToMarkdown; plain text keeps its \n structure
 * and `- ` bullets.
 *
 * SECURITY: script payloads are untrusted page data. The output flows into
 * the same descriptionMarkdown channel as the DOM extraction (schema-capped
 * at the endpoint, rendered as text, never raw HTML) and is capped at
 * maxChars here as well. Self-contained (serialized into the page via
 * toString, see discover-form.ts) and — being pure string work — directly
 * unit-testable in Node.
 */
export function recoverEmbeddedDescription(
  scriptTexts: ArrayLike<string | null | undefined>,
  domDescriptionChars: number,
  htmlToMarkdown: (html: string) => string,
  maxChars: number,
): EmbeddedDescription | null {
  const MIN_SCRIPT_CHARS = 800;
  const MAX_SCRIPT_CHARS = 400_000;
  /** Pieces below this (unescaped) length are noise, not JD sections. */
  const MIN_PIECE_CHARS = 500;
  /** A candidate must be at least this long AND ≥1.5× the DOM result. */
  const MIN_CANDIDATE_CHARS = 1_500;
  const DOM_SIZE_ADVANTAGE = 1.5;
  const MIN_MARKERS = 2;
  const MAX_PIECES = 40;
  const MAX_JSON_DEPTH = 12;
  /** Floor for the FINAL markdown (HTML→markdown strips tags, so it may
   * legitimately shrink below MIN_PIECE_CHARS — but not to near-nothing). */
  const MIN_FINAL_CHARS = 200;

  const MARKERS = [
    /responsibilit/i,
    /qualificat/i,
    /requirement/i,
    /about the (role|team|job)/i,
    /what you.ll do/i,
    /minimum qualifications/i,
  ];
  const markerCount = (text: string): number => {
    let count = 0;
    for (const marker of MARKERS) {
      if (marker.test(text)) count += 1;
    }
    return count;
  };

  // {500,} must stay in sync with MIN_PIECE_CHARS (escaped ≥ unescaped, and
  // the unescaped length is re-checked). \r\n excluded: string literals in
  // JS/JSON never contain raw newlines, and excluding them stops a stray
  // quote from swallowing whole script bodies.
  const literalRe = /"((?:[^"\\\r\n]|\\.){500,}?)"/g;
  const assignmentRe =
    /^(?:window|self|globalThis)(?:\.[$A-Za-z_][$\w]*|\[["'][^"']*["']\])+\s*=\s*([\s\S]+)$/;
  /** JSON-structure noise: quoted keys/values glued with `:` or `,`. */
  const structuredRe = /"\s*:\s*|"\s*,\s*"/;
  const htmlTagRe = /<[a-z][^>]*>/i;
  /** React flight text references like `32:T479,` at a chunk's edges. */
  const flightLeadRe = /^[0-9a-f]{1,6}:T[0-9a-f]{1,8},/i;
  const flightTailRe = /[0-9a-f]{1,6}:T[0-9a-f]{1,8},$/i;

  const unescapeLiteral = (raw: string): string => {
    try {
      const parsed: unknown = JSON.parse(`"${raw}"`);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // not strict-JSON escaping — fall through to the tolerant pass
    }
    return raw.replace(
      /\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
      (_whole, esc: string) => {
        const kind = esc[0];
        if (kind === 'u' || kind === 'x') {
          return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
        }
        if (esc === 'n') return '\n';
        if (esc === 't') return '\t';
        if (esc === 'r') return '\r';
        if (esc === 'b' || esc === 'f' || esc === 'v') return ' ';
        return esc; // \" \\ \/ and unknown escapes → the char itself
      },
    );
  };

  interface Piece {
    text: string;
    html: boolean;
  }
  const pieces: Piece[] = [];
  const candidates: Piece[][] = [];
  const seen = new Set<string>();

  const addPiece = (value: string, into: Piece[]): void => {
    if (into.length >= MAX_PIECES) return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_PIECE_CHARS) return;
    if (structuredRe.test(trimmed)) return;
    const text = trimmed
      .replace(flightLeadRe, '')
      .replace(flightTailRe, '')
      .trim();
    if (text.length < MIN_PIECE_CHARS || seen.has(text)) return;
    seen.add(text);
    into.push({ text, html: htmlTagRe.test(text) });
  };

  const collectJsonStrings = (
    value: unknown,
    into: Piece[],
    depth: number,
  ): void => {
    if (into.length >= MAX_PIECES || depth > MAX_JSON_DEPTH) return;
    if (typeof value === 'string') {
      addPiece(value, into);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectJsonStrings(item, into, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        collectJsonStrings(record[key], into, depth + 1);
      }
    }
  };

  for (
    let i = 0;
    i < scriptTexts.length && pieces.length < MAX_PIECES;
    i += 1
  ) {
    const scriptText = (scriptTexts[i] ?? '').slice(0, MAX_SCRIPT_CHARS);
    if (scriptText.length < MIN_SCRIPT_CHARS) continue;
    const scriptPieces: Piece[] = [];

    const trimmed = scriptText.trim();
    const assignment = trimmed.match(assignmentRe);
    const jsonBody = (assignment ? (assignment[1] ?? '') : trimmed)
      .replace(/;\s*$/, '')
      .trim();
    let parsedJson: unknown;
    let isJson = false;
    if (jsonBody.startsWith('{') || jsonBody.startsWith('[')) {
      try {
        parsedJson = JSON.parse(jsonBody);
        isJson = true;
      } catch {
        // not a JSON blob — fall back to the literal scan
      }
    }
    if (isJson) {
      collectJsonStrings(parsedJson, scriptPieces, 0);
    } else {
      for (const match of scriptText.matchAll(literalRe)) {
        if (scriptPieces.length >= MAX_PIECES) break;
        addPiece(unescapeLiteral(match[1] ?? ''), scriptPieces);
      }
    }
    if (scriptPieces.length === 0) continue;
    for (const piece of scriptPieces) {
      if (pieces.length < MAX_PIECES) pieces.push(piece);
    }
    candidates.push(scriptPieces);
    if (scriptPieces.length > 1) {
      for (const piece of scriptPieces) {
        if (piece.text.length >= MIN_CANDIDATE_CHARS) candidates.push([piece]);
      }
    }
  }
  if (pieces.length > 1) candidates.push([...pieces]);

  const required = Math.max(
    MIN_CANDIDATE_CHARS,
    Math.ceil(Math.max(0, domDescriptionChars) * DOM_SIZE_ADVANTAGE),
  );
  let best: Piece[] | null = null;
  let bestLength = 0;
  for (const candidate of candidates) {
    const combined = candidate.map((piece) => piece.text).join('\n\n');
    if (combined.length < required || combined.length <= bestLength) continue;
    if (markerCount(combined) < MIN_MARKERS) continue;
    best = candidate;
    bestLength = combined.length;
  }
  if (!best) return null;

  const parts: string[] = [];
  for (const piece of best) {
    if (piece.html) {
      let converted = '';
      try {
        converted = htmlToMarkdown(piece.text) ?? '';
      } catch {
        converted = '';
      }
      const clean = converted.trim();
      if (clean) parts.push(clean);
    } else {
      const clean = piece.text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (clean) parts.push(clean);
    }
  }
  let markdown = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (markdown.length < MIN_FINAL_CHARS) return null;
  let truncated = false;
  if (markdown.length > maxChars) {
    truncated = true;
    const cut = markdown.lastIndexOf('\n', maxChars);
    markdown = markdown
      .slice(0, cut > maxChars - 400 ? cut : maxChars)
      .replace(/\s+$/, '');
  }
  return { markdown, truncated };
}
