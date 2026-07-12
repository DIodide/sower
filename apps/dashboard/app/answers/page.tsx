// Answer-library management page. Listing and mutations go through the sower
// api's /answer-library routes (see ./library.ts and ./actions.ts); the only
// direct db read here is the list of company names seen on ingested jobs,
// used to power the scope picker's suggestions.
import { jobs } from '@sower/db';
import { getDb } from '../../lib/db';
import { BORDER, MUTED, PANEL_BG } from '../../lib/ui';
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
      <h2
        style={{
          margin: '0 0 0.375rem',
          fontSize: '1.125rem',
          fontWeight: 600,
        }}
      >
        Answer library
      </h2>
      <p
        style={{
          margin: '0 0 1.25rem',
          fontSize: '0.8rem',
          color: MUTED,
          lineHeight: 1.6,
          maxWidth: '48rem',
        }}
      >
        Saved answers auto-fill matching application questions.{' '}
        <strong style={{ color: '#c4b5fd' }}>Company-specific</strong> answers
        (e.g. “Why do you want to work here?”) are only used for that company;{' '}
        <strong style={{ color: '#9ca3af' }}>global</strong> answers apply to
        any company, but a company-specific answer always wins for its company.
        Nothing is ever invented — questions without a saved or profile answer
        stay in Needs&nbsp;Input.
      </p>
      {library.ok ? (
        <AnswersManager entries={library.entries} jobCompanies={jobCompanies} />
      ) : (
        <div
          style={{
            backgroundColor: PANEL_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: '0.5rem',
            padding: '1.25rem 1.5rem',
            fontSize: '0.875rem',
            lineHeight: 1.6,
          }}
        >
          <p style={{ margin: 0, color: '#f87171' }}>
            could not load the answer library: {library.message}
          </p>
          <p style={{ margin: '0.5rem 0 0', color: MUTED, fontSize: '0.8rem' }}>
            the answer library is served by the sower api — check that the api
            service is running and that API_BASE_URL and INGEST_API_KEY are set
            for the dashboard.
          </p>
        </div>
      )}
    </div>
  );
}
