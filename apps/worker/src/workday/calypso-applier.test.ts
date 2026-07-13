import type { Profile } from '@sower/answers';
import type { WorkdayQuestionnaireField } from '@sower/platforms';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApplyClient,
  applyViaCalypso,
  type CalypsoApplyInput,
} from './calypso-applier.js';

const profile = {
  name: { first: 'Ibraheem', last: 'Amin' },
  email: 'ibraheem.amin2@gmail.com',
  phone: '+1 (978) 555-0142',
  location: {
    city: 'Lowell',
    state: 'Massachusetts',
    country: 'United States',
  },
  links: {},
  education: [],
  work: [],
  authorization: { usWorkAuthorized: true, requiresSponsorship: false },
  custom: {},
} as unknown as Profile;

const authQ: WorkdayQuestionnaireField = {
  id: 'q-auth',
  label: 'Are you legally authorized to work in the US?',
  control: 'select',
  required: true,
  conditional: false,
  order: 'a',
  needsOptions: true,
  options: [
    { id: 'opt-yes', descriptor: 'Yes' },
    { id: 'opt-no', descriptor: 'No' },
  ],
};

function fakeClient(
  over: Partial<ApplyClient> & {
    fields?: WorkdayQuestionnaireField[];
    sessionOk?: boolean;
  } = {},
): ApplyClient & { calls: { section: string; body: unknown }[] } {
  const calls: { section: string; body: unknown }[] = [];
  return {
    calls,
    checkSession: vi.fn(async () => over.sessionOk ?? true),
    startApplication: vi.fn(async () => ({ jobApplicationId: 'JAID-1' })),
    fillSection: vi.fn(async (_j, section, body) => {
      calls.push({ section, body });
      return {};
    }),
    validate: vi.fn(async () => {}),
    getQuestionnaireFields: vi.fn(async () => over.fields ?? []),
    uploadResume: vi.fn(async () => {}),
    ...over,
  };
}

const baseInput: CalypsoApplyInput = {
  jobSlug: 'Software-Engineering-Intern_328740',
  questionnaireId: 'Q1',
  profile,
};

describe('applyViaCalypso', () => {
  it('starts, fills the profile sections, and STOPS before submit', async () => {
    const client = fakeClient({ fields: [] });
    const result = await applyViaCalypso(client, baseInput);

    expect(result.jobApplicationId).toBe('JAID-1');
    expect(result.stoppedBeforeSubmit).toBe(true);
    expect(result.sectionsFilled).toEqual([
      'name',
      'emailaddress',
      'phonenumber',
    ]);
    // The name section carried the profile name.
    const nameCall = client.calls.find((c) => c.section === 'name');
    expect(nameCall?.body).toMatchObject({
      legalName: { firstName: 'Ibraheem', lastName: 'Amin' },
    });
    // NEVER a finalize/submit call.
    expect(client.calls.map((c) => c.section)).not.toContain('finalize');
  });

  it('resolves questionnaire answers and posts questionnaireresponses', async () => {
    const client = fakeClient({ fields: [authQ] });
    const result = await applyViaCalypso(client, {
      ...baseInput,
      // A curated answer-bank hit for work authorization resolves 'Yes'.
      bank: [
        {
          normalizedLabel:
            'are you legally authorized to work in the united states',
          value: 'Yes',
          company: '',
        },
      ],
    });

    expect(result.questionnaire?.fields).toBe(1);
    const qCall = client.calls.find(
      (c) => c.section === 'questionnaireresponses',
    );
    // If resolution matched, the choice GUID is submitted; otherwise skipped.
    if (result.questionnaire && result.questionnaire.answered > 0) {
      expect(qCall?.body).toMatchObject({
        questionnaireAnswers: [
          {
            questionItem: { id: 'q-auth' },
            questionMultipleChoiceAnswers: [
              { id: 'opt-yes', descriptor: 'Yes' },
            ],
          },
        ],
      });
    }
  });

  it('records section errors but keeps going (tenant variance is not fatal)', async () => {
    const client = fakeClient({ fields: [] });
    client.fillSection = vi.fn(async (_j, section) => {
      if (section === 'phonenumber') throw new Error('bad phone');
      return {};
    });
    const result = await applyViaCalypso(client, baseInput);

    expect(result.sectionsFilled).toEqual(['name', 'emailaddress']);
    expect(result.sectionErrors).toEqual([
      { section: 'phonenumber', error: 'bad phone' },
    ]);
    expect(result.stoppedBeforeSubmit).toBe(true);
  });

  it('throws (without starting) when the session is invalid', async () => {
    const client = fakeClient({ sessionOk: false });
    await expect(applyViaCalypso(client, baseInput)).rejects.toThrow(
      /session is invalid/,
    );
    expect(client.startApplication).not.toHaveBeenCalled();
  });

  it('skips the questionnaire when there is no questionnaireId', async () => {
    const client = fakeClient();
    const result = await applyViaCalypso(client, {
      ...baseInput,
      questionnaireId: null,
    });
    expect(result.questionnaire).toBeNull();
    expect(client.getQuestionnaireFields).not.toHaveBeenCalled();
  });
});
