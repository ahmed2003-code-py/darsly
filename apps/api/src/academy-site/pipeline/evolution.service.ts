import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DesignFingerprint } from '../schema/design-spec';
import { SiteDocument, parseSiteDocument } from '../schema/site-document';
import { DESIGN_DNA_KEYS, isDnaKey } from './design-dna';
import { designFor } from './design-lift';
import { fingerprint } from './fingerprint';

/**
 * The Website Evolution layer. Generation is not memoryless: past decisions and
 * their outcomes steer the next one. Signals we read from history:
 *   - the published/approved design (what the teacher kept) → prefer to refine it
 *   - recently generated designs (what they regenerated away from) → don't repeat
 * so a teacher who keeps regenerating gets genuinely fresh directions, and the
 * pipeline improves instead of restarting from zero.
 */
export interface EvolutionContext {
  /** DNA of the currently published design, if any (a "keep this" signal). */
  publishedDna?: string;
  publishedArchetype?: string;
  /** DNAs of recent generations, most-recent first (a "don't repeat" signal). */
  recentDnas: string[];
  /** How many prior generations exist (0 = first ever). */
  regenCount: number;
}

/**
 * The fingerprint of a stored document: the one it recorded, or one measured
 * from it. A snapshot that no longer parses is skipped rather than throwing —
 * history is advisory, and a corrupt old version must not block a new design.
 */
function fingerprintOf(raw: unknown): DesignFingerprint | undefined {
  const stored = (raw as { fingerprint?: DesignFingerprint } | null)?.fingerprint;
  if (stored && typeof stored === 'object' && 'mode' in stored) return stored;
  const parsed = parseSiteDocument(raw);
  if (!parsed.success) return undefined;
  const doc = parsed.data as SiteDocument;
  return fingerprint(designFor(doc), doc);
}

const themeStr = (doc: unknown, key: 'dna' | 'archetype'): string | undefined => {
  const theme = doc && typeof doc === 'object' ? (doc as { theme?: Record<string, unknown> }).theme : undefined;
  const v = theme?.[key];
  return typeof v === 'string' ? v : undefined;
};

@Injectable()
export class EvolutionService {
  constructor(private readonly prisma: PrismaService) {}

  async context(academyId: string): Promise<EvolutionContext> {
    const site = await this.prisma.academySite.findUnique({
      where: { academyId },
      select: { id: true, publishedDoc: true },
    });
    const publishedDna = themeStr(site?.publishedDoc, 'dna');
    const publishedArchetype = themeStr(site?.publishedDoc, 'archetype');

    let recentDnas: string[] = [];
    let regenCount = 0;
    if (site) {
      const [snaps, count] = await Promise.all([
        this.prisma.academySiteSnapshot.findMany({
          where: { siteId: site.id, reason: 'generate' },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { doc: true },
        }),
        this.prisma.academySiteSnapshot.count({ where: { siteId: site.id, reason: 'generate' } }),
      ]);
      regenCount = count;
      recentDnas = snaps.map((s) => themeStr(s.doc, 'dna')).filter((d): d is string => !!d);
    }
    return { publishedDna, publishedArchetype, recentDnas, regenCount };
  }

  /**
   * Deterministic anti-repeat guard: if the teacher gave no fresh style brief and
   * the model chose the very direction they just regenerated away from, rotate to
   * a DNA they have NOT recently seen. Guarantees variety even if the model
   * ignores the history hint in the prompt.
   */
  enforceVariety(chosenDna: string, ctx: EvolutionContext, hasStyleBrief: boolean): string {
    if (hasStyleBrief) return chosenDna; // an explicit brief always wins
    const mostRecent = ctx.recentDnas[0];
    if (!mostRecent || chosenDna !== mostRecent) return chosenDna;
    const used = new Set(ctx.recentDnas);
    const fresh = DESIGN_DNA_KEYS.find((k) => !used.has(k));
    if (fresh) return fresh;
    // Every DNA has been used — pick any that isn't the most recent.
    return DESIGN_DNA_KEYS.find((k) => k !== mostRecent) ?? chosenDna;
  }

  /** Guard against an unknown/stale DNA string reaching token resolution. */
  normalizeDna(dna: string): string {
    return isDnaKey(dna) ? dna : DESIGN_DNA_KEYS[0];
  }

  /**
   * The design fingerprints of recent generations, most recent first.
   *
   * A composed document stores its own fingerprint, so this is usually a read.
   * Documents from before fingerprints existed are measured on the spot, which
   * is what lets an academy's first composed page still be pushed away from the
   * legacy page it is replacing.
   */
  async recentFingerprints(academyId: string, take = 3): Promise<DesignFingerprint[]> {
    const site = await this.prisma.academySite.findUnique({
      where: { academyId },
      select: { id: true },
    });
    if (!site) return [];
    const snaps = await this.prisma.academySiteSnapshot.findMany({
      where: { siteId: site.id, reason: 'generate' },
      orderBy: { createdAt: 'desc' },
      take,
      select: { doc: true },
    });
    const out: DesignFingerprint[] = [];
    for (const s of snaps) {
      const fp = fingerprintOf(s.doc);
      if (fp) out.push(fp);
    }
    return out;
  }
}
