import { Role } from '@darsly/shared-types';

export interface NotificationLike {
  type?: string;
  meta?: Record<string, unknown> | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * Where a notification should take you when you tap it.
 *
 * The server says what happened (`type`) and carries the ids involved
 * (`meta`); the destination for the same event differs by who is reading it —
 * an enrolment is a course to the student who bought it and a roster entry to
 * the teacher who now owns it. Returns null when nothing specific is worth
 * opening, and the caller just marks it read.
 */
export function notificationRoute(n: NotificationLike, role?: string): string | null {
  const meta = (n.meta ?? {}) as Record<string, unknown>;
  const threadId = str(meta.threadId);
  const courseId = str(meta.courseId);
  const isTeacher = role === Role.TEACHER;
  const isAdmin = role === Role.SUPER_ADMIN;

  switch (n.type) {
    case 'CHAT_MESSAGE':
      // The thread itself, not the inbox — MessagesPage opens whatever ?t= names.
      return threadId ? `/messages?t=${threadId}` : '/messages';

    case 'ENROLLMENT_APPROVED':
      return courseId ? `/course/${courseId}` : '/my-courses';

    case 'QUIZ_GRADED':
      // Only the score travels in meta, so the best that can be opened is the
      // list the graded work belongs to.
      return courseId ? `/course/${courseId}` : '/my-courses';

    case 'LIVE_SESSION_REMINDER':
      return isTeacher ? '/teacher/live' : '/live';

    case 'PAYOUT_STATUS':
      return isAdmin ? '/admin/payouts' : '/teacher/wallet';

    case 'SECURITY_ALERT':
      return isTeacher ? '/teacher/security' : isAdmin ? '/admin/security' : '/profile';

    case 'NEW_LESSON':
      return courseId ? `/course/${courseId}` : '/my-courses';

    case 'ANNOUNCEMENT':
    default: {
      // ANNOUNCEMENT is the catch-all the whole platform reaches for, so the
      // ids it carries are what distinguish one from another.
      if (str(meta.topupId)) return isAdmin ? '/admin/wallet' : '/wallet';
      if (str(meta.certificateId)) return '/my-certificates';
      if (str(meta.payoutId)) return isAdmin ? '/admin/payouts' : '/teacher/wallet';
      // A payment waiting on someone: the teacher acts on it from the roster,
      // where pending enrolments live; the admin has a screen of its own.
      if (str(meta.paymentId)) {
        return isAdmin ? '/admin/payments' : isTeacher ? '/teacher/students' : courseId ? `/course/${courseId}` : '/my-courses';
      }
      // A new review — `rating` is what marks it. The public course page is
      // where reviews are actually shown, including to the teacher; the
      // builder they'd otherwise land on doesn't show them at all.
      if (typeof meta.rating === 'number' && courseId) return `/course/${courseId}`;
      if (meta.audience === 'teacher') return '/teacher/students';
      if (threadId) return `/messages?t=${threadId}`;
      if (courseId) return isTeacher ? `/teacher/courses/${courseId}` : `/course/${courseId}`;
      return null;
    }
  }
}
