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
  const title = escapeHtml(ctx.academyName);

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css(doc.theme.primary, doc.theme.accent)}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <span class="brand">${logo(doc.theme.logoMediaId, ctx)}<span>${title}</span></span>
    <button id="langToggle" class="lang-toggle" type="button" aria-label="Language"></button>
  </div>
</header>
<main>
${body}
</main>
<footer class="site-footer"><div class="wrap">© ${title}</div></footer>
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
        <a class="btn" href="#courses-${block.id}">${i18n(block.ctaLabel)}</a>
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

function css(primary: string, accent: string): string {
  const p = /^#[0-9a-fA-F]{6}$/.test(primary) ? primary : '#4A32C9';
  const a = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : p;
  return `
:root{--p:${p};--a:${a};--ink:#1a1a2e;--mut:#667;--bg:#fff;--soft:#f5f6fb}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.topbar{position:sticky;top:0;z-index:9;background:rgba(255,255,255,.9);backdrop-filter:blur(8px);border-bottom:1px solid #eee}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800}.logo{border-radius:8px;object-fit:cover}
.lang-toggle{border:1px solid var(--p);color:var(--p);background:none;border-radius:999px;padding:6px 14px;font-weight:700;cursor:pointer}
.block{padding:64px 0}.block h2{font-size:1.9rem;margin:0 0 24px}
.hero{background:var(--soft)}.hero h1{font-size:2.6rem;margin:0 0 12px;text-wrap:balance}.hero .sub{font-size:1.2rem;color:var(--mut);max-width:640px}
.hero-img{color:#fff}.hero-img .sub{color:#eee}.hero-img{background-size:cover;background-position:center}
.btn{display:inline-block;margin-top:20px;background:var(--p);color:#fff;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700}
.btn:hover{background:var(--a)}
.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center}.about-img{width:100%;border-radius:14px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:20px}
.stat{background:var(--soft);border-radius:12px;padding:20px;text-align:center}.stat .v{display:block;font-size:2rem;font-weight:800;color:var(--p)}.stat .l{color:var(--mut)}
.faq-list details{border:1px solid #eee;border-radius:10px;padding:12px 16px;margin-bottom:10px}.faq-list summary{font-weight:700;cursor:pointer}
.cards,.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}
.card{background:var(--soft);border-radius:12px;padding:18px;min-height:120px}
.card img{width:100%;border-radius:8px;aspect-ratio:16/9;object-fit:cover}.card h3{margin:.6rem 0 .2rem;font-size:1.05rem}
.skeleton{background:linear-gradient(90deg,#eee,#f6f6f6,#eee);background-size:200% 100%;animation:sk 1.2s infinite}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.gallery-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px}
.cta{background:var(--p);color:#fff;text-align:center}.cta .btn{background:#fff;color:var(--p)}
.socials{display:flex;gap:12px;flex-wrap:wrap}.social{border:1px solid var(--p);color:var(--p);border-radius:999px;padding:8px 18px;text-decoration:none;font-weight:700}
.site-footer{padding:30px 0;color:var(--mut);border-top:1px solid #eee;text-align:center}
@media(max-width:720px){.about-grid{grid-template-columns:1fr}.hero h1{font-size:2rem}.block{padding:44px 0}}
`.trim();
}

function clientJs(slug: string, defaultLang: 'ar' | 'en'): string {
  const s = JSON.stringify(slug);
  const dl = JSON.stringify(defaultLang);
  return `
(function(){
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
