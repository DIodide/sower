import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, GcsStorage, LocalStorage } from './index.js';

describe('LocalStorage', () => {
  let root: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sower-vault-'));
    storage = new LocalStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a buffer through nested keys', async () => {
    const key = 'documents/123e4567-e89b-12d3-a456-426614174000/resume.pdf';
    const data = Buffer.from('%PDF-1.4 fake resume');

    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, data, 'application/pdf');
    expect(await storage.exists(key)).toBe(true);

    const roundTripped = await storage.get(key);
    expect(Buffer.isBuffer(roundTripped)).toBe(true);
    expect(roundTripped.equals(data)).toBe(true);
  });

  it('accepts Uint8Array data', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put('documents/blob.bin', data);
    expect([...(await storage.get('documents/blob.bin'))]).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('overwrites an existing key', async () => {
    await storage.put('a/b.txt', Buffer.from('first'));
    await storage.put('a/b.txt', Buffer.from('second'));
    expect((await storage.get('a/b.txt')).toString()).toBe('second');
  });

  it('reports missing keys and rejects reads of them', async () => {
    expect(await storage.exists('nope/missing.txt')).toBe(false);
    await expect(storage.get('nope/missing.txt')).rejects.toThrow();
  });

  it('rejects unsafe keys', async () => {
    for (const key of ['../escape.txt', '/absolute.txt', 'a/../../b', '']) {
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(
        /Invalid storage key/,
      );
      await expect(storage.get(key)).rejects.toThrow(/Invalid storage key/);
      await expect(storage.exists(key)).rejects.toThrow(/Invalid storage key/);
    }
  });
});

describe('createStorage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects the GCS driver when VAULT_BUCKET is set', () => {
    vi.stubEnv('VAULT_BUCKET', 'sower-production-vault');
    const storage = createStorage();
    expect(storage).toBeInstanceOf(GcsStorage);
    expect((storage as GcsStorage).bucketName).toBe('sower-production-vault');
  });

  it('selects the local driver rooted at VAULT_LOCAL_DIR otherwise', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sower-vault-env-'));
    try {
      vi.stubEnv('VAULT_BUCKET', '');
      vi.stubEnv('VAULT_LOCAL_DIR', root);
      const storage = createStorage();
      expect(storage).toBeInstanceOf(LocalStorage);

      await storage.put('documents/x/hello.txt', Buffer.from('hi'));
      const onDisk = await readFile(
        path.join(root, 'documents', 'x', 'hello.txt'),
        'utf8',
      );
      expect(onDisk).toBe('hi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults the local driver to .vault at the repo root', () => {
    vi.stubEnv('VAULT_BUCKET', '');
    vi.stubEnv('VAULT_LOCAL_DIR', '');
    const storage = createStorage();
    expect(storage).toBeInstanceOf(LocalStorage);
    const root = (storage as LocalStorage).root;
    expect(path.basename(root)).toBe('.vault');
    // repo root = three levels up from packages/storage/src
    expect(path.dirname(root)).toBe(
      path.resolve(import.meta.dirname, '../../..'),
    );
  });
});
