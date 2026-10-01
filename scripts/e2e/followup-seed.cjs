#!/usr/bin/env node
/**
 * C5 additions to the local E2E world (run after desk-seed.cjs): attendance
 * history and an overdue fee, so Today's follow-up signals have something
 * real to derive. Written straight into the C2 and C4 tables of the LOCAL E2E
 * DATABASE ONLY — exactly as C2 and C4 would have recorded them.
 *
 *   a[8]  absent the last 3 classes of group A  → ABSENT_STREAK
 *   a[9]  late the last 3 classes of group A    → LATE_STREAK
 *   a[10] a fee overdue by 20 days              → FEES_OVERDUE
 *   a[11] nothing; register guardian contact only (the invite flow)
 *   a[12] overdue fee + absent streak, checks in at the desk (never a gate)
 *
 * Usage: DATABASE_URL=…/darsly_c3e2e node scripts/e2e/followup-seed.cjs
 */
const { readFileSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('refusing: DATABASE_URL must be the local darsly_c3e2e database');

const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const p = new PrismaClient();
const S = F.students;
const A = F.academyId;

(async () => {
  const academy = await p.academy.findUniqueOrThrow({
    where: { id: A },
    select: { timezone: true, ownerUserId: true },
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: academy.timezone }).format(new Date());
  const day = (n) => {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };
  const group = F.groups.A.id;
  const classes = [];
  for (const n of [3, 2, 1]) {
    const date = day(n);
    // 16:00 in the centre's (fixed-offset, about-noon) zone, a few days back.
    const startAt = new Date(`${date}T16:00:00Z`);
    const gs = await p.groupSession.create({
      data: {
        academyId: A,
        groupId: group,
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        status: 'COMPLETED',
        locationType: 'CENTER',
        createdBy: academy.ownerUserId,
      },
    });
    const sh = await p.attendanceSession.create({
      data: {
        academyId: A,
        groupId: group,
        date: new Date(`${date}T00:00:00Z`),
        groupSessionId: gs.id,
        createdBy: academy.ownerUserId,
        closedAt: new Date(),
        closedBy: academy.ownerUserId,
      },
    });
    classes.push(sh.id);
  }
  const mark = (s, status) =>
    Promise.all(
      classes.map((sessionId) =>
        p.attendanceRecord.create({
          data: {
            academyId: A,
            sessionId,
            studentId: s.studentId,
            status,
            markedBy: academy.ownerUserId,
          },
        }),
      ),
    );
  await mark(S.a[8], 'ABSENT');
  await mark(S.a[9], 'LATE');
  await mark(S.a[12], 'ABSENT');
  const overdue = (s, cents) =>
    p.centerCharge.create({
      data: {
        id: randomUUID(),
        academyId: A,
        academyStudentId: s.id,
        kind: 'ONE_TIME',
        description: 'ملزمة',
        amountCents: cents,
        currency: 'EGP',
        dueOn: new Date(`${day(20)}T00:00:00Z`),
        createdBy: academy.ownerUserId,
        requestKey: randomUUID().replace(/-/g, ''),
      },
    });
  await overdue(S.a[10], 15000);
  await overdue(S.a[12], 20000);
  const out = {
    ...F,
    followUp: {
      absent: S.a[8],
      late: S.a[9],
      fees: S.a[10],
      contact: S.a[11],
      owing: S.a[12],
      today,
    },
  };
  writeFileSync(join(tmpdir(), 'darsly-followup-e2e.json'), JSON.stringify(out, null, 2));
  console.log('follow-up world seeded for', today);
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
