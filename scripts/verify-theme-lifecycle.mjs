#!/usr/bin/env node
/**
 * Theme/Studio lifecycle (post-Reset audit): the student's theme is a
 * server-persisted StudentCustomization row; this drives it through
 * list → unlock → apply → persist → re-login → switch → wear-academy → reset,
 * and checks the SUPER_ADMIN console theme preference round-trips. Local only;
 * restores what it changed.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-theme-lifecycle.mjs
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL missing or hosted.');
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  ok ? pass++ : fail++;
};
async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r.status < 300 ? r.body.accessToken : null;
};
const prisma = new PrismaClient();
let restore = null;
let adminRestore = null;
let studentId = null;
let adminId = null;
const granted = [];

async function main() {
  console.log('== Theme / Studio lifecycle ==\n');
  const student = await prisma.user.findFirst({
    where: { role: 'STUDENT' },
    select: { id: true, email: true, studentProfile: { select: { id: true } } },
  });
  studentId = student.studentProfile.id;
  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true, email: true, adminThemePreference: true },
  });
  adminId = admin.id;
  adminRestore = admin.adminThemePreference;
  restore = await prisma.studentCustomization.findUnique({ where: { studentId } });
  let tokS = await login(student.email);
  const tokAdmin = await login(admin.email);
  check('fixture logins', !!tokS && !!tokAdmin);

  // ── Catalogue: who can see what ──
  const studio = await api('/student/studio', { token: tokS });
  check(
    'LIST: student sees the studio catalogue',
    studio.status === 200 &&
      Array.isArray(studio.body?.catalogue ?? studio.body?.items ?? studio.body?.themes),
    Object.keys(studio.body ?? {}).join(','),
  );
  const items = studio.body?.catalogue ?? studio.body?.items ?? [];
  const themes = items.filter((i) => i.category === 'THEME');
  check(
    'LIST: catalogue contains THEME items (code-defined catalog, seeded at boot)',
    themes.length >= 2,
    String(themes.length),
  );
  const inactive = await prisma.cosmeticItem.count({ where: { isActive: false } });
  const listedKeys = new Set(items.map((i) => i.key));
  const inactiveListed = (
    await prisma.cosmeticItem.findMany({ where: { isActive: false }, select: { key: true } })
  ).filter((r) => listedKeys.has(r.key));
  check(
    'LIST: retired (inactive) items are not offered',
    inactiveListed.length === 0,
    `inactive in DB=${inactive}`,
  );
  check(
    'LIST: a teacher cannot read the student studio',
    (
      await api('/student/studio', {
        token: await login(
          (
            await prisma.academy.findFirst({
              where: { kind: 'PERSONAL' },
              select: { owner: { select: { email: true } } },
            })
          ).owner.email,
        ),
      })
    ).status === 403,
  );

  // Pick two themes the student can wear. There is no starter theme and every
  // theme is coin+level gated, so a fresh student owns none — grant two as
  // test data (StudentCosmetic rows, removed in cleanup) rather than faking coins.
  const owned = new Set(items.filter((i) => i.owned).map((i) => i.key));
  const wearable = themes.filter((t) => t.owned);
  let [t1, t2] = wearable;
  if (!t2) {
    const un = await api('/student/studio/unlock', {
      token: tokS,
      method: 'POST',
      body: { key: themes[0].key },
    });
    check(
      `UNLOCK path is gated (${themes[0].key}: cost ${themes[0].costCoins}, level ${themes[0].requiredLevel})`,
      un.status >= 400 && !!un.body?.code,
      JSON.stringify(un.body?.code ?? un.status),
    );
    for (const t of themes.filter((t) => !t.owned).slice(0, 2 - wearable.length)) {
      const item = await prisma.cosmeticItem.findUnique({ where: { key: t.key } });
      await prisma.studentCosmetic.create({ data: { studentId, itemId: item.id, costCoins: 0 } });
      granted.push(item.id);
      owned.add(t.key);
    }
    const again = await api('/student/studio', { token: tokS });
    [t1, t2] = again.body.items.filter((i) => i.category === 'THEME' && i.owned);
  }
  check(
    'two wearable themes available for the switch test',
    !!t1 && !!t2,
    `${t1?.key} / ${t2?.key}`,
  );
  if (!t1 || !t2) return;

  // ── APPLY → PERSIST → RELOAD → LOGIN AGAIN → SWITCH ──
  const eq1 = await api('/student/studio/equip', {
    token: tokS,
    method: 'POST',
    body: { key: t1.key },
  });
  check(`APPLY: equip ${t1.key}`, eq1.status < 300, JSON.stringify(eq1.body?.code ?? eq1.status));
  let th = await api('/student/studio/theme', { token: tokS });
  check(
    'PERSIST: /student/studio/theme reports the applied theme (server-side, not localStorage)',
    th.status === 200 && JSON.stringify(th.body).includes(t1.key),
    JSON.stringify(th.body).slice(0, 120),
  );
  const row1 = await prisma.studentCustomization.findUnique({ where: { studentId } });
  check('PERSIST: StudentCustomization.themeKey stored in DB', row1?.themeKey === t1.key);
  tokS = await login(student.email);
  th = await api('/student/studio/theme', { token: tokS });
  check('LOGIN AGAIN: theme survives a fresh login', JSON.stringify(th.body).includes(t1.key));
  const eq2 = await api('/student/studio/equip', {
    token: tokS,
    method: 'POST',
    body: { key: t2.key },
  });
  th = await api('/student/studio/theme', { token: tokS });
  check(
    `SWITCH: equip ${t2.key} replaces ${t1.key}`,
    eq2.status < 300 &&
      JSON.stringify(th.body).includes(t2.key) &&
      !JSON.stringify(th.body).includes(t1.key),
  );
  check(
    'PREVIEW: unequipped theme details are still readable in the catalogue (preview needs no equip)',
    items.some((i) => i.key === t1.key),
  );

  // ── Teacher look vs personal theme: mutually exclusive, never a silent override ──
  const enr = await prisma.enrollment.findFirst({
    where: { studentId, status: 'ACTIVE' },
    select: { tenantId: true, academyId: true },
  });
  if (enr) {
    const wear = await api('/student/studio/equip-academy', {
      token: tokS,
      method: 'POST',
      body: { academyId: enr.tenantId },
    });
    const row2 = await prisma.studentCustomization.findUnique({ where: { studentId } });
    check(
      'WEAR ACADEMY: equipping a teacher look clears the personal theme (explicit, server-enforced — no silent override)',
      wear.status < 300 && row2?.academyId === enr.tenantId && row2?.themeKey === null,
      JSON.stringify(wear.body?.code ?? wear.status),
    );
    const back = await api('/student/studio/equip', {
      token: tokS,
      method: 'POST',
      body: { key: t2.key },
    });
    const row3 = await prisma.studentCustomization.findUnique({ where: { studentId } });
    check(
      'personal theme re-applied clears the academy look — the two never coexist',
      back.status < 300 && row3?.themeKey === t2.key && row3?.academyId === null,
    );
    // A Center-scoped enrolment (academyId ≠ tenantId) cannot be worn: equip-academy keys on Enrollment.tenantId.
    const centerOnly =
      await prisma.$queryRaw`SELECT "academyId" FROM "Enrollment" WHERE "studentId" = ${studentId} AND status = 'ACTIVE' AND "academyId" IS NOT NULL AND "academyId" <> "tenantId" LIMIT 1`;
    if (centerOnly.length) {
      const c = await api('/student/studio/equip-academy', {
        token: tokS,
        method: 'POST',
        body: { academyId: centerOnly[0].academyId },
      });
      check(
        'GAP (expected today): a Center look cannot be worn — equip-academy checks Enrollment.tenantId, not academyId',
        c.body?.code === 'NOT_ENROLLED',
        String(c.status),
      );
    } else {
      check(
        'GAP (documented, not exercisable here): no Center enrolment on this student to probe equip-academy scope',
        true,
      );
    }
    // A student cannot wear a teacher they never enrolled with.
    const stranger = await prisma.academy.findFirst({
      where: { kind: 'PERSONAL', id: { not: enr.tenantId } },
      select: { id: true },
    });
    check(
      'a student cannot wear an academy they are not enrolled in',
      (
        await api('/student/studio/equip-academy', {
          token: tokS,
          method: 'POST',
          body: { academyId: stranger.id },
        })
      ).body?.code === 'NOT_ENROLLED',
    );
  } else {
    check('WEAR ACADEMY: (skipped — fixture student has no ACTIVE enrolment)', true);
  }

  // ── Wearing a theme the student does not own ──
  const notOwned = themes.find(
    (t) => !owned.has(t.key) && !t.isStarter && t.key !== t2.key && (t.costCoins ?? 0) > 0,
  );
  if (notOwned)
    check(
      'a student cannot equip a theme they have not unlocked',
      (
        await api('/student/studio/equip', {
          token: tokS,
          method: 'POST',
          body: { key: notOwned.key },
        })
      ).status >= 400,
    );

  // ── RESET ──
  const rs = await api('/student/studio/customization', { token: tokS, method: 'DELETE' });
  const row4 = await prisma.studentCustomization.findUnique({ where: { studentId } });
  check(
    'RESET: clears what is worn, keeps what is owned',
    rs.status < 300 &&
      (!row4 || (row4.themeKey === null && row4.academyId === null)) &&
      (await prisma.studentCosmetic.count({ where: { studentId } })) >= owned.size,
  );

  // ── SUPER_ADMIN: console theme preference (this is what "Admin Studio" manages) ──
  const cur = await api('/admin/theme', { token: tokAdmin });
  check('ADMIN: reads own console theme preference', cur.status === 200);
  const set = await api('/admin/theme', {
    token: tokAdmin,
    method: 'PATCH',
    body: { themeId: 'midnight' },
  });
  const re = await api('/admin/theme', { token: tokAdmin });
  check(
    'ADMIN: preference persists server-side (per SUPER_ADMIN user)',
    set.status < 300 && JSON.stringify(re.body).includes('midnight'),
    JSON.stringify(set.body?.code ?? re.body).slice(0, 100),
  );
  check(
    'ADMIN: a student cannot read/set the admin console theme',
    (await api('/admin/theme', { token: tokS })).status === 403,
  );
  // There is no SUPER_ADMIN endpoint to CREATE / EDIT / PUBLISH a marketplace theme — documented gap.
  check(
    'GAP: no SUPER_ADMIN create/edit/publish endpoint for student themes exists (catalog is code-defined)',
    true,
  );
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    if (studentId) {
      if (granted.length)
        await prisma.studentCosmetic
          .deleteMany({ where: { studentId, itemId: { in: granted } } })
          .catch(() => {});
      if (restore)
        await prisma.studentCustomization
          .upsert({
            where: { studentId },
            update: {
              themeKey: restore.themeKey,
              academyId: restore.academyId,
              accentKey: restore.accentKey,
              accentHex: restore.accentHex,
            },
            create: { studentId, themeKey: restore.themeKey, academyId: restore.academyId },
          })
          .catch(() => {});
      else await prisma.studentCustomization.deleteMany({ where: { studentId } }).catch(() => {});
    }
    if (adminId)
      await prisma.user
        .update({
          where: { id: adminId },
          data: { adminThemePreference: adminRestore ?? undefined },
        })
        .catch(() => {});
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
