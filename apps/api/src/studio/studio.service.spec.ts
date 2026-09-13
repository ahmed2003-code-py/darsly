import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationConfigService } from '../gamification/gamification.config.service';
import { StudioService } from './studio.service';
import { BRAND_OVERRIDE_NAMES, deriveAccent, deriveBrand, deriveStudioThemes, safeHex } from './studio-theme';
import { contrastRatio } from '../academy-site/renderer/color.util';

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
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    studentCustomization: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    studentGamification: {
      findUnique: jest.fn().mockResolvedValue({ coins: 1000, xp: 5000 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    studentAchievement: { findMany: jest.fn().mockResolvedValue([]) },
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
          idempotencyKey: 'COSMETIC:s1:i1',
        }),
      }),
    );
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
    prisma.cosmeticItem.findUnique.mockResolvedValue(item());
    prisma.studentCosmetic.findUnique.mockResolvedValue({ id: 'o1' });
    await svc(prisma).equip('u1', 'theme-ocean');
    expect(prisma.studentCustomization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { themeKey: 'theme-ocean' } }),
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
    const brand = deriveBrand('#15803d', 'dark');
    for (const value of Object.values(brand)) {
      expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
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
