import { ArgumentsHost, ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * The claim under test is narrow and worth stating plainly: a constraint the
 * database enforced should reach the caller as a refusal it can act on, and
 * nothing about the schema should travel with it.
 *
 * The errors here are real `PrismaClientKnownRequestError` instances rather
 * than `{ code: 'P2002' }` stand-ins, because the filter dispatches on the
 * class (`@Catch`) as well as the code — a fake object would pass a test the
 * running application would fail.
 */

/** A real Prisma error, carrying the schema-revealing message Prisma actually produces. */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`studentId\`,\`courseId\`)`,
    { code, clientVersion: '5.22.0', meta },
  );
}

/** Captures what the filter wrote, in the shape Express hands it. */
function mockHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;

  beforeEach(() => {
    filter = new PrismaExceptionFilter();
    // The filter logs every case; silence it so a passing run stays readable.
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('maps each known code to the status a client can act on', () => {
    it.each([
      ['P2002', HttpStatus.CONFLICT, 'ALREADY_EXISTS'],
      ['P2003', HttpStatus.CONFLICT, 'RELATED_RECORD_CONFLICT'],
      ['P2025', HttpStatus.NOT_FOUND, 'NOT_FOUND'],
      ['P2034', HttpStatus.SERVICE_UNAVAILABLE, 'WRITE_CONFLICT'],
    ])('%s → %i %s', (code, expectedStatus, expectedCode) => {
      const { host, status, json } = mockHost();

      filter.catch(prismaError(code), host);

      expect(status).toHaveBeenCalledWith(expectedStatus);
      expect(json).toHaveBeenCalledWith({ message: expect.any(String), code: expectedCode });
    });
  });

  it('answers with exactly { message, code } — no extra keys', () => {
    const { host, json } = mockHost();

    filter.catch(prismaError('P2025'), host);

    expect(Object.keys(json.mock.calls[0][0] as object).sort()).toEqual(['code', 'message']);
  });

  /**
   * The security property, and the reason the filter does not simply forward
   * `exception.message`: Prisma names the table and the columns that failed,
   * and the audit's finding was that no driver detail reaches a caller.
   */
  it('never leaks Prisma internals — message, column names, client version, or meta', () => {
    const { host, json } = mockHost();
    const error = prismaError('P2002', { target: ['studentId', 'courseId'], modelName: 'Payment' });

    filter.catch(error, host);

    const body = JSON.stringify(json.mock.calls[0][0]);
    expect(body).not.toContain('studentId');
    expect(body).not.toContain('courseId');
    expect(body).not.toContain('Payment');
    expect(body).not.toContain('Unique constraint');
    expect(body).not.toContain('5.22.0');
    expect(body).not.toContain(error.message);
  });

  it('logs the full error server-side so the detail is not simply lost', () => {
    const { host } = mockHost();
    const warn = jest.spyOn(filter['logger'], 'warn');

    filter.catch(prismaError('P2002', { target: ['studentId'] }), host);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('P2002'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('studentId'));
  });

  /**
   * An unmapped code is a real defect. Dressing it as a tidy 4xx would hide
   * it, so it stays a 500 — but a logged one, which is more than the default
   * filter offered.
   */
  it('leaves an unknown Prisma code as a logged 500', () => {
    const { host, status, json } = mockHost();
    const error = jest.spyOn(filter['logger'], 'error');

    filter.catch(prismaError('P2000'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Unique constraint');
  });

  /**
   * The preservation guarantee, asserted rather than assumed.
   *
   * `@Catch(Prisma.PrismaClientKnownRequestError)` is what makes it impossible
   * for an HttpException to arrive here, so the ~525 existing refusals and
   * every guard rejection keep their own status and body. This proves the
   * decorator is actually narrowed, which is the whole basis of the claim that
   * adding the filter cannot change an existing answer.
   */
  it('is scoped to Prisma errors only, so HttpExceptions are never intercepted', () => {
    const caught = Reflect.getMetadata(
      '__filterCatchExceptions__',
      PrismaExceptionFilter,
    ) as unknown[];

    expect(caught).toEqual([Prisma.PrismaClientKnownRequestError]);
    expect(caught).not.toContain(NotFoundException);
    expect(caught).not.toContain(ForbiddenException);
  });
});
