import type { Question } from '@sower/core';
import { describe, expect, it } from 'vitest';
import type { Profile } from './profile.js';
import {
  normalizeLabel,
  resolveAnswers,
  splitMissingByRequired,
} from './resolve.js';

const profile: Profile = {
  name: { first: 'Jane', last: 'Doe' },
  email: 'jane.doe@example.com',
  phone: '+1 555 0100',
  location: { city: 'Princeton', state: 'NJ', country: 'USA' },
  links: {
    website: 'https://janedoe.example.com',
    github: 'https://github.com/janedoe',
    linkedin: 'https://www.linkedin.com/in/janedoe-example',
  },
  education: [
    {
      school: 'Example University',
      degree: 'BSE',
      major: 'Computer Science',
      gpa: 3.9,
      startDate: '2024-09',
      endDate: '2028-05',
    },
  ],
  work: [
    {
      company: 'Example Corp',
      title: 'Software Engineering Intern',
      startDate: '2025-06',
      endDate: '2025-08',
    },
  ],
  authorization: { usWorkAuthorized: true, requiresSponsorship: false },
  custom: { 'favorite programming language': 'TypeScript' },
};

function q(
  partial: Partial<Question> & Pick<Question, 'id' | 'label'>,
): Question {
  return { type: 'text', required: true, ...partial };
}

describe('normalizeLabel', () => {
  it('lowercases, strips punctuation, and collapses spaces', () => {
    expect(normalizeLabel('  First   Name?! ')).toBe('first name');
    expect(normalizeLabel('E-mail (Address)')).toBe('e mail address');
  });
});

describe('resolveAnswers', () => {
  it('resolves standard ids: first_name, last_name, email, phone', () => {
    const questions: Question[] = [
      q({ id: 'first_name', label: 'First Name' }),
      q({ id: 'last_name', label: 'Last Name' }),
      q({ id: 'email', label: 'Email' }),
      q({ id: 'phone', label: 'Phone' }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      { questionId: 'first_name', source: 'profile', value: 'Jane' },
      { questionId: 'last_name', source: 'profile', value: 'Doe' },
      { questionId: 'email', source: 'profile', value: 'jane.doe@example.com' },
      { questionId: 'phone', source: 'profile', value: '+1 555 0100' },
    ]);
  });

  it('resolves by exact normalized label when the id is not a standard field', () => {
    const questions: Question[] = [
      q({ id: 'q_1', label: 'Full Name' }),
      q({ id: 'q_2', label: 'Email address' }),
      q({ id: 'q_3', label: 'LinkedIn Profile' }),
      q({ id: 'q_4', label: 'Current location (city)' }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      { questionId: 'q_1', source: 'profile', value: 'Jane Doe' },
      { questionId: 'q_2', source: 'profile', value: 'jane.doe@example.com' },
      {
        questionId: 'q_3',
        source: 'profile',
        value: 'https://www.linkedin.com/in/janedoe-example',
      },
      { questionId: 'q_4', source: 'profile', value: 'Princeton, NJ' },
    ]);
  });

  it('does not resolve sentence-form labels that merely contain a dictionary key', () => {
    // Exact-label matching only: sentence-form labels go to a human rather
    // than risk answering a different question than was asked.
    const question = q({ id: 'q_name', label: 'What is your full name?' });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('resolves a Yes/No select via exact option label match', () => {
    const question = q({
      id: 'q_auth',
      label: 'Are you authorized to work in the United States?',
      type: 'select',
      options: [
        { label: 'Yes', value: 1 },
        { label: 'No', value: 0 },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      { questionId: 'q_auth', source: 'profile', value: '1' },
    ]);
  });

  it('sends a select whose yes/no options carry extra claims to missing', () => {
    // Options that merely BEGIN with yes/no assert more than the profile's
    // boolean ('Yes, I will require sponsorship' is a specific statement).
    // Only an option whose label is exactly Yes or No may resolve.
    const question = q({
      id: 'q_sponsor',
      label: 'Will you require visa sponsorship?',
      type: 'select',
      options: [
        { label: 'Yes, I will require sponsorship', value: 'yes-sponsor' },
        { label: 'No, I will not require sponsorship', value: 'no-sponsor' },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('resolves a plain Yes/No sponsorship select to the exact matching option', () => {
    const question = q({
      id: 'q_sponsor',
      label: 'Will you require visa sponsorship?',
      type: 'select',
      options: [
        { label: 'Yes', value: 'opt-yes' },
        { label: 'No', value: 'opt-no' },
      ],
    });

    const noSponsor = resolveAnswers([question], profile);
    expect(noSponsor.missing).toEqual([]);
    expect(noSponsor.resolved).toEqual([
      { questionId: 'q_sponsor', source: 'profile', value: 'opt-no' },
    ]);

    const sponsorProfile: Profile = {
      ...profile,
      authorization: { usWorkAuthorized: true, requiresSponsorship: true },
    };
    const yesSponsor = resolveAnswers([question], sponsorProfile);
    expect(yesSponsor.missing).toEqual([]);
    expect(yesSponsor.resolved).toEqual([
      { questionId: 'q_sponsor', source: 'profile', value: 'opt-yes' },
    ]);
  });

  it('sends a sponsorship select with variant yes-options to missing (GitLab regression)', () => {
    // A profile requiring sponsorship must NEVER auto-pick a specific visa
    // type the profile never claimed.
    const sponsorProfile: Profile = {
      ...profile,
      authorization: { usWorkAuthorized: true, requiresSponsorship: true },
    };
    const question = q({
      id: 'q_visa',
      label:
        'Will you now or in the future require sponsorship for employment visa status?',
      type: 'select',
      options: [
        {
          label: 'Yes, Netherlands Highly Skilled Migrant Visa',
          value: 'nl-hsm',
        },
        { label: 'Yes, H-1B', value: 'h1b' },
        { label: 'Yes, other', value: 'other' },
        { label: 'No', value: 'no' },
      ],
    });
    const result = resolveAnswers([question], sponsorProfile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends a select with duplicate exactly-matching options to missing', () => {
    const question = q({
      id: 'q_auth_dup',
      label: 'Are you authorized to work in the United States?',
      type: 'select',
      options: [
        { label: 'Yes', value: 1 },
        { label: 'yes', value: 2 },
        { label: 'No', value: 0 },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends a select to missing when no option label matches the raw value', () => {
    const question = q({
      id: 'q_auth2',
      label: 'Work authorization status',
      type: 'select',
      options: [
        { label: 'US Citizen', value: 'citizen' },
        { label: 'Green Card', value: 'gc' },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('wraps multiselect values in an array', () => {
    const question = q({
      id: 'q_multi',
      label: 'Are you authorized to work in the US?',
      type: 'multiselect',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([
      { questionId: 'q_multi', source: 'profile', value: ['yes'] },
    ]);
  });

  it('always sends file uploads to missing, even resume/cover letter', () => {
    const questions: Question[] = [
      q({ id: 'resume', label: 'Resume', type: 'file' }),
      q({
        id: 'cover_letter',
        label: 'Cover Letter',
        type: 'file',
        required: false,
      }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual(questions);
  });

  it('sends unmatched required questions to missing (never guesses)', () => {
    const question = q({
      id: 'q_essay',
      label: 'Why do you want to work here?',
      type: 'textarea',
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends unmatched optional questions to missing (never default-fills)', () => {
    const question = q({
      id: 'q_pronouns',
      label: 'Pronouns',
      required: false,
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('resolves from profile.custom by exact normalized label match', () => {
    const hit = q({ id: 'q_lang', label: 'Favorite Programming Language?' });
    const miss = q({ id: 'q_lang2', label: 'Favorite Language' });
    const result = resolveAnswers([hit, miss], profile);
    expect(result.resolved).toEqual([
      { questionId: 'q_lang', source: 'profile', value: 'TypeScript' },
    ]);
    expect(result.missing).toEqual([miss]);
  });

  it('sends questions to missing when the profile lacks the optional link', () => {
    const profileWithoutLinks: Profile = { ...profile, links: {} };
    const question = q({ id: 'q_gh', label: 'GitHub URL' });
    const result = resolveAnswers([question], profileWithoutLinks);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it("resolves 'Current company' only from a work entry that has not ended", () => {
    const currentJobProfile: Profile = {
      ...profile,
      work: [
        {
          company: 'Acme Robotics',
          title: 'Software Engineer',
          startDate: '2026-01',
        },
      ],
    };
    const question = q({ id: 'q_company', label: 'Current company' });

    const withCurrentJob = resolveAnswers([question], currentJobProfile);
    expect(withCurrentJob.resolved).toEqual([
      { questionId: 'q_company', source: 'profile', value: 'Acme Robotics' },
    ]);

    // The base profile's only work entry has an endDate, so claiming it as
    // the current company would be untruthful.
    const withEndedJob = resolveAnswers([question], profile);
    expect(withEndedJob.resolved).toEqual([]);
    expect(withEndedJob.missing).toEqual([question]);
  });
});

describe('substring-fabrication regressions', () => {
  it.each([
    ['What is your ethnicity?', 'previously matched substring "city"'],
    ['Are you open to relocation?', 'previously matched substring "location"'],
    [
      'In what capacity have you worked with our products?',
      'previously matched substring "city"',
    ],
    ["What is your manager's email?", 'previously matched substring "email"'],
    ["Manager's email address", 'previously matched substring "email"'],
  ])('does not resolve %j (%s)', (label) => {
    const question = q({ id: 'q_custom', label });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends compound authorization-and-sponsorship questions to missing', () => {
    const question = q({
      id: 'q_compound',
      label:
        'Are you authorized to work in the US, or will you require sponsorship?',
    });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends negated sponsorship/authorization questions to missing', () => {
    const questions: Question[] = [
      q({
        id: 'q_neg_sponsor',
        label: 'Can you work in the US without sponsorship?',
      }),
      q({
        id: 'q_neg_auth',
        label: 'Select this if you are not authorized to work in the US',
      }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual(questions);
  });
});

describe('splitMissingByRequired', () => {
  it('splits missing questions by their required flag, preserved by resolveAnswers', () => {
    const requiredQ = q({
      id: 'q_essay',
      label: 'Why do you want to work here?',
      type: 'textarea',
    });
    const optionalQ = q({
      id: 'q_pronouns',
      label: 'Pronouns',
      required: false,
    });
    const result = resolveAnswers([requiredQ, optionalQ], profile);
    expect(result.missing).toEqual([requiredQ, optionalQ]);

    const split = splitMissingByRequired(result.missing);
    expect(split.required).toEqual([requiredQ]);
    expect(split.optional).toEqual([optionalQ]);
  });

  it('returns empty arrays for no missing questions', () => {
    expect(splitMissingByRequired([])).toEqual({
      required: [],
      optional: [],
    });
  });
});
