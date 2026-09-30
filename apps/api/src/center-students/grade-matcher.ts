import { toLatinDigits } from './student-code';

/**
 * Which school year a spreadsheet cell means.
 *
 * Centers write the year every way there is: "الصف الثالث الثانوي",
 * "3 ثانوي", "تالتة ثانوي", "ثالثة ث", "Secondary 3", "sec-3". The catalogue
 * has one row per year (GradeLevel), each with a stage. So a cell is read as
 * a (stage, number) pair and matched to the one row that has both — or to a
 * row's exact code / Arabic / English name. Anything that names no row, or
 * could be more than one, is not guessed: the import row gets an error and
 * the operator fixes the cell.
 */

export interface GradeRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  stage: string | null;
}

/** Same folding as the SQL name key, for the handful of words matched here. */
function fold(s: string): string {
  return toLatinDigits(s)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\s _\-.،,/]+/g, ' ')
    .trim();
}

const STAGE_WORDS: [RegExp, string][] = [
  [/(^| )(ال)?ابتدائي?( |$)|(^| )ابتدا|primary|(^| )prim( |$)/, 'PRIMARY'],
  [/(^| )(ال)?اعدادي?( |$)|(^| )اعدا|prep|preparatory|(^| )(ع)( |$)/, 'PREPARATORY'],
  [/(^| )(ال)?ثانوي?( |$)|(^| )ثانو|secondary|(^| )sec( |$)|(^| )(ث)( |$)/, 'SECONDARY'],
  [/بكالوريا|باكالوريا|(^| )باك( |$)|baccalaureate|(^| )bacc?( |$)/, 'BACCALAUREATE'],
];

/** Ordinal words (Standard and Egyptian, masculine and feminine) → number. */
const ORDINALS: [RegExp, number][] = [
  [/(^| )(ال)?(اول|اولي|اولى)( |$)|first/, 1],
  [/(^| )(ال)?(ثاني|ثانيه|تاني|تانيه)( |$)|second/, 2],
  [/(^| )(ال)?(ثالث|ثالثه|تالت|تالته)( |$)|third/, 3],
  [/(^| )(ال)?(رابع|رابعه)( |$)|fourth/, 4],
  [/(^| )(ال)?(خامس|خامسه)( |$)|fifth/, 5],
  [/(^| )(ال)?(سادس|سادسه)( |$)|sixth/, 6],
];

function stageOf(s: string): string | null {
  const hits = STAGE_WORDS.filter(([re]) => re.test(s)).map(([, st]) => st);
  // "ثانوي" also appears inside no other stage word, but guard anyway: two
  // stages named in one cell is a question, not an answer.
  return hits.length === 1 ? hits[0] : null;
}

function numberOf(s: string): number | null {
  // Lookarounds, so "2 3" yields both numbers (a consumed space would hide the 3).
  const nums = [...s.matchAll(/(?<=^| )([1-6])(?= |$)/g)].map((m) => Number(m[1]));
  const words = ORDINALS.filter(([re]) => re.test(s)).map(([, n]) => n);
  // "الصف الثاني الثانوي": ثانوي is a stage, not the ordinal — the ordinal
  // patterns require the whole word, so ثانوي never matches ثاني.
  const all = [...new Set([...nums, ...words])];
  return all.length === 1 ? all[0] : null;
}

export class GradeMatcher {
  private readonly exact = new Map<string, GradeRow | null>();

  constructor(private readonly grades: GradeRow[]) {
    const put = (k: string, g: GradeRow) => {
      const key = fold(k);
      if (!key) return;
      const had = this.exact.get(key);
      // A key two rows share identifies neither.
      this.exact.set(key, had === undefined || had?.id === g.id ? g : null);
    };
    for (const g of grades) {
      put(g.code, g);
      put(g.nameAr, g);
      put(g.nameEn, g);
      put(`الصف ${g.nameAr}`, g);
    }
  }

  /** The one year this text names, or null. */
  match(raw: string): GradeRow | null {
    const s = fold(raw);
    if (!s) return null;
    const direct = this.exact.get(s);
    if (direct !== undefined) return direct;
    const stage = stageOf(s);
    const n = numberOf(s);
    if (!stage || !n) return null;
    const found = this.grades.filter((g) => g.stage === stage && g.code.endsWith(`-${n}`));
    return found.length === 1 ? found[0] : null;
  }
}
