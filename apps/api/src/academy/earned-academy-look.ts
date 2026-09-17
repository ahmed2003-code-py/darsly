import { EnrollmentStatus } from '@prisma/client';

/**
 * Whose colours a student has earned the right to wear.
 *
 * A teacher's look is not bought in the Studio and is not stored anywhere: it
 * is derived from enrolments every time it is asked for. That is deliberate —
 * there is no grant table to fall out of step with reality, nothing to backfill
 * for the students who enrolled before the feature existed, and nothing to
 * clean up when an academy is deleted.
 *
 * Which enrolments count is the whole question, and the answer is "the ones
 * where they actually studied with this teacher":
 *
 *   PENDING_PAYMENT  they have paid and we are confirming it. Counted, so the
 *                    look appears the moment they buy rather than whenever an
 *                    admin next looks at the queue. If the payment is refused
 *                    the row becomes REJECTED and it goes again.
 *   ACTIVE           obviously.
 *   EXPIRED          **the one that used to be missing.** A course ending is
 *                    not the student doing anything wrong, and it is the most
 *                    common thing that happens to an enrolment. Leaving it out
 *                    meant the app silently repainted itself — a student's
 *                    Darsly went from their teacher's colours back to platform
 *                    indigo on the day their course lapsed, with nothing on
 *                    screen to explain it and no way to get it back. Once
 *                    earned, kept.
 *
 * And the two that are deliberately absent:
 *
 *   REJECTED         the payment was refused; they never studied here.
 *   REVOKED          access was taken away — a refund, a chargeback, abuse.
 *                    Whatever the reason, the cosmetic goes with it.
 *
 * This is NOT the same list as `COMMITTED` in subject-exclusivity.service.ts,
 * and the two must not be merged however similar they look: that one asks "is
 * this student currently committed to a subject", where a lapsed enrolment
 * genuinely frees them up. This one asks "did they study with this teacher",
 * and the past tense is the point.
 */
export const EARNED_LOOK_STATUSES: EnrollmentStatus[] = ['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED'];
