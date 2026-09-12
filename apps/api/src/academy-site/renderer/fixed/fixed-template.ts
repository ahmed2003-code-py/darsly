import { paletteTokens } from '../../pipeline/color-palettes';
import { SiteBlock, SiteDocument } from '../../schema/site-document';
import { escapeAttr, escapeHtml, safeUrl } from '../html.util';
import { RenderContext } from '../types';

/**
 * The one fixed template.
 *
 * Every academy's published page is a literal reproduction of the hand-authored
 * reference design (structure, section order, every animation) — the only thing
 * that varies is the brand colour pair in `doc.theme.primary` / `.accent`. There
 * is no pattern registry, no per-section layout choice, nothing left for a
 * model to design: this function is pure and total, the same way `compile.ts`
 * is for the composition engine, except here there is exactly one page to emit.
 */

type LT = { ar: string; en: string };
const text = (lt: LT | undefined, fallback = ''): string => {
  const v = (lt?.ar?.trim() || lt?.en?.trim() || fallback).toString();
  return escapeHtml(v);
};
const raw = (lt: LT | undefined, fallback = ''): string => (lt?.ar?.trim() || lt?.en?.trim() || fallback).toString();

function findBlock<T extends SiteBlock['type']>(
  blocks: SiteBlock[],
  type: T,
): Extract<SiteBlock, { type: T }> | undefined {
  return blocks.find((b) => b.type === type) as Extract<SiteBlock, { type: T }> | undefined;
}

const NUM = ['01', '02', '03', '04', '05', '06', '07', '08'];

export function renderFixedSite(doc: SiteDocument, ctx: RenderContext): string {
  const { blocks } = doc;
  const slug = ctx.slug;
  const tk = paletteTokens(doc.theme.primary, doc.theme.accent);

  const hero = findBlock(blocks, 'hero');
  const about = findBlock(blocks, 'about');
  const toolkit = findBlock(blocks, 'toolkit');
  const credentials = findBlock(blocks, 'credentials');
  const gallery = findBlock(blocks, 'gallery');
  const process = findBlock(blocks, 'process');
  const faq = findBlock(blocks, 'faq');
  const contact = findBlock(blocks, 'contact');
  const quote = findBlock(blocks, 'quote');

  const socials = contact?.socials ?? [];
  const socialUrl = (platform: string) => safeUrl(socials.find((s) => s.platform.toLowerCase() === platform)?.url);
  const ytUrl = socialUrl('youtube');
  const fbUrl = socialUrl('facebook');
  const waUrl = socialUrl('whatsapp');

  const logoUrl = doc.theme.logoMediaId ? ctx.media(doc.theme.logoMediaId)?.url : undefined;
  const heroPhotoId = hero && 'mediaId' in hero ? hero.mediaId : undefined;
  const heroPhotoUrl = heroPhotoId ? ctx.media(heroPhotoId)?.url : undefined;

  const galleryMedia = (gallery?.mediaIds ?? [])
    .map((id) => ({ id, m: ctx.media(id) }))
    .filter((x): x is { id: string; m: NonNullable<ReturnType<RenderContext['media']>> } => !!x.m);
  // The about photo is simply the first gallery shot — teachers already upload
  // one, and a dedicated slot for the same purpose would be one more thing to
  // fill in for no visible difference.
  const aboutPhotoUrl = galleryMedia[0]?.m.url || heroPhotoUrl;

  const brandName = escapeHtml(ctx.academyName);
  const brandSmall = escapeHtml(raw(hero?.subheadline).split(/\s+/).slice(0, 4).join(' '));

  const navLinks: string[] = [];
  if (about) navLinks.push(navLink('about', 'نبذة'));
  if (credentials) navLinks.push(navLink('credentials', 'الإنجازات'));
  navLinks.push('<a href="#courses" data-section="courses" id="navCoursesLink" hidden>الكورسات</a>');
  if (gallery && galleryMedia.length) navLinks.push(navLink('gallery', 'المعرض'));
  if (process || faq) navLinks.push(navLink('journey', 'الرحلة'));

  const secondaryHref = gallery && galleryMedia.length ? '#gallery' : credentials ? '#credentials' : '#about';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(doc.seo?.title, ctx.academyName)}</title>
<script>
(function(){
  try{
    /* One key for the whole platform, so turning this page dark and then
       signing in does not hand the reader a white console. The old per-academy
       key is still read once, so nobody loses a choice they already made. */
    var saved=localStorage.getItem('darsly-color-mode')
      ||localStorage.getItem(${JSON.stringify(slug + '-theme')});
    var wantsDark=saved?saved==='dark':(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme',wantsDark?'dark':'light');
  }catch(e){}
})();
</script>
${doc.seo?.description ? `<meta name="description" content="${text(doc.seo.description)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=El+Messiri:wght@500;600;700;800&family=Tajawal:wght@300;400;500;700;800&display=swap" rel="stylesheet">
<style>${css(tk)}</style>
</head>
<body>

${SPRITE}

<div class="progress-bar"><i id="progressFill"></i></div>
<div class="blobs" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<div class="dots" aria-hidden="true"></div>

<nav class="nav" id="nav">
  <div class="wrap">
    <a class="brand" href="#top">
      ${logoUrl ? `<span class="brand-mark"><img src="${escapeAttr(logoUrl)}" alt=""></span>` : ''}
      <span>${brandName}${brandSmall ? `<small>${brandSmall}</small>` : ''}</span>
    </a>
    <div class="nav-links" id="navLinks">
      <span class="nav-indicator" id="navIndicator" aria-hidden="true"></span>
      ${navLinks.join('\n      ')}
    </div>
    <div class="nav-cta">
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="تبديل الوضع الداكن">
        <svg class="icon"><use href="#i-moon" id="themeIconUse"/></svg>
      </button>
      <a class="nav-login" href="/login?academy=${escapeAttr(slug)}" target="_top">تسجيل الدخول</a>
      <a class="btn btn-primary" href="/register?academy=${escapeAttr(slug)}" target="_top">سجّل الآن</a>
    </div>
  </div>
</nav>

<main id="top">

${heroSection(hero, heroPhotoUrl, ytUrl, fbUrl, secondaryHref, slug)}
${about ? aboutSection(about, toolkit, aboutPhotoUrl) : ''}
${credentials ? credentialsSection(credentials) : ''}
${coursesSection()}
${gallery && galleryMedia.length ? gallerySection(galleryMedia, quote) : ''}
${process || faq ? journeySection(process, faq) : ''}
${contactSection(contact, ytUrl, fbUrl, slug)}

</main>

<footer>${brandName}</footer>

${waUrl ? `<a class="fab" href="${escapeAttr(waUrl)}" target="_blank" rel="noopener noreferrer" aria-label="تواصل عبر واتساب"><svg class="icon"><use href="#i-wa"/></svg></a>` : ''}

<div class="lightbox" id="lightbox">
  <button class="lightbox-close" id="lbClose" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button>
  <button class="lightbox-nav lightbox-prev" id="lbPrev" aria-label="السابق"><svg class="icon"><use href="#i-arrow" style="transform:scaleX(-1)"/></svg></button>
  <button class="lightbox-nav lightbox-next" id="lbNext" aria-label="التالي"><svg class="icon"><use href="#i-arrow"/></svg></button>
  <div class="lightbox-stage" id="lbStage"></div>
</div>

<script>${clientScript(slug)}</script>
</body>
</html>`;
}

function navLink(section: string, label: string): string {
  return `<a href="#${section}" data-section="${section}">${label}</a>`;
}

function heroSection(
  hero: Extract<SiteBlock, { type: 'hero' }> | undefined,
  photoUrl: string | undefined,
  ytUrl: string,
  fbUrl: string,
  secondaryHref: string,
  slug: string,
): string {
  const headline = text(hero?.headline, 'مرحبًا بك');
  const lead = text(hero?.subheadline);
  const cta = text(hero?.ctaLabel, 'سجّل الآن');
  const follow = ytUrl || fbUrl;
  return `<section class="hero" id="hero">
  <div class="wrap">
    <div>
      <span class="eyebrow hero-in"><svg class="icon"><use href="#i-star"/></svg> التسجيل متاح الآن</span>
      <h1 class="hero-in"><span class="grad-text">${headline}</span></h1>
      ${lead ? `<p class="lead hero-in">${lead}</p>` : ''}
      <div class="actions hero-in">
        <a class="btn btn-primary" href="/register?academy=${escapeAttr(slug)}" target="_top">${cta} <svg class="icon arrow"><use href="#i-arrow"/></svg></a>
        <a class="btn btn-ghost" href="${secondaryHref}">اعرف أكتر</a>
      </div>
      ${follow ? `<div class="follow hero-in">
        <span>تابعني على</span>
        <span class="links">
          ${ytUrl ? `<a class="social-btn yt" href="${escapeAttr(ytUrl)}" target="_blank" rel="noopener noreferrer" aria-label="يوتيوب"><svg class="icon"><use href="#i-yt"/></svg></a>` : ''}
          ${fbUrl ? `<a class="social-btn fb" href="${escapeAttr(fbUrl)}" target="_blank" rel="noopener noreferrer" aria-label="فيسبوك"><svg class="icon"><use href="#i-fb"/></svg></a>` : ''}
        </span>
      </div>` : ''}
    </div>
    ${photoUrl ? `<div class="hero-photo hero-in" id="heroPhoto">
      <div class="hero-photo-ring" aria-hidden="true"></div>
      <div class="hero-photo-frame" id="tiltFrame">
        <img src="${escapeAttr(photoUrl)}" alt="">
      </div>
      <span class="chip chip-1"><svg class="icon"><use href="#i-cap"/></svg> تعلّم أونلاين</span>
      <span class="chip chip-2"><svg class="icon"><use href="#i-book"/></svg> متابعة مستمرة</span>
      <span class="chip chip-3"><svg class="icon"><use href="#i-star"/></svg> دعم على مدار العام</span>
    </div>` : ''}
  </div>
</section>`;
}

function aboutSection(
  about: Extract<SiteBlock, { type: 'about' }>,
  toolkit: Extract<SiteBlock, { type: 'toolkit' }> | undefined,
  photoUrl: string | undefined,
): string {
  const paragraphs = raw(about.body)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('\n      ');
  const tags = (toolkit?.items ?? []).map((it) => (typeof it === 'string' ? it : it.ar || it.en));
  const doubled = tags.length ? [...tags, ...tags] : [];
  return `<section class="section about" id="about">
  <div class="wrap">
    <div class="about-text reveal">
      <span class="eyebrow">نبذة</span>
      <h2>${text(about.heading, 'نبذة عننا')}</h2>
      ${paragraphs}
      ${doubled.length ? `<div class="toolkit-label">محاور المتابعة</div>
      <div class="marquee-wrap">
        <div class="marquee-track">
          ${doubled.map((t) => `<span class="tag"><svg class="icon"><use href="#i-book"/></svg> ${escapeHtml(t)}</span>`).join('\n          ')}
        </div>
      </div>` : ''}
    </div>
    ${photoUrl ? `<div class="about-media reveal">
      <div class="about-media-ring" aria-hidden="true"></div>
      <div class="about-media-frame">
        <img src="${escapeAttr(photoUrl)}" alt="">
      </div>
    </div>` : ''}
  </div>
</section>`;
}

function credentialsSection(credentials: Extract<SiteBlock, { type: 'credentials' }>): string {
  const items = credentials.items.slice(0, 6);
  return `<section class="section soft" id="credentials">
  <div class="wrap">
    <div class="section-head center reveal">
      <span class="eyebrow">الإنجازات</span>
      <h2>${text(credentials.heading, 'ليه تتابع معايا؟')}</h2>
    </div>
    <div class="cred-grid stagger">
      ${items
        .map(
          (it, i) =>
            `<div class="cred-card glow"><span class="cred-num">${NUM[i]}</span><p>${escapeHtml(typeof it === 'string' ? it : it.ar || it.en)}</p></div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>`;
}

function coursesSection(): string {
  return `<section class="section courses-hidden" id="courses">
  <div class="wrap">
    <div class="section-head center reveal">
      <span class="eyebrow">الكورسات</span>
      <h2>الكورسات المتاحة دلوقتي</h2>
    </div>
    <div class="course-grid stagger" id="courseGrid"></div>
  </div>
</section>`;
}

function gallerySection(
  media: { id: string; m: { url: string; width?: number | null; height?: number | null; mimeType?: string | null } }[],
  quote: Extract<SiteBlock, { type: 'quote' }> | undefined,
): string {
  const tiles = media.map(({ m }) => {
    const isVideo = (m.mimeType ?? '').startsWith('video/');
    const tall = !!(m.width && m.height && m.height > m.width);
    const cls = `gal-item${tall ? ' tall' : ''}`;
    const src = escapeAttr(m.url);
    if (isVideo) {
      return `<div class="${cls}" data-type="video" data-src="${src}">
        <video src="${src}" muted loop autoplay playsinline preload="metadata"></video>
        <span class="gal-play"><svg class="icon"><use href="#i-play"/></svg></span>
        <div class="gal-overlay"><span class="gal-expand"><svg class="icon"><use href="#i-expand"/></svg></span></div>
      </div>`;
    }
    return `<div class="${cls}" data-type="image" data-src="${src}">
        <img src="${src}" alt="" loading="lazy">
        <div class="gal-overlay"><span class="gal-expand"><svg class="icon"><use href="#i-expand"/></svg></span></div>
      </div>`;
  });
  if (quote) {
    const q = `<div class="gal-quote"><span class="mark">”</span><p>${text(quote.text)}</p>${
      raw(quote.attribution) ? `<cite>${text(quote.attribution)}</cite>` : ''
    }</div>`;
    tiles.splice(Math.min(2, tiles.length), 0, q);
  }
  return `<section class="section" id="gallery">
  <div class="wrap">
    <div class="section-head center reveal">
      <span class="eyebrow">المعرض</span>
      <h2>لحظات من الرحلة</h2>
    </div>
    <div class="gal-grid stagger" id="galGrid">
      ${tiles.join('\n      ')}
    </div>
  </div>
</section>`;
}

function journeySection(
  process: Extract<SiteBlock, { type: 'process' }> | undefined,
  faq: Extract<SiteBlock, { type: 'faq' }> | undefined,
): string {
  const steps = (process?.steps ?? []).slice(0, 3);
  const items = (faq?.items ?? []).slice(0, 3);
  return `<section class="section soft" id="journey">
  <div class="wrap">
    ${steps.length ? `<div class="section-head center reveal">
      <span class="eyebrow">الطريقة</span>
      <h2>إزاي تسير الرحلة معايا؟</h2>
    </div>
    <div class="steps stagger">
      ${steps
        .map((s, i) => `<div class="step glow"><span class="step-n">${NUM[i]}</span><h3>${text(s.title)}</h3><p>${text(s.body)}</p></div>`)
        .join('\n      ')}
    </div>` : ''}
    ${items.length ? `<div class="faq-inner-head reveal">أسئلة شائعة</div>
    <div class="faq-list reveal">
      ${items
        .map(
          (it) => `<div class="faq-item">
        <button class="faq-q" type="button">${text(it.q)} <svg class="icon"><use href="#i-chevron"/></svg></button>
        <div class="faq-a-wrap"><div class="faq-a-inner"><p class="faq-a">${text(it.a)}</p></div></div>
      </div>`,
        )
        .join('\n      ')}
    </div>` : ''}
  </div>
</section>`;
}

function contactSection(
  contact: Extract<SiteBlock, { type: 'contact' }> | undefined,
  ytUrl: string,
  fbUrl: string,
  slug: string,
): string {
  return `<section class="section" id="contact">
  <div class="wrap">
    <div class="contact-band reveal">
      <h2>جاهز تبدأ رحلتك؟</h2>
      <p>سجّل دلوقتي على منصة درسلي، وتابعنا عشان تبقى على اطلاع بكل جديد.</p>
      <div class="actions">
        <a class="btn btn-on-brand" href="/register?academy=${escapeAttr(slug)}" target="_top"><svg class="icon"><use href="#i-arrow"/></svg> سجّل كطالب الآن</a>
        ${ytUrl ? `<a class="btn btn-on-brand" href="${escapeAttr(ytUrl)}" target="_blank" rel="noopener noreferrer"><svg class="icon"><use href="#i-yt"/></svg> يوتيوب</a>` : ''}
        ${fbUrl ? `<a class="btn btn-on-brand" href="${escapeAttr(fbUrl)}" target="_blank" rel="noopener noreferrer"><svg class="icon"><use href="#i-fb"/></svg> فيسبوك</a>` : ''}
      </div>
    </div>
  </div>
</section>`;
}

const SPRITE = `<svg style="display:none">
  <symbol id="i-cap" viewBox="0 0 24 24"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/></symbol>
  <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 2 2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6L12 2Z"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4v16l14-8L7 4Z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-expand" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-wa" viewBox="0 0 24 24"><path d="M17.6 6.3A8.9 8.9 0 0 0 3.1 16.9L2 22l5.3-1.4A8.9 8.9 0 0 0 12 21.9a9 9 0 0 0 5.6-15.6ZM12 20.2a7.3 7.3 0 0 1-3.8-1l-.3-.2-3.1.8.8-3-.2-.3a7.4 7.4 0 1 1 6.6 3.7Zm4-5.4c-.2-.1-1.3-.6-1.5-.7s-.4-.1-.5.1-.6.7-.7.9-.3.2-.5.1a6 6 0 0 1-1.8-1.1 6.7 6.7 0 0 1-1.2-1.6c-.1-.2 0-.4.1-.5l.4-.4a1.7 1.7 0 0 0 .2-.4.4.4 0 0 0 0-.4c-.1-.1-.5-1.2-.7-1.7s-.4-.4-.5-.4h-.4a.9.9 0 0 0-.6.3 2.6 2.6 0 0 0-.8 1.9 4.6 4.6 0 0 0 1 2.4 10 10 0 0 0 4 3.5c.5.2 1 .4 1.3.5a3 3 0 0 0 1.4.1 2.3 2.3 0 0 0 1.5-1 1.9 1.9 0 0 0 .1-1c0-.2-.2-.2-.4-.3Z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.2 19.8l1.9-1.9M17.9 6.1l1.9-1.9"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.2 14.7A8.6 8.6 0 1 1 9.3 3.8a7 7 0 0 0 10.9 10.9Z"/></symbol>
  <symbol id="i-yt" viewBox="0 0 24 24"><path d="M22 12s0-3.4-.4-5a2.8 2.8 0 0 0-2-2C17.9 4.5 12 4.5 12 4.5s-5.9 0-7.6.5a2.8 2.8 0 0 0-2 2C2 8.6 2 12 2 12s0 3.4.4 5a2.8 2.8 0 0 0 2 2c1.7.5 7.6.5 7.6.5s5.9 0 7.6-.5a2.8 2.8 0 0 0 2-2c.4-1.6.4-5 .4-5Z" fill="currentColor" stroke="none"/><path d="M10 9.2v5.6L15 12l-5-2.8Z" fill="#fff" stroke="none"/></symbol>
  <symbol id="i-fb" viewBox="0 0 24 24"><path d="M14 9h3V6h-3c-2 0-3.5 1.6-3.5 3.5V11H8v3h2.5v6H14v-6h2.6l.4-3h-3v-1.3c0-.5.3-.7.7-.7Z" fill="currentColor" stroke="none"/></symbol>
</svg>`;

function css(tk: { primary: string; accent: string; primaryInk: string; primaryDark: string; accentDark: string }): string {
  return `
:root{
  --bg:#ffffff; --bg-soft:#f6f8ff;
  --ink:#12162b; --ink-soft:#4c5273; --muted:#767c9c;
  --primary:${tk.primary}; --primary-ink:${tk.primaryInk};
  --accent:${tk.accent}; --accent-2:#06b6d4;
  --surface:#f1f4ff; --surface-2:#e8edfe; --line:#e7eaf6;
  --card-bg:#ffffff; --nav-glass:rgba(255,255,255,.82);
  --r-lg:28px; --r-md:20px; --r-sm:14px; --r-pill:999px;
  --sh-sm:0 10px 26px -16px rgba(31,45,120,.22);
  --sh-md:0 24px 54px -22px rgba(31,45,120,.30);
  --sh-lg:0 34px 80px -28px rgba(31,45,120,.38);
  --font-h:'El Messiri','Tajawal',sans-serif;
  --font-b:'Tajawal',sans-serif;
  --wrap:1500px;
  --nav-h:92px;
}
[data-theme="dark"]{
  --bg:#0a0d18; --bg-soft:#101426;
  --ink:#f2f4fc; --ink-soft:#b7bcd8; --muted:#7d84a6;
  --primary:${tk.primaryDark}; --primary-ink:${tk.primaryInk};
  --accent:${tk.accentDark}; --accent-2:#2dd9f0;
  --surface:#131829; --surface-2:#1a2038; --line:#2b3255;
  --card-bg:#131829; --nav-glass:rgba(10,13,24,.78);
  --sh-sm:0 10px 26px -14px rgba(0,0,0,.55);
  --sh-md:0 24px 54px -20px rgba(0,0,0,.6);
  --sh-lg:0 34px 80px -26px rgba(0,0,0,.65);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;font-size:17px}
body{margin:0;background:var(--bg);color:var(--ink-soft);font-family:var(--font-b);line-height:1.7;-webkit-font-smoothing:antialiased;overflow-x:hidden}
img,video{max-width:100%;display:block}
h1,h2,h3{font-family:var(--font-h);color:var(--ink);margin:0;line-height:1.18}
a{color:inherit;text-decoration:none}
button{font-family:inherit;cursor:pointer}
.wrap{width:100%;max-width:var(--wrap);margin-inline:auto;padding-inline:24px}
.eyebrow{display:inline-flex;align-items:center;gap:.5em;font-family:var(--font-h);font-weight:700;font-size:.82rem;letter-spacing:.06em;color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent);padding:.5em 1.1em;border-radius:var(--r-pill);margin-bottom:1.1em}
.grad-text{background-image:linear-gradient(96deg,var(--primary),var(--accent) 60%,var(--primary));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sheen 7s ease-in-out infinite}
@keyframes sheen{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
.section-head{max-width:640px;margin-bottom:2.6em}
.section-head.center{margin-inline:auto;text-align:center}
.section-head h2{font-size:clamp(1.7rem,3.2vw,2.5rem);font-weight:700}
.section{position:relative;padding-block:min(8vw,84px)}
.section.soft{background:var(--surface)}
.icon{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.progress-bar{position:fixed;top:0;inset-inline:0;height:3px;z-index:80;pointer-events:none}
.progress-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--primary));transition:width .08s linear}
.btn{position:relative;display:inline-flex;align-items:center;gap:.6em;font-family:var(--font-h);font-weight:700;font-size:1rem;padding:1em 1.9em;border-radius:var(--r-pill);border:0;transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s;overflow:hidden}
.btn-primary{background:linear-gradient(96deg,var(--primary),var(--accent));color:#fff;box-shadow:var(--sh-sm)}
.btn-primary:hover{transform:translateY(-3px);box-shadow:var(--sh-md)}
.btn-primary::after{content:"";position:absolute;top:0;inset-inline-start:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.4),transparent);transform:skewX(-18deg);transition:inset-inline-start .55s cubic-bezier(.2,.7,.2,1)}
.btn-primary:hover::after{inset-inline-start:120%}
.btn-ghost{background:var(--card-bg);color:var(--ink);border:1.5px solid var(--line);box-shadow:var(--sh-sm)}
.btn-ghost:hover{transform:translateY(-3px);border-color:var(--primary);color:var(--primary)}
.btn-on-brand{background:#fff;color:var(--primary-ink)}
.btn-on-brand:hover{transform:translateY(-3px);box-shadow:0 20px 40px -18px rgba(0,0,0,.35)}
.btn .icon{width:18px;height:18px;transition:transform .25s}
[dir=rtl] .btn:hover .icon.arrow{transform:translateX(-4px)}
.nav{position:fixed;top:0;inset-inline:0;z-index:60;height:var(--nav-h);display:flex;align-items:center;transition:background .3s,box-shadow .3s,backdrop-filter .3s}
.nav.stuck{background:var(--nav-glass);backdrop-filter:blur(16px) saturate(160%);box-shadow:0 8px 30px -22px rgba(20,30,80,.35)}
.nav .wrap{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:20px}
.brand{display:flex;align-items:center;gap:12px;font-family:var(--font-h);font-weight:700;font-size:1.15rem;justify-self:end}
.brand-mark{width:42px;height:42px;border-radius:14px;overflow:hidden;box-shadow:var(--sh-sm);flex:none}
.brand-mark img{width:100%;height:100%;object-fit:cover}
.brand small{display:block;font-family:var(--font-b);font-weight:400;font-size:.72rem;color:var(--muted)}
.nav-links{position:relative;display:flex;align-items:center;justify-content:center;gap:6px}
.nav-links a{position:relative;z-index:1;padding:.7em 1.35em;border-radius:var(--r-pill);font-weight:700;font-size:1rem;color:var(--ink-soft);transition:color .25s}
.nav-links a:hover{color:var(--primary)}
.nav-links a.active{color:var(--primary);font-weight:700}
.nav-indicator{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:var(--r-pill);background:var(--surface);opacity:0;transition:transform .4s cubic-bezier(.2,.7,.2,1),width .4s cubic-bezier(.2,.7,.2,1),opacity .25s;z-index:0;pointer-events:none}
.nav-links:hover .nav-indicator,.nav-indicator.show{opacity:1}
.nav-cta{display:flex;align-items:center;gap:18px;justify-self:start}
.nav-login{font-family:var(--font-h);font-weight:700;font-size:.98rem;color:var(--ink-soft);transition:color .2s}
.theme-toggle{width:42px;height:42px;flex:none;border-radius:50%;display:grid;place-items:center;background:var(--card-bg);border:1px solid var(--line);color:var(--ink-soft);box-shadow:var(--sh-sm);transition:color .2s,border-color .2s,transform .2s}
.theme-toggle:hover{color:var(--primary);border-color:var(--primary);transform:rotate(14deg)}
.theme-toggle .icon{width:19px;height:19px}
.nav-login:hover{color:var(--primary)}
@media(max-width:900px){.nav-links{display:none}.nav-login{display:none}.nav .wrap{grid-template-columns:auto auto}}
.blobs{position:fixed;inset:0;z-index:-2;overflow:hidden;pointer-events:none}
.blobs i{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.55;will-change:transform}
.blobs i:nth-child(1){width:46vw;height:46vw;top:-14vw;inset-inline-start:-10vw;background:radial-gradient(circle,var(--primary),transparent 70%);animation:drift1 24s ease-in-out infinite}
.blobs i:nth-child(2){width:38vw;height:38vw;top:2vw;inset-inline-end:-10vw;background:radial-gradient(circle,var(--accent),transparent 70%);animation:drift2 28s ease-in-out infinite}
.blobs i:nth-child(3){width:34vw;height:34vw;top:60vw;inset-inline-start:28vw;background:radial-gradient(circle,var(--accent-2),transparent 70%);opacity:.35;animation:drift3 32s ease-in-out infinite}
.blobs i:nth-child(4){width:22vw;height:22vw;top:110vw;inset-inline-end:6vw;background:radial-gradient(circle,var(--primary),transparent 70%);opacity:.3;animation:drift2 36s ease-in-out infinite}
@keyframes drift1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(4vw,5vw) scale(1.12)}}
@keyframes drift2{0%,100%{transform:translate(0,0) scale(1.05)}50%{transform:translate(-5vw,6vw) scale(.92)}}
@keyframes drift3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(3vw,-4vw) scale(1.08)}}
.dots{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;background-image:radial-gradient(color-mix(in srgb,var(--primary) 14%,transparent) 1.4px,transparent 1.4px);background-size:28px 28px;mask-image:radial-gradient(70% 60% at 50% 0%,#000,transparent 75%)}
@media(prefers-reduced-motion:reduce){.blobs i{animation:none}}
.glow{position:relative}
.glow::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;transition:opacity .35s;border-radius:inherit;background:radial-gradient(240px circle at var(--mx,50%) var(--my,50%),rgba(124,58,237,.16),transparent 62%)}
.glow:hover::after{opacity:1}
.hero{padding-block:calc(var(--nav-h) + 56px) 30px;position:relative}
.hero .wrap{display:grid;gap:56px;grid-template-columns:1fr;align-items:center}
@media(min-width:960px){.hero .wrap{grid-template-columns:1.08fr .92fr}}
.hero h1{font-size:clamp(2.3rem,5.4vw,3.6rem);font-weight:800;letter-spacing:-.01em}
.hero .lead{margin-top:1.1em;font-size:1.12rem;max-width:48ch;color:var(--ink-soft)}
.hero .actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:2em}
.hero .follow{display:flex;align-items:center;gap:14px;margin-top:2.4em;font-size:.9rem;color:var(--muted)}
.hero .follow .links{display:flex;gap:10px}
.social-btn{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:var(--card-bg);border:1px solid var(--line);box-shadow:var(--sh-sm);transition:.25s}
.social-btn:hover{transform:translateY(-3px) scale(1.06);color:#fff}
.social-btn.yt:hover{background:#FF0000}
.social-btn.fb:hover{background:#1877F2}
.social-btn .icon{width:18px;height:18px}
.hero-photo{position:relative;justify-self:center;perspective:1200px;will-change:transform}
.hero-photo-ring{position:absolute;inset:-18px;border-radius:58px;border:2px dashed color-mix(in srgb,var(--primary) 35%,transparent);animation:spin 44s linear infinite;pointer-events:none}
@keyframes spin{to{transform:rotate(360deg)}}
.hero-photo-frame{position:relative;width:min(420px,84vw);border-radius:40px;overflow:hidden;box-shadow:var(--sh-lg);background:var(--surface);transition:transform .3s cubic-bezier(.2,.7,.2,1);transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg))}
.hero-photo-frame img{width:100%;height:auto;object-fit:cover}
.chip{position:absolute;display:flex;align-items:center;gap:.6em;background:var(--card-bg);border-radius:var(--r-pill);padding:.8em 1.2em;box-shadow:var(--sh-md);font-family:var(--font-h);font-weight:700;font-size:.86rem;animation:bob 5s ease-in-out infinite}
.chip .icon{width:20px;height:20px;color:var(--primary)}
.chip-1{top:6%;inset-inline-start:-8%;animation-delay:.2s}
.chip-2{bottom:14%;inset-inline-end:-10%;animation-delay:1.1s;color:var(--accent)}
.chip-2 .icon{color:var(--accent)}
.chip-3{bottom:-4%;inset-inline-start:14%;animation-delay:2s;background:linear-gradient(96deg,var(--primary),var(--accent));color:#fff}
.chip-3 .icon{color:#fff}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@media(max-width:640px){.chip{font-size:.74rem;padding:.6em .95em}.chip-1{top:2%}.chip-3{display:none}}
.hero-in{opacity:0;transform:translateY(22px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}
.hero-in.in{opacity:1;transform:none}
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1)}
.reveal.in{opacity:1;transform:none}
.stagger>*{opacity:0;transform:translateY(22px) scale(.97);transition:opacity .55s cubic-bezier(.2,.7,.2,1),transform .55s cubic-bezier(.2,.7,.2,1)}
.stagger.in>*{opacity:1;transform:none}
.stagger.in>*:nth-child(1){transition-delay:.03s}.stagger.in>*:nth-child(2){transition-delay:.08s}
.stagger.in>*:nth-child(3){transition-delay:.13s}.stagger.in>*:nth-child(4){transition-delay:.18s}
.stagger.in>*:nth-child(5){transition-delay:.23s}.stagger.in>*:nth-child(6){transition-delay:.28s}
.stagger.in>*:nth-child(7){transition-delay:.33s}
@media(prefers-reduced-motion:reduce){.reveal,.stagger>*,.hero-in{opacity:1!important;transform:none!important;animation:none!important;transition:none!important}}
.about .wrap{display:grid;gap:64px;grid-template-columns:1fr}
@media(min-width:900px){.about .wrap{grid-template-columns:.92fr 1.08fr;align-items:center}}
.about-text{min-width:0;text-align:center;display:flex;flex-direction:column;align-items:center}
.about-text .eyebrow{margin-inline:auto}
.about-text h2{font-size:clamp(1.7rem,2.8vw,2.3rem)}
.about-media{position:relative;justify-self:center}
.about-media-ring{position:absolute;inset:-16px;border-radius:calc(var(--r-lg) + 16px);border:2px dashed color-mix(in srgb,var(--accent) 38%,transparent);pointer-events:none}
.about-media-frame{position:relative;border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-lg);max-width:440px;width:100%}
.about-media-frame img{transition:transform .6s cubic-bezier(.2,.7,.2,1)}
.about-media-frame:hover img{transform:scale(1.05)}
.about p{margin:0 0 1.1em;font-size:1.04rem;max-width:56ch}
.about p:last-child{margin-bottom:0}
.toolkit-label{margin-top:2em;font-family:var(--font-h);font-weight:700;color:var(--ink);font-size:1.02rem}
.marquee-wrap{overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);margin-top:.9em;width:100%;min-width:0}
.marquee-track{display:flex;gap:12px;width:max-content;animation:marquee 24s linear infinite}
.marquee-wrap:hover .marquee-track{animation-play-state:paused}
@keyframes marquee{to{transform:translateX(-50%)}}
[dir=rtl] .marquee-track{animation-direction:reverse}
.tag{display:inline-flex;align-items:center;gap:.55em;padding:.75em 1.3em;border-radius:var(--r-pill);background:var(--card-bg);border:1px solid var(--line);font-family:var(--font-h);font-weight:600;box-shadow:var(--sh-sm);white-space:nowrap;transition:.25s}
.tag .icon{width:15px;height:15px;color:var(--primary)}
.tag:hover{transform:translateY(-4px);background:linear-gradient(96deg,var(--primary),var(--accent));color:#fff;border-color:transparent}
.tag:hover .icon{color:#fff}
.cred-grid{display:grid;gap:18px;grid-template-columns:1fr}
@media(min-width:680px){.cred-grid{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1400px){.cred-grid{grid-template-columns:repeat(3,1fr)}}
.cred-card{background:var(--card-bg);border:1px solid var(--line);border-radius:var(--r-md);padding:1.6em;display:flex;gap:1.1em;box-shadow:var(--sh-sm);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s}
.cred-card:hover{transform:translateY(-6px);box-shadow:var(--sh-md)}
.cred-num{flex:none;width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(150deg,var(--primary),var(--accent));color:#fff;font-family:var(--font-h);font-weight:700}
.cred-card p{margin:0;font-weight:500;color:var(--ink)}
.courses-hidden{display:none}
.course-grid{display:grid;gap:22px;grid-template-columns:1fr}
@media(min-width:640px){.course-grid{grid-template-columns:repeat(2,1fr)}}
@media(min-width:980px){.course-grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:1500px){.course-grid{grid-template-columns:repeat(4,1fr)}}
.course-card{display:flex;flex-direction:column;background:var(--card-bg);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;box-shadow:var(--sh-sm);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s}
.course-card:hover{transform:translateY(-6px);box-shadow:var(--sh-md)}
.course-thumb{aspect-ratio:16/9;background:linear-gradient(150deg,var(--surface),var(--surface-2));display:grid;place-items:center;color:var(--primary)}
.course-thumb img{width:100%;height:100%;object-fit:cover}
.course-thumb .icon{width:34px;height:34px;opacity:.55}
.course-body{padding:1.3em 1.4em;display:flex;flex-direction:column;gap:.6em;flex:1}
.course-body h3{font-size:1.05rem;line-height:1.4}
.course-price{margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:.8em}
.course-price .amount{font-family:var(--font-h);font-weight:800;font-size:1.15rem;color:var(--primary)}
.course-price .free{font-family:var(--font-h);font-weight:800;color:#16A34A}
.course-price .go{display:inline-flex;align-items:center;gap:.3em;font-weight:700;font-size:.9rem;color:var(--accent)}
.gal-grid{display:grid;grid-template-columns:repeat(2,1fr);grid-auto-rows:150px;grid-auto-flow:dense;gap:14px}
@media(min-width:640px){.gal-grid{grid-template-columns:repeat(3,1fr);grid-auto-rows:170px;gap:16px}}
@media(min-width:1080px){.gal-grid{grid-template-columns:repeat(4,1fr)}}
.gal-item{position:relative;border-radius:var(--r-md);overflow:hidden;cursor:pointer;box-shadow:var(--sh-sm)}
.gal-item.tall{grid-row:span 2}
.gal-item img,.gal-item video{width:100%;height:100%;object-fit:cover;transition:transform .55s cubic-bezier(.2,.7,.2,1);will-change:transform}
.gal-item video{background:linear-gradient(135deg,var(--surface),var(--surface-2))}
.gal-item:hover img,.gal-item:hover video{transform:scale(1.07)}
.gal-overlay{position:absolute;inset:0;display:flex;align-items:flex-end;padding:14px;background:linear-gradient(0deg,rgba(10,14,40,.7),transparent 55%);opacity:0;transition:opacity .3s}
.gal-item:hover .gal-overlay{opacity:1}
.gal-expand{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;margin-inline-start:auto;color:#12162b}
.gal-expand .icon{width:17px;height:17px}
.gal-play{position:absolute;top:12px;inset-inline-start:12px;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;color:var(--primary)}
.gal-play .icon{width:14px;height:14px}
.gal-quote{grid-row:span 2;border-radius:var(--r-md);background:linear-gradient(150deg,var(--primary),var(--accent));color:#fff;padding:1.9em 1.5em;display:flex;flex-direction:column;justify-content:center;box-shadow:var(--sh-md)}
.gal-quote .mark{font-family:var(--font-h);font-size:2.6rem;line-height:.6;opacity:.55;margin-bottom:.3em}
.gal-quote p{margin:0;font-family:var(--font-h);font-weight:600;font-size:1.06rem;line-height:1.55}
.gal-quote cite{display:block;margin-top:1em;font-style:normal;font-size:.85rem;opacity:.85}
.steps{display:grid;gap:26px;grid-template-columns:1fr;position:relative;margin-bottom:3.4em}
@media(min-width:820px){.steps{grid-template-columns:repeat(3,1fr)}
.steps::before{content:"";position:absolute;top:26px;inset-inline:12%;height:2px;background:repeating-linear-gradient(90deg,var(--line) 0 10px,transparent 10px 18px);z-index:0}}
.step{position:relative;z-index:1;background:var(--card-bg);border:1px solid var(--line);border-radius:var(--r-md);padding:1.7em;box-shadow:var(--sh-sm);transition:transform .3s,box-shadow .3s}
.step:hover{transform:translateY(-6px);box-shadow:var(--sh-md)}
.step-n{width:50px;height:50px;border-radius:16px;display:grid;place-items:center;background:var(--surface);color:var(--primary);font-family:var(--font-h);font-weight:800;font-size:1.25rem;margin-bottom:1em}
.step h3{font-size:1.1rem;margin-bottom:.4em}
.step p{margin:0;font-size:.95rem}
.faq-inner-head{font-family:var(--font-h);font-weight:700;font-size:1.05rem;color:var(--ink);text-align:center;margin-bottom:1.2em}
.faq-list{max-width:800px;margin-inline:auto;display:flex;flex-direction:column;gap:14px}
.faq-item{background:var(--card-bg);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;box-shadow:var(--sh-sm)}
.faq-q{width:100%;display:flex;align-items:center;justify-content:space-between;gap:1em;padding:1.2em 1.5em;background:none;border:0;text-align:start;font-family:var(--font-h);font-weight:700;font-size:1rem;color:var(--ink)}
.faq-q .icon{color:var(--primary);width:19px;height:19px;flex:none;transition:transform .3s}
.faq-item.open .faq-q .icon{transform:rotate(180deg)}
.faq-a-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.7,.2,1)}
.faq-item.open .faq-a-wrap{grid-template-rows:1fr}
.faq-a-inner{overflow:hidden}
.faq-a{padding:0 1.5em 1.3em;color:var(--ink-soft)}
.contact-band{position:relative;overflow:hidden;background:linear-gradient(120deg,var(--primary),var(--accent));color:#fff;border-radius:var(--r-lg);margin-inline:24px;padding:min(8vw,68px) min(6vw,48px);text-align:center}
.contact-band::before,.contact-band::after{content:"";position:absolute;border-radius:50%;background:rgba(255,255,255,.12)}
.contact-band::before{width:360px;height:360px;top:-160px;inset-inline-start:-100px;animation:drift1 20s ease-in-out infinite}
.contact-band::after{width:260px;height:260px;bottom:-140px;inset-inline-end:-60px;animation:drift2 24s ease-in-out infinite}
.contact-band h2{color:#fff;font-size:clamp(1.6rem,3.4vw,2.3rem)}
.contact-band p{max-width:56ch;margin:1em auto 0;color:rgba(255,255,255,.9)}
.contact-band .actions{position:relative;display:flex;flex-wrap:wrap;justify-content:center;gap:14px;margin-top:2.2em}
.contact-band .social-btn{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);color:#fff}
.contact-band .social-btn:hover{background:#fff;color:var(--primary-ink)}
footer{padding:44px 24px;text-align:center;color:var(--muted);font-size:.9rem}
.fab{position:fixed;bottom:26px;inset-inline-start:26px;z-index:50;width:58px;height:58px;border-radius:50%;background:#25D366;color:#fff;display:grid;place-items:center;box-shadow:var(--sh-md);border:0;animation:pulse 2.6s ease-in-out infinite;transition:transform .25s}
.fab:hover{transform:scale(1.08)}
.fab .icon{width:28px;height:28px}
@keyframes pulse{0%,100%{box-shadow:var(--sh-md),0 0 0 0 rgba(37,211,102,.4)}50%{box-shadow:var(--sh-md),0 0 0 12px rgba(37,211,102,0)}}
.lightbox{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(8,10,26,.9);padding:5vh 4vw}
.lightbox.open{display:flex}
.lightbox-stage{position:relative;max-width:min(920px,92vw);max-height:88vh;width:100%;opacity:0;transform:scale(.96);transition:opacity .25s,transform .25s}
.lightbox.open .lightbox-stage{opacity:1;transform:none}
.lightbox-stage img,.lightbox-stage video{width:100%;max-height:88vh;object-fit:contain;border-radius:16px;background:#000;margin:0 auto}
.lightbox-close,.lightbox-nav{position:fixed;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;display:grid;place-items:center;border:1px solid rgba(255,255,255,.2);transition:.2s}
.lightbox-close:hover,.lightbox-nav:hover{background:#fff;color:#12162b}
.lightbox-close{top:22px;inset-inline-end:22px}
.lightbox-nav{top:50%;transform:translateY(-50%)}
.lightbox-prev{inset-inline-start:18px}
.lightbox-next{inset-inline-end:18px}
@media(max-width:640px){.lightbox-nav{display:none}}
`;
}

function clientScript(slug: string): string {
  const coursesUrl = JSON.stringify(`/api/v1/a/${slug}/courses`);
  return `
(function(){
  var root=document.documentElement;
  var btn=document.getElementById('themeToggle');
  var iconUse=document.getElementById('themeIconUse');
  var KEY='darsly-color-mode';
  function sync(){
    iconUse.setAttribute('href', root.getAttribute('data-theme')==='dark' ? '#i-sun' : '#i-moon');
  }
  sync();
  btn.addEventListener('click',function(){
    var dark = root.getAttribute('data-theme')!=='dark';
    /* Always written, both ways: an academy whose own palette is dark needs a
       reader to be able to ask for the light end of it, which removing the
       attribute cannot express. */
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    sync();
    try{ localStorage.setItem(KEY, dark ? 'dark' : 'light'); }catch(e){}
  });
})();

(function(){
  var nav=document.getElementById('nav');
  var fill=document.getElementById('progressFill');
  var ticking=false;
  function update(){
    nav.classList.toggle('stuck',window.scrollY>10);
    var h=document.documentElement;
    var scrolled=h.scrollTop||document.body.scrollTop;
    var height=(h.scrollHeight||document.body.scrollHeight)-h.clientHeight;
    fill.style.width=(height>0?(scrolled/height)*100:0)+'%';
    ticking=false;
  }
  document.addEventListener('scroll',function(){
    if(!ticking){requestAnimationFrame(update);ticking=true;}
  },{passive:true});
  update();
})();

(function(){
  var el=document.getElementById('heroPhoto');
  if(!el)return;
  var ticking=false;
  function update(){
    var y=window.scrollY||0;
    if(y<window.innerHeight*1.3){el.style.transform='translateY('+(y*0.06)+'px)';}
    ticking=false;
  }
  document.addEventListener('scroll',function(){
    if(!ticking){requestAnimationFrame(update);ticking=true;}
  },{passive:true});
})();

(function(){
  var el=document.getElementById('tiltFrame');
  if(!el)return;
  el.addEventListener('mousemove',function(e){
    var r=el.getBoundingClientRect();
    var px=(e.clientX-r.left)/r.width-.5, py=(e.clientY-r.top)/r.height-.5;
    el.style.setProperty('--ry',(px*12)+'deg');
    el.style.setProperty('--rx',(-py*12)+'deg');
  });
  el.addEventListener('mouseleave',function(){
    el.style.setProperty('--rx','0deg'); el.style.setProperty('--ry','0deg');
  });
})();

document.querySelectorAll('.glow').forEach(function(el){
  el.addEventListener('mousemove',function(e){
    var r=el.getBoundingClientRect();
    el.style.setProperty('--mx',(e.clientX-r.left)+'px');
    el.style.setProperty('--my',(e.clientY-r.top)+'px');
  });
});

(function(){
  var wrap=document.getElementById('navLinks');
  var indicator=document.getElementById('navIndicator');
  if(!wrap||!indicator)return;
  var links=Array.prototype.slice.call(wrap.querySelectorAll('a'));
  var activeLink=null;

  function moveTo(el){
    if(!el){ indicator.classList.remove('show'); return; }
    var wr=wrap.getBoundingClientRect(), r=el.getBoundingClientRect();
    indicator.style.width=r.width+'px';
    indicator.style.transform='translateX('+(r.left-wr.left)+'px)';
    indicator.classList.add('show');
  }
  function setActive(section){
    links.forEach(function(a){ a.classList.toggle('active',a.dataset.section===section); });
    activeLink=links.filter(function(a){ return a.dataset.section===section; })[0]||null;
    moveTo(activeLink);
  }
  links.forEach(function(a){ a.addEventListener('mouseenter',function(){ moveTo(a); }); });
  wrap.addEventListener('mouseleave',function(){ moveTo(activeLink); });
  window.addEventListener('resize',function(){ moveTo(activeLink); });

  var sections=links.map(function(a){ return document.getElementById(a.dataset.section); }).filter(Boolean);
  if('IntersectionObserver' in window && sections.length){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting)setActive(en.target.id); });
    },{rootMargin:'-40% 0px -50% 0px',threshold:0});
    sections.forEach(function(s){ io.observe(s); });
  }
})();

(function(){
  var els=document.querySelectorAll('.hero-in');
  els.forEach(function(el,i){
    setTimeout(function(){ el.classList.add('in'); }, 60+i*110);
  });
})();

(function(){
  var els=document.querySelectorAll('.reveal,.stagger');
  if(!('IntersectionObserver' in window)){els.forEach(function(e){e.classList.add('in');});return;}
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(en){ if(en.isIntersecting){en.target.classList.add('in'); io.unobserve(en.target);} });
  },{threshold:.15,rootMargin:'0px 0px -8% 0px'});
  els.forEach(function(e){io.observe(e);});
})();

(function(){
  var section=document.getElementById('courses');
  var grid=document.getElementById('courseGrid');
  var navLink=document.getElementById('navCoursesLink');
  if(!section||!grid)return;
  fetch(${coursesUrl}).then(function(r){ return r.ok?r.json():[]; }).then(function(courses){
    if(!Array.isArray(courses)||!courses.length)return;
    grid.innerHTML=courses.map(function(c){
      var price=c.priceCents>0
        ? '<span class="amount">'+(c.priceCents/100).toLocaleString('ar-EG')+' ج.م</span>'
        : '<span class="free">مجانًا</span>';
      var thumb=c.thumbnailUrl
        ? '<img src="'+c.thumbnailUrl+'" alt="" loading="lazy">'
        : '<svg class="icon"><use href="#i-book"/></svg>';
      return '<a class="course-card" href="'+c.url+'" target="_top">'
        +'<span class="course-thumb">'+thumb+'</span>'
        +'<span class="course-body"><h3>'+esc(c.title)+'</h3>'
        +'<span class="course-price">'+price+'<span class="go">التفاصيل <svg class="icon"><use href="#i-arrow"/></svg></span></span>'
        +'</span></a>';
    }).join('');
    section.classList.remove('courses-hidden');
    if(navLink)navLink.hidden=false;
  }).catch(function(){ /* courses just stay hidden — nothing broke */ });
  function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
})();

document.querySelectorAll('.faq-q').forEach(function(btn){
  btn.addEventListener('click',function(){
    var item=btn.closest('.faq-item');
    var wasOpen=item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(function(i){i.classList.remove('open');});
    if(!wasOpen)item.classList.add('open');
  });
});

(function(){
  var items=Array.prototype.slice.call(document.querySelectorAll('.gal-item'));
  var lb=document.getElementById('lightbox'), stage=document.getElementById('lbStage');
  if(!lb||!stage||!items.length)return;
  var idx=0;
  function render(){
    var it=items[idx];
    var type=it.getAttribute('data-type'), src=it.getAttribute('data-src');
    stage.innerHTML = type==='video'
      ? '<video src="'+src+'" controls autoplay playsinline></video>'
      : '<img src="'+src+'" alt="">';
  }
  function open(i){ idx=i; render(); lb.classList.add('open'); document.body.style.overflow='hidden'; }
  function close(){ lb.classList.remove('open'); stage.innerHTML=''; document.body.style.overflow=''; }
  function next(){ idx=(idx+1)%items.length; render(); }
  function prev(){ idx=(idx-1+items.length)%items.length; render(); }
  items.forEach(function(it,i){ it.addEventListener('click',function(){ open(i); }); });
  document.getElementById('lbClose').addEventListener('click',close);
  document.getElementById('lbNext').addEventListener('click',next);
  document.getElementById('lbPrev').addEventListener('click',prev);
  lb.addEventListener('click',function(e){ if(e.target===lb)close(); });
  document.addEventListener('keydown',function(e){
    if(!lb.classList.contains('open'))return;
    if(e.key==='Escape')close();
    if(e.key==='ArrowRight')next();
    if(e.key==='ArrowLeft')prev();
  });
})();
`;
}
