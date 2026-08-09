import { AccentMark, Backdrop, ImageTreatment } from '../../schema/design-spec';

/**
 * Decoration modules.
 *
 * The backdrop is the single biggest lever on how a page *feels* before a word
 * of it is read — a blueprint grid and a warm aurora are not the same site with
 * different colours. Each one is a self-contained stylesheet emitted only when
 * the design actually asks for it, so an austere page ships none of this.
 *
 * Everything here is decoration in the strict sense: remove any of it and the
 * page still reads, still navigates and still converts.
 */

/** The element the page renders behind everything, when the design has a backdrop. */
export function backdropHtml(kind: Backdrop): string {
  if (kind === 'none') return '';
  const layers = kind === 'mesh' || kind === 'aurora' || kind === 'orbits' ? '<i></i><i></i><i></i>' : '';
  return `<div class="backdrop" data-kind="${kind}" aria-hidden="true">${layers}</div>`;
}

const BACKDROP_BASE = `
.backdrop{position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden}
.backdrop i{position:absolute;display:block;border-radius:50%;will-change:transform}`;

export const BACKDROP_CSS: Record<Backdrop, string> = {
  none: '',

  'gradient-wash': `${BACKDROP_BASE}
.backdrop[data-kind=gradient-wash]{background:
  radial-gradient(60% 55% at 15% 0%,rgba(var(--pr),.20),transparent 62%),
  radial-gradient(55% 50% at 88% 8%,rgba(var(--ar),.16),transparent 62%)}`,

  mesh: `${BACKDROP_BASE}
.backdrop[data-kind=mesh]{filter:blur(80px);opacity:.55}
.backdrop[data-kind=mesh] i:nth-child(1){width:52vw;height:52vw;inset-inline-start:-10vw;top:-16vw;background:rgba(var(--pr),.55);animation:drift-a 21s ease-in-out infinite}
.backdrop[data-kind=mesh] i:nth-child(2){width:44vw;height:44vw;inset-inline-end:-8vw;top:6vw;background:rgba(var(--ar),.5);animation:drift-b 26s ease-in-out infinite}
.backdrop[data-kind=mesh] i:nth-child(3){width:48vw;height:48vw;inset-inline-start:34vw;bottom:-22vw;background:rgba(var(--pr),.34);animation:drift-c 31s ease-in-out infinite}
${drift()}`,

  spotlight: `${BACKDROP_BASE}
.backdrop[data-kind=spotlight]{background:radial-gradient(70% 60% at 50% -8%,rgba(var(--pr),.30),transparent 65%)}`,

  'grid-lines': `${BACKDROP_BASE}
.backdrop[data-kind=grid-lines]{background-image:
  linear-gradient(to right,color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px),
  linear-gradient(to bottom,color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px);
  background-size:64px 64px;
  mask-image:radial-gradient(80% 70% at 50% 0%,#000,transparent 78%)}`,

  'dot-matrix': `${BACKDROP_BASE}
.backdrop[data-kind=dot-matrix]{background-image:radial-gradient(color-mix(in srgb,var(--ink) 16%,transparent) 1.2px,transparent 1.2px);background-size:26px 26px;
  mask-image:radial-gradient(85% 75% at 50% 10%,#000,transparent 80%)}`,

  blueprint: `${BACKDROP_BASE}
.backdrop[data-kind=blueprint]{background-color:transparent;background-image:
  linear-gradient(to right,rgba(var(--pr),.14) 1px,transparent 1px),
  linear-gradient(to bottom,rgba(var(--pr),.14) 1px,transparent 1px),
  linear-gradient(to right,rgba(var(--pr),.07) 1px,transparent 1px),
  linear-gradient(to bottom,rgba(var(--pr),.07) 1px,transparent 1px);
  background-size:120px 120px,120px 120px,24px 24px,24px 24px}`,

  topography: `${BACKDROP_BASE}
.backdrop[data-kind=topography]{background-image:repeating-radial-gradient(circle at 20% 30%,transparent 0 38px,rgba(var(--pr),.09) 38px 39px),repeating-radial-gradient(circle at 78% 72%,transparent 0 46px,rgba(var(--ar),.08) 46px 47px)}`,

  orbits: `${BACKDROP_BASE}
.backdrop[data-kind=orbits] i{border-radius:50%;background:none;border:1px solid color-mix(in srgb,var(--a) 26%,transparent)}
.backdrop[data-kind=orbits] i:nth-child(1){width:70vmax;height:70vmax;inset-inline-start:-18vmax;top:-24vmax;animation:spin-slow 70s linear infinite}
.backdrop[data-kind=orbits] i:nth-child(2){width:52vmax;height:52vmax;inset-inline-end:-14vmax;bottom:-18vmax;animation:spin-slow 98s linear infinite reverse}
.backdrop[data-kind=orbits] i:nth-child(3){width:34vmax;height:34vmax;inset-inline-start:38vmax;top:26vmax;animation:spin-slow 60s linear infinite}
@keyframes spin-slow{to{transform:rotate(1turn)}}`,

  aurora: `${BACKDROP_BASE}
.backdrop[data-kind=aurora]{filter:blur(66px);opacity:.5}
.backdrop[data-kind=aurora] i{border-radius:44%}
.backdrop[data-kind=aurora] i:nth-child(1){width:80vw;height:38vw;inset-inline-start:-14vw;top:-8vw;background:linear-gradient(90deg,rgba(var(--pr),.7),rgba(var(--ar),.4));animation:drift-a 27s ease-in-out infinite}
.backdrop[data-kind=aurora] i:nth-child(2){width:66vw;height:30vw;inset-inline-end:-12vw;top:34vh;background:linear-gradient(90deg,rgba(var(--ar),.55),transparent);animation:drift-b 34s ease-in-out infinite}
.backdrop[data-kind=aurora] i:nth-child(3){width:70vw;height:26vw;inset-inline-start:6vw;bottom:-10vw;background:linear-gradient(90deg,transparent,rgba(var(--pr),.5));animation:drift-c 40s ease-in-out infinite}
${drift()}`,
};

function drift(): string {
  return `@keyframes drift-a{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(6vw,5vw,0) scale(1.12)}}
@keyframes drift-b{0%,100%{transform:translate3d(0,0,0) scale(1.05)}50%{transform:translate3d(-7vw,6vw,0) scale(.92)}}
@keyframes drift-c{0%,100%{transform:translate3d(0,0,0) scale(.96)}50%{transform:translate3d(4vw,-6vw,0) scale(1.1)}}
[data-motion=calm] .backdrop i{animation-duration:46s}
[data-motion=cinematic] .backdrop{opacity:.7}`;
}

/** A fine noise overlay. Expensive on a dark editorial page, dirt on a light one. */
export const GRAIN_CSS = `
.grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")}`;

export const ACCENT_CSS: Record<AccentMark, string> = {
  'rule-lines': `
.block[data-accent~=rule-lines]>.wrap::before{content:"";display:block;width:64px;height:2px;background:var(--a);margin-bottom:2em}
.center[data-accent~=rule-lines]>.wrap::before{margin-inline:auto}`,

  'numbered-sections': `
main{counter-reset:sec}
.block[data-accent~=numbered-sections]{counter-increment:sec}
.block[data-accent~=numbered-sections] .eyebrow::before{content:counter(sec,decimal-leading-zero) " —";font-variant-numeric:tabular-nums;opacity:.7}`,

  'corner-brackets': `
.block[data-accent~=corner-brackets]>.wrap{position:relative}
.block[data-accent~=corner-brackets]>.wrap::before,.block[data-accent~=corner-brackets]>.wrap::after{content:"";position:absolute;width:22px;height:22px;border:2px solid color-mix(in srgb,var(--a) 60%,transparent)}
.block[data-accent~=corner-brackets]>.wrap::before{top:-10px;inset-inline-start:0;border-inline-end:0;border-block-end:0}
.block[data-accent~=corner-brackets]>.wrap::after{bottom:-10px;inset-inline-end:0;border-inline-start:0;border-block-start:0}`,

  'sticker-badges': `
.block[data-accent~=sticker-badges] .eyebrow{display:inline-flex;padding:.45em 1em;border-radius:var(--pill);background:var(--a);color:var(--on-a);letter-spacing:.1em;transform:rotate(-1.5deg)}`,

  'underline-swash': `
.block[data-accent~=underline-swash] h2{display:inline-block;background-image:linear-gradient(color-mix(in srgb,var(--a) 40%,transparent),color-mix(in srgb,var(--a) 40%,transparent));background-size:100% .28em;background-position:0 88%;background-repeat:no-repeat;padding-inline-end:.12em}`,

  blob: `
.block[data-accent~=blob]::before{content:"";position:absolute;z-index:-1;width:28vmax;height:28vmax;border-radius:44% 56% 62% 38%/48% 42% 58% 52%;background:radial-gradient(circle at 30% 30%,rgba(var(--ar),.28),transparent 68%);inset-inline-end:-8vmax;top:-6vmax;filter:blur(12px)}`,

  ring: `
.block[data-accent~=ring]::before{content:"";position:absolute;z-index:-1;width:24vmax;height:24vmax;border-radius:50%;border:1px solid color-mix(in srgb,var(--a) 32%,transparent);inset-inline-start:-8vmax;bottom:-8vmax}`,
};

export const DIVIDER_CSS: Record<string, string> = {
  none: '',
  hairline: `.block+.block::before{content:"";position:absolute;top:0;inset-inline:var(--gut);height:1px;background:var(--line)}`,
  gradient: `.block+.block::before{content:"";position:absolute;top:0;inset-inline:var(--gut);height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--a) 45%,transparent),transparent)}`,
  wave: `.block+.block::before{content:"";position:absolute;top:-1px;inset-inline:0;height:22px;background:var(--bg);mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 22' preserveAspectRatio='none'%3E%3Cpath d='M0 22V8c150 12 300-12 450-4s300 20 450 10 300-14 300-14v22z'/%3E%3C/svg%3E");mask-size:100% 100%}`,
  notch: `.block+.block::before{content:"";position:absolute;top:0;inset-inline-start:calc(50% - 14px);width:28px;height:14px;background:var(--bg);clip-path:polygon(0 0,100% 0,50% 100%)}`,
};

export const IMAGE_CSS: Record<ImageTreatment, string> = {
  plain: `.img[data-t=plain]{border-radius:0}`,
  rounded: '',
  duotone: `.img[data-t=duotone]{filter:grayscale(1) contrast(1.05)}
.img-wrap[data-t=duotone]{position:relative;isolation:isolate}
.img-wrap[data-t=duotone]::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(140deg,var(--p),var(--a));mix-blend-mode:color;opacity:.72;pointer-events:none}`,
  ring: `.img[data-t=ring]{outline:1px solid color-mix(in srgb,var(--a) 45%,transparent);outline-offset:10px}`,
  tilt: `.img-wrap[data-t=tilt]{--rx:0deg;--ry:0deg;perspective:1000px}
.img-wrap[data-t=tilt]>*{transform:rotateX(var(--rx)) rotateY(var(--ry));transition:transform .25s cubic-bezier(.2,.7,.2,1);will-change:transform}`,
  'mask-arch': `.img[data-t=mask-arch]{border-start-start-radius:50vmin;border-start-end-radius:50vmin;border-end-start-radius:var(--rad);border-end-end-radius:var(--rad)}`,
  'mask-blob': `.img[data-t=mask-blob]{border-radius:56% 44% 38% 62%/48% 56% 44% 52%}`,
  'grid-overlay': `.img-wrap[data-t=grid-overlay]{position:relative}
.img-wrap[data-t=grid-overlay]::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background-image:linear-gradient(to right,rgba(255,255,255,.12) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.12) 1px,transparent 1px);background-size:34px 34px}`,
};

/** Extra CSS a scroll effect needs. The behaviour itself lives in the client. */
export const SCROLL_FX_CSS: Record<string, string> = {
  'progress-bar': `.scroll-bar{position:fixed;top:0;inset-inline:0;height:3px;z-index:40;pointer-events:none}
.scroll-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--a),var(--p));transition:width .1s linear}`,
  'sticky-headings': `@media(min-width:960px){.block[data-sticky] h2{position:sticky;top:calc(74px + 1.5em)}}`,
  marquee: `.marquee{overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.marquee-track{display:flex;gap:12px;width:max-content;animation:marquee 34s linear infinite}
.marquee:hover .marquee-track{animation-play-state:paused}
@keyframes marquee{to{transform:translateX(-50%)}}
[dir=rtl] .marquee-track{animation-direction:reverse}`,
  'pointer-glow': `.glow{--mx:50%;--my:50%;position:relative}
.glow::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .3s;background:radial-gradient(260px circle at var(--mx) var(--my),rgba(var(--pr),.16),transparent 62%)}
.glow:hover::after{opacity:1}`,
  parallax: '',
  counters: '',
};
