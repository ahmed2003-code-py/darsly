import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AiClient } from '../ai/ai.client';
import { AiJobError } from '../ai/ai-job.error';
import { DesignRulesService } from '../pipeline/design-rules.service';
import { ListItem, normalizeItems } from '../text.util';
import { SiteBlock, SiteDocument, parseSiteDocument } from '../schema/site-document';
import { AiCopy, parseAiCopy } from './ai-copy.schema';
import { AI_COPY_SCHEMA_NAME, aiCopyJsonSchema } from './ai-copy.jsonschema';
import { ContentSignals, systemPlanPrompt, userPlanPrompt } from './plan-prompt';
import { PLANNING_SCHEMA_NAME, planningJsonSchema } from './planning.jsonschema';
import { parseSitePlan } from './planning.schema';
import { systemPrompt, userPrompt } from './prompt';

const HEX = /^#[0-9a-fA-F]{6}$/;

type LT = { ar: string; en: string };
const hasText = (lt: LT | undefined): boolean => !!(lt && (lt.ar?.trim() || lt.en?.trim()));

/**
 * The staged generation pipeline:
 *   extract (load + normalise facts)
 *   → PLAN     (AI stage 1: brand strategist picks a Design DNA + colors + archetype)
 *   → RULES    (deterministic: resolve DNA → render tokens, validate)
 *   → GENERATE (AI stage 2: bilingual copy + curated skill/credential lists)
 *   → assemble (deterministic block layout, validated against the schema)
 * Two model calls; everything between them is deterministic.
 */
@Injectable()
export class SiteGeneratorService {
  private readonly logger = new Logger(SiteGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
    private readonly rules: DesignRulesService,
  ) {}

  async buildDraft(
    academyId: string,
    vibe?: string,
    stylePrompt?: string,
    lang?: 'ar' | 'en',
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

    const academyPrimary = HEX.test(academy.colorPrimary) ? academy.colorPrimary : '#4A32C9';
    const academyAccent = HEX.test(academy.colorAccent) ? academy.colorAccent : academyPrimary;
    const media = await this.prisma.academyMedia.findMany({
      where: { academyId, status: 'READY', kind: { in: ['LOGO', 'COVER', 'GALLERY'] } },
      orderBy: { createdAt: 'asc' },
    });
    const logoId = media.find((m) => m.kind === 'LOGO')?.id;
    const coverId = media.find((m) => m.kind === 'COVER')?.id;
    const galleryIds = media.filter((m) => m.kind === 'GALLERY').map((m) => m.id);

    const asStrings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const rawSubjects = asStrings(facts.subjects);
    const rawAchievements = asStrings(facts.achievements);
    const signals: ContentSignals = {
      hasCover: !!coverId,
      hasLogo: !!logoId,
      galleryCount: galleryIds.length,
      bioLength: (facts.bio ?? '').length,
      subjectsCount: rawSubjects.length,
      achievementsCount: rawAchievements.length,
    };

    // ── PLAN (AI stage 1) ── the strategist proposes a design direction only.
    const planCompletion = await this.ai.completeStructured<unknown>({
      system: systemPlanPrompt(),
      messages: [{ role: 'user', content: userPlanPrompt(facts, academy.name, vibe, stylePrompt, signals) }],
      maxTokens: 1500, // headroom for GPT-5 reasoning tokens + the small plan
      schemaName: PLANNING_SCHEMA_NAME,
      schema: planningJsonSchema,
    });
    const planParsed = parseSitePlan(planCompletion.data);
    if (planParsed.error) {
      throw new AiJobError(`AI plan failed validation: ${planParsed.error}`, 'RETRYABLE');
    }
    const plan = planParsed.data!;

    // ── RULES ── resolve the DNA into render tokens + validate.
    const { tokens, verdicts } = this.rules.validatePlan(plan, signals);
    if (verdicts.length) {
      this.logger.debug(`plan verdicts: ${verdicts.map((v) => `${v.severity}:${v.code}`).join(', ')}`);
    }
    // Colors: the AI's proposal wins only when the teacher gave a style brief;
    // otherwise keep the academy's own brand colors.
    const wantAi = !!stylePrompt?.trim();
    const primary = (wantAi && HEX.test(plan.theme.primary) && plan.theme.primary) || academyPrimary;
    const accent = (wantAi && HEX.test(plan.theme.accent) && plan.theme.accent) || academyAccent;

    // ── GENERATE (AI stage 2) ── content only, curated for the fixed design.
    const completion = await this.ai.completeStructured<unknown>({
      system: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(facts, academy.name, vibe, plan.archetype) }],
      maxTokens: 4000,
      schemaName: AI_COPY_SCHEMA_NAME,
      schema: aiCopyJsonSchema,
    });
    const parsed = parseAiCopy(completion.data);
    if (parsed.error) {
      throw new AiJobError(`AI output failed validation: ${parsed.error}`, 'RETRYABLE');
    }
    const copy: AiCopy = parsed.data!;

    // Curated lists win; fall back to the raw facts (cleaned) if the model
    // returned nothing usable.
    const toolkitItems = this.pickItems(copy.highlights, rawSubjects, { min: 2, maxLen: 60, cap: 20 });
    const credentialItems = this.pickItems(copy.credentials, rawAchievements, { min: 2, maxLen: 240, cap: 12 });

    // ── assemble (deterministic) ──
    const doc = this.assemble(
      copy,
      {
        primary, accent, style: tokens.style, preset: tokens.preset,
        headingFont: tokens.headingFont, dna: tokens.dna, defaultLang: lang,
        logoId, coverId, galleryIds, toolkitItems, credentialItems,
      },
      facts.socials,
    );
    const res = parseSiteDocument(doc);
    if (!res.success) {
      throw new AiJobError(`Assembled document invalid: ${res.errors?.join('; ')}`, 'RETRYABLE');
    }
    return { doc: res.data!, costCents: planCompletion.costCents + completion.costCents };
  }

  /** Prefer the AI-curated bilingual list; fall back to cleaned raw facts. */
  private pickItems(
    curated: LT[] | undefined,
    rawFallback: string[],
    opts: { min: number; maxLen: number; cap: number },
  ): ListItem[] {
    const c = normalizeItems(curated ?? [], opts);
    return c.length ? c : normalizeItems(rawFallback, opts);
  }

  private assemble(
    copy: AiCopy,
    brand: {
      primary: string; accent: string; style?: string; preset?: string;
      headingFont?: string; dna?: string; defaultLang?: 'ar' | 'en';
      logoId?: string; coverId?: string; galleryIds: string[];
      toolkitItems: ListItem[]; credentialItems: ListItem[];
    },
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
    if (brand.toolkitItems.length) {
      blocks.push({
        type: 'toolkit',
        id: randomUUID(),
        heading: hasText(copy.toolkitHeading) ? copy.toolkitHeading : bilingual('ما ستتعلمه', 'What you’ll learn'),
        items: brand.toolkitItems,
      });
    }
    if (brand.credentialItems.length) {
      blocks.push({
        type: 'credentials',
        id: randomUUID(),
        heading: hasText(copy.credentialsHeading) ? copy.credentialsHeading : bilingual('لماذا تثق بنا', 'Track record'),
        items: brand.credentialItems,
      });
    }
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
      theme: {
        primary: brand.primary,
        accent: brand.accent,
        ...(brand.logoId ? { logoMediaId: brand.logoId } : {}),
        ...(brand.style ? { style: brand.style as SiteDocument['theme']['style'] } : {}),
        ...(brand.preset ? { preset: brand.preset as SiteDocument['theme']['preset'] } : {}),
        ...(brand.headingFont ? { headingFont: brand.headingFont as SiteDocument['theme']['headingFont'] } : {}),
        ...(brand.dna ? { dna: brand.dna } : {}),
        ...(brand.defaultLang ? { defaultLang: brand.defaultLang } : {}),
      },
      seo: { title: copy.seo.metaTitle, description: copy.seo.metaDescription },
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
