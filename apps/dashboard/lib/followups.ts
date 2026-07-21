// Pure follow-up display helpers (tones, link hosts, event-data readers).
// Deliberately structural (plain strings, no @sower/core imports): the label
// vocabulary lives in @sower/core (FOLLOWUP_*_LABELS); this module only maps
// values the DASHBOARD invented — semantic tones and event-jsonb reading —
// so it stays unit-testable independent of the backend contract landing.

import type { Tone } from './format';

/** Follow-up state → semantic tone (states needing the user read attention,
 *  like the task rows' NEEDS_INPUT/REVIEW). Unknown states degrade neutral. */
const FOLLOWUP_STATE_TONES: Record<string, Tone> = {
  RECEIVED: 'attention',
  ACTION_NEEDED: 'attention',
  SCHEDULED: 'progress',
  WAITING: 'neutral',
  DONE: 'success',
  DISMISSED: 'neutral',
};

export function followupStateTone(state: string): Tone {
  return FOLLOWUP_STATE_TONES[state] ?? 'neutral';
}

/** Follow-up kind → badge tone: outcomes carry their verdict (offer green,
 *  rejection red); process kinds stay quiet. Unknown kinds degrade neutral. */
const FOLLOWUP_KIND_TONES: Record<string, Tone | 'accent'> = {
  assessment: 'accent',
  interview: 'progress',
  recruiter: 'neutral',
  offer: 'success',
  rejection: 'danger',
  other: 'neutral',
};

export function followupKindTone(kind: string): Tone | 'accent' {
  return FOLLOWUP_KIND_TONES[kind] ?? 'neutral';
}

/**
 * Hostname for the "Open <host>" button label (www. stripped — the brand is
 * the label, not the subdomain plumbing). Unparseable urls fall back to a
 * generic "link" rather than leaking a mangled string into a button.
 */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'link';
  } catch {
    return 'link';
  }
}

/** The followupId an event's jsonb data names, or null — the key the
 *  follow-up detail page filters the parent task's timeline on. */
export function followupIdOf(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).followupId;
  return typeof id === 'string' && id !== '' ? id : null;
}

export interface FollowupEventDetails {
  /** The FollowupEvent that caused a FOLLOWUP_STATE change, when recorded. */
  event: string | null;
  from: string | null;
  to: string | null;
}

/**
 * Follow-up state-change details from an event's jsonb data. The events
 * table's from_state/to_state columns hold TASK states, so a follow-up
 * transition carries its own from/to inside data — read defensively: any
 * absent or non-string field is simply null.
 */
export function followupEventDetails(data: unknown): FollowupEventDetails {
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const pick = (key: string): string | null => {
    const value = record?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return { event: pick('event'), from: pick('from'), to: pick('to') };
}
