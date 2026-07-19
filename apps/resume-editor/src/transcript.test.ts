import { describe, expect, it } from 'vitest';
import { consumeAgentStream, type TranscriptStep } from './transcript.js';

async function* streamOf(messages: { type: string }[]) {
  for (const message of messages) {
    yield message;
  }
}

describe('consumeAgentStream', () => {
  it('captures assistant text, tool calls, tool results, and the result message', async () => {
    const transcript: TranscriptStep[] = [];
    const capture = await consumeAgentStream(
      streamOf([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Editing the resume now.' },
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'Bash',
                input: { command: 'tectonic swe-2027.tex' },
              },
            ],
          },
        } as { type: string },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-1',
                content: 'compiled ok',
              },
            ],
          },
        } as { type: string },
        {
          type: 'result',
          subtype: 'success',
          result: 'Done: updated and pushed.',
        } as { type: string },
      ]),
      transcript,
    );

    expect(transcript.map((s) => s.kind)).toEqual([
      'assistant_text',
      'tool_use',
      'tool_result',
      'result',
    ]);
    expect(transcript.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    // tool_result steps are named via the tool_use id map.
    expect(transcript[2]?.tool).toBe('Bash');
    expect(transcript[2]?.output).toBe('compiled ok');
    expect(capture.resultText).toBe('Done: updated and pushed.');
    expect(capture.assistantTexts).toEqual(['Editing the resume now.']);
  });

  it('records permission_denied system messages with the denied tool', async () => {
    const transcript: TranscriptStep[] = [];
    await consumeAgentStream(
      streamOf([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'WebFetch',
          message: 'tool is not allowed',
        } as { type: string },
      ]),
      transcript,
    );
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.kind).toBe('system');
    expect(transcript[0]?.tool).toBe('WebFetch');
    expect(transcript[0]?.output).toBe('tool is not allowed');
  });

  it('truncates huge tool outputs', async () => {
    const transcript: TranscriptStep[] = [];
    await consumeAgentStream(
      streamOf([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'x',
                content: 'a'.repeat(10_000),
              },
            ],
          },
        } as { type: string },
      ]),
      transcript,
    );
    expect(transcript[0]?.output?.length).toBeLessThan(9000);
    expect(transcript[0]?.output).toContain('[truncated');
  });
});
