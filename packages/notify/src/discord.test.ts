import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalCard,
  applyVerdict,
  buildApprovalMessage,
  buildOtpRequestMessage,
  CARD_COLORS,
} from './cards.js';
import {
  editChannelMessage,
  notifyText,
  postApprovalCard,
  postChannelMessage,
  updateApprovalCard,
} from './discord.js';

const card: ApprovalCard = {
  taskId: 'task-123',
  platform: 'greenhouse',
  company: 'Acme',
  title: 'Software Engineer Intern',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/42',
  fieldCount: 12,
  fileCount: 1,
  missingRequired: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discord REST driver', () => {
  const fetchMock = vi.fn();

  function fetchCall(index: number): { url: string; init: RequestInit } {
    const call = fetchMock.mock.calls[index];
    if (!call) throw new Error(`fetch call ${index} was not recorded`);
    return { url: call[0] as string, init: call[1] as RequestInit };
  }

  function authHeader(index: number): string | undefined {
    const headers = fetchCall(index).init.headers as Record<string, string>;
    return headers.authorization;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DISCORD_BOT_TOKEN', 'test-token-from-env');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('postApprovalCard', () => {
    it('posts the card to the platform channel with buttons and returns ids', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ id: 'msg-1', channel_id: '1525749024261541978' }),
      );

      const ref = await postApprovalCard(card);

      expect(ref).toEqual({
        channelId: '1525749024261541978',
        messageId: 'msg-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://discord.com/api/v10/channels/1525749024261541978/messages',
      );
      expect(init.method).toBe('POST');

      const payload = JSON.parse(init.body as string);
      expect(payload.embeds[0].title).toBe('Acme — Software Engineer Intern');
      expect(payload.embeds[0].url).toBe(card.applyUrl);
      expect(payload.embeds[0].color).toBe(CARD_COLORS.pending);
      const buttons = payload.components[0].components;
      expect(buttons.map((b: { custom_id: string }) => b.custom_id)).toEqual([
        'approve:task-123',
        'reject:task-123',
      ]);
      // green approve, red reject
      expect(buttons[0].style).toBe(3);
      expect(buttons[1].style).toBe(4);
    });

    it('authenticates with the token from the env, never a hardcoded one', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ id: 'msg-1' }));

      await postApprovalCard(card);
      expect(authHeader(0)).toBe('Bot test-token-from-env');

      vi.stubEnv('DISCORD_BOT_TOKEN', 'rotated-token');
      await postApprovalCard(card);
      expect(authHeader(1)).toBe('Bot rotated-token');
    });

    it('rejects without a bot token and never touches the network', async () => {
      vi.stubEnv('DISCORD_BOT_TOKEN', '');
      await expect(postApprovalCard(card)).rejects.toThrow(
        /DISCORD_BOT_TOKEN is not set/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses DISCORD_FALLBACK_CHANNEL for unmapped platforms', async () => {
      vi.stubEnv('DISCORD_FALLBACK_CHANNEL', 'fallback-9');
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'msg-2' }));

      const ref = await postApprovalCard({
        ...card,
        platform: 'smartrecruiters',
      });

      expect(ref).toEqual({ channelId: 'fallback-9', messageId: 'msg-2' });
      expect(fetchCall(0).url).toBe(
        'https://discord.com/api/v10/channels/fallback-9/messages',
      );
    });

    it('throws for unmapped platforms without a fallback, without network', async () => {
      await expect(
        postApprovalCard({ ...card, platform: 'smartrecruiters' }),
      ).rejects.toThrow(/No Discord channel configured/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('honors a DISCORD_CHANNEL_MAP env override', async () => {
      vi.stubEnv('DISCORD_CHANNEL_MAP', '{"greenhouse":"override-1"}');
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'msg-3' }));

      await postApprovalCard(card);

      expect(fetchCall(0).url).toBe(
        'https://discord.com/api/v10/channels/override-1/messages',
      );
    });

    it('redacts the bot token from API error messages', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('unauthorized: test-token-from-env', { status: 403 }),
      );
      const error = await postApprovalCard(card).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).not.toContain('test-token-from-env');
      expect((error as Error).message).toContain('[redacted]');
    });
  });

  describe('updateApprovalCard', () => {
    it('fetches the message, disables buttons, recolors, appends verdict', async () => {
      const original = buildApprovalMessage(card);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 'msg-1', ...original }))
        .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }));

      await updateApprovalCard('chan-1', 'msg-1', 'approved', 'dry-run only');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [getUrl, getInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(getUrl).toBe(
        'https://discord.com/api/v10/channels/chan-1/messages/msg-1',
      );
      expect(getInit.method).toBe('GET');

      const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [
        string,
        RequestInit,
      ];
      expect(patchUrl).toBe(
        'https://discord.com/api/v10/channels/chan-1/messages/msg-1',
      );
      expect(patchInit.method).toBe('PATCH');
      const payload = JSON.parse(patchInit.body as string);
      expect(payload.embeds[0].color).toBe(CARD_COLORS.approved);
      expect(payload.embeds[0].description).toContain('ready for review');
      expect(payload.embeds[0].description).toContain('Approved');
      expect(payload.embeds[0].description).toContain('dry-run only');
      for (const button of payload.components[0].components) {
        expect(button.disabled).toBe(true);
      }
    });

    it('still patches a minimal verdict embed when the GET fails', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('gone', { status: 404 }))
        .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }));

      await updateApprovalCard('chan-1', 'msg-1', 'rejected');

      const payload = JSON.parse(fetchCall(1).init.body as string);
      expect(payload.embeds[0].color).toBe(CARD_COLORS.rejected);
      expect(payload.embeds[0].description).toContain('Rejected');
    });
  });

  describe('notifyText', () => {
    it('posts plain content to the platform channel', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'msg-4' }));

      await notifyText('lever', 'poll complete: 3 ingested');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://discord.com/api/v10/channels/1525749025897316503/messages',
      );
      expect(JSON.parse(init.body as string)).toEqual({
        content: 'poll complete: 3 ingested',
      });
    });
  });

  describe('postChannelMessage', () => {
    it('POSTs to the channel and returns the created message id', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'msg-5' }));

      const message = await postChannelMessage('chan-9', '✅ queued');

      expect(message).toEqual({ id: 'msg-5' });
      const { url, init } = fetchCall(0);
      expect(url).toBe('https://discord.com/api/v10/channels/chan-9/messages');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ content: '✅ queued' });
    });
  });

  describe('editChannelMessage', () => {
    it('PATCHes the message content in place', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'msg-5' }));

      await editChannelMessage('chan-9', 'msg-5', '✅ form verified');

      const { url, init } = fetchCall(0);
      expect(url).toBe(
        'https://discord.com/api/v10/channels/chan-9/messages/msg-5',
      );
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({
        content: '✅ form verified',
      });
    });

    it('throws a redacted error when the PATCH fails', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('nope: test-token-from-env', { status: 403 }),
      );
      const error = await editChannelMessage('chan-9', 'msg-5', 'x').catch(
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).not.toContain('test-token-from-env');
    });
  });
});

describe('card payload builders (pure)', () => {
  it('buildApprovalMessage encodes counts and the task id footer', () => {
    const payload = buildApprovalMessage(card);
    const fields = payload.embeds[0]?.fields;
    expect(fields).toContainEqual({
      name: 'Fields',
      value: '12',
      inline: true,
    });
    expect(fields).toContainEqual({ name: 'Files', value: '1', inline: true });
    expect(fields).toContainEqual({
      name: 'Missing required',
      value: '0',
      inline: true,
    });
    expect(payload.embeds[0]?.footer).toEqual({ text: 'task:task-123' });
  });

  it('applyVerdict is pure and covers submitted-dryrun', () => {
    const original = buildApprovalMessage(card);
    const updated = applyVerdict(original, 'submitted-dryrun');
    expect(updated.embeds[0]?.color).toBe(CARD_COLORS['submitted-dryrun']);
    expect(updated.embeds[0]?.description).toContain('dry run');
    // original untouched
    expect(original.embeds[0]?.color).toBe(CARD_COLORS.pending);
    expect(original.components[0]?.components[0]?.disabled).toBeUndefined();
  });

  it('buildOtpRequestMessage names the tenant and wires the otp: button', () => {
    const payload = buildOtpRequestMessage({
      taskId: 'task-123',
      platform: 'workday',
      company: 'Cadence',
      title: 'Software Intern',
      tenant: 'cadence',
    });
    expect(payload.embeds[0]?.description).toContain('cadence');
    expect(payload.embeds[0]?.footer).toEqual({ text: 'task:task-123' });
    expect(payload.components[0]?.components[0]).toMatchObject({
      label: 'Enter code',
      custom_id: 'otp:task-123',
    });
  });

  it('applyVerdict covers otp-received (recolors + disables the button)', () => {
    const original = buildOtpRequestMessage({
      taskId: 'task-123',
      platform: 'workday',
      company: 'Cadence',
      title: 'Software Intern',
      tenant: 'cadence',
    });
    const updated = applyVerdict(original, 'otp-received', 'task resumed');
    expect(updated.embeds[0]?.color).toBe(CARD_COLORS['otp-received']);
    expect(updated.embeds[0]?.description).toContain('Code received');
    expect(updated.components[0]?.components[0]?.disabled).toBe(true);
  });
});
