import { describe, expect, it, vi } from 'vitest';
import {
  type CalypsoFillClient,
  type CalypsoResume,
  fillViaCalypso,
} from './calypso-fill.js';

/** A fake calypso client recording section fills + resume uploads. */
function fakeClient(
  over: Partial<CalypsoFillClient> & { sessionOk?: boolean } = {},
): CalypsoFillClient & {
  sections: string[];
  resumeUploads: CalypsoResume[];
} {
  const sections: string[] = [];
  const resumeUploads: CalypsoResume[] = [];
  return {
    sections,
    resumeUploads,
    checkSession: vi.fn(async () => over.sessionOk ?? true),
    startApplication: vi.fn(async () => ({ jobApplicationId: 'JAID-1' })),
    fillSection: vi.fn(async (_j, section) => {
      sections.push(section);
      return {};
    }),
    validate: vi.fn(async () => {}),
    getQuestionnaireFields: vi.fn(async () => []),
    uploadResume: vi.fn(async (_j, resume) => {
      resumeUploads.push(resume);
    }),
    ...over,
  };
}

const applicant = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+1 555 0100',
};

const RESUME: CalypsoResume = {
  fileName: 'resume.pdf',
  contentType: 'application/pdf',
  bytes: new Uint8Array([1, 2, 3, 4]),
};

describe('fillViaCalypso — resume attachment', () => {
  it('uploads the resume and records it as a filled section', async () => {
    const client = fakeClient();
    const result = await fillViaCalypso(client, {
      jobSlug: 'SWE_1',
      applicant,
      resume: RESUME,
      resolveQuestionnaireAnswers: () => ({}),
    });

    expect(client.uploadResume).toHaveBeenCalledWith('JAID-1', RESUME);
    expect(client.resumeUploads).toEqual([RESUME]);
    expect(result.sectionsFilled).toContain('resume');
    expect(result.sectionErrors).toEqual([]);
    // GUARDRAIL preserved: still stops before submit.
    expect(result.stoppedBeforeSubmit).toBe(true);
  });

  it('skips the resume section when none is provided', async () => {
    const client = fakeClient();
    const result = await fillViaCalypso(client, {
      jobSlug: 'SWE_1',
      applicant,
      resolveQuestionnaireAnswers: () => ({}),
    });

    expect(client.uploadResume).not.toHaveBeenCalled();
    expect(result.sectionsFilled).not.toContain('resume');
  });

  it('records a section error (never throws) when the upload fails', async () => {
    const client = fakeClient({
      uploadResume: vi.fn(async () => {
        throw new Error('attachments 500');
      }),
    });
    const result = await fillViaCalypso(client, {
      jobSlug: 'SWE_1',
      applicant,
      resume: RESUME,
      resolveQuestionnaireAnswers: () => ({}),
    });

    // A failed resume upload is best-effort: recorded, not fatal.
    expect(result.sectionsFilled).not.toContain('resume');
    expect(result.sectionErrors).toEqual([
      { section: 'resume', error: 'attachments 500' },
    ]);
    expect(result.stoppedBeforeSubmit).toBe(true);
  });
});
