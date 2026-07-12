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
}: {
  taskId: string;
  views: QuestionView[];
  documents: DocumentOption[];
}) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_previous, formData) => saveAnswers(taskId, formData), null);

  return (
    <form action={formAction}>
      <QuestionsPanel views={views} interactive documents={documents} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginTop: '1rem',
        }}
      >
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
          style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}
        >
          Save answers
        </button>
        <button
          type="submit"
          name="intent"
          value="save_requeue"
          disabled={pending}
          style={{
            ...buttonStyle,
            backgroundColor: '#143322',
            color: '#4ade80',
            opacity: pending ? 0.6 : 1,
          }}
        >
          Save &amp; requeue
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
