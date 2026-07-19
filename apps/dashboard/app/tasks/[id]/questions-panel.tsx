// Question list shared between the read-only server rendering and the
// interactive NEEDS_INPUT client form. No directive: pure presentation +
// plain HTML form controls (names are read by the saveAnswers server
// action), so it composes in either environment.
//
// Layout: questions waiting on the user come first (required before
// optional), auto-filled answers are grouped behind them so the eye lands on
// what still needs doing.
import type { Tone } from '../../../lib/format';
import { Empty, ExpandableText } from '../../../lib/ui';
import { Badge } from './ui';

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
  /** Branch/conditional question — only applies based on a prior answer. */
  conditional?: boolean;
  /** Human hint under the label (e.g. which parent answer reveals this one). */
  help?: string;
}

export interface DocumentOption {
  id: string;
  kind: string;
  filename: string;
  createdLabel: string;
}

/** Human name + tone for each answer source. */
const SOURCE_META: Record<string, { label: string; tone: Tone | 'accent' }> = {
  profile: { label: 'from profile', tone: 'progress' },
  bank: { label: 'from answer bank', tone: 'accent' },
  user: { label: 'from you', tone: 'attention' },
  document: { label: 'document', tone: 'success' },
  default: { label: 'default', tone: 'neutral' },
};

function SourceChip({ source }: { source: string }) {
  const meta = SOURCE_META[source] ?? {
    label: source,
    tone: 'neutral' as const,
  };
  return (
    <Badge tone={meta.tone} title={`answer source: ${source}`}>
      {meta.label}
    </Badge>
  );
}

function ResolvedValue({ view }: { view: QuestionView }) {
  const values = view.resolvedValues ?? [];
  return (
    <div className="row" style={{ alignItems: 'baseline' }}>
      <div className="q-value" style={{ minWidth: 0, flex: '1 1 16rem' }}>
        {values.length === 0 ? (
          <span className="faint">—</span>
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
      className="hint"
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        marginTop: '0.4rem',
        maxWidth: '34rem',
        cursor: 'pointer',
      }}
    >
      <input type="checkbox" name={`global:${questionId}`} value="1" />
      <span>
        Reuse this answer for all companies — otherwise it is saved for{' '}
        <strong>{company}</strong> only.
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
      <div style={{ display: 'grid', gap: '0.4rem', maxWidth: '34rem' }}>
        {matching.length > 0 ? (
          <>
            <label htmlFor={`doc-${view.id}`} className="field-label">
              Use a stored {kindLabel}
            </label>
            <select
              id={`doc-${view.id}`}
              name={`doc:${view.id}`}
              defaultValue=""
              className="field"
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
          <p className="hint" style={{ margin: 0 }}>
            No stored {kindLabel} yet — upload one below.
          </p>
        )}
        <label htmlFor={`file-${view.id}`} className="field-label">
          {matching.length > 0 ? 'Or upload a new file' : 'Upload a file'}
        </label>
        <input id={`file-${view.id}`} name={`file:${view.id}`} type="file" />
        {view.docKind === 'other' ? (
          <p className="hint faint" style={{ margin: 0, fontSize: '0.75rem' }}>
            Uploads are stored in the vault, but only resume / cover letter
            questions are auto-attached on re-run.
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
        className="field"
        style={{ maxWidth: '34rem' }}
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
        className="well"
        style={{
          border: 'none',
          margin: 0,
          maxWidth: '34rem',
          display: 'grid',
          gap: '0.375rem',
          padding: '0.5rem 0.625rem',
        }}
      >
        <legend className="field-label" style={{ padding: 0 }}>
          Select all that apply
        </legend>
        {view.options.length === 0 ? (
          <span className="hint">No options provided by the platform.</span>
        ) : (
          view.options.map((o) => (
            <label
              key={o.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.9rem',
                cursor: 'pointer',
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
          className="field"
          style={{ maxWidth: '34rem' }}
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
        className="field"
        style={{ maxWidth: '34rem' }}
      />
      {scopeCompany ? (
        <EssayScopeChoice questionId={view.id} company={scopeCompany} />
      ) : null}
    </div>
  );
}

function QuestionRow({
  view,
  interactive,
  documents,
  scopeCompany,
}: {
  view: QuestionView;
  interactive: boolean;
  documents: DocumentOption[];
  scopeCompany?: string;
}) {
  return (
    <div
      className="q-row"
      style={
        // Conditional (branch) questions are visually nested under their
        // parent with a left rule, so a long questionnaire reads as a tree.
        view.conditional
          ? {
              marginLeft: '0.75rem',
              paddingLeft: '0.75rem',
              borderLeft: '2px solid var(--line)',
            }
          : undefined
      }
    >
      <div className="q-label-row">
        <label
          className="q-label"
          title={`${view.id} · ${view.type}`}
          htmlFor={
            interactive &&
            view.status === 'missing' &&
            view.type !== 'file' &&
            view.type !== 'multiselect'
              ? `q-${view.id}`
              : undefined
          }
        >
          {view.label}
        </label>
        {view.conditional ? (
          <Badge tone="neutral" title="Only applies based on a prior answer">
            conditional
          </Badge>
        ) : null}
        {view.status === 'missing' ? (
          view.required ? (
            <Badge tone="danger">required</Badge>
          ) : (
            <Badge tone="neutral">optional</Badge>
          )
        ) : null}
      </div>
      {view.help ? (
        <p
          className="hint faint"
          style={{ margin: '0.15rem 0 0.35rem', fontSize: '0.78rem' }}
        >
          {view.help}
        </p>
      ) : null}
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
          <span className="hint faint">No answer yet.</span>
        )
      ) : (
        <span className="hint faint">
          Not resolved yet — the task has not been processed.
        </span>
      )}
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
    return <Empty>The job spec contains no questions.</Empty>;
  }

  // Stable partition: required-missing first, then optional-missing.
  const missing = [...views.filter((v) => v.status === 'missing')].sort(
    (a, b) => Number(b.required) - Number(a.required),
  );
  const resolved = views.filter((v) => v.status === 'resolved');
  const unknown = views.filter((v) => v.status === 'unknown');

  const rowProps = { interactive, documents, scopeCompany };

  const missingSection =
    missing.length > 0 ? (
      <section aria-label="unanswered questions">
        <h3
          className="section-title"
          style={{ margin: '0.5rem 0 0.25rem', fontSize: '0.95rem' }}
        >
          {interactive ? 'Waiting on you' : 'Unanswered'}{' '}
          <span className="count">{missing.length}</span>
          {!interactive && missing.every((v) => !v.required) ? (
            <span className="hint" style={{ fontWeight: 600 }}>
              all optional — left blank on purpose
            </span>
          ) : null}
        </h3>
        {missing.map((view) => (
          <QuestionRow key={view.id} view={view} {...rowProps} />
        ))}
      </section>
    ) : null;

  const resolvedSection =
    resolved.length > 0 ? (
      interactive ? (
        // While answering, auto-filled answers stay collapsed so the eye
        // lands on what still needs doing.
        <details style={{ marginTop: missing.length > 0 ? '1.25rem' : 0 }}>
          <summary
            className="section-title"
            style={{
              margin: '0.5rem 0 0.25rem',
              fontSize: '0.95rem',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            Auto-filled <span className="count">{resolved.length}</span>
            <span className="hint" style={{ fontWeight: 600 }}>
              worth a skim before you approve
            </span>
          </summary>
          {resolved.map((view) => (
            <QuestionRow key={view.id} view={view} {...rowProps} />
          ))}
        </details>
      ) : (
        <section aria-label="answered questions">
          <h3
            className="section-title"
            style={{ margin: '0.5rem 0 0.25rem', fontSize: '0.95rem' }}
          >
            Answers <span className="count">{resolved.length}</span>
          </h3>
          {resolved.map((view) => (
            <QuestionRow key={view.id} view={view} {...rowProps} />
          ))}
        </section>
      )
    ) : null;

  return (
    <div>
      {/* Answering: gaps first. Reviewing: what you're approving first. */}
      {interactive ? (
        <>
          {missingSection}
          {resolvedSection}
        </>
      ) : (
        <>
          {resolvedSection}
          {missingSection ? (
            <div style={{ marginTop: resolved.length > 0 ? '1.25rem' : 0 }}>
              {missingSection}
            </div>
          ) : null}
        </>
      )}

      {unknown.length > 0 ? (
        <section aria-label="questions not yet resolved">
          {missing.length > 0 || resolved.length > 0 ? (
            <h3
              className="section-title"
              style={{ margin: '1.25rem 0 0.25rem', fontSize: '0.95rem' }}
            >
              Not yet processed <span className="count">{unknown.length}</span>
            </h3>
          ) : null}
          {unknown.map((view) => (
            <QuestionRow key={view.id} view={view} {...rowProps} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
