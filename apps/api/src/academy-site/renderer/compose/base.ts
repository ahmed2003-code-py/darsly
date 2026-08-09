/**
 * The base stylesheet: the vocabulary every pattern is built from.
 *
 * It deliberately contains no *look* of its own — every colour, size, radius and
 * rhythm here is a custom property the token layer wrote. That is what lets one
 * stylesheet render a brutalist mono page and a soft rounded one without either
 * of them looking like a compromise.
 */
export function baseCss(): string {
  return `
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--body);font-family:var(--font-b);line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:hidden}
:lang(ar){font-family:"Tajawal",var(--font-b)}
img{max-width:100%;display:block}
::selection{background:var(--a);color:var(--on-a)}

/* ── Container ─────────────────────────────────────────────────────────────
   Sections may narrow or widen the page for themselves via --w; the default is
   whatever the design chose. A full-bleed section drops the gutter too. */
.wrap{width:100%;max-width:var(--w,var(--wrap));margin-inline:auto;padding-inline:var(--gut)}
.block[data-width=full]>.wrap{max-width:100%;padding-inline:0}

/* ── Section rhythm ────────────────────────────────────────────────────────
   Emphasis scales the section's own air. "crescendo" then adds a little more
   with every section, so a long page opens up as it goes instead of marching. */
.block{position:relative;padding-block:calc(var(--pad) * var(--emph,1));isolation:isolate}
.block[data-emph=quiet]{--emph:.62}
.block[data-emph=feature]{--emph:1.4}
[data-rhythm=crescendo] .block{padding-block:calc(var(--pad) * var(--emph,1) * (1 + var(--i,0) * .045))}
[data-rhythm=alternating] .block:nth-of-type(even):not([data-surface]){background:color-mix(in srgb,var(--surface) 55%,var(--bg))}

/* ── Section surfaces ──────────────────────────────────────────────────────
   A page whose every band is the same colour reads as one long scroll. These
   are how a composition gives it structure without changing the palette. */
.block[data-surface=raised]{background:var(--surface)}
.block[data-surface=accent]{background:linear-gradient(135deg,var(--p),var(--a));color:var(--on-p)}
.block[data-surface=accent] :is(h1,h2,h3,p,.lead){color:var(--on-p)}
.block[data-surface=accent] .eyebrow{color:color-mix(in srgb,var(--on-p) 80%,transparent)}
.block[data-surface=inverted]{background:var(--ink);color:var(--bg)}
.block[data-surface=inverted] :is(h1,h2,h3){color:var(--bg)}
.block[data-surface=inverted] :is(p,.lead){color:color-mix(in srgb,var(--bg) 82%,var(--ink))}
.block[data-surface=inverted] .card{background:color-mix(in srgb,var(--bg) 10%,var(--ink));border-color:color-mix(in srgb,var(--bg) 22%,var(--ink))}
.block[data-surface=inverted] .eyebrow{color:color-mix(in srgb,var(--bg) 78%,var(--ink))}

/* ── Type ──────────────────────────────────────────────────────────────────
   Headings take the design's family, weight, tracking and case in one place, so
   a monumental condensed uppercase page and a restrained serif one are the same
   markup. */
h1,h2,h3,.h-face{font-family:var(--font-h);font-weight:var(--wh);letter-spacing:var(--tr);text-transform:var(--case);color:var(--ink);margin:0;text-wrap:balance}
h1{font-size:var(--h1);line-height:1.02}
h2{font-size:var(--h2);line-height:1.1;margin-bottom:.6em}
h3{font-size:var(--h3);line-height:1.25}
p{margin:0 0 1em;max-width:var(--measure)}
p:last-child{margin-bottom:0}
.lead{font-size:var(--lead);line-height:1.55;color:var(--body)}
.mut{color:var(--mut)}
.eyebrow{display:flex;align-items:center;gap:.6em;font-family:var(--font-h);font-size:.76rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--a-text);margin:0 0 1em}
.center{text-align:center}
.center .eyebrow,.center .actions{justify-content:center}
.center p,.center .lead{margin-inline:auto}

/* The one flourish that most separates a designed page from a typed one: the
   closing words of a headline carrying the brand gradient. */
.grad{background:linear-gradient(102deg,var(--a),var(--p) 55%,var(--a));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:sheen 8s ease-in-out infinite}
@keyframes sheen{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}

/* ── Actions ───────────────────────────────────────────────────────────────*/
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:2em}
.btn{position:relative;display:inline-flex;align-items:center;gap:.5em;font-family:var(--font-h);font-weight:700;font-size:1.02rem;text-decoration:none;padding:.95em 1.9em;border-radius:var(--pill);background:var(--p);color:var(--on-p);border:var(--bw) solid transparent;box-shadow:var(--sh1);transition:transform .2s,box-shadow .2s,background .2s;overflow:hidden}
.btn:hover{transform:translateY(-2px);box-shadow:var(--sh2)}
.btn::after{content:"";position:absolute;top:0;inset-inline-start:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-18deg);transition:inset-inline-start .55s cubic-bezier(.2,.7,.2,1)}
.btn:hover::after{inset-inline-start:120%}
.btn-arrow{transition:transform .25s;font-weight:400}
.btn:hover .btn-arrow{transform:translateX(4px)}
[dir=rtl] .btn-arrow{transform:scaleX(-1)}
[dir=rtl] .btn:hover .btn-arrow{transform:scaleX(-1) translateX(4px)}
.btn-ghost{background:transparent;color:var(--a-text);border-color:color-mix(in srgb,var(--a) 45%,transparent);box-shadow:none}
.btn-ghost:hover{background:color-mix(in srgb,var(--a) 12%,transparent);box-shadow:none}
.block[data-surface=accent] .btn{background:var(--bg);color:var(--p-text)}
.block[data-surface=accent] .btn-ghost{background:transparent;color:var(--on-p);border-color:color-mix(in srgb,var(--on-p) 55%,transparent)}

.badge{display:inline-flex;align-items:center;gap:.55em;padding:.5em 1.1em;border-radius:var(--pill);font-family:var(--font-h);font-size:.82rem;font-weight:700;color:var(--a-text);background:color-mix(in srgb,var(--a) 10%,transparent);border:1px solid color-mix(in srgb,var(--a) 28%,transparent)}
.badge .dot{width:7px;height:7px;border-radius:50%;background:var(--a);animation:pulse 2.4s ease-out infinite}
@keyframes pulse{70%{box-shadow:0 0 0 10px rgba(var(--ar),0)}100%{box-shadow:0 0 0 0 rgba(var(--ar),0)}}

/* ── Surfaces ──────────────────────────────────────────────────────────────*/
.card{background:var(--surface);border:var(--bw) solid var(--line);border-radius:var(--rad);padding:1.6em;transition:transform .26s cubic-bezier(.2,.7,.2,1),box-shadow .26s,border-color .26s}
.card.lift:hover{transform:translateY(-5px);box-shadow:var(--sh2);border-color:color-mix(in srgb,var(--a) 50%,var(--line))}
[data-radius=cut-corner] .card{border-radius:0;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px))}
[data-radius=mixed] .card:nth-child(odd){border-start-end-radius:calc(var(--rad) * 3)}
[data-radius=mixed] .card:nth-child(even){border-end-start-radius:calc(var(--rad) * 3)}
[data-shadow=brutal] .card{box-shadow:var(--sh1)}
[data-border=none] .card{border-color:transparent}

.tag{display:inline-flex;align-items:center;padding:.6em 1.2em;border-radius:var(--pill);border:1px solid var(--line);background:var(--surface);color:var(--ink);font-family:var(--font-h);font-weight:600;font-size:.95rem;transition:.2s}
.tag:hover{background:var(--p);border-color:var(--p);color:var(--on-p);transform:translateY(-3px)}

/* ── Grids ─────────────────────────────────────────────────────────────────
   One grid, driven by --cols, with a mobile base of a single column. Nothing in
   the system can produce a three-column phone layout, whatever a composition
   asks for. */
.grid{display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:640px){.grid{grid-template-columns:repeat(min(2,var(--cols,3)),1fr)}}
@media(min-width:960px){.grid{grid-template-columns:repeat(var(--cols,3),1fr)}}
.auto-grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--min,280px)),1fr))}
.split{display:grid;gap:calc(var(--gap) * 1.4);align-items:center;grid-template-columns:1fr}
@media(min-width:900px){.split{grid-template-columns:var(--split,1.05fr .95fr)}}
.stack{display:flex;flex-direction:column;gap:var(--gap)}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}

/* ── Media ─────────────────────────────────────────────────────────────────*/
.img{width:100%;object-fit:cover;border-radius:var(--rad-l);display:block}
.img[data-ratio="1:1"]{aspect-ratio:1}
.img[data-ratio="4:3"]{aspect-ratio:4/3}
.img[data-ratio="3:4"]{aspect-ratio:3/4}
.img[data-ratio="16:9"]{aspect-ratio:16/9}

/* ── Loading placeholders ──────────────────────────────────────────────────*/
.skeleton{background:linear-gradient(90deg,var(--surface),color-mix(in srgb,var(--surface) 55%,var(--bg)),var(--surface));background-size:200% 100%;animation:sk 1.3s infinite;border-radius:var(--rad);min-height:180px}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Chrome ────────────────────────────────────────────────────────────────*/
.topbar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid transparent;transition:border-color .3s,box-shadow .3s}
.topbar.stuck{border-bottom-color:var(--line);box-shadow:0 10px 30px -26px rgba(var(--inkr),.6)}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:74px;transition:height .3s}
.topbar.stuck .wrap{height:60px}
.brand{display:flex;align-items:center;gap:12px;font-family:var(--font-h);font-weight:var(--wh);letter-spacing:var(--tr);font-size:1.1rem;color:var(--ink);text-decoration:none}
.logo{width:38px;height:38px;border-radius:var(--rad-s);object-fit:cover;transition:.3s}
.topnav{display:flex;align-items:center;gap:10px}
.lang-toggle{font-family:var(--font-h);font-weight:700;cursor:pointer;border:1px solid color-mix(in srgb,var(--a) 40%,transparent);color:var(--a-text);background:transparent;border-radius:var(--pill);padding:.5em 1.1em;transition:.2s}
.lang-toggle:hover{background:var(--a);color:var(--on-a)}
.nav-cta{display:inline-flex;align-items:center;background:var(--p);color:var(--on-p);border-radius:var(--pill);padding:.6em 1.3em;font-family:var(--font-h);font-weight:700;text-decoration:none;transition:.2s}
.nav-cta:hover{filter:brightness(1.08)}
@media(max-width:640px){.nav-cta{display:none}}
.site-footer{padding:3em 0;color:var(--mut);border-top:1px solid var(--line);text-align:center;font-size:.95rem}

/* ── Entrance ──────────────────────────────────────────────────────────────
   One mechanism, five personalities. The class is added by script, so a page
   with no JavaScript shows everything rather than nothing. */
.reveal-on .block:not(.hero){opacity:0}
.reveal-on .block.in{opacity:1;transition:opacity .8s ease,transform .8s cubic-bezier(.2,.7,.2,1),clip-path .9s cubic-bezier(.2,.7,.2,1)}
[data-entrance=rise] .reveal-on .block:not(.hero){transform:translateY(30px)}
[data-entrance=slide] .reveal-on .block:not(.hero){transform:translateX(-28px)}
[dir=rtl] [data-entrance=slide] .reveal-on .block:not(.hero){transform:translateX(28px)}
[data-entrance=mask-reveal] .reveal-on .block:not(.hero){clip-path:inset(0 0 100% 0)}
[data-entrance=mask-reveal] .reveal-on .block.in{clip-path:inset(0 0 0 0)}
.reveal-on .block.in{transform:none}
[data-entrance=stagger-grid] .reveal-on .block :is(.card,.tag,li,.grid>*,.auto-grid>*){opacity:0;transform:translateY(18px)}
[data-entrance=stagger-grid] .reveal-on .block.in :is(.card,.tag,li,.grid>*,.auto-grid>*){opacity:1;transform:none;transition:opacity .5s ease,transform .5s cubic-bezier(.2,.7,.2,1)}
${stagger()}
[data-motion=calm] .reveal-on .block.in{transition-duration:1s}
[data-motion=cinematic] .reveal-on .block:not(.hero){transform:translateY(48px)}
[data-motion=cinematic] .reveal-on .block.in{transition-duration:1.15s}

/* ── Reduced motion ────────────────────────────────────────────────────────
   The only place in the system where animation actually stops. "calm" is a
   restrained design; this is a visitor telling us they need stillness. */
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  .reveal-on .block,.reveal-on .block :is(.card,.tag,li){opacity:1!important;transform:none!important;clip-path:none!important}
  .grad{background-position:0 50%}
  html{scroll-behavior:auto}
}

/* ── Print ─────────────────────────────────────────────────────────────────*/
@media print{.topbar,.scroll-bar{display:none}.block{padding-block:1cm;break-inside:avoid}}
`.trim();
}

/** Stagger delays for grid entrances — six steps, then everything after shares one. */
function stagger(): string {
  const sel = '[data-entrance=stagger-grid] .reveal-on .block.in :is(.card,.tag,li,.grid>*,.auto-grid>*)';
  const steps = [1, 2, 3, 4, 5, 6]
    .map((n) => `${sel}:nth-child(${n}){transition-delay:${(n * 0.06).toFixed(2)}s}`)
    .join('\n');
  return `${steps}\n${sel}:nth-child(n+7){transition-delay:.42s}`;
}
