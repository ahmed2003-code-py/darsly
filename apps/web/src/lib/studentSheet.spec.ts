import { cellText, mapHeaders, parseCsv, rowsFromSheet, MAX_SHEET_ROWS } from './studentSheet';

describe('student sheet: headers', () => {
  it('reads the template, Arabic spelling variants and English headers', () => {
    const m = mapHeaders(['اسم الطالب', 'تليفون ولى الامر', 'الصف', 'Group', 'School', 'ملاحظات']);
    expect(m.columns).toEqual({ fullName: 0, guardianPhone: 1, grade: 2, group: 3, school: 4 });
    expect(m.ignored).toEqual(['ملاحظات']);
    expect(m.conflicts).toEqual([]);
  });

  it('never guesses an unknown column, and reports a field claimed twice', () => {
    expect(mapHeaders(['تليفون']).columns).toEqual({}); // "phone" alone is ambiguous in Arabic: not mapped
    expect(mapHeaders(['الاسم', 'اسم الطالب']).conflicts).toEqual(['fullName']);
  });

  it('reads the register export back (round trip)', () => {
    const m = mapHeaders([
      'الكود',
      'الاسم',
      'الصف الدراسي',
      'تليفون الطالب',
      'اسم ولي الأمر',
      'تليفون ولي الأمر',
      'المدرسة',
      'الحالة',
      'المجموعات',
    ]);
    expect(m.columns).toMatchObject({
      fullName: 1,
      grade: 2,
      studentPhone: 3,
      guardianName: 4,
      guardianPhone: 5,
      school: 6,
      group: 8,
    });
    expect(m.ignored).toEqual(['الكود', 'الحالة']);
  });
});

describe('student sheet: rows', () => {
  it('uses sheet row numbers, skips blank rows, keeps numbers as their digits', () => {
    const read = rowsFromSheet([
      [],
      ['اسم الطالب', 'تليفون ولي الأمر'],
      ['أحمد  محمد', 1012345678],
      [null, ''],
      ['سارة', '٠١١٢٣٤٥٦٧٨٩'],
    ]);
    expect(read.problem).toBeNull();
    expect(read.rows).toEqual([
      { row: 3, fullName: 'أحمد محمد', guardianPhone: '1012345678' },
      { row: 5, fullName: 'سارة', guardianPhone: '٠١١٢٣٤٥٦٧٨٩' },
    ]);
  });

  it('refuses a sheet without a name column, an empty one, and one too long', () => {
    expect(rowsFromSheet([['تليفون الطالب'], ['010']]).problem).toEqual({ code: 'NO_NAME_COLUMN' });
    expect(rowsFromSheet([]).problem).toEqual({ code: 'EMPTY' });
    expect(rowsFromSheet([['الاسم']]).problem).toEqual({ code: 'EMPTY' });
    const big = [['الاسم'], ...Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, i) => [`s${i}`])];
    expect(rowsFromSheet(big).problem).toEqual({
      code: 'TOO_MANY_ROWS',
      count: MAX_SHEET_ROWS + 1,
    });
  });

  it('turns only text and numbers into cell text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('');
    expect(cellText(new Date())).toBe('');
    expect(cellText('  a  b ')).toBe('a b');
  });
});

describe('CSV', () => {
  it('handles a BOM, quotes, escaped quotes, commas and CRLF', () => {
    expect(parseCsv('﻿"الاسم","ملاحظة"\r\n"أحمد ""الصغير""","a,b"\r\nسارة,\n')).toEqual([
      ['الاسم', 'ملاحظة'],
      ['أحمد "الصغير"', 'a,b'],
      ['سارة', ''],
    ]);
  });
});
