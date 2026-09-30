import { csvCell } from './center-students.service';
import { GradeMatcher, GradeRow } from './grade-matcher';
import { displayPhone, parsePhone, phoneField } from './phone';
import { digitsOnly, generateStudentCode, isValidStudentCode, toLatinDigits } from './student-code';

describe('student codes', () => {
  it('generates six digits, never a leading 0, always with a valid check digit', () => {
    for (let i = 0; i < 5000; i++) {
      const c = generateStudentCode();
      expect(c).toMatch(/^[1-9][0-9]{5}$/);
      expect(isValidStudentCode(c)).toBe(true);
    }
  });

  it('catches every single mistyped digit', () => {
    const c = generateStudentCode();
    for (let pos = 0; pos < 6; pos++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === c[pos]) continue;
        const typo = c.slice(0, pos) + d + c.slice(pos + 1);
        expect({ typo, ok: isValidStudentCode(typo) }).toEqual({ typo, ok: false });
      }
    }
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', '012345', 'abcdef', '12 345', '١٢٣٤٥٥']) {
      expect(isValidStudentCode(bad)).toBe(false);
    }
    expect(isValidStudentCode('123455')).toBe(true); // Luhn: 1·2·3·4·5 → check 5
  });
});

describe('digits', () => {
  it('reads Arabic-Indic and Persian digits as 0-9', () => {
    expect(toLatinDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(toLatinDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(toLatinDigits('كود ٤٨٢')).toBe('كود 482');
  });

  it('says whether a query is a number, ignoring spacing and punctuation', () => {
    expect(digitsOnly(' ٠١٠-١٢٣ ٤٥٦٧٨ ')).toBe('01012345678');
    expect(digitsOnly('+20 (10) 1234.5678')).toBe('201012345678');
    expect(digitsOnly('احمد 12')).toBeNull();
    expect(digitsOnly('   ')).toBeNull();
  });
});

describe('phones on the register', () => {
  it('normalises every common way of writing an Egyptian mobile', () => {
    for (const raw of [
      '01012345678',
      '+201012345678',
      '00201012345678',
      '201012345678',
      '010 1234 5678',
      '٠١٠١٢٣٤٥٦٧٨',
    ]) {
      expect(parsePhone(raw)).toBe('+201012345678');
    }
  });

  it('blank is no phone; anything else is invalid, named by field', () => {
    expect(parsePhone('')).toBeNull();
    expect(parsePhone(null)).toBeNull();
    expect(parsePhone('  ')).toBeNull();
    expect(parsePhone('0201234567')).toBe('INVALID'); // a landline
    expect(() => phoneField('123', 'guardianPhone')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ field: 'guardianPhone', code: 'INVALID_PHONE' }),
      }),
    );
  });

  it('shows a number the way it is dialled (and Excel keeps as text)', () => {
    expect(displayPhone('+201012345678')).toBe('010 1234 5678');
    expect(displayPhone(null)).toBe('');
  });
});

describe('CSV cells', () => {
  it('neutralises anything a spreadsheet would run as a formula', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${lead}cmd`)).toBe(`"'${lead}cmd"`);
    }
    expect(csvCell('أحمد "الصغير"')).toBe('"أحمد ""الصغير"""');
  });
});

describe('school year matching', () => {
  const stages: [string, string, string][] = [
    ['prim', 'PRIMARY', 'الابتدائي'],
    ['prep', 'PREPARATORY', 'الإعدادي'],
    ['sec', 'SECONDARY', 'الثانوي'],
  ];
  const ordinals = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'];
  const grades: GradeRow[] = [];
  for (const [code, stage, ar] of stages) {
    const n = stage === 'PRIMARY' ? 6 : 3;
    for (let i = 1; i <= n; i++) {
      grades.push({
        id: `${code}-${i}`,
        code: `${code}-${i}`,
        nameAr: `${ordinals[i - 1]} ${ar}`,
        nameEn: `${code} ${i}`,
        stage,
      });
    }
  }
  const m = new GradeMatcher(grades);

  it.each([
    ['الصف الثالث الثانوي', 'sec-3'],
    ['الثالث الثانوي', 'sec-3'],
    ['3 ثانوي', 'sec-3'],
    ['٣ ثانوي', 'sec-3'],
    ['تالتة ثانوي', 'sec-3'],
    ['ثانية ثانوي', 'sec-2'],
    ['الصف الثاني الثانوي', 'sec-2'],
    ['اولى اعدادي', 'prep-1'],
    ['أولى إعدادي', 'prep-1'],
    ['1 ع', 'prep-1'],
    ['سادسة ابتدائي', 'prim-6'],
    ['sec-1', 'sec-1'],
    ['Secondary 2', 'sec-2'],
  ])('%s → %s', (text, id) => {
    expect(m.match(text)?.id).toBe(id);
  });

  it.each([['ثانوي'], ['3'], ['رابع ثانوي'], ['سابعة جامعة'], ['2 3 ثانوي'], ['']])(
    'does not guess: %s',
    (text) => {
      expect(m.match(text)).toBeNull();
    },
  );
});
