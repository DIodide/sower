// Read-only "job description" panel for the task detail page. Pure
// presentation (no client directive): renders the latest job_descriptions
// row's plain-text content inside a collapsed clay panel so it never pushes
// the answer form below the fold.
import { formatDate } from '../../../lib/format';

export interface JobDescriptionView {
  /** Plain-text description (JobSpec.description) of the latest version. */
  content: string;
  /** Version number of the latest stored description (starts at 1). */
  version: number;
  /** When the latest version was fetched from the source. */
  fetchedAt: Date | string | null;
  /** Total number of stored versions for this job. */
  versionCount: number;
}

/**
 * The caption only surfaces the version number once a re-discover has stored
 * more than one version (a single v1 needs no version chrome). `versionCount`
 * is included when it diverges from the latest version number — which can only
 * happen if history was pruned — so the count stays truthful.
 */
function caption(view: JobDescriptionView): string {
  const fetched = `fetched ${formatDate(view.fetchedAt)}`;
  if (view.versionCount <= 1) return fetched;
  const extra =
    view.versionCount !== view.version
      ? ` · ${view.versionCount} versions`
      : '';
  return `v${view.version} · ${fetched}${extra}`;
}

export function JobDescriptionPanel(view: JobDescriptionView) {
  return (
    <details className="panel">
      <summary>
        Job description <span className="hint">{caption(view)}</span>
      </summary>
      <div className="panel-body">
        <div
          className="scroll-cap"
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontSize: '0.9rem',
            lineHeight: 1.65,
          }}
        >
          {view.content}
        </div>
      </div>
    </details>
  );
}
