/**
 * OIDC identity tokens for calling IAM-gated Cloud Run services, minted by
 * the GCE metadata server (present on Cloud Run — no key material involved).
 * Tokens are audience-scoped and live 60 minutes; the per-audience cache
 * refreshes at 50 so a token is never presented near expiry. Off-GCP there
 * is no metadata server: the fetch fails and the error propagates — callers
 * own the fallout (the compile-preview route turns it into a 502).
 */

const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

const TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  token: string;
  fetchedAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test hook: the module-level cache would otherwise leak between tests. */
export function resetIdTokenCache(): void {
  tokenCache.clear();
}

export async function fetchIdToken(
  audience: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const cached = tokenCache.get(audience);
  if (cached !== undefined && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.token;
  }
  const response = await fetchFn(
    `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`,
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(
      `metadata identity request failed: HTTP ${response.status}`,
    );
  }
  const token = (await response.text()).trim();
  tokenCache.set(audience, { token, fetchedAt: Date.now() });
  return token;
}
