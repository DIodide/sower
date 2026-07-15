import type { JobSpec } from '@sower/core';
import type { Job } from '@sower/db';
import { describe, expect, it, vi } from 'vitest';
import { refreshIngestReply, renderTaskLine } from './ingest-reply.js';
import type { Deps } from './types.js';

const CHANNEL = 'chan-1';
const MESSAGE = 'reply-1';
const BASE_URL = 'https://dash.test';
const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

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
    async (_channelId: string, _messageId: string, _content: string) => {},
  );
  const deps = {
    db: { select },
    notify: { editChannelMessage },
    config: { DASHBOARD_BASE_URL: BASE_URL },
  } as unknown as Deps;
  return { deps, select, editChannelMessage };
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
      expect.any(String),
    );
    const text = editChannelMessage.mock.calls[0]?.[2] as string;
    expect(text.split('\n')).toEqual([
      `✅ [\`queued-1\`](${BASE_URL}/tasks/queued-1) queued · greenhouse`,
      `🔎 discovering form… → [\`invest-1\`](${BASE_URL}/tasks/invest-1)`,
      `🔎 form discovered: 3 fields, "Platform Intern" @ WeirdCo → [\`found-1x\`](${BASE_URL}/tasks/found-1x)`,
      `✅ form verified: 2 fields → [\`verify-1\`](${BASE_URL}/tasks/verify-1)`,
      `⚠️ recorded (unsupported) · no form found → [\`noform-1\`](${BASE_URL}/tasks/noform-1)`,
      `⚠️ recorded (unsupported) → [\`plain-1x\`](${BASE_URL}/tasks/plain-1x)`,
      `🖼️ screenshot recorded · job found → [\`shot-1xx\`](${BASE_URL}/tasks/shot-1xx)`,
    ]);
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

    const text = editChannelMessage.mock.calls[0]?.[2] as string;
    expect(text).toContain('🔎 discovering form…');
    expect(text).not.toContain('no form found');
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
  const shot = row('shot-1xx', {
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
  }) as unknown as Parameters<typeof renderTaskLine>[0];

  it('renders the plain recorded line when no investigation ran', () => {
    expect(renderTaskLine(shot, undefined, BASE_URL)).toBe(
      `🖼️ screenshot recorded → [\`shot-1xx\`](${BASE_URL}/tasks/shot-1xx)`,
    );
  });

  it('reflects a running / not_found screenshot investigation', () => {
    expect(
      renderTaskLine(shot, { kind: 'screenshot', status: 'running' }, BASE_URL),
    ).toContain('🖼️ screenshot recorded · investigating…');
    expect(
      renderTaskLine(
        shot,
        { kind: 'screenshot', status: 'not_found' },
        BASE_URL,
      ),
    ).toContain('🖼️ screenshot recorded · no job found');
  });

  it('degrades to a backticked id without a dashboard base url', () => {
    expect(renderTaskLine(shot, undefined)).toBe(
      '🖼️ screenshot recorded → `shot-1xx`',
    );
  });
});
