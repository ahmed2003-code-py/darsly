import { Injectable } from '@nestjs/common';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  PutOptions,
  RangeRequest,
  StorageProvider,
  StoredObjectStream,
} from './storage.provider';

/**
 * Dev/default driver: objects are files under STORAGE_LOCAL_PATH. Keys map
 * straight to relative paths; traversal (`..`) is rejected so a signed key can
 * never escape the storage root.
 */
@Injectable()
export class LocalStorageProvider extends StorageProvider {
  readonly driver = 'local' as const;
  private readonly root = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Illegal storage key: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer | Readable, _opts?: PutOptions): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await fs.writeFile(full, body);
    } else {
      await fs.writeFile(full, body);
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async getStream(key: string, range?: RangeRequest): Promise<StoredObjectStream> {
    const full = this.resolve(key);
    const stat = await fs.stat(full);
    if (range) {
      const start = Math.max(0, range.start);
      const end = Math.min(range.end ?? stat.size - 1, stat.size - 1);
      return {
        stream: createReadStream(full, { start, end }),
        contentLength: end - start + 1,
        totalSize: stat.size,
        range: { start, end },
      };
    }
    return {
      stream: createReadStream(full),
      contentLength: stat.size,
      totalSize: stat.size,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }

  localPath(key: string): string {
    return this.resolve(key);
  }
}
