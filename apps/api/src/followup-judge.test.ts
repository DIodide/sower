import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FollowupJudgeInput,
  judgeFollowupMail,
} from './followup-judge.js';

/**
 * The LLM follow-up judge against a mocked Agent SDK stream: the hardened
 * query options (haiku model, EMPTY tool set, shell/file/web/subagent
 * denials, dontAsk, capped turns, allowlisted subprocess env), JSON answer
 * extraction (result text, fenced blocks, brace-matching fallback in
 * assistant text), the never-throws null contract on SDK errors and
 * unparseable output, the timeout abort, and the body cap.
 */

interface QueryArgs {
  prompt: unknown;
  options: {
    model?: string;
    tools?: string[];
    disallowedTools?: string[];
    permissionMode?: string;
    maxTurns?: number;
    env?: Record<string, string>;
    abortController?: AbortController;
  };
}

const queryState = vi.hoisted(() => ({
  calls: [] as unknown[],
  impl: undefined as undefined | ((args: unknown) => unknown),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: unknown) => {
    queryState.calls.push(args);
    return queryState.impl ? queryState.impl(args) : (async function* () {})();
  }),
}));

/** A finished stream yielding `messages` in order. */
function streamOf(messages: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

function assistantText(text: string): unknown {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function resultMessage(result: string): unknown {
  return { type: 'result', subtype: 'success', result };
}

function queryArgs(index = 0): QueryArgs {
  return queryState.calls[index] as QueryArgs;
}

const INPUT: FollowupJudgeInput = {
  subject: 'Your August account summary is ready',
  from: 'GoDaddy <no-reply@godaddy.com>',
  bodyText: 'Here is what happened on your account this month.',
  company: 'GoDaddy',
  jobTitle: 'Software Engineer Intern',
  regexKind: 'recruiter',
};

beforeEach(() => {
  queryState.calls = [];
  queryState.impl = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('judgeFollowupMail', () => {
  it('parses a fenced JSON verdict from the result text and runs fully hardened', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-tok');
    vi.stubEnv('DATABASE_URL', 'postgres://secret');
    vi.stubEnv('INGEST_API_KEY', 'secret-key');
    queryState.impl = () =>
      streamOf([
        resultMessage(
          '```json\n{"verdict":"noise","kind":null,"confidence":"high","reason":"billing notification, not about a candidacy"}\n```',
        ),
      ]);

    const verdict = await judgeFollowupMail(INPUT);

    expect(verdict).toEqual({
      verdict: 'noise',
      kind: undefined,
      confidence: 'high',
      reason: 'billing notification, not about a candidacy',
    });
    const { prompt, options } = queryArgs();
    // The hardened posture, in full.
    expect(options.model).toBe('claude-haiku-4-5-20251001');
    expect(options.tools).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.maxTurns).toBe(4);
    for (const tool of [
      'Bash',
      'Read',
      'Write',
      'WebSearch',
      'WebFetch',
      'Task',
      'Agent',
    ]) {
      expect(options.disallowedTools).toContain(tool);
    }
    // The subprocess env is the allowlist ONLY — secrets never cross.
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(options.env).not.toHaveProperty('DATABASE_URL');
    expect(options.env).not.toHaveProperty('INGEST_API_KEY');
    // The prompt carries the application context + the untrusted-data rule.
    expect(prompt).toContain('GoDaddy');
    expect(prompt).toContain('Software Engineer Intern');
    expect(prompt).toContain("'recruiter'");
    expect(prompt).toContain('UNTRUSTED DATA');
    expect(prompt).toContain(INPUT.subject);
  });

  it('falls back to brace matching in assistant text (newest first) when the result has no JSON', async () => {
    queryState.impl = () =>
      streamOf([
        assistantText('Considering the email now.'),
        assistantText(
          'My verdict: {"verdict":"followup","kind":"interview","confidence":"low","reason":"reads like scheduling"} — done.',
        ),
        resultMessage('no json here'),
      ]);

    const verdict = await judgeFollowupMail(INPUT);

    expect(verdict).toEqual({
      verdict: 'followup',
      kind: 'interview',
      confidence: 'low',
      reason: 'reads like scheduling',
    });
  });

  it('returns null when the output never validates against the schema', async () => {
    queryState.impl = () =>
      streamOf([resultMessage('{"verdict":"maybe","confidence":"medium"}')]);

    expect(await judgeFollowupMail(INPUT)).toBeNull();
  });

  it('returns null (never throws) when the SDK query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queryState.impl = () => {
      throw new Error('subprocess failed to start');
    };
    expect(await judgeFollowupMail(INPUT)).toBeNull();

    // A stream that errors mid-iteration is the same contract.
    queryState.impl = () =>
      (async function* () {
        yield assistantText('thinking…');
        throw new Error('stream died');
      })();
    expect(await judgeFollowupMail(INPUT)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('aborts a wedged run at the timeout cap and returns null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queryState.impl = (args) =>
      (async function* () {
        const signal = (args as QueryArgs).options.abortController?.signal;
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      })();

    const verdict = await judgeFollowupMail(INPUT, { timeoutMs: 10 });

    expect(verdict).toBeNull();
    expect(queryArgs().options.abortController?.signal.aborted).toBe(true);
    warn.mockRestore();
  });

  it('caps the body text sent to the judge at ~6000 chars', async () => {
    queryState.impl = () =>
      streamOf([
        resultMessage('{"verdict":"noise","confidence":"high","reason":"r"}'),
      ]);

    await judgeFollowupMail({
      ...INPUT,
      bodyText: `${'a'.repeat(6_500)}ZZZTAIL`,
    });

    const prompt = queryArgs().prompt as string;
    expect(prompt).not.toContain('ZZZTAIL');
    expect(prompt).toContain('a'.repeat(100));
  });

  it('caps an over-long reason', async () => {
    queryState.impl = () =>
      streamOf([
        resultMessage(
          JSON.stringify({
            verdict: 'noise',
            confidence: 'high',
            reason: 'x'.repeat(1_000),
          }),
        ),
      ]);

    const verdict = await judgeFollowupMail(INPUT);
    expect(verdict?.reason).toHaveLength(300);
  });
});
