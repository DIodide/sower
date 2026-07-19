import { documents, resumes, resumeVersions } from '@sower/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { publishResume, vaultPathFor, versionPdfPathFor } from './publish.js';

interface DbWrite {
  method: 'insert' | 'update';
  table: unknown;
  arg: unknown;
}

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
  onConflictDoNothing: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onArg?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    orderBy: () => self,
    values: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    set: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
    onConflictDoNothing: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function createFakeDb(options: {
  selectResults?: unknown[][];
  insertResults?: unknown[][];
  writes?: DbWrite[];
}) {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  return {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
    // biome-ignore lint/suspicious/noExplicitAny: structural fake for tests
  } as any;
}

function createFakeStorage() {
  const puts: { path: string; bytes: Buffer; contentType?: string }[] = [];
  const storage = {
    put: async (path: string, bytes: Buffer, contentType?: string) => {
      puts.push({ path, bytes, contentType });
    },
    get: async () => Buffer.alloc(0),
    exists: async () => false,
  };
  return { storage, puts };
}

const input = {
  name: 'swe-2027',
  texPath: 'developer/resumes/swe-2027.tex',
  texSource: '\\documentclass{article}',
  pdf: Buffer.from('%PDF-1.7 fake'),
  commitSha: 'abc123',
};

let writes: DbWrite[];

beforeEach(() => {
  writes = [];
});

describe('vaultPathFor', () => {
  it('uses the fixed overwritten per-resume path', () => {
    expect(vaultPathFor('swe-2027')).toBe('resumes/swe-2027/swe-2027.pdf');
  });

  it('keeps underscores and mixed case intact (the real resume name)', () => {
    expect(vaultPathFor('Ibraheem_Amin_Resume')).toBe(
      'resumes/Ibraheem_Amin_Resume/Ibraheem_Amin_Resume.pdf',
    );
  });
});

describe('versionPdfPathFor', () => {
  it('keys the immutable copy on the commit sha, next to the latest pointer', () => {
    expect(versionPdfPathFor('swe-2027', 'abc123')).toBe(
      'resumes/swe-2027/versions/abc123.pdf',
    );
  });
});

describe('publishResume', () => {
  it('new resume: uploads the PDF, inserts a documents row, inserts the resumes row', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'doc-1' }], [{ id: 'resume-new' }]],
      writes,
    });

    const { storagePath } = await publishResume(db, storage, input);

    expect(storagePath).toBe('resumes/swe-2027/swe-2027.pdf');
    expect(puts).toEqual([
      {
        path: 'resumes/swe-2027/swe-2027.pdf',
        bytes: input.pdf,
        contentType: 'application/pdf',
      },
    ]);
    expect(writes[0]?.method).toBe('insert');
    expect(writes[0]?.table).toBe(documents);
    expect(writes[0]?.arg).toEqual({
      kind: 'resume',
      filename: 'swe-2027.pdf',
      storagePath: 'resumes/swe-2027/swe-2027.pdf',
      contentType: 'application/pdf',
      sizeBytes: input.pdf.length,
    });
    expect(writes[1]?.method).toBe('insert');
    expect(writes[1]?.table).toBe(resumes);
    expect(writes[1]?.arg).toMatchObject({
      name: 'swe-2027',
      texPath: input.texPath,
      texSource: input.texSource,
      pdfStoragePath: 'resumes/swe-2027/swe-2027.pdf',
      lastCommitSha: 'abc123',
      documentId: 'doc-1',
    });
    // No `version` input: nothing else is written or uploaded.
    expect(writes).toHaveLength(2);
  });

  it('existing resume WITH a documentId: updates both rows, inserts nothing', async () => {
    const { storage } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
      ],
      writes,
    });

    await publishResume(db, storage, input);

    expect(writes.map((w) => w.method)).toEqual(['update', 'update']);
    expect(writes[0]?.table).toBe(documents);
    expect(writes[1]?.table).toBe(resumes);
    expect(writes[1]?.arg).toMatchObject({
      texSource: input.texSource,
      lastCommitSha: 'abc123',
      documentId: 'doc-9',
    });
  });

  it('existing resume WITHOUT a documentId: inserts the documents row and links it', async () => {
    const { storage } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [[{ id: 'resume-1', name: 'swe-2027', documentId: null }]],
      insertResults: [[{ id: 'doc-new' }]],
      writes,
    });

    await publishResume(db, storage, input);

    expect(writes.map((w) => w.method)).toEqual(['insert', 'update']);
    expect(writes[0]?.table).toBe(documents);
    expect(writes[1]?.table).toBe(resumes);
    expect(writes[1]?.arg).toMatchObject({ documentId: 'doc-new' });
  });

  it('version (write kind): uploads the per-commit PDF copy and records the resume_versions row', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
      ],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      version: { kind: 'write', runId: 'run-1' },
    });

    // Same compile output uploaded twice: latest pointer + immutable copy.
    expect(puts.map((p) => p.path)).toEqual([
      'resumes/swe-2027/swe-2027.pdf',
      'resumes/swe-2027/versions/abc123.pdf',
    ]);
    const versionWrite = writes.find((w) => w.table === resumeVersions);
    expect(versionWrite).toBeDefined();
    expect(versionWrite?.method).toBe('insert');
    expect(versionWrite?.arg).toEqual({
      resumeId: 'resume-1',
      commitSha: 'abc123',
      texSource: input.texSource,
      pdfStoragePath: 'resumes/swe-2027/versions/abc123.pdf',
      runId: 'run-1',
      kind: 'write',
    });
  });

  it('version (fork kind): a NEW resume records its first version against the inserted id', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'doc-1' }], [{ id: 'resume-new' }]],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      name: 'stripe-2027',
      version: { kind: 'fork', runId: 'run-2' },
    });

    expect(puts.map((p) => p.path)).toContain(
      'resumes/stripe-2027/versions/abc123.pdf',
    );
    const versionWrite = writes.find((w) => w.table === resumeVersions);
    expect(versionWrite?.arg).toMatchObject({
      resumeId: 'resume-new',
      kind: 'fork',
      runId: 'run-2',
    });
  });

  it('version (sync kind): SKIPS recording when the latest version has identical tex', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
        // Latest recorded version — same source: the repo did not drift.
        [{ id: 'ver-1', texSource: input.texSource }],
      ],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      version: { kind: 'sync', runId: 'run-3' },
    });

    expect(puts.map((p) => p.path)).toEqual(['resumes/swe-2027/swe-2027.pdf']);
    expect(writes.find((w) => w.table === resumeVersions)).toBeUndefined();
  });

  it('version (sync kind): records drift when the repo tex differs from the last version', async () => {
    const { storage } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
        [{ id: 'ver-1', texSource: '\\older' }],
      ],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      version: { kind: 'sync', runId: 'run-3' },
    });

    expect(writes.find((w) => w.table === resumeVersions)?.arg).toMatchObject({
      kind: 'sync',
      commitSha: 'abc123',
      runId: 'run-3',
    });
  });

  it('version (sync kind): BACKFILLS a first version for a resume with none', async () => {
    const { storage } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
        // No versions recorded yet.
        [],
      ],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      version: { kind: 'sync', runId: 'run-3' },
    });

    expect(writes.find((w) => w.table === resumeVersions)?.arg).toMatchObject({
      kind: 'sync',
      texSource: input.texSource,
    });
  });

  it('version: skipped entirely when commitSha is null (no identity to key on)', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [
        [{ id: 'resume-1', name: 'swe-2027', documentId: 'doc-9' }],
      ],
      writes,
    });

    await publishResume(db, storage, {
      ...input,
      commitSha: null,
      version: { kind: 'write', runId: 'run-1' },
    });

    expect(puts).toHaveLength(1);
    expect(writes.find((w) => w.table === resumeVersions)).toBeUndefined();
  });
});
