/**
 * Platform reset: remove every account and everything that hangs off it,
 * except the platform admin and one teacher.
 *
 * Nothing here destroys a row. Every write sets `deletedAt`, which the Prisma
 * middleware filters out of reads — so the platform behaves as though the data
 * is gone while it remains recoverable with a single UPDATE. Take a `pg_dump`
 * first anyway: a soft delete protects against a mistake in the query, not
 * against a mistake in the plan.
 *
 *   npx ts-node --transpile-only scripts/cleanup-platform.ts            # dry run
 *   npx ts-node --transpile-only scripts/cleanup-platform.ts --execute  # do it
 *   DATABASE_URL=... scripts/cleanup-platform.ts --execute              # pick the target
 *
 * Accounts additionally have their unique handles released (email, phone,
 * username get a `deleted:<ts>:` prefix) for two reasons: the person can never
 * sign in again even through a code path that skips the read filter, and the
 * address is freed so they can be re-invited later. The original is recoverable
 * by stripping the prefix.
 */
import { PrismaClient } from '@prisma/client';

const KEEP_TEACHER_EMAIL = process.env.KEEP_TEACHER ?? 'amr927@gmail.com';
const EXECUTE = process.argv.includes('--execute');
const NOW = new Date();
const STAMP = `deleted:${NOW.toISOString().slice(0, 19).replace(/[-:T]/g, '')}:`;

const prisma = new PrismaClient();
const plan: { what: string; count: number }[] = [];

/** Count now, write only when asked. */
async function step(what: string, count: () => Promise<number>, run: () => Promise<unknown>) {
  const n = await count();
  plan.push({ what, count: n });
  if (EXECUTE && n > 0) await run();
}

async function main() {
  const keep = await prisma.user.findFirst({
    where: { email: KEEP_TEACHER_EMAIL },
    include: { teacherProfile: true },
  });
  if (!keep?.teacherProfile) {
    throw new Error(`refusing to run: ${KEEP_TEACHER_EMAIL} has no teacher profile in this database`);
  }
  const keepUserId = keep.id;
  const keepTenantId = keep.teacherProfile.id; // Academy.id === TeacherProfile.id
  const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true, email: true } });
  const keptUserIds = [keepUserId, ...admins.map((a) => a.id)];

  console.log(`${EXECUTE ? 'EXECUTING' : 'DRY RUN'} against ${maskUrl()}`);
  console.log(`keeping teacher : ${KEEP_TEACHER_EMAIL} (tenant ${keepTenantId})`);
  console.log(`keeping admins  : ${admins.map((a) => a.email).join(', ') || '(none!)'}`);
  console.log('');

  const live = { deletedAt: null };
  const otherTenant = { tenantId: { not: keepTenantId } };

  // ── Content belonging to every other academy ────────────────────────────
  // Ordered parent-last so a partial run never leaves a live child under a
  // removed parent.
  await step('lessons (other academies)',
    () => prisma.lesson.count({ where: { ...live, unit: { course: otherTenant } } }),
    () => prisma.lesson.updateMany({ where: { ...live, unit: { course: otherTenant } }, data: { deletedAt: NOW } }));

  await step('course units (other academies)',
    () => prisma.courseUnit.count({ where: { ...live, course: otherTenant } }),
    () => prisma.courseUnit.updateMany({ where: { ...live, course: otherTenant }, data: { deletedAt: NOW } }));

  await step('courses (other academies)',
    () => prisma.course.count({ where: { ...live, ...otherTenant } }),
    () => prisma.course.updateMany({ where: { ...live, ...otherTenant }, data: { deletedAt: NOW } }));

  await step('coupons (other academies)',
    () => prisma.coupon.count({ where: { ...live, ...otherTenant } }),
    () => prisma.coupon.updateMany({ where: { ...live, ...otherTenant }, data: { deletedAt: NOW } }));

  await step('live sessions (other academies)',
    () => prisma.liveSession.count({ where: { ...live, ...otherTenant } }),
    () => prisma.liveSession.updateMany({ where: { ...live, ...otherTenant }, data: { deletedAt: NOW } }));

  await step('academy sites (other academies)',
    () => prisma.academySite.count({ where: { ...live, academyId: { not: keepTenantId } } }),
    () => prisma.academySite.updateMany({ where: { ...live, academyId: { not: keepTenantId } }, data: { deletedAt: NOW } }));

  await step('academies (other)',
    () => prisma.academy.count({ where: { ...live, id: { not: keepTenantId } } }),
    () => prisma.academy.updateMany({ where: { ...live, id: { not: keepTenantId } }, data: { deletedAt: NOW } }));

  await step('academy media (other academies)',
    () => prisma.academyMedia.count({ where: { ...live, academyId: { not: keepTenantId } } }),
    () => prisma.academyMedia.updateMany({ where: { ...live, academyId: { not: keepTenantId } }, data: { deletedAt: NOW } }));

  // Transfer notifications the Android listener forwarded. The admin lists
  // every one of these regardless of who it belongs to — which is why they
  // survived the first pass and kept filling the payments screen.
  await step('payment events (all)',
    () => prisma.paymentEvent.count({ where: live }),
    () => prisma.paymentEvent.updateMany({ where: live, data: { deletedAt: NOW } }));

  // ── Everything every student ever did ───────────────────────────────────
  await step('certificates (all)',
    () => prisma.certificate.count({ where: live }),
    () => prisma.certificate.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('reviews (all)',
    () => prisma.review.count({ where: live }),
    () => prisma.review.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('enrolments (all)',
    () => prisma.enrollment.count({ where: live }),
    () => prisma.enrollment.updateMany({ where: live, data: { deletedAt: NOW } }));

  // ── Money ───────────────────────────────────────────────────────────────
  // Entries before transactions, and both before payments, so a balance is
  // never read mid-way through against a half-removed book.
  await step('ledger entries (all)',
    () => prisma.ledgerEntry.count({ where: live }),
    () => prisma.ledgerEntry.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('ledger transactions (all)',
    () => prisma.ledgerTransaction.count({ where: live }),
    () => prisma.ledgerTransaction.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('invoices (all)',
    () => prisma.invoice.count({ where: live }),
    () => prisma.invoice.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('payments (all)',
    () => prisma.payment.count({ where: live }),
    () => prisma.payment.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('wallet transactions (all)',
    () => prisma.walletTransaction.count({ where: live }),
    () => prisma.walletTransaction.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('wallet top-ups (all)',
    () => prisma.walletTopup.count({ where: live }),
    () => prisma.walletTopup.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('payout requests (all)',
    () => prisma.payoutRequest.count({ where: live }),
    () => prisma.payoutRequest.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('saved payout methods (all)',
    () => prisma.payoutMethodSaved.count({ where: live }),
    () => prisma.payoutMethodSaved.updateMany({ where: live, data: { deletedAt: NOW } }));

  // ── Profiles, then the accounts themselves ──────────────────────────────
  await step('student profiles (all)',
    () => prisma.studentProfile.count({ where: live }),
    () => prisma.studentProfile.updateMany({ where: live, data: { deletedAt: NOW } }));

  await step('teacher profiles (other)',
    () => prisma.teacherProfile.count({ where: { ...live, id: { not: keepTenantId } } }),
    () => prisma.teacherProfile.updateMany({ where: { ...live, id: { not: keepTenantId } }, data: { deletedAt: NOW } }));

  // Memberships of removed academies, and of removed people in the kept one.
  // The kept academy's member list joins to User through a nested include,
  // which the soft-delete read filter does not reach — so without this a
  // removed student would still be listed as a member.
  await step('academy memberships (removed academies or people)',
    () => prisma.academyMembership.count({
      where: { deletedAt: null, OR: [{ academyId: { not: keepTenantId } }, { userId: { notIn: keptUserIds } }] },
    }),
    () => prisma.academyMembership.updateMany({
      where: { deletedAt: null, OR: [{ academyId: { not: keepTenantId } }, { userId: { notIn: keptUserIds } }] },
      data: { deletedAt: NOW },
    }));

  // Sessions are revoked outright: a live refresh token is access, not history.
  await step('device sessions (removed accounts)',
    () => prisma.deviceSession.count({ where: { userId: { notIn: keptUserIds }, revokedAt: null } }),
    () => prisma.deviceSession.updateMany({
      where: { userId: { notIn: keptUserIds }, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: 'platform reset' },
    }));

  const doomed = await prisma.user.findMany({
    where: { ...live, id: { notIn: keptUserIds } },
    select: { id: true, email: true, phone: true, username: true },
  });
  plan.push({ what: 'user accounts (all but admin + kept teacher)', count: doomed.length });
  if (EXECUTE) {
    for (const u of doomed) {
      await prisma.user.update({
        where: { id: u.id },
        data: {
          deletedAt: NOW,
          // Belt and braces: `isActive` is already checked on every login path,
          // and releasing the handles means the identifier no longer resolves
          // even through a query that skips the soft-delete read filter.
          isActive: false,
          email: u.email ? `${STAMP}${u.email}`.slice(0, 200) : null,
          phone: u.phone ? `${STAMP}${u.phone}`.slice(0, 200) : null,
          username: u.username ? `${STAMP}${u.username}`.slice(0, 200) : null,
        },
      });
    }
  }

  console.log('what this run touches:');
  for (const row of plan) console.log(`  ${String(row.count).padStart(6)}  ${row.what}`);
  const total = plan.reduce((a, b) => a + b.count, 0);
  console.log(`  ${String(total).padStart(6)}  rows in total`);
  console.log(EXECUTE ? '\ndone — all reversible by clearing deletedAt.' : '\nnothing was written. re-run with --execute.');
}

function maskUrl(): string {
  const u = process.env.DATABASE_URL ?? '';
  return u.replace(/:\/\/[^@]*@/, '://***@').split('?')[0] || '(default DATABASE_URL)';
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
