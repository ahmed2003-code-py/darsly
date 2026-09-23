import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CenterThemesService } from './center-themes.service';

function make() {
  const prisma: any = {
    academy: { findFirst: jest.fn(), update: jest.fn() },
    academyThemeGrant: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const themes: any = { catalog: jest.fn(), resolve: jest.fn() };
  const audit: any = { log: jest.fn() };
  return { prisma, themes, audit, svc: new CenterThemesService(prisma, themes, audit) };
}

const entry = (id: string) => ({
  id,
  source: 'PRESET',
  name: id,
  subtitle: null,
  mode: 'dark',
  tokens: {
    background: '14 14 18',
    surface: '19 19 24',
    surfaceElevated: '26 26 32',
    text: '237 237 242',
    textMuted: '169 168 180',
    primary: '110 91 211',
    secondary: '201 200 210',
    accent: '156 143 226',
    success: '52 199 89',
    warning: '251 191 36',
    danger: '229 103 90',
    border: '46 46 56',
    sidebar: '14 14 18',
    topbar: '19 19 24',
    chart1: '110 91 211',
    chart2: '52 199 89',
    chart3: '251 191 36',
  },
  modes: {},
  meta: {},
});

describe('CenterThemesService', () => {
  it('refuses grants on a PERSONAL academy', async () => {
    const { prisma, svc } = make();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'a1',
      slug: 'me',
      name: 'Me',
      kind: 'PERSONAL',
      brandTokens: null,
    });
    await expect(svc.setGrants('a1', ['preset:midnight'], 'admin')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses applying a look that was not granted', async () => {
    const { prisma, svc } = make();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      slug: 'c',
      name: 'C',
      kind: 'CENTER',
      brandTokens: null,
    });
    prisma.academyThemeGrant.findMany.mockResolvedValue([]);
    await expect(svc.apply('c1', 'preset:midnight', 'owner')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('writes brandTokens when the look is granted', async () => {
    const { prisma, themes, svc } = make();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      slug: 'c',
      name: 'C',
      kind: 'CENTER',
      brandTokens: null,
    });
    prisma.academyThemeGrant.findMany.mockResolvedValue([{ themeId: 'preset:midnight' }]);
    themes.resolve.mockResolvedValue(entry('preset:midnight'));
    prisma.academy.update.mockResolvedValue({
      id: 'c1',
      colorPrimary: '#6e5bd3',
      colorAccent: '#9c8fe2',
      brandTokens: {},
    });
    const res = await svc.apply('c1', 'preset:midnight', 'owner');
    expect(res.appliedThemeId).toBe('preset:midnight');
    expect(prisma.academy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brandTokens: expect.objectContaining({ themeId: 'preset:midnight' }),
        }),
      }),
    );
  });

  it('404s a missing Center', async () => {
    const { prisma, svc } = make();
    prisma.academy.findFirst.mockResolvedValue(null);
    await expect(svc.grantedFor('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
