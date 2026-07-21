// Follow-up presentational pieces shared by the detail page, the task
// page's Post-application panel, and the home "In play" section. No
// directive: pure presentation, renders from server components and inside
// client forms alike. Labels come from @sower/core (the ONE vocabulary the
// api and Discord share); tones are the dashboard's own (lib/followups).

import { FOLLOWUP_KIND_LABELS, FOLLOWUP_STATE_LABELS } from '@sower/core';
import { followupKindTone, followupStateTone } from '../../lib/followups';

/** Kind pill ("Assessment", "Offer") — the category marker each row leads
 *  with. Unknown kinds degrade to their raw value, never crash a row. */
export function FollowupKindBadge({ kind }: { kind: string }) {
  const label = (FOLLOWUP_KIND_LABELS as Record<string, string>)[kind] ?? kind;
  return (
    <span className={`badge badge--${followupKindTone(kind)}`} title={kind}>
      {label}
    </span>
  );
}

/** State pill mirroring the task StateBadge: plain-words label, semantic
 *  tone, raw enum in the tooltip. */
export function FollowupStateBadge({ state }: { state: string }) {
  const label =
    (FOLLOWUP_STATE_LABELS as Record<string, string>)[state] ??
    state.toLowerCase().replace(/_/g, ' ');
  return (
    <span className={`badge badge--${followupStateTone(state)}`} title={state}>
      {label}
    </span>
  );
}
