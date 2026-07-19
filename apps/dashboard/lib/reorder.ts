// Pure list mechanics for the "Waiting on you" drag-and-drop (app/
// ordered-list): move a row to an insertion slot and read off the moved
// row's new neighbors. The api owns the rank math — the client only ever
// reports WHICH rows ended up adjacent.

/**
 * Neighbor ids for POST /tasks/:id/reorder: beforeTaskId is the row
 * immediately ABOVE `id` in the new order, afterTaskId immediately BELOW.
 * A key is omitted (not null) at the list's ends.
 */
export interface ReorderNeighbors {
  beforeTaskId?: string;
  afterTaskId?: string;
}

/**
 * Move the item at `from` to insertion slot `insertAt` (a gap index 0..n
 * computed against the list WITH the item still in place, i.e. what a drop
 * between rows means visually). Returns the SAME array reference when the
 * move is a no-op, so callers can skip a pointless write.
 */
export function moveToIndex<T>(
  list: readonly T[],
  from: number,
  insertAt: number,
): readonly T[] {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(
    0,
    Math.min(list.length - 1, insertAt > from ? insertAt - 1 : insertAt),
  );
  if (target === from) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** The moved row's neighbors in the (new) order — what the api needs. */
export function neighborIds(
  list: readonly { id: string }[],
  id: string,
): ReorderNeighbors {
  const index = list.findIndex((row) => row.id === id);
  if (index === -1) return {};
  const beforeTaskId = list[index - 1]?.id;
  const afterTaskId = list[index + 1]?.id;
  return {
    ...(beforeTaskId !== undefined ? { beforeTaskId } : {}),
    ...(afterTaskId !== undefined ? { afterTaskId } : {}),
  };
}
