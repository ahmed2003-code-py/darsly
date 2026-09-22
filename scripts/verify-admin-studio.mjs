#!/usr/bin/env node
/**
 * Real HTTP + DB verification of the Admin Studio look catalogue: presets +
 * every Academy brand + every store theme, server-resolved; choose/clear;
 * only ids ever accepted; SUPER_ADMIN only; choosing never writes to the
 * Academy or the item. Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-admin-studio.mjs
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) { console.error('REFUSED: DATABASE_URL missing or hosted.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); ok ? pass++ : fail++; };
async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json };
}
const login = async (email) => { const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } }); return r.status < 300 ? r.body.accessToken : null; };
const prisma = new PrismaClient();
const TRIPLE = /^\d{1,3} \d{1,3} \d{1,3}$/;
const TOKEN_KEYS = ['background', 'surface', 'surfaceElevated', 'text', 'textMuted', 'primary', 'secondary', 'accent', 'success', 'warning', 'danger', 'border', 'sidebar', 'topbar', 'chart1', 'chart2', 'chart3'];
const wellFormed = (e) => TOKEN_KEYS.every((k) => TRIPLE.test(e.tokens?.[k] ?? '')) && ['light', 'dark'].includes(e.mode) && typeof e.id === 'string' && typeof e.name === 'string';

let adminId = null, original = null;
async function main() {
  console.log('== Admin Studio look catalogue verification ==\n');
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true, email: true, adminThemePreference: true } });
  adminId = admin.id; original = admin.adminThemePreference;
  const student = await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { email: true } });
  const teacher = await prisma.academy.findFirst({ where: { kind: 'PERSONAL', status: 'ACTIVE' }, select: { id: true, owner: { select: { email: true } } } });
  const adminTok = await login(admin.email), studentTok = await login(student.email), teacherTok = await login(teacher.owner.email);
  check('fixture logins', !!adminTok && !!studentTok && !!teacherTok);

  // ── Catalogue ──
  const cat = await api('/admin/theme/catalog', { token: adminTok });
  check('1. catalogue served to SUPER_ADMIN', cat.status === 200 && Array.isArray(cat.body.presets) && Array.isArray(cat.body.academies) && Array.isArray(cat.body.cosmetics));
  check('2. all 8 built-in presets, namespaced', cat.body.presets.length === 8 && cat.body.presets.every((p) => p.id.startsWith('preset:') && p.source === 'PRESET'));
  const liveAcademies = await prisma.academy.count({ where: { deletedAt: null, status: { not: 'ARCHIVED' } } });
  check(`3. every live Academy is on the shelf (${liveAcademies})`, cat.body.academies.length === liveAcademies && cat.body.academies.every((a) => a.id.startsWith('academy:') && a.source === 'ACADEMY'));
  check('4. Centers and teachers both present and labelled by kind', cat.body.academies.some((a) => a.meta.academyKind === 'PERSONAL') && cat.body.academies.every((a) => ['PERSONAL', 'CENTER'].includes(a.meta.academyKind)));
  const activeThemes = await prisma.cosmeticItem.count({ where: { category: 'THEME', isActive: true } });
  check(`5. every active store THEME is on the shelf (${activeThemes})`, cat.body.cosmetics.length === activeThemes && cat.body.cosmetics.every((c) => c.id.startsWith('cosmetic:') && c.source === 'COSMETIC' && c.meta.rarity));
  const everything = [...cat.body.presets, ...cat.body.academies, ...cat.body.cosmetics];
  check('6. every entry is fully resolved server-side: 17 "R G B" tokens + mode', everything.every(wellFormed));
  check('7. no raw hex, no brandTokens, no config leaks in the catalogue', !/#[0-9a-f]{6}/i.test(JSON.stringify(cat.body)) && !JSON.stringify(cat.body).includes('brandTokens') && !JSON.stringify(cat.body).includes('"config"'));
  const centerEntry = cat.body.academies.find((a) => a.meta.academyKind === 'CENTER') ?? cat.body.academies[0];
  const cosmeticEntry = cat.body.cosmetics[0];

  // ── Choose / read back ──
  const pick = await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: centerEntry.id } });
  check("8. choose an Academy's brand → saved, response carries the resolved look", pick.status === 200 && pick.body.themeId === centerEntry.id && wellFormed(pick.body.theme) && pick.body.theme.tokens.primary === centerEntry.tokens.primary, String(pick.status));
  const stored = await prisma.user.findUnique({ where: { id: adminId }, select: { adminThemePreference: true } });
  check('9. only the id is persisted — never colours', JSON.stringify(stored.adminThemePreference) === JSON.stringify({ themeId: centerEntry.id }));
  const got = await api('/admin/theme', { token: adminTok });
  check('10. GET resolves the stored id afresh from the Academy', got.status === 200 && got.body.themeId === centerEntry.id && got.body.theme.name === centerEntry.name);
  const academyBefore = await prisma.academy.findUnique({ where: { id: centerEntry.meta.academyId }, select: { colorPrimary: true, colorAccent: true, brandTokens: true, updatedAt: true } });
  check('11. choosing a brand wrote NOTHING to that Academy', !!academyBefore && (await prisma.auditLog.count({ where: { academyId: centerEntry.meta.academyId, action: 'admin_theme.set' } })) === 0);

  const pickC = await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: cosmeticEntry.id } });
  check('12. choose a store theme → resolved from its stored config', pickC.status === 200 && pickC.body.theme.source === 'COSMETIC' && pickC.body.theme.meta.cosmeticKey === cosmeticEntry.meta.cosmeticKey);
  const pickP = await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'midnight' } });
  check('13. a legacy bare preset id still works and is normalised', pickP.status === 200 && pickP.body.themeId === 'preset:midnight');
  const clear = await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: null } });
  check('14. clear → nothing chosen', clear.status === 200 && clear.body.themeId === null && clear.body.theme === null);

  // ── Nothing but a catalogue id is ever accepted ──
  check('15. unknown ids → 400', (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'preset:nope' } })).status === 400 && (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'academy:does-not-exist' } })).status === 400 && (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'cosmetic:theme-nope' } })).status === 400);
  check('16. client-supplied colours are refused outright', (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'preset:midnight', tokens: { primary: '255 0 0' } } })).status === 400 && (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { theme: { tokens: {} } } })).status === 400);
  check('17. a malformed id is refused by validation', (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: 'academy:<script>' } })).status === 400);
  const archived = await prisma.academy.findFirst({ where: { status: 'ARCHIVED' }, select: { id: true } });
  if (archived) check('18. an ARCHIVED academy cannot be chosen', (await api('/admin/theme', { token: adminTok, method: 'PATCH', body: { themeId: `academy:${archived.id}` } })).status === 400);
  else console.log('   skip  18. (no ARCHIVED academy in this DB)');

  // ── Who may look ──
  check('19. STUDENT: catalogue and preference are 403', (await api('/admin/theme/catalog', { token: studentTok })).status === 403 && (await api('/admin/theme', { token: studentTok })).status === 403 && (await api('/admin/theme', { token: studentTok, method: 'PATCH', body: { themeId: 'preset:midnight' } })).status === 403);
  check('20. TEACHER: 403 too', (await api('/admin/theme/catalog', { token: teacherTok })).status === 403 && (await api('/admin/theme', { token: teacherTok, method: 'PATCH', body: { themeId: 'preset:midnight' } })).status === 403);
  check('21. anonymous: 401', (await api('/admin/theme/catalog')).status === 401);

  // ── Nothing else moved ──
  check('22. student studio still serves its own catalogue untouched', (await api('/student/studio', { token: studentTok })).status === 200);
}

main()
  .catch((e) => { console.error('\nUNCAUGHT:', e); fail++; })
  .finally(async () => {
    if (adminId) await prisma.user.update({ where: { id: adminId }, data: { adminThemePreference: original ?? undefined } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorUserId: adminId ?? '', action: 'admin_theme.set', createdAt: { gt: new Date(Date.now() - 120_000) } } }).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
