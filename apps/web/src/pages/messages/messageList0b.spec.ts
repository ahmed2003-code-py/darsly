import type { ChatMessageDto } from '@darsly/shared-types';
import { applyReactions, applySeen, LocalMessage, localId } from './messageList';
import { runPositions, dayLabel, formatBytes } from './format';
import { shouldSendOnKey } from './composerKeys';
import { initials, avatarTone } from '../../lib/initials';
import { tokenizeLinks } from '../../lib/linkTokens';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString();
const msg = (id: string, min: number, extra: Partial<ChatMessageDto> = {}): LocalMessage =>
  ({
    id,
    threadId: 't',
    senderId: 'me',
    senderName: 'Me',
    senderRole: 'STUDENT',
    body: id,
    readAt: null,
    createdAt: at(min),
    mine: true,
    ...extra,
  }) as LocalMessage;

describe('initials', () => {
  it.each([
    ['Ahmed Mohamed', 'AM'],
    ['Ahmed', 'A'],
    ['ahmed mohamed ali', 'AA'],
    ['أحمد محمد', 'أم'],
    ['أ. عمرو فاروق', 'عف'],
    ['Dr. Sara Adel', 'SA'],
    ['TEST · طالب اختبار 1 (smoke)', 'TS'],
    ['   ', '؟'],
    ['', '؟'],
    [null, '؟'],
  ])('%s → %s', (name, out) => expect(initials(name as string)).toBe(out));

  it('a person keeps one colour', () => {
    expect(avatarTone('user-1')).toBe(avatarTone('user-1'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(avatarTone)).size).toBeGreaterThan(1);
  });
});

describe('tokenizeLinks', () => {
  const links = (s: string) =>
    tokenizeLinks(s)
      .filter((t) => t.type === 'link')
      .map((t) => (t as any).href);
  it('finds http(s) and www links, trimming sentence punctuation (Arabic too)', () => {
    expect(links('see https://darsly.app/x, then www.example.com.')).toEqual([
      'https://darsly.app/x',
      'https://www.example.com',
    ]);
    expect(links('الرابط: https://example.com/a?b=1، شكراً؟')).toEqual([
      'https://example.com/a?b=1',
    ]);
    expect(links('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });
  it('never makes a javascript:, data: or bare word clickable', () => {
    expect(links('javascript:alert(1) data:text/html,<b> example.com http://x')).toEqual([]);
  });
  it('keeps the text around links intact', () => {
    const t = tokenizeLinks('a https://x.io b');
    expect(t.map((x) => x.value).join('')).toBe('a https://x.io b');
  });
});

describe('runPositions', () => {
  it('groups one person’s messages within 5 minutes into a turn', () => {
    const r = runPositions([
      { senderId: 'a', createdAt: at(0) },
      { senderId: 'a', createdAt: at(2) },
      { senderId: 'a', createdAt: at(9) },
      { senderId: 'b', createdAt: at(9) },
    ]);
    expect(r).toEqual([
      { first: true, last: false },
      { first: false, last: true },
      { first: true, last: true },
      { first: true, last: true },
    ]);
  });
});

describe('dayLabel / bytes', () => {
  const now = new Date(2026, 0, 10, 12);
  it('today, yesterday, weekday, date', () => {
    expect(dayLabel('2026-1-10', 'en', now)).toEqual({ kind: 'today' });
    expect(dayLabel('2026-1-9', 'en', now)).toEqual({ kind: 'yesterday' });
    expect(dayLabel('2026-1-6', 'en', now)).toMatchObject({ kind: 'date', text: 'Tuesday' });
    expect(dayLabel('2025-12-1', 'en', now)).toMatchObject({
      kind: 'date',
      text: expect.stringContaining('2025'),
    });
  });
  it('sizes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(2.4 * 1024 * 1024, 'en')).toBe('2.4 MB');
  });
});

describe('shouldSendOnKey', () => {
  const k = (o: object) => ({ key: 'Enter', ...o });
  it('desktop: Enter sends, Shift+Enter does not', () => {
    expect(shouldSendOnKey(k({}), false)).toBe(true);
    expect(shouldSendOnKey(k({ shiftKey: true }), false)).toBe(false);
  });
  it('never while an IME is composing', () => {
    expect(shouldSendOnKey(k({ isComposing: true }), false)).toBe(false);
    expect(shouldSendOnKey(k({ keyCode: 229 }), false)).toBe(false);
  });
  it('touch: Enter is a new line; Ctrl/⌘+Enter sends', () => {
    expect(shouldSendOnKey(k({}), true)).toBe(false);
    expect(shouldSendOnKey(k({ ctrlKey: true }), true)).toBe(true);
  });
  it('other keys never send', () => expect(shouldSendOnKey({ key: 'a' }, false)).toBe(false));
});

describe('live updates', () => {
  it('applyReactions replaces one message’s reactions only', () => {
    const list = [msg('a', 0), msg('b', 1)];
    const next = applyReactions(list, 'b', [{ emoji: '👍', count: 1, mine: false, names: ['X'] }]);
    expect(next[0]).toBe(list[0]);
    expect(next[1].reactions).toHaveLength(1);
    expect(applyReactions(list, 'zzz', [])).toBe(list);
  });
  it('applySeen marks my stored messages up to the position, never theirs or pending ones', () => {
    const list = [
      msg('a', 0),
      msg('b', 5),
      msg('c', 1, { mine: false }),
      { ...msg(localId('x'), 0), status: 'sending' as const },
    ];
    const next = applySeen(list, at(1));
    expect(next.map((m) => !!m.readAt)).toEqual([true, false, false, false]);
  });
});
