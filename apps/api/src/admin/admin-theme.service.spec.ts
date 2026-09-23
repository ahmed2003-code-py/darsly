import { BadRequestException } from '@nestjs/common';
import { ADMIN_THEME_PRESETS } from '@darsly/shared-types';
import { AdminThemeService, adminTokensFrom, paletteFromCosmetic } from './admin-theme.service';
import { deriveAppTheme } from '../branding/app-theme';

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
    expect(m.tokens.primary).toBe('16 185 129');
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
  it('a cosmetic config never reaches the tokens unfiltered — bad hexes fall back, every slot is a triple', () => {
    const palette = paletteFromCosmetic({
      accent: 'javascript:alert(1)',
      surfaces: { background: 'nope' },
    } as any);
    expect(palette.primary).toBeUndefined();
    const tokens = adminTokensFrom(deriveAppTheme(palette));
    for (const v of Object.values(tokens)) expect(v).toMatch(TRIPLE);
  });

  it('a skin prefers its dark-ground accent; a tint uses the plain one', () => {
    expect(paletteFromCosmetic(skin.config as any)).toMatchObject({
      primary: '#93c5fd',
      accent: '#fbbf24',
      background: '#0b1020',
      ink: '#e6ecff',
    });
    expect(paletteFromCosmetic(tint.config as any)).toMatchObject({
      primary: '#10b981',
      accent: '#0ea5e9',
      background: '#ecfdf5',
    });
  });
});
