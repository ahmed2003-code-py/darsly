import { BadRequestException } from '@nestjs/common';
import { ADMIN_THEME_PRESETS } from '@darsly/shared-types';
import { AdminThemeService, cosmeticModes, swatchFromCosmetic } from './admin-theme.service';
import { deriveStudioThemes } from '../studio/studio-theme';

const TRIPLE = /^\d{1,3} \d{1,3} \d{1,3}$/;

const center = {
  id: 'c1',
  name: 'El Shehab',
  slug: 'el-shehab',
  kind: 'CENTER',
  logoUrl: null,
  brandTokens: null,
  colorPrimary: '#0f766e',
  colorAccent: '#f59e0b',
  owner: { fullName: 'Owner' },
};
const teacher = {
  id: 't1',
  name: 'Mr Khaled',
  slug: 'khaled',
  kind: 'PERSONAL',
  logoUrl: null,
  brandTokens: {
    palette: { background: '#0b0f19', ink: '#e5e7eb', primary: '#818cf8', accent: '#f472b6' },
  },
  colorPrimary: '#818cf8',
  colorAccent: '#f472b6',
  owner: { fullName: 'Khaled' },
};
const skin = {
  key: 'theme-midnight-pro',
  nameAr: 'ميدنايت برو',
  nameEn: 'Midnight Pro',
  rarity: 'LEGENDARY',
  config: {
    accent: '#60a5fa',
    accentDark: '#93c5fd',
    secondaryDark: '#fbbf24',
    surfaces: { background: '#0b1020', surface: '#121a2e', ink: '#e6ecff', line: '#93c5fd' },
    pattern: 'grid',
  },
};
const tint = {
  key: 'theme-mint',
  nameAr: 'نعناع',
  nameEn: 'Mint',
  rarity: 'RARE',
  config: { accent: '#10b981', secondary: '#0ea5e9', wash: '#ecfdf5' },
};

function makePrisma() {
  return {
    academy: { findMany: jest.fn().mockResolvedValue([center, teacher]), findFirst: jest.fn() },
    cosmeticItem: { findMany: jest.fn().mockResolvedValue([skin, tint]), findFirst: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  } as any;
}

describe('AdminThemeService.catalog', () => {
  it('lists every preset, every live Academy (Centers and teachers) and every active store THEME, all resolved to the same token shape', async () => {
    const prisma = makePrisma();
    const cat = await new AdminThemeService(prisma).catalog();
    expect(cat.presets.map((p) => p.id)).toEqual(ADMIN_THEME_PRESETS.map((p) => `preset:${p.id}`));
    expect(cat.academies.map((a) => a.id)).toEqual(['academy:c1', 'academy:t1']);
    expect(cat.academies.map((a) => a.meta.academyKind)).toEqual(['CENTER', 'PERSONAL']);
    expect(cat.cosmetics.map((c) => c.id)).toEqual([
      'cosmetic:theme-midnight-pro',
      'cosmetic:theme-mint',
    ]);
    for (const e of [...cat.presets, ...cat.academies, ...cat.cosmetics]) {
      expect(Object.keys(e.tokens)).toHaveLength(17);
      for (const v of Object.values(e.tokens)) expect(v).toMatch(TRIPLE);
      expect(['light', 'dark']).toContain(e.mode);
      expect(e.modes.light).toBeTruthy();
      expect(e.modes.dark).toBeTruthy();
      expect(Object.keys(e.modes.light)).toHaveLength(17);
      expect(Object.keys(e.modes.dark)).toHaveLength(17);
    }
    // Only live rows are asked for: deleted/archived academies and retired items never appear.
    expect(prisma.academy.findMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      status: { not: 'ARCHIVED' },
    });
    expect(prisma.cosmeticItem.findMany.mock.calls[0][0].where).toMatchObject({
      category: 'THEME',
      isActive: true,
    });
  });

  it('an Academy look is derived from its stored brand — a Center with a teal primary reads teal, a teacher with a dark palette reads dark', async () => {
    const cat = await new AdminThemeService(makePrisma()).catalog();
    const [c, t] = cat.academies;
    expect(c.mode).toBe('light');
    expect(c.tokens.primary).toBe('15 118 110');
    expect(c.name).toBe('El Shehab');
    expect(c.subtitle).toBe('Owner');
    expect(t.mode).toBe('dark');
    expect(t.tokens.primary).toBe('129 140 248');
  });

  it('a store skin brings its own dark ground; a tint sits on paper', async () => {
    const cat = await new AdminThemeService(makePrisma()).catalog();
    const [s, m] = cat.cosmetics;
    expect(s.mode).toBe('dark');
    expect(s.meta).toMatchObject({ rarity: 'LEGENDARY', pattern: 'grid' });
    expect(m.mode).toBe('light');
    // The student engine floors a fill at 3:1 on its ground, so the tint's
    // primary is the student's primary — not the raw hex.
    expect(m.tokens.primary).toBe(
      deriveStudioThemes({ themeConfig: tint.config as any }).light.brand['--c-primary'],
    );
  });

  it('every entry carries the card the student Studio would draw for it', async () => {
    const cat = await new AdminThemeService(makePrisma()).catalog();
    for (const e of [...cat.presets, ...cat.academies, ...cat.cosmetics]) {
      expect(e.swatch.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
    const [c] = cat.academies;
    // The student's teacher-theme card: primary + accent, no ground.
    expect(c.swatch).toEqual({ accent: '#0f766e', accentDark: '#f59e0b' });
    const [s, m] = cat.cosmetics;
    expect(s.swatch).toEqual({
      accent: '#60a5fa',
      accentDark: '#93c5fd',
      gold: null,
      surfaces: { background: '#0b1020', surface: '#121a2e', ink: '#e6ecff' },
      pattern: 'grid',
    });
    expect(m.swatch).toMatchObject({ accent: '#10b981', gold: '#0ea5e9', surfaces: null });
  });
});

describe('AdminThemeService.resolve / set / get', () => {
  it('resolves every namespace, and a bare legacy id as a preset', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue(center);
    prisma.cosmeticItem.findFirst.mockResolvedValue(skin);
    const svc = new AdminThemeService(prisma);
    expect((await svc.resolve('preset:midnight'))?.id).toBe('preset:midnight');
    expect((await svc.resolve('midnight'))?.id).toBe('preset:midnight');
    expect((await svc.resolve('academy:c1'))?.source).toBe('ACADEMY');
    expect((await svc.resolve('cosmetic:theme-midnight-pro'))?.source).toBe('COSMETIC');
    expect(prisma.academy.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'c1',
      deletedAt: null,
    });
    expect(prisma.cosmeticItem.findFirst.mock.calls[0][0].where).toMatchObject({
      key: 'theme-midnight-pro',
      category: 'THEME',
      isActive: true,
    });
  });

  it('refuses anything that does not exist: unknown preset, deleted academy, retired item, foreign namespace', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue(null);
    prisma.cosmeticItem.findFirst.mockResolvedValue(null);
    const svc = new AdminThemeService(prisma);
    for (const id of [
      'preset:nope',
      'nope',
      'academy:gone',
      'cosmetic:theme-retired',
      'user:u1',
      'academy:',
    ]) {
      await expect(svc.set('me', id)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('set persists only the normalised id, for the caller only; the response carries the resolved look', async () => {
    const prisma = makePrisma();
    const res = await new AdminThemeService(prisma).set('me', 'midnight');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'me' },
      data: { adminThemePreference: { themeId: 'preset:midnight' } },
    });
    expect(res.themeId).toBe('preset:midnight');
    expect(res.theme?.tokens.primary).toBe('69 108 235');
  });

  it('set(null) clears', async () => {
    const prisma = makePrisma();
    const res = await new AdminThemeService(prisma).set('me', null);
    expect(prisma.user.update.mock.calls[0][0].data.adminThemePreference).not.toEqual(
      expect.objectContaining({ themeId: expect.anything() }),
    );
    expect(res).toEqual({ themeId: null, theme: null });
  });

  it('get resolves the stored choice; a choice that stopped existing reads as nothing chosen', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({
      adminThemePreference: { themeId: 'academy:c1' },
    });
    prisma.academy.findFirst.mockResolvedValueOnce(center);
    const svc = new AdminThemeService(prisma);
    expect((await svc.get('me')).theme?.name).toBe('El Shehab');
    prisma.user.findUnique.mockResolvedValueOnce({
      adminThemePreference: { themeId: 'academy:c1' },
    });
    prisma.academy.findFirst.mockResolvedValueOnce(null);
    expect(await svc.get('me')).toEqual({ themeId: null, theme: null });
    prisma.user.findUnique.mockResolvedValueOnce({
      adminThemePreference: { themeId: { $ne: null } },
    });
    expect(await svc.get('me')).toEqual({ themeId: null, theme: null });
  });
});

describe('token derivation', () => {
  const dayNight = {
    accent: '#dc2626',
    accentDark: '#ef4444',
    gold: '#a16207',
    goldDark: '#ffb95f',
    surfaces: { background: '#0a0e16', surface: '#121722', ink: '#dfe2ee' },
    surfacesLight: { background: '#f6f2e9', surface: '#ffffff', ink: '#151b28' },
  };

  it('a cosmetic config never reaches the tokens or the card unfiltered', () => {
    const cfg = {
      accent: 'javascript:alert(1)',
      surfaces: { background: 'nope', ink: 'url(x)' },
    } as any;
    const { modes } = cosmeticModes(cfg);
    for (const v of [...Object.values(modes.light), ...Object.values(modes.dark)])
      expect(v).toMatch(TRIPLE);
    const sw = swatchFromCosmetic(cfg);
    expect(sw.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(sw.surfaces).toEqual({ background: undefined, surface: undefined, ink: undefined });
  });

  it('each end wears the ground the student wears at that end — a day skin is not re-invented', () => {
    const { mode, modes } = cosmeticModes(dayNight as any);
    const student = deriveStudioThemes({ themeConfig: dayNight as any });
    expect(mode).toBe('dark');
    expect(modes.dark.background).toBe(student.dark.brand['--c-background']);
    expect(modes.light.background).toBe(student.light.brand['--c-background']);
    expect(modes.light.background).toBe('246 242 233'); // #f6f2e9, the theme's own chalk
    expect(modes.dark.primary).toBe(student.dark.brand['--c-primary']);
    expect(modes.light.primary).toBe(student.light.brand['--c-primary']);
    expect(modes.light.text).toBe(student.light.brand['--c-on-surface']);
  });
});
