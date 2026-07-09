import { Readable } from 'stream';

export interface PutOptions {
  contentType?: string;
  /** cache-control header to persist alongside the object (s3) */
  cacheControl?: string;
}

export interface RangeRequest {
  start: number;
  end?: number;
}

export interface StoredObjectStream {
  stream: Readable;
  contentType?: string;
  contentLength: number;
  /** total object size, even when a byte range was requested */
  totalSize: number;
  /** [start,end] actually served when a range was requested */
  range?: { start: number; end: number };
}

/**
 * Backend-agnostic object storage. The whole video pipeline talks to this
 * interface only, so swapping local disk (dev) for S3/Spaces/R2 (prod) is a
 * config change — no pipeline code moves. Keys are POSIX-style paths, e.g.
 * `hls/<assetId>/master.m3u8`. Raw source objects live under `source/…` and
 * are NEVER exposed through any signed URL — only encrypted HLS is served.
 */
export abstract class StorageProvider {
  abstract readonly driver: 'local' | 's3';

  abstract put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<void>;
  abstract getBuffer(key: string): Promise<Buffer>;
  abstract getStream(key: string, range?: RangeRequest): Promise<StoredObjectStream>;
  abstract exists(key: string): Promise<boolean>;
  abstract delete(key: string): Promise<void>;
  /** delete every object under a key prefix (e.g. an asset's whole HLS dir) */
  abstract deletePrefix(prefix: string): Promise<void>;

  /**
   * Absolute local filesystem path for a key when the driver keeps files on
   * disk (lets ffmpeg read/write directly). Returns null for remote drivers,
   * where the pipeline must stage through temp files instead.
   */
  abstract localPath(key: string): string | null;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
