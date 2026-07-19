/**
 * Minimal markdown → React renderer for job descriptions. Deliberately
 * self-written (zero deps): scraped content is UNTRUSTED and must never reach
 * the DOM as raw HTML. Every construct becomes a React element built from
 * plain strings — React escapes them all — and only absolute http(s) URLs
 * become anchors (javascript:/data:/relative hrefs render as their link text).
 *
 * Covers exactly the subset the browser agent's serializer emits
 * (packages/investigate serializeToMarkdown): #–###### headings, -/1. lists
 * with 2-space nesting, **bold**, *italic*, `code`, [text](url), pipe tables,
 * and paragraphs. Single newlines inside a paragraph stay visible line
 * breaks, so plain-text adapter descriptions read exactly as they used to.
 */
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ inline */

/** Only absolute http(s) targets ever become real links. */
const SAFE_HREF = /^https?:\/\//i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Fresh per call: the regex is stateful (lastIndex) and this recurses.
  const re =
    /\*\*(.+?)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]*)\]\(([^()\s]+)\)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}.${n}`;
    n += 1;
    const [whole, bold, italic, code, linkText, href] = m;
    if (bold !== undefined) {
      out.push(<strong key={key}>{renderInline(bold, key)}</strong>);
    } else if (italic !== undefined) {
      out.push(<em key={key}>{renderInline(italic, key)}</em>);
    } else if (code !== undefined) {
      out.push(<code key={key}>{code}</code>);
    } else if (href !== undefined && SAFE_HREF.test(href)) {
      out.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {renderInline(linkText ?? '', key)}
        </a>,
      );
    } else if (linkText !== undefined) {
      // Unsafe scheme (javascript: etc.) — keep the words, drop the link.
      out.push(linkText);
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ blocks */

interface ListData {
  ordered: boolean;
  items: ListItem[];
}

interface ListItem {
  text: string;
  child: ListData | null;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; list: ListData }
  | { kind: 'table'; header: string[] | null; rows: string[][] };

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,3})[.)])\s+(.+)$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;

/** `| a | b |` → ['a','b'], honoring the serializer's `\|` cell escapes. */
function splitTableRow(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

const isSeparatorRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

interface RawItem {
  depth: number;
  ordered: boolean;
  text: string;
}

/**
 * Consume raw items at `depth` into one list. Deeper runs nest under the
 * item before them; a marker-type flip (`-` ↔ `1.`) at the same depth ends
 * the list so the caller starts a new one. Always consumes ≥1 item.
 */
function buildList(
  raw: RawItem[],
  pos: { i: number },
  depth: number,
): ListData {
  const ordered = raw[pos.i]?.ordered ?? false;
  const items: ListItem[] = [];
  while (pos.i < raw.length) {
    const cur = raw[pos.i];
    if (!cur || cur.depth < depth) break;
    if (cur.depth > depth) {
      const child = buildList(raw, pos, cur.depth);
      const prev = items[items.length - 1];
      if (prev && prev.child === null) prev.child = child;
      else items.push({ text: '', child });
      continue;
    }
    if (cur.ordered !== ordered && items.length > 0) break;
    items.push({ text: cur.text, child: null });
    pos.i += 1;
  }
  return { ordered, items };
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? '',
      });
      i += 1;
      continue;
    }
    if (TABLE_RE.test(line)) {
      let header: string[] | null = null;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_RE.test(lines[i] ?? '')) {
        const cells = splitTableRow(lines[i] ?? '');
        i += 1;
        if (isSeparatorRow(cells)) {
          // A `| --- |` right after the first row promotes it to a header.
          if (header === null && rows.length === 1) header = rows.pop() ?? null;
          continue;
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (header !== null || rows.length > 0) {
        blocks.push({ kind: 'table', header, rows });
      }
      continue;
    }
    if (LIST_RE.test(line)) {
      const raw: RawItem[] = [];
      while (i < lines.length) {
        const m = (lines[i] ?? '').match(LIST_RE);
        if (!m) break;
        raw.push({
          depth: Math.floor((m[1]?.length ?? 0) / 2),
          ordered: m[3] !== undefined,
          text: m[4] ?? '',
        });
        i += 1;
      }
      const pos = { i: 0 };
      while (pos.i < raw.length) {
        blocks.push({
          kind: 'list',
          list: buildList(raw, pos, raw[pos.i]?.depth ?? 0),
        });
      }
      continue;
    }
    // Paragraph: consecutive lines up to a blank line or another block kind.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (
        l.trim() === '' ||
        HEADING_RE.test(l) ||
        TABLE_RE.test(l) ||
        LIST_RE.test(l)
      ) {
        break;
      }
      para.push(l.trimEnd());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', lines: para });
  }
  return blocks;
}

/* --------------------------------------------------------------- rendering */

function ListBlock({ list, keyPrefix }: { list: ListData; keyPrefix: string }) {
  const Tag = list.ordered ? 'ol' : 'ul';
  const children: ReactNode[] = [];
  for (let idx = 0; idx < list.items.length; idx += 1) {
    const item = list.items[idx];
    if (!item) continue;
    const key = `${keyPrefix}.${idx}`;
    children.push(
      <li key={key}>
        {renderInline(item.text, key)}
        {item.child ? (
          <ListBlock list={item.child} keyPrefix={`${key}n`} />
        ) : null}
      </li>,
    );
  }
  return <Tag>{children}</Tag>;
}

function cellsOf(
  cells: string[],
  rowKey: string,
  Cell: 'th' | 'td',
): ReactNode[] {
  const out: ReactNode[] = [];
  for (let c = 0; c < cells.length; c += 1) {
    const key = `${rowKey}.${c}`;
    out.push(<Cell key={key}>{renderInline(cells[c] ?? '', key)}</Cell>);
  }
  return out;
}

function TableBlock({
  header,
  rows,
  keyPrefix,
}: {
  header: string[] | null;
  rows: string[][];
  keyPrefix: string;
}) {
  const body: ReactNode[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const key = `${keyPrefix}.${r}`;
    body.push(<tr key={key}>{cellsOf(row, key, 'td')}</tr>);
  }
  return (
    <div className="md-table">
      <table>
        {header ? (
          <thead>
            <tr>{cellsOf(header, `${keyPrefix}.h`, 'th')}</tr>
          </thead>
        ) : null}
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

/** Renders untrusted markdown (or markdown-ish plain text) as React elements. */
export function Markdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  const out: ReactNode[] = [];
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx];
    if (!block) continue;
    const key = `b${idx}`;
    if (block.kind === 'heading') {
      // `#` renders as h2 (clamped at h6): the page's own h1/h2 chrome
      // outranks the document's internal hierarchy.
      const Tag = `h${Math.min(block.level + 1, 6)}` as
        | 'h2'
        | 'h3'
        | 'h4'
        | 'h5'
        | 'h6';
      out.push(<Tag key={key}>{renderInline(block.text, key)}</Tag>);
    } else if (block.kind === 'paragraph') {
      const parts: ReactNode[] = [];
      for (let l = 0; l < block.lines.length; l += 1) {
        if (l > 0) parts.push(<br key={`${key}.br${l}`} />);
        parts.push(...renderInline(block.lines[l] ?? '', `${key}.${l}`));
      }
      out.push(<p key={key}>{parts}</p>);
    } else if (block.kind === 'list') {
      out.push(<ListBlock key={key} list={block.list} keyPrefix={key} />);
    } else {
      out.push(
        <TableBlock
          key={key}
          header={block.header}
          rows={block.rows}
          keyPrefix={key}
        />,
      );
    }
  }
  return <div className="md">{out}</div>;
}
