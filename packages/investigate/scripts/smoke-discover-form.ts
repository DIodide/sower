/**
 * Smoke test for discoverForm against a LIVE unsupported job posting.
 *
 * Usage:
 *   export CLAUDE_CODE_OAUTH_TOKEN="$(gcloud secrets versions access latest \
 *     --secret=claude-code-oauth-token --project=sower-production)"
 *   unset ANTHROPIC_API_KEY
 *   pnpm --filter @sower/investigate exec tsx scripts/smoke-discover-form.ts <job-url>
 */
import { discoverForm } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: tsx scripts/smoke-discover-form.ts <job-url> [hint]');
  process.exit(1);
}

const started = Date.now();
const { result, transcript } = await discoverForm({
  url,
  hint: process.argv[3],
});

console.log('=== DiscoveredForm ===');
console.log(JSON.stringify(result, null, 2));

console.log('\n=== Transcript summary ===');
for (const step of transcript) {
  const head = `${String(step.seq).padStart(2)}. [${step.kind}${step.tool ? `:${step.tool}` : ''}]`;
  const input =
    step.input !== undefined
      ? ` in=${JSON.stringify(step.input).slice(0, 200)}`
      : '';
  const text = step.text
    ? ` text=${step.text.replace(/\s+/g, ' ').slice(0, 200)}`
    : '';
  const output = step.output
    ? ` out=${step.output.replace(/\s+/g, ' ').slice(0, 260)}`
    : '';
  console.log(`${head}${text}${input}${output}`);
}
console.log(
  `\n(${transcript.length} steps, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
);
