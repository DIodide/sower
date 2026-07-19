'use client';

// Client wrapper that OWNS the visual order of the "Waiting on you" rows so
// drag-and-drop (and the grip's keyboard arrows) reorder optimistically: the
// list re-renders instantly, the rank write is debounced/coalesced to the api
// (the midpoint math lives server-side — the client only reports the moved
// row's new NEIGHBORS), and a failure reverts to the last server-confirmed
// order with a toast. Every keyboard move is announced through an SR live
// region ("Moved above <label>"). Server refreshes reset the order to the
// server truth via the derive-state-from-changed-props pattern.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { moveToIndex, neighborIds } from '../lib/reorder';
import { TaskRow, type TaskRowData } from './task-row';
import { reorderTask } from './tasks/[id]/actions';
import { useWorkspace } from './workspace';

/** Rapid arrow presses coalesce into ONE write of the final neighbors. */
const REORDER_DEBOUNCE_MS = 400;

export function OrderedList({ rows }: { rows: TaskRowData[] }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [order, setOrder] = useState<readonly TaskRowData[]>(rows);
  const [prevRows, setPrevRows] = useState(rows);
  // The row id being dragged (null = no drag in progress).
  const [dragId, setDragId] = useState<string | null>(null);
  // Insertion slot (gap index 0..n) the pointer is currently over.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // SR-only live announcement for keyboard moves.
  const [announce, setAnnounce] = useState('');
  // Last server-confirmed order — the only revert target.
  const baseRef = useRef<readonly TaskRowData[]>(rows);
  // Mirror of `order` for closures that outlive a render (timers, unmount).
  const orderRef = useRef<readonly TaskRowData[]>(rows);
  // Monotonic write counter: only the latest write's result applies.
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row whose (not-yet-written) new position is pending.
  const pendingRef = useRef<string | null>(null);
  if (rows !== prevRows) {
    setPrevRows(rows);
    setOrder(rows);
    baseRef.current = rows;
    orderRef.current = rows;
  }

  const flush = (taskId: string) => {
    const snapshot = orderRef.current;
    const seq = ++seqRef.current;
    reorderTask(taskId, neighborIds(snapshot, taskId))
      .then((result) => {
        if (seq !== seqRef.current) return; // a newer write owns the list
        if (result.ok) {
          baseRef.current = snapshot;
        } else {
          setOrder(baseRef.current);
          orderRef.current = baseRef.current;
          ws.toast(`Reorder not saved — ${result.message}`, { kind: 'error' });
        }
        // Converge on the server truth either way.
        router.refresh();
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setOrder(baseRef.current);
        orderRef.current = baseRef.current;
        ws.toast('Reorder not saved — could not reach the server.', {
          kind: 'error',
        });
        router.refresh();
      });
  };

  const scheduleWrite = (taskId: string) => {
    // A different row's pending move flushes NOW — each write's neighbors
    // describe one row's final position, never a mixture.
    if (
      timerRef.current &&
      pendingRef.current &&
      pendingRef.current !== taskId
    ) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      const previous = pendingRef.current;
      pendingRef.current = null;
      flush(previous);
    }
    pendingRef.current = taskId;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) flush(pending);
    }, REORDER_DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) {
          // Unmounting mid-debounce must not lose the chosen order.
          void reorderTask(
            pending,
            neighborIds(orderRef.current, pending),
          ).catch(() => {});
        }
      }
    },
    [],
  );

  const applyOrder = (next: readonly TaskRowData[]) => {
    setOrder(next);
    orderRef.current = next;
  };

  /** Keyboard: move the row at `index` one position up (-1) or down (1). */
  const moveBy = (index: number, direction: -1 | 1) => {
    const current = orderRef.current;
    const target = index + direction;
    const moved = current[index];
    const swapped = current[target];
    if (!moved || !swapped) return; // already at the boundary
    const next = moveToIndex(
      current,
      index,
      direction === -1 ? target : target + 1,
    );
    if (next === current) return;
    applyOrder(next);
    setAnnounce(
      direction === -1
        ? `Moved above ${swapped.label}`
        : `Moved below ${swapped.label}`,
    );
    scheduleWrite(moved.id);
  };

  const onDragStart = (index: number, event: React.DragEvent<HTMLElement>) => {
    const row = orderRef.current[index];
    if (!row) return;
    setDragId(row.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.id);
    // Ghost the whole row, not just the grip glyph.
    const rowEl = event.currentTarget.closest('.grid-row');
    if (rowEl instanceof HTMLElement) {
      event.dataTransfer.setDragImage(rowEl, 24, rowEl.offsetHeight / 2);
    }
  };

  /** The insertion slot a pointer position over row `index` means. */
  const slotFor = (index: number, event: React.DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    return above ? index : index + 1;
  };

  const onDragOver = (index: number, event: React.DragEvent<HTMLElement>) => {
    if (dragId === null) return; // not our drag (a file, a text selection)
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setInsertAt(slotFor(index, event));
  };

  const onDrop = (index: number, event: React.DragEvent<HTMLElement>) => {
    if (dragId === null) return;
    event.preventDefault();
    const slot = slotFor(index, event);
    const current = orderRef.current;
    const from = current.findIndex((row) => row.id === dragId);
    setDragId(null);
    setInsertAt(null);
    if (from === -1) return;
    const next = moveToIndex(current, from, slot);
    if (next === current) return; // dropped where it already was
    applyOrder(next);
    const moved = current[from];
    if (moved) scheduleWrite(moved.id);
  };

  const onDragEnd = () => {
    setDragId(null);
    setInsertAt(null);
  };

  /** Insertion-line side for row `i`, hiding no-op slots around the source. */
  const dropEdgeFor = (i: number): 'above' | 'below' | null => {
    if (dragId === null || insertAt === null) return null;
    const from = order.findIndex((row) => row.id === dragId);
    if (insertAt === from || insertAt === from + 1) return null;
    if (insertAt === i) return 'above';
    if (i === order.length - 1 && insertAt === order.length) return 'below';
    return null;
  };

  return (
    <div className="row-list">
      {order.map((row, i) => (
        <TaskRow
          key={row.id}
          row={row}
          reorder={{
            index: i,
            count: order.length,
            dragging: row.id === dragId,
            dropEdge: dropEdgeFor(i),
            onDragStart,
            onDragEnd,
            onDragOver,
            onDrop,
            onMove: moveBy,
          }}
        />
      ))}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
