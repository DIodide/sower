'use client';

// Overleaf-style split pane for the Edit tab: CodeMirror 6 source (legacy
// stex highlighting) left, compiled-PDF preview right; the panes stack when
// the container is too narrow for both. Preview compiles go through the
// compileResumePreview action and are throwaway — no version, no run, no
// commit; Save (owned by the caller) remains the only mutation. At most one
// compile is in flight: requests during a compile set a rerun flag, and the
// newest source is compiled once the active one lands — never a deeper
// queue. On failure the last good PDF stays framed and the tectonic log
// shows under the status strip. Auto-compile (1.2s debounce after the last
// keystroke) can be toggled off; the choice persists in localStorage.
// Cmd/Ctrl+Enter compiles, Cmd/Ctrl+S runs the caller's save.

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  defaultHighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import {
  firstLatexError,
  pdfBytesFromBase64,
} from '../../../lib/latex-preview';
import { compileResumePreview } from './actions';

/** Marks programmatic doc replacement (prop sync) — never auto-compiled. */
const External = Annotation.define<boolean>();

const DEBOUNCE_MS = 1200;
/** localStorage key for the auto-compile toggle (shared across resumes). */
const AUTO_COMPILE_KEY = 'resume-preview-autocompile';

type Phase = 'idle' | 'compiling' | 'ok' | 'failed';

export function LatexEditor({
  resumeId,
  value,
  onChange,
  publishedPdfUrl,
  onSave,
}: {
  resumeId: string;
  /** The draft source. The caller owns it (dirty tracking, save, cancel). */
  value: string;
  onChange: (source: string) => void;
  /** The live /documents/<id> PDF — seeds the preview pane before the first
   *  compile. Null = the resume has never compiled. */
  publishedPdfUrl: string | null;
  /** The existing commit+push save flow (Cmd/Ctrl+S). Must self-guard
   *  against busy/clean states — the keybinding always fires. */
  onSave: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The latest editor text — compiles read it synchronously, so a compile
  // fired mid-debounce still sees every keystroke.
  const sourceRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const compileRef = useRef<() => void>(() => {});
  const autoRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const disposedRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);

  const [autoCompile, setAutoCompileState] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(publishedPdfUrl);

  const compile = async () => {
    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    inFlightRef.current = true;
    setPhase('compiling');
    const started = performance.now();
    let result: Awaited<ReturnType<typeof compileResumePreview>>;
    try {
      result = await compileResumePreview(resumeId, sourceRef.current);
    } catch {
      result = { ok: false, log: 'could not reach the dashboard.' };
    }
    inFlightRef.current = false;
    if (disposedRef.current) return;
    if (result.ok && result.pdf !== undefined) {
      let url: string | null = null;
      try {
        const bytes = pdfBytesFromBase64(result.pdf);
        url = URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' }),
        );
      } catch {
        // Malformed payload — fall through to the failure branch.
      }
      if (url) {
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setPdfUrl(url);
        setElapsedMs(performance.now() - started);
        setLog(null);
        setPhase('ok');
      } else {
        setLog('the api returned an unreadable PDF.');
        setPhase('failed');
      }
    } else {
      setLog(result.log ?? 'compile failed.');
      setPhase('failed');
    }
    if (rerunRef.current) {
      rerunRef.current = false;
      compileRef.current();
    }
  };

  // Keep the stable extensions' refs pointing at this render's closures.
  useEffect(() => {
    compileRef.current = () => void compile();
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  // Hydrate the persisted toggle after mount — SSR must render the default.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(AUTO_COMPILE_KEY) === 'off') {
        autoRef.current = false;
        setAutoCompileState(false);
      }
    } catch {
      // Storage unavailable (private mode) — the default stands.
    }
  }, []);

  const setAutoCompile = (next: boolean) => {
    autoRef.current = next;
    setAutoCompileState(next);
    if (!next && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      window.localStorage.setItem(AUTO_COMPILE_KEY, next ? 'on' : 'off');
    } catch {
      // Losing persistence, not the toggle.
    }
  };

  // Mount CodeMirror once; everything dynamic goes through refs.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: sourceRef.current,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.lineWrapping,
          StreamLanguage.define(stex),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([
            // Editor-scoped shortcuts beat the browser defaults.
            {
              key: 'Mod-Enter',
              run: () => {
                compileRef.current();
                return true;
              },
            },
            {
              key: 'Mod-s',
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Prop-sync dispatches never count as user edits.
            if (update.transactions.some((tr) => tr.annotation(External))) {
              return;
            }
            const text = update.state.doc.toString();
            sourceRef.current = text;
            onChangeRef.current(text);
            if (!autoRef.current) return;
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              compileRef.current();
            }, DEBOUNCE_MS);
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value changes (cancel, a run's refresh adopting new source)
  // replace the doc without triggering onChange or an auto-compile.
  useEffect(() => {
    sourceRef.current = value;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: External.of(true),
    });
  }, [value]);

  const firstError = log !== null ? firstLatexError(log) : null;
  // Pre-first-compile the frame still shows the published PDF, not the draft.
  const showingPublished = pdfUrl !== null && pdfUrl === publishedPdfUrl;

  return (
    <div className="latex-split">
      <div className="latex-pane">
        <div ref={hostRef} className="latex-cm" />
      </div>
      <div className="latex-pane">
        <div className="latex-status">
          <button
            type="button"
            className="btn btn--sm"
            disabled={phase === 'compiling'}
            title="Compile the preview (Cmd/Ctrl+Enter)"
            onClick={() => compileRef.current()}
          >
            Compile
          </button>
          {phase === 'compiling' ? (
            <span className="hint" role="status">
              compiling…
            </span>
          ) : phase === 'ok' && elapsedMs !== null ? (
            <span className="status-ok num" role="status">
              compiled in {(elapsedMs / 1000).toFixed(1)}s
            </span>
          ) : phase === 'failed' ? (
            <span className="status-err" role="status">
              compile failed
            </span>
          ) : (
            <span className="hint faint">
              {showingPublished
                ? 'showing the published PDF'
                : 'not compiled yet'}
            </span>
          )}
          <label
            className="latex-auto"
            title="Recompile ~1.2s after the last keystroke"
          >
            <input
              type="checkbox"
              checked={autoCompile}
              onChange={(event) => setAutoCompile(event.target.checked)}
            />
            auto-compile
          </label>
        </div>

        {phase === 'failed' && log ? (
          <div style={{ marginBottom: '0.375rem' }}>
            {firstError ? (
              <p
                className="status-err mono"
                style={{ margin: '0 0 0.25rem', overflowWrap: 'anywhere' }}
              >
                {firstError}
              </p>
            ) : null}
            <details className="expand">
              <summary>compile log</summary>
              <pre className="latex-log">{log}</pre>
            </details>
          </div>
        ) : null}

        {pdfUrl ? (
          <iframe
            src={pdfUrl}
            title="Compiled preview"
            className="latex-frame"
          />
        ) : (
          <div className="latex-frame latex-frame-empty">
            <p className="hint faint" style={{ margin: 0 }}>
              No PDF yet — compile to preview.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
