import { SiteBlock } from '../../../schema/site-document';
import {
  ENROLLING_BADGE, actions, hasImage, headline, i18n, image, sectionOpen, SECTION_CLOSE, COURSES_ANCHOR,
} from '../helpers';
import { registerPattern } from '../registry';
import { ComposeContext } from '../types';

/**
 * Heroes.
 *
 * The first screen decides whether the rest of the page is read, and it is the
 * section where two teachers most obviously either do or do not have their own
 * site. Six here, and they are not variations on a theme: a centred statement,
 * a split portrait, an editorial slab, a full-bleed photograph, a bento panel
 * and an offset collage produce genuinely different first impressions from the
 * same three sentences.
 */

type Hero = Extract<SiteBlock, { type: 'hero' }>;

const SCROLL_CUE = `<a class="hero-cue" href="#${COURSES_ANCHOR}" aria-hidden="true" tabindex="-1"><span></span></a>`;

const HERO_BASE = `
.hero{display:flex;align-items:center;min-height:var(--hero-h,80vh)}
.hero .wrap{width:100%}
.hero h1{margin-bottom:.5em}
.hero .lead{color:var(--mut)}
.hero-cue{position:absolute;bottom:22px;inset-inline-start:50%;transform:translateX(-50%);width:24px;height:38px;border:2px solid color-mix(in srgb,var(--ink) 26%,transparent);border-radius:999px;display:flex;justify-content:center;padding-top:7px}
.hero-cue span{width:3px;height:7px;border-radius:2px;background:var(--a);animation:cue 1.8s ease-in-out infinite}
@keyframes cue{0%{opacity:0;transform:translateY(-4px)}40%{opacity:1}100%{opacity:0;transform:translateY(11px)}}
.hero :is(.badge,h1,.lead,.actions){animation:hero-in .85s cubic-bezier(.2,.7,.2,1) both}
.hero h1{animation-delay:.06s}.hero .lead{animation-delay:.15s}.hero .actions{animation-delay:.24s}
@keyframes hero-in{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
[data-motion=calm] .hero :is(.badge,h1,.lead,.actions){animation-duration:1.1s}
[data-motion=cinematic] .hero :is(.badge,h1,.lead,.actions){animation-duration:1.3s}
@media(max-width:820px){.hero{min-height:auto;padding-block:calc(var(--pad) * .9)}.hero-cue{display:none}}`;

function copy(block: Hero, ctx: ComposeContext, opts: { badge?: boolean } = {}): string {
  return `${opts.badge === false ? '' : ENROLLING_BADGE}
    <h1>${headline(block.headline)}</h1>
    <p class="lead">${i18n(block.subheadline)}</p>
    ${actions(ctx, block.ctaLabel)}`;
}

// ── 1. Centred ───────────────────────────────────────────────────────────────
registerPattern({
  id: 'hero.centered',
  section: 'hero',
  brief: 'Centred statement. Type only, generous air. The safe, confident default.',
  base: 1,
  css: () => `${HERO_BASE}
.hero-centered .wrap{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:900px}
.hero-centered h1{max-width:16ch}
.hero-centered .lead{max-width:56ch}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-centered' })}
      ${copy(block, ctx)}${SCROLL_CUE}${SECTION_CLOSE}`;
  },
});

// ── 2. Split portrait ────────────────────────────────────────────────────────
registerPattern({
  id: 'hero.split-portrait',
  section: 'hero',
  brief: 'Copy on one side, the teacher\'s photograph on the other. Needs a cover image.',
  needs: { media: true },
  base: 1.3,
  css: () => `${HERO_BASE}
.hero-split .wrap{display:grid;gap:calc(var(--gap) * 1.6);align-items:center;grid-template-columns:1fr}
@media(min-width:900px){.hero-split .wrap{grid-template-columns:1.05fr .95fr}}
.hero-split h1{max-width:15ch}
.hero-split .lead{max-width:46ch}
.hero-split .hero-media{order:-1}
@media(min-width:900px){.hero-split .hero-media{order:0}}
.hero-split .img{box-shadow:var(--sh2)}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-split' })}
      <div class="hero-copy">${copy(block, ctx)}</div>
      <div class="hero-media">${image(block.mediaId, ctx, { ratio: '4:3', treatment: spec.imageTreatment, eager: true })}</div>
      ${SECTION_CLOSE}`;
  },
});

// ── 3. Editorial slab ────────────────────────────────────────────────────────
registerPattern({
  id: 'hero.editorial',
  section: 'hero',
  brief: 'Oversized left-aligned headline running most of the screen width. No image. Authoritative.',
  base: 1,
  weight: { university: 1.4, math_science: 1.2, languages: 1.15 },
  css: () => `${HERO_BASE}
.hero-editorial{--hero-h:86vh}
.hero-editorial .wrap{display:flex;flex-direction:column;align-items:flex-start;text-align:start}
.hero-editorial h1{max-width:13ch;font-size:calc(var(--h1) * 1.12)}
.hero-editorial .lead{max-width:52ch;margin-top:.4em}
.hero-editorial .rule{width:min(100%,520px);height:1px;background:var(--line);margin:2em 0 0}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-editorial' })}
      ${copy(block, ctx)}<div class="rule" aria-hidden="true"></div>${SECTION_CLOSE}`;
  },
});

// ── 4. Full-bleed photograph ─────────────────────────────────────────────────
registerPattern({
  id: 'hero.image-full',
  section: 'hero',
  brief: 'The cover photograph fills the screen behind the headline, under a scrim. Cinematic. Needs a strong cover image.',
  needs: { media: true },
  base: 1.15,
  weight: { exam_prep: 1.35, languages: 1.2 },
  fullBleed: true,
  css: () => `${HERO_BASE}
.hero-full{--hero-h:88vh;color:#fff;overflow:hidden}
.hero-full .hero-bg{position:absolute;inset:0;z-index:-1}
.hero-full .hero-bg .img{width:100%;height:100%;object-fit:cover;border-radius:0}
.hero-full::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(6,6,14,.30),rgba(6,6,14,.80))}
.hero-full :is(h1,.lead){color:#fff}
.hero-full .lead{color:rgba(255,255,255,.86)}
.hero-full .badge{color:#fff;border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.12)}
.hero-full .badge .dot{background:#fff}
.hero-full .btn-ghost{color:#fff;border-color:rgba(255,255,255,.5);background:rgba(255,255,255,.08)}
.hero-full .hero-cue{border-color:rgba(255,255,255,.5)}
.hero-full h1{max-width:17ch}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    const bg = image(block.mediaId, ctx, { treatment: 'plain', eager: true });
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-full' })}
      ${copy(block, ctx)}${SCROLL_CUE}</div>
      <div class="hero-bg" aria-hidden="true">${bg}</div></section>`;
  },
});

// ── 5. Bento ─────────────────────────────────────────────────────────────────
registerPattern({
  id: 'hero.bento',
  section: 'hero',
  brief: 'The headline shares the first screen with panels — image, badge, supporting note. Modern, technical, product-like.',
  base: 1,
  weight: { programming: 1.5, exam_prep: 1.1 },
  css: () => `${HERO_BASE}
.hero-bento{--hero-h:auto;padding-block:calc(var(--pad) * 1.1)}
.hero-bento .bento{display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:900px){
  .hero-bento .bento{grid-template-columns:repeat(3,1fr);grid-auto-rows:minmax(0,auto)}
  .hero-bento .b-copy{grid-column:span 2}
  .hero-bento .b-wide{grid-column:span 3}
}
.hero-bento .b-panel{background:var(--surface);border:var(--bw) solid var(--line);border-radius:var(--rad-l);padding:1.8em;display:flex;flex-direction:column;justify-content:space-between;gap:1em}
.hero-bento .b-panel .k{font-family:var(--font-h);font-size:2.2rem;font-weight:var(--wh);color:var(--a-text);line-height:1}
.hero-bento .b-media .img{height:100%;min-height:200px;border-radius:var(--rad-l)}
.hero-bento h1{max-width:14ch}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    const media = block.mediaId && hasImage(block.mediaId, ctx)
      ? `<div class="b-media b-wide">${image(block.mediaId, ctx, { ratio: '16:9', treatment: spec.imageTreatment, eager: true })}</div>`
      : '';
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-bento' })}
      <div class="bento">
        <div class="b-copy">${copy(block, ctx)}</div>
        <div class="b-panel">
          <span class="k">${i18n({ ar: 'ابدأ', en: 'Start' })}</span>
          <p class="mut">${i18n({ ar: 'مقاعد محدودة كل شهر، والمتابعة أسبوعية.', en: 'Limited places each month, with weekly follow-up.' })}</p>
        </div>
        ${media}
      </div>${SECTION_CLOSE}`;
  },
});

// ── 6. Offset collage ────────────────────────────────────────────────────────
registerPattern({
  id: 'hero.offset-collage',
  section: 'hero',
  brief: 'Headline with the photograph offset and overlapping. Warm, human, art-directed. Needs a cover image.',
  needs: { media: true },
  base: 1.05,
  weight: { languages: 1.45, general: 1.1 },
  css: () => `${HERO_BASE}
.hero-collage{--hero-h:auto;padding-block:calc(var(--pad) * 1.15);overflow:hidden}
.hero-collage .wrap{display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:980px){
  .hero-collage .wrap{grid-template-columns:1.1fr .9fr;align-items:center}
  .hero-collage .hero-art{position:relative;transform:translateY(6%)}
  .hero-collage .hero-art .img{transform:rotate(-2.5deg)}
  .hero-collage .hero-art::before{content:"";position:absolute;inset:-6% -8% 8% 10%;border:1px solid color-mix(in srgb,var(--a) 40%,transparent);border-radius:var(--rad-l);z-index:-1}
}
.hero-collage h1{max-width:14ch}
.hero-collage .lead{max-width:46ch}
.hero-collage .img{box-shadow:var(--sh2)}`,
  render: (b, spec, ctx) => {
    const block = b as Hero;
    return `${sectionOpen('hero', spec, ctx, { extraClass: 'hero hero-collage' })}
      <div class="hero-copy">${copy(block, ctx)}</div>
      <div class="hero-art">${image(block.mediaId, ctx, { ratio: '3:4', treatment: spec.imageTreatment, eager: true })}</div>
      ${SECTION_CLOSE}`;
  },
});
