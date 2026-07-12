// Read-only "job description" panel for the task detail page. Pure
// presentation (no client directive): renders the latest job_descriptions
// row's plain-text content in a scroll-capped panel, with a small version
// caption when the description has been re-fetched into multiple versions.
import { formatDate } from '../../../lib/format';
import { BORDER, MONO, MUTED, PANEL_BG } from '../../../lib/ui';

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
    <div
      style={{
        backgroundColor: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: '0.5rem',
        padding: '1rem 1.25rem',
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          color: MUTED,
          fontFamily: MONO,
          marginBottom: '0.75rem',
        }}
      >
        {caption(view)}
      </div>
      <div
        style={{
          maxHeight: '24rem',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontSize: '0.875rem',
          lineHeight: 1.65,
          color: '#d7dae0',
        }}
      >
        {view.content}
      </div>
    </div>
  );
}
