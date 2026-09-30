/**
 * Reading a center's student spreadsheet into rows the API can interpret.
 *
 * Pure: no DOM, no network — the file is opened elsewhere (read-excel-file
 * for .xlsx, `parseCsv` here for .csv). This only decides which column is
 * which, and turns every cell into plain text. Deciding what the text MEANS
 * (is it a valid phone, which school year, which group) is the server's job,
 * with the same rules as a desk registration; nothing here is trusted by it.
 */

export type SheetField =
  'fullName' | 'studentPhone' | 'guardianName' | 'guardianPhone' | 'school' | 'grade' | 'group';

export const SHEET_FIELDS: SheetField[] = [
  'fullName',
  'studentPhone',
  'guardianName',
  'guardianPhone',
  'school',
  'grade',
  'group',
];

/** The template's headers, in its column order (Arabic — the language centers keep their sheets in). */
export const TEMPLATE_HEADERS: Record<SheetField, string> = {
  fullName: 'اسم الطالب',
  studentPhone: 'تليفون الطالب',
  guardianName: 'اسم ولي الأمر',
  guardianPhone: 'تليفون ولي الأمر',
  school: 'المدرسة',
  grade: 'الصف الدراسي',
  group: 'المجموعة',
};

/** The most rows one import may carry — the API refuses more (IMPORT_MAX_ROWS). */
export const MAX_SHEET_ROWS = 5000;
/** A bigger file is not a student list. */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;

/** Header text → field. Exact matches only (after folding), so an unknown column is never guessed. */
const ALIASES: Record<SheetField, string[]> = {
  fullName: [
    'اسم الطالب',
    'الاسم',
    'الاسم بالكامل',
    'اسم الطالب بالكامل',
    'الطالب',
    'name',
    'student name',
    'full name',
    'student',
  ],
  studentPhone: [
    'تليفون الطالب',
    'موبايل الطالب',
    'رقم الطالب',
    'هاتف الطالب',
    'رقم تليفون الطالب',
    'student phone',
    'student mobile',
    'phone',
    'mobile',
  ],
  guardianName: [
    'اسم ولي الأمر',
    'ولي الأمر',
    'اسم ولي الامر',
    'اسم الأب',
    'اسم الاب',
    'guardian name',
    'parent name',
    'guardian',
    'parent',
  ],
  guardianPhone: [
    'تليفون ولي الأمر',
    'موبايل ولي الأمر',
    'رقم ولي الأمر',
    'هاتف ولي الأمر',
    'تليفون الأب',
    'رقم الأب',
    'guardian phone',
    'parent phone',
    'guardian mobile',
    'parent mobile',
  ],
  school: ['المدرسة', 'اسم المدرسة', 'school'],
  grade: [
    'الصف الدراسي',
    'الصف',
    'السنة الدراسية',
    'السنة',
    'المرحلة',
    'grade',
    'year',
    'class year',
  ],
  group: ['المجموعة', 'المجموعات', 'اسم المجموعة', 'group', 'group name'],
};

/** Folding for header matching: the spelling differences a person makes, and nothing more. */
export function foldHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[_\-:.*]/g, ' ')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

const LOOKUP = new Map<string, SheetField>();
for (const f of SHEET_FIELDS) for (const a of ALIASES[f]) LOOKUP.set(foldHeader(a), f);

export interface ColumnMap {
  /** field → column index */
  columns: Partial<Record<SheetField, number>>;
  /** Headers that named no field (shown to the operator; never imported). */
  ignored: string[];
  /** A field two columns both claimed — the operator must fix the sheet. */
  conflicts: SheetField[];
}

export function mapHeaders(header: unknown[]): ColumnMap {
  const columns: Partial<Record<SheetField, number>> = {};
  const ignored: string[] = [];
  const conflicts = new Set<SheetField>();
  header.forEach((h, i) => {
    const text = cellText(h);
    if (!text) return;
    const field = LOOKUP.get(foldHeader(text));
    if (!field) {
      ignored.push(text);
      return;
    }
    if (columns[field] !== undefined) conflicts.add(field);
    else columns[field] = i;
  });
  return { columns, ignored, conflicts: [...conflicts] };
}

/**
 * A cell as text. Numbers come back as their digits: a phone typed into
 * Excel as a number has lost its leading 0 (1012345678), which the server
 * accepts; `1.012345678E9` must never reach it, so no float formatting.
 */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return '';
  if (v instanceof Date) return '';
  return String(v)
    .replace(/[\s ]+/g, ' ')
    .trim();
}

export interface SheetRow {
  row: number;
  fullName?: string;
  studentPhone?: string;
  guardianName?: string;
  guardianPhone?: string;
  school?: string;
  grade?: string;
  group?: string;
}

export type SheetProblem =
  | { code: 'EMPTY' }
  | { code: 'NO_NAME_COLUMN' }
  | { code: 'DUPLICATE_COLUMNS'; fields: SheetField[] }
  | { code: 'TOO_MANY_ROWS'; count: number };

export interface ReadSheet {
  rows: SheetRow[];
  ignored: string[];
  problem: SheetProblem | null;
}

/**
 * The first row is the header; every later row that has anything in it is a
 * student. Row numbers are the sheet's own (header = 1), so an error report
 * points at the line the operator sees in Excel.
 */
export function rowsFromSheet(data: unknown[][]): ReadSheet {
  const firstFilled = data.findIndex((r) => r.some((c) => cellText(c)));
  if (firstFilled < 0) return { rows: [], ignored: [], problem: { code: 'EMPTY' } };
  const map = mapHeaders(data[firstFilled]);
  if (map.conflicts.length) {
    return {
      rows: [],
      ignored: map.ignored,
      problem: { code: 'DUPLICATE_COLUMNS', fields: map.conflicts },
    };
  }
  if (map.columns.fullName === undefined) {
    return { rows: [], ignored: map.ignored, problem: { code: 'NO_NAME_COLUMN' } };
  }
  const rows: SheetRow[] = [];
  for (let i = firstFilled + 1; i < data.length; i++) {
    const r = data[i] ?? [];
    const out: SheetRow = { row: i + 1 };
    let any = false;
    for (const f of SHEET_FIELDS) {
      const col = map.columns[f];
      if (col === undefined) continue;
      const text = cellText(r[col]).slice(0, f.endsWith('Phone') ? 32 : 120);
      if (text) {
        out[f] = text;
        any = true;
      }
    }
    if (any) rows.push(out);
  }
  if (!rows.length) return { rows: [], ignored: map.ignored, problem: { code: 'EMPTY' } };
  if (rows.length > MAX_SHEET_ROWS) {
    return {
      rows: [],
      ignored: map.ignored,
      problem: { code: 'TOO_MANY_ROWS', count: rows.length },
    };
  }
  return { rows, ignored: map.ignored, problem: null };
}

/** RFC 4180-ish CSV (quoted fields, "" escapes, CRLF or LF), BOM tolerated. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}
