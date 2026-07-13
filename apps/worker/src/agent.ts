import { CalypsoClient, type WorkdaySession } from '@sower/platforms';
import { SessionBroker } from './workday/session-broker.js';
import { createStealthBrowserLogin } from './workday/stealth-login.js';

/**
 * The local capture agent — the one piece that MUST run on your machine.
 *
 * The dashboard (cloud) can't open a browser you can see, so Workday's headful,
 * human-in-the-loop session capture runs here. The agent polls the cloud api for
 * a pending capture request, opens a real Chrome window (you solve the captcha +
 * sign in / create the account + email OTP, live), captures the session,
 * VERIFIES it from this machine's residential IP, and reports it back so the api
 * vaults it and re-enqueues the tenant's parked tasks.
 *
 * Footprint is deliberately tiny: it talks ONLY to the api (HTTPS + x-api-key) —
 * no DB, no GCS. The core cycle (`runAgentOnce`) is injectable so it unit-tests
 * without a browser or a network.
 */

export interface SessionClaim {
  tenant: string;
  host: string;
  loginUrl: string;
  email: string;
  password: string;
}

export interface AgentApiClient {
  /** Claim one pending capture request, or null when none is pending. */
  claim(): Promise<SessionClaim | null>;
  complete(
    tenant: string,
    session: WorkdaySession,
  ): Promise<{ requeued: number }>;
  fail(tenant: string, error: string): Promise<void>;
  heartbeat(name: string, detail?: string): Promise<void>;
}

export interface AgentDeps {
  api: AgentApiClient;
  /** Capture a session for a claim (default: headful browser via SessionBroker). */
  capture: (claim: SessionClaim) => Promise<WorkdaySession>;
  agentName: string;
  log?: (message: string) => void;
}

/**
 * One poll cycle: heartbeat, claim, and (if claimed) capture → report. Returns
 * what happened so the loop + tests can react. Never throws — a claim/capture
 * failure is reported to the api and swallowed.
 */
export async function runAgentOnce(
  deps: AgentDeps,
): Promise<'idle' | 'captured' | 'failed'> {
  const { api, capture, agentName, log = () => {} } = deps;
  await api.heartbeat(agentName, 'idle').catch(() => {});

  const claim = await api.claim();
  if (!claim) {
    return 'idle';
  }

  log(
    `capturing session for ${claim.tenant} — a browser window will open; sign in there`,
  );
  await api.heartbeat(agentName, `capturing ${claim.tenant}`).catch(() => {});
  try {
    const session = await capture(claim);
    const { requeued } = await api.complete(claim.tenant, session);
    log(
      `session for ${claim.tenant} captured + verified; re-enqueued ${requeued} task(s)`,
    );
    return 'captured';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api.fail(claim.tenant, message).catch(() => {});
    log(`capture failed for ${claim.tenant}: ${message}`);
    return 'failed';
  }
}

/**
 * Default capture: drive the headful `SessionBroker`. The browser opens; the
 * human completes login live. The session is VERIFIED here (home IP) and NOT
 * stored locally — the api vaults it via `/complete`.
 */
export function createBrowserCapture(
  opts: { proxyServer?: string } = {},
): (claim: SessionClaim) => Promise<WorkdaySession> {
  return (claim) => {
    const broker = new SessionBroker({
      login: createStealthBrowserLogin({}),
      // No local vault write — the api stores the verified session on /complete.
      storeSession: async () => {},
      // Verify from THIS machine's residential IP — the whole reason we're local.
      verify: (session) => new CalypsoClient(session).checkSession(),
    });
    return broker.capture({
      host: claim.host,
      tenant: claim.tenant,
      loginUrl: claim.loginUrl,
      credential: { email: claim.email, password: claim.password },
      proxyServer: opts.proxyServer,
    });
  };
}

/** HTTP api client (x-api-key), talking to the cloud api. */
export function createAgentApiClient(
  baseUrl: string,
  apiKey: string,
): AgentApiClient {
  const base = baseUrl.replace(/\/$/, '');
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`api ${path} responded ${res.status}`);
    }
    return res.json();
  };
  return {
    async claim() {
      const r = (await post('/sessions/claim')) as
        | { empty: true }
        | SessionClaim;
      return 'empty' in r ? null : r;
    },
    async complete(tenant, session) {
      return (await post(
        `/sessions/${encodeURIComponent(tenant)}/complete`,
        session,
      )) as { requeued: number };
    },
    async fail(tenant, error) {
      await post(`/sessions/${encodeURIComponent(tenant)}/fail`, { error });
    },
    async heartbeat(name, detail) {
      await post('/sessions/heartbeat', { name, detail });
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  agentName?: string;
  proxyServer?: string;
  pollIntervalMs?: number;
}

/** The long-lived daemon loop (launchd runs this). */
export async function startAgent(config: AgentConfig): Promise<void> {
  const agentName = config.agentName ?? 'home-agent';
  const pollIntervalMs = config.pollIntervalMs ?? 10_000;
  const deps: AgentDeps = {
    api: createAgentApiClient(config.baseUrl, config.apiKey),
    capture: createBrowserCapture({ proxyServer: config.proxyServer }),
    agentName,
    log: (message) => console.log(`[agent] ${message}`),
  };
  console.log(
    `[agent] ${agentName} polling ${config.baseUrl} every ${pollIntervalMs}ms`,
  );
  for (;;) {
    try {
      await runAgentOnce(deps);
    } catch (error) {
      console.warn('[agent] loop error:', error);
    }
    await sleep(pollIntervalMs);
  }
}
