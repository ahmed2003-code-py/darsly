import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import {
  PutOptions,
  RangeRequest,
  StorageProvider,
  StoredObjectStream,
} from './storage.provider';

/**
 * S3-compatible driver (AWS S3, MinIO, DigitalOcean Spaces, Cloudflare R2).
 * Enabled with STORAGE_DRIVER=s3. The AWS SDK is loaded lazily so the local
 * driver carries no extra dependency; to use this driver, install it:
 *
 *     npm i @aws-sdk/client-s3 --workspace=apps/api
 *
 * All objects stay private — the app issues its own short-lived signed URLs
 * through SignedUrlService and streams bytes itself, so bucket objects are
 * never made public and raw source keys are never handed to a client.
 */
@Injectable()
export class S3StorageProvider extends StorageProvider {
  readonly driver = 's3' as const;
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucket = process.env.S3_BUCKET ?? 'darsly-media';
  private client: any;

  private async s3() {
    if (this.client) return this.client;
    let S3: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      S3 = require('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        'STORAGE_DRIVER=s3 requires @aws-sdk/client-s3. Run: npm i @aws-sdk/client-s3 --workspace=apps/api',
      );
    }
    this.client = new S3.S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: !!process.env.S3_ENDPOINT, // MinIO/R2 need path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
    this.client._cmds = S3;
    return this.client;
  }

  async put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<void> {
    const s3 = await this.s3();
    await s3.send(
      new s3._cmds.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
        CacheControl: opts?.cacheControl,
      }),
    );
  }

  async getBuffer(key: string): Promise<Buffer> {
    const { stream } = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async getStream(key: string, range?: RangeRequest): Promise<StoredObjectStream> {
    const s3 = await this.s3();
    const res = await s3.send(
      new s3._cmds.GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }),
    );
    const totalSize = res.ContentRange
      ? Number(res.ContentRange.split('/')[1])
      : Number(res.ContentLength ?? 0);
    return {
      stream: res.Body as Readable,
      contentType: res.ContentType,
      contentLength: Number(res.ContentLength ?? 0),
      totalSize,
      range: range ? { start: range.start, end: range.end ?? totalSize - 1 } : undefined,
    };
  }

  async exists(key: string): Promise<boolean> {
    const s3 = await this.s3();
    try {
      await s3.send(new s3._cmds.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const s3 = await this.s3();
    await s3.send(new s3._cmds.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    const s3 = await this.s3();
    const listed = await s3.send(
      new s3._cmds.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    for (const obj of listed.Contents ?? []) {
      await this.delete(obj.Key);
    }
  }

  /** Remote objects have no local path — the pipeline stages through temp dirs. */
  localPath(): null {
    return null;
  }
}
