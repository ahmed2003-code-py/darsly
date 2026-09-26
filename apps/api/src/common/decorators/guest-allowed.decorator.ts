import { SetMetadata } from '@nestjs/common';

export const GUEST_ALLOWED_KEY = 'guestAllowed';

/**
 * The only routes a GUEST token may call: the classroom of the one live
 * session it was issued for. JwtAuthGuard refuses a guest everywhere else,
 * and refuses it here too unless the route's `:id` IS that session — so a
 * guest token cannot read a profile, open a chat thread, list courses, or
 * touch any other class. The service behind each route still checks the
 * guest's seat itself.
 */
export const GuestAllowed = () => SetMetadata(GUEST_ALLOWED_KEY, true);
