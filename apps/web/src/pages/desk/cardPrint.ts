import type { IssuedCard } from '../../lib/desk';

/**
 * A learner's printable card: the center, the learner's name, code and year,
 * and a QR holding the card token — 48 digits and nothing else. No phone, no
 * guardian, no id, no money.
 *
 * The token exists here only while the preview is open: it is rendered into
 * an SVG in memory and into a throwaway print frame, and never into a URL,
 * storage or a log. Printing again later means reissuing (the server keeps
 * only a digest and cannot reproduce a card).
 */

/** The QR as scalable SVG markup (numeric mode, error correction M). */
export async function qrSvg(token: string): Promise<string> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(token, 'Numeric');
  qr.make();
  const n = qr.getModuleCount();
  const m = 2; // quiet zone, in modules
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export interface CardLabels {
  code: string;
  card: string;
  note: string;
}

/** One card's markup, credit-card sized (85.6 × 54 mm), Arabic first. */
export function cardMarkup(p: IssuedCard['print'], svg: string, lang: string, l: CardLabels) {
  const grade = p.grade ? (lang === 'en' ? p.grade.nameEn : p.grade.nameAr) : '';
  const logo = p.academy.logoUrl
    ? `<img class="logo" src="${esc(p.academy.logoUrl)}" alt="" referrerpolicy="no-referrer">`
    : '';
  return `<article class="qr-card" dir="${lang === 'en' ? 'ltr' : 'rtl'}">
  <header>${logo}<span class="center"><bdi>${esc(p.academy.name)}</bdi></span><span class="kind">${esc(l.card)}</span></header>
  <div class="body">
    <div class="who">
      <p class="name"><bdi>${esc(p.fullName)}</bdi></p>
      ${grade ? `<p class="grade"><bdi>${esc(grade)}</bdi></p>` : ''}
      <p class="code-label">${esc(l.code)}</p>
      <p class="code" dir="ltr">${esc(p.code)}</p>
    </div>
    <div class="qr">${svg}</div>
  </div>
  <footer>${esc(l.note)}</footer>
</article>`;
}

export const CARD_CSS = `
.qr-card{box-sizing:border-box;width:85.6mm;height:54mm;border:0.3mm solid #cbd5e1;border-radius:3mm;padding:3mm 3.5mm;display:flex;flex-direction:column;background:#fff;color:#0f172a;font-family:'Cairo','Noto Sans Arabic',system-ui,sans-serif;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
.qr-card header{display:flex;align-items:center;gap:2mm;border-bottom:0.3mm solid #e2e8f0;padding-bottom:1.5mm}
.qr-card .logo{height:6mm;width:6mm;object-fit:contain}
.qr-card .center{font-weight:800;font-size:3.4mm;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qr-card .kind{font-size:2.4mm;color:#475569}
.qr-card .body{flex:1;display:flex;align-items:center;gap:3mm;min-height:0}
.qr-card .who{flex:1;min-width:0}
.qr-card .name{margin:0;font-weight:800;font-size:4mm;line-height:1.25;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.qr-card .grade{margin:0.5mm 0 0;font-size:2.8mm;color:#334155}
.qr-card .code-label{margin:1.5mm 0 0;font-size:2.3mm;color:#64748b}
.qr-card .code{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:800;font-size:5mm;letter-spacing:0.6mm}
.qr-card .qr{width:30mm;height:30mm;flex:none}
.qr-card .qr svg{width:100%;height:100%;display:block}
.qr-card footer{font-size:2.1mm;color:#64748b;text-align:center}
`;

/**
 * Print cards through a hidden frame (no popup to block, no URL to leak),
 * several to an A4 sheet when there are many. The frame is removed after.
 */
export function printCards(markups: string[], lang: string, title: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed;width:0;height:0;border:0;right:0;bottom:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html lang="${lang}" dir="${lang === 'en' ? 'ltr' : 'rtl'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:A4;margin:10mm}html,body{background:#fff}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{display:grid;grid-template-columns:repeat(2,85.6mm);gap:6mm;justify-content:center}${CARD_CSS}</style></head>
<body><main class="sheet">${markups.join('')}</main></body></html>`);
  doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // The print dialog blocks in most browsers; either way the frame goes.
    setTimeout(() => frame.remove(), 1000);
  };
  // Give a logo a moment to load; the QR is inline and needs none.
  const imgs = [...doc.images];
  if (!imgs.length) setTimeout(go, 50);
  else
    void Promise.all(
      imgs.map(
        (i) =>
          new Promise((r) => {
            if (i.complete) r(null);
            i.onload = i.onerror = () => r(null);
          }),
      ),
    ).then(() => setTimeout(go, 50));
}
