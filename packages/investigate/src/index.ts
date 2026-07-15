/**
 * Tier-2 screenshot investigation: a Claude Agent SDK wrapper that reads a
 * job-posting screenshot, identifies the posting (vision), and uses
 * WebSearch/WebFetch to locate the OFFICIAL application URL on the company's
 * ATS. Every step of the agent run (assistant text, tool calls with inputs,
 * tool results) is captured into a transcript — the observability record.
 *
 * Auth: the SDK's Claude Code subprocess authenticates via the
 * CLAUDE_CODE_OAUTH_TOKEN env var (a secret — never log it).
 *
 * Security posture: the agent fetches arbitrary web pages, so every page is a
 * potential prompt-injection vector. Two containment layers:
 *   1. The subprocess env is a minimal allowlist (see agent-runner.ts) —
 *      DB/API/GCP secrets never reach the agent process.
 *   2. The tool surface is restricted to WebSearch/WebFetch via the SDK's
 *      `tools` base-set option, with shell/file/code built-ins additionally
 *      blocked through `disallowedTools` and `permissionMode: 'dontAsk'`
 *      (headless: never prompts, denies anything not pre-approved). Denials
 *      surface as 'permission_denied' system steps in the transcript.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  buildSubprocessEnv,
  consumeAgentStream,
  DENIED_TOOLS,
  parseAgentJson,
  type TranscriptStep,
} from './agent-runner.js';

export type { TranscriptStep } from './agent-runner.js';
export {
  type DiscoveredForm,
  discoverForm,
  type FormDiscoveryOutcome,
} from './discover-form.js';

export interface InvestigationResult {
  /** true ONLY if a real application URL was located. */
  found: boolean;
  applyUrl?: string;
  company?: string;
  title?: string;
  /** greenhouse | lever | ashby | workday | other (best guess). */
  platform?: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface InvestigationOutcome {
  result: InvestigationResult;
  transcript: TranscriptStep[];
}

const DEFAULT_MAX_TURNS = 12;

/** The only tools the investigation agent may use. */
const INVESTIGATION_TOOLS = ['WebSearch', 'WebFetch'];

const investigationResultSchema = z.object({
  found: z.boolean(),
  applyUrl: z.string().nullish(),
  company: z.string().nullish(),
  title: z.string().nullish(),
  platform: z.string().nullish(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string().catch(''),
});

const PARSE_FAILURE_RESULT: InvestigationResult = {
  found: false,
  confidence: 'low',
  notes: 'could not parse agent output',
};

function buildPrompt(hint?: string): string {
  const lines = [
    'You are looking at a screenshot of a job posting. Identify the company, role title, and ATS platform.',
    "Find the OFFICIAL application URL — if it isn't fully visible in the screenshot, use WebSearch/WebFetch to locate the live posting on the company's ATS (greenhouse/lever/ashby/workday).",
    'Do NOT fabricate a URL; set found=false if you cannot verify one.',
    'When done, output ONLY a fenced ```json code block matching this schema: {found, applyUrl, company, title, platform, confidence, notes} where found is a boolean, platform is one of greenhouse|lever|ashby|workday|other, and confidence is one of high|medium|low.',
  ];
  if (hint) {
    lines.push(`Caller hint: ${hint}`);
  }
  return lines.join('\n');
}

export async function investigateScreenshot(input: {
  image: Buffer;
  contentType: string;
  hint?: string;
  maxTurns?: number;
}): Promise<InvestigationOutcome> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set: screenshot investigation requires the Claude Code OAuth token in the environment',
    );
  }

  const prompt = buildPrompt(input.hint);
  const imageData = input.image.toString('base64');

  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              // Anthropic's ImageBlockParam narrows media_type to a literal
              // union; callers pass standard image MIME types.
              media_type: input.contentType as
                | 'image/png'
                | 'image/jpeg'
                | 'image/gif'
                | 'image/webp',
              data: imageData,
            },
          },
        ],
      },
    };
  }

  const stream = query({
    prompt: userMessages(),
    options: {
      // Base tool set: ONLY web research tools exist in the agent's context.
      // (allowedTools alone does not restrict — it only auto-approves.)
      tools: [...INVESTIGATION_TOOLS],
      // Defense in depth: remove shell/file/code tools even if the base set
      // ever changes shape.
      disallowedTools: [...DENIED_TOOLS],
      // Pre-approve the web tools (plus ToolSearch, the harness meta-tool
      // that loads deferred tools) so the headless run never needs a prompt.
      allowedTools: [...INVESTIGATION_TOOLS, 'ToolSearch'],
      // Headless: never prompt; auto-deny anything not pre-approved. Denials
      // arrive as 'permission_denied' system messages and are recorded in
      // the transcript.
      permissionMode: 'dontAsk',
      maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      // Minimal allowlisted environment — REPLACES process.env for the
      // subprocess, starving it of DB/API/GCP secrets.
      env: buildSubprocessEnv(),
    },
  });

  const transcript: TranscriptStep[] = [];
  const capture = await consumeAgentStream(stream, transcript);

  // The final answer usually lands in the result message; fall back to
  // assistant text (latest first) if the result text doesn't parse.
  const result = parseAgentJson(capture, (candidate) => {
    const parsed = investigationResultSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    const d = parsed.data;
    return {
      found: d.found,
      applyUrl: d.applyUrl ?? undefined,
      company: d.company ?? undefined,
      title: d.title ?? undefined,
      platform: d.platform ?? undefined,
      confidence: d.confidence,
      notes: d.notes,
    } satisfies InvestigationResult;
  });
  return { result: result ?? { ...PARSE_FAILURE_RESULT }, transcript };
}
