import { documents } from '@sower/db';
import type { DiscordChannelMessage } from '@sower/notify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestMessageAttachments } from './attachment-ingest.js';
import type { Deps } from './types.js';

const storageState = vi.hoisted(() => ({
  puts: [] as { path: string; bytes: number; contentType?: string }[],
  failPut: false,
}));

vi.mock('@sower/storage', () => ({
  createStorage: () => ({
    put: async (path: string, data: Buffer, contentType?: string) => {
      if (storageState.failPut) throw new Error('vault down');
      storageState.puts.push({ path, bytes: data.byteLength, contentType });
    },
  }),
}));

const ingestState = vi.hoisted(() => ({
  calls: [] as {
    url: string;
    source?: string;
    title?: string;
    resolve?: boolean;
  }[],
}));

vi.mock('./ingest.js', () => ({
  ingestJob: vi.fn(
    async (
      _deps: unknown,
      input: {
        url: string;
        source?: string;
        title?: string;
        resolve?: boolean;
      },
    ) => {
      ingestState.calls.push(input);
      return {
        duplicate: false,
        jobId: 'job-1',
        taskId: 'task-1',
        state: 'NEEDS_INPUT',
      };
    },
  ),
}));

/** Fake db that captures documents inserts. */
function fakeDeps() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (table === documents) inserted.push(row);
        return [];
      },
    }),
  };
  return { deps: { db } as unknown as Deps, inserted };
}

const CDN_URL = 'https://cdn.discordapp.com/attachments/1/2/job%20posting.png';

function message(
  attachments: DiscordChannelMessage['attachments'],
): DiscordChannelMessage {
  return { id: 'm-1', content: '', attachments };
}

function imageAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    filename: 'job posting.png',
    content_type: 'image/png',
    url: CDN_URL,
    size: 3,
    ...overrides,
  };
}

function okImageResponse(): Response {
  return new Response(Buffer.from([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

beforeEach(() => {
  storageState.puts = [];
  storageState.failPut = false;
  ingestState.calls = [];
});

afterEach(() => vi.restoreAllMocks());

describe('ingestMessageAttachments', () => {
  it('stores an image attachment, parks the task, and links a documents row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okImageResponse());
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([imageAttachment()]),
    );

    expect(outcomes).toEqual([
      {
        kind: 'screenshot',
        jobId: 'job-1',
        filename: 'job posting.png',
        stored: true,
      },
    ]);
    // Parked via the shared pipeline, without re-fetching the CDN URL.
    expect(ingestState.calls).toEqual([
      {
        url: CDN_URL,
        source: 'discord',
        resolve: false,
        title: 'job posting.png',
      },
    ]);
    // Bytes vaulted under screenshots/<uuid>/<sanitized filename>.
    expect(storageState.puts).toHaveLength(1);
    const put = storageState.puts[0];
    expect(put?.path).toMatch(/^screenshots\/[0-9a-f-]{36}\/job posting\.png$/);
    expect(put).toMatchObject({ bytes: 3, contentType: 'image/png' });
    // Documents row linked to the parked job.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      kind: 'screenshot',
      filename: 'job posting.png',
      storagePath: put?.path,
      contentType: 'image/png',
      sizeBytes: 3,
      jobId: 'job-1',
    });
  });

  it('ignores non-image attachments (and returns [] when there are none)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([
        imageAttachment({
          filename: 'resume.pdf',
          content_type: 'application/pdf',
        }),
        imageAttachment({ filename: 'notes.txt', content_type: undefined }),
      ]),
    );

    expect(outcomes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ingestState.calls).toEqual([]);
    expect(inserted).toEqual([]);
    expect(
      await ingestMessageAttachments(deps, { id: 'm-2', content: 'hi' }),
    ).toEqual([]);
  });

  it('still parks the task when the image fetch fails (never dropped)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('cdn down'));
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([imageAttachment()]),
    );

    expect(outcomes).toEqual([
      {
        kind: 'screenshot',
        jobId: 'job-1',
        filename: 'job posting.png',
        stored: false,
      },
    ]);
    expect(ingestState.calls).toHaveLength(1);
    expect(storageState.puts).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it('skips oversized images (content-length over the cap) but still parks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(50_000_000),
        },
      }),
    );
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([imageAttachment()]),
    );

    expect(outcomes[0]).toMatchObject({ stored: false, jobId: 'job-1' });
    expect(storageState.puts).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it('refuses to fetch a private-host url (SSRF guard) but still parks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([imageAttachment({ url: 'http://169.254.169.254/shot.png' })]),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ stored: false, jobId: 'job-1' });
    expect(ingestState.calls).toHaveLength(1);
    expect(inserted).toEqual([]);
  });

  it('still parks (stored:false, no documents row) when the vault put fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okImageResponse());
    storageState.failPut = true;
    const { deps, inserted } = fakeDeps();

    const outcomes = await ingestMessageAttachments(
      deps,
      message([imageAttachment()]),
    );

    expect(outcomes[0]).toMatchObject({ stored: false, jobId: 'job-1' });
    expect(ingestState.calls).toHaveLength(1);
    expect(inserted).toEqual([]);
  });
});
