import type {
  JobSpec,
  ResolutionResult,
  TaskEvent,
  TaskState,
} from '@sower/core';
import { transition } from '@sower/core';
import { applicationTasks, events } from '@sower/db';
import { eq } from 'drizzle-orm';
import type { Db } from './types.js';

/**
 * Persist a state transition: update the task row and append an event row.
 *
 * The target state is always computed via the @sower/core transition table —
 * an illegal (state, event) pair throws InvalidTransitionError, which is a
 * bug signal (a runtime path the table forbids), never control flow.
 *
 * `patch` merges extra task columns into the SAME row update (one atomic
 * UPDATE): clearing a stale lastError alongside a successful pass, or the
 * reingest reset (attempt/jobSpec/resolution back to fresh-ingest values).
 *
 * Returns the state the task moved to.
 */
export async function transitionTask(
  db: Db,
  taskId: string,
  fromState: TaskState,
  event: TaskEvent,
  data?: Record<string, unknown>,
  patch?: {
    lastError?: string | null;
    attempt?: number;
    jobSpec?: JobSpec | null;
    resolution?: ResolutionResult | null;
  },
): Promise<TaskState> {
  const toState = transition(fromState, event);
  await db
    .update(applicationTasks)
    .set({ ...patch, state: toState, updatedAt: new Date() })
    .where(eq(applicationTasks.id, taskId));
  await db.insert(events).values({
    taskId,
    type: event,
    fromState,
    toState,
    data: data ?? null,
  });
  return toState;
}
