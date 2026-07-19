/**
 * Transcript capture from a Claude Agent SDK message stream.
 *
 * Local adaptation of @sower/investigate's agent-runner capture (same
 * TranscriptStep shape as the @sower/db mirror, so resume_runs.transcript and
 * investigation_runs.transcript render identically in the dashboard). Kept as
 * a local copy rather than an import so this app does not inherit
 * @sower/investigate's playwright/browser dependency tree into its container
 * image.
 */

export interface TranscriptStep {
  seq: number;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'result' | 'system';
  /** Bash / Edit / ... (on 'system' steps: the denied tool). */
  tool?: string;
  /** tool_use input (e.g. {command} or {file_path}). */
  input?: unknown;
  /**
   * tool_result output (or, on 'permission_denied' system steps, the denial
   * message), truncated to ~8000 chars.
   */
  output?: string;
  /** assistant reasoning text. */
  text?: string;
  ts: number;
}

const OUTPUT_TRUNCATE_CHARS = 8000;

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

export interface AgentStreamCapture {
  /** The final result-message text, when the run produced one. */
  resultText?: string;
  /** Every assistant text block, in stream order. */
  assistantTexts: string[];
}

/**
 * Drain an SDK message stream into `transcript` (seq continues from the
 * steps already recorded) and capture the texts the final answer may live in.
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
