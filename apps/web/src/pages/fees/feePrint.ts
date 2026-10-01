import { formatMoney, Receipt } from '../../lib/centerFees';
import { formatClock } from '../../lib/classOps';

/**
 * Printing a receipt or a statement through a hidden frame (no popup to
 * block, nothing in a URL). Arabic first; the same layout reads left-to-right
 * in English. Our own escaped markup only.
 */
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function printHtml(body: string, title: string, lang: string, css: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed;width:0;height:0;border:0;right:0;bottom:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html lang="${lang}" dir="${lang === 'en' ? 'ltr' : 'rtl'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:A5;margin:10mm}html,body{background:#fff}body{margin:0;color:#0f172a;font-family:'Cairo','Noto Sans Arabic',system-ui,sans-serif;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}${css}</style></head>
<body>${body}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  }, 60);
}

export interface ReceiptLabels {
  title: string;
  number: string;
  date: string;
  student: string;
  code: string;
  collector: string;
  method: string;
  methodName: string;
  paidFor: string;
  total: string;
  balanceAfter: string;
  reversed: string;
  note: string;
  lineLabel: (l: Receipt['lines'][number]) => string;
  footer: string;
}

const RECEIPT_CSS = `
.r{max-width:120mm;margin:0 auto;border:1px solid #cbd5e1;border-radius:3mm;padding:5mm;position:relative}
.r h1{font-size:15px;margin:0}.r .sub{color:#475569;margin:1mm 0 3mm}
.r dl{display:grid;grid-template-columns:auto 1fr;gap:1.2mm 4mm;margin:0 0 3mm}.r dt{color:#64748b}.r dd{margin:0;font-weight:700}
.r table{width:100%;border-collapse:collapse;margin:2mm 0}.r td{padding:1.4mm 0;border-bottom:1px solid #e2e8f0}.r td.a{text-align:end;white-space:nowrap}
.r .total{display:flex;justify-content:space-between;font-size:15px;font-weight:800;border-top:2px solid #0f172a;padding-top:2mm}
.r .after{display:flex;justify-content:space-between;color:#334155;margin-top:1.5mm}
.r .num{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3mm}
.r .void{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.r .void span{border:3px solid #b91c1c;color:#b91c1c;font-size:22px;font-weight:900;padding:2mm 6mm;transform:rotate(-12deg);opacity:.85}
.r footer{margin-top:4mm;color:#64748b;font-size:10px;text-align:center}`;

export function printReceipt(r: Receipt, lang: string, l: ReceiptLabels) {
  const money = (c: number) => esc(formatMoney(c, r.currency, lang));
  const [y, m, d] = r.localDate.split('-');
  const time = formatClock(
    `${String(Math.floor(r.localMinute / 60)).padStart(2, '0')}:${String(r.localMinute % 60).padStart(2, '0')}`,
    lang,
  );
  const body = `<article class="r">
  ${r.reversed ? `<div class="void"><span>${esc(l.reversed)}</span></div>` : ''}
  <h1><bdi>${esc(r.academy.name)}</bdi></h1>
  <p class="sub">${esc(l.title)} · <span class="num" dir="ltr">${esc(r.receiptNumber)}</span></p>
  <dl>
    <dt>${esc(l.date)}</dt><dd dir="ltr">${esc(`${d}/${m}/${y}`)} · ${esc(time)}</dd>
    <dt>${esc(l.student)}</dt><dd><bdi>${esc(r.student.fullName)}</bdi></dd>
    <dt>${esc(l.code)}</dt><dd class="num" dir="ltr">${esc(r.student.code)}</dd>
    <dt>${esc(l.method)}</dt><dd>${esc(l.methodName)}</dd>
    <dt>${esc(l.collector)}</dt><dd><bdi>${esc(r.collector)}</bdi></dd>
    ${r.note ? `<dt>${esc(l.note)}</dt><dd><bdi>${esc(r.note)}</bdi></dd>` : ''}
  </dl>
  <div>${esc(l.paidFor)}</div>
  <table>${r.lines.map((x) => `<tr><td><bdi>${esc(l.lineLabel(x))}</bdi></td><td class="a" dir="ltr">${money(x.amountCents)}</td></tr>`).join('')}</table>
  <div class="total"><span>${esc(l.total)}</span><span dir="ltr">${money(r.amountCents)}</span></div>
  <div class="after"><span>${esc(l.balanceAfter)}</span><span dir="ltr">${money(r.balanceAfterCents)}</span></div>
  <footer>${esc(l.footer)}</footer>
</article>`;
  printHtml(body, `${l.title} ${r.receiptNumber}`, lang, RECEIPT_CSS);
}

const STATEMENT_CSS = `
.s h1{font-size:15px;margin:0}.s .sub{color:#475569;margin:1mm 0 3mm}
.s table{width:100%;border-collapse:collapse}.s th,.s td{padding:1.4mm 1mm;border-bottom:1px solid #e2e8f0;text-align:start}
.s th{color:#475569;font-weight:600;border-bottom:1.5px solid #0f172a}.s td.a{text-align:end;white-space:nowrap;font-variant-numeric:tabular-nums}
.s .end{margin-top:3mm;font-size:14px;font-weight:800;display:flex;justify-content:space-between}`;

export function printStatement(
  data: {
    academyName: string;
    student: { fullName: string; code: string };
    currency: string;
    rows: { date: string; label: string; deltaCents: number; balanceCents: number }[];
    outstandingCents: number;
  },
  lang: string,
  l: {
    title: string;
    date: string;
    item: string;
    amount: string;
    balance: string;
    outstanding: string;
  },
) {
  const money = (c: number) => esc(formatMoney(c, data.currency, lang));
  const body = `<section class="s">
  <h1><bdi>${esc(data.academyName)}</bdi></h1>
  <p class="sub">${esc(l.title)} · <bdi>${esc(data.student.fullName)}</bdi> · <span dir="ltr">${esc(data.student.code)}</span></p>
  <table><thead><tr><th>${esc(l.date)}</th><th>${esc(l.item)}</th><th class="a">${esc(l.amount)}</th><th class="a">${esc(l.balance)}</th></tr></thead>
  <tbody>${data.rows.map((r) => `<tr><td dir="ltr">${esc(r.date)}</td><td><bdi>${esc(r.label)}</bdi></td><td class="a" dir="ltr">${money(r.deltaCents)}</td><td class="a" dir="ltr">${money(r.balanceCents)}</td></tr>`).join('')}</tbody></table>
  <div class="end"><span>${esc(l.outstanding)}</span><span dir="ltr">${money(data.outstandingCents)}</span></div>
</section>`;
  printHtml(body, l.title, lang, STATEMENT_CSS);
}
