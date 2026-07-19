// Resume workspace: the LaTeX resumes synced from the portfolio repo. Each
// resume renders two panes — the compiled PDF (served by the existing
// /documents/[id] byte route via the resume's kind='resume' documents row)
// and the tabbed editor (Ask Claude | Edit source | History). Reads go
// straight to the db like other pages; every mutation goes through the
// server actions in ./actions.ts and is observed by the client poll loop.

import { type ResumeRun, resumeRuns, resumes } from '@sower/db';
import { asc, desc } from 'drizzle-orm';
import { getDb } from '../../../lib/db';
import { Timestamp } from '../../../lib/ui';
import { ResumeTabs, RunHistoryList } from './resume-tabs';
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
  const [resumeRows, runRows] = await Promise.all([
    db.select().from(resumes).orderBy(asc(resumes.name)),
    // Newest first; enough headroom that each resume still gets its last 10
    // even after repo-wide sync runs (resumeId null) are folded in.
    db.select().from(resumeRuns).orderBy(desc(resumeRuns.startedAt)).limit(60),
  ]);

  // A resume's history includes its own runs plus repo-wide syncs.
  const historyFor = (resumeId: string): RunSnapshot[] =>
    runRows
      .filter((run) => run.resumeId === resumeId || run.resumeId === null)
      .slice(0, HISTORY_LIMIT)
      .map(toSnapshot);

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
            <section key={resume.id} style={{ marginBottom: '1.5rem' }}>
              {/* ---- header: name · commit · updated · sync ---- */}
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
                <span className="spread">
                  <SyncButton />
                </span>
              </div>

              {/* ---- two panes: PDF | tabs (stacks when narrow) ---- */}
              <div className="resume-split">
                <div className="resume-pane-pdf">
                  {resume.documentId ? (
                    <iframe
                      src={`/documents/${resume.documentId}`}
                      title={`${resume.name} — compiled PDF`}
                      className="resume-frame"
                    />
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
                    resume={{
                      id: resume.id,
                      name: resume.name,
                      texPath: resume.texPath,
                      texSource: resume.texSource,
                    }}
                    history={history}
                    initialRun={initialRun}
                  />
                </div>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
