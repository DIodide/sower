// The latest browser-fill job for a greenhouse task: status chip, the
// live-view link, and the runner's per-field report. A server component that
// reads the newest fill_jobs row itself (like the page's other panels); while
// the job is active a small client refresher polls so the panel converges
// without a manual reload. The runner NEVER submits — the human finishes in
// the live view, which is why that link is the panel's primary action.
import { fillJobs } from '@sower/db';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../lib/db';
import {
  FILL_OUTCOME_TONE,
  fillStatusMeta,
  parseFillReport,
} from '../../../lib/fill-job';
import {
  ExpandableText,
  SectionHeading,
  TableWrap,
  Timestamp,
} from '../../../lib/ui';
import { FillJobRefresher } from './fill-job-refresher';
import { Badge } from './ui';

const STATUS_HINTS: Record<string, string> = {
  requested: 'Waiting for the runner on your machine to pick this up.',
  claimed: 'The runner is opening the application form in a browser…',
  running: 'The runner is filling your answers into the real form…',
  ready:
    'The form is filled and the browser session was left open for you — check every field in the live view, attach any files, and submit it yourself. Nothing is ever submitted automatically.',
};

export async function FillJobPanel({ taskId }: { taskId: string }) {
  const db = getDb();
  const rows = await db
    .select()
    .from(fillJobs)
    .where(eq(fillJobs.taskId, taskId))
    .orderBy(desc(fillJobs.requestedAt))
    .limit(1);
  const job = rows[0];
  if (!job) return null;

  const meta = fillStatusMeta(job.status);
  const report = parseFillReport(job.report);
  const hint = STATUS_HINTS[job.status];

  return (
    <section>
      <SectionHeading>Browser fill</SectionHeading>
      <div className="card">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {job.liveViewUrl ? (
            <a
              className="btn btn--primary btn--sm"
              href={job.liveViewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open live view ↗
            </a>
          ) : null}
          <span className="hint faint spread">
            requested <Timestamp value={job.requestedAt} inline />
          </span>
        </div>
        {job.status === 'failed' && job.error ? (
          <div className="status-err" style={{ marginTop: '0.625rem' }}>
            <ExpandableText text={job.error} max={200} />
          </div>
        ) : null}
        {hint ? (
          <p className="hint" style={{ margin: '0.625rem 0 0' }}>
            {hint}
          </p>
        ) : null}
        {report.length > 0 ? (
          <div style={{ marginTop: '0.75rem' }}>
            <TableWrap>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.map((entry) => (
                  <tr key={entry.questionId}>
                    <td>{entry.label}</td>
                    <td>
                      <Badge tone={FILL_OUTCOME_TONE[entry.outcome]}>
                        {entry.outcome}
                      </Badge>
                    </td>
                    <td>{entry.detail ?? <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        ) : null}
        {meta.active ? (
          <FillJobRefresher
            jobId={job.id}
            status={job.status}
            hasLiveView={job.liveViewUrl !== null}
            hasReport={job.report !== null}
          />
        ) : null}
      </div>
    </section>
  );
}
