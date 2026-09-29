import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { ApiExceptionFilter } from './api-exception.filter';
import { validationExceptionFactory } from './validation-exception.factory';
import { requestIdMiddleware } from '../request-context';

/**
 * The error contract, end to end through the filter: what a client receives
 * for every kind of failure, and — just as important — what it never does.
 */

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`studentId`,`courseId`) in table "Enrollment"',
    { code, clientVersion: '5.22.0', meta },
  );
}

function mockHost(opts: { route?: string; headers?: Record<string, string> } = {}) {
  const json = jest.fn();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const res = {
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json,
    getHeader: (k: string) => headers[k],
  };
  (res.status as jest.Mock).mockReturnValue(res);
  const req = {
    method: 'POST',
    baseUrl: '',
    path: '/api/v1/staff/students/ckabc/guardians',
    route: opts.route ? { path: opts.route } : undefined,
    headers: {},
    user: { sub: 'user-1' },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, res, json };
}

/** Run inside a request context, as production does, so requestId is set. */
function inRequest<T>(fn: () => T): T {
  let out!: T;
  const res = { setHeader: jest.fn() };
  requestIdMiddleware({ headers: { 'x-request-id': 'req-123' } } as never, res as never, () => {
    out = fn();
  });
  return out;
}

describe('ApiExceptionFilter', () => {
  let filter: ApiExceptionFilter;
  beforeEach(() => {
    filter = new ApiExceptionFilter();
    for (const lvl of ['log', 'warn', 'error'] as const)
      jest.spyOn(filter['logger'], lvl).mockImplementation(() => undefined);
  });

  const send = (e: unknown, opts?: Parameters<typeof mockHost>[0]) =>
    inRequest(() => {
      const h = mockHost(opts);
      filter.catch(e, h.host);
      return {
        status: (h.res.status as jest.Mock).mock.calls[0][0],
        body: h.json.mock.calls[0][0],
      };
    });

  it('keeps a coded refusal exactly, and completes the envelope', () => {
    const { status, body } = send(
      new ConflictException({ code: 'PHONE_IN_USE', message: 'Phone in use', field: 'phone' }),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      code: 'PHONE_IN_USE',
      message: 'Phone in use',
      field: 'phone',
      retryable: false,
      requestId: 'req-123',
    });
  });

  it('keeps structured extras a thrower attached (params, counts)', () => {
    const { body } = send(
      new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: 'x', balanceCents: 500 }),
    );
    expect(body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', balanceCents: 500 });
  });

  it.each([
    [400, 'BAD_REQUEST', () => new BadRequestException('Empty message')],
    [403, 'FORBIDDEN', () => new ForbiddenException()],
    [404, 'NOT_FOUND', () => new NotFoundException('Student not found')],
    [409, 'CONFLICT', () => new ConflictException('dup')],
    [413, 'PAYLOAD_TOO_LARGE', () => new PayloadTooLargeException('File too large')],
  ])('an uncoded %i gets the generic code %s', (s, code, make) => {
    const { status, body } = send(make());
    expect(status).toBe(s);
    expect(body.code).toBe(code);
    expect(body).not.toHaveProperty('error'); // Nest's reason phrase is dropped
  });

  it('never changes the status of an HttpException (a hiding 404 stays a 404)', () => {
    const { status, body } = send(new NotFoundException('Not found'));
    expect(status).toBe(404);
    expect(body.message).toBe('Not found');
  });

  it('answers anything unexpected with a bare 500 and a reference id — no internals', () => {
    const { status, body } = send(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 at Object.<anonymous>'),
    );
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: true,
      requestId: 'req-123',
    });
  });

  it('logs the unexpected failure with its stack and the route template, not the raw path', () => {
    inRequest(() => {
      const h = mockHost({ route: '/api/v1/staff/students/:studentId/guardians' });
      const e = new TypeError('boom');
      filter.catch(e, h.host);
      const [line, stack] = (filter['logger'].error as jest.Mock).mock.calls[0];
      expect(line).toContain('500 INTERNAL_ERROR [INTERNAL]');
      expect(line).toContain('/api/v1/staff/students/:studentId/guardians');
      expect(line).not.toContain('ckabc');
      expect(line).toContain('user=user-1');
      expect(stack).toBe(e.stack);
    });
  });

  it('logs an expected refusal as one info line, not an error', () => {
    send(new ConflictException({ code: 'PHONE_IN_USE', message: 'x' }), { route: '/r/:id' });
    expect(filter['logger'].error).not.toHaveBeenCalled();
    expect((filter['logger'].log as jest.Mock).mock.calls[0][0]).toContain(
      '409 PHONE_IN_USE [CONFLICT] POST /r/:id',
    );
  });

  it('does not log 401s (routine token expiry) or 404s on unmatched paths (scanners)', () => {
    send(new NotFoundException());
    send(new (class extends BadRequestException {})());
    const { UnauthorizedException } = jest.requireActual('@nestjs/common');
    send(new UnauthorizedException());
    const logged = (filter['logger'].log as jest.Mock).mock.calls.map((c) => c[0]);
    expect(logged.some((l: string) => l.startsWith('401'))).toBe(false);
    expect(logged.some((l: string) => l.startsWith('404'))).toBe(false);
  });

  describe('Prisma errors', () => {
    it.each([
      ['P2002', 409, 'ALREADY_EXISTS', false],
      ['P2003', 409, 'RELATED_RECORD_CONFLICT', false],
      ['P2025', 404, 'NOT_FOUND', false],
      ['P2034', 503, 'WRITE_CONFLICT', true],
    ])('%s → %i %s', (code, s, c, retryable) => {
      const { status, body } = send(prismaError(code, { target: ['studentId', 'courseId'] }));
      expect(status).toBe(s);
      expect(body).toMatchObject({ code: c, retryable });
    });

    it('never lets the schema reach the client', () => {
      for (const code of ['P2002', 'P2003', 'P2025', 'P2034', 'P2010']) {
        const { body } = send(prismaError(code, { target: ['studentId', 'courseId'] }));
        const text = JSON.stringify(body);
        for (const leak of ['studentId', 'courseId', 'Enrollment', 'Unique constraint', code])
          expect(text).not.toContain(leak);
      }
    });

    it('an unmapped code is a real 500, logged with the code and meta', () => {
      const { status } = send(prismaError('P2010'));
      expect(status).toBe(500);
      expect((filter['logger'].error as jest.Mock).mock.calls[0][0]).toContain('prisma=P2010');
    });
  });

  it('turns a throttle into RATE_LIMITED with the wait the header carries', () => {
    const { status, body } = send(new ThrottlerException(), { headers: { 'Retry-After': '42' } });
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 42 });
  });

  it('marks a 503 retryable unless the thrower said otherwise', () => {
    expect(
      send(new ServiceUnavailableException({ code: 'AI_DISABLED', message: 'x' })).body,
    ).toMatchObject({ retryable: true });
    expect(
      send(new ServiceUnavailableException({ code: 'AI_DISABLED', message: 'x', retryable: false }))
        .body,
    ).toMatchObject({ retryable: false });
  });

  it('turns a foreign validation list into VALIDATION_FAILED without its sentences', () => {
    const { body } = send(new BadRequestException(['page must be an integer number']));
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Invalid input',
      fields: [{ field: 'page', code: 'INVALID' }],
    });
  });
});

describe('validationExceptionFactory', () => {
  const filter = new ApiExceptionFilter();
  const bodyOf = (errors: Parameters<typeof validationExceptionFactory>[0]) =>
    filter.bodyFor(validationExceptionFactory(errors));

  it('names each field with a stable code and the limit, never the constraint text', () => {
    const body = bodyOf([
      {
        property: 'name',
        constraints: { minLength: 'name must be longer than or equal to 2 characters' },
      },
      {
        property: 'phone',
        constraints: { matches: 'phone must match /^(\\+20|0)1[0125]\\d{8}$/ regular expression' },
      },
      {
        property: 'email',
        constraints: { isEmail: 'email must be an email', isNotEmpty: 'email should not be empty' },
      },
      { property: 'price', constraints: { max: 'price must not be greater than 5000' } },
      { property: 'evil', constraints: { whitelistValidation: 'property evil should not exist' } },
    ]);
    expect(body.statusCode).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields).toEqual([
      { field: 'name', code: 'TOO_SHORT', params: { min: 2 } },
      { field: 'phone', code: 'INVALID_PHONE' },
      { field: 'email', code: 'REQUIRED' },
      { field: 'price', code: 'TOO_LARGE', params: { max: 5000 } },
      { field: 'evil', code: 'UNKNOWN_FIELD' },
    ]);
    expect(JSON.stringify(body)).not.toContain('regular expression');
  });

  it('names nested fields by path', () => {
    const body = bodyOf([
      {
        property: 'questions',
        children: [
          { property: '0', children: [{ property: 'text', constraints: { isNotEmpty: 'x' } }] },
        ],
      },
    ]);
    expect(body.fields).toEqual([{ field: 'questions.0.text', code: 'REQUIRED' }]);
  });
});
