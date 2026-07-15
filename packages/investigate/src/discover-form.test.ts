import { query } from '@anthropic-ai/claude-agent-sdk';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawExtraction } from './discover-form.js';
import { discoverForm } from './index.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
}));

const queryMock = vi.mocked(query);
const launchMock = vi.mocked(chromium.launch);

function fakeStream(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) yield message;
  })() as ReturnType<typeof query>;
}

interface FakeRoute {
  request(): { url(): string };
  abort: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
}

type RouteHandler = (route: FakeRoute) => Promise<void>;

/**
 * A scripted Playwright double: `evaluate` returns the queued extractions in
 * order; `click` advances the page URL to `urls[1]` when present.
 */
function fakePlaywright(opts: {
  extractions: RawExtraction[];
  urls?: [string, ...string[]];
  gotoError?: Error;
}) {
  const urls = opts.urls ?? ['https://jobs.example.com/posting/123'];
  let currentUrl = urls[0];
  let extractCall = 0;
  const routeHandlers: RouteHandler[] = [];

  const page = {
    goto: vi.fn(async (url: string) => {
      if (opts.gotoError) throw opts.gotoError;
      currentUrl = urls[0] ?? url;
      return { status: () => 200 };
    }),
    waitForLoadState: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    url: () => currentUrl,
    evaluate: vi.fn(async () => {
      const extraction =
        opts.extractions[Math.min(extractCall, opts.extractions.length - 1)];
      extractCall += 1;
      return extraction;
    }),
    click: vi.fn(async () => {
      if (urls[1]) currentUrl = urls[1];
    }),
  };

  const context = {
    route: vi.fn(async (_pattern: string, handler: RouteHandler) => {
      routeHandlers.push(handler);
    }),
    newPage: vi.fn(async () => page),
    waitForEvent: vi.fn(async () => {
      throw new Error('no popup');
    }),
  };

  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  };

  launchMock.mockResolvedValue(browser as never);
  return { browser, context, page, routeHandlers };
}

const APPLICATION_EXTRACTION: RawExtraction = {
  controls: [
    {
      label: 'First name *',
      name: 'firstName',
      inputType: 'text',
      required: true,
    },
    {
      label: 'Last name *',
      name: 'lastName',
      inputType: 'text',
      required: true,
    },
    { label: 'Email *', name: 'email', inputType: 'email', required: true },
    { label: 'Phone', name: 'phone', inputType: 'tel', required: false },
    { label: 'Resume/CV *', name: 'resume', inputType: 'file', required: true },
    {
      label: 'Cover letter',
      name: 'coverLetter',
      inputType: 'textarea',
      required: false,
    },
    {
      label: 'Are you authorized to work in the US?',
      name: 'workAuth',
      inputType: 'radio',
      required: true,
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    },
  ],
  formCount: 1,
  iframeCount: 0,
  looksLikeApplicationForm: true,
  applyCandidate: null,
  hasPasswordField: false,
  hasCaptcha: false,
  headingText: 'Example Co | Software Engineer Intern',
  pageTitle: 'Software Engineer Intern - Example Co',
  pageText: 'Example Co is hiring a Software Engineer Intern in NYC.',
};

const EMPTY_EXTRACTION: RawExtraction = {
  controls: [],
  formCount: 0,
  iframeCount: 0,
  looksLikeApplicationForm: false,
  applyCandidate: null,
  hasPasswordField: false,
  hasCaptcha: false,
  headingText: 'Example Co Careers',
  pageTitle: 'Careers - Example Co',
  pageText: 'Join our team.',
};

const INTERPRETED = {
  formFound: true,
  company: 'Example Co',
  title: 'Software Engineer Intern',
  questions: [
    { id: 'first_name', label: 'First name', type: 'text', required: true },
    { id: 'last_name', label: 'Last name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'text', required: true },
    { id: 'phone', label: 'Phone', type: 'text', required: false },
    { id: 'resume', label: 'Resume/CV', type: 'file', required: true },
    {
      id: 'cover_letter',
      label: 'Cover letter',
      type: 'textarea',
      required: false,
    },
    {
      id: 'work_authorization',
      label: 'Are you authorized to work in the US?',
      type: 'select',
      required: true,
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    },
  ],
  confidence: 'high',
  notes: 'mapped 7 extracted controls',
};

const AGENT_MESSAGES = [
  {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Normalizing the extracted controls.' }],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    result: `\`\`\`json\n${JSON.stringify(INTERPRETED)}\n\`\`\``,
  },
];

describe('discoverForm', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    queryMock.mockReset();
    launchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('throws a clear error when CLAUDE_CODE_OAUTH_TOKEN is missing', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await expect(
      discoverForm({ url: 'https://jobs.example.com/posting/123' }),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('extracts a form and has the agent interpret it into Question[]', async () => {
    fakePlaywright({ extractions: [APPLICATION_EXTRACTION] });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
      hint: 'software intern',
    });

    expect(result.formFound).toBe(true);
    expect(result.applyUrl).toBe('https://jobs.example.com/posting/123');
    expect(result.company).toBe('Example Co');
    expect(result.title).toBe('Software Engineer Intern');
    expect(result.confidence).toBe('high');
    expect(result.questions).toHaveLength(7);
    expect(result.questions[0]).toEqual({
      id: 'first_name',
      label: 'First name',
      type: 'text',
      required: true,
    });
    const workAuth = result.questions.find(
      (q) => q.id === 'work_authorization',
    );
    expect(workAuth?.type).toBe('select');
    expect(workAuth?.options).toEqual([
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ]);

    // Browser phase steps come first, then the agent's steps; seq monotonic.
    const browserSteps = transcript.filter((s) =>
      s.tool?.startsWith('browser.'),
    );
    expect(browserSteps.map((s) => [s.kind, s.tool])).toEqual([
      ['tool_use', 'browser.navigate'],
      ['tool_result', 'browser.navigate'],
      ['tool_use', 'browser.extract'],
      ['tool_result', 'browser.extract'],
    ]);
    expect(browserSteps[0]?.input).toEqual({
      url: 'https://jobs.example.com/posting/123',
    });
    const extractResult = transcript.find(
      (s) => s.kind === 'tool_result' && s.tool === 'browser.extract',
    );
    expect(extractResult?.output).toContain('found 7 form controls');
    expect(transcript.at(-1)?.kind).toBe('result');
    expect(transcript.map((s) => s.seq)).toEqual(transcript.map((_, i) => i));

    // The interpretation agent is TEXT-ONLY and hardened.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(call.prompt).toContain('RAW EXTRACTION');
    expect(call.prompt).toContain('First name');
    expect(call.prompt).toContain('Caller hint: software intern');
    expect(call.options.tools).toEqual([]);
    expect(call.options.permissionMode).toBe('dontAsk');
    expect(call.options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'WebSearch',
        'WebFetch',
      ]),
    );
    const env = call.options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-token');
    for (const key of Object.keys(env)) {
      expect([
        'CLAUDE_CODE_OAUTH_TOKEN',
        'PATH',
        'HOME',
        'CLAUDE_CONFIG_DIR',
      ]).toContain(key);
    }
  });

  it('refuses SSRF-risky URLs without launching a browser or agent', async () => {
    for (const url of [
      'http://169.254.169.254/computeMetadata/v1/',
      'http://localhost:8080/admin',
      'https://vault.internal/secrets',
      'http://10.0.0.5/',
      'file:///etc/passwd',
    ]) {
      const { result, transcript } = await discoverForm({ url });
      expect(result.formFound).toBe(false);
      expect(result.confidence).toBe('low');
      expect(result.notes).toMatch(/refused to fetch url/);
      expect(transcript).toHaveLength(1);
      expect(transcript[0]?.kind).toBe('system');
      expect(transcript[0]?.text).toBe('ssrf_refused');
    }
    expect(launchMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('installs a route interceptor that aborts private/internal hosts', async () => {
    const { routeHandlers } = fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
    });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    await discoverForm({ url: 'https://jobs.example.com/posting/123' });

    expect(routeHandlers).toHaveLength(1);
    const handler = routeHandlers[0];
    if (!handler) throw new Error('route handler not captured');

    for (const blocked of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/xhr',
      'http://192.168.0.1/asset.js',
      'https://internal.corp.local/style.css',
      'http://localhost:9090/api',
    ]) {
      const route: FakeRoute = {
        request: () => ({ url: () => blocked }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(route);
      expect(route.abort).toHaveBeenCalledTimes(1);
      expect(route.continue).not.toHaveBeenCalled();
    }
  });

  it('returns formFound:false with an explanatory note (and transcript) when no form renders', async () => {
    fakePlaywright({ extractions: [EMPTY_EXTRACTION] });

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(result.formFound).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.applyUrl).toBe('https://jobs.example.com/posting/123');
    expect(result.questions).toEqual([]);
    expect(result.notes).toMatch(/no application form controls found/);
    expect(result.notes).toMatch(/JS-rendered/);
    // The agent is never invoked when there is nothing to interpret.
    expect(queryMock).not.toHaveBeenCalled();
    expect(transcript.filter((s) => s.tool === 'browser.extract')).toHaveLength(
      2,
    );
  });

  it('clicks an Apply control when the landing page has no form, then extracts the revealed form', async () => {
    const { page } = fakePlaywright({
      extractions: [
        { ...EMPTY_EXTRACTION, applyCandidate: 'Apply now' },
        APPLICATION_EXTRACTION,
      ],
      urls: [
        'https://jobs.example.com/posting/123',
        'https://jobs.example.com/posting/123/apply',
      ],
    });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(page.click).toHaveBeenCalledWith('[data-sower-apply="1"]', {
      timeout: expect.any(Number),
    });
    expect(result.formFound).toBe(true);
    expect(result.applyUrl).toBe('https://jobs.example.com/posting/123/apply');
    expect(result.questions).toHaveLength(7);

    const clickStep = transcript.find(
      (s) => s.kind === 'tool_use' && s.tool === 'browser.click',
    );
    expect(clickStep?.input).toEqual({
      selector: '[data-sower-apply="1"]',
      text: 'Apply now',
    });
    const clickResult = transcript.find(
      (s) => s.kind === 'tool_result' && s.tool === 'browser.click',
    );
    expect(clickResult?.output).toContain(
      'https://jobs.example.com/posting/123/apply',
    );
  });

  it('returns formFound:false when navigation fails (never throws)', async () => {
    fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
      gotoError: new Error(
        'net::ERR_NAME_NOT_RESOLVED at https://gone.example',
      ),
    });

    const { result, transcript } = await discoverForm({
      url: 'https://gone.example/job',
    });

    expect(result.formFound).toBe(false);
    expect(result.notes).toMatch(/could not load page/);
    expect(queryMock).not.toHaveBeenCalled();
    const navResult = transcript.find(
      (s) => s.kind === 'tool_result' && s.tool === 'browser.navigate',
    );
    expect(navResult?.output).toContain('navigation failed');
  });

  it('returns formFound:false + confidence:low with the transcript when the agent output does not parse', async () => {
    const { browser } = fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
    });
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'here you go' }] },
        },
        { type: 'result', subtype: 'success', result: 'not json at all' },
      ]),
    );

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(result.formFound).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.notes).toBe('could not parse agent output');
    expect(result.questions).toEqual([]);
    // Browser steps AND agent steps are both present.
    expect(transcript.some((s) => s.tool === 'browser.extract')).toBe(true);
    expect(transcript.some((s) => s.kind === 'result')).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });
});
