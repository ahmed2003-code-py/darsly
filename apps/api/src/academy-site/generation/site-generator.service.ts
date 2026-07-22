import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AiClient } from '../ai/ai.client';
import { AiJobError } from '../ai/ai-job.error';
import { SiteBlock, SiteDocument, parseSiteDocument } from '../schema/site-document';
import { AiCopy, parseAiCopy } from './ai-copy.schema';
import { extractJson, systemPrompt, userPrompt } from './prompt';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The staged generation pipeline: extract (load + normalize facts) → brand
 * (deterministic palette from the academy) → copy (one AI call) → assemble
 * (deterministic block layout, validated against the Site Document schema).
 * Only the copy stage calls the model; everything else is deterministic.
 */
@Injectable()
export class SiteGeneratorService {
  private readonly logger = new Logger(SiteGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
  ) {}

  async buildDraft(
    academyId: string,
    vibe?: string,
  ): Promise<{ doc: SiteDocument; costCents: number }> {
    // ── extract ──
    const [academy, facts] = await Promise.all([
      this.prisma.academy.findUnique({ where: { id: academyId } }),
      this.prisma.academyProfileFacts.findUnique({ where: { academyId } }),
    ]);
    if (!academy) throw new AiJobError('Academy not found', 'TERMINAL');
    if (!facts || (!facts.bio && !facts.rawIntake && !(facts.subjects as string[])?.length)) {
      throw new AiJobError('Not enough profile facts to generate a site', 'TERMINAL');
    }

    // ── brand (deterministic) ──
    const primary = HEX.test(academy.colorPrimary) ? academy.colorPrimary : '#4A32C9';
    const accent = HEX.test(academy.colorAccent) ? academy.colorAccent : primary;
    const media = await this.prisma.academyMedia.findMany({
      where: { academyId, status: 'READY', kind: { in: ['LOGO', 'COVER', 'GALLERY'] } },
      orderBy: { createdAt: 'asc' },
    });
    const logoId = media.find((m) => m.kind === 'LOGO')?.id;
    const coverId = media.find((m) => m.kind === 'COVER')?.id;
    const galleryIds = media.filter((m) => m.kind === 'GALLERY').map((m) => m.id);

    // ── copy (AI) ──
    const completion = await this.ai.complete({
      system: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(facts, academy.name, vibe) }],
      maxTokens: 2500,
      temperature: 0.7,
    });
    let copy: AiCopy;
    try {
      const parsed = parseAiCopy(extractJson(completion.text));
      if (parsed.error) throw new Error(parsed.error);
      copy = parsed.data!;
    } catch (e) {
      // Malformed model output is retryable (a re-roll often fixes it).
      throw new AiJobError(`AI output invalid: ${(e as Error).message}`, 'RETRYABLE');
    }

    // ── assemble (deterministic) ──
    const doc = this.assemble(copy, { primary, accent, logoId, coverId, galleryIds }, facts.socials);
    const res = parseSiteDocument(doc);
    if (!res.success) {
      throw new AiJobError(`Assembled document invalid: ${res.errors?.join('; ')}`, 'RETRYABLE');
    }
    return { doc: res.data!, costCents: completion.costCents };
  }

  private assemble(
    copy: AiCopy,
    brand: { primary: string; accent: string; logoId?: string; coverId?: string; galleryIds: string[] },
    socialsJson: unknown,
  ): SiteDocument {
    const bilingual = (ar: string, en: string) => ({ ar, en });
    const blocks: SiteBlock[] = [];

    blocks.push({
      type: 'hero',
      id: randomUUID(),
      headline: copy.hero.headline,
      subheadline: copy.hero.subheadline,
      ctaLabel: copy.hero.ctaLabel,
      ...(brand.coverId ? { mediaId: brand.coverId } : {}),
    });
    blocks.push({
      type: 'about',
      id: randomUUID(),
      heading: copy.about.heading,
      body: copy.about.body,
    });
    blocks.push({
      type: 'courses',
      id: randomUUID(),
      heading: bilingual('الدورات', 'Courses'),
      mode: 'auto',
      limit: 6,
    });
    if (brand.galleryIds.length) {
      blocks.push({
        type: 'gallery',
        id: randomUUID(),
        heading: bilingual('معرض الصور', 'Gallery'),
        mediaIds: brand.galleryIds.slice(0, 12),
      });
    }
    blocks.push({
      type: 'reviews',
      id: randomUUID(),
      heading: bilingual('آراء الطلاب', 'Student Reviews'),
      mode: 'auto',
      limit: 6,
    });
    blocks.push({
      type: 'faq',
      id: randomUUID(),
      heading: bilingual('الأسئلة الشائعة', 'FAQ'),
      items: copy.faq.slice(0, 8),
    });
    const socials = this.normalizeSocials(socialsJson);
    blocks.push({
      type: 'contact',
      id: randomUUID(),
      heading: bilingual('تواصل معنا', 'Contact'),
      socials,
    });
    blocks.push({
      type: 'cta',
      id: randomUUID(),
      headline: copy.cta.headline,
      buttonLabel: copy.cta.buttonLabel,
    });

    return {
      version: 1,
      theme: { primary: brand.primary, accent: brand.accent, ...(brand.logoId ? { logoMediaId: brand.logoId } : {}) },
      blocks,
    };
  }

  private normalizeSocials(json: unknown): { platform: string; url: string }[] {
    if (!Array.isArray(json)) return [];
    return json
      .filter(
        (s): s is { platform: string; url: string } =>
          !!s && typeof s.platform === 'string' && typeof s.url === 'string' && /^https?:\/\//.test(s.url),
      )
      .slice(0, 10)
      .map((s) => ({ platform: s.platform.slice(0, 30), url: s.url.slice(0, 300) }));
  }
}
