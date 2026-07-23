import type { JobSpec } from '@sower/core';
import type { Job } from '@sower/db';
import type { ChannelMessagePayload, DiscordEmbed } from '@sower/notify';
import { describe, expect, it, vi } from 'vitest';
import { INGEST_QUOTE_FIELD } from './discord-ingest.js';
import {
  refreshEmbedTitle,
  refreshIngestReply,
  renderTaskLine,
} from './ingest-reply.js';
import type { Deps } from './types.js';

const CHANNEL = 'chan-1';
const MESSAGE = 'reply-1';
const BASE_URL = 'https://dash.test';
const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';
/** Every fake job row is ingested at this instant → "Jul 13" in ET. */
const INGESTED_AT = new Date('2026-07-13T19:47:00Z');
const DATE = 'Jul 13';
/** The default fake job URL as the reply's link label shortens it. */
const URL_LABEL = 'weirdats.example/jobs/1';

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    innerJoin: () => self,
    orderBy: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function fakeDeps(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => chain(results.shift() ?? []));
  const editChannelMessage = vi.fn(
    async (
      _channelId: string,
      _messageId: string,
      _message: string | ChannelMessagePayload,
    ) => {},
  );
  const getChannelMessage = vi.fn(async () => ({ id: MESSAGE }));
  const deps = {
    db: { select },
    notify: { editChannelMessage, getChannelMessage },
    config: { DASHBOARD_BASE_URL: BASE_URL },
  } as unknown as Deps;
  return { deps, select, editChannelMessage, getChannelMessage };
}

/** The embed the refresh PATCHed (edits are always `{content, embeds}`). */
function editedPayload(
  editChannelMessage: ReturnType<typeof fakeDeps>['editChannelMessage'],
): { content: string; embeds: DiscordEmbed[] } {
  return editChannelMessage.mock.calls[0]?.[2] as {
    content: string;
    embeds: DiscordEmbed[];
  };
}

/** The refreshed embed's description (the per-task reply lines). */
function editedText(
  editChannelMessage: ReturnType<typeof fakeDeps>['editChannelMessage'],
): string {
  return editedPayload(editChannelMessage).embeds[0]?.description ?? '';
}

/** A sibling row as the join select returns it (only read fields matter). */
function row(
  id: string,
  jobOverrides: Partial<Job> = {},
  jobSpec: JobSpec | null = null,
) {
  return {
    task: {
      id,
      jobSpec,
      ingestChannelId: CHANNEL,
      ingestMessageId: MESSAGE,
    },
    job: {
      id: `job-${id}`,
      platform: 'unknown',
      tenant: null,
      url: 'https://weirdats.example/jobs/1',
      title: null,
      company: null,
      createdAt: INGESTED_AT,
      ...jobOverrides,
    },
  };
}

function discoveredSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    platform: 'unknown',
    tenant: '',
    externalId: '',
    title: 'Platform Intern',
    company: 'WeirdCo',
    applyUrl: 'https://weirdats.example/jobs/1/apply',
    questions: [
      { id: 'q1', label: 'First name', type: 'text', required: true },
      { id: 'q2', label: 'Email', type: 'text', required: true },
      { id: 'q3', label: 'Resume', type: 'file', required: true },
    ],
    discoveredByAgent: true,
    ...overrides,
  };
}

const REF_ROW = [{ ingestChannelId: CHANNEL, ingestMessageId: MESSAGE }];

describe('refreshIngestReply', () => {
  it('no-ops when the task carries no reply ref', async () => {
    const { deps, select, editChannelMessage } = fakeDeps([
      [{ ingestChannelId: null, ingestMessageId: null }],
    ]);

    await refreshIngestReply(deps, TASK_ID);

    expect(editChannelMessage).not.toHaveBeenCalled();
    // Only the ref lookup ran; no sibling/run queries.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the task does not exist or the notifier is absent', async () => {
    const { deps, editChannelMessage } = fakeDeps([[]]);
    await refreshIngestReply(deps, TASK_ID);
    expect(editChannelMessage).not.toHaveBeenCalled();

    const noNotify = { db: { select: vi.fn() } } as unknown as Deps;
    await expect(
      refreshIngestReply(noNotify, TASK_ID),
    ).resolves.toBeUndefined();
  });

  it('re-renders one line per sibling task from CURRENT state and edits the message', async () => {
    const siblings = [
      row('queued-1', {
        platform: 'greenhouse',
        tenant: 'acme',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
      }),
      row('invest-1'),
      row('found-1x', {}, discoveredSpec()),
      row(
        'verify-1',
        {},
        discoveredSpec({
          formVerified: true,
          questions: [
            { id: 'q1', label: 'First name', type: 'text', required: true },
            { id: 'q2', label: 'Email', type: 'text', required: true },
          ],
        }),
      ),
      row('noform-1'),
      row('plain-1x'),
      row('shot-1xx', {
        url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
      }),
    ];
    const runs = [
      { taskId: 'invest-1', kind: 'form', status: 'running' },
      { taskId: 'found-1x', kind: 'form', status: 'found' },
      { taskId: 'verify-1', kind: 'form', status: 'found' },
      { taskId: 'noform-1', kind: 'form', status: 'not_found' },
      { taskId: 'shot-1xx', kind: 'screenshot', status: 'found' },
    ];
    const { deps, editChannelMessage } = fakeDeps([REF_ROW, siblings, runs]);

    await refreshIngestReply(deps, TASK_ID);

    expect(editChannelMessage).toHaveBeenCalledTimes(1);
    expect(editChannelMessage).toHaveBeenCalledWith(
      CHANNEL,
      MESSAGE,
      // Plain content cleared; `components` omitted so buttons are untouched.
      { content: '', embeds: [expect.any(Object)] },
    );
    const payload = editedPayload(editChannelMessage);
    expect('components' in payload).toBe(false);
    // Multi-task replies title with the first line's emoji + a count.
    expect(payload.embeds[0]?.title).toBe('✅ 7 links');
    const text = editedText(editChannelMessage);
    expect(text.split('\n')).toEqual([
      `✅ [boards.greenhouse.io/acme/jobs/1](${BASE_URL}/tasks/queued-1) · queued · greenhouse · ${DATE}`,
      `🔎 [${URL_LABEL}](${BASE_URL}/tasks/invest-1) · discovering form… · ${DATE}`,
      `🔎 [Platform Intern · WeirdCo](${BASE_URL}/tasks/found-1x) · form discovered: 3 fields · ${DATE}`,
      `✅ [Platform Intern · WeirdCo](${BASE_URL}/tasks/verify-1) · form verified: 2 fields · ${DATE}`,
      `⚠️ [${URL_LABEL}](${BASE_URL}/tasks/noform-1) · recorded (unsupported) · no form found · ${DATE}`,
      `⚠️ [${URL_LABEL}](${BASE_URL}/tasks/plain-1x) · recorded (unsupported) · ${DATE}`,
      `🖼️ [cdn.discordapp.com/attachments/1/2/shot.png](${BASE_URL}/tasks/shot-1xx) · screenshot recorded · job found · ${DATE}`,
    ]);
    // A task id is only ever the link TARGET, never the visible label.
    expect(text).not.toMatch(/\[[^\]]*(queued-1|invest-1|found-1x)[^\]]*\]/);
    // The whole edit respects Discord's cap.
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('consults only the LATEST run per task (rows arrive newest-first)', async () => {
    const { deps, editChannelMessage } = fakeDeps([
      REF_ROW,
      [row('invest-1')],
      [
        // Newest run first (a re-investigation underway) wins...
        { taskId: 'invest-1', kind: 'form', status: 'running' },
        // ...over the older finished run.
        { taskId: 'invest-1', kind: 'form', status: 'not_found' },
      ],
    ]);

    await refreshIngestReply(deps, TASK_ID);

    const text = editedText(editChannelMessage);
    expect(text).toContain('· discovering form…');
    expect(text).not.toContain('no form found');
  });

  it('renders a discarded sibling with its latest DISCARD note (the expanded-listing line)', async () => {
    const discarded = row('disc-1xx');
    const siblings = [
      { ...discarded, task: { ...discarded.task, state: 'DISCARDED' } },
      row('plain-1x'),
    ];
    const discardEvents = [
      // Newest first: the listing auto-discard's note wins…
      {
        taskId: 'disc-1xx',
        data: { reason: 'auto', note: 'listing (2 jobs added)' },
      },
      // …over an older note-less manual discard.
      { taskId: 'disc-1xx', data: { reason: 'manual' } },
    ];
    const { deps, select, editChannelMessage } = fakeDeps([
      REF_ROW,
      siblings,
      [], // no investigation runs
      discardEvents,
    ]);

    await refreshIngestReply(deps, TASK_ID);

    // ref + siblings + runs + discard events (the last one only because a
    // discarded row exists).
    expect(select).toHaveBeenCalledTimes(4);
    const text = editedText(editChannelMessage);
    expect(text.split('\n')).toEqual([
      `🗑️ [${URL_LABEL}](${BASE_URL}/tasks/disc-1xx) · discarded — listing (2 jobs added) · ${DATE}`,
      `⚠️ [${URL_LABEL}](${BASE_URL}/tasks/plain-1x) · recorded (unsupported) · ${DATE}`,
    ]);
  });

  it('the LATEST discard decides even when it is note-less (older notes never resurface)', async () => {
    const discarded = row('disc-2xx');
    const { deps, editChannelMessage } = fakeDeps([
      REF_ROW,
      [{ ...discarded, task: { ...discarded.task, state: 'DISCARDED' } }],
      [], // no investigation runs
      [
        // Newest first: a re-discard without a note…
        { taskId: 'disc-2xx', data: { reason: 'manual' } },
        // …must not resurface the older listing note.
        {
          taskId: 'disc-2xx',
          data: { reason: 'auto', note: 'listing (2 jobs added)' },
        },
      ],
    ]);

    await refreshIngestReply(deps, TASK_ID);

    const text = editedText(editChannelMessage);
    expect(text).toContain('· discarded ·');
    expect(text).not.toContain('listing (2 jobs added)');
  });

  it('skips the discard-note query entirely when no sibling is discarded', async () => {
    const { deps, select } = fakeDeps([REF_ROW, [row('plain-1x')], []]);
    await refreshIngestReply(deps, TASK_ID);
    // ref + siblings + runs only.
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('preserves the quoted-original field across a refresh (the deleted message lives only there)', async () => {
    const { deps, editChannelMessage, getChannelMessage } = fakeDeps([
      REF_ROW,
      [row('plain-1x')],
      [],
    ]);
    getChannelMessage.mockResolvedValueOnce({
      id: MESSAGE,
      embeds: [
        {
          title: '⚠️ weirdats.example/jobs/1',
          description: 'old line',
          fields: [
            { name: INGEST_QUOTE_FIELD, value: 'apply here: https://x/1' },
          ],
        },
      ],
    } as never);

    await refreshIngestReply(deps, TASK_ID);

    expect(getChannelMessage).toHaveBeenCalledWith(CHANNEL, MESSAGE);
    const embed = editedPayload(editChannelMessage).embeds[0];
    expect(embed?.fields).toEqual([
      { name: INGEST_QUOTE_FIELD, value: 'apply here: https://x/1' },
    ]);
  });

  it('still refreshes (without the quote) when the message fetch fails', async () => {
    const { deps, editChannelMessage, getChannelMessage } = fakeDeps([
      REF_ROW,
      [row('plain-1x')],
      [],
    ]);
    getChannelMessage.mockRejectedValueOnce(new Error('discord down'));

    await refreshIngestReply(deps, TASK_ID);

    expect(editChannelMessage).toHaveBeenCalledTimes(1);
    const embed = editedPayload(editChannelMessage).embeds[0];
    expect(embed?.fields).toBeUndefined();
    expect(embed?.description).toContain('recorded (unsupported)');
  });

  it('upgrades a lone task reply title to Company — Title once the parse knows them', async () => {
    const { deps, editChannelMessage } = fakeDeps([
      REF_ROW,
      [
        row('lone-1xx', {
          title: 'Account Executive',
          company: 'Vercel',
          platform: 'greenhouse',
          tenant: 'acme',
          url: 'https://boards.greenhouse.io/acme/jobs/9',
        }),
      ],
      [],
    ]);

    await refreshIngestReply(deps, TASK_ID);

    expect(editedPayload(editChannelMessage).embeds[0]?.title).toBe(
      '✅ Vercel — Account Executive',
    );
  });

  it('swallows a Discord edit rejection (never throws into the caller)', async () => {
    const { deps, editChannelMessage } = fakeDeps([
      REF_ROW,
      [row('plain-1x')],
      [],
    ]);
    editChannelMessage.mockRejectedValueOnce(new Error('discord down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(refreshIngestReply(deps, TASK_ID)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('swallows a db failure too', async () => {
    const deps = {
      db: {
        select: vi.fn(() => {
          throw new Error('db down');
        }),
      },
      notify: { editChannelMessage: vi.fn() },
      config: {},
    } as unknown as Deps;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(refreshIngestReply(deps, TASK_ID)).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('renderTaskLine (screenshot states)', () => {
  const CDN_LABEL = 'cdn.discordapp.com/attachments/1/2/shot.png';
  const shot = row('shot-1xx', {
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
  }) as unknown as Parameters<typeof renderTaskLine>[0];

  it('renders the plain recorded line when no investigation ran', () => {
    expect(renderTaskLine(shot, undefined, BASE_URL)).toBe(
      `🖼️ [${CDN_LABEL}](${BASE_URL}/tasks/shot-1xx) · screenshot recorded · ${DATE}`,
    );
  });

  it('reflects a running / not_found screenshot investigation', () => {
    expect(
      renderTaskLine(shot, { kind: 'screenshot', status: 'running' }, BASE_URL),
    ).toContain('· screenshot recorded · investigating…');
    expect(
      renderTaskLine(
        shot,
        { kind: 'screenshot', status: 'not_found' },
        BASE_URL,
      ),
    ).toContain('· screenshot recorded · no job found');
  });

  it('degrades to a bold link-less label (never the id) without a dashboard base url', () => {
    expect(renderTaskLine(shot, undefined)).toBe(
      `🖼️ **${CDN_LABEL}** · screenshot recorded · ${DATE}`,
    );
  });
});

describe('renderTaskLine (discarded)', () => {
  const asRow = (r: ReturnType<typeof row>, state: string) =>
    ({
      ...r,
      task: { ...r.task, state },
    }) as unknown as Parameters<typeof renderTaskLine>[0];

  it('renders the discarded line (with the date) for a discarded task', () => {
    const line = renderTaskLine(
      asRow(
        row('disc-1xx', { title: 'Data Scientist', company: 'TickPick' }),
        'DISCARDED',
      ),
      undefined,
      BASE_URL,
    );
    expect(line).toBe(
      `🗑️ [Data Scientist · TickPick](${BASE_URL}/tasks/disc-1xx) · discarded · ${DATE}`,
    );
  });

  it('appends the discard note when provided (the listing auto-discard)', () => {
    const line = renderTaskLine(
      asRow(
        row('disc-5xx', { title: 'Careers', company: 'Databricks' }),
        'DISCARDED',
      ),
      undefined,
      BASE_URL,
      'listing (12 jobs added)',
    );
    expect(line).toBe(
      `🗑️ [Careers · Databricks](${BASE_URL}/tasks/disc-5xx) · discarded — listing (12 jobs added) · ${DATE}`,
    );
  });

  it('wins over queued/screenshot/investigation lines', () => {
    // A queued greenhouse task that was discarded no longer reads "queued"...
    const queued = renderTaskLine(
      asRow(
        row('disc-2xx', {
          platform: 'greenhouse',
          tenant: 'acme',
          url: 'https://boards.greenhouse.io/acme/jobs/1',
        }),
        'DISCARDED',
      ),
      undefined,
      BASE_URL,
    );
    expect(queued).toContain('· discarded');
    expect(queued).not.toContain('queued');

    // ...and a discarded screenshot task no longer reads "investigating".
    const shot = renderTaskLine(
      asRow(
        row('disc-3xx', {
          url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
        }),
        'DISCARDED',
      ),
      { kind: 'screenshot', status: 'running' },
      BASE_URL,
    );
    expect(shot).toContain('· discarded');
    expect(shot).not.toContain('investigating');
  });
});

describe('renderTaskLine (applied)', () => {
  const asRow = (r: ReturnType<typeof row>, state: string) =>
    ({
      ...r,
      task: { ...r.task, state },
    }) as unknown as Parameters<typeof renderTaskLine>[0];

  it('renders the applied line for SUBMITTED and CONFIRMED tasks', () => {
    for (const state of ['SUBMITTED', 'CONFIRMED']) {
      const line = renderTaskLine(
        asRow(
          row('sent-1xx', { title: 'Data Scientist', company: 'TickPick' }),
          state,
        ),
        undefined,
        BASE_URL,
      );
      expect(line).toBe(
        `✅ [Data Scientist · TickPick](${BASE_URL}/tasks/sent-1xx) · applied · ${DATE}`,
      );
    }
  });

  it('wins over the queued/screenshot lines (a sent application is never "queued")', () => {
    // A supported task marked applied out of band no longer reads "queued"...
    const queued = renderTaskLine(
      asRow(
        row('sent-2xx', {
          platform: 'greenhouse',
          tenant: 'acme',
          url: 'https://boards.greenhouse.io/acme/jobs/1',
        }),
        'SUBMITTED',
      ),
      undefined,
      BASE_URL,
    );
    expect(queued).toContain('· applied');
    expect(queued).not.toContain('queued');

    // ...and a screenshot task marked applied no longer reads "investigating".
    const shot = renderTaskLine(
      asRow(
        row('sent-3xx', {
          url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
        }),
        'SUBMITTED',
      ),
      { kind: 'screenshot', status: 'running' },
      BASE_URL,
    );
    expect(shot).toContain('· applied');
    expect(shot).not.toContain('investigating');
  });

  it('discarded still wins over applied ordering (DISCARDED renders discarded)', () => {
    const line = renderTaskLine(
      asRow(row('disc-9xx'), 'DISCARDED'),
      undefined,
      BASE_URL,
    );
    expect(line).toContain('· discarded');
    expect(line).not.toContain('applied');
  });
});

describe('renderTaskLine (link labels)', () => {
  const asRow = (r: ReturnType<typeof row>) =>
    r as unknown as Parameters<typeof renderTaskLine>[0];

  it('labels with Title · Company from the jobs row (parsed values win over the spec)', () => {
    const line = renderTaskLine(
      asRow(
        row(
          'lbl-1',
          {
            platform: 'greenhouse',
            tenant: 'acme',
            url: 'https://boards.greenhouse.io/acme/jobs/9',
            title: 'Account Executive',
            company: 'Vercel',
          },
          discoveredSpec({ title: 'Spec Title', company: 'SpecCo' }),
        ),
      ),
      undefined,
      BASE_URL,
    );
    expect(line).toBe(
      `✅ [Account Executive · Vercel](${BASE_URL}/tasks/lbl-1) · queued · greenhouse · ${DATE}`,
    );
  });

  it('falls back to the jobSpec title/company when the jobs row has none', () => {
    const line = renderTaskLine(
      asRow(row('lbl-2', {}, discoveredSpec())),
      undefined,
      BASE_URL,
    );
    expect(line).toContain(
      `[Platform Intern · WeirdCo](${BASE_URL}/tasks/lbl-2)`,
    );
  });

  it('labels with the lone known part (title-only / company-only)', () => {
    expect(
      renderTaskLine(
        asRow(row('lbl-3', { title: 'Data Scientist' })),
        undefined,
        BASE_URL,
      ),
    ).toContain(`[Data Scientist](${BASE_URL}/tasks/lbl-3)`);
    expect(
      renderTaskLine(
        asRow(row('lbl-4', { company: 'TickPick' })),
        undefined,
        BASE_URL,
      ),
    ).toContain(`[TickPick](${BASE_URL}/tasks/lbl-4)`);
  });

  it('shortens the URL fallback (scheme + www. stripped) and caps it at 48 chars', () => {
    const line = renderTaskLine(
      asRow(row('lbl-5', { url: `https://www.example.com/${'x'.repeat(80)}` })),
      undefined,
      BASE_URL,
    );
    const label = /\[([^\]]*)\]/.exec(line)?.[1] ?? '';
    expect(label.startsWith('example.com/xxx')).toBe(true);
    expect(label).toHaveLength(48);
    expect(label.endsWith('…')).toBe(true);
  });

  it('escapes markdown-breaking characters in a title', () => {
    const line = renderTaskLine(
      asRow(row('lbl-6', { title: 'Eng [Platform] `Sr`', company: 'A*Co' })),
      undefined,
      BASE_URL,
    );
    expect(line).toContain(
      `[Eng \\[Platform\\] \\\`Sr\\\` · A\\*Co](${BASE_URL}/tasks/lbl-6)`,
    );
  });

  it('renders a bold link-less label without a base url — still never the id', () => {
    const line = renderTaskLine(
      asRow(row('lbl-7', { title: 'Data Scientist', company: 'TickPick' })),
      undefined,
    );
    expect(line).toBe(
      `⚠️ **Data Scientist · TickPick** · recorded (unsupported) · ${DATE}`,
    );
    expect(line).not.toContain('lbl-7');
  });

  it('omits the date when the job has no createdAt', () => {
    const line = renderTaskLine(
      asRow(row('lbl-8', { createdAt: null })),
      undefined,
      BASE_URL,
    );
    expect(line).toBe(
      `⚠️ [${URL_LABEL}](${BASE_URL}/tasks/lbl-8) · recorded (unsupported)`,
    );
  });
});

describe('refreshEmbedTitle', () => {
  const asRows = (...rows: ReturnType<typeof row>[]) =>
    rows as unknown as Parameters<typeof refreshEmbedTitle>[0];

  it('titles a lone task with the line emoji + Company — Title', () => {
    const rows = asRows(row('t-1', { title: 'SWE', company: 'Acme' }));
    expect(refreshEmbedTitle(rows, ['✅ some line'])).toBe('✅ Acme — SWE');
  });

  it('falls back to the lone known part, the spec, then the shortened URL', () => {
    expect(
      refreshEmbedTitle(asRows(row('t-2', { title: 'SWE' })), ['⚠️ line']),
    ).toBe('⚠️ SWE');
    expect(
      refreshEmbedTitle(asRows(row('t-3', {}, discoveredSpec())), ['🔎 line']),
    ).toBe('🔎 WeirdCo — Platform Intern');
    expect(refreshEmbedTitle(asRows(row('t-4')), ['⚠️ line'])).toBe(
      `⚠️ ${URL_LABEL}`,
    );
  });

  it('titles a multi-task reply with a count', () => {
    expect(
      refreshEmbedTitle(asRows(row('t-5'), row('t-6')), ['✅ a', '⚠️ b']),
    ).toBe('✅ 2 links');
  });
});
