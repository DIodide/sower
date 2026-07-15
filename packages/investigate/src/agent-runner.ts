/**
 * Shared plumbing for hardened Claude Agent SDK runs, used by both
 * investigateScreenshot and discoverForm:
 *   - the minimal subprocess env allowlist (secrets never reach the agent),
 *   - the denied-tool list (shell/file/code built-ins removed outright),
 *   - transcript capture from the SDK message stream (the observability
 *     record: every assistant text, tool call, tool result, and denial),
 *   - JSON extraction from agent output text (fenced block first, brace
 *     matching fallback).
 */

export interface TranscriptStep {
  seq: number;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'result' | 'system';
  /** WebSearch / browser.navigate / ... (on 'system' steps: the denied tool). */
  tool?: string;
  /** tool_use input (e.g. {query} or {url}). */
  input?: unknown;
  /**
   * tool_result output (or, on 'permission_denied' system steps, the
   * denial message), truncated to ~8000 chars.
   */
  output?: string;
  /** assistant reasoning text. */
  text?: string;
  ts: number;
}

const OUTPUT_TRUNCATE_CHARS = 8000;

/**
 * Shell/file/code built-ins removed from the agent's context entirely
 * (defense in depth on top of a restricted `tools` base set: a bare name
 * in `disallowedTools` removes the tool and blocks harness-internal calls
 * in every permission mode).
 */
export const DENIED_TOOLS = [
  'Task',
  'Agent',
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'Skill',
  'REPL',
  'TodoWrite',
  'ExitPlanMode',
];

/**
 * Env vars forwarded to the agent subprocess — nothing else. The SDK `env`
 * option REPLACES the subprocess environment (it is not merged with
 * process.env), so secrets like DATABASE_URL, INGEST_API_KEY, and GCP_* /
 * vault vars in the parent process never reach the agent, even if a
 * prompt-injected page convinces it to try dumping its environment.
 */
const SUBPROCESS_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
];

export function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SUBPROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function truncateOutput(text: string): string {
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
 * JSON candidates from agent output text, best-first: fenced ```json blocks
 * (last block first), then any parseable JSON object in the raw text (last
 * object first).
 */
function extractJsonCandidates(text: string): unknown[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
    (m) => m[1] ?? '',
  );
  const sources = [...fenced.reverse(), text];
  const candidates: unknown[] = [];
  for (const source of sources) {
    const objects = findJsonObjects(source);
    for (let i = objects.length - 1; i >= 0; i--) {
      candidates.push(objects[i]);
    }
  }
  return candidates;
}

export interface AgentStreamCapture {
  /** The final result-message text, when the run produced one. */
  resultText?: string;
  /** Every assistant text block, in stream order. */
  assistantTexts: string[];
}

/**
 * Extract the agent's final JSON answer: try the result text first, then
 * assistant texts newest-first; within each, fenced blocks before raw
 * objects. `tryParse` validates a candidate (e.g. zod safeParse) and
 * returns undefined to reject it.
 */
export function parseAgentJson<T>(
  capture: AgentStreamCapture,
  tryParse: (candidate: unknown) => T | undefined,
): T | undefined {
  const sources = [
    ...(capture.resultText ? [capture.resultText] : []),
    ...[...capture.assistantTexts].reverse(),
  ];
  for (const source of sources) {
    for (const candidate of extractJsonCandidates(source)) {
      const parsed = tryParse(candidate);
      if (parsed !== undefined) return parsed;
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

/**
 * Drain an SDK message stream into `transcript` (seq continues from the
 * steps already recorded — browser-phase steps stay in order before agent
 * steps) and capture the texts the final answer may live in.
 */
export async function consumeAgentStream(
  stream: AsyncIterable<{ type: string }>,
  transcript: TranscriptStep[],
): Promise<AgentStreamCapture> {
  let seq = transcript.length;
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
      const m = message as {
        subtype?: unknown;
        tool_name?: unknown;
        message?: unknown;
      };
      // 'permission_denied' system messages record blocked tool calls —
      // keep the tool name and denial message so denials are observable.
      const denied = m.subtype === 'permission_denied';
      transcript.push({
        seq: seq++,
        kind: 'system',
        text: typeof m.subtype === 'string' ? m.subtype : undefined,
        tool:
          denied && typeof m.tool_name === 'string' ? m.tool_name : undefined,
        output: denied && typeof m.message === 'string' ? m.message : undefined,
        ts,
      });
    }
  }

  return { resultText, assistantTexts };
}
