import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '@darsly/shared-types';

/** Injects the verified JWT payload: { sub, role, tenantId?, sessionId }. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
