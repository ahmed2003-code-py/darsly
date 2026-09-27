import {
  clientErrors,
  firstInvalid,
  LIVE_SESSION_RULES,
  messageKey,
  serverErrors,
  toPayload,
  combine,
  formatTime12,
  localTime,
  nextSlot,
  splitStart,
  asciiDigits,
  clockSkew,
  formatDuration,
  commerceErrors,
  type LiveFormValues,
} from './liveSessionForm';
import i18next from 'i18next';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';

const NOW = new Date('2026-09-26T10:00:00Z').getTime();
// datetime-local values are local time; build them from a Date so the test is
// independent of the machine's zone.
const local = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const ok: LiveFormValues = {
  title: 'مراجعة الفيزياء',
  description: '',
  startsAt: local(NOW + 60 * 60_000),
  durationMin: '60',
  capacity: '',
};

describe('the new-session form', () => {
  it('accepts a normal session', () => {
    expect(clientErrors(ok, NOW)).toEqual({});
  });

  it('puts each problem on its field, with the rule it broke', () => {
    const e = clientErrors({ ...ok, title: '', durationMin: '2', capacity: '0' }, NOW);
    expect(e.title?.code).toBe('TITLE_REQUIRED');
    expect(e.durationMin).toEqual({
      code: 'DURATION_TOO_SHORT',
      params: { min: LIVE_SESSION_RULES.durationMin },
    });
    expect(e.capacity?.code).toBe('CAPACITY_TOO_SMALL');
    expect(messageKey(e.durationMin!.code)).toBe('live.v.DURATION_TOO_SHORT');
  });

  it('refuses a start in the past and an empty date', () => {
    expect(clientErrors({ ...ok, startsAt: local(NOW - 60 * 60_000) }, NOW).startsAt?.code).toBe(
      'STARTS_AT_PAST',
    );
    expect(clientErrors({ ...ok, startsAt: '' }, NOW).startsAt?.code).toBe('STARTS_AT_REQUIRED');
  });

  it('focuses the first invalid field in form order', () => {
    const e = clientErrors({ ...ok, durationMin: '', title: '' }, NOW);
    expect(firstInvalid(e)).toBe('title');
    expect(firstInvalid(clientErrors({ ...ok, capacity: 'x', durationMin: '1000' }, NOW))).toBe(
      'durationMin',
    );
    expect(firstInvalid({})).toBeNull();
  });

  it('maps the server refusal to the same fields', () => {
    const err = {
      response: {
        data: {
          code: 'LIVE_SESSION_INVALID',
          fields: [
            { field: 'startsAt', code: 'STARTS_AT_PAST' },
            { field: 'durationMin', code: 'DURATION_TOO_SHORT', params: { min: 5 } },
            { field: 'somethingElse', code: 'X' },
          ],
        },
      },
    };
    expect(serverErrors(err)).toEqual({
      startsAt: { code: 'STARTS_AT_PAST', params: {} },
      durationMin: { code: 'DURATION_TOO_SHORT', params: { min: 5 } },
    });
  });

  it('maps a DTO shape refusal to its field without the internal sentence', () => {
    const err = { response: { data: { message: ['title must be a string', 'noise'] } } };
    expect(serverErrors(err)).toEqual({ title: { code: 'INVALID', params: {} } });
  });

  it('leaves errors that belong to no field to the banner', () => {
    expect(serverErrors({ response: { data: { code: 'TEACHER_CONFLICT', message: 'x' } } })).toEqual({});
    expect(serverErrors(new Error('Network Error'))).toEqual({});
  });

  it('offers sensible times: the next half hour, a 12-hour clock', () => {
    const at = new Date(2026, 8, 26, 19, 7).getTime(); // 19:07 local
    expect(localTime(nextSlot(at))).toBe('19:30');
    expect(splitStart(combine('2026-09-26', '19:30'))).toEqual({ date: '2026-09-26', time: '19:30' });
    expect(formatTime12('19:30', 'ar')).toBe('7:30 م');
    expect(formatTime12('21:37', 'ar')).toBe('9:37 م');
    expect(formatTime12('00:15', 'en')).toBe('12:15 AM');
  });

  it('keeps any exact minute and converts local wall-clock to UTC exactly once', () => {
    for (const time of ['09:07', '21:37', '21:58', '00:01']) {
      const p = toPayload({ ...ok, startsAt: combine('2026-09-27', time) }, '');
      const back = new Date(p.startsAt);
      // Read back in local time, it is the minute the teacher picked, on the day picked.
      expect(localTime(back.getTime())).toBe(time);
      expect(back.getDate()).toBe(27);
      expect(back.getSeconds()).toBe(0);
      // And the instant is local-midnight + h:m, not shifted by the zone twice.
      const [h, m] = time.split(':').map(Number);
      expect(back.getTime()).toBe(new Date(2026, 8, 27, h, m).getTime());
    }
  });

  it('refuses a time already gone, but not the current minute', () => {
    const now = new Date(2026, 8, 26, 21, 37, 40).getTime(); // 21:37:40 local
    expect(clientErrors({ ...ok, startsAt: combine('2026-09-26', '21:37') }, now).startsAt).toBeUndefined();
    expect(clientErrors({ ...ok, startsAt: combine('2026-09-26', '21:36') }, now).startsAt?.code).toBe(
      'STARTS_AT_PAST',
    );
    expect(clientErrors({ ...ok, startsAt: combine('2026-09-25', '23:59') }, now).startsAt?.code).toBe(
      'STARTS_AT_PAST',
    );
  });

  it('refuses whitespace titles and rejects bad numbers instead of fixing them', () => {
    expect(clientErrors({ ...ok, title: '   ' }, NOW).title?.code).toBe('TITLE_REQUIRED');
    expect(clientErrors({ ...ok, title: ' a ' }, NOW).title?.code).toBe('TITLE_TOO_SHORT');
    expect(clientErrors({ ...ok, durationMin: '1.5' }, NOW).durationMin?.code).toBe('DURATION_INVALID');
    expect(clientErrors({ ...ok, durationMin: '721' }, NOW).durationMin?.code).toBe('DURATION_TOO_LONG');
    expect(clientErrors({ ...ok, durationMin: '720' }, NOW).durationMin).toBeUndefined();
    expect(clientErrors({ ...ok, durationMin: '70' }, NOW).durationMin).toBeUndefined();
    expect(clientErrors({ ...ok, capacity: '0' }, NOW).capacity?.code).toBe('CAPACITY_TOO_SMALL');
    expect(clientErrors({ ...ok, capacity: '-3' }, NOW).capacity?.code).toBe('CAPACITY_INVALID');
    expect(clientErrors({ ...ok, capacity: '2.5' }, NOW).capacity?.code).toBe('CAPACITY_INVALID');
    expect(clientErrors({ ...ok, capacity: '100001' }, NOW).capacity?.code).toBe('CAPACITY_TOO_LARGE');
    expect(clientErrors({ ...ok, capacity: '100000' }, NOW).capacity).toBeUndefined();
  });

  it('asks for a number when "limit" is chosen but left empty', () => {
    expect(clientErrors({ ...ok, capacity: '' }, NOW, { capacityRequired: true }).capacity?.code).toBe(
      'CAPACITY_REQUIRED',
    );
    expect(clientErrors({ ...ok, capacity: '' }, NOW).capacity).toBeUndefined();
  });

  it('reads Arabic-Indic digits as numbers and touches nothing else', () => {
    expect(asciiDigits('٧٠')).toBe('70');
    expect(asciiDigits('۱۲')).toBe('12');
    expect(asciiDigits('1.5')).toBe('1.5');
  });

  it('corrects a wrong device clock, ignoring network noise', () => {
    const received = Date.UTC(2026, 8, 26, 10, 0, 0);
    expect(clockSkew(new Date(received + 10 * 60_000).toISOString(), received)).toBe(10 * 60_000);
    expect(clockSkew(new Date(received - 7 * 60_000).toISOString(), received)).toBe(-7 * 60_000);
    expect(clockSkew(new Date(received + 2_000).toISOString(), received)).toBe(0);
    expect(clockSkew(undefined, received)).toBe(0);
  });

  it('says a length the way people do, in Arabic and English', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'ar',
      resources: { ar: { translation: ar }, en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    const t = i18n.t.bind(i18n) as unknown as Parameters<typeof formatDuration>[1];
    expect(formatDuration(45, t)).toBe('45 دقيقة');
    expect(formatDuration(70, t)).toBe('ساعة و10 دقائق');
    expect(formatDuration(60, t)).toBe('ساعة');
    expect(formatDuration(120, t)).toBe('ساعتين');
    expect(formatDuration(150, t)).toBe('ساعتين و30 دقيقة');
    expect(formatDuration(180, t)).toBe('3 ساعات');
    expect(formatDuration(62, t)).toBe('ساعة ودقيقتان');
    await i18n.changeLanguage('en');
    expect(formatDuration(70, t)).toBe('1 hour 10 minutes');
  });

  it('sends numbers, trims text, and null for no capacity', () => {
    const p = toPayload({ ...ok, title: '  عنوان ', capacity: '' }, '');
    expect(p).toMatchObject({ title: 'عنوان', durationMin: 60, capacity: null, joinUrl: null });
    expect(typeof p.startsAt).toBe('string');
    expect(toPayload({ ...ok, capacity: '30' }, '').capacity).toBe(30);
  });

  it('checks a PAID price the way the server reads it — exact piasters, strict format, bounds in EGP', () => {
    const base = { paid: true, replayPolicy: 'INCLUDED_FOREVER' as const, replayDays: '' };
    expect(commerceErrors({ ...base, price: '' }).priceCents?.code).toBe('PRICE_REQUIRED');
    for (const bad of ['abc', '1.005', '-5', '1e3', '12.', '1,000']) {
      expect(commerceErrors({ ...base, price: bad }).priceCents?.code).toBe('PRICE_INVALID');
    }
    expect(commerceErrors({ ...base, price: '0' }).priceCents).toEqual({ code: 'PRICE_TOO_LOW', params: { min: 1 } });
    expect(commerceErrors({ ...base, price: '1000001' }).priceCents).toEqual({ code: 'PRICE_TOO_HIGH', params: { max: 1_000_000 } });
    for (const good of ['50', '75', '100', '149.50', '149.5', '٧٥']) {
      expect(commerceErrors({ ...base, price: good }).priceCents).toBeUndefined();
    }
    // FREE never has a price problem.
    expect(commerceErrors({ ...base, paid: false, price: 'abc' })).toEqual({});
  });

  it('checks replay days only when replay is limited to days', () => {
    const base = { paid: true, price: '100' };
    expect(commerceErrors({ ...base, replayPolicy: 'INCLUDED_DAYS', replayDays: '0' }).replayDays?.code).toBe('REPLAY_DAYS_INVALID');
    expect(commerceErrors({ ...base, replayPolicy: 'INCLUDED_DAYS', replayDays: '2.5' }).replayDays?.code).toBe('REPLAY_DAYS_INVALID');
    expect(commerceErrors({ ...base, replayPolicy: 'INCLUDED_DAYS', replayDays: '7' }).replayDays).toBeUndefined();
    expect(commerceErrors({ ...base, replayPolicy: 'NONE', replayDays: 'x' }).replayDays).toBeUndefined();
  });

  it('shows the server’s price bounds in EGP, not piasters', () => {
    const err = { response: { data: { fields: [{ field: 'priceCents', code: 'PRICE_TOO_LOW', params: { min: 100 } }] } } };
    expect(serverErrors(err).priceCents).toEqual({ code: 'PRICE_TOO_LOW', params: { min: 1 } });
  });
});
