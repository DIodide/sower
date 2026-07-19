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
