/**
 * Local Workday capture agent (daemon). Run on your HOME machine (residential
 * IP) — it opens a real Chrome window whenever you click "Start session capture"
 * on the dashboard; you sign in there. It never submits; it only captures +
 * verifies sessions and hands them to the cloud api.
 *
 *   API_BASE_URL=https://sower-api-...run.app INGEST_API_KEY=... \
 *     pnpm --filter @sower/worker exec tsx scripts/agent.ts
 *
 * Optional env: SOWER_AGENT_NAME (default 'home-agent'),
 * SOWER_RESIDENTIAL_PROXY (http://user:pass@host:port), SOWER_AGENT_POLL_MS.
 * For always-on, install the launchd plist in workday-phase2-runbook.md.
 */
import { startAgent } from '../src/agent.js';

const baseUrl = process.env.API_BASE_URL;
const apiKey = process.env.INGEST_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('API_BASE_URL and INGEST_API_KEY are required');
  process.exit(1);
}

await startAgent({
  baseUrl,
  apiKey,
  agentName: process.env.SOWER_AGENT_NAME,
  proxyServer: process.env.SOWER_RESIDENTIAL_PROXY,
  pollIntervalMs: process.env.SOWER_AGENT_POLL_MS
    ? Number(process.env.SOWER_AGENT_POLL_MS)
    : undefined,
});
