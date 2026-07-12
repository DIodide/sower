// Answer-library management page. Listing and mutations go through the sower
// api's /answer-library routes (see ./library.ts and ./actions.ts); the only
// direct db read here is the list of company names seen on ingested jobs,
// used to power the scope picker's suggestions.
import { jobs } from '@sower/db';
import { getDb } from '../../lib/db';
import { AnswersManager } from './answers-manager';
import { fetchAnswerLibrary } from './library';

export const dynamic = 'force-dynamic';

async function fetchJobCompanies(): Promise<string[]> {
  try {
    const db = getDb();
    const rows = await db.selectDistinct({ company: jobs.company }).from(jobs);
    return rows
      .map((r) => r.company)
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  } catch {
    // The picker suggestions are a convenience — the page still works (with a
    // free-text company field) when the db is unreachable.
    return [];
  }
}

export default async function AnswersPage() {
  const [library, jobCompanies] = await Promise.all([
    fetchAnswerLibrary(),
    fetchJobCompanies(),
  ]);

  return (
    <div>
      <h1 className="page-title">Answer library</h1>
      <p className="page-sub">
        Saved answers auto-fill matching questions on future applications.
        Nothing is ever invented — questions without a saved or profile answer
        stay in <strong>Needs input</strong>.
      </p>
      <details className="expand" style={{ margin: '-0.75rem 0 1.5rem' }}>
        <summary>How matching and company scopes work</summary>
        <div
          className="well"
          style={{ marginTop: '0.5rem', maxWidth: '46rem' }}
        >
          <p className="hint" style={{ margin: 0 }}>
            Matching is fuzzy on punctuation and case but otherwise exact, so
            save answers under the question text as it appears on application
            forms. A <strong>company-specific</strong> answer (e.g. “Why do you
            want to work here?”) is only used for that company. A{' '}
            <strong>global</strong> answer applies to any company — but a
            company-specific answer for the same question always wins for its
            company.
          </p>
        </div>
      </details>
      {library.ok ? (
        <AnswersManager entries={library.entries} jobCompanies={jobCompanies} />
      ) : (
        <div className="card">
          <p className="status-err" style={{ margin: 0 }}>
            Could not load the answer library: {library.message}
          </p>
          <p className="hint" style={{ margin: '0.5rem 0 0' }}>
            The answer library is served by the sower api — check that the api
            service is running and that API_BASE_URL and INGEST_API_KEY are set
            for the dashboard.
          </p>
        </div>
      )}
    </div>
  );
}
