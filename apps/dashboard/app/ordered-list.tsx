'use client';

// Client wrapper that OWNS the visual order of the "Waiting on you" rows so
// drag-and-drop (and the grip's keyboard arrows) reorder optimistically: the
// list re-renders instantly, the rank write is debounced/coalesced to the api
// (the midpoint math lives server-side — the client only reports the moved
// row's new NEIGHBORS), and a failure reverts to the last server-confirmed
// order with a toast. Every keyboard move is announced through an SR live
// region ("Moved above <label>"). Server refreshes reset the order to the
// server truth via the derive-state-from-changed-props pattern — EXCEPT
// while a move is still unflushed or in flight (H3): resetting then would
// yank the row back mid-drag and make the eventual write's neighbors lie;
// the flush's own refresh re-delivers fresh rows once the write lands.
//
// When any row is hand-ranked, a one-line hint under the section heading
// explains the hybrid order and offers "clear manual order" (H6) — one api
// call nulls the section's ranks and the pure priority/recency sort returns.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  moveToIndex,
  neighborIds,
  type ReorderNeighbors,
} from '../lib/reorder';
import { clearManualOrder } from './actions';
import { TaskRow, type TaskRowData } from './task-row';
import { reorderTask } from './tasks/[id]/actions';
import { useWorkspace } from './workspace';

/** Rapid arrow presses coalesce into ONE write of the final neighbors. */
const REORDER_DEBOUNCE_MS = 400;

/** One not-yet-written move: the row and the neighbors it ended between,
 *  snapshotted when the move was made (H3) — a server refresh landing before
 *  the debounce fires must not change what gets written. */
interface PendingMove {
  taskId: string;
  neighbors: ReorderNeighbors;
}

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
  // "clear manual order" in flight.
  const [clearing, setClearing] = useState(false);
  // Last server-confirmed order — the only revert target.
  const baseRef = useRef<readonly TaskRowData[]>(rows);
  // Mirror of `order` for closures that outlive a render (timers, unmount).
  const orderRef = useRef<readonly TaskRowData[]>(rows);
  // Monotonic write counter: only the latest write's result applies.
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The move whose write is debounce-pending (snapshot, see PendingMove).
  const pendingRef = useRef<PendingMove | null>(null);
  // Reorder writes currently on the wire.
  const inflightRef = useRef(0);
  if (rows !== prevRows) {
    setPrevRows(rows);
    // H3: while a move is unflushed or a write is in flight, the fresh
    // server rows predate it — applying them would revert the move on
    // screen. The flush's router.refresh() converges once the write lands.
    if (
      timerRef.current === null &&
      pendingRef.current === null &&
      inflightRef.current === 0
    ) {
      setOrder(rows);
      baseRef.current = rows;
      orderRef.current = rows;
    }
  }

  const flush = (move: PendingMove) => {
    const snapshot = orderRef.current;
    const seq = ++seqRef.current;
    inflightRef.current += 1;
    reorderTask(move.taskId, move.neighbors)
      .then((result) => {
        inflightRef.current -= 1;
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
        inflightRef.current -= 1;
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
    const pending = pendingRef.current;
    if (timerRef.current && pending && pending.taskId !== taskId) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;
      flush(pending);
    }
    // Snapshot the neighbors NOW (H3): the write must describe the position
    // the user chose, whatever props arrive before the debounce fires.
    pendingRef.current = {
      taskId,
      neighbors: neighborIds(orderRef.current, taskId),
    };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const move = pendingRef.current;
      pendingRef.current = null;
      if (move) flush(move);
    }, REORDER_DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const move = pendingRef.current;
        pendingRef.current = null;
        if (move) {
          // Unmounting mid-debounce must not lose the chosen order.
          void reorderTask(move.taskId, move.neighbors).catch(() => {});
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

  // H6: return the whole section to the pure priority/recency sort. A
  // pending drag write is deliberately DROPPED — the user just asked for no
  // manual order at all — and the server's conditional writes keep any
  // still-in-flight one from resurrecting a cleared rank.
  const clearOrder = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setClearing(true);
    clearManualOrder()
      .then((result) => {
        if (result.ok) {
          ws.toast('Manual order cleared — sorted by priority again');
        } else {
          ws.toast(`Order not cleared — ${result.message}`, { kind: 'error' });
        }
        router.refresh();
      })
      .catch(() => {
        ws.toast('Order not cleared — could not reach the server.', {
          kind: 'error',
        });
      })
      .finally(() => {
        setClearing(false);
      });
  };

  const hasManualOrder = order.some((row) => row.ranked);

  return (
    <div>
      {hasManualOrder ? (
        <p className="hint order-hint">
          Your order — drag to change ·{' '}
          <button
            type="button"
            className="order-clear"
            disabled={clearing}
            onClick={clearOrder}
            title="Remove the hand-made order — every row sorts by priority and recency again"
          >
            {clearing ? 'clearing…' : 'clear manual order'}
          </button>
        </p>
      ) : null}
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
    </div>
  );
}
