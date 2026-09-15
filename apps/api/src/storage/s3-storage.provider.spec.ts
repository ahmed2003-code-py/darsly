import { S3StorageProvider } from './s3-storage.provider';

/**
 * The parts of the S3 driver that R2 depends on and that a stub cannot cover:
 * the region rule, and a prefix delete that walks every page.
 */
describe('the S3 driver, as R2 needs it', () => {
  const sent: any[] = [];
  const fakeSdk = {
    S3Client: class {
      opts: any;
      constructor(opts: any) { this.opts = opts; }
      async send(cmd: any) {
        sent.push(cmd);
        if (cmd.kind === 'ListObjectsV2Command') {
          // Two pages of a thousand, then a short one.
          const page = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
          const n = page < 2 ? 1000 : 7;
          return {
            Contents: Array.from({ length: n }, (_, i) => ({ Key: `${cmd.input.Prefix}${page * 1000 + i}` })),
            IsTruncated: page < 2,
            NextContinuationToken: page < 2 ? String(page + 1) : undefined,
          };
        }
        return {};
      }
    },
    ListObjectsV2Command: class { kind = 'ListObjectsV2Command'; constructor(public input: any) {} },
    DeleteObjectsCommand: class { kind = 'DeleteObjectsCommand'; constructor(public input: any) {} },
  };

  beforeEach(() => {
    sent.length = 0;
    jest.resetModules();
    jest.doMock('@aws-sdk/client-s3', () => fakeSdk, { virtual: true });
  });
  afterEach(() => {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;
  });

  const fresh = (): S3StorageProvider => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { S3StorageProvider: P } = require('./s3-storage.provider');
    return new P();
  };

  it('uses region "auto" for an R2 endpoint whatever S3_REGION says', async () => {
    process.env.S3_ENDPOINT = 'https://abc123.r2.cloudflarestorage.com';
    process.env.S3_REGION = 'eu-west-1';
    const p = fresh();
    await p.exists('x').catch(() => undefined);
    const client = (p as any).client;
    expect(client.opts.region).toBe('auto');
    expect(client.opts.forcePathStyle).toBe(true);
  });

  it('keeps a real region for a non-R2 endpoint', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_REGION = 'us-east-1';
    const p = fresh();
    await p.exists('x').catch(() => undefined);
    expect((p as any).client.opts.region).toBe('us-east-1');
  });

  it('deletes a prefix across every page, a thousand keys per request', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    const p = fresh();
    await p.deletePrefix('hls/asset-1/');
    const lists = sent.filter((c) => c.kind === 'ListObjectsV2Command');
    const dels = sent.filter((c) => c.kind === 'DeleteObjectsCommand');
    expect(lists).toHaveLength(3);
    expect(dels).toHaveLength(3);
    expect(dels.map((d) => d.input.Delete.Objects.length)).toEqual([1000, 1000, 7]);
    expect(dels[2].input.Delete.Objects[6].Key).toBe('hls/asset-1/2006');
  });
});
