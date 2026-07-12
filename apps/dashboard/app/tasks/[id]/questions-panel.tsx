// Question list shared between the read-only server rendering and the
// interactive NEEDS_INPUT client form. No directive: pure presentation +
// plain HTML form controls (names are read by the saveAnswers server
// action), so it composes in either environment.
import type { CSSProperties } from 'react';
import { BORDER, Empty, ExpandableText, MONO, MUTED } from '../../../lib/ui';
import { Badge, FAINT, INPUT_BG, INPUT_BORDER } from './ui';

export interface QuestionOptionView {
  label: string;
  value: string;
}

export interface QuestionView {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'file' | 'select' | 'multiselect';
  required: boolean;
  options: QuestionOptionView[];
  docKind: 'resume' | 'cover_letter' | 'other';
  /**
   * 'resolved': has an answer in the stored resolution.
   * 'missing': listed in resolution.missing (renders an input when the panel
   *            is interactive).
   * 'unknown': no resolution stored yet (task not processed).
   */
  status: 'resolved' | 'missing' | 'unknown';
  resolvedSource?: string;
  /** Display-ready values (option labels / document filenames). */
  resolvedValues?: string[];
}

export interface DocumentOption {
  id: string;
  kind: string;
  filename: string;
  createdLabel: string;
}

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  profile: { bg: '#16283f', fg: '#93c5fd' },
  bank: { bg: '#2a2140', fg: '#c4b5fd' },
  default: { bg: '#26262b', fg: '#9ca3af' },
  user: { bg: '#3a2f14', fg: '#fbbf24' },
  document: { bg: '#143322', fg: '#4ade80' },
};

const FALLBACK_SOURCE_COLOR = { bg: '#26262b', fg: '#9ca3af' };

const rowStyle: CSSProperties = {
  padding: '0.75rem 0',
  borderBottom: `1px solid ${BORDER}`,
};

const labelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
  flexWrap: 'wrap',
  marginBottom: '0.375rem',
};

const inputStyle: CSSProperties = {
  backgroundColor: INPUT_BG,
  border: `1px solid ${INPUT_BORDER}`,
  borderRadius: '0.375rem',
  color: '#d7dae0',
  fontSize: '0.875rem',
  padding: '0.375rem 0.5rem',
  width: '100%',
  maxWidth: '32rem',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

function SourceChip({ source }: { source: string }) {
  const color = SOURCE_COLORS[source] ?? FALLBACK_SOURCE_COLOR;
  return (
    <Badge bg={color.bg} fg={color.fg} title={`answer source: ${source}`}>
      {source}
    </Badge>
  );
}

function ResolvedValue({ view }: { view: QuestionView }) {
  const values = view.resolvedValues ?? [];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ fontSize: '0.875rem', minWidth: 0, flex: '1 1 16rem' }}>
        {values.length === 0 ? (
          <span style={{ color: FAINT }}>—</span>
        ) : values.length === 1 && values[0] !== undefined ? (
          <ExpandableText text={values[0]} max={200} />
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {values.map((v) => (
              <li key={v}>
                <ExpandableText text={v} max={200} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {view.resolvedSource ? <SourceChip source={view.resolvedSource} /> : null}
    </div>
  );
}

/**
 * Scope control for essay (text/textarea) answers: unchecked (default) the
 * saveAnswers action stores the answer for this task's company only; checked
 * it is stored globally. Rendered only when the task has a company.
 */
function EssayScopeChoice({
  questionId,
  company,
}: {
  questionId: string;
  company: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        marginTop: '0.375rem',
        maxWidth: '32rem',
        fontSize: '0.75rem',
        color: MUTED,
        cursor: 'pointer',
      }}
    >
      <input type="checkbox" name={`global:${questionId}`} value="1" />
      <span>
        reuse for all companies — otherwise this answer is saved for{' '}
        <strong style={{ color: '#c4b5fd' }}>{company}</strong> only
      </span>
    </label>
  );
}

function MissingInput({
  view,
  documents,
  scopeCompany,
}: {
  view: QuestionView;
  documents: DocumentOption[];
  scopeCompany?: string;
}) {
  const inputId = `q-${view.id}`;

  if (view.type === 'file') {
    const kindLabel = view.docKind.replace('_', ' ');
    const matching = documents.filter((d) => d.kind === view.docKind);
    return (
      <div style={{ display: 'grid', gap: '0.375rem', maxWidth: '32rem' }}>
        {matching.length > 0 ? (
          <>
            <label
              htmlFor={`doc-${view.id}`}
              style={{ fontSize: '0.75rem', color: MUTED }}
            >
              use an existing {kindLabel} document
            </label>
            <select
              id={`doc-${view.id}`}
              name={`doc:${view.id}`}
              defaultValue=""
              style={inputStyle}
            >
              <option value="">— none —</option>
              {matching.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename} ({d.createdLabel})
                </option>
              ))}
            </select>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: '0.75rem', color: FAINT }}>
            no stored {kindLabel} documents yet — upload one below.
          </p>
        )}
        <label
          htmlFor={`file-${view.id}`}
          style={{ fontSize: '0.75rem', color: MUTED }}
        >
          or upload a new file
        </label>
        <input
          id={`file-${view.id}`}
          name={`file:${view.id}`}
          type="file"
          style={{ fontSize: '0.8rem' }}
        />
        {view.docKind === 'other' ? (
          <p style={{ margin: 0, fontSize: '0.7rem', color: FAINT }}>
            uploads are stored in the vault, but only resume / cover letter
            questions are auto-attached on requeue.
          </p>
        ) : null}
      </div>
    );
  }

  if (view.type === 'select') {
    return (
      <select
        id={inputId}
        name={`q:${view.id}`}
        defaultValue=""
        aria-required={view.required}
        style={inputStyle}
      >
        <option value="">— select —</option>
        {view.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (view.type === 'multiselect') {
    return (
      <fieldset
        style={{
          border: `1px solid ${INPUT_BORDER}`,
          borderRadius: '0.375rem',
          padding: '0.5rem 0.75rem',
          margin: 0,
          maxWidth: '32rem',
          display: 'grid',
          gap: '0.25rem',
        }}
      >
        <legend
          style={{ fontSize: '0.7rem', color: MUTED, padding: '0 0.25rem' }}
        >
          select all that apply
        </legend>
        {view.options.length === 0 ? (
          <span style={{ fontSize: '0.75rem', color: FAINT }}>
            no options provided by the platform.
          </span>
        ) : (
          view.options.map((o) => (
            <label
              key={o.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
              }}
            >
              <input type="checkbox" name={`q:${view.id}`} value={o.value} />
              {o.label}
            </label>
          ))
        )}
      </fieldset>
    );
  }

  if (view.type === 'textarea') {
    return (
      <div>
        <textarea
          id={inputId}
          name={`q:${view.id}`}
          rows={4}
          maxLength={20000}
          aria-required={view.required}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
        {scopeCompany ? (
          <EssayScopeChoice questionId={view.id} company={scopeCompany} />
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <input
        id={inputId}
        name={`q:${view.id}`}
        type="text"
        maxLength={20000}
        aria-required={view.required}
        style={inputStyle}
      />
      {scopeCompany ? (
        <EssayScopeChoice questionId={view.id} company={scopeCompany} />
      ) : null}
    </div>
  );
}

export function QuestionsPanel({
  views,
  interactive = false,
  documents = [],
  scopeCompany,
}: {
  views: QuestionView[];
  /** When true, missing questions render form controls (NEEDS_INPUT form). */
  interactive?: boolean;
  documents?: DocumentOption[];
  /**
   * The task's company (display name). When set, interactive essay inputs
   * offer the company-scoped/global save choice.
   */
  scopeCompany?: string;
}) {
  if (views.length === 0) {
    return <Empty>the job spec contains no questions.</Empty>;
  }
  return (
    <div>
      {views.map((view) => (
        <div key={view.id} style={rowStyle}>
          <div style={labelRowStyle}>
            <label
              htmlFor={
                interactive &&
                view.status === 'missing' &&
                view.type !== 'file' &&
                view.type !== 'multiselect'
                  ? `q-${view.id}`
                  : undefined
              }
              style={{ fontSize: '0.875rem', fontWeight: 600 }}
            >
              {view.label}
            </label>
            <span
              style={{ fontSize: '0.7rem', color: FAINT, fontFamily: MONO }}
            >
              {view.id} · {view.type}
            </span>
            {view.required ? (
              <Badge bg="#3a1a1a" fg="#f87171">
                required
              </Badge>
            ) : (
              <Badge bg="#26262b" fg="#9ca3af">
                optional
              </Badge>
            )}
          </div>
          {view.status === 'resolved' ? (
            <ResolvedValue view={view} />
          ) : view.status === 'missing' ? (
            interactive ? (
              <MissingInput
                view={view}
                documents={documents}
                scopeCompany={scopeCompany}
              />
            ) : (
              <span style={{ fontSize: '0.8rem', color: '#fbbf24' }}>
                unanswered
              </span>
            )
          ) : (
            <span style={{ fontSize: '0.8rem', color: FAINT }}>
              not yet resolved — the task has not been processed.
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
