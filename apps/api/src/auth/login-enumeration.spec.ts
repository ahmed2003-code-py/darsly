// Wrapped, not replaced: every call is counted and still really hashes.
jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return { ...actual, verify: jest.fn(actual.verify) };
});

import { HttpException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

/**
 * Login must not tell anyone whether an account exists.
 *
 * The path this pins down: an account locked after too many wrong passwords
 * used to answer 403 ACCOUNT_LOCKED. Only an existing account can be locked,
 * so ten guesses at any phone or email revealed whether it was registered.
 * Now an unknown account, a wrong password and a locked account are the same
 * refusal — same status, same body — and all of them run the password hash,
 * so they cost the same time.
 */
describe('login does not reveal whether an account exists', () => {
  const PASSWORD = 'Correct-horse-9';
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };
  let service: AuthService;
  let hash: string;

  beforeAll(async () => {
    hash = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
    service = new AuthService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    role: 'STUDENT',
    isActive: true,
    passwordHash: hash,
    failedLogins: 0,
    lockedUntil: null,
    teacherProfile: null,
    studentProfile: { id: 's1' },
    ...over,
  });

  /** The refusal as a client would see it: status and body. */
  async function refusal(found: unknown, password: string) {
    prisma.user.findUnique.mockResolvedValue(found);
    try {
      await service.login({ identifier: 'someone@example.com', password } as never, {} as never);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const h = e as HttpException;
      return { status: h.getStatus(), body: h.getResponse() };
    }
    throw new Error('login unexpectedly succeeded');
  }

  it('unknown account, wrong password and locked account answer identically', async () => {
    const lockedUntil = new Date(Date.now() + 10 * 60_000);
    const unknown = await refusal(null, 'Anything-1');
    const wrong = await refusal(user(), 'Wrong-pass-1');
    const lockedWrong = await refusal(user({ lockedUntil }), 'Wrong-pass-1');
    // Even the right password is refused the same way while locked — anything
    // else would let guessing continue through the lock.
    const lockedRight = await refusal(user({ lockedUntil }), PASSWORD);

    for (const r of [wrong, lockedWrong, lockedRight]) expect(r).toEqual(unknown);
    expect(unknown).toEqual({
      status: 401,
      body: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' },
    });
    expect(JSON.stringify([lockedWrong, lockedRight])).not.toMatch(/LOCK/i);
  });

  it('runs the password hash on every path, so timing does not tell them apart', async () => {
    const verify = argon2.verify as unknown as jest.Mock;
    verify.mockClear();
    await refusal(null, 'Anything-1');
    await refusal(user({ lockedUntil: new Date(Date.now() + 60_000) }), PASSWORD);
    await refusal(user(), 'Wrong-pass-1');
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('keeps the lock observable internally, and does not extend it', async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    await refusal(user({ lockedUntil }), 'Wrong-pass-1');
    expect(service['logger'].warn).toHaveBeenCalledWith(
      expect.stringContaining('account locked user=u1'),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a wrong password on an unlocked account still counts toward the lock', async () => {
    await refusal(user({ failedLogins: 9 }), 'Wrong-pass-1');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lockedUntil: expect.any(Date) }) }),
    );
  });
});
