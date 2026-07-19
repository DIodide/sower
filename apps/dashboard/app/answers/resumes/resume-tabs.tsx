'use client';

// The interactive right pane of a resume: flat tabs for "Ask Claude"
// (natural-language change request → agent run), "Edit source" (the raw .tex
// with dirty-tracking + beforeunload guard), "History" (the last runs with
// expandable transcripts), and "Share" (public …/r/<token> links). One run is
// polled at a time; Send/Save stay disabled until it settles, and a
// successful run router.refresh()es so the PDF preview, source, and history
// all converge on the server's truth.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { truncate } from '../../../lib/format';
import { Empty, Timestamp } from '../../../lib/ui';
import { Badge } from '../../tasks/[id]/ui';
import { askResumeChange, saveResumeEdit } from './actions';
import {
  commitUrl,
  KIND_META,
  type RunSnapshot,
  STATUS_META,
  shortSha,
} from './run-format';
import { LiveRunView, TranscriptSteps, useRunPoll } from './run-view';
import { SharePanel } from './share-panel';

/** The resume row, serialized by the page for this client component. */
export interface ResumeClientView {
  id: string;
  name: string;
  texPath: string;
  texSource: string | null;
}

type TabId = 'ask' | 'edit' | 'history' | 'share';

const TABS: { id: TabId; label: string }[] = [
  { id: 'ask', label: 'Ask Claude' },
  { id: 'edit', label: 'Edit source' },
  { id: 'history', label: 'History' },
  { id: 'share', label: 'Share' },
];

/** Where the currently-polled run should render its live view. */
type RunOrigin = 'ask' | 'edit';

const EDITOR_MAX_PX = 576; // 36rem — then the editor scrolls.
const PROMPT_MAX = 4000;
const SOURCE_MAX = 200_000;

function HistoryRow({ run }: { run: RunSnapshot }) {
  const kind = KIND_META[run.kind];
  const status = STATUS_META[run.status];
  const excerpt =
    run.kind === 'agent' && run.prompt
      ? truncate(run.prompt, 110)
      : kind.fallbackExcerpt;
  return (
    <li className="q-row" style={{ listStyle: 'none' }}>
      <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Badge tone={kind.tone} title={`kind: ${run.kind}`}>
          {kind.label}
        </Badge>
        <Badge tone={status.tone} title={run.status}>
          {status.label}
        </Badge>
        <span
          style={{
            flex: '1 1 10rem',
            minWidth: 0,
            fontSize: '0.875rem',
            overflowWrap: 'anywhere',
          }}
        >
          {excerpt}
        </span>
        {run.commitSha ? (
          <a
            className="mono"
            style={{ fontSize: '0.8125rem' }}
            href={commitUrl(run.commitSha)}
            target="_blank"
            rel="noopener noreferrer"
            title={run.commitSha}
          >
            {shortSha(run.commitSha)}
          </a>
        ) : null}
        <Timestamp value={run.startedAt} />
      </div>
      {run.error ? (
        <p
          className="status-err"
          style={{ margin: '0.25rem 0 0', overflowWrap: 'anywhere' }}
        >
          {truncate(run.error, 400)}
        </p>
      ) : null}
      {run.transcript.length > 0 ? (
        <details className="expand" style={{ marginTop: '0.25rem' }}>
          <summary>
            transcript · {run.transcript.length} step
            {run.transcript.length === 1 ? '' : 's'}
          </summary>
          <div className="scroll-cap" style={{ marginTop: '0.5rem' }}>
            <TranscriptSteps steps={run.transcript} startedAt={run.startedAt} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** The last runs, newest first. Also reused by the page's empty state. */
export function RunHistoryList({ runs }: { runs: RunSnapshot[] }) {
  if (runs.length === 0) {
    return <Empty>No runs yet — sync, ask, or edit to create one.</Empty>;
  }
  return (
    <ul style={{ margin: 0, padding: 0 }}>
      {runs.map((run) => (
        <HistoryRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

export function ResumeTabs({
  resume,
  history,
  initialRun,
  viewingOldVersion = false,
}: {
  resume: ResumeClientView;
  /** The resume's last runs (incl. repo-wide syncs), newest first. */
  history: RunSnapshot[];
  /** The latest run when it was still 'running' at render time. */
  initialRun: RunSnapshot | null;
  /** The PDF pane is showing a PRIOR version — the Edit tab warns that
   *  edits always apply to the latest. */
  viewingOldVersion?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('ask');

  // ---- the one polled run -------------------------------------------------
  const [active, setActive] = useState<{
    runId: string;
    origin: RunOrigin;
  } | null>(
    initialRun
      ? {
          runId: initialRun.id,
          origin: initialRun.kind === 'write' ? 'edit' : 'ask',
        }
      : null,
  );
  const { run, timedOut, pollError } = useRunPoll(
    active?.runId ?? null,
    initialRun,
    (settled) => {
      if (settled.status === 'succeeded') router.refresh();
    },
  );
  const runActive =
    active !== null && !timedOut && (run === null || run.status === 'running');

  // ---- Ask Claude ---------------------------------------------------------
  const [prompt, setPrompt] = useState('');
  const [askError, setAskError] = useState<string | null>(null);
  const [askPending, startAsk] = useTransition();
  const send = () => {
    const trimmed = prompt.trim();
    if (trimmed === '') {
      setAskError('Describe the change you want.');
      return;
    }
    setAskError(null);
    startAsk(async () => {
      const result = await askResumeChange(resume.id, trimmed);
      if (result.ok && result.runId) {
        setActive({ runId: result.runId, origin: 'ask' });
        setPrompt('');
      } else {
        setAskError(result.message);
      }
    });
  };

  // ---- Edit source --------------------------------------------------------
  const source = resume.texSource ?? '';
  const [baseline, setBaseline] = useState(source);
  const [draft, setDraft] = useState(source);
  const dirty = draft !== baseline;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, startSave] = useTransition();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // After a refresh lands new source (a run committed), adopt it — unless the
  // user has unsaved edits, which are never clobbered.
  useEffect(() => {
    if (baseline !== source) {
      if (draft === baseline) setDraft(source);
      setBaseline(source);
    }
  }, [source, baseline, draft]);

  // Warn before leaving the page with unsaved editor changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Autogrow the editor to its content, up to 36rem, then scroll. Re-measure
  // on every draft change and when the tab becomes visible (hidden panels
  // measure 0).
  useEffect(() => {
    const el = editorRef.current;
    if (!el || tab !== 'edit' || el.value !== draft) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, EDITOR_MAX_PX)}px`;
  }, [tab, draft]);

  const save = () => {
    if (draft.trim() === '') {
      setSaveError('Resume source is empty.');
      return;
    }
    if (draft.length > SOURCE_MAX) {
      setSaveError('Resume source is over the 200,000 character limit.');
      return;
    }
    setSaveError(null);
    startSave(async () => {
      const result = await saveResumeEdit(resume.id, draft);
      if (result.ok && result.runId) {
        setActive({ runId: result.runId, origin: 'edit' });
      } else {
        setSaveError(result.message);
      }
    });
  };

  const busy = runActive || askPending || savePending;
  const waitHint = (
    <p className="hint faint" style={{ margin: '0.375rem 0 0' }}>
      Another run is in progress — wait for it to finish.
    </p>
  );

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={`${resume.name} panels`}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${resume.id}-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${resume.id}-${id}`}
            className="tab"
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'history' && history.length > 0 ? (
              <span
                className="faint num"
                style={{ marginLeft: '0.375rem', fontSize: '0.75rem' }}
              >
                {history.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ---- Ask Claude ---- */}
      <div
        role="tabpanel"
        id={`panel-${resume.id}-ask`}
        aria-labelledby={`tab-${resume.id}-ask`}
        hidden={tab !== 'ask'}
      >
        <label htmlFor={`ask-${resume.id}`} className="field-label">
          Describe the change
        </label>
        <textarea
          id={`ask-${resume.id}`}
          className="field"
          rows={4}
          maxLength={PROMPT_MAX}
          placeholder="e.g. 'Add my Sower project under Projects — TypeScript, GCP, Claude Agent SDK'"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <p className="hint faint" style={{ margin: '0.25rem 0 0' }}>
          A Claude agent edits the LaTeX, recompiles, and commits + pushes to
          your portfolio repo.
        </p>
        <div className="row" style={{ marginTop: '0.625rem' }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || prompt.trim() === ''}
            onClick={send}
          >
            {askPending ? 'Starting…' : 'Send'}
          </button>
        </div>
        {askError ? (
          <p className="status-err" style={{ margin: '0.5rem 0 0' }}>
            {askError}
          </p>
        ) : null}
        {runActive && active?.origin === 'edit' ? waitHint : null}
        {active?.origin === 'ask' ? (
          <LiveRunView
            run={run}
            timedOut={timedOut}
            pollError={pollError}
            fallbackKind="agent"
          />
        ) : null}
      </div>

      {/* ---- Edit source ---- */}
      <div
        role="tabpanel"
        id={`panel-${resume.id}-edit`}
        aria-labelledby={`tab-${resume.id}-edit`}
        hidden={tab !== 'edit'}
      >
        {viewingOldVersion ? (
          <p className="hint" style={{ margin: '0 0 0.5rem' }}>
            The preview is showing an older version — editing always applies to
            the latest version.
          </p>
        ) : null}
        <div className="row" style={{ alignItems: 'baseline' }}>
          <label
            htmlFor={`tex-${resume.id}`}
            className="field-label"
            style={{ margin: 0 }}
          >
            LaTeX source
          </label>
          <span className="mono faint" style={{ fontSize: '0.6875rem' }}>
            {resume.texPath}
          </span>
          {dirty ? (
            <span className="spread hint" style={{ fontWeight: 600 }}>
              unsaved changes
            </span>
          ) : null}
        </div>
        {resume.texSource === null ? (
          <p className="hint" style={{ margin: '0.5rem 0 0' }}>
            No source snapshot yet — sync first.
          </p>
        ) : (
          <>
            <textarea
              id={`tex-${resume.id}`}
              ref={editorRef}
              className="field tex-editor"
              wrap="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              style={{ marginTop: '0.375rem' }}
            />
            <div className="row" style={{ marginTop: '0.625rem' }}>
              <button
                type="button"
                className="btn btn--success"
                disabled={busy || !dirty}
                onClick={save}
              >
                {savePending ? 'Starting…' : 'Save — commit + push'}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy || !dirty}
                onClick={() => {
                  setDraft(baseline);
                  setSaveError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {saveError ? (
          <p className="status-err" style={{ margin: '0.5rem 0 0' }}>
            {saveError}
          </p>
        ) : null}
        {runActive && active?.origin === 'ask' ? waitHint : null}
        {active?.origin === 'edit' ? (
          <LiveRunView
            run={run}
            timedOut={timedOut}
            pollError={pollError}
            fallbackKind="write"
          />
        ) : null}
      </div>

      {/* ---- History ---- */}
      <div
        role="tabpanel"
        id={`panel-${resume.id}-history`}
        aria-labelledby={`tab-${resume.id}-history`}
        hidden={tab !== 'history'}
      >
        <RunHistoryList runs={history} />
      </div>

      {/* ---- Share ---- */}
      <div
        role="tabpanel"
        id={`panel-${resume.id}-share`}
        aria-labelledby={`tab-${resume.id}-share`}
        hidden={tab !== 'share'}
      >
        <SharePanel resumeId={resume.id} active={tab === 'share'} />
      </div>
    </div>
  );
}
