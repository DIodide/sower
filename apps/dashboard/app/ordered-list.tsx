'use client';

// Client wrapper that OWNS the visual order of the "Waiting on you" rows so
// drag-and-drop (and the grip's keyboard arrows) reorder optimistically: the
// list re-renders instantly, the rank write is debounced/coalesced to the api
// (the midpoint math lives server-side — the client only reports the moved
// row's new NEIGHBORS), and a failure reverts to the last server-confirmed
// order with a toast. A move that crosses a priority-tier boundary adopts
// the destination tier: the client derives it from the same neighbor rule
// the api uses (lib/reorder dropPriority), updates the row's priority chip
// optimistically, and toasts "Moved to High"; keyboard moves additionally
// carry the tier in the SR announcement ("Moved above <label> — now High").
// Server refreshes reset the order to the server truth via the
// derive-state-from-changed-props pattern — EXCEPT while a move is still
// unflushed or in flight (H3): resetting then would yank the row back
// mid-drag and make the eventual write's neighbors lie; the flush's own
// refresh re-delivers fresh rows once the write lands.
//
// When any row is hand-ranked, a one-line hint under the section heading
// explains the hybrid order and offers "clear manual order" (H6) — one api
// call nulls the section's ranks and the pure priority/arrival sort returns.

import { TASK_PRIORITY_LABELS, type TaskPriority } from '@sower/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  dropPriority,
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

  /**
   * Apply a finished move: when the row landed across a tier boundary it
   * ADOPTS the destination tier (dropPriority — the exact neighbor rule the
   * api derives server-side from the same ids), so the optimistic state
   * updates its priority chip and a toast confirms "Moved to High". The row
   * is also marked hand-ranked — that is what the write makes it. Returns
   * the adopted tier, or null when the move stayed within one tier.
   */
  const settle = (
    next: readonly TaskRowData[],
    moved: TaskRowData,
  ): TaskPriority | null => {
    const index = next.findIndex((row) => row.id === moved.id);
    const above = next[index - 1];
    const below = next[index + 1];
    const tier = dropPriority(above?.priority, below?.priority);
    const adopted = tier !== undefined && tier !== moved.priority;
    applyOrder(
      adopted || !moved.ranked
        ? next.map((row) =>
            row.id === moved.id
              ? { ...row, priority: tier ?? moved.priority, ranked: true }
              : row,
          )
        : next,
    );
    if (adopted) ws.toast(`Moved to ${TASK_PRIORITY_LABELS[tier]}`);
    return adopted ? tier : null;
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
    const tier = settle(next, moved);
    const where =
      direction === -1
        ? `Moved above ${swapped.label}`
        : `Moved below ${swapped.label}`;
    setAnnounce(
      tier !== null ? `${where} — now ${TASK_PRIORITY_LABELS[tier]}` : where,
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
    const moved = current[from];
    if (!moved) return;
    settle(next, moved);
    scheduleWrite(moved.id);
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

  // H6: return the whole section to the pure priority/arrival sort. A
  // pending drag write is deliberately DROPPED — the user just asked for no
  // manual order at all. A reorder write already on the wire may re-rank its
  // one row (the api's documented clear/reorder race); the refresh below —
  // and the seq bump — keep this client from ever showing a stale order.
  const clearOrder = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    // Invalidate any reorder write already on the wire: its response must not
    // be applied over the clear (the api's CASE guard keeps the cleared rank
    // NULL server-side; this keeps the client from resurrecting the hint).
    seqRef.current += 1;
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
            title="Remove the hand-made order — every row sorts by priority and arrival again"
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
