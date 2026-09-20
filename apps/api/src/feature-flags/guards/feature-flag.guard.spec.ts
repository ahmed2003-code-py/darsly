import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard } from './feature-flag.guard';

function makeCtx(academyContext: any, metaValue: unknown) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(metaValue) } as unknown as Reflector;
  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ academyContext }) }),
  } as any;
  return { reflector, ctx };
}

describe('FeatureFlagGuard', () => {
  it('passes through when the route has no @RequireFeature', async () => {
    const flags = { isEnabled: jest.fn() };
    const { reflector, ctx } = makeCtx({ academyId: 'a1' }, undefined);
    const guard = new FeatureFlagGuard(reflector, flags as any);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });

  it('allows the request when the flag is enabled', async () => {
    const flags = { isEnabled: jest.fn().mockResolvedValue(true) };
    const { reflector, ctx } = makeCtx({ academyId: 'a1' }, 'attendance');
    const guard = new FeatureFlagGuard(reflector, flags as any);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('a1', 'attendance');
  });

  it('403s a disabled flag instead of proceeding — API-level enforcement, not just hidden UI', async () => {
    const flags = { isEnabled: jest.fn().mockResolvedValue(false) };
    const { reflector, ctx } = makeCtx({ academyId: 'a1' }, 'attendance');
    const guard = new FeatureFlagGuard(reflector, flags as any);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403s when no academy context was resolved', async () => {
    const flags = { isEnabled: jest.fn() };
    const { reflector, ctx } = makeCtx(undefined, 'attendance');
    const guard = new FeatureFlagGuard(reflector, flags as any);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });
});
