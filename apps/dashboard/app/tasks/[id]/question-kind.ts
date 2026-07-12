import { normalizeLabel } from '@sower/answers';

export type DocumentKind = 'resume' | 'cover_letter' | 'other';

/**
 * Which stored-document kind a file question maps to. Mirrors the
 * @sower/answers resolution rule (documentKindForFileQuestion): standard
 * field id, or whole words in the normalized label — never substrings.
 * Ambiguous questions (mentioning both resume and cover letter) and
 * unrecognized uploads map to 'other', which resolution never auto-attaches.
 */
export function documentKind(question: {
  id: string;
  label: string;
}): DocumentKind {
  const label = normalizeLabel(question.label);
  const words = label.split(' ');
  const indicatesResume =
    question.id === 'resume' ||
    words.includes('resume') ||
    words.includes('cv');
  const indicatesCoverLetter =
    question.id === 'cover_letter' || /\bcover letter\b/.test(label);
  if (indicatesResume && indicatesCoverLetter) return 'other';
  if (indicatesResume) return 'resume';
  if (indicatesCoverLetter) return 'cover_letter';
  return 'other';
}
