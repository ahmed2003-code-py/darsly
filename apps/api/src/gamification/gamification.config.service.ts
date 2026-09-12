import { Injectable } from '@nestjs/common';
import { LevelTier, XpRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationEventType } from './gamification.types';

/**
 * The tunable half of the economy: what each event pays, and where the levels
 * sit. Both live in the database so an admin can retune them without a deploy,
 * and both are read on nearly every learning action — so they are cached in
 * process for a minute rather than fetched per event.
 *
 * The cache is deliberately short and deliberately dumb. A minute of staleness
 * after an admin edits an XP value is invisible; a stale-forever cache behind a
 * multi-instance deploy is a support ticket nobody can reproduce.
 */
const TTL_MS = 60_000;

@Injectable()
export class GamificationConfigService {
  private rules = new Map<string, XpRule>();
  private tiers: LevelTier[] = [];
  private loadedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  private async load(): Promise<void> {
    if (Date.now() - this.loadedAt < TTL_MS && this.tiers.length) return;
    const [rules, tiers] = await Promise.all([
      this.prisma.xpRule.findMany(),
      this.prisma.levelTier.findMany({ orderBy: { level: 'asc' } }),
    ]);
    this.rules = new Map(rules.map((r) => [r.event, r]));
    this.tiers = tiers;
    this.loadedAt = Date.now();
  }

  /** Drop the cache — called after an admin edits the economy. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  async rule(event: GamificationEventType): Promise<XpRule | null> {
    await this.load();
    const r = this.rules.get(event);
    return r && r.isActive ? r : null;
  }

  async levels(): Promise<LevelTier[]> {
    await this.load();
    return this.tiers;
  }

  /** The tier a given XP total sits in. Falls back to level 1 on an empty table. */
  async levelFor(xp: number): Promise<LevelTier> {
    const tiers = await this.levels();
    if (!tiers.length) {
      return { level: 1, minXp: 0, nameAr: 'مبتدئ', nameEn: 'Starter', icon: 'egg', coinReward: 0 };
    }
    let current = tiers[0];
    for (const t of tiers) if (xp >= t.minXp) current = t;
    return current;
  }

  /**
   * Where the student stands inside their level: how far through, and how much
   * is left. At the top tier there is no "next", and the bar reads full rather
   * than pretending there is more to climb.
   */
  async levelProgress(xp: number): Promise<{
    level: LevelTier;
    next: LevelTier | null;
    xpIntoLevel: number;
    xpForNext: number;
    pct: number;
  }> {
    const tiers = await this.levels();
    const level = await this.levelFor(xp);
    const next = tiers.find((t) => t.level === level.level + 1) ?? null;
    const xpIntoLevel = xp - level.minXp;
    const span = next ? next.minXp - level.minXp : 0;
    return {
      level,
      next,
      xpIntoLevel,
      xpForNext: next ? next.minXp - xp : 0,
      pct: next && span > 0 ? Math.min(100, Math.round((xpIntoLevel / span) * 100)) : 100,
    };
  }
}
