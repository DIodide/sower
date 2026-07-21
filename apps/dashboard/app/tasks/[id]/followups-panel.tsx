// The task page's "Post-application" panel: everything that happened AFTER
// this application was sent — assessment invites, interviews, recruiter
// threads, offers, rejections — each a follow-up rendered as a row linking
// to its own detail page, plus the inline add form. No directive: pure
// presentation over server-fetched rows (the add form is the client island).

import type { Followup } from '@sower/db';
import Link from 'next/link';
import {
  deadlineChipLabel,
  formatDeadline,
  isDeadlineSoon,
} from '../../../lib/format';
import { SectionHeading } from '../../../lib/ui';
import { FollowupKindBadge, FollowupStateBadge } from '../../followups/ui';
import { FollowupAddForm } from './followup-add-form';

export function FollowupsPanel({
  taskId,
  rows,
}: {
  taskId: string;
  rows: Followup[];
}) {
  return (
    <section id="followups">
      <SectionHeading count={rows.length}>Post-application</SectionHeading>
      <div className="card">
        {rows.length === 0 ? (
          <p className="hint" style={{ margin: '0 0 0.625rem' }}>
            Nothing yet — when this application gets a reply (an assessment
            invite, an interview, a recruiter email, an offer or rejection),
            track it here.
          </p>
        ) : (
          <div className="row-list" style={{ marginBottom: '0.625rem' }}>
            {rows.map((followup) => (
              <div key={followup.id} className="fu-row">
                <FollowupKindBadge kind={followup.kind} />
                <span className="fu-title">
                  <Link href={`/followups/${followup.id}`}>
                    {followup.title}
                  </Link>
                </span>
                <FollowupStateBadge state={followup.state} />
                <span className="fu-due">
                  {followup.dueDate ? (
                    <span
                      className={
                        isDeadlineSoon(followup.dueDate)
                          ? 'deadline-chip deadline-chip--soon'
                          : 'deadline-chip'
                      }
                      title={`due ${formatDeadline(followup.dueDate)}`}
                    >
                      ⏰ {deadlineChipLabel(followup.dueDate)}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
        <FollowupAddForm taskId={taskId} />
      </div>
    </section>
  );
}
