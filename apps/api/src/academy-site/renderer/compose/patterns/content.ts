import { SiteBlock } from '../../../schema/site-document';
import { normalizeItems } from '../../../text.util';
import { escapeHtml } from '../../html.util';
import {
  SECTION_CLOSE, hasImage, i18n, image, itemText, sectionHead, sectionOpen,
} from '../helpers';
import { registerPattern } from '../registry';

/**
 * The sections that carry what the teacher actually says: about, toolkit,
 * credentials, stats, timeline, process, quote, FAQ.
 *
 * These are where a page stops being a hero with a list underneath. A skill
 * matrix, a career timeline and a numbered method are three different arguments
 * built from the same facts, and letting the composition choose between them is
 * most of what makes two teachers' pages read differently.
 */

type Of<T extends SiteBlock['type']> = Extract<SiteBlock, { type: T }>;

// ── About ────────────────────────────────────────────────────────────────────

registerPattern({
  id: 'about.side-by-side',
  section: 'about',
  brief: 'Heading and prose beside a portrait or panel. The dependable default.',
  base: 1,
  css: () => `.about-side .split{--split:1.1fr .9fr}
.about p{white-space:pre-line;font-size:1.06rem}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'about'>;
    const img = hasImage(block.mediaId, ctx)
      ? `<div>${image(block.mediaId, ctx, { ratio: '4:3', treatment: spec.imageTreatment })}</div>`
      : '';
    return `${sectionOpen('about', spec, ctx, { extraClass: 'about about-side' })}
      <div class="split"><div>${sectionHead('about', block.heading)}<p>${i18n(block.body)}</p></div>${img}</div>
      ${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'about.statement',
  section: 'about',
  brief: 'One centred lead paragraph set large. Editorial and confident. Needs a substantial bio.',
  needs: { text: 200 },
  base: 1.1,
  weight: { university: 1.3, languages: 1.2 },
  css: () => `.about-statement .wrap{max-width:min(var(--w,var(--wrap)),860px);text-align:center}
.about-statement .eyebrow{justify-content:center}
.about-statement .say{font-family:var(--font-h);font-weight:calc(var(--wh) - 100);font-size:var(--h3);line-height:1.5;color:var(--ink);white-space:pre-line;max-width:none}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'about'>;
    return `${sectionOpen('about', spec, ctx, { extraClass: 'about about-statement' })}
      ${sectionHead('about', block.heading)}<p class="say">${i18n(block.body)}</p>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'about.two-column',
  section: 'about',
  brief: 'Heading held on the left while the prose runs in a column on the right. Magazine-like.',
  needs: { text: 160 },
  base: 1,
  weight: { math_science: 1.25, university: 1.2 },
  js: ['sticky-nav'],
  css: () => `.about-two .split{--split:.8fr 1.2fr;align-items:start}
.about-two p{white-space:pre-line;font-size:1.06rem;column-gap:2.4em}
@media(min-width:1100px){.about-two p{columns:2;max-width:none}}
@media(min-width:960px){.about-two .about-h{position:sticky;top:calc(74px + 2em)}}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'about'>;
    return `${sectionOpen('about', spec, ctx, { extraClass: 'about about-two' })}
      <div class="split"><div class="about-h">${sectionHead('about', block.heading)}</div>
      <p>${i18n(block.body)}</p></div>${SECTION_CLOSE}`;
  },
});

// ── Toolkit ──────────────────────────────────────────────────────────────────

const toolkitItems = (b: SiteBlock) =>
  b.type === 'toolkit' ? normalizeItems(b.items, { min: 2, maxLen: 60, cap: 20 }) : [];

registerPattern({
  id: 'toolkit.tags',
  section: 'toolkit',
  brief: 'Subjects as a wrapped field of pills. Compact and unfussy.',
  base: 1,
  css: () => `.toolkit-tags .tags{display:flex;flex-wrap:wrap;gap:12px}`,
  render: (b, spec, ctx) => {
    const items = toolkitItems(b);
    if (!items.length) return '';
    const block = b as Of<'toolkit'>;
    return `${sectionOpen('toolkit', spec, ctx, { extraClass: 'toolkit toolkit-tags' })}
      ${sectionHead('toolkit', block.heading)}
      <div class="tags">${items.map((it) => `<span class="tag">${itemText(it)}</span>`).join('')}</div>
      ${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'toolkit.skill-matrix',
  section: 'toolkit',
  brief: 'Subjects as a numbered grid of cells, like a syllabus map. Technical and structured.',
  needs: { items: 4 },
  base: 1.1,
  weight: { programming: 1.6, math_science: 1.3, exam_prep: 1.15 },
  css: () => `.matrix{display:grid;gap:1px;background:var(--line);border:var(--bw) solid var(--line);border-radius:var(--rad);overflow:hidden;grid-template-columns:1fr}
@media(min-width:620px){.matrix{grid-template-columns:repeat(2,1fr)}}
@media(min-width:960px){.matrix{grid-template-columns:repeat(var(--cols,3),1fr)}}
.matrix .cell{background:var(--bg);padding:1.5em 1.4em;display:flex;gap:1em;align-items:baseline;transition:background .25s}
.matrix .cell:hover{background:var(--surface)}
.matrix .n{font-family:var(--font-h);font-size:.85rem;font-weight:700;color:var(--a-text);font-variant-numeric:tabular-nums}
.matrix .t{font-family:var(--font-h);font-weight:600;color:var(--ink)}`,
  render: (b, spec, ctx) => {
    const items = toolkitItems(b);
    if (!items.length) return '';
    const block = b as Of<'toolkit'>;
    const cells = items
      .map((it, i) => `<div class="cell"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t">${itemText(it)}</span></div>`)
      .join('');
    return `${sectionOpen('toolkit', spec, ctx, { extraClass: 'toolkit toolkit-matrix' })}
      ${sectionHead('toolkit', block.heading)}<div class="matrix">${cells}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'toolkit.marquee',
  section: 'toolkit',
  brief: 'Subjects scrolling past in a continuous band. Energetic; best as a quiet strip between louder sections.',
  needs: { items: 5 },
  base: .9,
  weight: { languages: 1.3, exam_prep: 1.2, programming: 1.05 },
  js: ['marquee'],
  css: () => `.toolkit-marquee .marquee{margin-top:1.5em}
.toolkit-marquee .tag{white-space:nowrap}`,
  render: (b, spec, ctx) => {
    const items = toolkitItems(b);
    if (!items.length) return '';
    const block = b as Of<'toolkit'>;
    ctx.useDecor('fx:marquee');
    ctx.useEffect('marquee');
    const tags = items.map((it) => `<span class="tag">${itemText(it)}</span>`).join('');
    return `${sectionOpen('toolkit', spec, ctx, { extraClass: 'toolkit toolkit-marquee' })}
      ${sectionHead('toolkit', block.heading)}
      <div class="marquee"><div class="marquee-track">${tags}</div></div>${SECTION_CLOSE}`;
  },
});

// ── Credentials ──────────────────────────────────────────────────────────────

const credentialItems = (b: SiteBlock) =>
  b.type === 'credentials' ? normalizeItems(b.items, { min: 2, maxLen: 240, cap: 12 }) : [];

registerPattern({
  id: 'credentials.record',
  section: 'credentials',
  brief: 'A numbered editorial list separated by hairlines. Quiet authority.',
  base: 1,
  css: () => `.record{list-style:none;margin:0;padding:0;counter-reset:rec;max-width:min(100%,920px)}
.record li{counter-increment:rec;display:grid;grid-template-columns:auto 1fr;gap:1.4em;align-items:baseline;padding:1.3em 0;border-top:1px solid var(--line);font-size:1.1rem;font-weight:600;color:var(--ink)}
.record li::before{content:counter(rec,decimal-leading-zero);font-family:var(--font-h);font-size:1.1rem;color:var(--a-text);font-variant-numeric:tabular-nums}`,
  render: (b, spec, ctx) => {
    const items = credentialItems(b);
    if (!items.length) return '';
    const block = b as Of<'credentials'>;
    return `${sectionOpen('credentials', spec, ctx, { extraClass: 'credentials' })}
      ${sectionHead('credentials', block.heading)}
      <ol class="record">${items.map((it) => `<li><span>${itemText(it)}</span></li>`).join('')}</ol>
      ${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'credentials.cards',
  section: 'credentials',
  brief: 'Numbered cards in a grid. Reads as a body of work once there are several.',
  needs: { items: 4 },
  base: 1.05,
  css: () => `.cred-grid{display:grid;gap:var(--gap);counter-reset:crd;grid-template-columns:1fr}
@media(min-width:620px){.cred-grid{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1000px){.cred-grid{grid-template-columns:repeat(var(--cols,3),1fr)}}
.cred-card{counter-increment:crd;font-weight:600;color:var(--ink)}
.cred-card::before{content:counter(crd,decimal-leading-zero);display:block;font-family:var(--font-h);font-size:1.1rem;color:var(--a-text);margin-bottom:.6em;font-variant-numeric:tabular-nums}`,
  render: (b, spec, ctx) => {
    const items = credentialItems(b);
    if (!items.length) return '';
    const block = b as Of<'credentials'>;
    return `${sectionOpen('credentials', spec, ctx, { extraClass: 'credentials' })}
      ${sectionHead('credentials', block.heading)}
      <div class="cred-grid">${items.map((it) => `<div class="card lift cred-card"><span>${itemText(it)}</span></div>`).join('')}</div>
      ${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'credentials.wall',
  section: 'credentials',
  brief: 'A dense wall of short statements with a rule between them. Impressive in volume.',
  needs: { items: 6 },
  base: 1,
  weight: { exam_prep: 1.3, university: 1.2 },
  css: () => `.cred-wall{display:grid;gap:0;grid-template-columns:1fr}
@media(min-width:760px){.cred-wall{grid-template-columns:repeat(2,1fr)}}
.cred-wall span{padding:1.15em 1.2em;border-top:1px solid var(--line);font-weight:600;color:var(--ink)}
@media(min-width:760px){.cred-wall span:nth-child(odd){border-inline-end:1px solid var(--line)}}`,
  render: (b, spec, ctx) => {
    const items = credentialItems(b);
    if (!items.length) return '';
    const block = b as Of<'credentials'>;
    return `${sectionOpen('credentials', spec, ctx, { extraClass: 'credentials' })}
      ${sectionHead('credentials', block.heading)}
      <div class="cred-wall">${items.map((it) => `<span>${itemText(it)}</span>`).join('')}</div>
      ${SECTION_CLOSE}`;
  },
});

// ── Stats ────────────────────────────────────────────────────────────────────

registerPattern({
  id: 'stats.band',
  section: 'stats',
  brief: 'Figures in a row of panels. The standard proof band.',
  base: 1,
  js: ['counters'],
  css: () => `.stat-grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.stat{text-align:center;padding:1.6em 1em}
.stat .v{display:block;font-family:var(--font-h);font-size:2.6rem;font-weight:var(--wh);color:var(--a-text);line-height:1;font-variant-numeric:tabular-nums}
.stat .l{display:block;margin-top:.5em;color:var(--mut);font-weight:600;font-size:.95rem}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'stats'>;
    if (!block.items.length) return '';
    ctx.useEffect('counters');
    const cells = block.items
      .map((s) => `<div class="stat card"><span class="v" data-count>${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
      .join('');
    return `${sectionOpen('stats', spec, ctx, { extraClass: 'stats' })}
      ${sectionHead('stats', block.heading)}<div class="stat-grid">${cells}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'stats.big-numbers',
  section: 'stats',
  brief: 'Very large figures with no panels, sitting directly on the page. Loud and confident.',
  base: 1,
  weight: { exam_prep: 1.5, programming: 1.1 },
  js: ['counters'],
  css: () => `.stats-big .stat-grid{display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:700px){.stats-big .stat-grid{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}
.stats-big .stat{text-align:start;padding:0;border-top:2px solid var(--a);padding-top:1em}
.stats-big .stat .v{font-size:clamp(3rem,7vw,5rem);color:var(--ink)}
.stats-big .stat .l{text-transform:uppercase;letter-spacing:.12em;font-size:.78rem}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'stats'>;
    if (!block.items.length) return '';
    ctx.useEffect('counters');
    const cells = block.items
      .map((s) => `<div class="stat"><span class="v" data-count>${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
      .join('');
    return `${sectionOpen('stats', spec, ctx, { extraClass: 'stats stats-big' })}
      ${sectionHead('stats', block.heading)}<div class="stat-grid">${cells}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'stats.strip',
  section: 'stats',
  brief: 'A single quiet line of figures. Use as punctuation between two heavier sections.',
  base: .9,
  js: ['counters'],
  css: () => `.stats-strip .stat-row{display:flex;flex-wrap:wrap;gap:2.4em;align-items:baseline;justify-content:space-between;border-block:1px solid var(--line);padding-block:1.4em}
.stats-strip .stat{display:flex;align-items:baseline;gap:.6em;padding:0}
.stats-strip .v{font-family:var(--font-h);font-weight:var(--wh);font-size:1.9rem;color:var(--a-text);font-variant-numeric:tabular-nums}
.stats-strip .l{color:var(--mut);font-weight:600}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'stats'>;
    if (!block.items.length) return '';
    ctx.useEffect('counters');
    const cells = block.items
      .map((s) => `<div class="stat"><span class="v" data-count>${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
      .join('');
    return `${sectionOpen('stats', spec, ctx, { extraClass: 'stats stats-strip' })}
      <div class="stat-row">${cells}</div>${SECTION_CLOSE}`;
  },
});

// ── Timeline ─────────────────────────────────────────────────────────────────

registerPattern({
  id: 'timeline.rail',
  section: 'timeline',
  brief: 'A vertical rail with markers. Turns a list of achievements into a career.',
  base: 1,
  css: () => `.tl{list-style:none;margin:0;padding:0;position:relative}
.tl::before{content:"";position:absolute;inset-block:.6em;inset-inline-start:7px;width:1px;background:var(--line)}
.tl li{position:relative;padding-inline-start:2.6em;padding-block:0 1.8em}
.tl li::before{content:"";position:absolute;inset-inline-start:0;top:.45em;width:15px;height:15px;border-radius:50%;background:var(--bg);border:2px solid var(--a)}
.tl .m{font-family:var(--font-h);font-size:.82rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--a-text)}
.tl h3{margin:.2em 0 .35em}
.tl p{color:var(--mut);margin:0}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'timeline'>;
    if (!block.items.length) return '';
    const li = block.items
      .map((it) => `<li><span class="m">${i18n(it.marker)}</span><h3>${i18n(it.title)}</h3><p>${i18n(it.body)}</p></li>`)
      .join('');
    return `${sectionOpen('timeline', spec, ctx, { extraClass: 'timeline' })}
      ${sectionHead('timeline', block.heading)}<ol class="tl">${li}</ol>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'timeline.columns',
  section: 'timeline',
  brief: 'The same journey laid out horizontally as connected columns. Reads as progress, not history.',
  needs: { items: 3 },
  base: 1,
  weight: { exam_prep: 1.3, programming: 1.2 },
  css: () => `.tl-cols{list-style:none;margin:0;padding:0;display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:760px){.tl-cols{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}}
.tl-cols li{border-top:2px solid var(--a);padding-top:1.1em}
.tl-cols .m{font-family:var(--font-h);font-size:2rem;font-weight:var(--wh);color:var(--a-text);line-height:1}
.tl-cols h3{margin:.4em 0 .3em}
.tl-cols p{color:var(--mut);margin:0;font-size:.98rem}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'timeline'>;
    if (!block.items.length) return '';
    const li = block.items
      .map((it) => `<li><span class="m">${i18n(it.marker)}</span><h3>${i18n(it.title)}</h3><p>${i18n(it.body)}</p></li>`)
      .join('');
    return `${sectionOpen('timeline', spec, ctx, { extraClass: 'timeline' })}
      ${sectionHead('timeline', block.heading)}<ol class="tl-cols">${li}</ol>${SECTION_CLOSE}`;
  },
});

// ── Process ──────────────────────────────────────────────────────────────────

registerPattern({
  id: 'process.numbered',
  section: 'process',
  brief: 'Numbered steps answering "what actually happens if I enrol?". Reassuring for parents.',
  base: 1,
  css: () => `.steps{list-style:none;margin:0;padding:0;counter-reset:st;display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:760px){.steps{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}}
.steps li{counter-increment:st;position:relative;padding-top:2.6em}
.steps li::before{content:counter(st);position:absolute;top:0;inset-inline-start:0;width:2em;height:2em;display:grid;place-items:center;border-radius:var(--pill);background:var(--a);color:var(--on-a);font-family:var(--font-h);font-weight:700}
.steps h3{margin-bottom:.35em}
.steps p{color:var(--mut);margin:0}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'process'>;
    if (!block.steps.length) return '';
    const li = block.steps.map((s) => `<li><h3>${i18n(s.title)}</h3><p>${i18n(s.body)}</p></li>`).join('');
    return `${sectionOpen('process', spec, ctx, { extraClass: 'process' })}
      ${sectionHead('process', block.heading)}<ol class="steps">${li}</ol>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'process.rail',
  section: 'process',
  brief: 'Steps as a connected horizontal rail with arrows. Reads as a path.',
  needs: { items: 3 },
  base: 1,
  weight: { programming: 1.3, exam_prep: 1.2 },
  css: () => `.rail{list-style:none;margin:0;padding:0;counter-reset:st;display:grid;gap:0;grid-template-columns:1fr}
@media(min-width:860px){.rail{grid-auto-flow:column;grid-auto-columns:1fr}}
.rail li{counter-increment:st;position:relative;padding:1.6em 1.4em;border:var(--bw) solid var(--line);margin:-1px 0 0 -1px}
@media(min-width:860px){.rail li{margin:0 0 0 -1px}}
.rail li::before{content:counter(st,decimal-leading-zero);font-family:var(--font-h);font-size:.82rem;font-weight:700;color:var(--a-text);display:block;margin-bottom:.7em}
.rail h3{margin-bottom:.35em}
.rail p{color:var(--mut);margin:0;font-size:.97rem}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'process'>;
    if (!block.steps.length) return '';
    const li = block.steps.map((s) => `<li><h3>${i18n(s.title)}</h3><p>${i18n(s.body)}</p></li>`).join('');
    return `${sectionOpen('process', spec, ctx, { extraClass: 'process' })}
      ${sectionHead('process', block.heading)}<ol class="rail">${li}</ol>${SECTION_CLOSE}`;
  },
});

// ── Quote ────────────────────────────────────────────────────────────────────

registerPattern({
  id: 'quote.statement',
  section: 'quote',
  brief: 'One sentence set large, alone on the page. The cheapest way to give a long page a moment of quiet.',
  base: 1,
  css: () => `.quote-block .wrap{max-width:min(var(--w,var(--wrap)),840px);text-align:center}
.quote-block blockquote{margin:0;font-family:var(--font-h);font-weight:calc(var(--wh) - 100);font-size:var(--h2);line-height:1.35;letter-spacing:var(--tr);color:var(--ink)}
.quote-block figcaption{margin-top:1.4em;color:var(--mut);font-weight:600;letter-spacing:.06em}
.quote-block .mark{font-family:var(--font-h);font-size:3.5rem;line-height:.6;color:var(--a-text);opacity:.5;display:block;margin-bottom:.2em}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'quote'>;
    return `${sectionOpen('quote', spec, ctx, { extraClass: 'quote-block' })}
      <figure><span class="mark" aria-hidden="true">”</span>
      <blockquote>${i18n(block.text)}</blockquote>
      <figcaption>${i18n(block.attribution)}</figcaption></figure>${SECTION_CLOSE}`;
  },
});

// ── FAQ ──────────────────────────────────────────────────────────────────────

const FAQ_BASE = `.faq-item{border:var(--bw) solid var(--line);border-radius:var(--rad);background:var(--surface);margin-bottom:12px;transition:border-color .2s}
.faq-item[open]{border-color:color-mix(in srgb,var(--a) 50%,var(--line))}
.faq-item summary{cursor:pointer;list-style:none;padding:1.1em 1.3em;font-family:var(--font-h);font-weight:600;font-size:1.03rem;color:var(--ink);position:relative;padding-inline-end:2.6em}
.faq-item summary::-webkit-details-marker{display:none}
.faq-item summary::after{content:"+";position:absolute;inset-inline-end:1.1em;top:50%;transform:translateY(-50%);font-size:1.4rem;color:var(--a-text);transition:transform .2s}
.faq-item[open] summary::after{transform:translateY(-50%) rotate(45deg)}
.faq-item .a{padding:0 1.3em 1.2em;color:var(--body)}`;

registerPattern({
  id: 'faq.accordion',
  section: 'faq',
  brief: 'A single column of accordions. Familiar and scannable.',
  base: 1,
  js: ['faq'],
  css: () => `${FAQ_BASE}\n.faq-list{max-width:min(100%,840px)}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'faq'>;
    if (!block.items.length) return '';
    ctx.useEffect('faq');
    const items = block.items
      .map((f) => `<details class="faq-item"><summary>${i18n(f.q)}</summary><div class="a">${i18n(f.a)}</div></details>`)
      .join('');
    return `${sectionOpen('faq', spec, ctx, { extraClass: 'faq' })}
      ${sectionHead('faq', block.heading)}<div class="faq-list">${items}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'faq.two-column',
  section: 'faq',
  brief: 'Heading held to one side with the questions beside it. Keeps a long FAQ from reading as a support article.',
  base: 1,
  weight: { university: 1.25, programming: 1.2 },
  js: ['faq'],
  css: () => `${FAQ_BASE}\n.faq-two .split{--split:.72fr 1.28fr;align-items:start}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'faq'>;
    if (!block.items.length) return '';
    ctx.useEffect('faq');
    const items = block.items
      .map((f) => `<details class="faq-item"><summary>${i18n(f.q)}</summary><div class="a">${i18n(f.a)}</div></details>`)
      .join('');
    return `${sectionOpen('faq', spec, ctx, { extraClass: 'faq faq-two' })}
      <div class="split"><div>${sectionHead('faq', block.heading)}</div><div>${items}</div></div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'faq.plain',
  section: 'faq',
  brief: 'Questions and answers open, with no accordion. Honest and fast to read when there are only a few.',
  base: .95,
  css: () => `.faq-plain dl{margin:0;max-width:min(100%,860px)}
.faq-plain dt{font-family:var(--font-h);font-weight:600;font-size:1.05rem;color:var(--ink);padding-top:1.3em;border-top:1px solid var(--line);margin-top:1.3em}
.faq-plain dt:first-of-type{border-top:0;margin-top:0;padding-top:0}
.faq-plain dd{margin:.5em 0 0;color:var(--body)}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'faq'>;
    if (!block.items.length) return '';
    const items = block.items.map((f) => `<dt>${i18n(f.q)}</dt><dd>${i18n(f.a)}</dd>`).join('');
    return `${sectionOpen('faq', spec, ctx, { extraClass: 'faq faq-plain' })}
      ${sectionHead('faq', block.heading)}<dl>${items}</dl>${SECTION_CLOSE}`;
  },
});
