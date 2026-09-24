/**
 * The pages the pipeline is measured against.
 *
 * Rendered rather than collected: a repository cannot carry photographs of
 * real students' exam papers, and a test suite that needs a scanner is a test
 * suite nobody runs. These are drawn with sharp from SVG and then degraded on
 * purpose — blurred, skewed, shadowed, shrunk — so every case the pipeline
 * claims to handle has something to handle.
 *
 * What this measures honestly: the deterministic half. Whether a shadowed page
 * is detected as shadowed, whether a skewed page's angle is found, whether a
 * seven-question page segments into seven, whether the metrics themselves are
 * right. What it does not measure is how well a model reads Arabic
 * handwriting — no fixture can, and pretending otherwise would be the most
 * misleading thing in this directory.
 */

export interface Fixture {
  id: string;
  /** What the page says, for scoring a transcription against it. */
  reference: string;
  /** How many questions are on it, for scoring segmentation. */
  regions: number;
  /** What this page is meant to be hard about. */
  challenge:
    | 'clean-print'
    | 'handwriting'
    | 'math'
    | 'arabic-numerals'
    | 'fractions'
    | 'percentages'
    | 'decimals'
    | 'low-light'
    | 'skew'
    | 'low-resolution';
  render: RenderSpec;
}

export interface RenderSpec {
  width: number;
  height: number;
  /** Lines of text, in order. */
  lines: string[];
  fontSize: number;
  /** Degrees of rotation applied after rendering. */
  skew?: number;
  /** Gaussian blur sigma. */
  blur?: number;
  /** 0–1: how much of a corner-to-corner brightness gradient to lay over it. */
  shadow?: number;
  /** Scale the finished page down to this fraction, then back up — which is
   *  what a low-resolution photograph actually is. */
  downscale?: number;
  /** Ink darkness, 0–255. Faded handwriting is not black. */
  ink?: number;
  /** A handwriting-ish face, so the strokes are not geometrically perfect. */
  cursive?: boolean;
}

const AR_Q = (n: string, body: string) => `(${n}) ${body}`;

export const FIXTURES: Fixture[] = [
  {
    id: 'clean-print-ar',
    challenge: 'clean-print',
    regions: 3,
    reference: [
      AR_Q('١', 'ما هي عاصمة مصر؟'),
      AR_Q('٢', 'اذكر ثلاثة من حالات المادة.'),
      AR_Q('٣', 'عرّف التمثيل الضوئي في سطرين.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      lines: [
        AR_Q('١', 'ما هي عاصمة مصر؟'),
        '',
        AR_Q('٢', 'اذكر ثلاثة من حالات المادة.'),
        '',
        AR_Q('٣', 'عرّف التمثيل الضوئي في سطرين.'),
      ],
    },
  },
  {
    id: 'arabic-numerals',
    challenge: 'arabic-numerals',
    regions: 2,
    reference: [
      AR_Q('١', 'بلغ معاشه ١٢٨ جنيهًا في السنة السادسة.'),
      AR_Q('٢', 'وزن السنتيمتر المكعب من الزئبق ١٣٫٦ جرامًا.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      lines: [
        AR_Q('١', 'بلغ معاشه ١٢٨ جنيهًا في السنة السادسة.'),
        '',
        AR_Q('٢', 'وزن السنتيمتر المكعب من الزئبق ١٣٫٦ جرامًا.'),
      ],
    },
  },
  {
    id: 'math-fractions',
    challenge: 'fractions',
    regions: 2,
    reference: ['(1) Find √7 / (2 - √7) to 4 decimal places.', '(2) Simplify 3/4 + 5/8.'].join(
      '\n',
    ),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 40,
      lines: ['(1) Find √7 / (2 - √7) to 4 decimal places.', '', '(2) Simplify 3/4 + 5/8.'],
    },
  },
  {
    id: 'percentages-decimals',
    challenge: 'percentages',
    regions: 2,
    reference: [
      '(1) A gold bar is 81% pure by weight; another is 97% pure.',
      '(2) The price fell by 5% from 280.50 to 266.48.',
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      lines: [
        '(1) A gold bar is 81% pure by weight; another is 97% pure.',
        '',
        '(2) The price fell by 5% from 280.50 to 266.48.',
      ],
    },
  },
  {
    id: 'handwriting-faded',
    challenge: 'handwriting',
    regions: 3,
    reference: [
      AR_Q('١', 'يزداد معاش موظف كل سنة زيادة سنوية ثابتة.'),
      AR_Q('٢', 'أوجد قيمة الكسر إلى أربعة أرقام عشرية.'),
      AR_Q('٣', 'ارتفاع الزئبق في أنبوبة ٩٫٣ سم.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 40,
      cursive: true,
      ink: 110,
      blur: 0.6,
      lines: [
        AR_Q('١', 'يزداد معاش موظف كل سنة زيادة سنوية ثابتة.'),
        '',
        AR_Q('٢', 'أوجد قيمة الكسر إلى أربعة أرقام عشرية.'),
        '',
        AR_Q('٣', 'ارتفاع الزئبق في أنبوبة ٩٫٣ سم.'),
      ],
    },
  },
  {
    id: 'mixed-script',
    challenge: 'handwriting',
    regions: 2,
    reference: [
      AR_Q('١', 'اشرح الفرق بين exothermic و endothermic.'),
      AR_Q('٢', 'العدد الذري للكربون Carbon هو 6.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      lines: [
        AR_Q('١', 'اشرح الفرق بين exothermic و endothermic.'),
        '',
        AR_Q('٢', 'العدد الذري للكربون Carbon هو 6.'),
      ],
    },
  },
  {
    id: 'low-light',
    challenge: 'low-light',
    regions: 3,
    reference: [
      AR_Q('١', 'ما هو ناتج تفاعل الحمض مع القاعدة؟'),
      AR_Q('٢', 'اذكر وظيفة الميتوكوندريا.'),
      AR_Q('٣', 'عرّف الأسموزية.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      shadow: 0.55,
      ink: 90,
      lines: [
        AR_Q('١', 'ما هو ناتج تفاعل الحمض مع القاعدة؟'),
        '',
        AR_Q('٢', 'اذكر وظيفة الميتوكوندريا.'),
        '',
        AR_Q('٣', 'عرّف الأسموزية.'),
      ],
    },
  },
  {
    id: 'skewed',
    challenge: 'skew',
    regions: 3,
    reference: [
      AR_Q('١', 'اكتب معادلة التمثيل الضوئي.'),
      AR_Q('٢', 'ما هي وحدة قياس القوة؟'),
      AR_Q('٣', 'احسب مساحة دائرة نصف قطرها ٧ سم.'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 38,
      skew: 3.5,
      lines: [
        AR_Q('١', 'اكتب معادلة التمثيل الضوئي.'),
        '',
        AR_Q('٢', 'ما هي وحدة قياس القوة؟'),
        '',
        AR_Q('٣', 'احسب مساحة دائرة نصف قطرها ٧ سم.'),
      ],
    },
  },
  {
    id: 'low-resolution',
    challenge: 'low-resolution',
    regions: 3,
    reference: [
      AR_Q('١', 'عرّف الكثافة.'),
      AR_Q('٢', 'اذكر قانون نيوتن الأول.'),
      AR_Q('٣', 'ما الفرق بين الكتلة والوزن؟'),
    ].join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 34,
      downscale: 0.28,
      lines: [
        AR_Q('١', 'عرّف الكثافة.'),
        '',
        AR_Q('٢', 'اذكر قانون نيوتن الأول.'),
        '',
        AR_Q('٣', 'ما الفرق بين الكتلة والوزن؟'),
      ],
    },
  },
  {
    id: 'dense-seven',
    challenge: 'math',
    regions: 7,
    reference: Array.from({ length: 7 }, (_, i) =>
      AR_Q(String(i + 1), `السؤال رقم ${i + 1} عن الحساب والأرقام مثل ${(i + 1) * 128}.`),
    ).join('\n'),
    render: {
      width: 1240,
      height: 1754,
      fontSize: 32,
      lines: Array.from({ length: 7 }, (_, i) => [
        AR_Q(String(i + 1), `السؤال رقم ${i + 1} عن الحساب والأرقام مثل ${(i + 1) * 128}.`),
        '',
      ]).flat(),
    },
  },
];

/** Render a fixture to PNG bytes. Deterministic: the same fixture always
 *  produces the same pixels, so a test that passes today passes tomorrow. */
export async function renderFixture(spec: RenderSpec): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  const ink = spec.ink ?? 25;
  const colour = `rgb(${ink},${ink},${Math.min(255, ink + 40)})`;
  const family = spec.cursive ? 'cursive, serif' : 'serif';
  const lineHeight = Math.round(spec.fontSize * 1.9);

  const texts = spec.lines
    .map((line, i) =>
      line
        ? `<text x="${spec.width - 70}" y="${120 + i * lineHeight}" font-family="${family}" font-size="${spec.fontSize}" fill="${colour}" text-anchor="start" direction="rtl">${escapeXml(line)}</text>`
        : '',
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}"><rect width="100%" height="100%" fill="#fdfbf4"/>${texts}</svg>`;

  let image = sharp(Buffer.from(svg));
  if (spec.skew)
    image = sharp(await image.png().toBuffer()).rotate(spec.skew, { background: '#fdfbf4' });
  if (spec.blur) image = sharp(await image.png().toBuffer()).blur(spec.blur);

  if (spec.shadow) {
    // A corner-to-corner gradient laid over the page: one side of the paper
    // brighter than the other, which is what a hand-held photograph looks like.
    const grad = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="${spec.shadow}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    image = sharp(await image.png().toBuffer()).composite([
      { input: Buffer.from(grad), blend: 'multiply' },
    ]);
  }

  if (spec.downscale) {
    const small = await sharp(await image.png().toBuffer())
      .resize({ width: Math.max(80, Math.round(spec.width * spec.downscale)) })
      .png()
      .toBuffer();
    // Back up, which is what makes it low resolution rather than merely small.
    image = sharp(small).resize({ width: spec.width, kernel: 'nearest' });
  }

  return image.png().toBuffer();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
