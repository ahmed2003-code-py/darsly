import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import {
  PutOptions,
  RangeRequest,
  StorageProvider,
  StoredObjectStream,
} from './storage.provider';

/**
 * S3-compatible driver (Cloudflare R2, AWS S3, MinIO, DigitalOcean Spaces).
 * Enabled with STORAGE_DRIVER=s3.
 *
 * R2 is the intended production target and needs three things this driver
 * now does on its own: the region is `auto` (R2 rejects a real region name),
 * requests are path-style, and the endpoint is the account's
 * `https://<account-id>.r2.cloudflarestorage.com`. Nothing else about R2 is
 * different from S3 at the level this app uses.
 *
 * All objects stay private — the app issues its own short-lived signed URLs
 * through SignedUrlService and streams bytes itself, so bucket objects are
 * never made public and raw source keys are never handed to a client. No
 * bucket policy, no public access, no custom domain is needed.
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
    const endpoint = process.env.S3_ENDPOINT;
    const isR2 = /\.r2\.cloudflarestorage\.com/i.test(endpoint ?? '');
    this.client = new S3.S3Client({
      // R2 only accepts `auto`; a real region name is a 400. Anyone who set
      // one for an R2 endpoint gets the right thing rather than a puzzle.
      region: isR2 ? 'auto' : (process.env.S3_REGION ?? 'us-east-1'),
      endpoint,
      forcePathStyle: !!endpoint, // MinIO and R2 want path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
    if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
      this.logger.error('STORAGE_DRIVER=s3 but S3_ACCESS_KEY / S3_SECRET_KEY are not set');
    }
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

  /**
   * Everything under a prefix — every page of it, a thousand at a time.
   *
   * The first version listed once and deleted one by one, which stops at the
   * first thousand keys and makes a thousand requests to get there. A lesson's
   * HLS folder can exceed that on its own, so the old folder would have been
   * left half-deleted and billed forever.
   */
  async deletePrefix(prefix: string): Promise<void> {
    const s3 = await this.s3();
    let token: string | undefined;
    do {
      const listed = await s3.send(
        new s3._cmds.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? []).map((o: { Key: string }) => ({ Key: o.Key }));
      if (keys.length) {
        await s3.send(
          new s3._cmds.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  /** Remote objects have no local path — the pipeline stages through temp dirs. */
  localPath(): null {
    return null;
  }
}
