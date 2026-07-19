'use client';

// Client shell around the (server-rendered) Applications sections. Holds the
// two bits of cross-row state the rows can't own alone: the checkbox
// selection (with its sticky "Discard N selected" bar) and the toast layer
// (discard undo, action errors). Rows reach it via useWorkspace().
//
// Toast rules: one toast at a time, but a live UNDO toast is never evicted —
// anything that arrives while an undo window is open queues behind it and
// shows when the window ends (expiry or undo). Errors render as role="alert";
// info toasts sit inside a persistent polite live region.

import { useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { discardTaskIds } from './actions';
import { restoreTask } from './tasks/[id]/actions';

export interface ToastOptions {
  /** 'error' renders as role="alert"; default 'info' is a polite status. */
  kind?: 'info' | 'error';
  /** "Undo" button handler — its presence renders the button. */
  onUndo?: () => void;
  /** Runs when the toast expires (or is replaced) without Undo being hit. */
  onExpire?: () => void;
  /** Move focus to the Undo button (keyboard-initiated discards). */
  focusUndo?: boolean;
}

interface WorkspaceApi {
  isSelected(id: string): boolean;
  setSelected(id: string, on: boolean): void;
  toast(message: string, options?: ToastOptions): void;
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error('useWorkspace requires a <Workspace> ancestor');
  return api;
}

const TOAST_MS = 6_000;

interface ToastState {
  key: number;
  message: string;
  kind: 'info' | 'error';
  onUndo?: (() => void) | undefined;
  focusUndo?: boolean | undefined;
}

let toastKey = 0;

export function Workspace({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selected, setSelectedSet] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Optional shared "why" typed on the select bar — stored on every ticked
  // task's DISCARD event, exactly like the single-discard note.
  const [bulkNote, setBulkNote] = useState('');
  const [toast, setToastState] = useState<ToastState | null>(null);
  const [pending, startTransition] = useTransition();
  // Mirror of the live toast for the (ref-only) queueing machinery.
  const toastRef = useRef<ToastState | null>(null);
  // Toasts waiting behind a live undo toast.
  const queueRef = useRef<{ message: string; options?: ToastOptions }[]>([]);
  const undoBtnRef = useRef<HTMLButtonElement | null>(null);
  // The live toast's expiry: timer id + the not-yet-fired onExpire callback.
  const expiryRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    onExpire?: (() => void) | undefined;
  } | null>(null);

  // H4: a changed filter/search shows a different list — a selection made
  // against the old list must not survive into it (render-time reset, the
  // React "derive state from a changed key" pattern).
  const filterKey = ['q', 'bucket', 'state', 'platform']
    .map((k) => `${k}=${searchParams?.get(k) ?? ''}`)
    .join('&');
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setSelectedSet(new Set());
  }

  const clearToastTimer = useCallback((fireExpire: boolean) => {
    const expiry = expiryRef.current;
    if (!expiry) return;
    clearTimeout(expiry.timer);
    expiryRef.current = null;
    if (fireExpire) expiry.onExpire?.();
  }, []);

  useEffect(() => () => clearToastTimer(false), [clearToastTimer]);

  const setToast = useCallback((state: ToastState | null) => {
    toastRef.current = state;
    setToastState(state);
  }, []);

  // display/showNext only touch refs and stable setters, so the closures the
  // expiry timers capture can never go stale.
  const displayToast = useCallback(
    (message: string, options?: ToastOptions) => {
      // Replacing a (non-undo) toast still runs its pending onExpire
      // (typically a router.refresh) so nothing is left stale.
      clearToastTimer(true);
      toastKey += 1;
      setToast({
        key: toastKey,
        message,
        kind: options?.kind ?? 'info',
        onUndo: options?.onUndo,
        focusUndo: options?.focusUndo,
      });
      expiryRef.current = {
        timer: setTimeout(() => {
          expiryRef.current = null;
          options?.onExpire?.();
          const next = queueRef.current.shift();
          if (next) displayToast(next.message, next.options);
          else setToast(null);
        }, TOAST_MS),
        onExpire: options?.onExpire,
      };
    },
    [clearToastTimer, setToast],
  );

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      // Never evict a live undo toast — its window is a promise to the user.
      if (toastRef.current?.onUndo && expiryRef.current) {
        queueRef.current.push(options ? { message, options } : { message });
        return;
      }
      displayToast(message, options);
    },
    [displayToast],
  );

  // H7: a keyboard-initiated discard moves focus to the Undo button.
  useEffect(() => {
    if (toast?.focusUndo && toast.onUndo) undoBtnRef.current?.focus();
  }, [toast]);

  const setSelected = useCallback((id: string, on: boolean) => {
    setSelectedSet((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const discardSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const note = bulkNote.trim();
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof discardTaskIds>>;
      try {
        result = await discardTaskIds(ids, note === '' ? undefined : note);
      } catch {
        showToast('Discard failed — could not reach the server.', {
          kind: 'error',
        });
        return;
      }
      setSelectedSet(new Set());
      setBulkNote('');
      const restorable = result.discardedIds;
      if (restorable.length > 0) {
        showToast(`${result.message} — Undo returns them to "Waiting on you"`, {
          kind: result.ok ? 'info' : 'error',
          onUndo: async () => {
            // Sequential restores (≤100 per batch) — plenty fast, and the
            // api treats an already-restored task as a no-op.
            let failedRestores = 0;
            for (const id of restorable) {
              try {
                const r = await restoreTask(id);
                if (!r.ok) failedRestores += 1;
              } catch {
                failedRestores += 1;
              }
            }
            if (failedRestores > 0) {
              showToast(
                `Could not restore ${failedRestores} of ${restorable.length} — check the Archive.`,
                { kind: 'error' },
              );
            }
            router.refresh();
          },
        });
      } else {
        showToast(result.message, { kind: result.ok ? 'info' : 'error' });
      }
      router.refresh();
    });
  };

  const undoToast = () => {
    if (!toast?.onUndo) return;
    const undo = toast.onUndo;
    clearToastTimer(false); // undone — the expire callback must NOT run
    const next = queueRef.current.shift();
    if (next) displayToast(next.message, next.options);
    else setToast(null);
    undo();
  };

  return (
    <WorkspaceContext.Provider
      value={{ isSelected, setSelected, toast: showToast }}
    >
      <div className={selected.size > 0 ? 'has-selection' : undefined}>
        {children}
      </div>
      <div className="bottom-dock">
        {/* Persistent polite region: info toasts announce without stealing
            focus; errors get their own role="alert" inside it. */}
        <div aria-live="polite">
          {toast ? (
            <div
              key={toast.key}
              className="toast"
              role={toast.kind === 'error' ? 'alert' : 'status'}
            >
              <span>{toast.message}</span>
              {toast.onUndo ? (
                <button
                  ref={undoBtnRef}
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={undoToast}
                >
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {selected.size > 0 ? (
          <div className="select-bar" role="toolbar" aria-label="selection">
            <input
              type="text"
              className="field discard-note"
              placeholder="why? (optional — saved with each discard)"
              aria-label="Discard note (optional, applies to every ticked task)"
              title="Saved with every ticked task's discard so future-you knows why"
              value={bulkNote}
              maxLength={2000}
              disabled={pending}
              onChange={(e) => setBulkNote(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={pending}
              onClick={discardSelected}
              title="Discards every ticked task — records and history are kept"
            >
              {pending ? 'Discarding…' : `Discard ${selected.size} selected`}
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => setSelectedSet(new Set())}
            >
              Clear
            </button>
          </div>
        ) : null}
      </div>
    </WorkspaceContext.Provider>
  );
}
