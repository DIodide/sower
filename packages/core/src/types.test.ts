import { describe, expect, it } from 'vitest';
import { TASK_PRIORITY_LABELS, type TaskPriority } from './types.js';

describe('TaskPriority', () => {
  it('labels every level, including the new Highest (2) above High', () => {
    expect(TASK_PRIORITY_LABELS[2]).toBe('Highest');
    expect(TASK_PRIORITY_LABELS[1]).toBe('High');
    expect(TASK_PRIORITY_LABELS[0]).toBe('Normal');
    expect(TASK_PRIORITY_LABELS[-1]).toBe('Low');
  });

  it('the int values sort Highest first under ORDER BY priority DESC', () => {
    // The DB column is a plain int, so no migration is needed for a new
    // level — numeric descending order IS the display order.
    const priorities: TaskPriority[] = [0, 2, -1, 1];
    const sorted = [...priorities].sort((a, b) => b - a);
    expect(sorted.map((p) => TASK_PRIORITY_LABELS[p])).toEqual([
      'Highest',
      'High',
      'Normal',
      'Low',
    ]);
  });
});
