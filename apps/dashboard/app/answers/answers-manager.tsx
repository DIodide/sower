'use client';

// Interactive answer-library manager: search, grouped listing (Global +
// per-company), add / inline-edit / delete-with-confirm. All mutations go
// through the server actions in ./actions.ts, which call the sower api's
// /answer-library routes with x-api-key.

import type { ReactNode } from 'react';
import { useMemo, useState, useTransition } from 'react';
import { formatLocal, relativeTime, truncate } from '../../lib/format';
import { Empty } from '../../lib/ui';
import { Badge } from '../tasks/[id]/ui';
import type { ActionResult } from './actions';
import {
  createLibraryAnswer,
  deleteLibraryAnswer,
  updateLibraryAnswer,
} from './actions';
import type { LibraryEntry } from './library';

const MAX_VALUE_LENGTH = 20_000;

function ScopeBadge({ company }: { company: string }) {
  if (company === '') {
    return (
      <Badge
        tone="neutral"
        title="global — used for any company when no company-specific answer exists"
      >
        global
      </Badge>
    );
  }
  return (
    <Badge tone="accent" title={`only used for applications at “${company}”`}>
      {company}
    </Badge>
  );
}

function CharCount({ length }: { length: number }) {
  const over = length > MAX_VALUE_LENGTH;
  return (
    <span
      className={over ? 'status-err mono' : 'hint faint mono'}
      style={{ fontSize: '0.72rem' }}
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
      className={result.ok ? 'status-ok' : 'status-err'}
      style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
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
    <div style={{ display: 'grid', gap: '0.875rem' }}>
      <div>
        <span className="field-label">Scope</span>
        <div className="row">
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name={`${idPrefix}-scope`}
              checked={draft.scope === 'global'}
              onChange={() => onChange({ ...draft, scope: 'global' })}
            />
            Global — reused for any company
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name={`${idPrefix}-scope`}
              checked={draft.scope === 'company'}
              onChange={() => onChange({ ...draft, scope: 'company' })}
            />
            Company-specific
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
                className="field"
                style={{ maxWidth: '16rem', width: 'auto' }}
              />
              <datalist id={datalistId}>
                {companies.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          ) : null}
        </div>
        <p className="hint faint" style={{ margin: '0.25rem 0 0' }}>
          {draft.scope === 'company'
            ? 'Matched case-insensitively; this answer will only auto-fill applications at this company.'
            : 'Global answers are the fallback — a company-specific answer for the same question always wins for its company.'}
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-label`} className="field-label">
          Question label
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
          className="field"
        />
        <p className="hint faint" style={{ margin: '0.25rem 0 0' }}>
          Use the question text as it appears on application forms — matching is
          fuzzy on punctuation and case but otherwise exact.
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-value`} className="field-label">
          Answer
        </label>
        <textarea
          id={`${idPrefix}-value`}
          rows={6}
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          maxLength={MAX_VALUE_LENGTH}
          placeholder="the answer, exactly as it should be submitted"
          className="field"
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
    return 'Enter a company name, or choose the global scope.';
  }
  if (draft.questionLabel.trim() === '') return 'Question label is required.';
  if (draft.value.trim() === '') return 'Answer text is required.';
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
        className="btn btn--primary"
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
      className="card"
      style={{ flexBasis: '100%' }}
    >
      <h3 className="section-title" style={{ margin: '0 0 0.875rem' }}>
        New answer
      </h3>
      <AnswerFields
        draft={draft}
        onChange={setDraft}
        companies={companies}
        idPrefix="add"
      />
      {error ? (
        <p className="status-err" style={{ margin: '0.5rem 0 0' }}>
          {error}
        </p>
      ) : null}
      <div className="row" style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="btn btn--success"
          disabled={pending}
          onClick={submit}
        >
          {pending ? 'Saving…' : 'Save answer'}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
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
    <div style={{ padding: '0.5rem 0 0.5rem' }}>
      <AnswerFields
        draft={draft}
        onChange={setDraft}
        companies={companies}
        idPrefix={`edit-${entry.id}`}
      />
      {error ? (
        <p className="status-err" style={{ margin: '0.5rem 0 0' }}>
          {error}
        </p>
      ) : null}
      <div className="row" style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="btn btn--success"
          disabled={pending}
          onClick={submit}
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
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
    <li className="q-row" style={{ listStyle: 'none' }}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <div style={{ flex: '1 1 22rem', minWidth: 0 }}>
          <span className="q-label" style={{ marginRight: '0.5rem' }}>
            {entry.questionLabel}
          </span>
          <ScopeBadge company={entry.company} />
        </div>
        <span
          className="hint faint"
          style={{ whiteSpace: 'nowrap' }}
          title={formatLocal(entry.updatedAt)}
        >
          {entry.updatedAt ? `updated ${relativeTime(entry.updatedAt)}` : ''}
        </span>
        {!editing ? (
          <span style={{ display: 'inline-flex', gap: '0.375rem' }}>
            <button type="button" className="btn btn--sm" onClick={onEdit}>
              Edit
            </button>
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={pending}
                  onClick={remove}
                >
                  {pending ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  disabled={pending}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                style={{ color: 'var(--danger-fg)' }}
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
          className="hint"
          style={{
            margin: '0.25rem 0 0',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
            maxWidth: '60rem',
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
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <input
          type="search"
          aria-label="search answers"
          placeholder="Search by question, answer, or company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="field"
          style={{ maxWidth: '24rem', flex: '1 1 16rem' }}
        />
        <AddPanel companies={pickerCompanies} onDone={onResult} />
      </div>
      <StatusMessage result={lastResult} />

      {entries.length === 0 ? (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="hint" style={{ margin: 0 }}>
            No saved answers yet. Add one above, or answer a{' '}
            <strong>Needs input</strong> task — essay answers you save there are
            stored per company and auto-fill future applications at that
            company; everything else is saved globally.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <Empty>No answers match “{query}”.</Empty>
      ) : (
        groups.map((group) => (
          <section
            key={group.company || '__global__'}
            className="card"
            style={{ marginTop: '1.25rem' }}
          >
            <h3
              className="section-title"
              style={{ margin: '0 0 0.25rem', fontSize: '1rem' }}
            >
              {group.title}
              <span className="count">{group.entries.length}</span>
              {group.company === '' ? (
                <span className="hint" style={{ fontWeight: 600 }}>
                  fallback for any company
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
