'use client';

// The two-pane body of one resume: the PDF pane with ◀ version N of M ▶
// navigation over the immutable resume_versions history, and the tabbed
// editor. This wrapper owns the "which version am I viewing" state so the
// Edit tab can warn that edits always apply to the LATEST version.
//
// Position semantics: version M (the newest) IS the live resume — it renders
// the /documents/<id> PDF exactly as before this feature; stepping back swaps
// the frame to the IAP-gated /answers/resumes/versions/<versionId> stream. A
// version whose compile failed has no PDF — it shows its LaTeX source instead.

import type { ResumeVersionKind } from '@sower/db';
import { useState } from 'react';
import { Timestamp } from '../../../lib/ui';
import { type ResumeClientView, ResumeTabs } from './resume-tabs';
import { commitUrl, KIND_META, type RunSnapshot, shortSha } from './run-format';

/**
 * One resume_versions row, serialized for the client. `texSource` rides along
 * ONLY for versions with no PDF (failed compile — the source-only fallback);
 * for compiled versions it stays server-side.
 */
export interface VersionClientView {
  id: string;
  commitSha: string;
  kind: ResumeVersionKind;
  createdAt: string | null;
  hasPdf: boolean;
  texSource: string | null;
}

export function ResumeWorkspace({
  resume,
  documentId,
  versions,
  history,
  initialRun,
}: {
  resume: ResumeClientView;
  /** The live documents row for the CURRENT PDF (null = never compiled). */
  documentId: string | null;
  /** The resume's version history, newest first. */
  versions: VersionClientView[];
  history: RunSnapshot[];
  initialRun: RunSnapshot | null;
}) {
  // 0 = the LATEST (live PDF); i > 0 = versions[i] (older). A refresh can
  // grow/shrink the list, so the index is clamped on every render.
  const [viewIndex, setViewIndex] = useState(0);
  const total = versions.length;
  const index = Math.min(viewIndex, Math.max(0, total - 1));
  const viewing = index > 0 ? versions[index] : null;

  // The one <iframe> src: latest → live document, older → version stream.
  // Null means there is no PDF to frame (source-only version / never built).
  const frameSrc = viewing
    ? viewing.hasPdf
      ? `/answers/resumes/versions/${viewing.id}`
      : null
    : documentId
      ? `/documents/${documentId}`
      : null;

  return (
    <div className="resume-split">
      <div className="resume-pane-pdf">
        {total > 0 ? (
          <div className="version-nav">
            <button
              type="button"
              className="btn btn--sm"
              aria-label="Previous (older) version"
              title="Previous (older) version"
              disabled={index >= total - 1}
              onClick={() => setViewIndex(Math.min(index + 1, total - 1))}
            >
              ◀
            </button>
            <span className="num">
              version {total - index} of {total}
            </span>
            <button
              type="button"
              className="btn btn--sm"
              aria-label="Next (newer) version"
              title="Next (newer) version"
              disabled={index === 0}
              onClick={() => setViewIndex(Math.max(index - 1, 0))}
            >
              ▶
            </button>
          </div>
        ) : null}

        {viewing ? (
          <div className="version-banner">
            <span style={{ minWidth: 0 }}>
              Viewing version from <Timestamp value={viewing.createdAt} /> ·{' '}
              <a
                className="mono"
                href={commitUrl(viewing.commitSha)}
                target="_blank"
                rel="noopener noreferrer"
                title={viewing.commitSha}
              >
                {shortSha(viewing.commitSha)}
              </a>{' '}
              · {KIND_META[viewing.kind].label}
            </span>
            <button
              type="button"
              className="btn btn--sm spread"
              onClick={() => setViewIndex(0)}
            >
              back to latest
            </button>
          </div>
        ) : null}

        {frameSrc ? (
          <iframe
            src={frameSrc}
            title={
              viewing
                ? `${resume.name} — version ${shortSha(viewing.commitSha)}`
                : `${resume.name} — compiled PDF`
            }
            className="resume-frame"
          />
        ) : viewing ? (
          <div className="card">
            <p className="hint" style={{ margin: 0 }}>
              No PDF for this version — the compile failed; source only.
            </p>
            {viewing.texSource ? (
              <details className="expand" style={{ marginTop: '0.5rem' }}>
                <summary>LaTeX source at {shortSha(viewing.commitSha)}</summary>
                <pre className="codeblock">{viewing.texSource}</pre>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="card">
            <p className="hint" style={{ margin: 0 }}>
              Not compiled yet — sync first.
            </p>
          </div>
        )}
      </div>
      <div className="resume-pane-side">
        <ResumeTabs
          resume={resume}
          history={history}
          initialRun={initialRun}
          viewingOldVersion={viewing !== null}
        />
      </div>
    </div>
  );
}
