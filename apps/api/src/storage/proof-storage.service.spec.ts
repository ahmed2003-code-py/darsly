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
  // The complete 8-byte PNG signature. It used to be the first four, which is
  // not a PNG: uploads are now checked against the declared type's magic
  // number, so a truncated one is rejected the same way a mislabelled HEIF is.
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = 'data:image/png;base64,' + Buffer.from(PNG_MAGIC).toString('base64');

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
    expect((put.mock.calls[0] as any)[1]).toEqual(Buffer.from(PNG_MAGIC));
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

/**
 * Security model for GET /files/payment-proofs (the one @Public() file route).
 *
 * The URL is a CAPABILITY: `k` (an unguessable, prefix-locked object key), `e`
 * (a 10-minute expiry) and `t` = HMAC-SHA256(secret, `${k}\n${e}`), compared in
 * constant time. No session is checked on the way in — an <img> cannot send a
 * bearer token — so the guarantee is that such a URL is only ever *issued* by
 * academy-scoped list endpoints (ManualPaymentsService.list, academyId-scoped)
 * and admin queues, and cannot be forged, extended, re-pointed or replayed
 * after expiry. Traversal is closed twice: `isKey` pins the prefix here, and
 * LocalStorageProvider.resolve() refuses anything escaping its root.
 */
describe('payment-proof link — threat model regressions', () => {
  const getStream = jest.fn(async () => ({ stream: {} as any, contentType: 'image/jpeg', contentLength: 1, totalSize: 1 }));
  const storage = { put: jest.fn(), delete: jest.fn(), getStream } as unknown as StorageProvider;
  const svc = new ProofStorageService(storage);
  beforeAll(() => { process.env.VIDEO_SIGNING_SECRET = 'test-secret'; process.env.API_URL = 'https://api.example.test'; });
  beforeEach(() => jest.clearAllMocks());
  const parts = (key: string) => {
    const u = new URL(svc.urlFor(key)!);
    return { k: u.searchParams.get('k')!, e: Number(u.searchParams.get('e')), t: u.searchParams.get('t')! };
  };

  it('1. the intended link opens the intended object', async () => {
    const { k, e, t } = parts('payment-proofs/payments/mine.jpg');
    await expect(svc.open(k, e, t)).resolves.toBeDefined();
    expect(getStream).toHaveBeenCalledWith('payment-proofs/payments/mine.jpg');
  });
  it('2. an invalid token is refused', async () => {
    const { k, e } = parts('payment-proofs/payments/mine.jpg');
    await expect(svc.open(k, e, 'not-a-signature')).rejects.toThrow(UnauthorizedException);
  });
  it('3. a modified token (single character) is refused — constant-time compare, no partial match', async () => {
    const { k, e, t } = parts('payment-proofs/payments/mine.jpg');
    const bent = t.slice(0, 5) + (t[5] === 'a' ? 'b' : 'a') + t.slice(6);
    await expect(svc.open(k, e, bent)).rejects.toThrow(UnauthorizedException);
  });
  it('4/5/6. the same signature cannot be re-pointed at another payment, tenant or Center proof', async () => {
    const { e, t } = parts('payment-proofs/payments/teacherA-student1.jpg');
    for (const other of ['payment-proofs/payments/teacherA-student2.jpg', 'payment-proofs/payments/teacherB-x.jpg', 'payment-proofs/payments/centerZ-y.jpg', 'payment-proofs/topups/t.jpg']) {
      await expect(svc.open(other, e, t)).rejects.toThrow(UnauthorizedException);
    }
    expect(getStream).not.toHaveBeenCalled();
  });
  it('7. without any signature at all nothing is served (the route is public but not open)', async () => {
    await expect(svc.open('payment-proofs/payments/mine.jpg', 9999999999, '')).rejects.toThrow(UnauthorizedException);
    expect(getStream).not.toHaveBeenCalled();
  });
  it('8. path traversal and foreign prefixes never reach storage, even correctly signed for that string', async () => {
    for (const evil of ['../.env', 'payment-proofs/../../.env', 'payment-proofs/payments/../../../etc/passwd', 'hls/x.m3u8', '/payment-proofs/x.jpg', '']) {
      // Sign the hostile string exactly as the service would — the prefix check must still win.
      let e = 9999999999, t = 'x';
      try { ({ e, t } = parts(evil)); } catch { /* urlFor refuses non-keys: fine */ }
      await expect(svc.open(evil, e, t)).rejects.toThrow();
    }
    expect(getStream).not.toHaveBeenCalled();
  });
  it('8b. a traversal that KEEPS the prefix is stopped by the storage root guard, not just the prefix', async () => {
    // isKey passes ("payment-proofs/…"); LocalStorageProvider.resolve() must refuse it.
    const { LocalStorageProvider } = await import('./local-storage.provider');
    const local = new LocalStorageProvider();
    await expect(local.getBuffer('payment-proofs/../../secret.txt')).rejects.toThrow(/Illegal storage key/);
  });
  it('9. malformed identifiers are refused, not coerced', async () => {
    const { k, t } = parts('payment-proofs/payments/mine.jpg');
    await expect(svc.open(k, NaN, t)).rejects.toThrow(UnauthorizedException);
    await expect(svc.open(k, Infinity, t)).rejects.toThrow(UnauthorizedException);
    await expect(svc.open(k, -1, t)).rejects.toThrow(UnauthorizedException);
  });
  it('10. a link expires: after `e` it is refused even with a valid signature; links live 10 minutes', async () => {
    const { k, e, t } = parts('payment-proofs/payments/mine.jpg');
    expect(e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    const past = Math.floor(Date.now() / 1000) - 5;
    // A signature minted for a past expiry is still refused on expiry alone.
    const sign = (svc as any).sign.bind(svc);
    await expect(svc.open(k, past, sign(k, past))).rejects.toThrow(/expired/i);
    await expect(svc.open(k, e, t)).resolves.toBeDefined();
  });
});
