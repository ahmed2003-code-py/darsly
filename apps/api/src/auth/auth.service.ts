import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Role, TeacherStatus } from '@darsly/shared-types';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceContext, TokenService } from './token.service';
import {
  ForgotPasswordDto,
  LoginDto,
  normalizeEgyptianPhone,
  RegisterStudentDto,
  RegisterTeacherDto,
  ResetPasswordDto,
} from './dto/auth.dto';

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
// The reset-token-over-HTTP backdoor is dev-only. Belt-and-suspenders with the
// boot-time config check that refuses to start with OTP_DEV_MODE=true in prod.
const DEV_MODE =
  process.env.OTP_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';

@Injectable()
export class AuthService {
  // A valid argon2 hash to verify against when an account is absent, so login
  // latency doesn't reveal whether an email exists (constant-time login).
  private readonly dummyHash = argon2.hash('constant-time-dummy-password');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────────

  /** Student self-service signup — active immediately, auto-logged-in. */
  async registerStudent(dto: RegisterStudentDto, device: DeviceContext) {
    const email = dto.email.toLowerCase().trim();
    await this.assertEmailFree(email);
    const phone = dto.phone ? normalizeEgyptianPhone(dto.phone) : undefined;
    if (phone) await this.assertPhoneFree(phone);

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
    await this.prisma.user.create({
      data: {
        role: Role.TEACHER,
        email,
        phone,
        fullName: dto.fullName.trim(),
        passwordHash: await argon2.hash(dto.password),
        teacherProfile: { create: { slug, bio: dto.bio ?? '', status: TeacherStatus.PENDING } },
      },
    });
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
   * Always responds ok (no email enumeration). Issues a single-use hashed
   * token. Without SMTP configured we surface the token in dev mode only.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return { ok: true };

    // Invalidate any previous unused tokens for this user.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });

    // TODO(prod): email the reset link. Until SMTP lands, dev mode returns it.
    if (DEV_MODE) {
      // eslint-disable-next-line no-console
      console.log(`[DEV] password reset token for ${email}: ${rawToken}`);
      return { ok: true, devResetToken: rawToken };
    }
    return { ok: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(dto.token.trim()) },
      include: { user: true },
    });
    if (!row || row.usedAt || !row.user.isActive) {
      throw new BadRequestException({ message: 'Invalid or used reset link', code: 'INVALID_TOKEN' });
    }
    if (row.expiresAt < new Date()) {
      throw new BadRequestException({ message: 'Reset link has expired', code: 'TOKEN_EXPIRED' });
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash: await argon2.hash(dto.password), failedLogins: 0, lockedUntil: null },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
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

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private publicUser(user: any) {
    const { passwordHash: _ph, failedLogins: _f, lockedUntil: _l, ...safe } = user;
    return safe;
  }
}
