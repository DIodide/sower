'use client';

// One home-page "In play" row: kind badge, company · title link, state
// badge, due ⏰ chip (labels precomputed server-side so hydration never
// disagrees on "now"), and a ghost '×' dismiss — hover/focus revealed,
// always visible on touch (the .jn-del idiom). Dismiss fires the
// follow-up's DISMISS transition and optimistic-removes the row (the
// section is server-rendered, so this tiny client island owns only its own
// visibility): hide NOW, converge via router.refresh(); a failure un-hides
// the row and explains via the workspace toast. No undo — Reopen lives on
// the follow-up's detail page.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { transitionFollowup } from './followups/actions';
import { FollowupKindBadge, FollowupStateBadge } from './followups/ui';
import { useWorkspace } from './workspace';

export interface InPlayRowData {
  id: string;
  taskId: string;
  kind: string;
  title: string;
  /** Company display name (jobSpec fallback applied server-side). */
  company: string;
  state: string;
  /** ⏰ chip display, precomputed on the server; null = no due date. */
  due: { label: string; title: string; soon: boolean } | null;
}

export function InPlayRow({ row }: { row: InPlayRowData }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const dismiss = () => {
    setBusy(true);
    setHidden(true);
    transitionFollowup(row.id, 'DISMISS', row.taskId)
      .then((result) => {
        if (result.ok) {
          ws.toast('Dismissed — Reopen is on its follow-up page.');
          router.refresh();
        } else {
          setHidden(false);
          ws.toast(result.message, { kind: 'error' });
        }
      })
      .catch(() => {
        setHidden(false);
        ws.toast('Dismiss failed — could not reach the server.', {
          kind: 'error',
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (hidden) return null;

  return (
    <div className="fu-row">
      <FollowupKindBadge kind={row.kind} />
      <span className="fu-title">
        <span className="faint">
          {row.company}
          {' · '}
        </span>
        <Link href={`/followups/${row.id}`}>{row.title}</Link>
      </span>
      <FollowupStateBadge state={row.state} />
      <span className="fu-due">
        {row.due ? (
          <span
            className={
              row.due.soon
                ? 'deadline-chip deadline-chip--soon'
                : 'deadline-chip'
            }
            title={row.due.title}
          >
            ⏰ {row.due.label}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="fu-del"
        disabled={busy}
        onClick={dismiss}
        aria-label={`Dismiss ${row.title}`}
        title="Dismiss this follow-up (Reopen it later from its detail page)"
      >
        ×
      </button>
    </div>
  );
}
