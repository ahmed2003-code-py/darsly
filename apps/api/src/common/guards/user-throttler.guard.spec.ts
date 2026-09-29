import { JwtService } from '@nestjs/jwt';
import { UserThrottlerGuard } from './user-throttler.guard';

describe('UserThrottlerGuard — who a request counts against', () => {
  const secret = 'test-secret-for-throttle';
  const jwt = new JwtService();
  const guard = new UserThrottlerGuard({ throttlers: [] } as any, {} as any, {} as any);
  const tracker = (headers: Record<string, string>) =>
    (guard as any).getTracker({ headers, ip: '203.0.113.7', ips: [] });

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = secret;
  });

  it('a signed-in caller counts as themselves, not as their network', async () => {
    const token = await jwt.signAsync({ sub: 'user-1' }, { secret, algorithm: 'HS256' });
    expect(await tracker({ authorization: `Bearer ${token}` })).toBe('u:user-1');
  });

  it('a made-up or foreign token cannot buy a fresh bucket — the IP counts', async () => {
    const forged = await jwt.signAsync({ sub: 'user-1' }, { secret: 'other', algorithm: 'HS256' });
    expect(await tracker({ authorization: `Bearer ${forged}` })).toBe('203.0.113.7');
    expect(await tracker({ authorization: 'Bearer not-a-jwt' })).toBe('203.0.113.7');
  });

  it('an expired token and an anonymous call count against the IP', async () => {
    const expired = await jwt.signAsync(
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 60 },
      { secret, algorithm: 'HS256' },
    );
    expect(await tracker({ authorization: `Bearer ${expired}` })).toBe('203.0.113.7');
    expect(await tracker({})).toBe('203.0.113.7');
  });
});
