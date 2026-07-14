/**
 * Tier-2 screenshot investigation: a Claude Agent SDK wrapper that reads a
 * job-posting screenshot, identifies the posting (vision), and uses
 * WebSearch/WebFetch to locate the OFFICIAL application URL on the company's
 * ATS. Every step of the agent run (assistant text, tool calls with inputs,
 * tool results) is captured into a transcript — the observability record.
 *
 * Auth: the SDK's Claude Code subprocess authenticates via the
 * CLAUDE_CODE_OAUTH_TOKEN env var (a secret — never log it).
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

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

export interface TranscriptStep {
  seq: number;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'result' | 'system';
  /** WebSearch / WebFetch / ... */
  tool?: string;
  /** tool_use input (e.g. {query} or {url}). */
  input?: unknown;
  /** tool_result output, truncated to ~8000 chars. */
  output?: string;
  /** assistant reasoning text. */
  text?: string;
  ts: number;
}

export interface InvestigationOutcome {
  result: InvestigationResult;
  transcript: TranscriptStep[];
}

const DEFAULT_MAX_TURNS = 12;
const OUTPUT_TRUNCATE_CHARS = 8000;

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

function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_TRUNCATE_CHARS) return text;
  return `${text.slice(0, OUTPUT_TRUNCATE_CHARS)}… [truncated ${text.length - OUTPUT_TRUNCATE_CHARS} chars]`;
}

/** Render a tool_result content payload (string or content-block array) as text. */
function renderToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
          return JSON.stringify(block);
        }
        return String(block);
      })
      .join('\n');
  }
  return JSON.stringify(content) ?? '';
}

/**
 * Scan free text for top-level JSON objects (brace matching, string-aware)
 * and return each one that parses.
 */
function findJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            objects.push(JSON.parse(text.slice(i, j + 1)));
            i = j;
          } catch {
            // not valid JSON — keep scanning from the next '{'
          }
          break;
        }
      }
    }
  }
  return objects;
}

/**
 * Extract the final InvestigationResult from the agent's output text:
 * prefer the last fenced ```json block, fall back to the last parseable
 * JSON object anywhere in the text, validate with zod.
 */
function parseInvestigationResult(
  text: string,
): InvestigationResult | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
    (m) => m[1] ?? '',
  );
  // Candidates in priority order: fenced blocks (last first), then raw text.
  const candidates = [...fenced.reverse(), text];
  for (const candidate of candidates) {
    const objects = findJsonObjects(candidate);
    for (let i = objects.length - 1; i >= 0; i--) {
      const parsed = investigationResultSchema.safeParse(objects[i]);
      if (parsed.success) {
        const d = parsed.data;
        return {
          found: d.found,
          applyUrl: d.applyUrl ?? undefined,
          company: d.company ?? undefined,
          title: d.title ?? undefined,
          platform: d.platform ?? undefined,
          confidence: d.confidence,
          notes: d.notes,
        };
      }
    }
  }
  return undefined;
}

/** Minimal structural view of the content blocks the SDK stream yields. */
interface ContentBlockish {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

function contentBlocksOf(message: unknown): ContentBlockish[] {
  if (!message || typeof message !== 'object') return [];
  const inner = (message as { message?: { content?: unknown } }).message;
  const content = inner?.content;
  return Array.isArray(content) ? (content as ContentBlockish[]) : [];
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
      allowedTools: ['WebSearch', 'WebFetch'],
      maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      // Headless: never block on interactive permission prompts.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  const transcript: TranscriptStep[] = [];
  let seq = 0;
  // tool_use id -> tool name, so tool_result steps can name their tool.
  const toolNamesById = new Map<string, string>();
  const assistantTexts: string[] = [];
  let resultText: string | undefined;

  for await (const message of stream) {
    const ts = Date.now();
    if (message.type === 'assistant') {
      for (const block of contentBlocksOf(message)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          assistantTexts.push(block.text);
          transcript.push({
            seq: seq++,
            kind: 'assistant_text',
            text: block.text,
            ts,
          });
        } else if (block.type === 'tool_use') {
          const tool = typeof block.name === 'string' ? block.name : undefined;
          if (typeof block.id === 'string' && tool) {
            toolNamesById.set(block.id, tool);
          }
          transcript.push({
            seq: seq++,
            kind: 'tool_use',
            tool,
            input: block.input,
            ts,
          });
        }
      }
    } else if (message.type === 'user') {
      for (const block of contentBlocksOf(message)) {
        if (block.type === 'tool_result') {
          const tool =
            typeof block.tool_use_id === 'string'
              ? toolNamesById.get(block.tool_use_id)
              : undefined;
          transcript.push({
            seq: seq++,
            kind: 'tool_result',
            tool,
            output: truncateOutput(renderToolResultContent(block.content)),
            ts,
          });
        }
      }
    } else if (message.type === 'result') {
      const m = message as { subtype?: unknown; result?: unknown };
      if (typeof m.result === 'string') {
        resultText = m.result;
      }
      transcript.push({
        seq: seq++,
        kind: 'result',
        text: typeof m.subtype === 'string' ? m.subtype : undefined,
        output:
          typeof m.result === 'string' ? truncateOutput(m.result) : undefined,
        ts,
      });
    } else if (message.type === 'system') {
      const m = message as { subtype?: unknown };
      transcript.push({
        seq: seq++,
        kind: 'system',
        text: typeof m.subtype === 'string' ? m.subtype : undefined,
        ts,
      });
    }
  }

  // The final answer usually lands in the result message; fall back to
  // assistant text (latest first) if the result text doesn't parse.
  const sources = [
    ...(resultText ? [resultText] : []),
    ...assistantTexts.reverse(),
  ];
  for (const source of sources) {
    const result = parseInvestigationResult(source);
    if (result) return { result, transcript };
  }
  return { result: { ...PARSE_FAILURE_RESULT }, transcript };
}
