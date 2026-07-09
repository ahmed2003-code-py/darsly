import { UnauthorizedException } from '@nestjs/common';
import { SignedUrlService } from './signed-url.service';

describe('SignedUrlService', () => {
  let svc: SignedUrlService;
  const baseClaims = { sid: 'sess1', uid: 'user1', aid: 'asset1', lid: 'lesson1', wm: 'DRS-12345-ABCD' };

  beforeEach(() => {
    process.env.VIDEO_SIGNING_SECRET = 'test-secret';
    process.env.SIGNED_URL_TTL_SECONDS = '300';
    svc = new SignedUrlService();
  });

  it('signs and verifies a token round-trip', () => {
    const token = svc.sign(baseClaims);
    const claims = svc.verify(token);
    expect(claims.sid).toBe('sess1');
    expect(claims.aid).toBe('asset1');
    expect(claims.wm).toBe('DRS-12345-ABCD');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a tampered payload', () => {
    const token = svc.sign(baseClaims);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...baseClaims, aid: 'other', exp: 9999999999 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(() => svc.verify(`${forged}.${sig}`)).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with a different secret', () => {
    const token = svc.sign(baseClaims);
    process.env.VIDEO_SIGNING_SECRET = 'attacker-secret';
    const other = new SignedUrlService();
    expect(() => other.verify(token)).toThrow(UnauthorizedException);
  });

  it('rejects an expired token', () => {
    const token = svc.sign(baseClaims, -1); // already expired
    expect(() => svc.verify(token)).toThrow(/expired/i);
  });

  it('scopes a token to its own asset prefix', () => {
    const claims = svc.verify(svc.sign(baseClaims));
    expect(() => svc.assertKeyBelongsToAsset(claims, 'hls/asset1/master.m3u8')).not.toThrow();
    expect(() => svc.assertKeyBelongsToAsset(claims, 'hls/asset1/360p/seg_000.ts')).not.toThrow();
  });

  it('blocks cross-asset access and path traversal', () => {
    const claims = svc.verify(svc.sign(baseClaims));
    expect(() => svc.assertKeyBelongsToAsset(claims, 'hls/asset2/master.m3u8')).toThrow(
      UnauthorizedException,
    );
    expect(() => svc.assertKeyBelongsToAsset(claims, 'hls/asset1/../source/x.mp4')).toThrow(
      UnauthorizedException,
    );
    expect(() => svc.assertKeyBelongsToAsset(claims, 'source/asset1.mp4')).toThrow(
      UnauthorizedException,
    );
  });

  it('marks preview tokens with pv=1', () => {
    const token = svc.sign({ ...baseClaims, pv: 1 });
    expect(svc.verify(token).pv).toBe(1);
  });
});
