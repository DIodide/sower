/**
 * HTML → plain-text helper for SINGLE-LINE strings (e.g. Workday
 * questionnaire labels, which arrive as entity-encoded HTML fragments).
 *
 * Job DESCRIPTIONS no longer use this: the adapters convert them with
 * htmlToMarkdown (html-to-markdown.ts) so the posting's headings/lists
 * survive into the stored description instead of collapsing to one line.
 */

/**
 * Decode the small, fixed set of HTML entities the ATS sources emit. `&amp;` is
 * decoded LAST so a singly-encoded `&amp;lt;` collapses to a literal `&lt;`
 * rather than being over-decoded to `<`.
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Convert Greenhouse's entity-encoded HTML `content` to readable plain text:
 * decode entities first (so `&lt;h2&gt;` becomes a real `<h2>` tag), strip all
 * tags, decode once more (to recover text from any double-encoded entity),
 * then strip tags AGAIN so a tag reconstructed by that second decode (e.g. from
 * `&amp;lt;script&amp;gt;`) can never survive into the output, and collapse
 * whitespace. Returns '' for empty/whitespace-only input.
 */
const TAG_RE = /<[^>]+>/g;

export function htmlEntityEncodedToPlainText(content: string): string {
  const decoded = decodeHtmlEntities(content).replace(TAG_RE, ' ');
  return decodeHtmlEntities(decoded)
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
