// Read-only "job description" panel for the task detail page. Pure
// presentation (no client directive): renders the latest job_descriptions
// row's content — agent-scraped markdown for unsupported links, plain text
// (often markdown-ish) from adapter platforms — through the safe markdown
// renderer (lib/markdown: React elements only, never raw HTML) inside a
// collapsible clay panel. Collapsed by default so it never pushes the answer
// form below the fold, except when the task is waiting on the user, who
// reads the description while answering.
import { formatLocal } from '../../../lib/format';
import { Markdown } from '../../../lib/markdown';

export interface JobDescriptionView {
  /** Latest stored description: markdown (agent) or plain text (adapter). */
  content: string;
  /** Version number of the latest stored description (starts at 1). */
  version: number;
  /** When the latest version was fetched from the source. */
  fetchedAt: Date | string | null;
  /** Total number of stored versions for this job. */
  versionCount: number;
  /** Render open on first paint (NEEDS_INPUT/REVIEW tasks). */
  defaultOpen?: boolean;
}

/**
 * The caption only surfaces the version number once a re-discover has stored
 * more than one version (a single v1 needs no version chrome). `versionCount`
 * is included when it diverges from the latest version number — which can only
 * happen if history was pruned — so the count stays truthful.
 */
function caption(view: JobDescriptionView): string {
  const fetched = `fetched ${formatLocal(view.fetchedAt)}`;
  if (view.versionCount <= 1) return fetched;
  const extra =
    view.versionCount !== view.version
      ? ` · ${view.versionCount} versions`
      : '';
  return `v${view.version} · ${fetched}${extra}`;
}

export function JobDescriptionPanel(view: JobDescriptionView) {
  return (
    <details className="panel" open={view.defaultOpen || undefined}>
      <summary>
        Job description <span className="hint">{caption(view)}</span>
      </summary>
      <div className="panel-body">
        <div className="scroll-cap">
          <Markdown content={view.content} />
        </div>
      </div>
    </details>
  );
}
