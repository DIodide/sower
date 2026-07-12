import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, QuestionOption } from '@sower/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AnswerBank,
  DEFAULT_ANSWER_BANK_PATH,
  getProfilePath,
  loadAnswerBank,
  resolveFromAnswerBank,
} from './answer-bank.js';
import type { Profile } from './profile.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROFILE: Profile = {
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
  custom: {},
};

/**
 * Build a profile with extra/overridden fields. `extra` is untyped on
 * purpose: the optional graduation/academics/preferences fields land in
 * ProfileSchema separately, and the engine traverses dot-paths generically,
 * so these tests must not depend on the schema change ordering. It also
 * lets tests inject deliberately-wrong shapes (a TODO string where a number
 * belongs) to prove the engine refuses them.
 */
function makeProfile(extra: Record<string, unknown> = {}): Profile {
  return { ...structuredClone(BASE_PROFILE), ...extra } as Profile;
}

function q(
  partial: Partial<Question> & Pick<Question, 'id' | 'label'>,
): Question {
  return { type: 'text', required: true, ...partial };
}

/** Options with distinct numeric values so tests prove we submit VALUES. */
function opts(labels: string[]): QuestionOption[] {
  return labels.map((label, i) => ({ label, value: 1000 + i }));
}

/** The option value the engine must submit for `label`. */
function optionValue(options: QuestionOption[], label: string): string {
  const hit = options.find((o) => o.label === label);
  if (hit === undefined) throw new Error(`no option labeled ${label}`);
  return String(hit.value);
}

function bankWith(entries: AnswerBank['entries']): AnswerBank {
  return { version: 1, entries };
}

const GPA_SELECT_BANK = bankWith([
  {
    key: 'gpa',
    aliases: [
      'what is your gpa',
      'what is your current cumulative gpa',
      'For your most recent degree, what is/was your GPA (normalized to a 4.0 scale)?',
    ],
    strategy: { type: 'numericRange', source: 'education.0.gpa' },
  },
]);

// ---------------------------------------------------------------------------
// getProfilePath
// ---------------------------------------------------------------------------

describe('getProfilePath', () => {
  const profile = makeProfile();

  it('reads nested fields and array indices', () => {
    expect(getProfilePath(profile, 'name.first')).toBe('Jane');
    expect(getProfilePath(profile, 'education.0.gpa')).toBe(3.9);
    expect(getProfilePath(profile, 'authorization.requiresSponsorship')).toBe(
      false,
    );
  });

  it('returns undefined for missing paths', () => {
    expect(getProfilePath(profile, 'education.5.gpa')).toBeUndefined();
    expect(getProfilePath(profile, 'graduation.date')).toBeUndefined();
    expect(getProfilePath(profile, 'name.first.extra')).toBeUndefined();
    expect(getProfilePath(profile, '')).toBeUndefined();
  });

  it('rejects non-numeric segments on arrays and prototype members', () => {
    expect(getProfilePath(profile, 'education.first.gpa')).toBeUndefined();
    expect(getProfilePath(profile, 'name.toString')).toBeUndefined();
    expect(getProfilePath(profile, '__proto__.polluted')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadAnswerBank
// ---------------------------------------------------------------------------

describe('loadAnswerBank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'answer-bank-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function writeYaml(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('parses and validates a well-formed bank', () => {
    const path = writeYaml(
      'ok.yaml',
      [
        'version: 1',
        'entries:',
        '  - key: gpa',
        '    aliases:',
        '      - "what is your gpa"',
        '    strategy: { type: numericRange, source: "education.0.gpa" }',
        '  - key: eeo_gender',
        '    strategy: { type: decline }',
      ].join('\n'),
    );
    const bank = loadAnswerBank(path);
    expect(bank.version).toBe(1);
    expect(bank.entries).toHaveLength(2);
    expect(bank.entries[0]?.strategy.type).toBe('numericRange');
    // aliases defaults to [] for id-matched entries.
    expect(bank.entries[1]?.aliases).toEqual([]);
  });

  it('throws a clear error for a missing file', () => {
    expect(() => loadAnswerBank(join(dir, 'nope.yaml'))).toThrow(
      /Failed to read answer bank file/,
    );
  });

  it('throws a clear error for invalid YAML', () => {
    const path = writeYaml('bad-syntax.yaml', 'version: [unclosed');
    expect(() => loadAnswerBank(path)).toThrow(/not valid YAML/);
  });

  it('throws a clear error for schema violations', () => {
    const path = writeYaml(
      'bad-schema.yaml',
      [
        'version: 1',
        'entries:',
        '  - key: gpa',
        '    strategy: { type: guessRandomly }',
      ].join('\n'),
    );
    expect(() => loadAnswerBank(path)).toThrow(/invalid/);
  });

  it('rejects unknown versions', () => {
    const path = writeYaml('bad-version.yaml', 'version: 2\nentries: []');
    expect(() => loadAnswerBank(path)).toThrow(/invalid/);
  });

  it('accepts a literal strategy with a source instead of a value', () => {
    const path = writeYaml(
      'literal-source.yaml',
      [
        'version: 1',
        'entries:',
        '  - key: grad_year',
        '    aliases: ["what year are you expected to graduate"]',
        '    strategy: { type: literal, source: "graduation.year" }',
      ].join('\n'),
    );
    const bank = loadAnswerBank(path);
    expect(bank.entries[0]?.strategy).toEqual({
      type: 'literal',
      source: 'graduation.year',
    });
  });

  it('rejects a literal strategy with both or neither of value/source', () => {
    const both = writeYaml(
      'literal-both.yaml',
      [
        'version: 1',
        'entries:',
        '  - key: bad',
        '    strategy: { type: literal, value: "x", source: "name.first" }',
      ].join('\n'),
    );
    expect(() => loadAnswerBank(both)).toThrow(
      /exactly one of 'value' or 'source'/,
    );
    const neither = writeYaml(
      'literal-neither.yaml',
      [
        'version: 1',
        'entries:',
        '  - key: bad',
        '    strategy: { type: literal }',
      ].join('\n'),
    );
    expect(() => loadAnswerBank(neither)).toThrow(
      /exactly one of 'value' or 'source'/,
    );
  });

  it('loads the committed sample bank at DEFAULT_ANSWER_BANK_PATH', () => {
    const bank = loadAnswerBank(DEFAULT_ANSWER_BANK_PATH);
    expect(bank.version).toBe(1);
    expect(bank.entries.length).toBeGreaterThanOrEqual(20);
  });

  it('exposes a default path at the repo config root', () => {
    expect(DEFAULT_ANSWER_BANK_PATH).toMatch(
      /\/config\/answer-bank\.sample\.yaml$/,
    );
    expect(DEFAULT_ANSWER_BANK_PATH).not.toContain('packages');
  });
});

// ---------------------------------------------------------------------------
// Alias / id matching
// ---------------------------------------------------------------------------

describe('resolveFromAnswerBank: entry matching', () => {
  it('matches any alias after normalization (dedup across wordings)', () => {
    const options = opts(['Below 3.2', '3.41 - 3.5', 'Over 3.9', '3.6-4.0']);
    for (const label of [
      'What is your GPA?',
      'What is your current cumulative GPA?',
      'For your most recent degree, what is/was your GPA (normalized to a 4.0 scale)?',
    ]) {
      const answer = resolveFromAnswerBank(
        q({ id: 'q1', label, type: 'select', options }),
        makeProfile(),
        GPA_SELECT_BANK,
      );
      expect(answer).toEqual({
        questionId: 'q1',
        source: 'profile',
        value: optionValue(options, '3.6-4.0'),
      });
    }
  });

  it('returns null for labels the bank does not know', () => {
    const answer = resolveFromAnswerBank(
      q({ id: 'q1', label: 'Describe your greatest achievement' }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    expect(answer).toBeNull();
  });

  it('never answers file questions', () => {
    const bank = bankWith([
      {
        key: 'resume',
        aliases: ['resume'],
        strategy: { type: 'literal', value: 'x' },
      },
    ]);
    expect(
      resolveFromAnswerBank(
        q({ id: 'resume', label: 'Resume', type: 'file' }),
        makeProfile(),
        bank,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// numericRange
// ---------------------------------------------------------------------------

describe('numericRange strategy', () => {
  it('picks the single GPA bucket containing 3.9 (coarse buckets)', () => {
    const options = opts(['Below 3.2', '3.41 - 3.5', 'Over 3.9', '3.6-4.0']);
    const answer = resolveFromAnswerBank(
      q({ id: 'gpa', label: 'What is your GPA?', type: 'select', options }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    // 3.9 is NOT "Over 3.9" (exclusive) and 3.6-4.0 is the only bucket
    // containing it.
    expect(answer?.value).toBe(optionValue(options, '3.6-4.0'));
  });

  it('picks the exact fine bucket from the live 10-bucket GPA select', () => {
    const options = opts([
      'Below 3.2',
      '3.21 - 3.3',
      '3.31 - 3.4',
      '3.41 - 3.5',
      '3.51 - 3.6',
      '3.61 - 3.7',
      '3.71 - 3.8',
      '3.81 - 3.9',
      '3.91 - 4.0',
      'Above 4.0',
    ]);
    const answer = resolveFromAnswerBank(
      q({ id: 'gpa', label: 'What is your GPA?', type: 'select', options }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, '3.81 - 3.9'));
  });

  it('resolves nothing when the value falls in a bucket gap', () => {
    // Live set: "Over 3.9" is exclusive and "3.8 - 3.89" tops out below 3.9,
    // so a 3.9 GPA has no truthful bucket here.
    const options = opts(['Over 3.9', '3.8 - 3.89', '3.7 - 3.79', 'Below 3.0']);
    const answer = resolveFromAnswerBank(
      q({ id: 'gpa', label: 'What is your GPA?', type: 'select', options }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    expect(answer).toBeNull();
  });

  it('resolves nothing when overlapping buckets are ambiguous', () => {
    const options = opts(['3.5 - 4.0', '3.8 - 4.0']);
    const answer = resolveFromAnswerBank(
      q({ id: 'gpa', label: 'What is your GPA?', type: 'select', options }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    expect(answer).toBeNull();
  });

  it('handles SAT buckets including "<1200" and skips "I don\'t have..."', () => {
    const bank = bankWith([
      {
        key: 'sat',
        aliases: ['provide your best result on sat'],
        strategy: { type: 'numericRange', source: 'academics.satTotal' },
      },
    ]);
    const options = opts([
      "I don't have SAT score",
      '<1200',
      '1201 - 1300',
      '1301 - 1400',
      '1401 - 1500',
      '1501 - 1600',
    ]);
    const question = q({
      id: 'sat',
      label: 'Provide your best result on SAT',
      type: 'select',
      options,
    });
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ academics: { satTotal: 1500 } }),
        bank,
      )?.value,
    ).toBe(optionValue(options, '1401 - 1500'));
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ academics: { satTotal: 1100 } }),
        bank,
      )?.value,
    ).toBe(optionValue(options, '<1200'));
    // No SAT score in the profile -> never answer (in particular, never
    // pick "I don't have SAT score", which may be false).
    expect(resolveFromAnswerBank(question, makeProfile(), bank)).toBeNull();
  });

  it('handles year buckets ("2029 or later", "Before 2023")', () => {
    const bank = bankWith([
      {
        key: 'grad_year',
        aliases: ['what year are you expected to graduate'],
        strategy: { type: 'numericRange', source: 'graduation.year' },
      },
    ]);
    const options = opts([
      'Before 2023',
      '2026',
      '2027',
      '2028',
      '2029 or later',
    ]);
    const question = q({
      id: 'gy',
      label: 'What year are you expected to graduate?',
      type: 'select',
      options,
    });
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { year: 2028 } }),
        bank,
      )?.value,
    ).toBe(optionValue(options, '2028'));
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { year: 2030 } }),
        bank,
      )?.value,
    ).toBe(optionValue(options, '2029 or later'));
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { year: 2021 } }),
        bank,
      )?.value,
    ).toBe(optionValue(options, 'Before 2023'));
  });

  it('never resolves from a TODO or missing source value', () => {
    const options = opts(['Below 3.2', '3.6-4.0']);
    const question = q({
      id: 'gpa',
      label: 'What is your GPA?',
      type: 'select',
      options,
    });
    const todoProfile = makeProfile({
      education: [{ ...BASE_PROFILE.education[0], gpa: 'TODO: fill in' }],
    });
    expect(
      resolveFromAnswerBank(question, todoProfile, GPA_SELECT_BANK),
    ).toBeNull();
    const missingProfile = makeProfile({
      education: [{ ...BASE_PROFILE.education[0], gpa: undefined }],
    });
    expect(
      resolveFromAnswerBank(question, missingProfile, GPA_SELECT_BANK),
    ).toBeNull();
  });

  it('fills a text question with the exact number', () => {
    const answer = resolveFromAnswerBank(
      q({ id: 'gpa', label: 'What is your GPA?', type: 'text' }),
      makeProfile(),
      GPA_SELECT_BANK,
    );
    expect(answer?.value).toBe('3.9');
  });

  describe('gpa band fallback (exact GPA unknown, band known)', () => {
    const bandProfile = makeProfile({
      education: [{ ...BASE_PROFILE.education[0], gpa: undefined }],
      academics: { gpaBandLow: 3.7 },
    });

    it('resolves a coarse bucket that contains the whole band', () => {
      // Live options: NA (with a trailing non-breaking space), "< 3.0",
      // "3.0 -3.5" (irregular spacing), "3.6-4.0".
      const options = opts(['NA\u00a0', '< 3.0', '3.0 -3.5', '3.6-4.0']);
      const answer = resolveFromAnswerBank(
        q({
          id: 'gpa',
          label:
            'For your most recent degree, what is/was your GPA (normalized to a 4.0 scale)?',
          type: 'select',
          options,
        }),
        bandProfile,
        GPA_SELECT_BANK,
      );
      // The band [3.7, 4.0] fits entirely inside 3.6-4.0, so this answer is
      // guaranteed true even without the exact GPA.
      expect(answer?.value).toBe(optionValue(options, '3.6-4.0'));
    });

    it('resolves nothing for fine buckets narrower than the band', () => {
      const options = opts([
        'Below 3.2',
        '3.61 - 3.7',
        '3.71 - 3.8',
        '3.81 - 3.9',
        '3.91 - 4.0',
      ]);
      const answer = resolveFromAnswerBank(
        q({ id: 'gpa', label: 'What is your GPA?', type: 'select', options }),
        bandProfile,
        GPA_SELECT_BANK,
      );
      // We do not know WHICH fine bucket the real GPA lands in -> no answer.
      expect(answer).toBeNull();
    });

    it('never fills a text question from a band (no exact number)', () => {
      const answer = resolveFromAnswerBank(
        q({ id: 'gpa', label: 'What is your GPA?', type: 'text' }),
        bandProfile,
        GPA_SELECT_BANK,
      );
      expect(answer).toBeNull();
    });

    it('supports explicit band sources on non-gpa fields', () => {
      const bank = bankWith([
        {
          key: 'sat',
          aliases: ['provide your best result on sat'],
          strategy: {
            type: 'numericRange',
            source: 'academics.satTotal',
            bandLowSource: 'academics.satBandLow',
            bandHigh: 1600,
          },
        },
      ]);
      const options = opts(['<1200', '1201 - 1400', '1401 - 1600']);
      const answer = resolveFromAnswerBank(
        q({
          id: 'sat',
          label: 'Provide your best result on SAT',
          type: 'select',
          options,
        }),
        makeProfile({ academics: { satBandLow: 1450 } }),
        bank,
      );
      expect(answer?.value).toBe(optionValue(options, '1401 - 1600'));
    });
  });
});

// ---------------------------------------------------------------------------
// dateRange
// ---------------------------------------------------------------------------

describe('dateRange strategy', () => {
  const GRAD_BANK = bankWith([
    {
      key: 'grad_date',
      aliases: [
        'when is your anticipated graduation date please select a graduation date range',
        'when is your expected graduation date',
      ],
      strategy: { type: 'dateRange', source: 'graduation.date' },
    },
  ]);
  const gradProfile = makeProfile({ graduation: { date: '2028-05' } });

  it('picks the month-range bucket containing 2028-05 (live options)', () => {
    const options = opts([
      "I've already graduated",
      'July 2026 - December 2026',
      'January 2027 - June 2027',
      'July 2027 - December 2027',
      'January 2028 - June 2028',
      'July 2028 - December 2028',
      'January 2029 - June 2029',
    ]);
    const answer = resolveFromAnswerBank(
      q({
        id: 'gd',
        label:
          'When is your anticipated graduation date? Please select a graduation date range.',
        type: 'select',
        options,
      }),
      gradProfile,
      GRAD_BANK,
    );
    expect(answer?.value).toBe(
      optionValue(options, 'January 2028 - June 2028'),
    );
  });

  it('picks the single month on a multiselect and wraps it in an array', () => {
    const options = opts([
      'December 2027',
      'May 2028',
      'June 2028',
      'December 2028',
      'May 2029',
    ]);
    const answer = resolveFromAnswerBank(
      q({
        id: 'gd',
        label: 'When is your expected graduation date?',
        type: 'multiselect',
        options,
      }),
      gradProfile,
      GRAD_BANK,
    );
    expect(answer?.value).toEqual([optionValue(options, 'May 2028')]);
  });

  it('picks whole-year and "or later" buckets', () => {
    const options = opts(['2026', '2027', '2028', '2029 or later']);
    const question = q({
      id: 'gd',
      label: 'When is your expected graduation date?',
      type: 'select',
      options,
    });
    expect(resolveFromAnswerBank(question, gradProfile, GRAD_BANK)?.value).toBe(
      optionValue(options, '2028'),
    );
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { date: '2030-06' } }),
        GRAD_BANK,
      )?.value,
    ).toBe(optionValue(options, '2029 or later'));
  });

  it('resolves nothing when two buckets contain the date (ambiguous)', () => {
    const options = opts(['2028', 'January 2028 - June 2028']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'gd',
        label: 'When is your expected graduation date?',
        type: 'select',
        options,
      }),
      gradProfile,
      GRAD_BANK,
    );
    expect(answer).toBeNull();
  });

  it('resolves nothing for missing, TODO, or malformed profile dates', () => {
    const options = opts(['2027', '2028']);
    const question = q({
      id: 'gd',
      label: 'When is your expected graduation date?',
      type: 'select',
      options,
    });
    expect(
      resolveFromAnswerBank(question, makeProfile(), GRAD_BANK),
    ).toBeNull();
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { date: 'TODO' } }),
        GRAD_BANK,
      ),
    ).toBeNull();
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ graduation: { date: 'May 2028' } }),
        GRAD_BANK,
      ),
    ).toBeNull();
  });

  it('fills a text question with the profile date verbatim', () => {
    const answer = resolveFromAnswerBank(
      q({ id: 'gd', label: 'When is your expected graduation date?' }),
      gradProfile,
      GRAD_BANK,
    );
    expect(answer?.value).toBe('2028-05');
  });
});

// ---------------------------------------------------------------------------
// booleanYesNo
// ---------------------------------------------------------------------------

describe('booleanYesNo strategy', () => {
  const AUTH_BANK = bankWith([
    {
      key: 'work_authorized_us',
      aliases: [
        'are you legally authorized to work in the united states',
        // Inverse phrasing: "authorized ... WITHOUT sponsorship?" is still
        // truthfully Yes for an authorized, no-sponsorship profile, so the
        // curator maps it to the same boolean.
        'are you authorized to work in the united states without sponsorship',
      ],
      strategy: {
        type: 'booleanYesNo',
        source: 'authorization.usWorkAuthorized',
      },
    },
    {
      key: 'requires_sponsorship',
      aliases: [
        'will you now or in the future require sponsorship for employment visa status',
        'will you require immigration sponsorship to begin working for imc',
      ],
      strategy: {
        type: 'booleanYesNo',
        source: 'authorization.requiresSponsorship',
      },
    },
  ]);

  it('resolves true -> the exact Yes option', () => {
    const options = opts(['Yes', 'No']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'auth',
        label: 'Are you legally authorized to work in the United States?',
        type: 'select',
        options,
      }),
      makeProfile(),
      AUTH_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, 'Yes'));
  });

  it('resolves false -> the exact No option, never Maybe (3-option case)', () => {
    const options = opts(['Yes', 'No', 'Maybe/I don’t know']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'sponsor',
        label:
          'Will you require immigration sponsorship to begin working for IMC?',
        type: 'select',
        options,
      }),
      makeProfile(),
      AUTH_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, 'No'));
  });

  it('handles inverse phrasing via the curated alias truthfully', () => {
    const options = opts(['Yes', 'No']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'auth2',
        label:
          'Are you authorized to work in the United States without sponsorship?',
        type: 'select',
        options,
      }),
      makeProfile(),
      AUTH_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, 'Yes'));
  });

  it('fills text questions with Yes/No', () => {
    const answer = resolveFromAnswerBank(
      q({
        id: 'auth',
        label: 'Are you legally authorized to work in the United States?',
      }),
      makeProfile(),
      AUTH_BANK,
    );
    expect(answer?.value).toBe('Yes');
  });

  it('never resolves from a non-boolean or missing source', () => {
    const options = opts(['Yes', 'No']);
    const question = q({
      id: 'auth',
      label: 'Are you legally authorized to work in the United States?',
      type: 'select',
      options,
    });
    // A string 'yes' is not a profile boolean -> no answer.
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ authorization: { usWorkAuthorized: 'yes' } }),
        AUTH_BANK,
      ),
    ).toBeNull();
    expect(
      resolveFromAnswerBank(
        question,
        makeProfile({ authorization: {} }),
        AUTH_BANK,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decline (EEO / demographics)
// ---------------------------------------------------------------------------

describe('decline strategy', () => {
  const EEO_BANK = bankWith([
    { key: 'eeo_gender', aliases: [], strategy: { type: 'decline' } },
    { key: 'eeo_race', aliases: [], strategy: { type: 'decline' } },
    { key: 'eeo_veteran', aliases: [], strategy: { type: 'decline' } },
    { key: 'eeo_disability', aliases: [], strategy: { type: 'decline' } },
    {
      key: 'eeo_ethnicity',
      aliases: [
        'what is your race ethnicity',
        'which most closely describes your gender',
      ],
      strategy: { type: 'decline' },
    },
  ]);

  it('matches Greenhouse compliance ids and picks the decline option', () => {
    const gender = opts(['Decline To Self Identify', 'Female', 'Male']);
    expect(
      resolveFromAnswerBank(
        q({ id: 'gender', label: 'Gender', type: 'select', options: gender }),
        makeProfile(),
        EEO_BANK,
      )?.value,
    ).toBe(optionValue(gender, 'Decline To Self Identify'));

    const veteran = opts([
      "I don't wish to answer",
      'I identify as one or more of the classifications of a protected veteran',
      'I am not a protected veteran',
    ]);
    expect(
      resolveFromAnswerBank(
        q({
          id: 'veteran_status',
          label: 'Veteran Status',
          type: 'select',
          options: veteran,
        }),
        makeProfile(),
        EEO_BANK,
      )?.value,
    ).toBe(optionValue(veteran, "I don't wish to answer"));

    const disability = opts([
      'I do not want to answer',
      'No, I do not have a disability and have not had one in the past',
      'Yes, I have a disability, or have had one in the past',
    ]);
    expect(
      resolveFromAnswerBank(
        q({
          id: 'disability_status',
          label: 'Disability Status',
          type: 'select',
          options: disability,
        }),
        makeProfile(),
        EEO_BANK,
      )?.value,
    ).toBe(optionValue(disability, 'I do not want to answer'));
  });

  it('matches demographic multiselects by alias and wraps the value', () => {
    const options = opts([
      'Asian',
      'White',
      'Two or More Races',
      "I don't wish to answer",
    ]);
    const answer = resolveFromAnswerBank(
      q({
        id: 'demographic_question_4005629101[]',
        label: 'What is your race/ethnicity?',
        type: 'multiselect',
        options,
      }),
      makeProfile(),
      EEO_BANK,
    );
    expect(answer?.value).toEqual([
      optionValue(options, "I don't wish to answer"),
    ]);
  });

  it('recognizes "Prefer not to..." phrasings', () => {
    const options = opts(['Woman', 'Man', 'Non-Binary', 'Prefer not to state']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'question_37007686002',
        label: 'Which most closely describes your gender?',
        type: 'select',
        options,
      }),
      makeProfile(),
      EEO_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, 'Prefer not to state'));
  });

  it('never picks "I prefer to self-describe" or guesses when no decline option exists', () => {
    const options = opts(['Man', 'Woman', 'I prefer to self-describe']);
    const answer = resolveFromAnswerBank(
      q({ id: 'gender', label: 'Gender', type: 'select', options }),
      makeProfile(),
      EEO_BANK,
    );
    expect(answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// choice and literal
// ---------------------------------------------------------------------------

describe('choice strategy', () => {
  const HEARD_BANK = bankWith([
    {
      key: 'how_did_you_hear',
      aliases: ['how did you hear about this job', 'how did you hear about us'],
      strategy: {
        type: 'choice',
        prefer: ['Other', 'Job board', 'LinkedIn Jobs'],
      },
    },
  ]);

  it('picks the first preferred label that exists among the options', () => {
    const options = opts(['LinkedIn Jobs', 'Job board', 'Referral']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'hear',
        label: 'How did you hear about us?',
        type: 'select',
        options,
      }),
      makeProfile(),
      HEARD_BANK,
    );
    // 'Other' is absent -> 'Job board' wins over the later 'LinkedIn Jobs'.
    expect(answer?.value).toBe(optionValue(options, 'Job board'));
  });

  it('resolves nothing when no preferred label exists or for text questions', () => {
    expect(
      resolveFromAnswerBank(
        q({
          id: 'hear',
          label: 'How did you hear about us?',
          type: 'select',
          options: opts(['Referral', 'Campus event']),
        }),
        makeProfile(),
        HEARD_BANK,
      ),
    ).toBeNull();
    expect(
      resolveFromAnswerBank(
        q({ id: 'hear', label: 'How did you hear about us?' }),
        makeProfile(),
        HEARD_BANK,
      ),
    ).toBeNull();
  });
});

describe('literal strategy', () => {
  const CONSENT_BANK = bankWith([
    {
      key: 'privacy_consent',
      aliases: [
        'privacy statement',
        'i hereby certify that all information in my application is true and complete',
      ],
      strategy: { type: 'literal', value: 'I Agree' },
    },
  ]);

  it('matches select options case-insensitively via normalization', () => {
    const options = opts(['I agree']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'consent',
        label: 'Privacy Statement',
        type: 'select',
        options,
      }),
      makeProfile(),
      CONSENT_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, 'I agree'));
  });

  it('fills text questions verbatim and skips selects without a match', () => {
    expect(
      resolveFromAnswerBank(
        q({ id: 'consent', label: 'Privacy Statement' }),
        makeProfile(),
        CONSENT_BANK,
      )?.value,
    ).toBe('I Agree');
    expect(
      resolveFromAnswerBank(
        q({
          id: 'consent',
          label: 'Privacy Statement',
          type: 'select',
          options: opts(['Acknowledged and understood']),
        }),
        makeProfile(),
        CONSENT_BANK,
      ),
    ).toBeNull();
  });
});

describe('literal strategy from a profile source', () => {
  const SOURCE_BANK = bankWith([
    {
      key: 'grad_year',
      aliases: ['what year are you expected to graduate'],
      strategy: { type: 'literal', source: 'graduation.year' },
    },
    {
      key: 'school_attended',
      aliases: ['what school do you currently attend'],
      strategy: { type: 'literal', source: 'education.0.school' },
    },
    {
      key: 'relocation_as_literal',
      aliases: ['are you open to relocation'],
      strategy: { type: 'literal', source: 'preferences.openToRelocation' },
    },
  ]);

  it('emits the profile string verbatim for text questions', () => {
    const answer = resolveFromAnswerBank(
      q({ id: 'school', label: 'What school do you currently attend?' }),
      makeProfile(),
      SOURCE_BANK,
    );
    expect(answer).toEqual({
      questionId: 'school',
      source: 'profile',
      value: 'Example University',
    });
  });

  it('renders numeric facts as strings so year selects match', () => {
    const options = opts(['2027', '2028', '2029 or later']);
    const answer = resolveFromAnswerBank(
      q({
        id: 'grad',
        label: 'What year are you expected to graduate?',
        type: 'select',
        options,
      }),
      makeProfile({ graduation: { year: 2028 } }),
      SOURCE_BANK,
    );
    expect(answer?.value).toBe(optionValue(options, '2028'));
  });

  it('resolves nothing for missing, TODO, or boolean facts', () => {
    // Missing: base profile has no graduation.year.
    expect(
      resolveFromAnswerBank(
        q({ id: 'grad', label: 'What year are you expected to graduate?' }),
        makeProfile(),
        SOURCE_BANK,
      ),
    ).toBeNull();
    // TODO placeholder is an unfilled slot, not a fact.
    const todoEducation = structuredClone(BASE_PROFILE).education;
    if (todoEducation[0]) todoEducation[0].school = 'TODO';
    expect(
      resolveFromAnswerBank(
        q({ id: 'school', label: 'What school do you currently attend?' }),
        makeProfile({ education: todoEducation }),
        SOURCE_BANK,
      ),
    ).toBeNull();
    // Booleans are booleanYesNo territory; literal never renders them.
    expect(
      resolveFromAnswerBank(
        q({ id: 'reloc', label: 'Are you open to relocation?' }),
        makeProfile({ preferences: { openToRelocation: true } }),
        SOURCE_BANK,
      ),
    ).toBeNull();
  });
});

describe('answer bank — review fixes (truthfulness)', () => {
  const bank = loadAnswerBank(DEFAULT_ANSWER_BANK_PATH);
  const YN = [
    { label: 'Yes', value: 'Yes' },
    { label: 'No', value: 'No' },
  ];
  const q = (label: string, type: string = 'select', options?: unknown) =>
    ({ id: 'x', label, type, required: true, options }) as never;
  const profile = (requiresSponsorship: boolean) =>
    ({
      name: { first: 'J', last: 'D' },
      email: 'e',
      phone: 'p',
      location: { city: 'c', state: 's', country: 'USA' },
      links: {},
      education: [],
      work: [],
      authorization: { usWorkAuthorized: true, requiresSponsorship },
      custom: {},
    }) as never;

  it('compound "authorized without sponsorship" resolves Yes only when no sponsorship needed', () => {
    const question = q(
      'Are you authorized to work in the United States without sponsorship?',
      'select',
      YN,
    );
    expect(resolveFromAnswerBank(question, profile(false), bank)?.value).toBe(
      'Yes',
    );
    // F-1 student (authorized but needs sponsorship) must NOT get a false Yes.
    expect(resolveFromAnswerBank(question, profile(true), bank)).toBeNull();
  });

  it('does not fill an "employment eligibility status" text field', () => {
    expect(
      resolveFromAnswerBank(
        q('Employment Eligibility Status', 'text'),
        profile(false),
        bank,
      ),
    ).toBeNull();
  });
});
