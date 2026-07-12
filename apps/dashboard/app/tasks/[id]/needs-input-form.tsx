'use client';

import { useActionState } from 'react';
import { MUTED } from '../../../lib/ui';
import type { ActionResult } from './actions';
import { saveAnswers } from './actions';
import type { DocumentOption, QuestionView } from './questions-panel';
import { QuestionsPanel } from './questions-panel';

const buttonStyle = {
  backgroundColor: '#16283f',
  color: '#93c5fd',
  border: '1px solid #2a3145',
  borderRadius: '0.375rem',
  padding: '0.375rem 0.875rem',
  fontSize: '0.8rem',
  fontWeight: 600,
  cursor: 'pointer',
} as const;

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

  return (
    <form action={formAction}>
      <QuestionsPanel
        views={views}
        interactive
        documents={documents}
        scopeCompany={company}
      />
      <p
        style={{
          margin: '1rem 0 0.5rem',
          fontSize: '0.78rem',
          color: MUTED,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: '#93c5fd' }}>Save answers</strong> stores your
        answers on this task but leaves it here in Needs&nbsp;Input — nothing
        re-runs, so you can fill things in over several visits.
        {company ? (
          <>
            {' '}
            Written (essay) answers are saved for{' '}
            <strong style={{ color: '#c4b5fd' }}>{company}</strong> only unless
            you tick “reuse for all companies”.
          </>
        ) : null}{' '}
        <strong style={{ color: '#4ade80' }}>Save &amp; re-run</strong> also
        re-processes the task: it re-checks every required question, and if
        they&rsquo;re all answered it advances to <em>Review</em> (where you
        approve the dry-run submission). Use it when you&rsquo;ve finished
        answering.
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginTop: '0.25rem',
        }}
      >
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
          title="Store your answers and stay on this task (no re-processing)"
          style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}
        >
          Save answers
        </button>
        <button
          type="submit"
          name="intent"
          value="save_requeue"
          disabled={pending}
          title="Store your answers and re-process the task — advances to Review if all required questions are answered"
          style={{
            ...buttonStyle,
            backgroundColor: '#143322',
            color: '#4ade80',
            opacity: pending ? 0.6 : 1,
          }}
        >
          Save &amp; re-run
        </button>
        {pending ? (
          <span style={{ fontSize: '0.8rem', color: MUTED }}>saving…</span>
        ) : null}
      </div>
      {result ? (
        <p
          role="status"
          style={{
            marginTop: '0.75rem',
            marginBottom: 0,
            fontSize: '0.8rem',
            color: result.ok ? '#4ade80' : '#f87171',
            wordBreak: 'break-word',
          }}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
