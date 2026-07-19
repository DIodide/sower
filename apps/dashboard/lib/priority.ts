// Pure priority-stepping logic for the ▼/▲ control (lib/priority-control),
// kept free of React so the cycle bounds are unit-testable: one click is one
// level, and the control stops hard at Low (▼) and Highest (▲).

import type { TaskPriority } from '@sower/core';

/** The ▼ stop: Low. */
export const PRIORITY_MIN: TaskPriority = -1;

/** The ▲ stop: Highest — one step above High, nothing beyond it. */
export const PRIORITY_MAX: TaskPriority = 2;

/** One stepper click: one level in `direction`, clamped at the stops. */
export function stepPriority(
  priority: TaskPriority,
  direction: 1 | -1,
): TaskPriority {
  const next = priority + direction;
  if (next > PRIORITY_MAX) return PRIORITY_MAX;
  if (next < PRIORITY_MIN) return PRIORITY_MIN;
  return next as TaskPriority;
}
