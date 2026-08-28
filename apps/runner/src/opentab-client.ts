/**
 * Client for the OpenTab serve api (localhost REST over the user's Chrome).
 * Shapes are copied from OpenTab's src/types.ts — CreateSessionRequest and
 * SessionResponse (SessionInfo + urls) — so the runner parses the real
 * field names. Auth is the serve token as a bearer header.
 */

export type OpenTabIsolation = 'shared' | 'context' | 'profile' | 'attached';

export interface OpenTabCreateSessionRequest {
  isolation?: OpenTabIsolation;
  profile?: string;
  headless?: boolean;
  url?: string;
  /** Seconds; 0/undefined = no expiry. */
  ttl?: number;
}

export interface OpenTabSessionUrls {
  /** Per-tab CDP websocket: hand to an agent that drives one tab. */
  cdp_ws: string;
  /** Instance-level HTTP base ("/json/version" etc.) — the connectOverCDP endpoint. */
  browser_http: string;
  /** Instance-level browser websocket (whole-browser control). */
  browser_ws: string;
  /** Hosted DevTools frontend aimed at this tab — open in a browser. */
  devtools: string;
  /**
   * OpenTab's human-control viewport for this tab. Optional: a serve
   * process started before this field was advertised omits it while still
   * routing the URL, so read it through liveViewUrl().
   */
  live_view?: string;
}

export interface OpenTabSession {
  id: string;
  isolation: OpenTabIsolation;
  profile: string;
  headless: boolean;
  instanceId: string;
  targetId: string;
  browserContextId: string | null;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  urls: OpenTabSessionUrls;
}

/**
 * The link a human opens to take the tab over. OpenTab serves a viewport
 * built for that at /t/<token>/view/s/<id>, which is what belongs in the
 * dashboard; the hosted DevTools frontend is an inspector that happens to
 * screencast. When a serve process is old enough not to advertise the
 * field, derive it from browser_http (".../t/<token>/i/<instanceId>"),
 * whose token base is the same, and fall back to DevTools only if even
 * that shape is unfamiliar.
 */
export function liveViewUrl(session: OpenTabSession): string {
  const advertised = session.urls.live_view;
  if (advertised !== undefined && advertised !== '') {
    return advertised;
  }
  const derived = session.urls.browser_http.replace(
    /\/i\/[^/]+\/?$/,
    `/view/s/${session.id}`,
  );
  return derived === session.urls.browser_http
    ? session.urls.devtools
    : derived;
}

export interface OpenTabClient {
  createSession(request: OpenTabCreateSessionRequest): Promise<OpenTabSession>;
  destroySession(id: string): Promise<void>;
}

export interface OpenTabClientDeps {
  base: string;
  token: string;
  fetch: typeof fetch;
}

async function call(
  deps: OpenTabClientDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await deps.fetch(`${deps.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${deps.token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body: the status alone names the failure.
  }
  if (!response.ok) {
    const message =
      data !== null &&
      typeof data === 'object' &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(`opentab ${method} ${path}: ${message}`);
  }
  return data;
}

export function makeOpenTabClient(deps: OpenTabClientDeps): OpenTabClient {
  return {
    async createSession(request) {
      const data = await call(deps, 'POST', '/api/sessions', request);
      return data as OpenTabSession;
    },
    async destroySession(id) {
      await call(deps, 'DELETE', `/api/sessions/${id}`);
    },
  };
}
