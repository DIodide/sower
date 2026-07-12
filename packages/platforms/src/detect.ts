import type { PlatformRef } from '@sower/core';

const GREENHOUSE_BOARD_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

const WORKDAY_HOST_PATTERN = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/;

const UNKNOWN: PlatformRef = {
  platform: 'unknown',
  tenant: null,
  externalId: null,
};

/**
 * Detect the ATS platform (and tenant/external job id when derivable) from a job URL.
 *
 * Recognized patterns:
 * - boards.greenhouse.io/{token}/jobs/{id} (and job-boards / eu variants) -> greenhouse
 * - boards.greenhouse.io/embed/job_app?for={tenant}&token={id} (and variants) -> greenhouse
 * - any URL with a gh_jid query param -> greenhouse (tenant unknown)
 * - jobs.lever.co/{tenant}/{id} -> lever
 * - jobs.ashbyhq.com/{tenant}/{id} -> ashby
 * - {tenant}.wd{N}.myworkdayjobs.com -> workday (external id not derivable from URL)
 */
export function detectPlatform(url: string): PlatformRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...UNKNOWN };
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0);

  // Greenhouse-hosted boards: {token}/jobs/{id}
  if (GREENHOUSE_BOARD_HOSTS.has(host)) {
    const tenant = segments[0];
    const externalId = segments[2];
    if (tenant && segments[1] === 'jobs' && externalId) {
      return { platform: 'greenhouse', tenant, externalId };
    }

    // Greenhouse embed iframe: /embed/job_app?for={tenant}&token={id}
    if (segments[0] === 'embed' && segments[1] === 'job_app') {
      const embedTenant = parsed.searchParams.get('for');
      const embedId = parsed.searchParams.get('token');
      if (embedTenant && embedId) {
        return {
          platform: 'greenhouse',
          tenant: embedTenant,
          externalId: embedId,
        };
      }
    }
  }

  // Greenhouse embedded on a company site: ?gh_jid={id}
  const ghJid = parsed.searchParams.get('gh_jid');
  if (ghJid) {
    return { platform: 'greenhouse', tenant: null, externalId: ghJid };
  }

  // Lever: jobs.lever.co/{tenant}/{id}
  if (host === 'jobs.lever.co') {
    const tenant = segments[0];
    const externalId = segments[1];
    if (tenant && externalId) {
      return { platform: 'lever', tenant, externalId };
    }
  }

  // Ashby: jobs.ashbyhq.com/{tenant}/{id}
  if (host === 'jobs.ashbyhq.com') {
    const tenant = segments[0];
    const externalId = segments[1];
    if (tenant && externalId) {
      return { platform: 'ashby', tenant, externalId };
    }
  }

  // Workday: {tenant}.wd{N}.myworkdayjobs.com — job id is not reliably in the URL.
  const workdayMatch = host.match(WORKDAY_HOST_PATTERN);
  if (workdayMatch?.[1]) {
    return { platform: 'workday', tenant: workdayMatch[1], externalId: null };
  }

  return { ...UNKNOWN };
}
