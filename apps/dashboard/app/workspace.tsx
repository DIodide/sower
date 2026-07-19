'use client';

// Client shell around the (server-rendered) Applications sections. Holds the
// two bits of cross-row state the rows can't own alone: the checkbox
// selection (with its sticky "Discard N selected" bar) and the single toast
// (the discard undo, action errors). Rows reach it via useWorkspace().

import { useRouter } from 'next/navigation';
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

export interface ToastOptions {
  /** "Undo" button handler — its presence renders the button. */
  onUndo?: () => void;
  /** Runs when the toast expires (or is replaced) without Undo being hit. */
  onExpire?: () => void;
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
  onUndo?: (() => void) | undefined;
}

export function Workspace({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [selected, setSelectedSet] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [toast, setToastState] = useState<ToastState | null>(null);
  const [pending, startTransition] = useTransition();
  // The live toast's expiry: timer id + the not-yet-fired onExpire callback.
  const expiryRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    onExpire?: (() => void) | undefined;
  } | null>(null);

  const clearToastTimer = useCallback((fireExpire: boolean) => {
    const expiry = expiryRef.current;
    if (!expiry) return;
    clearTimeout(expiry.timer);
    expiryRef.current = null;
    if (fireExpire) expiry.onExpire?.();
  }, []);

  useEffect(() => () => clearToastTimer(false), [clearToastTimer]);

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      // A new toast replaces the old one; the old one's pending onExpire
      // (typically a router.refresh) still runs so nothing is left stale.
      clearToastTimer(true);
      const key = Date.now();
      setToastState({ key, message, onUndo: options?.onUndo });
      expiryRef.current = {
        timer: setTimeout(() => {
          expiryRef.current = null;
          setToastState(null);
          options?.onExpire?.();
        }, TOAST_MS),
        onExpire: options?.onExpire,
      };
    },
    [clearToastTimer],
  );

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
    startTransition(async () => {
      const result = await discardTaskIds(ids);
      setSelectedSet(new Set());
      showToast(result.message);
      router.refresh();
    });
  };

  const undoToast = () => {
    if (!toast?.onUndo) return;
    const undo = toast.onUndo;
    clearToastTimer(false); // undone — the expire callback must NOT run
    setToastState(null);
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
        {toast ? (
          <div key={toast.key} className="toast" role="status">
            <span>{toast.message}</span>
            {toast.onUndo ? (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={undoToast}
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
        {selected.size > 0 ? (
          <div className="select-bar" role="toolbar" aria-label="selection">
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
