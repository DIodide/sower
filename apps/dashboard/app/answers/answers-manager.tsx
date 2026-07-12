'use client';

// Interactive answer-library manager: search, grouped listing (Global +
// per-company), add / inline-edit / delete-with-confirm. All mutations go
// through the server actions in ./actions.ts, which call the sower api's
// /answer-library routes with x-api-key.

import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState, useTransition } from 'react';
import { formatDate, relativeTime, truncate } from '../../lib/format';
import { BORDER, Empty, MONO, MUTED, PANEL_BG } from '../../lib/ui';
import { Badge, FAINT, INPUT_BG, INPUT_BORDER } from '../tasks/[id]/ui';
import type { ActionResult } from './actions';
import {
  createLibraryAnswer,
  deleteLibraryAnswer,
  updateLibraryAnswer,
} from './actions';
import type { LibraryEntry } from './library';

const MAX_VALUE_LENGTH = 20_000;
const GLOBAL_SCOPE_COLOR = { bg: '#26262b', fg: '#9ca3af' };
const COMPANY_SCOPE_COLOR = { bg: '#2a2140', fg: '#c4b5fd' };

const inputStyle: CSSProperties = {
  backgroundColor: INPUT_BG,
  border: `1px solid ${INPUT_BORDER}`,
  borderRadius: '0.375rem',
  color: '#d7dae0',
  fontSize: '0.875rem',
  padding: '0.375rem 0.5rem',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const smallLabelStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: MUTED,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontFamily: MONO,
  display: 'block',
  marginBottom: '0.25rem',
};

const primaryButtonStyle: CSSProperties = {
  backgroundColor: '#16283f',
  color: '#93c5fd',
  border: '1px solid #2a3145',
  borderRadius: '0.375rem',
  padding: '0.375rem 0.875rem',
  fontSize: '0.8rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const saveButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  backgroundColor: '#143322',
  color: '#4ade80',
};

const quietButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  backgroundColor: 'transparent',
  color: MUTED,
  fontWeight: 500,
};

const smallButtonStyle: CSSProperties = {
  backgroundColor: 'transparent',
  border: `1px solid ${INPUT_BORDER}`,
  borderRadius: '0.375rem',
  padding: '0.125rem 0.625rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
  color: MUTED,
};

function ScopeBadge({ company }: { company: string }) {
  if (company === '') {
    return (
      <Badge
        bg={GLOBAL_SCOPE_COLOR.bg}
        fg={GLOBAL_SCOPE_COLOR.fg}
        title="global — used for any company when no company-specific answer exists"
      >
        global
      </Badge>
    );
  }
  return (
    <Badge
      bg={COMPANY_SCOPE_COLOR.bg}
      fg={COMPANY_SCOPE_COLOR.fg}
      title={`only used for applications at “${company}”`}
    >
      {company}
    </Badge>
  );
}

function CharCount({ length }: { length: number }) {
  const over = length > MAX_VALUE_LENGTH;
  return (
    <span
      style={{
        fontSize: '0.7rem',
        fontFamily: MONO,
        color: over ? '#f87171' : FAINT,
      }}
    >
      {length.toLocaleString()} / {MAX_VALUE_LENGTH.toLocaleString()}
    </span>
  );
}

function StatusMessage({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      style={{
        margin: '0.5rem 0 0',
        fontSize: '0.8rem',
        color: result.ok ? '#4ade80' : '#f87171',
        wordBreak: 'break-word',
      }}
    >
      {result.message}
    </p>
  );
}

interface DraftState {
  scope: 'global' | 'company';
  company: string;
  questionLabel: string;
  value: string;
}

/**
 * Scope + label + answer fields shared by the add and edit forms. Controlled
 * by the caller so add/edit each keep their own draft.
 */
function AnswerFields({
  draft,
  onChange,
  companies,
  idPrefix,
}: {
  draft: DraftState;
  onChange: (next: DraftState) => void;
  companies: string[];
  idPrefix: string;
}) {
  const datalistId = `${idPrefix}-companies`;
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <div>
        <span style={smallLabelStyle}>scope</span>
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.8rem',
            }}
          >
            <input
              type="radio"
              name={`${idPrefix}-scope`}
              checked={draft.scope === 'global'}
              onChange={() => onChange({ ...draft, scope: 'global' })}
            />
            global — reused for any company
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.8rem',
            }}
          >
            <input
              type="radio"
              name={`${idPrefix}-scope`}
              checked={draft.scope === 'company'}
              onChange={() => onChange({ ...draft, scope: 'company' })}
            />
            company-specific
          </label>
          {draft.scope === 'company' ? (
            <>
              <input
                type="text"
                aria-label="company"
                placeholder="company name"
                value={draft.company}
                onChange={(e) =>
                  onChange({ ...draft, company: e.target.value })
                }
                list={datalistId}
                style={{ ...inputStyle, maxWidth: '16rem', width: 'auto' }}
              />
              <datalist id={datalistId}>
                {companies.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          ) : null}
        </div>
        {draft.scope === 'company' ? (
          <p
            style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: FAINT }}
          >
            company names are matched case-insensitively; this answer will only
            auto-fill applications at this company.
          </p>
        ) : (
          <p
            style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: FAINT }}
          >
            global answers are the fallback — a company-specific answer for the
            same question always wins for its company.
          </p>
        )}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-label`} style={smallLabelStyle}>
          question label
        </label>
        <input
          id={`${idPrefix}-label`}
          type="text"
          placeholder="e.g. Why do you want to work here?"
          value={draft.questionLabel}
          onChange={(e) =>
            onChange({ ...draft, questionLabel: e.target.value })
          }
          maxLength={1000}
          style={inputStyle}
        />
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: FAINT }}>
          matching is fuzzy on punctuation/case but otherwise exact — use the
          question text as it appears on application forms.
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-value`} style={smallLabelStyle}>
          answer
        </label>
        <textarea
          id={`${idPrefix}-value`}
          rows={6}
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          maxLength={MAX_VALUE_LENGTH}
          placeholder="the answer, exactly as it should be submitted"
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <CharCount length={draft.value.length} />
        </div>
      </div>
    </div>
  );
}

function draftToInput(draft: DraftState): {
  company: string;
  questionLabel: string;
  value: string;
} {
  return {
    company: draft.scope === 'global' ? '' : draft.company.toLowerCase().trim(),
    questionLabel: draft.questionLabel.trim(),
    value: draft.value.trim(),
  };
}

function validateDraft(draft: DraftState): string | null {
  if (draft.scope === 'company' && draft.company.trim() === '') {
    return 'enter a company name, or choose the global scope.';
  }
  if (draft.questionLabel.trim() === '') return 'question label is required.';
  if (draft.value.trim() === '') return 'answer text is required.';
  return null;
}

const EMPTY_DRAFT: DraftState = {
  scope: 'global',
  company: '',
  questionLabel: '',
  value: '',
};

function AddPanel({
  companies,
  onDone,
}: {
  companies: string[];
  onDone: (result: ActionResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        style={primaryButtonStyle}
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
      >
        + Add answer
      </button>
    );
  }

  const submit = () => {
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createLibraryAnswer(draftToInput(draft));
      if (result.ok) {
        setDraft(EMPTY_DRAFT);
        setOpen(false);
      } else {
        setError(result.message);
      }
      onDone(result);
    });
  };

  return (
    <section
      aria-label="add answer"
      style={{
        backgroundColor: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: '0.5rem',
        padding: '1rem 1.25rem',
        flexBasis: '100%',
      }}
    >
      <h3
        style={{
          margin: '0 0 0.75rem',
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: MONO,
        }}
      >
        new answer
      </h3>
      <AnswerFields
        draft={draft}
        onChange={setDraft}
        companies={companies}
        idPrefix="add"
      />
      {error ? (
        <p
          style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#f87171' }}
        >
          {error}
        </p>
      ) : null}
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          marginTop: '0.75rem',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          style={{ ...saveButtonStyle, opacity: pending ? 0.6 : 1 }}
          disabled={pending}
          onClick={submit}
        >
          Save answer
        </button>
        <button
          type="button"
          style={quietButtonStyle}
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
        {pending ? (
          <span style={{ fontSize: '0.8rem', color: MUTED }}>saving…</span>
        ) : null}
      </div>
    </section>
  );
}

function EditForm({
  entry,
  companies,
  onDone,
  onCancel,
}: {
  entry: LibraryEntry;
  companies: string[];
  onDone: (result: ActionResult) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftState>({
    scope: entry.company === '' ? 'global' : 'company',
    company: entry.company,
    questionLabel: entry.questionLabel,
    value: entry.value,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateLibraryAnswer(entry.id, draftToInput(draft));
      if (!result.ok) setError(result.message);
      onDone(result);
    });
  };

  return (
    <div style={{ padding: '0.25rem 0 0.5rem' }}>
      <AnswerFields
        draft={draft}
        onChange={setDraft}
        companies={companies}
        idPrefix={`edit-${entry.id}`}
      />
      {error ? (
        <p
          style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#f87171' }}
        >
          {error}
        </p>
      ) : null}
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          marginTop: '0.75rem',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          style={{ ...saveButtonStyle, opacity: pending ? 0.6 : 1 }}
          disabled={pending}
          onClick={submit}
        >
          Save changes
        </button>
        <button
          type="button"
          style={quietButtonStyle}
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        {pending ? (
          <span style={{ fontSize: '0.8rem', color: MUTED }}>saving…</span>
        ) : null}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  companies,
  editing,
  onEdit,
  onCloseEdit,
  onResult,
}: {
  entry: LibraryEntry;
  companies: string[];
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  onResult: (result: ActionResult) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const remove = () => {
    startTransition(async () => {
      const result = await deleteLibraryAnswer(entry.id);
      setConfirmingDelete(false);
      onResult(result);
    });
  };

  return (
    <li
      style={{
        padding: '0.625rem 0',
        borderBottom: `1px solid ${BORDER}`,
        listStyle: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.625rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>
          {entry.questionLabel}
        </span>
        <ScopeBadge company={entry.company} />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '0.75rem',
            color: FAINT,
            whiteSpace: 'nowrap',
          }}
          title={formatDate(entry.updatedAt)}
        >
          {entry.updatedAt ? `updated ${relativeTime(entry.updatedAt)}` : ''}
        </span>
        {!editing ? (
          <span style={{ display: 'inline-flex', gap: '0.375rem' }}>
            <button type="button" style={smallButtonStyle} onClick={onEdit}>
              Edit
            </button>
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  style={{
                    ...smallButtonStyle,
                    color: '#f87171',
                    borderColor: '#4a2222',
                    backgroundColor: '#3a1a1a',
                    opacity: pending ? 0.6 : 1,
                  }}
                  disabled={pending}
                  onClick={remove}
                >
                  {pending ? 'deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  style={smallButtonStyle}
                  disabled={pending}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                style={{ ...smallButtonStyle, color: '#f87171' }}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
          </span>
        ) : null}
      </div>
      {editing ? (
        <EditForm
          entry={entry}
          companies={companies}
          onDone={(result) => {
            if (result.ok) onCloseEdit();
            onResult(result);
          }}
          onCancel={onCloseEdit}
        />
      ) : (
        <p
          style={{
            margin: '0.25rem 0 0',
            fontSize: '0.8rem',
            color: MUTED,
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
          }}
        >
          {truncate(entry.value, 220)}
        </p>
      )}
    </li>
  );
}

interface Group {
  /** '' for the global group, otherwise the company key. */
  company: string;
  title: ReactNode;
  entries: LibraryEntry[];
}

function buildGroups(entries: LibraryEntry[]): Group[] {
  const byCompany = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    const list = byCompany.get(entry.company);
    if (list) list.push(entry);
    else byCompany.set(entry.company, [entry]);
  }
  const companies = [...byCompany.keys()]
    .filter((c) => c !== '')
    .sort((a, b) => a.localeCompare(b));
  const ordered: Group[] = [];
  const globalEntries = byCompany.get('');
  if (globalEntries) {
    ordered.push({ company: '', title: 'Global', entries: globalEntries });
  }
  for (const company of companies) {
    ordered.push({
      company,
      title: company,
      entries: byCompany.get(company) ?? [],
    });
  }
  for (const group of ordered) {
    group.entries.sort((a, b) =>
      a.questionLabel.localeCompare(b.questionLabel),
    );
  }
  return ordered;
}

export function AnswersManager({
  entries,
  jobCompanies,
}: {
  entries: LibraryEntry[];
  /** Company names seen on ingested jobs (original casing), for the picker. */
  jobCompanies: string[];
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);

  // Companies offered in the scope picker: from jobs plus any company that
  // already has a scoped answer (deduped case-insensitively).
  const pickerCompanies = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of jobCompanies) {
      const key = c.toLowerCase().trim();
      if (key !== '' && !seen.has(key)) seen.set(key, c);
    }
    for (const entry of entries) {
      if (entry.company !== '' && !seen.has(entry.company)) {
        seen.set(entry.company, entry.company);
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }, [jobCompanies, entries]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (q === '') return entries;
    return entries.filter(
      (entry) =>
        entry.questionLabel.toLowerCase().includes(q) ||
        entry.value.toLowerCase().includes(q) ||
        (entry.company === '' ? 'global' : entry.company).includes(q),
    );
  }, [entries, query]);

  const groups = useMemo(() => buildGroups(filtered), [filtered]);

  const onResult = (result: ActionResult) => setLastResult(result);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: '0.5rem',
        }}
      >
        <input
          type="search"
          aria-label="search answers"
          placeholder="search by question, answer, or company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...inputStyle, maxWidth: '24rem', flex: '1 1 16rem' }}
        />
        <AddPanel companies={pickerCompanies} onDone={onResult} />
      </div>
      <StatusMessage result={lastResult} />

      {entries.length === 0 ? (
        <div
          style={{
            backgroundColor: PANEL_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: '0.5rem',
            padding: '1.5rem',
            marginTop: '1rem',
            fontSize: '0.875rem',
            color: MUTED,
            lineHeight: 1.6,
          }}
        >
          <p style={{ margin: 0 }}>
            no saved answers yet. Add one above, or answer a{' '}
            <span style={{ color: '#fbbf24' }}>Needs Input</span> task — essay
            answers you save there are stored per company and auto-fill future
            applications at that company; everything else is saved globally.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <Empty>no answers match “{query}”.</Empty>
      ) : (
        groups.map((group) => (
          <section key={group.company || '__global__'}>
            <h3
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '0.5rem',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: MUTED,
                textTransform: group.company === '' ? 'uppercase' : 'none',
                letterSpacing: '0.08em',
                margin: '1.75rem 0 0.25rem',
                fontFamily: MONO,
              }}
            >
              {group.title}
              <span style={{ color: FAINT, fontWeight: 400 }}>
                {group.entries.length}
              </span>
              {group.company === '' ? (
                <span
                  style={{
                    color: FAINT,
                    fontWeight: 400,
                    fontFamily: 'inherit',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                  }}
                >
                  — fallback for any company
                </span>
              ) : null}
            </h3>
            <ul style={{ margin: 0, padding: 0 }}>
              {group.entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  companies={pickerCompanies}
                  editing={editingId === entry.id}
                  onEdit={() => setEditingId(entry.id)}
                  onCloseEdit={() => setEditingId(null)}
                  onResult={onResult}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
