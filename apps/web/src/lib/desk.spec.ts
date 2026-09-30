import { classifyDeskInput, latinDigits, looksLikeCard } from './desk';

const TOKEN = '123456789012345678901234567890123456789012345678';

/** What the desk does with whatever a scanner or a person put in the box. */
describe('desk input', () => {
  it('48 digits are a card — typed by a USB scanner, pasted, or in Arabic digits', () => {
    expect(classifyDeskInput(TOKEN)).toEqual({ kind: 'TOKEN', token: TOKEN });
    expect(classifyDeskInput(` ${TOKEN}\n`)).toEqual({ kind: 'TOKEN', token: TOKEN });
    const arabic = [...TOKEN].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');
    expect(classifyDeskInput(arabic)).toEqual({ kind: 'TOKEN', token: TOKEN });
  });

  it('six digits are a student code, in any digits', () => {
    expect(classifyDeskInput('241513')).toEqual({ kind: 'CODE', code: '241513' });
    expect(classifyDeskInput('٢٤١٥١٣')).toEqual({ kind: 'CODE', code: '241513' });
    expect(classifyDeskInput('۲۴۱۵۱۳')).toEqual({ kind: 'CODE', code: '241513' });
  });

  it('a long run of digits that is not a card is a bad scan — never a search', () => {
    expect(classifyDeskInput(TOKEN.slice(0, 40))).toEqual({ kind: 'BAD_SCAN' });
    expect(classifyDeskInput(TOKEN + '9')).toEqual({ kind: 'BAD_SCAN' });
    expect(looksLikeCard(TOKEN.slice(0, 30))).toBe(true);
    expect(looksLikeCard('01012345678')).toBe(false);
  });

  it('names and phone numbers go to the register search', () => {
    expect(classifyDeskInput('مريم')).toEqual({ kind: 'SEARCH', q: 'مريم' });
    expect(classifyDeskInput('01012345678')).toEqual({ kind: 'SEARCH', q: '01012345678' });
    expect(classifyDeskInput('م')).toEqual({ kind: 'EMPTY' });
    expect(classifyDeskInput('   ')).toEqual({ kind: 'EMPTY' });
  });

  it('reads Arabic-Indic and Persian digits', () => {
    expect(latinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789 0123456789');
  });
});
