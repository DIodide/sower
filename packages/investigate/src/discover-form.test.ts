import { query } from '@anthropic-ai/claude-agent-sdk';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobMetadata, RawExtraction } from './discover-form.js';
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

interface FakeFrameSpec {
  url: string;
  extraction?: RawExtraction;
}

const DEFAULT_METADATA: JobMetadata = {
  title: 'Software Engineer Intern',
  company: 'Example Co',
  descriptionMarkdown:
    '# Software Engineer Intern\n\nBuild things at Example Co.\n\n## Requirements\n\n- TypeScript\n- Grit',
  descriptionTruncated: false,
};

/**
 * A scripted Playwright double: `evaluate` answers the metadata expression
 * with `metadata`, click-fallback expressions with undefined, and extraction
 * expressions with the queued extractions in order; `goto` returns `statuses`
 * per call (default 200); each `click` advances the page URL to the next
 * entry in `urls`; `frames` become child frames alongside a main frame.
 */
function fakePlaywright(opts: {
  extractions: RawExtraction[];
  urls?: [string, ...string[]];
  gotoError?: Error;
  statuses?: number[];
  metadata?: JobMetadata | null;
  frames?: FakeFrameSpec[];
}) {
  const urls = opts.urls ?? ['https://jobs.example.com/posting/123'];
  let currentUrl = urls[0];
  let extractCall = 0;
  let clickCount = 0;
  let gotoCall = 0;
  const routeHandlers: RouteHandler[] = [];

  const mainFrame = { url: () => currentUrl };
  const childFrames = (opts.frames ?? []).map((spec) => ({
    url: () => spec.url,
    evaluate: vi.fn(async () => {
      if (spec.extraction === undefined) {
        throw new Error('no extraction scripted for this frame');
      }
      return spec.extraction;
    }),
  }));

  const page = {
    goto: vi.fn(async (url: string) => {
      const status = opts.statuses?.[gotoCall] ?? 200;
      gotoCall += 1;
      if (opts.gotoError) throw opts.gotoError;
      currentUrl = urls[0] ?? url;
      return { status: () => status };
    }),
    close: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    url: () => currentUrl,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, ...childFrames],
    evaluate: vi.fn(async (expr: string) => {
      if (typeof expr === 'string' && expr.includes('sower:metadata')) {
        return opts.metadata === undefined ? DEFAULT_METADATA : opts.metadata;
      }
      if (typeof expr === 'string' && expr.includes('.click()')) {
        return undefined;
      }
      const extraction =
        opts.extractions[Math.min(extractCall, opts.extractions.length - 1)];
      extractCall += 1;
      return extraction;
    }),
    click: vi.fn(async () => {
      clickCount += 1;
      const next = urls[Math.min(clickCount, urls.length - 1)];
      if (next) currentUrl = next;
    }),
  };

  const context = {
    route: vi.fn(async (_pattern: string, handler: RouteHandler) => {
      routeHandlers.push(handler);
    }),
    addInitScript: vi.fn(async (_script: { content: string }) => {}),
    newPage: vi.fn(async () => page),
    waitForEvent: vi.fn(async () => {
      throw new Error('no popup');
    }),
  };

  const browser = {
    newContext: vi.fn(async (_options: Record<string, unknown>) => context),
    version: () => '143.0.7204.97',
    close: vi.fn(async () => {}),
  };

  launchMock.mockResolvedValue(browser as never);
  return { browser, context, page, childFrames, routeHandlers };
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
    const { context, browser } = fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
    });
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

    // descriptionMarkdown comes PROGRAMMATICALLY from the details page —
    // never from the agent (the agent's JSON has no such field).
    expect(result.descriptionMarkdown).toBe(
      DEFAULT_METADATA.descriptionMarkdown,
    );

    // The context is hardened: real-Chrome UA (no HeadlessChrome), normal
    // viewport, locale, and a webdriver-masking init script.
    const contextOptions = browser.newContext.mock.calls[0]?.[0] as
      | {
          userAgent: string;
          viewport: { width: number; height: number };
          locale: string;
        }
      | undefined;
    expect(contextOptions?.userAgent).toContain('Chrome/143.0.0.0');
    expect(contextOptions?.userAgent).not.toContain('Headless');
    expect(contextOptions?.viewport).toEqual({ width: 1440, height: 900 });
    expect(contextOptions?.locale).toBe('en-US');
    const initScript = context.addInitScript.mock.calls[0]?.[0];
    expect(initScript?.content).toContain('webdriver');
    const launchOptions = launchMock.mock.calls[0]?.[0];
    expect(launchOptions?.args).toContain(
      '--disable-blink-features=AutomationControlled',
    );

    // Browser phase steps come first (navigate, metadata extract, form
    // extract), then the agent's steps; seq monotonic.
    const browserSteps = transcript.filter((s) =>
      s.tool?.startsWith('browser.'),
    );
    expect(browserSteps.map((s) => [s.kind, s.tool])).toEqual([
      ['tool_use', 'browser.navigate'],
      ['tool_result', 'browser.navigate'],
      ['tool_use', 'browser.extract'],
      ['tool_result', 'browser.extract'],
      ['tool_use', 'browser.extract'],
      ['tool_result', 'browser.extract'],
    ]);
    expect(browserSteps[0]?.input).toEqual({
      url: 'https://jobs.example.com/posting/123',
    });
    const metadataResult = transcript.find(
      (s) =>
        s.kind === 'tool_result' &&
        s.tool === 'browser.extract' &&
        s.output?.includes('chars of markdown'),
    );
    expect(metadataResult?.output).toMatch(
      /description: \d+ chars of markdown/,
    );
    const extractResult = transcript.find(
      (s) =>
        s.kind === 'tool_result' &&
        s.tool === 'browser.extract' &&
        s.output?.includes('form controls'),
    );
    expect(extractResult?.output).toContain('found 7 form controls');
    expect(transcript.at(-1)?.kind).toBe('result');
    expect(transcript.map((s) => s.seq)).toEqual(transcript.map((_, i) => i));

    // The interpretation agent is TEXT-ONLY and hardened, and sees a
    // description excerpt for context.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(call.prompt).toContain('RAW EXTRACTION');
    expect(call.prompt).toContain('First name');
    expect(call.prompt).toContain('Caller hint: software intern');
    expect(call.prompt).toContain('JOB DESCRIPTION EXCERPT');
    expect(call.prompt).toContain('# Software Engineer Intern');
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

  it('retries once on HTTP 403 and reports an honest "blocked" outcome (never "no form found", no agent)', async () => {
    const { page } = fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
      statuses: [403, 403],
    });

    const { result, transcript } = await discoverForm({
      url: 'https://www.example.com/careers/details/swe-intern/',
    });

    expect(result.formFound).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.notes).toMatch(
      /the site blocked automated access \(HTTP 403\)/,
    );
    expect(result.notes).not.toMatch(/no application form controls/);
    // Two navigation attempts, a delay between them, no extraction, no agent.
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(transcript.some((s) => s.tool === 'browser.extract')).toBe(false);
    expect(
      transcript.some(
        (s) => s.kind === 'system' && s.text === 'http_error_retry',
      ),
    ).toBe(true);
    const blockedStep = transcript.find(
      (s) => s.kind === 'system' && s.text === 'blocked_by_site',
    );
    expect(blockedStep?.output).toContain('HTTP 403');
    const navResults = transcript.filter(
      (s) => s.kind === 'tool_result' && s.tool === 'browser.navigate',
    );
    expect(navResults).toHaveLength(2);
    expect(navResults[0]?.output).toContain('HTTP 403');
    expect(navResults[1]?.output).toContain('HTTP 403');
  });

  it('recovers when the retry succeeds after an initial 403', async () => {
    const { page } = fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
      statuses: [403, 200],
    });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(result.formFound).toBe(true);
    expect(result.questions).toHaveLength(7);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(
      transcript.some(
        (s) => s.kind === 'system' && s.text === 'http_error_retry',
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (s) => s.kind === 'system' && s.text === 'blocked_by_site',
      ),
    ).toBe(false);
  });

  it('reports a non-bot HTTP failure with its status wording', async () => {
    fakePlaywright({
      extractions: [APPLICATION_EXTRACTION],
      statuses: [404, 404],
    });

    const { result } = await discoverForm({
      url: 'https://jobs.example.com/gone',
    });

    expect(result.formFound).toBe(false);
    expect(result.notes).toMatch(/returned HTTP 404/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns formFound:false with an explanatory note (and scraped metadata) when no form renders', async () => {
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
    // Metadata is still scraped and surfaced even without a form.
    expect(result.company).toBe('Example Co');
    expect(result.title).toBe('Software Engineer Intern');
    expect(result.descriptionMarkdown).toBe(
      DEFAULT_METADATA.descriptionMarkdown,
    );
    // The agent is never invoked when there is nothing to interpret.
    expect(queryMock).not.toHaveBeenCalled();
    // Two extract pairs: job-metadata + form controls.
    expect(transcript.filter((s) => s.tool === 'browser.extract')).toHaveLength(
      4,
    );
  });

  it('clicks an Apply control when the landing page has no form, then extracts the revealed form', async () => {
    const { page } = fakePlaywright({
      extractions: [
        { ...EMPTY_EXTRACTION, applyCandidate: 'Start Application' },
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
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(result.formFound).toBe(true);
    expect(result.applyUrl).toBe('https://jobs.example.com/posting/123/apply');
    expect(result.questions).toHaveLength(7);

    const clickStep = transcript.find(
      (s) => s.kind === 'tool_use' && s.tool === 'browser.click',
    );
    expect(clickStep?.input).toEqual({
      selector: '[data-sower-apply="1"]',
      text: 'Start Application',
    });
    const clickResult = transcript.find(
      (s) => s.kind === 'tool_result' && s.tool === 'browser.click',
    );
    expect(clickResult?.output).toContain(
      'https://jobs.example.com/posting/123/apply',
    );
  });

  it('follows up to two apply hops (details → interstitial → form)', async () => {
    const { page } = fakePlaywright({
      extractions: [
        { ...EMPTY_EXTRACTION, applyCandidate: 'Apply now' },
        { ...EMPTY_EXTRACTION, applyCandidate: 'Continue to application' },
        APPLICATION_EXTRACTION,
      ],
      urls: [
        'https://jobs.example.com/posting/123',
        'https://jobs.example.com/posting/123/interstitial',
        'https://jobs.example.com/posting/123/apply',
      ],
    });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(page.click).toHaveBeenCalledTimes(2);
    expect(result.formFound).toBe(true);
    expect(result.applyUrl).toBe('https://jobs.example.com/posting/123/apply');
    const clickSteps = transcript.filter(
      (s) => s.kind === 'tool_use' && s.tool === 'browser.click',
    );
    expect(clickSteps.map((s) => (s.input as { text: string }).text)).toEqual([
      'Apply now',
      'Continue to application',
    ]);
  });

  it('stops after two hops even when every page dangles another apply control', async () => {
    const { page } = fakePlaywright({
      extractions: [{ ...EMPTY_EXTRACTION, applyCandidate: 'Apply now' }],
    });

    const { result } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(page.click).toHaveBeenCalledTimes(2);
    expect(result.formFound).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('extracts inside a same-origin iframe when the top page has no form', async () => {
    const frameUrl = 'https://jobs.example.com/embed/apply-form';
    const { childFrames } = fakePlaywright({
      extractions: [{ ...EMPTY_EXTRACTION, iframeCount: 1 }],
      frames: [{ url: frameUrl, extraction: APPLICATION_EXTRACTION }],
    });
    queryMock.mockReturnValue(fakeStream(AGENT_MESSAGES));

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(childFrames[0]?.evaluate).toHaveBeenCalled();
    expect(result.formFound).toBe(true);
    expect(result.questions).toHaveLength(7);
    expect(result.notes).toContain('same-origin iframe');
    const frameExtract = transcript.find(
      (s) =>
        s.kind === 'tool_use' &&
        s.tool === 'browser.extract' &&
        (s.input as { target?: string }).target === 'same-origin iframe',
    );
    expect((frameExtract?.input as { url: string } | undefined)?.url).toBe(
      frameUrl,
    );
  });

  it('records a cross-origin ATS iframe (greenhouse) in notes and transcript instead of extracting it', async () => {
    const frameUrl = 'https://boards.greenhouse.io/embed/job_app?for=example';
    const { childFrames } = fakePlaywright({
      extractions: [{ ...EMPTY_EXTRACTION, iframeCount: 1 }],
      frames: [{ url: frameUrl }],
    });

    const { result, transcript } = await discoverForm({
      url: 'https://jobs.example.com/posting/123',
    });

    expect(childFrames[0]?.evaluate).not.toHaveBeenCalled();
    expect(result.formFound).toBe(false);
    expect(result.notes).toContain('supported ATS (greenhouse)');
    expect(result.notes).toContain(frameUrl);
    const iframeStep = transcript.find(
      (s) => s.kind === 'system' && s.text === 'cross_origin_iframe',
    );
    expect(iframeStep?.output).toContain(frameUrl);
    expect(iframeStep?.output).toContain('greenhouse');
    expect(queryMock).not.toHaveBeenCalled();
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
    // The programmatic metadata still comes through.
    expect(result.descriptionMarkdown).toBe(
      DEFAULT_METADATA.descriptionMarkdown,
    );
    // Browser steps AND agent steps are both present.
    expect(transcript.some((s) => s.tool === 'browser.extract')).toBe(true);
    expect(transcript.some((s) => s.kind === 'result')).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });
});
