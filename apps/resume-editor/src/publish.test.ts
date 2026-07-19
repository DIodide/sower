import { documents, resumes } from '@sower/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { publishResume, vaultPathFor } from './publish.js';

interface DbWrite {
  method: 'insert' | 'update';
  table: unknown;
  arg: unknown;
}

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onArg?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    values: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    set: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
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

describe('publishResume', () => {
  it('new resume: uploads the PDF, inserts a documents row, inserts the resumes row', async () => {
    const { storage, puts } = createFakeStorage();
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'doc-1' }], []],
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
});
