import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationConfigService } from '../gamification/gamification.config.service';
import { StudioService } from './studio.service';
import { CATALOG } from './studio.catalog';
import {
  BRAND_OVERRIDE_NAMES,
  deriveAccent,
  deriveBrand,
  deriveStudioThemes,
  deriveSurfaces,
  safeHex,
} from './studio-theme';
import { contrastRatio } from '../academy-site/renderer/color.util';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The rules that matter here are the ones about somebody else's money and
 * somebody else's collection, so that is what these test: that a price comes
 * from the catalogue and never from the request, that a balance cannot be spent
 * twice by two requests arriving together, that an item nobody owns cannot be
 * worn, and that resetting how Darsly looks never costs a student what they own.
 */

const GROUND = { light: '#fdfdfb', dark: '#0e0e12' };

function makePrisma(over: Record<string, any> = {}): any {
  const base: any = {
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ id: 's1' }) },
    cosmeticItem: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    studentCosmetic: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'own1' }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    studentCustomization: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    studentGamification: {
      findUnique: jest.fn().mockResolvedValue({ coins: 1000, xp: 5000 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    studentAchievement: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    academy: { findMany: jest.fn().mockResolvedValue([]) },
    gamificationEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = { ...base, ...over };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  // Typed loosely on purpose: these are jest mocks standing in for a Prisma
  // client, and asserting on `.mock.calls` is the point of them.
  return prisma;
}

const notifications = { create: jest.fn().mockResolvedValue({}) } as unknown as NotificationsService;
const config = {
  levelProgress: jest.fn().mockResolvedValue({
    level: { level: 5, nameAr: 'x', nameEn: 'x', minXp: 0, icon: 'e', coinReward: 0 },
    next: null,
    xpIntoLevel: 0,
    xpForNext: 100,
    pct: 0,
  }),
} as unknown as GamificationConfigService;

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  key: 'theme-ocean',
  category: 'THEME',
  rarity: 'COMMON',
  nameAr: 'محيط',
  nameEn: 'Ocean',
  descAr: '',
  descEn: '',
  config: { accent: '#0f6f9c', accentDark: '#3fb3e0' },
  costCoins: 120,
  requiredLevel: 1,
  requiredAchievement: null,
  isStarter: false,
  isActive: true,
  sortOrder: 1,
  ...over,
});

const svc = (prisma: any) => new StudioService(prisma, notifications, config);

describe('StudioService — unlocking', () => {
  it('charges the catalogue price, not one the caller supplied', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ costCoins: 120 }));
    await svc(prisma).unlock('u1', 'theme-ocean');

    // The only number that reached the debit is the one on the row.
    expect(prisma.studentGamification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: 's1', coins: { gte: 120 } },
        data: { coins: { decrement: 120 }, coinsSpent: { increment: 120 } },
      }),
    );
  });

  it('writes the spend to the gamification ledger, keyed so a replay collides', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    await svc(prisma).unlock('u1', 'theme-ocean');

    expect(prisma.gamificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'COSMETIC_UNLOCKED',
          coinsAwarded: -120,
          idempotencyKey: 'COSMETIC:own1',
        }),
      }),
    );
  });

  /**
   * A ledger is not erased, so it must not be a lock.
   *
   * Keying the spend on (student, item) made the first purchase permanent: a
   * refund removes what the student owns but leaves the ledger row that records
   * the spend, and every later attempt to buy the same item collided with that
   * dead row. The student was told "already owned" while owning nothing, and
   * there was no way out of it. The key belongs to the purchase.
   */
  it('can be bought again after a refund, because the ledger is not the lock', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    prisma.studentCosmetic.create.mockResolvedValue({ id: 'own2' });
    await svc(prisma).unlock('u1', 'theme-ocean');
    const first = prisma.gamificationEvent.create.mock.calls[0][0].data.idempotencyKey;

    // The same student, the same item, a second time round.
    prisma.gamificationEvent.create.mockClear();
    prisma.studentCosmetic.create.mockResolvedValue({ id: 'own3' });
    await svc(prisma).unlock('u1', 'theme-ocean');
    const second = prisma.gamificationEvent.create.mock.calls[0][0].data.idempotencyKey;

    expect(second).not.toBe(first);
    // …and it still names something, so a genuine replay has a row to collide with.
    expect(second).toMatch(/^COSMETIC:\w+$/);
  });

  it('refuses when the balance is short, and takes nothing', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    // The conditional update matching no row IS the insufficient-funds signal.
    prisma.studentGamification.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(BadRequestException);
    expect(prisma.studentCosmetic.create).not.toHaveBeenCalled();
  });

  /**
   * The race the conditional update exists for: two requests, one balance.
   * Whichever arrives second matches no row, because the first one has already
   * moved the balance below the price.
   */
  it('lets only one of two simultaneous unlocks spend the same coins', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ costCoins: 500 }));
    let coins = 500;
    prisma.studentGamification.updateMany.mockImplementation(async ({ where }: any) => {
      if (coins >= where.coins.gte) {
        coins -= 500;
        return { count: 1 };
      }
      return { count: 0 };
    });

    const results = await Promise.allSettled([
      svc(prisma).unlock('u1', 'theme-ocean'),
      svc(prisma).unlock('u1', 'theme-ocean'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(coins).toBe(0);
  });

  it('refuses an item that is already owned', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    prisma.studentCosmetic.findUnique.mockResolvedValue({ id: 'o1' });
    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(BadRequestException);
    expect(prisma.studentGamification.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an item that has been retired', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ isActive: false }));
    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(NotFoundException);
  });

  it('refuses to sell something the student has not levelled up to', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ requiredLevel: 9 }));
    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(BadRequestException);
    expect(prisma.studentGamification.updateMany).not.toHaveBeenCalled();
  });

  // Some cosmetics are earned. Selling one would be a way to buy an achievement.
  it('refuses to sell an achievement reward', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ requiredAchievement: 'streak_30' }));
    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(BadRequestException);
    expect(prisma.studentGamification.updateMany).not.toHaveBeenCalled();
  });
});

describe('StudioService — wearing', () => {
  it('refuses to equip something the student does not own', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    prisma.studentCosmetic.findUnique.mockResolvedValue(null);
    await expect(svc(prisma).equip('u1', 'theme-ocean')).rejects.toThrow(ForbiddenException);
    expect(prisma.studentCustomization.upsert).not.toHaveBeenCalled();
  });

  it('equips an owned item into its own slot', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ category: 'BUTTON_STYLE', key: 'button-pill' }));
    prisma.studentCosmetic.findUnique.mockResolvedValue({ id: 'o1' });
    await svc(prisma).equip('u1', 'button-pill');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { buttonKey: 'button-pill' } }),
    );
  });

  // Two looks cannot be worn at once, so choosing a theme has to let go of the
  // teacher's colours rather than layer on top of them.
  it('releases the teacher’s look when a bought theme is equipped', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    prisma.studentCosmetic.findUnique.mockResolvedValue({ id: 'o1' });
    await svc(prisma).equip('u1', 'theme-ocean');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { themeKey: 'theme-ocean', academyId: null } }),
    );
  });

  it('refuses a teacher’s look the student does not study with', async () => {
    const prisma = makePrisma({
      enrollment: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc(prisma).equipAcademy('u1', 'someone-elses-academy')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.studentCustomization.upsert).not.toHaveBeenCalled();
  });

  it('wears a teacher’s look, and lets go of the bought theme', async () => {
    const prisma = makePrisma({
      enrollment: { findFirst: jest.fn().mockResolvedValue({ id: 'e1' }) },
    });
    await svc(prisma).equipAcademy('u1', 'academy-1');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { academyId: 'academy-1', themeKey: null } }),
    );
  });

  // Starters are what a new student customises away from, so they need no row.
  it('equips a starter without owning anything', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item({ isStarter: true, key: 'theme-paper' }));
    prisma.studentCosmetic.findUnique.mockResolvedValue(null);
    await svc(prisma).equip('u1', 'theme-paper');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalled();
  });

  it('keeps a mixed colour and an unlocked one from both being worn', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(
      item({ category: 'ACCENT', key: 'accent-violet', config: { hex: '#7c3aed' } }),
    );
    prisma.studentCosmetic.findUnique.mockResolvedValue({ id: 'o1' });
    await svc(prisma).equip('u1', 'accent-violet');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { accentKey: 'accent-violet', accentHex: null } }),
    );
  });
});

describe('StudioService — a teacher’s look as the way back', () => {
  const withTeacher = () => {
    const prisma = makePrisma();
    prisma.enrollment.findMany.mockResolvedValue([{ tenantId: 'a1', createdAt: new Date() }]);
    prisma.academy.findMany.mockResolvedValue([
      { id: 'a1', name: 'Academy', colorPrimary: '#2f5fe0', colorAccent: '#7c3aed', brandTokens: null, owner: { fullName: 'Amr' } },
    ]);
    prisma.cosmeticItem.findMany.mockResolvedValue([]);
    // `studentProfile.findUnique` stands in for two different reads here: the
    // id lookup that authorises the call, and the profile the overview renders.
    prisma.studentProfile.findUnique.mockResolvedValue({
      id: 's1', currentStreak: 0, user: { fullName: 'Student', avatarUrl: null },
    });
    return prisma;
  };

  it('marks the first teacher in use while nothing else is worn', async () => {
    const prisma = withTeacher();
    const out = await svc(prisma).overview('u1');
    expect(out.academyThemes[0].equipped).toBe(true);
  });

  /**
   * The card shows a tick or a button, never both. Claiming a teacher's look
   * was in use while a bought theme was on took the button off the page, and
   * with it the one tap back to that teacher.
   */
  it('offers the way back while a bought theme is worn', async () => {
    const prisma = withTeacher();
    prisma.studentCustomization.findUnique.mockResolvedValue({
      themeKey: 'theme-egyptian-king', academyId: null, accentKey: null, accentHex: null,
      buttonKey: null, cardKey: null, navKey: null, avatarKey: null, frameKey: null, effectKey: null,
    });
    const out = await svc(prisma).overview('u1');
    expect(out.equipped.themeKey).toBe('theme-egyptian-king');
    expect(out.academyThemes[0].equipped).toBe(false);
  });

  it('marks the teacher in use once that teacher is chosen', async () => {
    const prisma = withTeacher();
    prisma.studentCustomization.findUnique.mockResolvedValue({
      themeKey: null, academyId: 'a1', accentKey: null, accentHex: null,
      buttonKey: null, cardKey: null, navKey: null, avatarKey: null, frameKey: null, effectKey: null,
    });
    const out = await svc(prisma).overview('u1');
    expect(out.academyThemes[0].equipped).toBe(true);
  });
});

describe('StudioService — a colour of your own', () => {
  it('refuses anything that is not a colour', async () => {
    const prisma = makePrisma();
    for (const bad of ['red', 'javascript:alert(1)', '#fff', 'rgb(1,2,3)', '#12345g', '']) {
      await expect(svc(prisma).setAccent('u1', bad)).rejects.toThrow(BadRequestException);
    }
    expect(prisma.studentCustomization.upsert).not.toHaveBeenCalled();
  });

  it('stores the hex and nothing else', async () => {
    const prisma = makePrisma();
    await svc(prisma).setAccent('u1', '#7C3AED');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { accentHex: '#7c3aed', accentKey: 'custom' } }),
    );
  });
});

describe('StudioService — reset', () => {
  it('clears every slot and touches nothing that was earned', async () => {
    const prisma = makePrisma();
    await svc(prisma).reset('u1');
    const { update } = prisma.studentCustomization.upsert.mock.calls[0][0];
    expect(Object.values(update).every((v) => v === null)).toBe(true);
    // The collection, the coins and the ledger are all untouched.
    expect(prisma.studentCosmetic.create).not.toHaveBeenCalled();
    expect(prisma.studentGamification.updateMany).not.toHaveBeenCalled();
    expect(prisma.gamificationEvent.create).not.toHaveBeenCalled();
  });
});

describe('StudioService — identity', () => {
  // The whole of the cross-student guarantee: there is no student id to send.
  it('refuses an account with no student profile', async () => {
    const prisma = makePrisma({ studentProfile: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(svc(prisma).overview('u1')).rejects.toThrow(ForbiddenException);
    await expect(svc(prisma).unlock('u1', 'theme-ocean')).rejects.toThrow(ForbiddenException);
    await expect(svc(prisma).equip('u1', 'theme-ocean')).rejects.toThrow(ForbiddenException);
  });

  it('scopes every read and write to the student behind the token', async () => {
    const prisma = makePrisma();
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    await svc(prisma).unlock('u1', 'theme-ocean');
    for (const call of prisma.studentGamification.updateMany.mock.calls) {
      expect(call[0].where.studentId).toBe('s1');
    }
    expect(prisma.studentCosmetic.create.mock.calls[0][0].data.studentId).toBe('s1');
  });
});

describe('studio theme derivation', () => {
  it('only ever emits --s-* tokens, so academy branding is unreachable', () => {
    const themes = deriveStudioThemes({ accentHex: '#7c3aed' });
    for (const mode of ['light', 'dark'] as const) {
      for (const name of Object.keys(themes[mode].tokens)) {
        expect(name.startsWith('--s-')).toBe(true);
        expect(name.startsWith('--c-')).toBe(false);
      }
    }
  });

  it('emits tokens as plain "R G B", never anything a browser would run', () => {
    const themes = deriveStudioThemes({ accentHex: '#7c3aed' });
    for (const value of Object.values(themes.light.tokens)) {
      expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  /**
   * The point of deriving on the server: a student can pick a colour that would
   * be unreadable, and what comes back is one that is not.
   */
  it('keeps a chosen colour legible on both grounds', () => {
    const chosen = ['#ffffff', '#000000', '#ffff00', '#7c3aed', '#0d9488', '#fde047'];
    for (const hex of chosen) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = deriveAccent(hex, mode);
        const ink = fromTriple(tokens['--s-accent-ink']);
        const accent = fromTriple(tokens['--s-accent']);
        const onAccent = fromTriple(tokens['--s-on-accent']);
        // Accent used as text clears the text floor against the page…
        expect(contrastRatio(ink, GROUND[mode])).toBeGreaterThanOrEqual(4.5);
        // …and text on a button filled with it clears the same floor.
        expect(contrastRatio(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('falls back to a style name it knows rather than passing one through', () => {
    const themes = deriveStudioThemes({
      button: 'position:fixed',
      card: '<script>',
      nav: '../../etc/passwd',
    });
    expect(themes.styles.button).toBe('classic');
    expect(themes.styles.card).toBe('minimal');
    expect(themes.styles.nav).toBe('classic');
  });

  /**
   * A theme now asks for a typeface and a corner radius too. Both are names,
   * and a name the stylesheet does not know is dropped rather than passed on —
   * there is no way for a theme to hand the browser a font of its own.
   */
  it('drops a typeface or a radius it does not recognise', () => {
    const themes = deriveStudioThemes({
      themeConfig: {
        accent: '#dc2626',
        font: 'https://evil.example/font.css',
        radius: '9999px; position: fixed',
        pattern: 'url(x)',
      },
    });
    expect(themes.styles.font).toBeNull();
    expect(themes.styles.radius).toBeNull();
    expect(themes.styles.pattern).toBeNull();
  });

  it('carries a recognised typeface, radius and pattern through', () => {
    const themes = deriveStudioThemes({
      themeConfig: {
        accent: '#dc2626',
        accentDark: '#f87171',
        font: 'display',
        radius: 'sharp',
        pattern: 'web',
        glow: true,
      },
    });
    expect(themes.styles).toMatchObject({ font: 'display', radius: 'sharp', pattern: 'web', glow: true });
  });

  it('holds the second colour to the same floors as the first', () => {
    for (const hex of ['#ffffff', '#ffff00', '#0284c7']) {
      for (const mode of ['light', 'dark'] as const) {
        const themes = deriveStudioThemes({
          themeConfig: { accent: '#dc2626', accentDark: '#f87171', secondary: hex, secondaryDark: hex },
        });
        const t = themes[mode].tokens;
        expect(contrastRatio(fromTriple(t['--s-secondary-ink']), GROUND[mode])).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(fromTriple(t['--s-on-secondary']), fromTriple(t['--s-secondary'])),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('reads a mixed colour as more specific than the theme it came with', () => {
    const themes = deriveStudioThemes({
      themeConfig: { accent: '#0f6f9c', accentDark: '#3fb3e0' },
      accentHex: '#be123c',
    });
    // Seated for the mode, so not necessarily the exact hex — but rose, not blue.
    const [r, g, b] = themes.light.tokens['--s-accent'].split(' ').map(Number);
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(g);
  });

  /**
   * The student's colour now restates the platform accent family, so that it
   * reaches the logo and every button. That is a bigger door than `--s-*`, and
   * these are the hinges on it.
   */
  it('restates only the accent family, never a surface or the ink', () => {
    const brand = deriveBrand('#7c3aed', 'light');
    for (const name of Object.keys(brand)) {
      expect(name).toMatch(/^--c-(primary|on-primary|inverse-primary|surface-tint|brand-accent|on-brand-accent|accent-)/);
    }
    // The things that would make the app unreadable are not reachable.
    for (const forbidden of [
      '--c-background', '--c-surface', '--c-on-surface', '--c-on-background',
      '--c-error', '--c-outline', '--c-line', '--c-surface-container',
    ]) {
      expect(Object.keys(brand)).not.toContain(forbidden);
    }
  });

  it('keeps text on a primary button readable whatever colour is chosen', () => {
    for (const hex of ['#ffffff', '#000000', '#ffff00', '#7c3aed', '#15803d', '#dc2626']) {
      for (const mode of ['light', 'dark'] as const) {
        const brand = deriveBrand(hex, mode);
        expect(
          contrastRatio(fromTriple(brand['--c-on-primary']), fromTriple(brand['--c-primary'])),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('emits every brand token as plain "R G B"', () => {
    const brand = { ...deriveBrand('#15803d', 'dark'), ...deriveSurfaces({ background: '#101018' }) };
    for (const value of Object.values(brand)) {
      expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$|^0 0 0$/);
    }
    // The client refuses any brand name it was not told about, so the two
    // families the server can write have to be named there in full — and the
    // allowlist must hold nothing beyond them.
    for (const name of Object.keys(brand)) expect(BRAND_OVERRIDE_NAMES).toContain(name);
    expect(BRAND_OVERRIDE_NAMES.length).toBe(Object.keys(brand).length);
  });

  /** A wash is a mood, not a new page: the ground must stay close to itself. */
  it('tints the page without moving it far from the platform ground', () => {
    const themes = deriveStudioThemes({
      themeConfig: { accent: '#15803d', accentDark: '#4ade80', wash: '#15803d', washDark: '#22c55e' },
    });
    for (const mode of ['light', 'dark'] as const) {
      const wash = fromTriple(themes[mode].tokens['--s-wash']);
      const ground = mode === 'light' ? '#fdfdfb' : '#0e0e12';
      expect(contrastRatio(wash, ground)).toBeLessThan(1.6);
    }
  });

  it('accepts a hex colour and nothing else', () => {
    expect(safeHex('#7C3AED')).toBe('#7c3aed');
    for (const bad of ['#fff', 'red', 'url(x)', '#1234567', null, 42, {}]) {
      expect(safeHex(bad)).toBeNull();
    }
  });
});

function fromTriple(triple: string): string {
  const [r, g, b] = triple.split(' ').map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The first real item in the catalogue.
 *
 * Tested as data rather than as a screenshot: the price, the gate and the
 * configuration are what the server actually enforces, and every value in
 * `config` has to be one the theme engine recognises — an unknown name is
 * dropped silently, so a typo here would ship a theme that quietly does less
 * than it claims.
 */
describe('Egyptian King', () => {
  const item = CATALOG.find((c) => c.key === 'theme-egyptian-king');

  it('is in the catalogue, as a legendary theme', () => {
    expect(item).toBeDefined();
    expect(item!.category).toBe('THEME');
    expect(item!.rarity).toBe('LEGENDARY');
  });

  // A hundred coins is ten lessons: the first skin's job is to be had, not
  // saved for. No level gate for the same reason.
  it('costs a hundred, and is gated on nothing', () => {
    expect(item!.costCoins).toBe(100);
    expect(item!.requiredLevel).toBeUndefined();
    // Earned items carry no price; a bought one must not pretend to be earned.
    expect(item!.requiredAchievement).toBeUndefined();
    expect(item!.isStarter).toBeUndefined();
  });

  /**
   * The difference between a skin and a tint.
   *
   * A theme that only moves the accent leaves the platform's greys underneath,
   * which is exactly the "it just looks red" failure. This one has to bring its
   * own ground — and the ground has to be near-black navy, not red.
   */
  it('brings its own ground, and the ground is navy rather than red', () => {
    const brand = deriveStudioThemes({ themeConfig: item!.config as any }).dark.brand;
    expect(brand['--c-background']).toBeDefined();
    expect(brand['--c-surface-container-lowest']).toBeDefined();
    const [r, g, b] = brand['--c-background'].split(' ').map(Number);
    expect(b).toBeGreaterThan(r); // cool, not warm
    expect(r + g + b).toBeLessThan(120); // and genuinely dark
  });

  it('keeps body text readable on its own ground', () => {
    const brand = deriveStudioThemes({ themeConfig: item!.config as any }).dark.brand;
    const bg = fromTriple(brand['--c-background']);
    // Long-form reading is held to AAA, the same floor the academy palette uses.
    expect(contrastRatio(fromTriple(brand['--c-on-surface']), bg)).toBeGreaterThanOrEqual(7);
    // Secondary text and the quietest ink still clear the text floor.
    expect(contrastRatio(fromTriple(brand['--c-on-surface-variant']), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fromTriple(brand['--c-outline']), bg)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * `text-primary` is read as text on well over a hundred screens, so a skin
   * has to ship a brand colour that survives being read — without giving up the
   * one it is painted in. At 3:1 this palette measured 3.71:1 as body text;
   * pushed to 4.5:1 the button stopped being Egyptian red. Hence two tokens.
   */
  it('keeps the brand readable as a label and crimson as a fill', () => {
    const themes = deriveStudioThemes({ themeConfig: item!.config as any });
    for (const mode of ['light', 'dark'] as const) {
      const brand = themes[mode].brand;
      const card = fromTriple(brand['--c-surface-container-highest']);
      // The label clears the text floor on the hardest surface in the skin…
      expect(contrastRatio(fromTriple(brand['--c-primary-text']), card)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(fromTriple(brand['--c-primary-text']), fromTriple(brand['--c-background'])),
      ).toBeGreaterThanOrEqual(4.5);
      // …and the text on the soft fill built from the colour clears it too.
      expect(
        contrastRatio(fromTriple(brand['--c-on-primary-fixed']), fromTriple(brand['--c-primary-fixed'])),
      ).toBeGreaterThanOrEqual(4.5);

      // The fill stays the colour the theme asked for: still unmistakably red,
      // and still dark enough to carry white text.
      const [r, g, b] = brand['--c-primary'].split(' ').map(Number);
      expect(r).toBeGreaterThan(g + 60);
      expect(r).toBeGreaterThan(b + 60);
      expect(
        contrastRatio(fromTriple(brand['--c-on-primary']), fromTriple(brand['--c-primary'])),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('carries gold as a semantic, legible on its own ground', () => {
    const t = deriveStudioThemes({ themeConfig: item!.config as any }).dark.tokens;
    const brand = deriveStudioThemes({ themeConfig: item!.config as any }).dark.brand;
    expect(t['--s-gold']).toBeDefined();
    expect(contrastRatio(fromTriple(t['--s-gold-ink']), fromTriple(brand['--c-background']))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fromTriple(t['--s-on-gold']), fromTriple(t['--s-gold']))).toBeGreaterThanOrEqual(4.5);
  });

  // A skin is a skin in both modes: someone who chose light did not choose to
  // see half a stadium.
  it('looks the same whichever mode the reader prefers', () => {
    const themes = deriveStudioThemes({ themeConfig: item!.config as any });
    expect(themes.light.brand['--c-background']).toBe(themes.dark.brand['--c-background']);
    expect(themes.light.brand['--c-on-surface']).toBe(themes.dark.brand['--c-on-surface']);
  });

  it('configures only values the theme engine knows how to read', () => {
    const cfg = item!.config as Record<string, unknown>;
    const themes = deriveStudioThemes({ themeConfig: cfg });
    // Every one of these survived validation, which is the proof the names are
    // right — an unrecognised name comes back null rather than throwing.
    expect(themes.styles).toMatchObject({
      pattern: 'stadium',
      font: 'display',
      radius: 'sharp',
      card: 'elevated',
      button: 'sharp',
      glow: true,
    });
  });

  it('carries a red action colour and a gold partner, both legible', () => {
    const cfg = item!.config as Record<string, unknown>;
    for (const mode of ['light', 'dark'] as const) {
      const t = deriveStudioThemes({ themeConfig: cfg })[mode].tokens;
      const [r, g, b] = t['--s-accent'].split(' ').map(Number);
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
      // Gold is its own colour and is held to the same floors — against the
      // ground this skin actually lays down, which is its own, not the app's.
      const ground = fromTriple(deriveStudioThemes({ themeConfig: cfg })[mode].brand['--c-background']);
      expect(contrastRatio(fromTriple(t['--s-secondary-ink']), ground)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(fromTriple(t['--s-on-accent']), fromTriple(t['--s-accent'])),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('restates the accent family and the ground, so the look reaches every screen', () => {
    const cfg = item!.config as Record<string, unknown>;
    const brand = deriveStudioThemes({ themeConfig: cfg }).dark.brand;
    // A skin that only restated --s-* would stop at the student's own pages.
    // These are the names every screen in the app reads, teachers' included.
    for (const reached of ['--c-primary', '--c-background', '--c-surface', '--c-on-surface']) {
      expect(brand[reached]).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
    // …and still cannot reach the colours that mean something. An error has to
    // stay red-for-error, not red-for-Egypt.
    for (const forbidden of ['--c-error', '--c-on-error', '--c-error-container', '--c-success']) {
      expect(Object.keys(brand)).not.toContain(forbidden);
    }
  });

  /**
   * The regression fixed in 1b63835, guarded as data.
   *
   * A student with no customisation must produce an empty theme, because the
   * client removes only what it wrote — and if this produced tokens, it would
   * be writing over an academy that had done nothing wrong.
   */
  /**
   * The ground is a bigger door than the accent was, so it has its own hinges:
   * nothing outside the declared surface names is reachable through it.
   */
  it('cannot reach an error colour or a secondary through the ground', () => {
    const names = Object.keys(deriveSurfaces({ background: '#0a0e16' }));
    for (const forbidden of [
      '--c-error', '--c-on-error', '--c-error-container',
      '--c-secondary', '--c-tertiary', '--c-primary',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // And every name it does produce is one the client will accept.
    for (const n of names) expect(BRAND_OVERRIDE_NAMES).toContain(n);
  });

  /**
   * Two hand-kept lists, one on each side of the wire.
   *
   * The client refuses any brand name it was not told about — the guard that
   * keeps a theme from reaching an error colour. That guard silently drops a
   * token the server adds and the client has not heard of, so the two lists are
   * compared here rather than trusted.
   */
  it('names every brand token the client is willing to accept', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = readFileSync(
      join(__dirname, '../../../web/src/lib/studio.ts'),
      'utf8',
    );
    const allowed = new Set(
      (client.match(/const BRAND_ALLOWED[\s\S]*?\];/)?.[0] ?? '').match(/--[a-z0-9-]+/g) ?? [],
    );
    expect(allowed.size).toBeGreaterThan(20);
    for (const name of BRAND_OVERRIDE_NAMES) expect([...allowed]).toContain(name);
  });

  it('writes nothing at all when a student has customised nothing', () => {
    const themes = deriveStudioThemes({});
    expect(Object.keys(themes.light.tokens)).toHaveLength(0);
    expect(Object.keys(themes.light.brand)).toHaveLength(0);
    expect(Object.keys(themes.dark.brand)).toHaveLength(0);
    expect(themes.styles.pattern).toBeNull();
    expect(themes.styles.font).toBeNull();
  });
});
