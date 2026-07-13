import type { WorkdaySession } from '@sower/platforms';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentApiClient,
  type AgentDeps,
  runAgentOnce,
  type SessionClaim,
} from './agent.js';

const SESSION: WorkdaySession = {
  host: 'caci.wd1.myworkdayjobs.com',
  tenant: 'caci',
  cookie: 'PLAY_SESSION=x; CALYPSO_SESSION=y; CALYPSO_CSRF_TOKEN=z',
  csrfToken: 'z',
};

const CLAIM: SessionClaim = {
  tenant: 'caci',
  host: 'caci.wd1.myworkdayjobs.com',
  loginUrl: 'https://caci.wd1.myworkdayjobs.com/external/job/x/SWE_1',
  email: 'ada@example.com',
  password: 'pw-1',
};

function fakeApi(over: Partial<AgentApiClient> = {}): AgentApiClient & {
  heartbeats: { name: string; detail?: string }[];
  completed: { tenant: string; session: WorkdaySession }[];
  failed: { tenant: string; error: string }[];
} {
  const heartbeats: { name: string; detail?: string }[] = [];
  const completed: { tenant: string; session: WorkdaySession }[] = [];
  const failed: { tenant: string; error: string }[] = [];
  return {
    heartbeats,
    completed,
    failed,
    claim: vi.fn(async () => null),
    complete: vi.fn(async (tenant, session) => {
      completed.push({ tenant, session });
      return { requeued: 1 };
    }),
    fail: vi.fn(async (tenant, error) => {
      failed.push({ tenant, error });
    }),
    heartbeat: vi.fn(async (name, detail) => {
      heartbeats.push({ name, detail });
    }),
    ...over,
  };
}

describe('runAgentOnce', () => {
  it('is idle and heartbeats when nothing is pending', async () => {
    const api = fakeApi({ claim: vi.fn(async () => null) });
    const deps: AgentDeps = {
      api,
      capture: vi.fn(async () => SESSION),
      agentName: 'home-agent',
    };

    const result = await runAgentOnce(deps);

    expect(result).toBe('idle');
    expect(deps.capture).not.toHaveBeenCalled();
    expect(api.heartbeats).toContainEqual({
      name: 'home-agent',
      detail: 'idle',
    });
  });

  it('captures a claimed request and reports it complete', async () => {
    const capture = vi.fn(async () => SESSION);
    const api = fakeApi({ claim: vi.fn(async () => CLAIM) });
    const result = await runAgentOnce({
      api,
      capture,
      agentName: 'home-agent',
    });

    expect(result).toBe('captured');
    expect(capture).toHaveBeenCalledWith(CLAIM);
    expect(api.completed).toEqual([{ tenant: 'caci', session: SESSION }]);
    expect(api.failed).toEqual([]);
    // Heartbeat reflects the active capture.
    expect(api.heartbeats).toContainEqual({
      name: 'home-agent',
      detail: 'capturing caci',
    });
  });

  it('reports a capture failure and never throws', async () => {
    const api = fakeApi({ claim: vi.fn(async () => CLAIM) });
    const capture = vi.fn(async () => {
      throw new Error('verify failed');
    });
    const result = await runAgentOnce({
      api,
      capture,
      agentName: 'home-agent',
    });

    expect(result).toBe('failed');
    expect(api.failed).toEqual([{ tenant: 'caci', error: 'verify failed' }]);
    expect(api.completed).toEqual([]);
  });
});
