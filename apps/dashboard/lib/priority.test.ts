import { TASK_PRIORITY_LABELS, type TaskPriority } from '@sower/core';
import { describe, expect, it } from 'vitest';
import { PRIORITY_MAX, PRIORITY_MIN, stepPriority } from './priority';

describe('stepPriority (the ▼/▲ control cycle)', () => {
  it('walks the full ladder one level per click: Low → Normal → High → Highest', () => {
    let priority: TaskPriority = PRIORITY_MIN;
    const climbed: string[] = [TASK_PRIORITY_LABELS[priority]];
    while (priority !== PRIORITY_MAX) {
      priority = stepPriority(priority, 1);
      climbed.push(TASK_PRIORITY_LABELS[priority]);
    }
    expect(climbed).toEqual(['Low', 'Normal', 'High', 'Highest']);
  });

  it('▲ from High reaches Highest and stops there (the button is disabled at the stop)', () => {
    expect(stepPriority(1, 1)).toBe(2);
    expect(TASK_PRIORITY_LABELS[stepPriority(1, 1)]).toBe('Highest');
    // Clamped: even a stray extra step never exceeds the top.
    expect(stepPriority(2, 1)).toBe(2);
  });

  it('▼ stops at Low', () => {
    expect(stepPriority(0, -1)).toBe(-1);
    expect(stepPriority(-1, -1)).toBe(-1);
  });

  it('steps down from Highest back through High', () => {
    expect(stepPriority(2, -1)).toBe(1);
  });
});
