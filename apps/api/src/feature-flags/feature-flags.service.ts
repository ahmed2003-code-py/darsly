import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Every flag this plan introduces. Defaults to enabled — a missing
 * AcademyFeatureFlag row means "use this default", not "off", so shipping a
 * new flag never requires backfilling every academy, and existing academies
 * keep today's behavior the moment a gated feature ships.
 */
export const FEATURE_FLAG_KEYS = [
  'attendance',
  'scheduling',
  'groups',
  'enrollmentApprovalMode',
  'adminStudio',
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

const DEFAULT_ENABLED = true;

/** How long a resolved flag is trusted before re-reading the DB. Short enough
 *  that a platform admin's toggle takes effect quickly; long enough that a
 *  hot route isn't hitting the DB on every request. */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  enabled: boolean;
  expiresAt: number;
}

/**
 * Per-academy feature toggles. Deliberately small: a flag list, a lookup, a
 * guard — not a rollout/targeting engine. See AcademyFeatureFlag in
 * schema.prisma.
 */
@Injectable()
export class FeatureFlagsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  private cacheKey(academyId: string, key: string): string {
    return `${academyId}:${key}`;
  }

  async isEnabled(academyId: string, key: FeatureFlagKey): Promise<boolean> {
    const ck = this.cacheKey(academyId, key);
    const cached = this.cache.get(ck);
    if (cached && cached.expiresAt > Date.now()) return cached.enabled;

    const row = await this.prisma.academyFeatureFlag.findUnique({
      where: { academyId_key: { academyId, key } },
      select: { enabled: true },
    });
    const enabled = row?.enabled ?? DEFAULT_ENABLED;
    this.cache.set(ck, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
    return enabled;
  }

  /** Platform-admin read: every known flag for one academy, defaults filled in. */
  async listForAcademy(academyId: string): Promise<{ key: FeatureFlagKey; enabled: boolean }[]> {
    const rows = await this.prisma.academyFeatureFlag.findMany({
      where: { academyId },
      select: { key: true, enabled: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.enabled]));
    return FEATURE_FLAG_KEYS.map((key) => ({ key, enabled: byKey.get(key) ?? DEFAULT_ENABLED }));
  }

  /** Platform-admin write. Invalidates this academy+key's cache entry immediately. */
  async setFlag(academyId: string, key: FeatureFlagKey, enabled: boolean, updatedBy: string) {
    const row = await this.prisma.academyFeatureFlag.upsert({
      where: { academyId_key: { academyId, key } },
      create: { academyId, key, enabled, updatedBy },
      update: { enabled, updatedBy },
    });
    this.cache.delete(this.cacheKey(academyId, key));
    return row;
  }
}
