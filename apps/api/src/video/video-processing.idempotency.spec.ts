import { VideoJobError } from './jobs/video-job.service';
import { VideoProcessingService } from './video-processing.service';

/**
 * Why packaging has to be safe to run twice.
 *
 * A successful run **deletes the source** — that is deliberate, the encrypted
 * HLS is the only artifact worth keeping. It also means a retry that lands
 * after a completed-but-unacknowledged attempt (a worker that finished the
 * encode and was killed before it could write SUCCEEDED, then a lease expiry
 * handing the job to someone else) would find no source and fail forever,
 * turning a finished video into a permanent error on the teacher's screen.
 *
 * The guard is that the asset's own state — not the job's — decides whether
 * the work is done.
 */
function makeService(asset: Record<string, unknown> | null) {
  const prisma = {
    videoAsset: {
      findUnique: jest.fn().mockResolvedValue(asset),
      update: jest.fn().mockResolvedValue({}),
    },
    lesson: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as any;
  const storage = { localPath: jest.fn(), getStream: jest.fn(), delete: jest.fn() } as any;
  const drm = { package: jest.fn() } as any;
  const jobs = { enqueue: jest.fn() } as any;
  const svc = new VideoProcessingService(prisma, storage, drm, jobs);
  jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
  return { svc, prisma, storage, drm, jobs };
}

describe('VideoProcessingService — running the same job twice', () => {
  it('does nothing when the asset is already READY with an HLS master', async () => {
    const { svc, drm, storage, prisma } = makeService({
      id: 'asset1',
      status: 'READY',
      hlsMasterKey: 'hls/asset1/master.m3u8',
      originalKey: 'source/asset1.mp4',
    });

    await expect(svc.process('asset1')).resolves.toBeUndefined();

    // Crucially: no re-encode, and no second attempt to read a source that a
    // previous successful run already deleted.
    expect(drm.package).not.toHaveBeenCalled();
    expect(storage.getStream).not.toHaveBeenCalled();
    expect(prisma.videoAsset.update).not.toHaveBeenCalled();
  });

  it('still packages an asset marked READY that has no master key', async () => {
    // Half-written state: READY was set but the key never landed. That is not
    // a finished video, so the guard must not treat it as one.
    const { svc, storage } = makeService({
      id: 'asset1',
      status: 'READY',
      hlsMasterKey: null,
      originalKey: 'source/asset1.mp4',
    });
    storage.localPath.mockReturnValue('/tmp/asset1.mp4');

    await svc.process('asset1').catch(() => undefined);

    expect(storage.localPath).toHaveBeenCalled();
  });

  it('re-packages a PROCESSING asset — the ordinary retry', async () => {
    const { svc, storage } = makeService({
      id: 'asset1',
      status: 'PROCESSING',
      hlsMasterKey: null,
      originalKey: 'source/asset1.mp4',
    });
    storage.localPath.mockReturnValue('/tmp/asset1.mp4');

    await svc.process('asset1').catch(() => undefined);

    expect(storage.localPath).toHaveBeenCalled();
  });

  /**
   * A row that is gone will be gone on every retry too, so three attempts at
   * it are three wasted claims and, with a CPU-bound worker, three wasted
   * minutes of someone else's queue position.
   */
  it('classifies a missing asset as TERMINAL so it is never retried', async () => {
    const { svc } = makeService(null);

    await expect(svc.process('ghost')).rejects.toMatchObject({
      name: 'VideoJobError',
      errorClass: 'TERMINAL',
    });
  });

  it('leaves the asset alone when packaging fails — the worker decides when it is final', async () => {
    const { svc, prisma, storage, drm } = makeService({
      id: 'asset1',
      status: 'PROCESSING',
      hlsMasterKey: null,
      originalKey: 'source/asset1.mp4',
    });
    storage.localPath.mockReturnValue('/tmp/asset1.mp4');
    drm.package.mockRejectedValue(new Error('ffmpeg exploded'));

    await expect(svc.process('asset1')).rejects.toThrow('ffmpeg exploded');

    // The only update is the PROCESSING marker at the start. Nothing here
    // writes FAILED: a job with retries left has not failed yet.
    const statuses = prisma.videoAsset.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).not.toContain('FAILED');
  });

  describe('enqueue', () => {
    it('marks the asset PROCESSING and writes the job in the caller transaction', async () => {
      const { svc, jobs } = makeService({ id: 'asset1' });
      const tx = { videoAsset: { update: jest.fn().mockResolvedValue({}) } } as any;

      await svc.enqueue('asset1', 'tenant1', tx);

      // PROCESSING is set here rather than at claim time so the status endpoint
      // answers exactly what it answered before the queue existed.
      expect(tx.videoAsset.update).toHaveBeenCalledWith({
        where: { id: 'asset1' },
        data: { status: 'PROCESSING' },
      });
      expect(jobs.enqueue).toHaveBeenCalledWith('asset1', 'tenant1', tx);
    });
  });

  it('exports a VideoJobError that carries its classification', () => {
    const e = new VideoJobError('nope', 'TERMINAL');
    expect(e.errorClass).toBe('TERMINAL');
    expect(e).toBeInstanceOf(Error);
  });
});
