import { createHash } from 'crypto';
import { AuthService } from './auth.service';

/**
 * The reset flow end-to-end at the service layer, with the database and mailer
 * stubbed. What matters here is the decision-making: who gets told what, and
 * how many wrong guesses a 6-digit code survives.
 */
describe('AuthService — password reset by emailed code', () => {
  const USER = { id: 'user_1', email: 'ahmed@example.com', fullName: 'أحمد', isActive: true };

  let prisma: any;
  let mail: any;
  let service: AuthService;
  let storedToken: any;

  const hashOf = (userId: string, code: string) =>
    createHash('sha256').update(`${userId}:${code}`).digest('hex');

  beforeEach(() => {
    storedToken = null;
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(USER), update: jest.fn() },
      passwordResetToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockImplementation(({ data }: any) => {
          storedToken = { id: 'tok_1', attempts: 0, usedAt: null, ...data };
          return Promise.resolve(storedToken);
        }),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(storedToken)),
        update: jest.fn().mockImplementation(({ data }: any) => {
          if (data.attempts?.increment) storedToken.attempts += data.attempts.increment;
          return Promise.resolve(storedToken);
        }),
      },
      deviceSession: { updateMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    mail = { send: jest.fn().mockResolvedValue({ delivered: true, id: 'm1' }), webUrl: (p = '') => p };
    service = new AuthService(prisma, {} as any, mail, {} as any);
    delete process.env.OTP_DEV_MODE;
  });

  /** Pull the code out of the email the service just sent. */
  function sentCode(): string {
    const body = mail.send.mock.calls[0][0].text as string;
    return body.match(/\b(\d{6})\b/)![1];
  }

  it('answers an unknown address exactly as it answers a real one', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await service.forgotPassword({ email: 'nobody@example.com' });

    // Indistinguishable from the answer a real account gets — that is the point.
    expect(result).toMatchObject({ ok: true, expiresInMinutes: expect.any(Number) });
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('answers a disabled account the same way, and emails nothing', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...USER, isActive: false });

    const result = await service.forgotPassword({ email: USER.email });

    // Suspension is not something a stranger gets to discover either.
    expect(result).toMatchObject({ ok: true });
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  /**
   * The property the whole change exists for: an attacker holding one address
   * must not be able to tell from the response whether it has an account here.
   */
  it('unknown, disabled and real addresses are indistinguishable in the response', async () => {
    const unknown = await service.forgotPassword({ email: 'nobody@example.com' });
    prisma.user.findUnique.mockResolvedValue({ ...USER, isActive: false });
    const disabled = await service.forgotPassword({ email: USER.email });
    prisma.user.findUnique.mockResolvedValue(USER);
    const real = await service.forgotPassword({ email: USER.email });

    const shape = (r: any) => JSON.stringify({ ...r, devResetCode: undefined });
    expect(shape(unknown)).toBe(shape(real));
    expect(shape(disabled)).toBe(shape(real));
  });

  it('emails a 6-digit code and stores only its hash', async () => {
    const result = await service.forgotPassword({ email: USER.email });

    expect(result).toMatchObject({ ok: true });
    const code = sentCode();
    expect(code).toMatch(/^\d{6}$/);
    // The plaintext code must never be what lands in the table.
    expect(storedToken.tokenHash).toBe(hashOf(USER.id, code));
    expect(JSON.stringify(storedToken)).not.toContain(code);
  });

  it('invalidates any earlier code so only the newest one works', async () => {
    await service.forgotPassword({ email: USER.email });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER.id, usedAt: null } }),
    );
  });

  it('reports a failed send instead of claiming the email went out', async () => {
    mail.send.mockResolvedValue({ delivered: false, reason: 'provider-error' });
    await expect(service.forgotPassword({ email: USER.email })).rejects.toMatchObject({
      status: 503,
      response: { code: 'MAIL_DELIVERY_FAILED' },
    });
  });

  it('accepts the correct code and rejects a wrong one', async () => {
    await service.forgotPassword({ email: USER.email });
    const code = sentCode();

    await expect(service.verifyResetCode({ email: USER.email, code })).resolves.toEqual({ ok: true });
    await expect(
      service.verifyResetCode({ email: USER.email, code: '000000' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
  });

  it('counts wrong guesses and locks the code after five', async () => {
    await service.forgotPassword({ email: USER.email });
    const code = sentCode();

    for (let i = 0; i < 5; i++) {
      await expect(
        service.verifyResetCode({ email: USER.email, code: '000000' }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
    }
    // Even the RIGHT code is refused once the budget is spent — otherwise the
    // attempt counter would only slow an attacker down, not stop them.
    await expect(service.verifyResetCode({ email: USER.email, code })).rejects.toMatchObject({
      response: { code: 'TOO_MANY_ATTEMPTS' },
    });
  });

  it('rejects an expired code', async () => {
    await service.forgotPassword({ email: USER.email });
    const code = sentCode();
    storedToken.expiresAt = new Date(Date.now() - 1000);

    await expect(service.verifyResetCode({ email: USER.email, code })).rejects.toMatchObject({
      response: { code: 'CODE_EXPIRED' },
    });
  });

  it('rejects a code that belongs to a different account', async () => {
    await service.forgotPassword({ email: USER.email });
    const code = sentCode();
    // Same digits, different user ⇒ different hash ⇒ no match.
    prisma.user.findUnique.mockResolvedValue({ ...USER, id: 'user_2' });

    await expect(service.verifyResetCode({ email: USER.email, code })).rejects.toMatchObject({
      response: { code: 'INVALID_CODE' },
    });
  });

  it('sets the password and revokes every device session', async () => {
    await service.forgotPassword({ email: USER.email });
    const code = sentCode();

    await expect(
      service.resetPassword({ email: USER.email, code, password: 'Passw0rd1' }),
    ).resolves.toEqual({ ok: true });

    // A reset is what someone does after losing control of an account, so the
    // other logged-in devices must not survive it.
    expect(prisma.deviceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'PASSWORD_RESET' }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
