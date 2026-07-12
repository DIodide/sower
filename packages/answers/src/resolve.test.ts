import type { Question } from '@sower/core';
import { describe, expect, it } from 'vitest';
import type { AnswerBank } from './answer-bank.js';
import type { Profile } from './profile.js';
import {
  normalizeCompanyKey,
  normalizeLabel,
  resolveAnswers,
  selectBankValue,
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

describe('LABEL_DICTIONARY census additions', () => {
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

  it.each([
    ['Preferred First Name', 'Jane'],
    ['Preferred Name', 'Jane'],
    ['Preferred Last Name', 'Doe'],
  ])('resolves %j from the profile name', (label, expected) => {
    const question = q({ id: 'q_pref', label });
    const result = resolveAnswers([question], profile);
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      { questionId: 'q_pref', source: 'profile', value: expected },
    ]);
  });

  it('resolves Twitter only when the profile has a twitter link', () => {
    const question = q({ id: 'q_tw', label: 'Twitter', required: false });

    const withTwitter: Profile = {
      ...profile,
      links: { ...profile.links, twitter: 'https://twitter.com/janedoe' },
    };
    const hit = resolveAnswers([question], withTwitter);
    expect(hit.resolved).toEqual([
      {
        questionId: 'q_tw',
        source: 'profile',
        value: 'https://twitter.com/janedoe',
      },
    ]);

    // The base profile has no twitter link, so the question goes to a human.
    const miss = resolveAnswers([question], profile);
    expect(miss.resolved).toEqual([]);
    expect(miss.missing).toEqual([question]);
  });

  it("resolves 'Current Employer (if applicable)' only from a job that has not ended", () => {
    const question = q({
      id: 'q_emp',
      label: 'Current Employer (if applicable)',
    });

    const withCurrentJob = resolveAnswers([question], currentJobProfile);
    expect(withCurrentJob.resolved).toEqual([
      { questionId: 'q_emp', source: 'profile', value: 'Acme Robotics' },
    ]);

    // The base profile's only job has ended, so there is no current employer.
    const withEndedJob = resolveAnswers([question], profile);
    expect(withEndedJob.resolved).toEqual([]);
    expect(withEndedJob.missing).toEqual([question]);
  });

  it.each([
    'Who is your current or most recent employer?',
    'Who is your current or previous employer?',
  ])('resolves %j from the most recent work entry', (label) => {
    const question = q({ id: 'q_recent_emp', label });

    // A single ended job is still the most recent employer.
    const ended = resolveAnswers([question], profile);
    expect(ended.resolved).toEqual([
      { questionId: 'q_recent_emp', source: 'profile', value: 'Example Corp' },
    ]);

    // A current job wins outright.
    const current = resolveAnswers([question], currentJobProfile);
    expect(current.resolved).toEqual([
      { questionId: 'q_recent_emp', source: 'profile', value: 'Acme Robotics' },
    ]);

    // With several ended jobs, the latest endDate wins.
    const multiEnded: Profile = {
      ...profile,
      work: [
        {
          company: 'Older Corp',
          title: 'Intern',
          startDate: '2023-06',
          endDate: '2023-08',
        },
        ...profile.work,
      ],
    };
    const latest = resolveAnswers([question], multiEnded);
    expect(latest.resolved).toEqual([
      { questionId: 'q_recent_emp', source: 'profile', value: 'Example Corp' },
    ]);
  });

  it('sends most-recent-employer questions to missing when the history is ambiguous', () => {
    const question = q({
      id: 'q_recent_emp',
      label: 'Who is your current or most recent employer?',
    });

    // Two jobs ending the same month: no single most recent employer.
    const tiedProfile: Profile = {
      ...profile,
      work: [
        {
          company: 'Corp A',
          title: 'Engineer',
          startDate: '2025-01',
          endDate: '2025-08',
        },
        {
          company: 'Corp B',
          title: 'Engineer',
          startDate: '2025-02',
          endDate: '2025-08',
        },
      ],
    };
    const tied = resolveAnswers([question], tiedProfile);
    expect(tied.resolved).toEqual([]);
    expect(tied.missing).toEqual([question]);

    // Two concurrent current jobs: also ambiguous.
    const twoCurrentProfile: Profile = {
      ...profile,
      work: [
        { company: 'Corp A', title: 'Engineer', startDate: '2025-01' },
        { company: 'Corp B', title: 'Advisor', startDate: '2025-02' },
      ],
    };
    const twoCurrent = resolveAnswers([question], twoCurrentProfile);
    expect(twoCurrent.resolved).toEqual([]);
    expect(twoCurrent.missing).toEqual([question]);

    // Empty history: nothing to answer with.
    const noWork = resolveAnswers([question], { ...profile, work: [] });
    expect(noWork.resolved).toEqual([]);
    expect(noWork.missing).toEqual([question]);
  });

  it.each([
    'What is your current or more recent job title?',
    'What is your current or previous job title?',
  ])('resolves %j from the most recent work entry', (label) => {
    const question = q({ id: 'q_title', label });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([
      {
        questionId: 'q_title',
        source: 'profile',
        value: 'Software Engineering Intern',
      },
    ]);
  });

  it("resolves 'What is the most recent school you attended?' by latest endDate", () => {
    const question = q({
      id: 'q_school',
      label: 'What is the most recent school you attended?',
    });

    const single = resolveAnswers([question], profile);
    expect(single.resolved).toEqual([
      {
        questionId: 'q_school',
        source: 'profile',
        value: 'Example University',
      },
    ]);

    const multiSchool: Profile = {
      ...profile,
      education: [
        {
          school: 'Later Institute',
          degree: 'MS',
          major: 'Robotics',
          startDate: '2028-09',
          endDate: '2030-05',
        },
        ...profile.education,
      ],
    };
    const latest = resolveAnswers([question], multiSchool);
    expect(latest.resolved).toEqual([
      { questionId: 'q_school', source: 'profile', value: 'Later Institute' },
    ]);

    const noEducation = resolveAnswers([question], {
      ...profile,
      education: [],
    });
    expect(noEducation.resolved).toEqual([]);
    expect(noEducation.missing).toEqual([question]);
  });

  it.each([
    'What is your current country of residence?',
    'Please choose the country in which you are located',
  ])('resolves %j from the profile country', (label) => {
    const question = q({ id: 'q_country', label });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([
      { questionId: 'q_country', source: 'profile', value: 'USA' },
    ]);
  });

  it('resolves the country-of-residence select only on an exact option match', () => {
    const base = {
      id: 'q_country',
      label: 'Please select the country where you currently reside.',
      type: 'select' as const,
    };

    const exact = q({
      ...base,
      options: [
        { label: 'Canada', value: 'ca' },
        { label: 'USA', value: 'usa' },
      ],
    });
    const hit = resolveAnswers([exact], profile);
    expect(hit.resolved).toEqual([
      { questionId: 'q_country', source: 'profile', value: 'usa' },
    ]);

    // Stripe-style option list spells it 'US' — no exact match for the
    // profile's 'USA', so nothing resolves (never guess an equivalence).
    const inexact = q({
      ...base,
      options: [
        { label: 'Canada', value: 'ca' },
        { label: 'US', value: 'us' },
        { label: 'UK', value: 'uk' },
      ],
    });
    const miss = resolveAnswers([inexact], profile);
    expect(miss.resolved).toEqual([]);
    expect(miss.missing).toEqual([inexact]);
  });

  it.each([
    [
      'What is the most recent degree you obtained?',
      'in-progress degrees are not obtained',
    ],
    ['Pronouns', 'no profile fact'],
    ['Name Pronunciation', 'no profile fact'],
    ['What is the zip code of your primary residence?', 'profile has no zip'],
    [
      'Which U.S. state or Canadian province do you reside in?',
      'only truthful for US/Canada residents',
    ],
  ])('deliberately does not resolve census candidate %j (%s)', (label) => {
    const question = q({ id: 'q_skip', label });
    const result = resolveAnswers([question], profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });
});

describe('answers bank', () => {
  it('resolves a text question from an exact normalized-label bank match', () => {
    const question = q({
      id: 'q_essay',
      label: 'Why do you want to work here?',
      type: 'textarea',
    });
    const result = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'why do you want to work here',
          value: 'I admire the engineering culture.',
        },
      ],
    });
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      {
        questionId: 'q_essay',
        source: 'bank',
        value: 'I admire the engineering culture.',
      },
    ]);
  });

  it('does NOT resolve from a near-miss bank label', () => {
    const question = q({
      id: 'q_essay',
      label: 'Why do you want to work here?',
      type: 'textarea',
    });
    const result = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'why do you want to work at acme',
          value: 'I admire the engineering culture.',
        },
      ],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('bank selects still require an exact option match', () => {
    // A sponsorship-requiring profile resolves the regex stage to a bare
    // 'Yes', which matches none of these variant options — so the bank is
    // the only stage that can answer (GitLab regression setup).
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
    const bankLabel =
      'will you now or in the future require sponsorship for employment visa status';

    const exact = resolveAnswers([question], sponsorProfile, {
      bank: [{ normalizedLabel: bankLabel, value: 'Yes, H-1B' }],
    });
    expect(exact.resolved).toEqual([
      { questionId: 'q_visa', source: 'bank', value: 'h1b' },
    ]);

    // A bank value that is not exactly one of the options never resolves.
    const inexact = resolveAnswers([question], sponsorProfile, {
      bank: [{ normalizedLabel: bankLabel, value: 'H1B' }],
    });
    expect(inexact.resolved).toEqual([]);
    expect(inexact.missing).toEqual([question]);
  });

  it('falls through to the bank when the profile yes/no cannot match variant options', () => {
    // The sponsorship regex resolves the profile to a bare 'Yes', which
    // never matches these variant options — the user's saved exact option
    // in the bank must win instead of the task looping forever.
    const sponsorProfile: Profile = {
      ...profile,
      authorization: { usWorkAuthorized: true, requiresSponsorship: true },
    };
    const question = q({
      id: 'q_visa',
      label: 'Will you require visa sponsorship?',
      type: 'select',
      options: [
        { label: 'Yes, H-1B', value: 'h1b' },
        { label: 'No', value: 'no' },
      ],
    });
    const result = resolveAnswers([question], sponsorProfile, {
      bank: [
        {
          normalizedLabel: 'will you require visa sponsorship',
          value: 'Yes, H-1B',
        },
      ],
    });
    expect(result.resolved).toEqual([
      { questionId: 'q_visa', source: 'bank', value: 'h1b' },
    ]);
  });

  it('prefers the profile over the bank when both can answer', () => {
    const question = q({ id: 'q_email', label: 'Email' });
    const result = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: 'email', value: 'stale@example.com' }],
    });
    expect(result.resolved).toEqual([
      {
        questionId: 'q_email',
        source: 'profile',
        value: 'jane.doe@example.com',
      },
    ]);
  });

  it('resolves a multiselect from bank array values only when every value matches', () => {
    const question = q({
      id: 'q_langs',
      label: 'Which languages do you use?',
      type: 'multiselect',
      options: [
        { label: 'TypeScript', value: 'ts' },
        { label: 'Python', value: 'py' },
        { label: 'Go', value: 'go' },
      ],
    });
    const bankLabel = 'which languages do you use';

    const allMatch = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: bankLabel, value: ['TypeScript', 'Go'] }],
    });
    expect(allMatch.resolved).toEqual([
      { questionId: 'q_langs', source: 'bank', value: ['ts', 'go'] },
    ]);

    const oneMisses = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: bankLabel, value: ['TypeScript', 'Rust'] }],
    });
    expect(oneMisses.resolved).toEqual([]);
    expect(oneMisses.missing).toEqual([question]);
  });

  it('does not fill a text question from a bank array value', () => {
    const question = q({ id: 'q_langs', label: 'Which languages do you use?' });
    const result = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'which languages do you use',
          value: ['TypeScript', 'Go'],
        },
      ],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });
});

describe('company-scoped answers bank', () => {
  const essay = q({
    id: 'q_essay',
    label: 'Why do you want to work here?',
    type: 'textarea' as const,
  });
  const essayLabel = 'why do you want to work here';
  const acmeEntry = {
    normalizedLabel: essayLabel,
    value: 'Acme builds rockets and I love rockets.',
    company: 'acme',
  };
  const globexEntry = {
    normalizedLabel: essayLabel,
    value: 'Globex has the best fission reactors.',
    company: 'globex',
  };
  const globalEntry = {
    normalizedLabel: essayLabel,
    value: 'I admire the engineering culture.',
  };

  it('normalizeCompanyKey lowercases, trims, and maps absent to global', () => {
    expect(normalizeCompanyKey('  Acme Corp  ')).toBe('acme corp');
    expect(normalizeCompanyKey(undefined)).toBe('');
    expect(normalizeCompanyKey('   ')).toBe('');
  });

  it('resolves a company-scoped answer for its company', () => {
    const result = resolveAnswers([essay], profile, {
      bank: [acmeEntry],
      company: 'acme',
    });
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      { questionId: 'q_essay', source: 'bank', value: acmeEntry.value },
    ]);
  });

  it("never leaks another company's answer: the other company's or global entry wins instead", () => {
    // Same normalized label saved for acme, globex, and globally. Resolving
    // for globex must pick globex's answer — never acme's.
    const forGlobex = resolveAnswers([essay], profile, {
      bank: [acmeEntry, globexEntry, globalEntry],
      company: 'globex',
    });
    expect(forGlobex.resolved).toEqual([
      { questionId: 'q_essay', source: 'bank', value: globexEntry.value },
    ]);

    // With only acme's answer stored, globex gets nothing (stays missing).
    const onlyOther = resolveAnswers([essay], profile, {
      bank: [acmeEntry],
      company: 'globex',
    });
    expect(onlyOther.resolved).toEqual([]);
    expect(onlyOther.missing).toEqual([essay]);

    // With acme's and a global answer, globex falls back to the global one.
    const withGlobal = resolveAnswers([essay], profile, {
      bank: [acmeEntry, globalEntry],
      company: 'globex',
    });
    expect(withGlobal.resolved).toEqual([
      { questionId: 'q_essay', source: 'bank', value: globalEntry.value },
    ]);
  });

  it('resolves a global answer when no company-scoped answer exists', () => {
    const result = resolveAnswers([essay], profile, {
      bank: [globalEntry],
      company: 'acme',
    });
    expect(result.resolved).toEqual([
      { questionId: 'q_essay', source: 'bank', value: globalEntry.value },
    ]);
  });

  it('company-scoped wins over global for its company, regardless of bank order', () => {
    for (const bank of [
      [globalEntry, acmeEntry],
      [acmeEntry, globalEntry],
    ]) {
      const result = resolveAnswers([essay], profile, {
        bank,
        company: 'acme',
      });
      expect(result.resolved).toEqual([
        { questionId: 'q_essay', source: 'bank', value: acmeEntry.value },
      ]);
    }
  });

  it('a company-scoped answer never resolves for a job with no company', () => {
    // Isolation invariant: without opts.company (or with ''), only global
    // entries may answer — acme's essay must not fill an unknown-company job.
    for (const company of [undefined, '']) {
      const scopedOnly = resolveAnswers([essay], profile, {
        bank: [acmeEntry],
        company,
      });
      expect(scopedOnly.resolved).toEqual([]);
      expect(scopedOnly.missing).toEqual([essay]);

      const withGlobal = resolveAnswers([essay], profile, {
        bank: [acmeEntry, globalEntry],
        company,
      });
      expect(withGlobal.resolved).toEqual([
        { questionId: 'q_essay', source: 'bank', value: globalEntry.value },
      ]);
    }
  });

  it('matches companies case- and whitespace-insensitively', () => {
    const result = resolveAnswers([essay], profile, {
      bank: [{ ...acmeEntry, company: '  Acme  ' }],
      company: 'Acme',
    });
    expect(result.resolved).toEqual([
      { questionId: 'q_essay', source: 'bank', value: acmeEntry.value },
    ]);
  });

  it('company-scopes explicit document picks for file questions', () => {
    const question = q({ id: 'resume', label: 'Resume/CV', type: 'file' });
    const documents = [
      {
        kind: 'resume',
        storagePath: 'documents/a/general.pdf',
        filename: 'general.pdf',
      },
      {
        kind: 'resume',
        storagePath: 'documents/b/acme-tailored.pdf',
        filename: 'acme-tailored.pdf',
      },
    ];
    const bank = [
      {
        normalizedLabel: 'resume cv',
        value: 'documents/b/acme-tailored.pdf',
        company: 'acme',
      },
    ];

    // Acme's pick applies for acme...
    const forAcme = resolveAnswers([question], profile, {
      documents,
      bank,
      company: 'acme',
    });
    expect(forAcme.resolved[0]?.value).toBe('documents/b/acme-tailored.pdf');

    // ...but another company falls back to kind-matching (first resume).
    const forGlobex = resolveAnswers([question], profile, {
      documents,
      bank,
      company: 'globex',
    });
    expect(forGlobex.resolved[0]?.value).toBe('documents/a/general.pdf');
  });

  it('selectBankValue keeps first-entry-wins semantics within each scope', () => {
    const first = {
      normalizedLabel: essayLabel,
      value: 'first',
      company: 'acme',
    };
    const second = {
      normalizedLabel: essayLabel,
      value: 'second',
      company: 'acme',
    };
    expect(selectBankValue(essay, [first, second], 'acme')).toBe('first');

    const globalFirst = { normalizedLabel: essayLabel, value: 'g-first' };
    const globalSecond = { normalizedLabel: essayLabel, value: 'g-second' };
    expect(selectBankValue(essay, [globalFirst, globalSecond], undefined)).toBe(
      'g-first',
    );
    // No matching label at all -> undefined (never fabricates).
    expect(
      selectBankValue(q({ id: 'q_other', label: 'Other question' }), [first]),
    ).toBeUndefined();
  });
});

describe('documents', () => {
  const resumeDoc = {
    kind: 'resume',
    storagePath: 'documents/aaaa-1111/jane-doe-resume.pdf',
    filename: 'jane-doe-resume.pdf',
  };
  const coverDoc = {
    kind: 'cover_letter',
    storagePath: 'documents/bbbb-2222/jane-doe-cover.pdf',
    filename: 'jane-doe-cover.pdf',
  };

  it("resolves the standard resume file question from a stored 'resume' document", () => {
    const question = q({ id: 'resume', label: 'Resume/CV', type: 'file' });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc],
    });
    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      {
        questionId: 'resume',
        source: 'document',
        value: 'documents/aaaa-1111/jane-doe-resume.pdf',
      },
    ]);
  });

  it.each([
    'Resume/CV',
    'CV',
    'Upload your resume',
  ])('detects a resume file question by label %j', (label) => {
    const question = q({ id: 'q_file', label, type: 'file' });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc],
    });
    expect(result.resolved).toEqual([
      {
        questionId: 'q_file',
        source: 'document',
        value: 'documents/aaaa-1111/jane-doe-resume.pdf',
      },
    ]);
  });

  it("resolves a cover letter file question from a stored 'cover_letter' document", () => {
    const question = q({
      id: 'cover_letter',
      label: 'Cover Letter',
      type: 'file',
      required: false,
    });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc, coverDoc],
    });
    expect(result.resolved).toEqual([
      {
        questionId: 'cover_letter',
        source: 'document',
        value: 'documents/bbbb-2222/jane-doe-cover.pdf',
      },
    ]);
  });

  it('sends a resume question to missing when no resume document exists', () => {
    const question = q({ id: 'resume', label: 'Resume/CV', type: 'file' });
    const result = resolveAnswers([question], profile, {
      documents: [coverDoc],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends unrecognized file questions to missing even when documents exist', () => {
    // 'Portfolio deck' is neither a resume nor a cover letter; attaching a
    // resume to it would be untruthful.
    const question = q({
      id: 'q_deck',
      label: 'Portfolio deck',
      type: 'file',
    });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc, coverDoc],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('sends a file question that ambiguously names both kinds to missing', () => {
    const question = q({
      id: 'q_file',
      label: 'Resume or Cover Letter',
      type: 'file',
    });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc, coverDoc],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
  });

  it('never attaches a document to a non-file question', () => {
    // Greenhouse pairs each file field with a *_text textarea of the same
    // label; a storage path must never be pasted into it.
    const question = q({
      id: 'resume_text',
      label: 'Resume/CV',
      type: 'textarea',
    });
    const result = resolveAnswers([question], profile, {
      documents: [resumeDoc],
    });
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([question]);
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

describe('resolveAnswers — milestone fixes', () => {
  it('bank round-trip: a select answered by option VALUE resolves (dashboard stores values)', () => {
    const question = q({
      id: 'q_referral',
      label: 'How did you hear about us?',
      type: 'select',
      options: [
        { label: 'LinkedIn', value: '101' },
        { label: 'Referral', value: '102' },
      ],
    });
    const result = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: 'how did you hear about us', value: '102' }],
    });
    expect(result.missing).toEqual([]);
    expect(result.resolved[0]).toEqual({
      questionId: 'q_referral',
      source: 'bank',
      value: '102',
    });
  });

  it('bank round-trip: a select answered by option LABEL still resolves', () => {
    const question = q({
      id: 'q_referral',
      label: 'Referral source',
      type: 'select',
      options: [
        { label: 'LinkedIn', value: '101' },
        { label: 'Referral', value: '102' },
      ],
    });
    const result = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: 'referral source', value: 'Referral' }],
    });
    expect(result.resolved[0]?.value).toBe('102');
  });

  it('bank value matching nothing goes to missing (no fabrication)', () => {
    const question = q({
      id: 'q_referral',
      label: 'Referral source',
      type: 'select',
      options: [{ label: 'LinkedIn', value: '101' }],
    });
    const result = resolveAnswers([question], profile, {
      bank: [{ normalizedLabel: 'referral source', value: '999' }],
    });
    expect(result.missing).toEqual([question]);
  });

  it('sponsorship regex does NOT answer a relocation question that mentions sponsorship', () => {
    const question = q({
      id: 'q_reloc',
      label: 'Are you able to relocate to Germany after visa sponsorship?',
      type: 'select',
      options: [
        { label: 'Yes', value: '1' },
        { label: 'No', value: '2' },
      ],
    });
    const result = resolveAnswers([question], profile);
    expect(result.missing).toEqual([question]);
  });

  it('plain sponsorship yes/no still resolves from the profile boolean', () => {
    const question = q({
      id: 'q_spon',
      label: 'Will you require visa sponsorship?',
      type: 'select',
      options: [
        { label: 'Yes', value: '1' },
        { label: 'No', value: '2' },
      ],
    });
    const result = resolveAnswers([question], profile);
    // profile.requiresSponsorship === false -> 'No' -> value '2'
    expect(result.resolved[0]?.value).toBe('2');
  });

  it('file question honors an explicit document pick over kind-matching', () => {
    const question = q({
      id: 'resume',
      label: 'Resume/CV',
      type: 'file',
    });
    const documents = [
      {
        kind: 'resume',
        storagePath: 'documents/a/first.pdf',
        filename: 'first.pdf',
      },
      {
        kind: 'resume',
        storagePath: 'documents/b/second.pdf',
        filename: 'second.pdf',
      },
    ];
    const result = resolveAnswers([question], profile, {
      documents,
      bank: [{ normalizedLabel: 'resume cv', value: 'documents/b/second.pdf' }],
    });
    expect(result.resolved[0]).toEqual({
      questionId: 'resume',
      source: 'document',
      value: 'documents/b/second.pdf',
    });
  });

  it('file question auto-resolves by kind when no explicit pick', () => {
    const question = q({ id: 'resume', label: 'Resume/CV', type: 'file' });
    const result = resolveAnswers([question], profile, {
      documents: [
        {
          kind: 'resume',
          storagePath: 'documents/a/only.pdf',
          filename: 'only.pdf',
        },
      ],
    });
    expect(result.resolved[0]?.value).toBe('documents/a/only.pdf');
  });
});

describe('resolveAnswers — jsonb numeric coercion', () => {
  it('resolves a select when the bank value is a NUMBER (jsonb round-trip)', () => {
    const question = q({
      id: 'q_school',
      label: 'What school do you currently attend?',
      type: 'select',
      options: [
        { label: 'Yale University', value: 731269089 },
        { label: 'Other', value: 731269090 },
      ],
    });
    // The answers bank stores option values; postgres jsonb returns them as
    // numbers, not the original strings.
    const result = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'what school do you currently attend',
          value: 731269090 as unknown as string,
        },
      ],
    });
    expect(result.resolved[0]).toEqual({
      questionId: 'q_school',
      source: 'bank',
      value: '731269090',
    });
  });

  it('resolves a multiselect with numeric bank values', () => {
    const question = q({
      id: 'q_grad',
      label: 'Expected graduation',
      type: 'multiselect',
      options: [
        { label: 'Spring 2027', value: 731269094 },
        { label: 'Fall 2027', value: 731269095 },
      ],
    });
    const result = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'expected graduation',
          value: [731269094] as unknown as string[],
        },
      ],
    });
    expect(result.resolved[0]?.value).toEqual(['731269094']);
  });
});

describe('resolveAnswers — Ashby system field ids', () => {
  it('resolves Ashby _systemfield_* standard fields from the profile', () => {
    const questions: Question[] = [
      q({ id: '_systemfield_name', label: 'Legal Name' }),
      q({ id: '_systemfield_email', label: 'Email' }),
      q({
        id: '_systemfield_location',
        label: 'Where do you plan on working from?',
      }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.missing).toEqual([]);
    const byId = Object.fromEntries(
      result.resolved.map((r) => [r.questionId, r.value]),
    );
    expect(byId._systemfield_name).toBe('Jane Doe');
    expect(byId._systemfield_email).toBe('jane.doe@example.com');
    expect(byId._systemfield_location).toBe('Princeton, NJ');
  });

  it('resolves an Ashby resume file (_systemfield_resume) from a document', () => {
    const question = q({
      id: '_systemfield_resume',
      label: 'Resume',
      type: 'file',
    });
    const result = resolveAnswers([question], profile, {
      documents: [
        { kind: 'resume', storagePath: 'documents/a/r.pdf', filename: 'r.pdf' },
      ],
    });
    expect(result.resolved[0]).toEqual({
      questionId: '_systemfield_resume',
      source: 'document',
      value: 'documents/a/r.pdf',
    });
  });
});

describe('resolveAnswers — jsonb boolean coercion (Ashby Yes/No)', () => {
  it('resolves a Boolean select when the bank value is a BOOLEAN', () => {
    const question = q({
      id: 'ashby_bool',
      label: 'Do you have 2+ years experience?',
      type: 'select',
      options: [
        { label: 'Yes', value: 'true' },
        { label: 'No', value: 'false' },
      ],
    });
    // jsonb returns 'true'/'false' select answers as JS booleans.
    const yes = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'do you have 2 years experience',
          value: true as unknown as string,
        },
      ],
    });
    expect(yes.resolved[0]?.value).toBe('true');
    const no = resolveAnswers([question], profile, {
      bank: [
        {
          normalizedLabel: 'do you have 2 years experience',
          value: false as unknown as string,
        },
      ],
    });
    expect(no.resolved[0]?.value).toBe('false');
  });
});

describe('resolveAnswers — curated answer bank stage', () => {
  const answerBank: AnswerBank = {
    version: 1,
    entries: [
      {
        key: 'gpa',
        aliases: ['what is your cumulative gpa'],
        strategy: { type: 'numericRange', source: 'education.0.gpa' },
      },
      {
        // Deliberate trap: if the bank ever outranked the direct profile
        // stages, 'Email' would resolve to this wrong literal.
        key: 'email_trap',
        aliases: ['email'],
        strategy: { type: 'literal', value: 'trap@wrong.example' },
      },
      {
        key: 'eeo_gender',
        aliases: [],
        strategy: { type: 'decline' },
      },
    ],
  };

  const gpaOptions = [
    { label: 'Below 3.0', value: 'b30' },
    { label: '3.0 - 3.5', value: 'b35' },
    { label: '3.6 - 4.0', value: 'b40' },
  ];
  const gpaQuestion = q({
    id: 'q_gpa',
    label: 'What is your cumulative GPA?',
    type: 'select',
    options: gpaOptions,
  });

  it('resolves a range select via the bank with source profile (only when passed)', () => {
    const without = resolveAnswers([gpaQuestion], profile);
    expect(without.missing).toEqual([gpaQuestion]);

    const withBank = resolveAnswers([gpaQuestion], profile, { answerBank });
    expect(withBank.missing).toEqual([]);
    expect(withBank.resolved).toEqual([
      { questionId: 'q_gpa', source: 'profile', value: 'b40' },
    ]);
  });

  it('runs AFTER the direct profile stages (they win on conflict)', () => {
    const question = q({ id: 'q_email', label: 'Email' });
    const result = resolveAnswers([question], profile, { answerBank });
    expect(result.resolved).toEqual([
      {
        questionId: 'q_email',
        source: 'profile',
        value: 'jane.doe@example.com',
      },
    ]);
  });

  it('runs BEFORE the user bank, which still catches what the bank cannot', () => {
    // Curated bank beats a conflicting user-bank entry...
    const both = resolveAnswers([gpaQuestion], profile, {
      answerBank,
      bank: [{ normalizedLabel: 'what is your cumulative gpa', value: 'b30' }],
    });
    expect(both.resolved).toEqual([
      { questionId: 'q_gpa', source: 'profile', value: 'b40' },
    ]);

    // ...but when the bank has no truthful bucket (gap: 3.9 fits nothing
    // here), the user's explicitly saved answer still resolves.
    const gapQuestion = q({
      id: 'q_gpa_gap',
      label: 'What is your cumulative GPA?',
      type: 'select',
      options: [
        { label: 'Over 3.9', value: 'over' },
        { label: '3.8 - 3.89', value: 'b389' },
      ],
    });
    const fallthrough = resolveAnswers([gapQuestion], profile, {
      answerBank,
      bank: [{ normalizedLabel: 'what is your cumulative gpa', value: 'over' }],
    });
    expect(fallthrough.resolved).toEqual([
      { questionId: 'q_gpa_gap', source: 'bank', value: 'over' },
    ]);
  });

  it('routes Greenhouse compliance ids to the eeo decline entries', () => {
    const question = q({
      id: 'gender',
      label: 'Gender (voluntary self-identification)',
      type: 'select',
      options: [
        { label: 'Male', value: '1' },
        { label: 'Female', value: '2' },
        { label: 'Decline To Self Identify', value: '3' },
      ],
    });
    const result = resolveAnswers([question], profile, { answerBank });
    expect(result.resolved).toEqual([
      { questionId: 'gender', source: 'profile', value: '3' },
    ]);
  });
});

describe('resolveAnswers — non-US-country guard (truthfulness)', () => {
  it('never answers non-US sponsorship/right-to-work from US-scoped booleans', () => {
    // Live Marshall Wace question: profile says requiresSponsorship: false,
    // but that boolean is US-scoped — answering 'No' for the UK would be a
    // fabricated claim. Must go to a human.
    const questions: Question[] = [
      q({
        id: 'q_uk_sponsor',
        label:
          'Would you now, or in the future, require sponsorship to work in the UK?',
        type: 'select',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      }),
      q({
        id: 'q_uk_auth',
        label: 'Are you authorized to work in the United Kingdom?',
      }),
    ];
    const result = resolveAnswers(questions, profile);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual(questions);
  });

  it('still answers the US phrasings', () => {
    const result = resolveAnswers(
      [
        q({
          id: 'q_us_auth',
          label: 'Are you authorized to work in the United States?',
        }),
      ],
      profile,
    );
    expect(result.resolved).toEqual([
      { questionId: 'q_us_auth', source: 'profile', value: 'Yes' },
    ]);
  });
});

describe('auth detail guard (review fix)', () => {
  it('does not answer work-authorization expiry/type questions as yes/no', () => {
    for (const label of [
      'When does your work authorization expire?',
      'Will your work authorization expire during your employment?',
      'What type of work authorization do you have?',
    ]) {
      const result = resolveAnswers(
        [q({ id: 'auth', label, type: 'text' })],
        profile,
      );
      expect(result.resolved).toEqual([]);
    }
  });
});
