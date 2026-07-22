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

/**
 * Pure, deterministic compiler: Site Document → a single self-contained HTML
 * document (inline CSS/JS, no external requests except same-origin media/data).
 * All text is escaped. Live blocks (courses/reviews) are emitted as hydration
 * placeholders filled at view time from public endpoints, so cached HTML never
 * serves a stale course list.
 */
export function compileSite(doc: SiteDocument, ctx: RenderContext): string {
  const lang = ctx.defaultLang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const body = doc.blocks.map((b) => renderBlock(b, ctx)).join('\n');
  const brand = escapeHtml(ctx.academyName);
  // SEO title/description come from the document when generated; fall back to the
  // academy name. Meta tags are rendered in the default language for crawlers.
  const seoTitle = doc.seo?.title?.[lang]?.trim();
  const seoDesc = doc.seo?.description?.[lang]?.trim();
  const title = escapeHtml(seoTitle || ctx.academyName);
  const descMeta = seoDesc ? `\n<meta name="description" content="${escapeAttr(seoDesc)}">` : '';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${descMeta}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
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
  // default textContent set at load from the active language by clientJs
  return `<span class="i18n" data-ar="${ar}" data-en="${en}">${escapeHtml(lt?.ar ?? '')}</span>`;
}

function logo(id: string | undefined, ctx: RenderContext): string {
  if (!id) return '';
  const m = ctx.media(id);
  const url = safeUrl(m?.url);
  if (!url) return '';
  return `<img class="logo" src="${escapeAttr(url)}" alt="" width="36" height="36">`;
}

function renderBlock(block: SiteBlock, ctx: RenderContext): string {
  switch (block.type) {
    case 'hero': {
      const cover = block.mediaId ? ctx.media(block.mediaId) : undefined;
      const bg = cover && safeUrl(cover.url)
        ? ` style="background-image:linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.55)),url('${escapeAttr(safeUrl(cover.url))}')"`
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
      return `<section class="block about"><div class="wrap about-grid">
        <div><h2>${i18n(block.heading)}</h2><p>${i18n(block.body)}</p></div>${imgHtml}
      </div></section>`;
    }
    case 'stats':
      return `<section class="block stats"><div class="wrap">
        <h2>${i18n(block.heading)}</h2>
        <div class="stat-grid">${block.items
          .map((s) => `<div class="stat"><span class="v">${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
          .join('')}</div>
      </div></section>`;
    case 'faq':
      return `<section class="block faq"><div class="wrap">
        <h2>${i18n(block.heading)}</h2>
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
      return `<section id="courses-${block.id}" class="block courses" data-hydrate="courses" data-limit="${block.limit}"><div class="wrap">
        <h2>${i18n(block.heading)}</h2>
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
    case 'reviews':
      return `<section class="block reviews" data-hydrate="reviews" data-limit="${block.limit}"><div class="wrap">
        <h2>${i18n(block.heading)}</h2>
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
    case 'gallery': {
      const imgs = block.mediaIds
        .map((id) => ctx.media(id))
        .filter((m): m is RenderMedia => !!m && !!safeUrl(m.url))
        .map((m) => `<img src="${escapeAttr(safeUrl(m.url))}" alt="" loading="lazy">`)
        .join('');
      if (!imgs) return '';
      return `<section class="block gallery"><div class="wrap">
        <h2>${i18n(block.heading)}</h2><div class="gallery-grid">${imgs}</div>
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
/** Mix `hex` toward `target` by weight w (0..1). */
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
/** Readable text color on a given background. */
const onColor = (hex: string) => (relLuminance(hex) > 0.5 ? '#12121c' : '#ffffff');

const STYLE_RADIUS: Record<string, string> = {
  modern: '18px', bold: '12px', elegant: '8px', minimal: '10px', playful: '26px',
};

function css(primary: string, accent: string, style?: string): string {
  const p = /^#[0-9a-fA-F]{6}$/.test(primary) ? primary : '#4A32C9';
  const a = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : p;
  const rad = STYLE_RADIUS[style ?? 'modern'] ?? '18px';
  const pDark = darken(p, 0.18);
  const onP = onColor(p);
  const aDark = darken(a, 0.18);
  const pSoft = mix(p, '#ffffff', 0.92);
  const heroTo = a.toLowerCase() === p.toLowerCase() ? pDark : a;
  const pr = hexToRgb(p).join(',');
  const ar = hexToRgb(a).join(',');
  return `
:root{--p:${p};--p-dark:${pDark};--on-p:${onP};--a:${a};--a-dark:${aDark};--soft:${pSoft};--pr:${pr};--ar:${ar};--ink:#14141f;--mut:#5c5c72;--bg:#fff;--line:#ececf3;--rad:${rad}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:"Tajawal","Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.7;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
:lang(en){font-family:"Plus Jakarta Sans","Tajawal",system-ui,sans-serif}
img{max-width:100%;display:block}
.wrap{max-width:1140px;margin:0 auto;padding:0 24px}
.eyebrow{display:inline-block;font-size:.8rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--p);background:rgba(var(--pr),.09);padding:6px 14px;border-radius:999px;margin-bottom:16px}
/* Nav */
.topbar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.72);backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid rgba(0,0,0,.05)}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;height:70px}
.brand{display:flex;align-items:center;gap:12px;font-weight:900;font-size:1.15rem}.logo{width:40px;height:40px;border-radius:11px;object-fit:cover;box-shadow:0 4px 14px -6px rgba(var(--pr),.6)}
.lang-toggle{border:1.5px solid rgba(var(--pr),.35);color:var(--p);background:#fff;border-radius:999px;padding:8px 18px;font-weight:800;font-family:inherit;cursor:pointer;transition:.2s}
.lang-toggle:hover{background:var(--p);color:var(--on-p);border-color:var(--p)}
/* Section rhythm */
.block{padding:96px 0;position:relative}
.block h2{font-size:clamp(1.8rem,3.6vw,2.6rem);font-weight:900;letter-spacing:-.02em;margin:0 0 28px;text-wrap:balance;line-height:1.15}
/* Hero */
.hero{min-height:78vh;display:flex;align-items:center;text-align:center;overflow:hidden;background:
  radial-gradient(60% 55% at 20% 8%,rgba(var(--pr),.16),transparent 60%),
  radial-gradient(55% 50% at 88% 12%,rgba(var(--ar),.14),transparent 60%),
  linear-gradient(180deg,var(--soft),#fff 70%)}
.hero .wrap{display:flex;flex-direction:column;align-items:center}
.hero h1{font-size:clamp(2.4rem,6vw,4.4rem);font-weight:900;letter-spacing:-.03em;line-height:1.08;margin:0 0 20px;text-wrap:balance;max-width:16ch}
.hero .sub{font-size:clamp(1.05rem,1.8vw,1.35rem);color:var(--mut);max-width:60ch;margin:0 auto}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:32px}
.hero-img{color:#fff;background-size:cover;background-position:center;min-height:82vh}
.hero-img::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,20,.35),rgba(10,10,20,.72))}
.hero-img .wrap{position:relative;z-index:1}.hero-img h1{max-width:18ch}.hero-img .sub{color:#eef}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--p);color:var(--on-p);padding:15px 32px;border-radius:var(--rad);text-decoration:none;font-weight:800;font-size:1.05rem;box-shadow:0 14px 30px -12px rgba(var(--pr),.7);transition:.2s}
.btn:hover{background:var(--p-dark);transform:translateY(-2px);box-shadow:0 20px 40px -12px rgba(var(--pr),.8)}
.btn-ghost{background:rgba(var(--pr),.08);color:var(--p);box-shadow:none}.btn-ghost:hover{background:rgba(var(--pr),.16);color:var(--p)}
/* About */
.about-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center}
.about p{font-size:1.1rem;color:#3d3d52;white-space:pre-line}.about-img{width:100%;border-radius:calc(var(--rad) + 6px);box-shadow:0 30px 60px -30px rgba(var(--pr),.5)}
/* Stats */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:20px}
.stat{background:var(--soft);border:1px solid rgba(var(--pr),.12);border-radius:var(--rad);padding:28px;text-align:center}
.stat .v{display:block;font-size:2.6rem;font-weight:900;background:linear-gradient(120deg,var(--p),${heroTo});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.stat .l{color:var(--mut);font-weight:600}
/* FAQ */
.faq-list{max-width:800px;margin:0 auto}
.faq-list details{border:1px solid var(--line);border-radius:var(--rad);padding:6px 22px;margin-bottom:14px;background:#fff;transition:.2s}
.faq-list details[open]{border-color:rgba(var(--pr),.5);box-shadow:0 16px 40px -24px rgba(var(--pr),.5)}
.faq-list summary{font-weight:800;cursor:pointer;padding:16px 0;list-style:none;position:relative;font-size:1.08rem}
.faq-list summary::-webkit-details-marker{display:none}
.faq-list summary::after{content:"+";position:absolute;inset-inline-end:0;font-size:1.5rem;color:var(--p);transition:.2s}
.faq-list details[open] summary::after{transform:rotate(45deg)}
.faq-list details>div{padding-bottom:18px;color:#3d3d52}
/* Cards */
.cards,.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:24px}
.card{background:#fff;border:1px solid var(--line);border-radius:calc(var(--rad) + 2px);padding:0;overflow:hidden;min-height:120px;transition:.25s cubic-bezier(.2,.7,.2,1)}
a.card{text-decoration:none;color:inherit}
a.card:hover{border-color:rgba(var(--pr),.5);box-shadow:0 30px 60px -30px rgba(var(--pr),.6);transform:translateY(-6px)}
.card img{width:100%;aspect-ratio:16/10;object-fit:cover}.card h3{margin:0;padding:16px 18px 4px;font-size:1.1rem;font-weight:800}.card>div{padding:0 18px 18px;color:var(--p);font-weight:800}
.card:not(a){padding:22px}.card strong{font-weight:800}.card p{color:#4a4a5e;margin:.4rem 0 0}
.skeleton{background:linear-gradient(90deg,var(--soft),#f4f4f8,var(--soft));background-size:200% 100%;animation:sk 1.3s infinite}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.gallery-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:18px;transition:.3s}.gallery-grid img:hover{transform:scale(1.03)}
/* CTA */
.cta{text-align:center;color:var(--on-p);position:relative;overflow:hidden;background:linear-gradient(130deg,var(--p),${heroTo})}
.cta::before{content:"";position:absolute;inset:0;background:radial-gradient(50% 80% at 80% 0%,rgba(255,255,255,.18),transparent 60%)}
.cta .wrap{position:relative}.cta h2{color:var(--on-p)}.cta .btn{background:#fff;color:var(--p);box-shadow:0 14px 30px -14px rgba(0,0,0,.4)}
/* Contact */
.socials{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
.social{border:1.5px solid rgba(var(--pr),.3);color:var(--p);border-radius:999px;padding:12px 26px;text-decoration:none;font-weight:800;transition:.2s}.social:hover{background:var(--p);color:var(--on-p);border-color:var(--p)}
.contact{text-align:center}
.site-footer{padding:44px 0;color:var(--mut);border-top:1px solid var(--line);text-align:center;font-weight:600}
/* Scroll reveal (only when JS enables it) */
.reveal-on .block{opacity:0;transform:translateY(26px)}
.reveal-on .block.in{opacity:1;transform:none;transition:opacity .8s ease,transform .8s cubic-bezier(.2,.7,.2,1)}
@media(prefers-reduced-motion:reduce){.reveal-on .block{opacity:1;transform:none}html{scroll-behavior:auto}}
@media(max-width:820px){.about-grid{grid-template-columns:1fr;gap:32px}.block{padding:64px 0}.hero{min-height:auto;padding:80px 0}}
`.trim();
}

function clientJs(slug: string, defaultLang: 'ar' | 'en'): string {
  const s = JSON.stringify(slug);
  const dl = JSON.stringify(defaultLang);
  return `
(function(){
  // Scroll-reveal: enable only when JS runs so no-JS still shows everything.
  try{
    document.body.classList.add('reveal-on');
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12,rootMargin:'0px 0px -8% 0px'});
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
