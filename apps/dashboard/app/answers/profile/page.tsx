// Profile editor page. The profile is the resolver's primary answer source:
// its values auto-fill matching application questions (name/email/phone,
// location, links, education, work authorization, …). Stored as a single DB
// row served by the sower api (GET/PUT /profile) — the dashboard never
// touches the profiles table directly.
import { getProfileAction } from './actions';
import { ProfileEditor } from './profile-editor';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const load = await getProfileAction();

  return (
    <div>
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">
        These values auto-fill applications — resolution matches them to each
        form&rsquo;s questions. Nothing is ever invented: a blank or unset field
        simply sends that question to <strong>Needs input</strong>.
      </p>
      {!load.ok ? (
        <div className="card">
          <p className="status-err" style={{ margin: 0 }}>
            Could not load the profile: {load.message}
          </p>
          <p className="hint" style={{ margin: '0.5rem 0 0' }}>
            The profile is served by the sower api — check that the api service
            is running and that API_BASE_URL and INGEST_API_KEY are set for the
            dashboard.
          </p>
        </div>
      ) : (
        <>
          {!load.configured ? (
            <div
              className="banner banner--attention"
              style={{ marginBottom: '1rem' }}
            >
              <strong>No profile yet.</strong> Until one is saved here, tasks
              resolve without profile facts — only saved answers and documents
              auto-fill, and everything else waits on you. Fill this in once and
              every future application uses it.
            </div>
          ) : null}
          <ProfileEditor
            initial={load.profile}
            updatedAt={load.updatedAt}
            configured={load.configured}
          />
        </>
      )}
    </div>
  );
}
