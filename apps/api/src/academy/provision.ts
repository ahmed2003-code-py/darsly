import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/** Teacher status → academy status (mirrors the one-time backfill migration). */
export const ACADEMY_STATUS_FOR: Record<string, 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'ARCHIVED'> = {
  APPROVED: 'ACTIVE',
  PENDING: 'PENDING',
  SUSPENDED: 'SUSPENDED',
  REJECTED: 'ARCHIVED',
};

export interface TeacherForProvision {
  id: string; // TeacherProfile.id — equals academyId (identity-preserving migration)
  slug: string;
  userId: string;
  status: string; // TeacherStatus
  language?: string;
  maxConcurrentSessions?: number;
  autoApproveEnrollments?: boolean;
  commissionPercent?: number;
}

/**
 * Idempotently provision a teacher's OWN Academy + OWNER membership, mirroring the
 * one-time academy backfill migration. Teacher signup/approval never created these,
 * so a teacher registered after the academy migration had no membership — and every
 * @AcademyStaff console route (courses, units, lessons, quizzes, wallet…) 404s with
 * "Academy not found". This restores their workspace. Never overwrites an existing
 * academy's settings (update:{}), so it is safe to call on every login/approval.
 */
export async function provisionTeacherAcademy(
  db: Db,
  teacher: TeacherForProvision,
  name: string,
): Promise<void> {
  await db.academy.upsert({
    where: { id: teacher.id },
    update: {},
    create: {
      id: teacher.id,
      slug: teacher.slug,
      name: name?.trim() || teacher.slug,
      status: ACADEMY_STATUS_FOR[teacher.status] ?? 'PENDING',
      ownerUserId: teacher.userId,
      language: teacher.language ?? 'ar',
      maxConcurrentSessions: teacher.maxConcurrentSessions ?? 2,
      requiresEnrollmentApproval:
        teacher.autoApproveEnrollments != null ? !teacher.autoApproveEnrollments : true,
      feeType: 'PERCENT',
      feeValue: teacher.commissionPercent ?? 20,
    },
  });
  await db.academyMembership.upsert({
    where: { userId_academyId: { userId: teacher.userId, academyId: teacher.id } },
    update: {},
    create: {
      userId: teacher.userId,
      academyId: teacher.id,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
  });
}
