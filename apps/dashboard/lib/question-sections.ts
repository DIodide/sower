/**
 * Which section of the task page a question belongs in.
 *
 * The dividing line is not whether an answer exists — it is whether the
 * answer was looked up or written. Name, email, country, school, degree
 * and the yes/no compliance questions repeat unchanged across every
 * application: once resolved they are a fact to skim, so they collapse
 * under Auto-filled. Prose written for one job does not repeat, even when
 * the answer bank happens to have it from a previous application, so it
 * stays where it can be read in full and revised.
 */

export interface SectionQuestion {
  status: 'resolved' | 'saved' | 'missing' | 'unknown';
  type: 'text' | 'textarea' | 'file' | 'select' | 'multiselect';
  /** Present only on questions the form caps the length of — always prose. */
  limit?: { kind: 'characters' | 'words'; max: number } | undefined;
}

/** Prose: a free-text box, or anything the form gave a length cap. */
export function isJobSpecificProse(question: SectionQuestion): boolean {
  return question.type === 'textarea' || question.limit !== undefined;
}

/**
 * True when an already-resolved question should still be shown editable
 * next to the unanswered ones rather than collapsed away: prose written for
 * this job, and file questions — which document goes to which company is a
 * per-application choice, and the auto-pick is only a default.
 */
export function staysAnswerable(question: SectionQuestion): boolean {
  return (
    question.status === 'resolved' &&
    (isJobSpecificProse(question) || question.type === 'file')
  );
}
