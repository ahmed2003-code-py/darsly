#!/usr/bin/env node
/**
 * Synthetic world for the C3 reception-desk browser E2E (scripts/e2e/desk-e2e.mjs).
 *
 * LOCAL E2E DATABASE ONLY: refuses to run unless DATABASE_URL names a database
 * called darsly_c3e2e on localhost. Every account gets a fresh random password
 * and every card a fresh random token; both are written only to a file in the
 * OS temp directory (never the repository) for the E2E to read.
 *
 * The clock matters: classes are placed relative to NOW, so seed right before
 * running the E2E.
 *
 * Usage:
 *   DATABASE_URL=postgresql://…@localhost:…/darsly_c3e2e node scripts/e2e/desk-seed.cjs
 */
const { createHash, randomBytes, randomInt } = require('crypto');
const { writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const ROOT = join(__dirname, '..', '..');
const { PrismaClient } = require(join(ROOT, 'node_modules/@prisma/client'));
const argon2 = require(
  require.resolve('argon2', {
    paths: [join(ROOT, 'apps/api/node_modules'), join(ROOT, 'node_modules')],
  }),
);

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('refusing: DATABASE_URL must be the local darsly_c3e2e database');

const OUT = join(tmpdir(), 'darsly-desk-e2e.json');
/** A fixed-offset zone where it is about noon now, so "today" holds whenever this runs. */
function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}
const p = new PrismaClient();
const MIN = 60_000;
const token = () => Array.from({ length: 48 }, () => randomInt(0, 10)).join('');
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

let codeSeq = 20000;
function code() {
  const body = String(codeSeq++);
  let sum = 0;
  let dbl = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return body + String((10 - (sum % 10)) % 10);
}

(async () => {
  const password = `E2e-${randomBytes(9).toString('base64url')}`;
  const hash = await argon2.hash(password);
  const tag = randomBytes(3).toString('hex');
  const email = (who) => `${who}-${tag}@desk-e2e.test`;
  const user = (who, role, fullName) =>
    p.user.create({ data: { email: email(who), role, fullName, passwordHash: hash } });
  const grade = await p.gradeLevel.upsert({
    where: { code: 'sec-3' },
    create: {
      code: 'sec-3',
      nameAr: 'الثالث الثانوي',
      nameEn: 'Secondary 3',
      stage: 'SECONDARY',
      sortOrder: 12,
    },
    update: {},
  });

  async function center(slug, name, ownerName) {
    const owner = await user(`${slug}-owner`, 'STAFF', ownerName);
    const academy = await p.academy.create({
      data: {
        slug: `${slug}-${tag}`,
        name,
        ownerUserId: owner.id,
        kind: 'CENTER',
        timezone: middayZone(),
      },
    });
    await p.academyMembership.create({
      data: {
        userId: owner.id,
        academyId: academy.id,
        role: 'OWNER',
        status: 'ACTIVE',
        isHome: true,
      },
    });
    for (const key of [
      'studentRegistry',
      'classOperations',
      'receptionDesk',
      'centerFees',
      'studentFollowUp',
      // C6: paper exams and grades.
      'paperExams',
    ])
      await p.academyFeatureFlag.create({ data: { academyId: academy.id, key, enabled: true } });
    return { owner, academy };
  }
  const A = await center('desk', 'سنتر المستقبل', 'مدير سنتر المستقبل');
  const B = await center('other', 'سنتر آخر', 'مدير سنتر آخر');
  const aid = A.academy.id;

  const staff = async (who, name, permissions) => {
    const u = await user(who, 'STAFF', name);
    await p.academyMembership.create({
      data: {
        userId: u.id,
        academyId: aid,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        courseScope: 'ALL',
        isHome: true,
        title: name,
        permissions,
      },
    });
    return u;
  };
  // The Reception & desk preset (C3 + C4's fees.view / fees.collect).
  const FRONT_DESK = [
    'student.view',
    'student.directory',
    'student.register',
    'desk.checkin',
    'card.manage',
    'fees.view',
    'fees.collect',
    // C5: the Reception & desk preset follows up with families too.
    'guardian.manage',
    'followup.view',
    'followup.manage',
  ];
  const reception = await staff('reception', 'منى الاستقبال', FRONT_DESK);
  const reception2 = await staff('reception2', 'هالة الاستقبال', FRONT_DESK);
  const c1only = await staff('c1only', 'سجل فقط', [
    'student.view',
    'student.directory',
    'student.register',
  ]);

  const tUser = await user('teacher', 'TEACHER', 'أ/ عمرو سالم');
  const tp = await p.teacherProfile.create({
    data: { userId: tUser.id, slug: `desk-t-${tag}`, status: 'APPROVED' },
  });
  await p.academy.create({
    data: { id: tp.id, slug: `desk-t-${tag}`, name: 'أكاديمية عمرو', ownerUserId: tUser.id },
  });
  await p.academyMembership.create({
    data: { userId: tUser.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE' },
  });
  await p.academyMembership.create({
    data: { userId: tUser.id, academyId: aid, role: 'TEACHER', status: 'ACTIVE', isHome: true },
  });

  const room1 = await p.room.create({ data: { academyId: aid, name: 'قاعة 1' } });
  const room2 = await p.room.create({ data: { academyId: aid, name: 'Lab 2 · معمل' } });
  const group = (name, extra = {}) =>
    p.group.create({ data: { academyId: aid, name, lateGraceMin: 10, ...extra } });
  const G = {
    A: await group('فيزياء — مجموعة أ', { gradeId: grade.id, capacity: 45 }),
    C: await group('كيمياء — مجموعة ج'),
    B: await group('Physics B · مجموعة ب', { capacity: 3 }),
    D: await group('أحياء — مجموعة د', { capacity: 30 }),
    E: await group('رياضة — مجموعة هـ'),
    F: await group('عربي — مجموعة و'),
  };
  await p.groupAssignment.create({
    data: { groupId: G.A.id, userId: tUser.id, role: 'TEACHER', academyId: aid },
  });

  const cls = (g, offsetMin, dur = 90, room = null) => {
    const startAt = new Date(Date.now() + offsetMin * MIN);
    return p.groupSession.create({
      data: {
        academyId: aid,
        groupId: g.id,
        startAt,
        endAt: new Date(startAt.getTime() + dur * MIN),
        locationType: 'CENTER',
        roomId: room?.id ?? null,
        teacherUserId: g.id === G.A.id ? tUser.id : null,
        createdBy: A.owner.id,
      },
    });
  };
  const classes = {
    A: await cls(G.A, -3, 120, room1), // on now, inside the grace
    C: await cls(G.C, -20, 90, room2), // on now, past the grace → LATE
    B: await cls(G.B, -5, 90), // full for makeups
    D: await cls(G.D, -1, 90), // open seats for a makeup
    E: await cls(G.E, -30, 90), // closed below
    // Later today and not open yet (it opens an hour before) — kept short
    // of midnight so a late-evening run still has it "today".
    F: await cls(G.F, 75, 30),
  };
  await p.attendanceSession.create({
    data: {
      groupSessionId: classes.E.id,
      groupId: G.E.id,
      academyId: aid,
      date: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'),
      createdBy: A.owner.id,
      closedAt: new Date(),
      closedBy: A.owner.id,
    },
  });

  const FIRST = [
    'أحمد',
    'محمد',
    'مريم',
    'سارة',
    'يوسف',
    'نور',
    'عمر',
    'ليلى',
    'كريم',
    'هدى',
    'علي',
    'فاطمة',
    'حسن',
    'منى',
    'خالد',
    'رنا',
    'زياد',
    'ندى',
    'طارق',
    'سلمى',
  ];
  let n = 0;
  async function student(
    academyId,
    groups,
    { withdrawn = false, card = true, name, account = false } = {},
  ) {
    const fullName =
      name ??
      `${FIRST[n % FIRST.length]} ${['السيد', 'إبراهيم', 'مصطفى', 'عبد الرحمن'][n % 4]} ${n}`;
    n++;
    const u = account
      ? await user(`student${n}`, 'STUDENT', fullName)
      : await p.user.create({ data: { role: 'STUDENT', fullName } });
    const sp = await p.studentProfile.create({ data: { userId: u.id } });
    const rec = await p.academyStudent.create({
      data: {
        academyId,
        studentId: sp.id,
        code: code(),
        fullName,
        gradeId: grade.id,
        guardianPhone: `+2010${String(10000000 + n).slice(0, 8)}`,
        source: 'DESK',
        status: withdrawn ? 'WITHDRAWN' : 'ACTIVE',
        leftAt: withdrawn ? new Date(Date.now() - 3 * 3600_000) : null,
      },
    });
    for (const g of groups)
      await p.groupMembership.create({
        data: {
          groupId: g.id,
          studentId: sp.id,
          academyId,
          addedAt: new Date(Date.now() - 86_400_000),
        },
      });
    let t = null;
    if (card) {
      t = token();
      await p.academyStudentCard.create({
        data: { academyId, academyStudentId: rec.id, tokenHash: sha(t), issuedBy: A.owner.id },
      });
    }
    return { id: rec.id, studentId: sp.id, code: rec.code, name: fullName, token: t, userId: u.id };
  }

  const S = {
    // 14 in group A: the Rush queue and the single-class cases.
    a: [],
    late: await student(aid, [G.C], { name: 'بسمة متأخرة' }),
    multi: await student(aid, [G.A, G.C], { name: 'مريم حصتين' }),
    noClass: await student(aid, [G.F], { name: 'عمر حصته بالليل' }),
    withdrawn: await student(aid, [G.A], { withdrawn: true, name: 'طارق منسحب' }),
    closed: await student(aid, [G.E], { name: 'سلمى الحصة اتقفلت' }),
    noCard: await student(aid, [G.A], { card: false, name: 'كريم من غير كارت' }),
    noCard2: await student(aid, [G.A], { card: false, name: 'Karim No Card' }),
    guest: await student(aid, [G.F], { name: 'نور تعويض' }),
    longName: await student(aid, [G.A], {
      name: 'عبد الرحمن محمد عبد العزيز إبراهيم السيد الشرقاوي أبو المجد',
    }),
    account: await student(aid, [G.A], { account: true, name: 'حساب طالب' }),
    foreign: await student(B.academy.id, [], { name: 'طالب سنتر تاني' }),
  };
  for (let i = 0; i < 14; i++) S.a.push(await student(aid, [G.A]));
  for (let i = 0; i < 3; i++) await student(aid, [G.B], { card: false }); // B is full (3 of 3)
  // A card that was replaced: the old token must fail.
  const revoked = await student(aid, [G.A], { name: 'هدى كارتها اتغير' });
  await p.academyStudentCard.update({
    where: { tokenHash: sha(revoked.token) },
    data: { revokedAt: new Date(), revokedBy: A.owner.id, revokeReason: 'LOST' },
  });
  const fresh = token();
  await p.academyStudentCard.create({
    data: {
      academyId: aid,
      academyStudentId: revoked.id,
      tokenHash: sha(fresh),
      issuedBy: A.owner.id,
    },
  });
  S.revoked = { ...revoked, oldToken: revoked.token, token: fresh };

  const out = {
    password,
    academyId: aid,
    foreignAcademyId: B.academy.id,
    emails: {
      owner: A.owner.email,
      reception: reception.email,
      c1only: c1only.email,
      reception2: reception2.email,
      teacher: tUser.email,
      foreignOwner: B.owner.email,
      student: S.account && email(`student${n}`),
    },
    groups: Object.fromEntries(Object.entries(G).map(([k, v]) => [k, { id: v.id, name: v.name }])),
    classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.id])),
    students: S,
  };
  // The account student's email is the one made in student().
  out.emails.student = (await p.user.findUniqueOrThrow({ where: { id: S.account.userId } })).email;
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`seeded ${n} students in "${A.academy.name}" (+1 foreign); fixture → ${OUT}`);
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
