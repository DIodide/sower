import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { investigateScreenshot } from './index.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const queryMock = vi.mocked(query);

function fakeStream(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) yield message;
  })() as ReturnType<typeof query>;
}

const FINAL_JSON = {
  found: true,
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  company: 'Acme',
  title: 'Software Engineer Intern',
  platform: 'greenhouse',
  confidence: 'high',
  notes: 'verified live posting via WebFetch',
};

const HAPPY_PATH_MESSAGES = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'The screenshot shows an Acme posting.' },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'WebSearch',
          input: { query: 'Acme Software Engineer Intern greenhouse' },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            {
              type: 'text',
              text: 'Result: https://boards.greenhouse.io/acme/jobs/123',
            },
          ],
        },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: `Found it.\n\`\`\`json\n${JSON.stringify(FINAL_JSON, null, 2)}\n\`\`\``,
        },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    result: `\`\`\`json\n${JSON.stringify(FINAL_JSON)}\n\`\`\``,
  },
];

describe('investigateScreenshot', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    queryMock.mockReset();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('throws a clear error when CLAUDE_CODE_OAUTH_TOKEN is missing', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await expect(
      investigateScreenshot({
        image: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('captures every assistant text, tool_use, and tool_result in the transcript and parses the final JSON', async () => {
    queryMock.mockReturnValue(fakeStream(HAPPY_PATH_MESSAGES));

    const outcome = await investigateScreenshot({
      image: Buffer.from('fake-png-bytes'),
      contentType: 'image/png',
      hint: 'company is Acme',
    });

    expect(outcome.result).toEqual(FINAL_JSON);

    const kinds = outcome.transcript.map((s) => s.kind);
    expect(kinds).toEqual([
      'system',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'result',
    ]);
    // seq is monotonically increasing from 0
    expect(outcome.transcript.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4, 5]);

    const toolUse = outcome.transcript.find((s) => s.kind === 'tool_use');
    expect(toolUse?.tool).toBe('WebSearch');
    expect(toolUse?.input).toEqual({
      query: 'Acme Software Engineer Intern greenhouse',
    });

    const toolResult = outcome.transcript.find((s) => s.kind === 'tool_result');
    expect(toolResult?.tool).toBe('WebSearch');
    expect(toolResult?.output).toContain(
      'https://boards.greenhouse.io/acme/jobs/123',
    );

    const firstText = outcome.transcript.find(
      (s) => s.kind === 'assistant_text',
    );
    expect(firstText?.text).toBe('The screenshot shows an Acme posting.');
  });

  it('sends the image as a base64 content block with the prompt (and hint)', async () => {
    queryMock.mockReturnValue(fakeStream(HAPPY_PATH_MESSAGES));
    const image = Buffer.from('fake-png-bytes');

    await investigateScreenshot({
      image,
      contentType: 'image/png',
      hint: 'company is Acme',
      maxTurns: 5,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<{
        type: string;
        parent_tool_use_id: string | null;
        message: { role: string; content: unknown[] };
      }>;
      options: Record<string, unknown>;
    };

    expect(call.options.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(call.options.allowedTools).toEqual([
      'WebSearch',
      'WebFetch',
      'ToolSearch',
    ]);
    expect(call.options.maxTurns).toBe(5);
    expect(call.options.permissionMode).toBe('dontAsk');
    expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();

    const yielded = [];
    for await (const m of call.prompt) yielded.push(m);
    expect(yielded).toHaveLength(1);
    const message = yielded[0];
    expect(message?.type).toBe('user');
    expect(message?.parent_tool_use_id).toBeNull();
    const content = message?.message.content as {
      type: string;
      text?: string;
      source?: { type: string; media_type: string; data: string };
    }[];
    const textBlock = content.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain('screenshot of a job posting');
    expect(textBlock?.text).toContain('Caller hint: company is Acme');
    const imageBlock = content.find((b) => b.type === 'image');
    expect(imageBlock?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: image.toString('base64'),
    });
  });

  it('starves the agent subprocess of secrets and restricts its tool set', async () => {
    // Simulate the Job process env: secrets that must NOT reach the agent.
    process.env.DATABASE_URL = 'postgres://user:pw@host:5432/sower';
    process.env.INGEST_API_KEY = 'super-secret-ingest-key';
    process.env.GCP_PROJECT = 'sower-production';
    try {
      queryMock.mockReturnValue(fakeStream(HAPPY_PATH_MESSAGES));
      await investigateScreenshot({
        image: Buffer.from('x'),
        contentType: 'image/png',
      });

      const call = queryMock.mock.calls[0]?.[0] as
        | { options: Record<string, unknown> }
        | undefined;
      const options = call?.options ?? {};

      // env is a minimal allowlist that REPLACES the subprocess env.
      const env = options.env as Record<string, string>;
      expect(env).toBeDefined();
      const allowlist = [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'PATH',
        'HOME',
        'CLAUDE_CONFIG_DIR',
      ];
      for (const key of Object.keys(env)) {
        expect(allowlist).toContain(key);
      }
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-token');
      expect(env).not.toHaveProperty('DATABASE_URL');
      expect(env).not.toHaveProperty('INGEST_API_KEY');
      expect(env).not.toHaveProperty('GCP_PROJECT');

      // Tool surface: only web research tools; shell/file/code tools denied.
      expect(options.tools).toEqual(['WebSearch', 'WebFetch']);
      expect(options.disallowedTools).toEqual(
        expect.arrayContaining([
          'Bash',
          'Read',
          'Write',
          'Edit',
          'NotebookEdit',
          'Task',
          'Agent',
          'Glob',
          'Grep',
        ]),
      );
      expect(options.permissionMode).toBe('dontAsk');
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.INGEST_API_KEY;
      delete process.env.GCP_PROJECT;
    }
  });

  it('records permission denials as system steps with tool and message', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          message: 'Bash is not allowed in this session.',
        },
        {
          type: 'result',
          subtype: 'success',
          result: `\`\`\`json\n${JSON.stringify(FINAL_JSON)}\n\`\`\``,
        },
      ]),
    );

    const outcome = await investigateScreenshot({
      image: Buffer.from('x'),
      contentType: 'image/png',
    });

    const denial = outcome.transcript.find(
      (s) => s.kind === 'system' && s.text === 'permission_denied',
    );
    expect(denial?.tool).toBe('Bash');
    expect(denial?.output).toBe('Bash is not allowed in this session.');
  });

  it('returns found:false with the full transcript when no valid JSON is produced', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I could not read the image.' }],
          },
        },
        { type: 'result', subtype: 'success', result: 'No JSON here, sorry.' },
      ]),
    );

    const outcome = await investigateScreenshot({
      image: Buffer.from('x'),
      contentType: 'image/png',
    });

    expect(outcome.result).toEqual({
      found: false,
      confidence: 'low',
      notes: 'could not parse agent output',
    });
    expect(outcome.transcript).toHaveLength(2);
    expect(outcome.transcript[0]?.kind).toBe('assistant_text');
    expect(outcome.transcript[0]?.text).toBe('I could not read the image.');
    expect(outcome.transcript[1]?.kind).toBe('result');
  });

  it('truncates long tool_result output to ~8000 chars', async () => {
    const longText = 'a'.repeat(20_000);
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_9',
                name: 'WebFetch',
                input: { url: 'https://example.com' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_9',
                content: longText,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: `\`\`\`json\n${JSON.stringify(FINAL_JSON)}\n\`\`\``,
        },
      ]),
    );

    const outcome = await investigateScreenshot({
      image: Buffer.from('x'),
      contentType: 'image/png',
    });

    const toolResult = outcome.transcript.find((s) => s.kind === 'tool_result');
    expect(toolResult?.tool).toBe('WebFetch');
    expect(toolResult?.output?.length).toBeLessThan(9000);
    expect(toolResult?.output).toContain('[truncated');
  });
});
