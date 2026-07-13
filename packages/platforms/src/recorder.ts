/**
 * API-call recording for platform adapters.
 *
 * SAFETY (rule 3): authorization / cookie / set-cookie / x-api-key header
 * values are redacted before a call record ever leaves this module, so
 * secrets can never end up in persisted api_calls rows. Recording is
 * best-effort: a failure to capture or persist a record must never break
 * (or alter) the underlying request — errors are logged via console.warn
 * and swallowed.
 */

export interface ApiCallRecord {
  phase: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  durationMs: number;
  dryRun?: boolean;
}

export type Recorder = (call: ApiCallRecord) => void | Promise<void>;

/** Bodies longer than this are cut off with a `{truncated: true}` marker. */
export const MAX_RECORDED_BODY_CHARS = 64 * 1024;

const REDACTED = '[REDACTED]';

const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

function headersInitEntries(headers: HeadersInit): [string, string][] {
  if (headers instanceof Headers) {
    return [...headers.entries()];
  }
  if (Array.isArray(headers)) {
    return headers.map(([key, value]) => [String(key), String(value)]);
  }
  return Object.entries(headers).map(([key, value]) => [key, String(value)]);
}

function redactEntries(
  entries: [string, string][],
): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const redacted: Record<string, string> = {};
  for (const [key, value] of entries) {
    redacted[key] = REDACTED_HEADER_NAMES.has(key.toLowerCase())
      ? REDACTED
      : value;
  }
  return redacted;
}

/** Parse a body as JSON when possible (fallback: raw text), capped at 64KB. */
function capBody(text: string): unknown {
  if (text.length > MAX_RECORDED_BODY_CHARS) {
    return {
      truncated: true,
      totalChars: text.length,
      preview: text.slice(0, MAX_RECORDED_BODY_CHARS),
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function captureRequestBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) {
    return undefined;
  }
  if (typeof body === 'string') {
    return capBody(body);
  }
  if (body instanceof URLSearchParams) {
    return capBody(body.toString());
  }
  // FormData / streams / binary buffers: note their presence without
  // attempting (possibly destructive) serialization.
  const name = body.constructor?.name ?? typeof body;
  return `[unrecorded ${name} body]`;
}

/** Invoke a recorder without ever letting its failure propagate. */
export async function safeRecord(
  recorder: Recorder | undefined,
  call: ApiCallRecord,
): Promise<void> {
  if (!recorder) {
    return;
  }
  try {
    await recorder(call);
  } catch (error) {
    console.warn('[sower] recorder failed (api call not recorded):', error);
  }
}

/**
 * fetch() wrapper that records the request/response through `recorder`.
 *
 * - Times the call and captures status, redacted headers, and JSON
 *   (fallback text) bodies capped at 64KB.
 * - Reads the body from a clone; the ORIGINAL Response is returned unread.
 * - Recording never throws: capture or recorder failures are logged with
 *   console.warn and the response is still returned (or the fetch error
 *   rethrown as-is).
 */
export async function recordedFetch(
  recorder: Recorder | undefined,
  phase: string,
  url: string,
  init?: RequestInit,
  /** Injectable fetch (defaults to global); lets clients pass a mock/proxy. */
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!recorder) {
    return fetchImpl(url, init);
  }

  const call: ApiCallRecord = {
    phase,
    method: (init?.method ?? 'GET').toUpperCase(),
    url,
    durationMs: 0,
  };
  try {
    if (init?.headers) {
      const requestHeaders = redactEntries(headersInitEntries(init.headers));
      if (requestHeaders) {
        call.requestHeaders = requestHeaders;
      }
    }
    const requestBody = captureRequestBody(init?.body);
    if (requestBody !== undefined) {
      call.requestBody = requestBody;
    }
  } catch (error) {
    console.warn('[sower] recordedFetch: request capture failed:', error);
  }

  const start = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // Record the failed attempt (no response fields), then rethrow untouched.
    call.durationMs = Math.round(performance.now() - start);
    await safeRecord(recorder, call);
    throw error;
  }
  call.durationMs = Math.round(performance.now() - start);

  try {
    if (typeof response.status === 'number') {
      call.responseStatus = response.status;
    }
    if (response.headers) {
      const responseHeaders = redactEntries([...response.headers.entries()]);
      if (responseHeaders) {
        call.responseHeaders = responseHeaders;
      }
    }
  } catch (error) {
    console.warn(
      '[sower] recordedFetch: response header capture failed:',
      error,
    );
  }
  try {
    const text = await response.clone().text();
    if (text.length > 0) {
      call.responseBody = capBody(text);
    }
  } catch (error) {
    console.warn('[sower] recordedFetch: response body capture failed:', error);
  }

  await safeRecord(recorder, call);
  return response;
}
