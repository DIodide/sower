'use client';

import { useActionState } from 'react';
import type { ActionResult } from './actions';
import { saveAnswers } from './actions';
import type { DocumentOption, QuestionView } from './questions-panel';
import { QuestionsPanel } from './questions-panel';

export function NeedsInputForm({
  taskId,
  views,
  documents,
  company,
}: {
  taskId: string;
  views: QuestionView[];
  documents: DocumentOption[];
  /** The task's company (display name); '' when unknown. */
  company?: string;
}) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_previous, formData) => saveAnswers(taskId, formData), null);

  const requiredMissing = views.filter(
    (v) => v.status === 'missing' && v.required,
  ).length;

  return (
    <form action={formAction}>
      <QuestionsPanel
        views={views}
        interactive
        documents={documents}
        scopeCompany={company}
      />

      <hr className="divider-soft" />

      <div className="row">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
          className="btn"
          title="Store your answers and stay on this task (no re-processing)"
        >
          Save answers
        </button>
        <button
          type="submit"
          name="intent"
          value="save_requeue"
          disabled={pending}
          className="btn btn--primary"
          title="Store your answers and re-process the task — advances to Ready to review once every required question is answered"
        >
          Save &amp; re-run
        </button>
        {pending ? <span className="hint">Saving…</span> : null}
      </div>

      <p className="hint" style={{ margin: '0.75rem 0 0', maxWidth: '44rem' }}>
        <strong>Save answers</strong> keeps the task here so you can fill things
        in over several visits. <strong>Save &amp; re-run</strong> also
        re-processes it
        {requiredMissing > 0
          ? ` — it moves on to review once all ${requiredMissing} remaining required question${requiredMissing === 1 ? ' is' : 's are'} answered.`
          : ' — with every required question answered, it should move on to review.'}
        {company ? (
          <>
            {' '}
            Essay answers are saved for <strong>{company}</strong> only, unless
            you tick “reuse for all companies”.
          </>
        ) : null}
      </p>

      {result ? (
        <p
          role="status"
          className={result.ok ? 'status-ok' : 'status-err'}
          style={{ margin: '0.75rem 0 0', wordBreak: 'break-word' }}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
