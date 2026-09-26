import {
  clientErrors,
  firstInvalid,
  LIVE_SESSION_RULES,
  messageKey,
  serverErrors,
  toPayload,
  type LiveFormValues,
} from './liveSessionForm';

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

  it('sends numbers, trims text, and null for no capacity', () => {
    const p = toPayload({ ...ok, title: '  عنوان ', capacity: '' }, '');
    expect(p).toMatchObject({ title: 'عنوان', durationMin: 60, capacity: null, joinUrl: null });
    expect(typeof p.startsAt).toBe('string');
    expect(toPayload({ ...ok, capacity: '30' }, '').capacity).toBe(30);
  });
});
