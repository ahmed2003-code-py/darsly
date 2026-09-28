import { SetMetadata } from '@nestjs/common';

export const GUARDIAN_ALLOWED_KEY = 'guardianAllowed';

/**
 * The only routes a GUARDIAN token may call: the guardian's own dashboard,
 * messaging, notifications and their own session. JwtAuthGuard refuses a
 * guardian everywhere else — every student, teacher, wallet and catalog
 * route — whatever that route's own checks would have said. Defence in
 * depth: the routes that do allow a guardian still authorize each request
 * through an ACTIVE GuardianLink.
 */
export const GuardianAllowed = () => SetMetadata(GUARDIAN_ALLOWED_KEY, true);
