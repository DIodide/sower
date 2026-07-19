// Resume workspace: the LaTeX resumes synced from the portfolio repo (plus
// any forks — each resume is its own bounded section). Each resume renders
// two panes — the PDF pane with ◀ version ▶ navigation over the immutable
// resume_versions history (latest = the live /documents/[id] PDF) and the
// tabbed editor (Ask Claude | Edit source | History | Share). Reads go
// straight to the db like other pages; every mutation goes through the
// server actions in ./actions.ts and is observed by the client poll loop.

import { type ResumeRun, resumeRuns, resumes, resumeVersions } from '@sower/db';
import { asc, desc, sql } from 'drizzle-orm';
import { getDb } from '../../../lib/db';
import { Timestamp } from '../../../lib/ui';
import { ForkButton } from './fork-button';
import { RunHistoryList } from './resume-tabs';
import { ResumeWorkspace, type VersionClientView } from './resume-workspace';
import { commitUrl, type RunSnapshot, shortSha } from './run-format';
import { SyncButton } from './sync-button';

export const dynamic = 'force-dynamic';

/** Runs shown per resume in the History tab (and in the empty state). */
const HISTORY_LIMIT = 10;

/** DB row → the serializable run shape the client components render. */
function toSnapshot(run: ResumeRun): RunSnapshot {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    prompt: run.prompt,
    transcript: run.transcript ?? [],
    commitSha: run.commitSha,
    error: run.error,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

export default async function ResumesPage() {
  const db = getDb();
  const [resumeRows, runRows, versionRows] = await Promise.all([
    db.select().from(resumes).orderBy(asc(resumes.name)),
    // Newest first; enough headroom that each resume still gets its last 10
    // even after repo-wide sync runs (resumeId null) are folded in.
    db.select().from(resumeRuns).orderBy(desc(resumeRuns.startedAt)).limit(60),
    // Version history, newest first. texSource is only carried for versions
    // WITHOUT a PDF (the source-only fallback) — compiled versions would ship
    // up to 200KB of LaTeX each to the client for nothing.
    db
      .select({
        id: resumeVersions.id,
        resumeId: resumeVersions.resumeId,
        commitSha: resumeVersions.commitSha,
        kind: resumeVersions.kind,
        createdAt: resumeVersions.createdAt,
        hasPdf: sql<boolean>`(${resumeVersions.pdfStoragePath} is not null)`,
        texSource: sql<
          string | null
        >`case when ${resumeVersions.pdfStoragePath} is null then ${resumeVersions.texSource} else null end`,
      })
      .from(resumeVersions)
      .orderBy(desc(resumeVersions.createdAt)),
  ]);

  // A resume's history includes its own runs plus repo-wide syncs.
  const historyFor = (resumeId: string): RunSnapshot[] =>
    runRows
      .filter((run) => run.resumeId === resumeId || run.resumeId === null)
      .slice(0, HISTORY_LIMIT)
      .map(toSnapshot);

  const versionsFor = (resumeId: string): VersionClientView[] =>
    versionRows
      .filter((version) => version.resumeId === resumeId)
      .map((version) => ({
        id: version.id,
        commitSha: version.commitSha,
        kind: version.kind,
        createdAt: version.createdAt ? version.createdAt.toISOString() : null,
        hasPdf: version.hasPdf,
        texSource: version.texSource,
      }));

  return (
    <div>
      <h1 className="page-title">Resumes</h1>
      <p className="page-sub">
        LaTeX resumes from your portfolio repo. Preview the compiled PDF, ask
        Claude for a change in plain language, or edit the source — edits commit
        and push back to the repo.
      </p>

      {resumeRows.length === 0 ? (
        <>
          <div className="card">
            <p className="hint" style={{ margin: '0 0 0.75rem' }}>
              No resumes synced yet. Syncing clones the portfolio repo, compiles
              each <span className="mono">developer/resumes/*.tex</span>, and
              registers the PDFs here.
            </p>
            <SyncButton label="Sync from repo" primary />
          </div>
          {runRows.length > 0 ? (
            <section style={{ marginTop: '1rem' }}>
              <h2 className="section-title">Recent runs</h2>
              <div className="card">
                <RunHistoryList
                  runs={runRows.slice(0, HISTORY_LIMIT).map(toSnapshot)}
                />
              </div>
            </section>
          ) : null}
        </>
      ) : (
        resumeRows.map((resume) => {
          const history = historyFor(resume.id);
          const latest = history[0] ?? null;
          const initialRun = latest?.status === 'running' ? latest : null;
          return (
            <section key={resume.id} className="resume-section">
              {/* ---- header: name · commit · updated · fork · sync ---- */}
              <div
                className="row"
                style={{
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  marginBottom: '0.625rem',
                }}
              >
                <h2 className="section-title" style={{ margin: 0 }}>
                  {resume.name}
                </h2>
                {resume.lastCommitSha ? (
                  <a
                    className="mono"
                    style={{ fontSize: '0.8125rem' }}
                    href={commitUrl(resume.lastCommitSha)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`built from commit ${resume.lastCommitSha}`}
                  >
                    {shortSha(resume.lastCommitSha)} ↗
                  </a>
                ) : null}
                <span className="hint">
                  updated{' '}
                  <Timestamp
                    value={
                      resume.updatedAt ? resume.updatedAt.toISOString() : null
                    }
                  />
                </span>
                <span
                  className="spread row"
                  style={{ gap: '0.5rem', alignItems: 'baseline' }}
                >
                  <ForkButton resumeId={resume.id} />
                  <SyncButton />
                </span>
              </div>

              {/* ---- two panes: PDF + versions | tabs (stacks when narrow) ---- */}
              <ResumeWorkspace
                resume={{
                  id: resume.id,
                  name: resume.name,
                  texPath: resume.texPath,
                  texSource: resume.texSource,
                }}
                documentId={resume.documentId}
                versions={versionsFor(resume.id)}
                history={history}
                initialRun={initialRun}
              />
            </section>
          );
        })
      )}
    </div>
  );
}
