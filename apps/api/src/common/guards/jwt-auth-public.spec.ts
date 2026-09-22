import { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The public-route branch of the auth guard.
 *
 * A `@Public()` route still attaches a user when one can be identified, so the
 * response can be viewer-aware — an enrollment badge on a public course page.
 * The rule that branch has to keep is that "viewer-aware" never becomes a
 * weaker version of "authenticated": a revoked device must stop being
 * recognised everywhere, including on the pages anyone can read.
 */
function makeGuard(over: { verify?: jest.Mock; session?: unknown } = {}) {
  const jwtService = {
    verifyAsync: over.verify ?? jest.fn().mockResolvedValue({ sub: 'u1', sessionId: 's1' }),
  } as any;
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as any; // isPublic
  const prisma = {
    deviceSession: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.session === undefined ? { revokedAt: null, user: { isActive: true } } : over.session,
        ),
    },
  } as any;
  return { guard: new JwtAuthGuard(jwtService, reflector, prisma), jwtService, prisma };
}

function ctx(headers: Record<string, string> = {}) {
  const request: any = { headers };
  return {
    request,
    host: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext,
  };
}

const bearer = { authorization: 'Bearer token-abc' };

describe('JwtAuthGuard — public routes', () => {
  it('lets an anonymous request through with no user', async () => {
    const { guard } = makeGuard();
    const { host, request } = ctx();

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('attaches the viewer when the token and session are good', async () => {
    const { guard } = makeGuard();
    const { host, request } = ctx(bearer);

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: 'u1' });
  });

  /**
   * The property this change exists for: a ban that applies everywhere except
   * the pages anyone can read is not a ban.
   */
  it('does NOT attach a revoked session, but still serves the page', async () => {
    const { guard } = makeGuard({ session: { revokedAt: new Date(), user: { isActive: true } } });
    const { host, request } = ctx(bearer);

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('does NOT attach a disabled account', async () => {
    const { guard } = makeGuard({ session: { revokedAt: null, user: { isActive: false } } });
    const { host, request } = ctx(bearer);

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('does NOT attach when the session no longer exists', async () => {
    const { guard } = makeGuard({ session: null });
    const { host, request } = ctx(bearer);

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('pins HS256, rather than relying on the library default', async () => {
    const { guard, jwtService } = makeGuard();
    const { host } = ctx(bearer);

    await guard.canActivate(host);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ algorithms: ['HS256'] }),
    );
  });

  it('stays public when the token is garbage', async () => {
    const { guard } = makeGuard({ verify: jest.fn().mockRejectedValue(new Error('bad signature')) });
    const { host, request } = ctx(bearer);

    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('stays public when the session lookup itself fails', async () => {
    const { guard, prisma } = makeGuard();
    prisma.deviceSession.findUnique.mockRejectedValue(new Error('db down'));
    const { host, request } = ctx(bearer);

    // A public page must not start refusing visitors because the database
    // hiccuped while answering a question only used for decoration.
    await expect(guard.canActivate(host)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});
