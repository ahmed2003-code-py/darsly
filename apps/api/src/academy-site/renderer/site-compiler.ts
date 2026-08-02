import { SiteBlock, SiteDocument } from '../schema/site-document';
import { escapeAttr, escapeHtml, safeUrl } from './html.util';

export interface RenderMedia {
  url: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface RenderContext {
  academyName: string;
  slug: string;
  defaultLang: 'ar' | 'en';
  /** Resolve a media id to its public URL + metadata (READY media only). */
  media: (id: string) => RenderMedia | undefined;
}

type LT = { ar: string; en: string };

// Short section eyebrow labels, numbered in the editorial layout.
const SECTION_LABEL: Record<string, LT> = {
  about: { ar: 'نبذة', en: 'About' },
  toolkit: { ar: 'المنهج', en: 'Toolkit' },
  credentials: { ar: 'السجل', en: 'Track record' },
  courses: { ar: 'الدورات', en: 'Courses' },
  reviews: { ar: 'الآراء', en: 'Reviews' },
  faq: { ar: 'الأسئلة', en: 'FAQ' },
  gallery: { ar: 'المعرض', en: 'Gallery' },
  stats: { ar: 'أرقام', en: 'By the numbers' },
};

/**
 * Pure, deterministic compiler: Site Document → a single self-contained HTML
 * document. A strong editorial design with numbered sections, four distinct
 * visual presets (theme.preset) and tasteful motion. Live blocks (courses/
 * reviews) hydrate at view time so cached HTML never serves a stale list.
 */
export function compileSite(doc: SiteDocument, ctx: RenderContext): string {
  const lang = doc.theme?.defaultLang ?? ctx.defaultLang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const preset = doc.theme?.preset ?? 'warm';
  const body = doc.blocks.map((b) => renderBlock(b, ctx)).join('\n');
  const brand = escapeHtml(ctx.academyName);
  const seoTitle = doc.seo?.title?.[lang]?.trim();
  const seoDesc = doc.seo?.description?.[lang]?.trim();
  const title = escapeHtml(seoTitle || ctx.academyName);
  const descMeta = seoDesc ? `\n<meta name="description" content="${escapeAttr(seoDesc)}">` : '';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}" data-preset="${escapeAttr(preset)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${descMeta}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=Plus+Jakarta+Sans:wght@400;700;800&family=Tajawal:wght@400;700;800&display=swap" rel="stylesheet">
<style>${css(doc.theme.primary, doc.theme.accent, doc.theme.style)}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <span class="brand">${logo(doc.theme.logoMediaId, ctx)}<span>${brand}</span></span>
    <button id="langToggle" class="lang-toggle" type="button" aria-label="Language"></button>
  </div>
</header>
<main>
${body}
</main>
<footer class="site-footer"><div class="wrap">© ${brand}</div></footer>
<script>${clientJs(ctx.slug, lang)}</script>
</body>
</html>`;
}

function i18n(lt: LT): string {
  const ar = escapeAttr(lt?.ar ?? '');
  const en = escapeAttr(lt?.en ?? '');
  return `<span class="i18n" data-ar="${ar}" data-en="${en}">${escapeHtml(lt?.ar ?? '')}</span>`;
}

/** Numbered eyebrow + big heading for an editorial section. */
function head(type: string, heading: LT): string {
  const label = SECTION_LABEL[type];
  const eyebrow = label ? `<p class="eyebrow">${i18n(label)}</p>` : '';
  return `${eyebrow}<h2>${i18n(heading)}</h2>`;
}

function logo(id: string | undefined, ctx: RenderContext): string {
  if (!id) return '';
  const m = ctx.media(id);
  const url = safeUrl(m?.url);
  if (!url) return '';
  return `<img class="logo" src="${escapeAttr(url)}" alt="" width="40" height="40">`;
}

function renderBlock(block: SiteBlock, ctx: RenderContext): string {
  switch (block.type) {
    case 'hero': {
      const cover = block.mediaId ? ctx.media(block.mediaId) : undefined;
      const bg = cover && safeUrl(cover.url)
        ? ` style="background-image:url('${escapeAttr(safeUrl(cover.url))}')"`
        : '';
      return `<section class="block hero${bg ? ' hero-img' : ''}"${bg}><div class="wrap">
        <h1>${i18n(block.headline)}</h1>
        <p class="sub">${i18n(block.subheadline)}</p>
        <div class="hero-actions"><a class="btn" href="#courses-${block.id}">${i18n(block.ctaLabel)}</a></div>
      </div></section>`;
    }
    case 'about': {
      const img = block.mediaId ? ctx.media(block.mediaId) : undefined;
      const imgHtml = img && safeUrl(img.url)
        ? `<img class="about-img" src="${escapeAttr(safeUrl(img.url))}" alt="" loading="lazy">`
        : '';
      return `<section class="block numbered about"><div class="wrap about-grid">
        <div>${head('about', block.heading)}<p>${i18n(block.body)}</p></div>${imgHtml}
      </div></section>`;
    }
    case 'toolkit': {
      const tags = block.items.map((s) => `<span class="tag">${escapeHtml(s)}</span>`).join('');
      if (!tags) return '';
      return `<section class="block numbered toolkit"><div class="wrap">
        ${head('toolkit', block.heading)}<div class="tags">${tags}</div>
      </div></section>`;
    }
    case 'credentials': {
      const items = block.items.map((s) => `<li><span>${escapeHtml(s)}</span></li>`).join('');
      if (!items) return '';
      return `<section class="block numbered credentials"><div class="wrap">
        ${head('credentials', block.heading)}<ol class="record">${items}</ol>
      </div></section>`;
    }
    case 'stats':
      return `<section class="block numbered stats"><div class="wrap">
        ${head('stats', block.heading)}
        <div class="stat-grid">${block.items
          .map((s) => `<div class="stat"><span class="v">${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
          .join('')}</div>
      </div></section>`;
    case 'faq':
      return `<section class="block numbered faq"><div class="wrap">
        ${head('faq', block.heading)}
        <div class="faq-list">${block.items
          .map((f) => `<details><summary>${i18n(f.q)}</summary><div>${i18n(f.a)}</div></details>`)
          .join('')}</div>
      </div></section>`;
    case 'cta':
      return `<section class="block cta"><div class="wrap">
        <h2>${i18n(block.headline)}</h2>
        <a class="btn" href="#top">${i18n(block.buttonLabel)}</a>
      </div></section>`;
    case 'courses':
      return `<section id="courses-${block.id}" class="block numbered courses" data-hydrate="courses" data-limit="${block.limit}"><div class="wrap">
        ${head('courses', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
    case 'reviews':
      return `<section class="block numbered reviews" data-hydrate="reviews" data-limit="${block.limit}"><div class="wrap">
        ${head('reviews', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
    case 'gallery': {
      const imgs = block.mediaIds
        .map((id) => ctx.media(id))
        .filter((m): m is RenderMedia => !!m && !!safeUrl(m.url))
        .map((m) => `<img src="${escapeAttr(safeUrl(m.url))}" alt="" loading="lazy">`)
        .join('');
      if (!imgs) return '';
      return `<section class="block numbered gallery"><div class="wrap">
        ${head('gallery', block.heading)}<div class="gallery-grid">${imgs}</div>
      </div></section>`;
    }
    case 'contact': {
      const links = block.socials
        .filter((s) => safeUrl(s.url))
        .map(
          (s) =>
            `<a class="social" href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(s.platform)}</a>`,
        )
        .join('');
      return `<section class="block contact"><div class="wrap">
        <h2>${i18n(block.heading)}</h2><div class="socials">${links}</div>
      </div></section>`;
    }
  }
}

function skeleton(n: number): string {
  return Array.from({ length: n }, () => '<div class="card skeleton"></div>').join('');
}

// ── Deterministic color system (derive a cohesive palette from the brand) ────
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(rgb: number[]): string {
  return '#' + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function mix(hex: string, target: string, w: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(a.map((c, i) => c + (b[i] - c) * w));
}
const darken = (hex: string, amt: number) => mix(hex, '#000000', amt);
function relLuminance(hex: string): number {
  const a = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
const onColor = (hex: string) => (relLuminance(hex) > 0.5 ? '#12121c' : '#ffffff');

const STYLE_RADIUS: Record<string, string> = {
  modern: '18px', bold: '12px', elegant: '10px', minimal: '10px', playful: '26px',
};

function css(primary: string, accent: string, style?: string): string {
  const p = /^#[0-9a-fA-F]{6}$/.test(primary) ? primary : '#4A32C9';
  const a = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : p;
  const rad = STYLE_RADIUS[style ?? 'modern'] ?? '18px';
  const pDark = darken(p, 0.18);
  const pl = mix(p, '#ffffff', 0.42); // lightened brand — for accents on dark presets
  const onP = onColor(p);
  const heroTo = a.toLowerCase() === p.toLowerCase() ? pDark : a;
  const pr = hexToRgb(p).join(',');
  const ar = hexToRgb(a).join(',');
  return `
:root{
  --p:${p};--pl:${pl};--p-dark:${pDark};--on-p:${onP};--a:${a};--pr:${pr};--ar:${ar};
  --acc:var(--p);--rad:${rad};
  --bg:#ffffff;--ink:#14141f;--mut:#5a5a72;--surface:#f7f7fb;--card:#ffffff;--line:#e9e9f1;
  --body:color-mix(in srgb,var(--ink) 82%,var(--bg));
}
:root[data-preset=warm]{--bg:#fffdf9;--ink:#231e19;--mut:#7c6f63;--surface:#fff7ee;--card:#fffcf7;--line:#efe5d8}
:root[data-preset=academic]{--bg:#ffffff;--ink:#0e1a2b;--mut:#54607a;--surface:#f4f8fc;--card:#ffffff;--line:#e5ebf3}
:root[data-preset=premium]{--bg:#0b0b13;--ink:#f4f2f9;--mut:#a09eb2;--surface:#14141e;--card:#15151f;--line:#252531;--acc:var(--pl)}
:root[data-preset=energetic]{--bg:#0a0a17;--ink:#ffffff;--mut:#bcbbd2;--surface:#15152c;--card:#161630;--line:#272750;--acc:var(--pl)}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:"Plus Jakarta Sans","Tajawal",system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.7;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
:lang(ar){font-family:"Tajawal","Plus Jakarta Sans",system-ui,sans-serif}
img{max-width:100%;display:block}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
/* Nav */
.topbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 78%,transparent);backdrop-filter:saturate(180%) blur(16px);border-bottom:1px solid var(--line)}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;height:72px}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:1.15rem;color:var(--ink)}
.logo{width:40px;height:40px;border-radius:11px;object-fit:cover;box-shadow:0 6px 18px -8px rgba(var(--pr),.7)}
.lang-toggle{border:1.5px solid color-mix(in srgb,var(--acc) 45%,transparent);color:var(--acc);background:transparent;border-radius:999px;padding:8px 18px;font-weight:800;font-family:inherit;cursor:pointer;transition:.2s}
.lang-toggle:hover{background:var(--acc);color:var(--on-p);border-color:var(--acc)}
/* Section rhythm + numbered eyebrows */
main{counter-reset:sec}
.block{padding:104px 0;position:relative}
.numbered{counter-increment:sec}
.block h2{font-size:clamp(1.9rem,4vw,2.9rem);font-weight:800;letter-spacing:-.025em;margin:0 0 34px;text-wrap:balance;line-height:1.12;color:var(--ink)}
.eyebrow{display:flex;align-items:center;gap:10px;font-size:.78rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--acc);margin:0 0 14px}
.numbered .eyebrow::before{content:counter(sec,decimal-leading-zero) "  —";font-variant-numeric:tabular-nums;opacity:.75}
/* Hero */
.hero{min-height:82vh;display:flex;align-items:center;text-align:center;overflow:hidden;isolation:isolate;background:
  radial-gradient(58% 60% at 18% 4%,rgba(var(--pr),.22),transparent 60%),
  radial-gradient(52% 55% at 86% 10%,rgba(var(--ar),.18),transparent 60%),
  var(--bg)}
.hero .wrap{display:flex;flex-direction:column;align-items:center}
.hero h1{font-size:clamp(2.6rem,6.5vw,4.8rem);font-weight:800;letter-spacing:-.035em;line-height:1.05;margin:0 0 22px;text-wrap:balance;max-width:17ch;color:var(--ink)}
.hero .sub{font-size:clamp(1.08rem,1.8vw,1.4rem);color:var(--mut);max-width:62ch;margin:0 auto}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:34px}
.hero h1,.hero .sub,.hero-actions{animation:rise .8s cubic-bezier(.2,.7,.2,1) both}
.hero .sub{animation-delay:.09s}.hero-actions{animation-delay:.18s}
@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
.hero-img{color:#fff;background-size:cover;background-position:center;min-height:88vh}
.hero-img::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(8,8,16,.35),rgba(8,8,16,.78))}
.hero-img h1{color:#fff;max-width:19ch}.hero-img .sub{color:#eef}
/* Preset-specific hero flourishes */
[data-preset=premium] h1,[data-preset=premium] .hero h1,[data-preset=premium] .block h2{font-family:"Fraunces",Georgia,serif;font-weight:700;letter-spacing:-.01em}
[data-preset=energetic] .hero::before{content:"";position:absolute;z-index:-2;inset:-25%;background:conic-gradient(from 0deg,rgba(var(--pr),.55),rgba(var(--ar),.42),rgba(var(--pr),.55));filter:blur(100px);opacity:.55;animation:spin 20s linear infinite}
@keyframes spin{to{transform:rotate(1turn)}}
[data-preset=academic] .hero{background:
  linear-gradient(rgba(var(--pr),.05),rgba(var(--pr),.05)),
  var(--bg);border-bottom:1px solid var(--line)}
/* Buttons */
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--p);color:var(--on-p);padding:16px 34px;border-radius:var(--rad);text-decoration:none;font-weight:800;font-size:1.05rem;box-shadow:0 16px 34px -14px rgba(var(--pr),.75);transition:.2s}
.btn:hover{background:var(--p-dark);transform:translateY(-2px);box-shadow:0 22px 44px -14px rgba(var(--pr),.85)}
.hero-img .btn{box-shadow:0 16px 34px -12px rgba(0,0,0,.6)}
/* About */
.about-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:60px;align-items:center}
.about p{font-size:1.15rem;color:var(--body);white-space:pre-line;margin:0}
.about-img{width:100%;border-radius:calc(var(--rad) + 8px);box-shadow:0 40px 80px -40px rgba(var(--pr),.6)}
/* Toolkit */
.tags{display:flex;flex-wrap:wrap;gap:12px}
.tag{padding:12px 22px;border:1px solid var(--line);border-radius:999px;font-weight:700;background:var(--surface);color:var(--ink);transition:.2s}
.tag:hover{border-color:var(--acc);color:var(--acc);transform:translateY(-2px)}
/* Track record */
.record{list-style:none;margin:0;padding:0;counter-reset:rec;max-width:900px}
.record li{counter-increment:rec;display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:baseline;padding:24px 0;border-top:1px solid var(--line);font-size:1.18rem;font-weight:600;color:var(--ink)}
.record li::before{content:counter(rec,decimal-leading-zero);font-family:"Fraunces",Georgia,serif;font-size:1.5rem;font-weight:700;color:var(--acc);opacity:.9}
/* Stats */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:20px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--rad);padding:30px;text-align:center}
.stat .v{display:block;font-size:2.7rem;font-weight:800;background:linear-gradient(120deg,var(--acc),${heroTo});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.stat .l{color:var(--mut);font-weight:600}
/* FAQ */
.faq-list{max-width:820px}
.faq-list details{border:1px solid var(--line);border-radius:var(--rad);padding:6px 24px;margin-bottom:14px;background:var(--card);transition:.2s}
.faq-list details[open]{border-color:color-mix(in srgb,var(--acc) 55%,transparent);box-shadow:0 18px 46px -26px rgba(var(--pr),.6)}
.faq-list summary{font-weight:700;cursor:pointer;padding:18px 0;list-style:none;position:relative;font-size:1.1rem;color:var(--ink)}
.faq-list summary::-webkit-details-marker{display:none}
.faq-list summary::after{content:"+";position:absolute;inset-inline-end:0;font-size:1.6rem;color:var(--acc);transition:.2s}
.faq-list details[open] summary::after{transform:rotate(45deg)}
.faq-list details>div{padding-bottom:20px;color:var(--body)}
/* Cards (courses / reviews) */
.cards,.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:calc(var(--rad) + 2px);padding:0;overflow:hidden;min-height:120px;transition:.28s cubic-bezier(.2,.7,.2,1)}
a.card{text-decoration:none;color:inherit}
a.card:hover{border-color:color-mix(in srgb,var(--acc) 55%,transparent);box-shadow:0 40px 70px -36px rgba(var(--pr),.65);transform:translateY(-6px)}
.card img{width:100%;aspect-ratio:16/10;object-fit:cover}
.card h3{margin:0;padding:18px 20px 4px;font-size:1.12rem;font-weight:700;color:var(--ink)}
.card>div{padding:0 20px 20px;color:var(--acc);font-weight:800}
.card:not(a){padding:24px}.card strong{font-weight:800;color:var(--ink)}.card p{color:var(--body);margin:.4rem 0 0}
.skeleton{background:linear-gradient(90deg,var(--surface),color-mix(in srgb,var(--surface) 60%,var(--bg)),var(--surface));background-size:200% 100%;animation:sk 1.3s infinite}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.gallery-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:calc(var(--rad) + 2px);transition:.3s}.gallery-grid img:hover{transform:scale(1.03)}
/* CTA */
.cta{text-align:center;color:var(--on-p);position:relative;overflow:hidden;background:linear-gradient(130deg,var(--p),${heroTo})}
.cta::before{content:"";position:absolute;inset:0;background:radial-gradient(50% 90% at 80% 0%,rgba(255,255,255,.2),transparent 60%)}
.cta .wrap{position:relative}.cta h2{color:var(--on-p)}.cta .btn{background:#fff;color:var(--p);box-shadow:0 16px 34px -14px rgba(0,0,0,.45)}
/* Contact */
.contact{text-align:center}
.socials{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
.social{border:1.5px solid color-mix(in srgb,var(--acc) 40%,transparent);color:var(--acc);border-radius:999px;padding:13px 28px;text-decoration:none;font-weight:800;transition:.2s}.social:hover{background:var(--acc);color:var(--on-p);border-color:var(--acc)}
.site-footer{padding:48px 0;color:var(--mut);border-top:1px solid var(--line);text-align:center;font-weight:600}
/* Scroll reveal */
.reveal-on .block{opacity:0;transform:translateY(28px)}
.reveal-on .hero{opacity:1;transform:none}
.reveal-on .block.in{opacity:1;transform:none;transition:opacity .8s ease,transform .8s cubic-bezier(.2,.7,.2,1)}
@media(prefers-reduced-motion:reduce){.reveal-on .block,.hero h1,.hero .sub,.hero-actions{opacity:1!important;transform:none!important;animation:none!important}[data-preset=energetic] .hero::before{animation:none}html{scroll-behavior:auto}}
@media(max-width:820px){.about-grid{grid-template-columns:1fr;gap:34px}.block{padding:68px 0}.hero{min-height:auto;padding:88px 0}}
`.trim();
}

function clientJs(slug: string, defaultLang: 'ar' | 'en'): string {
  const s = JSON.stringify(slug);
  const dl = JSON.stringify(defaultLang);
  return `
(function(){
  try{
    document.body.classList.add('reveal-on');
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.1,rootMargin:'0px 0px -8% 0px'});
    document.querySelectorAll('.block').forEach(function(b){io.observe(b);});
  }catch(e){document.body.classList.remove('reveal-on');}
  var L=localStorage.getItem('darsly_lang')|| ${dl};
  function apply(l){
    document.documentElement.lang=l;document.documentElement.dir=(l==='ar'?'rtl':'ltr');
    document.querySelectorAll('.i18n').forEach(function(e){var v=e.dataset[l];if(v!=null)e.textContent=v;});
    var b=document.getElementById('langToggle');if(b)b.textContent=(l==='ar'?'English':'العربية');
    localStorage.setItem('darsly_lang',l);
  }
  apply(L);
  var b=document.getElementById('langToggle');
  if(b)b.addEventListener('click',function(){apply(document.documentElement.lang==='ar'?'en':'ar');});
  function esc(t){var d=document.createElement('div');d.textContent=(t==null?'':t);return d.innerHTML;}
  function money(c){return (typeof c==='number')?(c/100).toLocaleString()+' EGP':'';}
  function hydrate(sec){
    var kind=sec.getAttribute('data-hydrate');var limit=sec.getAttribute('data-limit')||6;
    var slot=sec.querySelector('[data-slot]');if(!slot)return;
    fetch('/api/v1/a/'+encodeURIComponent(${s})+'/'+kind+'?limit='+limit)
      .then(function(r){return r.ok?r.json():[];})
      .then(function(items){
        if(!Array.isArray(items)||!items.length){sec.style.display='none';return;}
        slot.innerHTML=items.map(function(it){
          if(kind==='courses'){
            var img=it.thumbnailUrl?'<img src="'+esc(it.thumbnailUrl)+'" alt="">':'';
            return '<a class="card" href="'+esc(it.url||'#')+'">'+img+'<h3>'+esc(it.title)+'</h3><div>'+money(it.priceCents)+'</div></a>';
          }
          return '<div class="card"><strong>'+esc(it.studentName||'')+'</strong><div>'+('★'.repeat(it.rating||0))+'</div><p>'+esc(it.comment||'')+'</p></div>';
        }).join('');
      }).catch(function(){sec.style.display='none';});
  }
  document.querySelectorAll('[data-hydrate]').forEach(hydrate);
})();
`.trim();
}
