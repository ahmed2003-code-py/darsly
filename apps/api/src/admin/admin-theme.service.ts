import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The full set of admin theme presets — the same 8 the frontend ships
 * (apps/web/src/lib/adminTheme.ts). Kept here too so a custom/tampered
 * themeId can be rejected server-side rather than trusted from the client.
 */
export const ADMIN_THEME_IDS = [
  'darsly-dark',
  'crimson-gold',
  'emerald',
  'midnight',
  'royal',
  'minimal',
  'cyber',
  'command-center',
] as const;
export type AdminThemeId = (typeof ADMIN_THEME_IDS)[number];

export interface AdminThemePreference {
  themeId: AdminThemeId | null;
}

function isAdminThemeId(v: unknown): v is AdminThemeId {
  return typeof v === 'string' && (ADMIN_THEME_IDS as readonly string[]).includes(v);
}

/**
 * A SUPER_ADMIN's own Admin Studio theme choice — per-admin, not
 * platform-wide (a personal UI preference, the same way a person's editor
 * theme is their own and not their whole team's). Persisted server-side
 * (User.adminThemePreference) so it survives a cleared browser, not just
 * localStorage. Every read/write here is scoped to the caller's own userId
 * — there is no "set theme for user X" path, so this is IDOR-proof by
 * construction, not by a permission check that could be forgotten.
 */
@Injectable()
export class AdminThemeService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<AdminThemePreference> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { adminThemePreference: true } });
    const pref = user?.adminThemePreference as { themeId?: string } | null;
    return { themeId: pref?.themeId && isAdminThemeId(pref.themeId) ? pref.themeId : null };
  }

  async set(userId: string, themeId: string | null): Promise<AdminThemePreference> {
    if (themeId !== null && !isAdminThemeId(themeId)) {
      throw new BadRequestException(`Unknown admin theme: ${themeId}`);
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { adminThemePreference: themeId ? { themeId } : Prisma.DbNull },
    });
    return { themeId };
  }
}
