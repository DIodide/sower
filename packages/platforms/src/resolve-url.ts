const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const APPLICATION_URL_PATTERN = /"applicationUrl"\s*:\s*"([^"]+)"/;
const APPLY_URL_PATTERN = /"applyUrl"\s*:\s*"([^"]+)"/;

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function isSimplifyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'simplify.jobs' || host.endsWith('.simplify.jobs');
}

/**
 * Follow redirects to the final URL for a job link. On any network error the
 * input is returned unchanged. If the redirect chain lands on simplify.jobs,
 * the page body is scanned for the underlying ATS application URL.
 */
export async function resolveUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': USER_AGENT },
    });
    const finalUrl = response.url || url;

    if (isSimplifyHost(new URL(finalUrl).hostname)) {
      const body = await response.text();
      const match =
        APPLICATION_URL_PATTERN.exec(body) ?? APPLY_URL_PATTERN.exec(body);
      if (match?.[1]) {
        return unescapeJsonString(match[1]);
      }
    }

    return finalUrl;
  } catch {
    return url;
  }
}
