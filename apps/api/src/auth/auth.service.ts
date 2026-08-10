import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role, TeacherStatus } from '@darsly/shared-types';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'crypto';
import { provisionTeacherAcademy } from '../academy/provision';
import { MailService } from '../mail/mail.service';
import { otpEmail, teacherPendingEmail, welcomeStudentEmail } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceContext, TokenService } from './token.service';
import {
  ForgotPasswordDto,
  LoginDto,
  normalizeEgyptianPhone,
  RegisterStudentDto,
  RegisterTeacherDto,
  ResetPasswordDto,
  VerifyResetCodeDto,
} from './dto/auth.dto';

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
/** Short-lived on purpose: a 6-digit code is weaker than a 32-byte link. */
const RESET_TTL_MINUTES = 15;
const MAX_RESET_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  // A valid argon2 hash to verify against when an account is absent, so login
  // latency doesn't reveal whether an email exists (constant-time login).
  private readonly dummyHash = argon2.hash('constant-time-dummy-password');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly mail: MailService,
  ) {}

  /**
   * Returning the reset code over HTTP is a dev-only convenience — belt and
   * braces with the boot-time config check that refuses to start a production
   * process with OTP_DEV_MODE=true.
   *
   * Read per call rather than captured at import: a module-level constant is
   * fixed by whatever the environment happened to be when the file first
   * loaded, which makes the flag untestable and surprising to toggle.
   */
  private get devMode(): boolean {
    return process.env.OTP_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';
  }

  // ── Registration ───────────────────────────────────────────────────────────

  /** Student self-service signup — active immediately, auto-logged-in. */
  async registerStudent(dto: RegisterStudentDto, device: DeviceContext) {
    const email = dto.email.toLowerCase().trim();
    await this.assertEmailFree(email);
    const phone = normalizeEgyptianPhone(dto.phone);
    await this.assertPhoneFree(phone);

    const user = await this.prisma.user.create({
      data: {
        role: Role.STUDENT,
        email,
        phone,
        fullName: dto.fullName.trim(),
        passwordHash: await argon2.hash(dto.password),
        studentProfile: { create: {} },
      },
      include: { teacherProfile: true, studentProfile: true },
    });

    const tokens = await this.tokenService.createSession(
      { id: user.id, role: user.role as Role, tenantId: undefined },
      { ...device, deviceName: dto.deviceName ?? device.deviceName },
    );
    // Not awaited: a slow mail provider must not delay the signup response, and
    // a failed welcome mail must not fail an account that already exists.
    this.mail.sendInBackground({
      to: email,
      ...welcomeStudentEmail({ name: user.fullName, loginUrl: this.mail.webUrl('/courses') }),
    });
    return { user: this.publicUser(user), isNewUser: true, ...tokens };
  }

  /**
   * Teacher signup — lands PENDING. They cannot log in until a super admin
   * approves them (mirrors the reference CRM's approval flow), so we return a
   * pending flag with no tokens.
   */
  async registerTeacher(dto: RegisterTeacherDto) {
    const email = dto.email.toLowerCase().trim();
    await this.assertEmailFree(email);
    const phone = normalizeEgyptianPhone(dto.phone);
    await this.assertPhoneFree(phone);

    const slug = await this.uniqueSlug(dto.email, dto.fullName);
    const fullName = dto.fullName.trim();
    // Create the teacher AND provision their own Academy + OWNER membership in one
    // transaction. Without the academy, every @AcademyStaff console route (courses,
    // lessons, quizzes, wallet…) 404s — the teacher can't build anything.
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          role: Role.TEACHER,
          email,
          phone,
          fullName,
          passwordHash: await argon2.hash(dto.password),
          teacherProfile: { create: { slug, bio: dto.bio ?? '', status: TeacherStatus.PENDING } },
        },
        include: { teacherProfile: true },
      });
      const tp = user.teacherProfile!;
      await provisionTeacherAcademy(
        tx,
        {
          id: tp.id,
          slug: tp.slug,
          userId: user.id,
          status: tp.status,
          language: tp.language,
          maxConcurrentSessions: tp.maxConcurrentSessions,
          autoApproveEnrollments: tp.autoApproveEnrollments,
          commissionPercent: tp.commissionPercent,
        },
        fullName,
      );
    });
    this.mail.sendInBackground({ to: email, ...teacherPendingEmail({ name: fullName }) });
    return { pending: true };
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  /** Email + password login for everyone (students, teachers, admins). */
  async login(dto: LoginDto, device: DeviceContext) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { teacherProfile: true, studentProfile: true },
    });

    // Soft-lock check before touching the password.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException({
        message: 'Account temporarily locked after too many attempts. Try again later.',
        code: 'ACCOUNT_LOCKED',
      });
    }

    // Always run a verify (against a dummy hash when the user/hash is absent) so
    // login latency is the same for existing and non-existing emails.
    const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), dto.password);
    if (!user || !user.passwordHash || !ok) {
      if (user?.isActive) await this.recordFailedLogin(user.id, user.failedLogins);
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertLoginAllowed(user);

    // Success — clear the failure counter.
    if (user.failedLogins || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    const tokens = await this.tokenService.createSession(
      { id: user.id, role: user.role as Role, tenantId: user.teacherProfile?.id },
      { ...device, deviceName: dto.deviceName ?? device.deviceName },
    );
    return { user: this.publicUser(user), ...tokens };
  }

  // ── Forgot / reset password ─────────────────────────────────────────────────

  /**
   * Step 1 — the account must exist, then a 6-digit code goes out by email.
   *
   * This deliberately tells the caller when an email is unknown. The usual
   * advice is the opposite (answer "ok" either way so nobody can enumerate
   * accounts), and that is what this endpoint used to do — but it made a real
   * failure indistinguishable from success: a typo, an unknown address and a
   * mail provider outage all produced the same cheerful "check your inbox",
   * and the user sat waiting for a message that was never coming.
   *
   * The enumeration risk is real and is mitigated rather than ignored: the
   * route is throttled to 5 requests per 10 minutes per IP, which makes
   * harvesting a list of addresses impractical while keeping the honest user
   * informed. If that trade stops being acceptable, this is the one method to
   * change back.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException({
        message: 'لا يوجد حساب مسجَّل بهذا البريد الإلكتروني',
        code: 'EMAIL_NOT_FOUND',
      });
    }
    if (!user.isActive) {
      throw new ForbiddenException({ message: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }

    // Invalidate any previous unused code for this user, so the newest code is
    // the only one that works — two live codes double the guessing surface.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashResetCode(user.id, code),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });

    // Awaited, and its verdict is reported: "we emailed you a code" is the
    // whole response, so claiming it after a rejected send would be a lie.
    const delivery = await this.mail.send({
      to: email,
      ...otpEmail({
        name: user.fullName,
        code,
        expiresInMinutes: RESET_TTL_MINUTES,
        purpose: 'إعادة تعيين كلمة المرور',
      }),
    });

    if (this.devMode) {
      // eslint-disable-next-line no-console
      console.log(`[DEV] password reset code for ${email}: ${code}`);
      return { ok: true, expiresInMinutes: RESET_TTL_MINUTES, devResetCode: code };
    }

    if (!delivery.delivered) {
      throw new ServiceUnavailableException({
        message: 'تعذّر إرسال البريد الآن، حاول بعد قليل',
        code: 'MAIL_DELIVERY_FAILED',
      });
    }
    return { ok: true, expiresInMinutes: RESET_TTL_MINUTES };
  }

  /**
   * Step 2 (optional) — check a code without spending it, so the UI can move to
   * the new-password field before asking the user to type one.
   */
  async verifyResetCode(dto: VerifyResetCodeDto) {
    await this.consumableResetToken(dto.email, dto.code);
    return { ok: true };
  }

  /** Step 3 — the code is spent here, exactly once. */
  async resetPassword(dto: ResetPasswordDto) {
    const row = await this.consumableResetToken(dto.email, dto.code);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash: await argon2.hash(dto.password), failedLogins: 0, lockedUntil: null },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      // Revoke every active device session so a compromised session (the reason a
      // user resets) is evicted immediately — its access token fails the guard's
      // revocation check and its refresh token can no longer rotate. Forces a
      // fresh login on all devices with the new password.
      this.prisma.deviceSession.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
      }),
    ]);
    return { ok: true };
  }

  // ── Session helpers (unchanged behaviour) ────────────────────────────────────

  async refresh(refreshToken: string) {
    return this.tokenService.rotate(refreshToken);
  }

  async logout(sessionId: string) {
    await this.tokenService.revokeSession(sessionId, 'LOGOUT');
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        teacherProfile: { include: { subject: true, grades: { include: { grade: true } } } },
        studentProfile: { include: { grade: true, interests: { include: { subject: true } } } },
      },
    });
    if (!user) throw new UnauthorizedException();
    return this.publicUser(user);
  }

  async listSessions(userId: string) {
    return this.prisma.deviceSession.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, deviceName: true, ip: true, createdAt: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async recordFailedLogin(userId: string, current: number) {
    const fails = (current ?? 0) + 1;
    const locked = fails >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLogins: locked ? 0 : fails,
        lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
      },
    });
  }

  private assertLoginAllowed(user: {
    isActive: boolean;
    role: string;
    teacherProfile?: { status: string } | null;
  }) {
    if (!user.isActive) throw new ForbiddenException('Account disabled');
    const ts = user.teacherProfile?.status;
    if (user.role === Role.TEACHER) {
      if (ts === TeacherStatus.PENDING) {
        throw new ForbiddenException({
          message: 'Your teacher account is awaiting admin approval',
          code: 'ACCOUNT_PENDING_APPROVAL',
        });
      }
      if (ts === TeacherStatus.SUSPENDED || ts === TeacherStatus.REJECTED) {
        throw new ForbiddenException({
          message: `Teacher account is ${ts?.toLowerCase()}`,
          code: `ACCOUNT_${ts}`,
        });
      }
    }
  }

  private async assertEmailFree(email: string) {
    const exists = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (exists) throw new ConflictException({ message: 'Email already registered', code: 'EMAIL_TAKEN' });
  }

  private async assertPhoneFree(phone: string) {
    const exists = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (exists) throw new ConflictException({ message: 'Phone already registered', code: 'PHONE_TAKEN' });
  }

  private async uniqueSlug(email: string, fullName: string): Promise<string> {
    const base =
      email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
      fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
      'teacher';
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      const taken = await this.prisma.teacherProfile.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * The stored hash binds the code to its owner, so a 6-digit code stays unique
   * table-wide and a code issued to one account can never unlock another.
   */
  private hashResetCode(userId: string, code: string): string {
    return createHash('sha256').update(`${userId}:${code.trim()}`).digest('hex');
  }

  /**
   * Look up a live reset code for an email, or explain precisely why it isn't
   * usable. Every wrong guess is counted against the code, so a 6-digit secret
   * cannot be walked through even if the per-IP throttle is sidestepped.
   */
  private async consumableResetToken(rawEmail: string, code: string) {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
    if (!user || !user.isActive) {
      throw new BadRequestException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    }

    // The active code for this user, whether or not the submitted digits match —
    // needed so a wrong guess has something to be counted against.
    const active = await this.prisma.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      throw new BadRequestException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    }
    if (active.expiresAt < new Date()) {
      throw new BadRequestException({ message: 'Reset code has expired', code: 'CODE_EXPIRED' });
    }
    if (active.attempts >= MAX_RESET_ATTEMPTS) {
      throw new BadRequestException({
        message: 'Too many attempts — request a new code',
        code: 'TOO_MANY_ATTEMPTS',
      });
    }

    if (active.tokenHash !== this.hashResetCode(user.id, code)) {
      await this.prisma.passwordResetToken.update({
        where: { id: active.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    }

    return active;
  }

  private publicUser(user: any) {
    const { passwordHash: _ph, failedLogins: _f, lockedUntil: _l, ...safe } = user;
    return safe;
  }
}
