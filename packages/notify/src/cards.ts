/**
 * Pure builders for Discord approval-card message payloads. No network here —
 * these are unit-testable and reused by the interactions handler in apps/api
 * to construct type-7 (UPDATE_MESSAGE) responses.
 */

/** Summary of an application task awaiting human review. */
export interface ApprovalCard {
  taskId: string;
  platform: string;
  company: string;
  title: string;
  applyUrl: string;
  fieldCount: number;
  fileCount: number;
  missingRequired: number;
}

export type ApprovalVerdict = 'approved' | 'rejected' | 'submitted-dryrun';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export interface DiscordButton {
  type: 2;
  style: number;
  label?: string;
  custom_id?: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface ApprovalMessagePayload {
  embeds: DiscordEmbed[];
  components: DiscordActionRow[];
}

/** Embed colors by card state. */
export const CARD_COLORS: Readonly<
  Record<'pending' | ApprovalVerdict, number>
> = {
  pending: 0xf1c40f,
  approved: 0x57f287,
  rejected: 0xed4245,
  'submitted-dryrun': 0x5865f2,
};

const VERDICT_LABELS: Readonly<Record<ApprovalVerdict, string>> = {
  approved: 'Approved',
  rejected: 'Rejected',
  'submitted-dryrun': 'Submitted (dry run — no real application was sent)',
};

/** Button style constants (Discord API): 3 = green/success, 4 = red/danger. */
const BUTTON_STYLE_SUCCESS = 3;
const BUTTON_STYLE_DANGER = 4;

/**
 * Build the initial (pending review) approval card: an embed summarizing the
 * task plus Approve / Reject buttons whose custom_ids encode the task id.
 */
/** Discord caps embed titles at 256 chars; trim with an ellipsis. */
function clampTitle(text: string): string {
  return text.length <= 256 ? text : `${text.slice(0, 255)}…`;
}

export function buildApprovalMessage(
  card: ApprovalCard,
): ApprovalMessagePayload {
  return {
    embeds: [
      {
        title: clampTitle(`${card.company} — ${card.title}`),
        url: card.applyUrl,
        color: CARD_COLORS.pending,
        description: `Task \`${card.taskId}\` is ready for review.`,
        fields: [
          { name: 'Platform', value: card.platform, inline: true },
          { name: 'Fields', value: String(card.fieldCount), inline: true },
          { name: 'Files', value: String(card.fileCount), inline: true },
          {
            name: 'Missing required',
            value: String(card.missingRequired),
            inline: true,
          },
        ],
        footer: { text: `task:${card.taskId}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: BUTTON_STYLE_SUCCESS,
            label: 'Approve (dry run)',
            custom_id: `approve:${card.taskId}`,
          },
          {
            type: 2,
            style: BUTTON_STYLE_DANGER,
            label: 'Reject',
            custom_id: `reject:${card.taskId}`,
          },
        ],
      },
    ],
  };
}

/**
 * Produce the edited payload for an existing card once a verdict is reached:
 * recolor the embed, append a verdict line, and disable every button.
 * Accepts the current message payload (embeds/components) so the original
 * content is preserved; tolerates a missing/partial message.
 */
export function applyVerdict(
  existing: Partial<ApprovalMessagePayload>,
  verdict: ApprovalVerdict,
  detail?: string,
): ApprovalMessagePayload {
  const label = VERDICT_LABELS[verdict];
  const line = detail ? `**${label}** — ${detail}` : `**${label}**`;
  const [first, ...rest] = existing.embeds ?? [];
  const base: DiscordEmbed = first ?? { title: 'Application task' };
  const embed: DiscordEmbed = {
    ...base,
    color: CARD_COLORS[verdict],
    description: base.description ? `${base.description}\n${line}` : line,
  };
  const components = (existing.components ?? []).map((row) => ({
    ...row,
    components: row.components.map((button) => ({ ...button, disabled: true })),
  }));
  return { embeds: [embed, ...rest], components };
}
