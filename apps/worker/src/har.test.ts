import { describe, expect, it } from 'vitest';
import {
  buildRecordHarOptions,
  HAR_CONTENT_TYPE,
  HAR_DOCUMENT_KIND,
  harFilename,
  planHarAttachment,
} from './har.js';

const TASK_ID = '3f0c8dbb-6f5e-4b57-9b1c-2a54d2b3c111';

describe('buildRecordHarOptions', () => {
  it('builds a per-task HAR path with safe capture settings', () => {
    expect(buildRecordHarOptions(TASK_ID, '/tmp/sower-har')).toEqual({
      path: `/tmp/sower-har/task-${TASK_ID}.har`,
      mode: 'minimal',
      content: 'omit',
    });
  });

  it('never embeds response bodies (content stays "omit")', () => {
    // SAFETY: HAR bodies can carry cookies/tokens; this must never change
    // without revisiting the redaction story.
    expect(buildRecordHarOptions(TASK_ID, '/x').content).toBe('omit');
  });

  it('tolerates a trailing slash in the directory', () => {
    expect(buildRecordHarOptions(TASK_ID, '/tmp/hars/').path).toBe(
      `/tmp/hars/task-${TASK_ID}.har`,
    );
  });

  it('rejects task ids that could escape the directory', () => {
    expect(() => buildRecordHarOptions('../etc/passwd', '/tmp')).toThrow(
      /Invalid task id/,
    );
    expect(() => harFilename('a/b')).toThrow(/Invalid task id/);
    expect(() => harFilename('')).toThrow(/Invalid task id/);
  });
});

describe('planHarAttachment', () => {
  it('plans the documents row and vault storage key for a task HAR', () => {
    expect(planHarAttachment(TASK_ID)).toEqual({
      taskId: TASK_ID,
      kind: HAR_DOCUMENT_KIND,
      filename: `task-${TASK_ID}.har`,
      storagePath: `tasks/${TASK_ID}/har/task-${TASK_ID}.har`,
      contentType: HAR_CONTENT_TYPE,
    });
  });

  it('produces a storage key that satisfies the vault key rules', () => {
    const { storagePath } = planHarAttachment(TASK_ID);
    // Mirrors @sower/storage assertSafeKey: relative, no empty/'..' segments.
    expect(storagePath.startsWith('/')).toBe(false);
    expect(storagePath.includes('\\')).toBe(false);
    for (const segment of storagePath.split('/')) {
      expect(segment).not.toBe('');
      expect(segment).not.toBe('..');
    }
  });
});
