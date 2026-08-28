import { describe, expect, it, vi } from 'vitest';
import { runTick, type TickDeps } from './loop.js';
import type { OpenTabSession } from './opentab-client.js';
import type { FillPayload } from './sower-client.js';

/**
 * Tick ordering with stubbed effects: the empty-queue path touches
 * nothing, the happy path reports running (live-view viewport) then
 * ready, failures BEFORE/DURING the fill destroy the session and fail
 * the job, a ready-report failure AFTER the fill keeps the session
 * alive, and every outbound string (fail errors, report details) passes
 * through redactSecrets.
 */

const session: OpenTabSession = {
  id: 's_ab12cd',
  isolation: 'context',
  profile: 'default',
  headless: true,
  instanceId: 'i_default_headless',
  targetId: 'F0A1B2C3D4E5',
  browserContextId: 'CTX42',
  url: 'https://job-boards.greenhouse.io/acme/jobs/123',
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: null,
  urls: {
    cdp_ws: 'ws://127.0.0.1:9333/t/tok/s/s_ab12cd',
    browser_http: 'http://127.0.0.1:9333/t/tok/i/i_default_headless',
    browser_ws:
      'ws://127.0.0.1:9333/t/tok/i/i_default_headless/devtools/browser/uuid',
    devtools:
      'http://127.0.0.1:9333/t/tok/devtools-frontend/@abc/inspector.html?ws=127.0.0.1:9333/t/tok/s/s_ab12cd',
    live_view: 'http://127.0.0.1:9333/t/tok/view/s/s_ab12cd',
  },
};

const payload: FillPayload = {
  applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
  company: 'Acme',
  title: 'Software Engineer',
  questions: [],
};

const job = { id: 'j1', taskId: 't1' };

function makeDeps() {
  const deps = {
    sower: {
      claim: vi.fn<TickDeps['sower']['claim']>(async () => null),
      report: vi.fn<TickDeps['sower']['report']>(async () => {}),
      fail: vi.fn<TickDeps['sower']['fail']>(async () => {}),
      heartbeat: vi.fn<TickDeps['sower']['heartbeat']>(async () => {}),
    },
    opentab: {
      createSession: vi.fn<TickDeps['opentab']['createSession']>(
        async () => session,
      ),
      destroySession: vi.fn<TickDeps['opentab']['destroySession']>(
        async () => {},
      ),
    },
    fill: vi.fn<TickDeps['fill']>(async () => []),
    log: () => {},
    secrets: ['tok'],
  };
  return deps;
}

describe('runTick', () => {
  it('does nothing when the queue is empty', async () => {
    const deps = makeDeps();
    expect(await runTick(deps)).toBe(false);
    expect(deps.opentab.createSession).not.toHaveBeenCalled();
    expect(deps.sower.report).not.toHaveBeenCalled();
    expect(deps.sower.fail).not.toHaveBeenCalled();
  });

  it('opens a session, reports running with the live-view url, then ready', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    const report = [
      { questionId: 'q1', label: 'Full Name*', outcome: 'filled' as const },
    ];
    deps.fill.mockResolvedValueOnce(report);
    expect(await runTick(deps)).toBe(true);
    expect(deps.opentab.createSession).toHaveBeenCalledWith({
      isolation: 'context',
      headless: true,
      url: payload.applyUrl,
      ttl: 4 * 3600,
    });
    // The live-view URL is the feature — it is NOT redacted. It is the
    // viewport a human takes the tab over in, never the DevTools frontend.
    expect(deps.sower.report).toHaveBeenNthCalledWith(1, 'j1', {
      status: 'running',
      liveViewUrl: session.urls.live_view,
    });
    expect(deps.sower.report).toHaveBeenNthCalledWith(2, 'j1', {
      status: 'ready',
      report,
    });
    expect(deps.opentab.destroySession).not.toHaveBeenCalled();
    expect(deps.sower.fail).not.toHaveBeenCalled();
  });

  it('destroys the session and fails the job when the fill throws', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    deps.fill.mockRejectedValueOnce(new Error('cdp connection lost'));
    expect(await runTick(deps)).toBe(true);
    expect(deps.opentab.destroySession).toHaveBeenCalledWith(session.id);
    expect(deps.sower.fail).toHaveBeenCalledWith('j1', 'cdp connection lost');
  });

  it('destroys the session when the running report fails (before the fill)', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    deps.sower.report.mockRejectedValueOnce(new Error('api down'));
    expect(await runTick(deps)).toBe(true);
    expect(deps.fill).not.toHaveBeenCalled();
    expect(deps.opentab.destroySession).toHaveBeenCalledWith(session.id);
    expect(deps.sower.fail).toHaveBeenCalledWith('j1', 'api down');
  });

  it('keeps the session when the ready report fails after the fill', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    deps.fill.mockResolvedValueOnce([
      { questionId: 'q1', label: 'Full Name*', outcome: 'filled' },
    ]);
    deps.sower.report.mockImplementation(async (_jobId, body) => {
      if (body.status === 'ready') {
        throw new Error('report timed out at http://127.0.0.1:9333/t/tok/x');
      }
    });
    expect(await runTick(deps)).toBe(true);
    // The filled tab must survive a transient ready-report failure.
    expect(deps.opentab.destroySession).not.toHaveBeenCalled();
    expect(deps.sower.fail).toHaveBeenCalledWith(
      'j1',
      'fill completed but the ready report failed: report timed out at http://127.0.0.1:9333/t/[redacted]/x',
    );
  });

  it('redacts secrets from fail errors (playwright connectOverCDP shape)', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    deps.fill.mockRejectedValueOnce(
      new Error(
        'browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9333\n' +
          'Call log:\n' +
          '  - <ws preparing> retrieving websocket url from http://127.0.0.1:9333/t/tok/i/i_default_headless/json/version',
      ),
    );
    expect(await runTick(deps)).toBe(true);
    expect(deps.opentab.destroySession).toHaveBeenCalledWith(session.id);
    expect(deps.sower.fail).toHaveBeenCalledWith(
      'j1',
      expect.not.stringContaining('/t/tok'),
    );
    expect(deps.sower.fail).toHaveBeenCalledWith(
      'j1',
      expect.stringContaining('/t/[redacted]/i/i_default_headless'),
    );
  });

  it('redacts secrets from report details before the ready report', async () => {
    const deps = makeDeps();
    deps.sower.claim.mockResolvedValueOnce({ job, payload });
    deps.fill.mockResolvedValueOnce([
      {
        questionId: 'q1',
        label: 'School',
        outcome: 'failed',
        detail: 'timeout at http://127.0.0.1:9333/t/tok/s/s_ab12cd',
      },
    ]);
    expect(await runTick(deps)).toBe(true);
    expect(deps.sower.report).toHaveBeenNthCalledWith(2, 'j1', {
      status: 'ready',
      report: [
        {
          questionId: 'q1',
          label: 'School',
          outcome: 'failed',
          detail: 'timeout at http://127.0.0.1:9333/t/[redacted]/s/s_ab12cd',
        },
      ],
    });
  });
});
