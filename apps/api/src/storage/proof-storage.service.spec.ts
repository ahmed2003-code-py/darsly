import { UnauthorizedException } from '@nestjs/common';
import { ProofStorageService } from './proof-storage.service';
import { StorageProvider } from './storage.provider';

/**
 * Proof screenshots as objects, and the signed links that show them.
 *
 * The rules that matter: a legacy `data:` row passes through untouched, a key
 * becomes a link that expires, and a link that has been tampered with — in its
 * key, its expiry or its signature — opens nothing.
 */
describe('proof screenshots as objects', () => {
  const put = jest.fn(async () => undefined);
  const del = jest.fn(async () => undefined);
  const getStream = jest.fn(async () => ({ stream: {} as any, contentType: 'image/png', contentLength: 3, totalSize: 3 }));
  const storage = { put, delete: del, getStream } as unknown as StorageProvider;
  const svc = new ProofStorageService(storage);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  beforeAll(() => {
    process.env.VIDEO_SIGNING_SECRET = 'test-secret';
    process.env.API_URL = 'https://api.example.test';
  });
  beforeEach(() => jest.clearAllMocks());

  it('stores a data URL as an object under payment-proofs and hands back the key', async () => {
    const key = await svc.store('topups', png, 1_000_000);
    expect(key).toMatch(/^payment-proofs\/topups\/[0-9a-f-]{36}\.png$/);
    expect(put).toHaveBeenCalledWith(key, expect.any(Buffer), expect.objectContaining({ contentType: 'image/png' }));
    // The body is the decoded bytes, not the data URL text.
    expect((put.mock.calls[0] as any)[1]).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('refuses anything that is not an image data URL, and stores nothing', async () => {
    await expect(svc.store('payments', 'not an image', 1_000_000)).rejects.toThrow();
    await expect(svc.store('payments', 'data:text/plain;base64,aGk=', 1_000_000)).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  it('turns a key into a signed link on the API origin, and leaves a legacy data URL alone', () => {
    const url = svc.urlFor('payment-proofs/payments/abc.jpg')!;
    expect(url.startsWith('https://api.example.test/api/v1/files/payment-proofs?k=')).toBe(true);
    expect(url).toMatch(/&e=\d+&t=[A-Za-z0-9_-]+$/);
    expect(svc.urlFor(png)).toBe(png);
    expect(svc.urlFor(null)).toBeNull();
    expect(svc.urlFor('')).toBeNull();
  });

  it('opens the object for a link it signed, and only that link', async () => {
    const url = new URL(svc.urlFor('payment-proofs/payments/abc.jpg')!);
    const k = url.searchParams.get('k')!, e = Number(url.searchParams.get('e')), t = url.searchParams.get('t')!;
    await expect(svc.open(k, e, t)).resolves.toMatchObject({ contentType: 'image/png' });
    expect(getStream).toHaveBeenCalledWith('payment-proofs/payments/abc.jpg');

    // A different key with the same signature, a longer life, a bent signature.
    await expect(svc.open('payment-proofs/payments/other.jpg', e, t)).rejects.toThrow(UnauthorizedException);
    await expect(svc.open(k, e + 3600, t)).rejects.toThrow(UnauthorizedException);
    await expect(svc.open(k, e, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).rejects.toThrow(UnauthorizedException);
    // And one that has simply run out.
    await expect(svc.open(k, Math.floor(Date.now() / 1000) - 1, t)).rejects.toThrow(UnauthorizedException);
  });

  it('never serves a key outside its own prefix, however it is signed', async () => {
    await expect(svc.open('hls/asset/master.m3u8', 9999999999, 'x')).rejects.toThrow();
    await expect(svc.open('source/video.mp4', 9999999999, 'x')).rejects.toThrow();
    expect(getStream).not.toHaveBeenCalled();
  });

  it('discards quietly, because a proof without a row is nothing to keep', async () => {
    del.mockRejectedValueOnce(new Error('gone already'));
    await expect(svc.discard('payment-proofs/topups/x.png')).resolves.toBeUndefined();
  });
});
