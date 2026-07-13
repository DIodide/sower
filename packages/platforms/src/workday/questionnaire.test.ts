import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseQuestionnaireDefinition } from './questionnaire.js';

// Real datasite questionnaire definition captured live from the authenticated
// calypso API (POST .../questionnaire/{id}/definition), 2026-07-12.
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixture-questionnaire-definition.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

describe('parseQuestionnaireDefinition (real datasite fixture)', () => {
  const fields = parseQuestionnaireDefinition(fixture);

  it('extracts all six questions in schema order', () => {
    expect(fields.map((f) => f.label)).toEqual([
      'Are you legally authorized to work in the country for which you have applied?',
      'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B status)?',
      'Do you have a non-compete or non-solicit clause that could impact your ability to work in the position for which you have applied?',
      'Please provide a copy of the document.',
      'What are your salary expectations in the local currency you are applying?',
      'What is your notice period?',
    ]);
  });

  it('maps schema types to controls (object->select, string->text, upload->file)', () => {
    const byLabel = new Map(fields.map((f) => [f.label, f]));
    expect(byLabel.get('What is your notice period?')?.control).toBe('text');
    expect(
      byLabel.get(
        'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B status)?',
      )?.control,
    ).toBe('select');
    expect(byLabel.get('Please provide a copy of the document.')?.control).toBe(
      'file',
    );
  });

  it('strips HTML from labels', () => {
    const notice = fields.find((f) => f.label.includes('notice period'));
    expect(notice?.label).toBe('What is your notice period?');
    expect(notice?.label).not.toContain('<p>');
  });

  it('treats the hidden document upload as conditional and not required', () => {
    const doc = fields.find((f) => f.label.includes('provide a copy'));
    expect(doc?.conditional).toBe(true);
    // It is in the schema's `required` list, but hidden -> not enforced upfront.
    expect(doc?.required).toBe(false);
  });

  it('marks visible required questions as required', () => {
    const auth = fields.find((f) => f.label.includes('legally authorized'));
    expect(auth?.required).toBe(true);
    expect(auth?.conditional).toBe(false);
  });

  it('flags choice questions as needing option resolution', () => {
    const sponsorship = fields.find((f) => f.label.includes('sponsorship'));
    expect(sponsorship?.control).toBe('select');
    expect(sponsorship?.needsOptions).toBe(true);
    // A text question does not need options.
    const salary = fields.find((f) => f.label.includes('salary'));
    expect(salary?.needsOptions).toBe(false);
  });

  it('orders sub-questions correctly (c before c.a before d)', () => {
    const orders = fields.map((f) => f.order);
    expect(orders).toEqual(['a', 'b', 'c', 'c.a', 'd', 'e']);
  });

  it('returns [] for an empty/absent definition', () => {
    expect(parseQuestionnaireDefinition({})).toEqual([]);
    expect(
      parseQuestionnaireDefinition({
        definitions: { primaryQuestionnaire: {} },
      }),
    ).toEqual([]);
  });

  it('drops read-only fields', () => {
    const parsed = parseQuestionnaireDefinition({
      definitions: {
        primaryQuestionnaire: {
          required: [],
          properties: {
            ro: {
              label: 'read only',
              type: 'string',
              readOnly: true,
              order: 'a',
            },
            ok: { label: 'answer me', type: 'string', order: 'b' },
          },
        },
      },
    });
    expect(parsed.map((f) => f.id)).toEqual(['ok']);
  });
});

import { parseWorkdayQuestionnaire } from './questionnaire.js';

const caciFixture = JSON.parse(
  readFileSync(
    new URL('./fixture-questionnaire-caci.json', import.meta.url),
    'utf8',
  ),
) as { questions?: unknown[] };

describe('parseWorkdayQuestionnaire (real CACI GET response, with options + branching)', () => {
  const fields = parseWorkdayQuestionnaire(caciFixture);

  it('extracts every question with its option GUIDs', () => {
    const usPerson = fields.find((f) =>
      f.label.startsWith('Are you a U.S. Person'),
    );
    expect(usPerson?.control).toBe('select');
    expect(usPerson?.options).toEqual([
      { id: 'ca4e30f2955901bb987d6239f6013691', descriptor: 'Yes' },
      expect.objectContaining({ descriptor: 'No' }),
      expect.objectContaining({ descriptor: 'I choose not to disclose' }),
    ]);
    expect(usPerson?.required).toBe(true);
  });

  it('flattens a branching question as a conditional field with its trigger', () => {
    // "Are you a U.S. Person?" -> "Yes" reveals the clearance-citizen question.
    const branch = fields.find((f) =>
      f.label.startsWith('For purposes of obtaining a U.S. security clearance'),
    );
    expect(branch).toBeDefined();
    expect(branch?.conditional).toBe(true);
    expect(branch?.required).toBe(false); // not enforced until revealed
    expect(branch?.branchTrigger).toEqual({
      questionId: 'cabee52113e4100107ab2328610e0002',
      answerId: 'ca4e30f2955901bb987d6239f6013691', // the 'Yes' option
    });
  });

  it('captures multi-option questions (salary ranges, clearance agencies)', () => {
    const salary = fields.find((f) => f.label.includes('desired salary'));
    expect(salary?.options?.length).toBe(10);
    expect(salary?.options?.map((o) => o.descriptor)).toContain(
      '$100,000-$120,000',
    );
  });

  it('has more fields than top-level questions (branches included)', () => {
    // 9 top-level + at least the one branch.
    expect(fields.length).toBeGreaterThanOrEqual(10);
  });
});
