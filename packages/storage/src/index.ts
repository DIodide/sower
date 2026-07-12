import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Storage as GcsClient } from '@google-cloud/storage';

/**
 * Blob storage for the vault (resumes, cover letters, other documents).
 * Keys are plain relative paths like 'documents/<uuid>/<filename>'.
 */
export interface Storage {
  put(
    path: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  get(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
}

/** Reject absolute paths and traversal so keys stay inside the vault root. */
function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.includes('\\') ||
    path.posix.isAbsolute(key) ||
    key.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Local filesystem driver, rooted at a directory (dev / tests). */
export class LocalStorage implements Storage {
  constructor(readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    _contentType?: string,
  ): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, toBuffer(data));
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolve(key);
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Google Cloud Storage driver (production). Authenticates via Application
 * Default Credentials. The client is created lazily on first use so that
 * merely constructing the driver (or importing this module) needs neither
 * credentials nor the optional dependency loaded.
 */
export class GcsStorage implements Storage {
  private client: GcsClient | undefined;

  constructor(readonly bucketName: string) {}

  private async bucket() {
    if (!this.client) {
      const { Storage: Client } = await import('@google-cloud/storage');
      this.client = new Client();
    }
    return this.client.bucket(this.bucketName);
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void> {
    assertSafeKey(key);
    const bucket = await this.bucket();
    await bucket
      .file(key)
      .save(toBuffer(data), { contentType, resumable: false });
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const bucket = await this.bucket();
    const [contents] = await bucket.file(key).download();
    return contents;
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const bucket = await this.bucket();
    const [ok] = await bucket.file(key).exists();
    return ok;
  }
}

/**
 * Default local vault: '.vault' at the repo root (gitignored). The root is
 * found by walking up from cwd to the workspace marker; this deliberately
 * avoids `new URL(..., import.meta.url)`, which bundlers (Next.js/webpack)
 * statically rewrite as an asset reference and fail the build on.
 */
function defaultLocalDir(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), '.vault');
    dir = parent;
  }
  return path.join(dir, '.vault');
}

/**
 * VAULT_BUCKET set -> GCS driver against that bucket (ADC).
 * Otherwise -> local-fs driver rooted at VAULT_LOCAL_DIR (default
 * '.vault' at the repo root).
 */
export function createStorage(): Storage {
  const bucket = process.env.VAULT_BUCKET;
  if (bucket) {
    return new GcsStorage(bucket);
  }
  return new LocalStorage(process.env.VAULT_LOCAL_DIR || defaultLocalDir());
}
