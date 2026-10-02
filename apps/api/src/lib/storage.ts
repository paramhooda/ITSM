import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { config } from '@/config';

/**
 * Attachment storage abstraction. The local driver stores files on a volume;
 * an S3-compatible driver can be added without touching callers.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): NodeJS.ReadableStream;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class LocalStorage implements StorageDriver {
  constructor(private root: string) {}
  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root))) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  get(key: string) {
    return readFile(this.resolve(key));
  }
  stream(key: string) {
    return createReadStream(this.resolve(key));
  }
  async delete(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
  async exists(key: string) {
    return stat(this.resolve(key)).then(() => true).catch(() => false);
  }
}

export const storage: StorageDriver = new LocalStorage(config.STORAGE_LOCAL_PATH);

/** Deterministic, customer-partitioned key: <customer|shared>/<yyyy>/<mm>/<uuid>-<safe name> */
export function storageKeyFor(customerId: string | null, id: string, filename: string) {
  const now = new Date();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `${customerId ?? 'shared'}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}-${safe}`;
}

export const sha256Buffer = (b: Buffer) => createHash('sha256').update(b).digest('hex');
