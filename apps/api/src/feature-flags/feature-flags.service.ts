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
  // Center Operations C1 — the student register. A new product surface rather
  // than a gate on today's behaviour, so it starts OFF and a platform admin
  // turns it on per academy (see DEFAULT_OFF).
  'studentRegistry',
  // Center Operations C2 — weekly timetables, real class occurrences and their
  // attendance (start, late, close, makeup). New to everyone, so OFF until a
  // platform admin turns it on per academy.
  'classOperations',
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

const DEFAULT_ENABLED = true;

/**
 * Flags whose missing row means OFF. The rule above ("missing = on") exists
 * so gating an existing feature never changes what an academy already has;
 * a feature that is new to everyone is the opposite case — nobody should
 * wake up to an unannounced screen — so it is listed here instead.
 */
const DEFAULT_OFF: ReadonlySet<FeatureFlagKey> = new Set<FeatureFlagKey>([
  'studentRegistry',
  'classOperations',
]);

function defaultFor(key: FeatureFlagKey): boolean {
  return DEFAULT_OFF.has(key) ? false : DEFAULT_ENABLED;
}

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
    const enabled = row?.enabled ?? defaultFor(key);
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
    return FEATURE_FLAG_KEYS.map((key) => ({ key, enabled: byKey.get(key) ?? defaultFor(key) }));
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
