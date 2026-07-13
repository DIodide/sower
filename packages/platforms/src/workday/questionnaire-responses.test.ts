import { describe, expect, it } from 'vitest';
import type { WorkdayQuestionnaireField } from './questionnaire.js';
import {
  buildQuestionnaireResolution,
  buildQuestionnaireResponses,
  matchOption,
  resolveQuestionnaireAnswer,
} from './questionnaire-responses.js';

function field(
  over: Partial<WorkdayQuestionnaireField> & { id: string },
): WorkdayQuestionnaireField {
  return {
    label: over.id,
    control: 'text',
    required: true,
    conditional: false,
    order: 'a',
    needsOptions: false,
    ...over,
  };
}

// Real option GUIDs from the datasite HAR (each question has its OWN Yes/No).
const workAuth = field({
  id: '8bf28821933a1001f43b336b96670001',
  label: 'Are you legally authorized to work…?',
  control: 'select',
  options: [
    { id: 'ee2b4eda6fee0119c645a5854c58f48a', descriptor: 'Yes' },
    { id: 'ee2b4eda6fee0119c645a5854c58aaaa', descriptor: 'No' },
  ],
});
const sponsorship = field({
  id: '8bf28821933a1001f43b340531bc0002',
  label: 'Will you require sponsorship…?',
  control: 'select',
  options: [
    { id: '34865b6365551001ecb357e016b8yyyy', descriptor: 'Yes' },
    { id: '34865b6365551001ecb357e016b80003', descriptor: 'No' },
  ],
});
const notice = field({
  id: '8bf28821933a1001f4750e0834210000',
  label: 'Notice period?',
  control: 'text',
});

describe('buildQuestionnaireResponses (exact datasite wire format)', () => {
  it('serializes text as answerText and choice as questionMultipleChoiceAnswers', () => {
    const payload = buildQuestionnaireResponses([
      {
        questionId: workAuth.id,
        choice: { id: 'ee2b4eda6fee0119c645a5854c58f48a', descriptor: 'Yes' },
      },
      { questionId: notice.id, answerText: '5 months' },
    ]);
    expect(payload).toEqual({
      questionnaireAnswers: [
        {
          questionItem: { id: '8bf28821933a1001f43b336b96670001' },
          questionMultipleChoiceAnswers: [
            { id: 'ee2b4eda6fee0119c645a5854c58f48a', descriptor: 'Yes' },
          ],
        },
        {
          questionItem: { id: '8bf28821933a1001f4750e0834210000' },
          answerText: '5 months',
        },
      ],
    });
  });
});

describe('matchOption', () => {
  const opts = workAuth.options ?? [];
  it('matches by descriptor case-insensitively', () => {
    expect(matchOption(opts, 'Yes')?.id).toBe(
      'ee2b4eda6fee0119c645a5854c58f48a',
    );
    expect(matchOption(opts, 'yes')?.descriptor).toBe('Yes');
  });
  it('aliases true/false/y/n to yes/no', () => {
    expect(matchOption(opts, 'true')?.descriptor).toBe('Yes');
    expect(matchOption(opts, 'false')?.descriptor).toBe('No');
    expect(matchOption(opts, 'N')?.descriptor).toBe('No');
  });
  it('matches when the value already IS the option GUID', () => {
    expect(
      matchOption(opts, 'ee2b4eda6fee0119c645a5854c58f48a')?.descriptor,
    ).toBe('Yes');
  });
  it('returns undefined for an unmatched value (never guesses)', () => {
    expect(matchOption(opts, 'maybe')).toBeUndefined();
  });
});

describe('resolveQuestionnaireAnswer', () => {
  it('text field -> answerText', () => {
    expect(resolveQuestionnaireAnswer(notice, '5 months')).toEqual({
      questionId: notice.id,
      answerText: '5 months',
    });
  });
  it('select field -> the matched option GUID (choice)', () => {
    expect(resolveQuestionnaireAnswer(sponsorship, 'No')).toEqual({
      questionId: sponsorship.id,
      choice: { id: '34865b6365551001ecb357e016b80003', descriptor: 'No' },
    });
  });
  it('select with no matching option -> null (skip for human)', () => {
    expect(resolveQuestionnaireAnswer(sponsorship, 'perhaps')).toBeNull();
  });
  it('empty value or file control -> null', () => {
    expect(resolveQuestionnaireAnswer(notice, '   ')).toBeNull();
    expect(
      resolveQuestionnaireAnswer(field({ id: 'f', control: 'file' }), 'x'),
    ).toBeNull();
  });
});

describe('buildQuestionnaireResolution', () => {
  it('resolves a mixed set and reports skips (required-aware)', () => {
    const result = buildQuestionnaireResolution(
      [workAuth, sponsorship, notice],
      {
        [workAuth.id]: 'Yes',
        [sponsorship.id]: 'No',
        // notice deliberately unanswered
      },
    );
    expect((result.payload.questionnaireAnswers as unknown[]).length).toBe(2);
    expect(result.skipped.map((f) => f.id)).toEqual([notice.id]);
    expect(result.skippedRequired).toBe(1);
  });

  it('reproduces the datasite HAR answers exactly', () => {
    const nonCompete = field({
      id: '8bf28821933a1001f43b340531bc0005',
      control: 'select',
      options: [
        { id: '34865b6365551001ecb35745af6ffff', descriptor: 'Yes' },
        { id: '34865b6365551001ecb35745af600000', descriptor: 'No' },
      ],
    });
    const salary = field({ id: '8bf28821933a1001f43b340531bc0009' });
    const { payload } = buildQuestionnaireResolution(
      [workAuth, notice, salary, nonCompete, sponsorship],
      {
        [workAuth.id]: 'Yes',
        [notice.id]: '5 months',
        [salary.id]: '125,000 / year',
        [nonCompete.id]: 'No',
        [sponsorship.id]: 'No',
      },
    );
    // The exact GUIDs the human's HAR submitted.
    expect(payload.questionnaireAnswers).toContainEqual({
      questionItem: { id: '8bf28821933a1001f43b336b96670001' },
      questionMultipleChoiceAnswers: [
        { id: 'ee2b4eda6fee0119c645a5854c58f48a', descriptor: 'Yes' },
      ],
    });
    expect(payload.questionnaireAnswers).toContainEqual({
      questionItem: { id: '8bf28821933a1001f43b340531bc0002' },
      questionMultipleChoiceAnswers: [
        { id: '34865b6365551001ecb357e016b80003', descriptor: 'No' },
      ],
    });
    expect(payload.questionnaireAnswers).toContainEqual({
      questionItem: { id: '8bf28821933a1001f43b340531bc0009' },
      answerText: '125,000 / year',
    });
  });
});
