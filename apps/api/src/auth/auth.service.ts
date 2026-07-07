import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Role, TeacherStatus } from '@darsly/shared-types';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';
import { DeviceContext, TokenService } from './token.service';
import {
  LoginPasswordDto,
  normalizeEgyptianPhone,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
  ) {}

  async requestOtp(dto: RequestOtpDto) {
    const phone = normalizeEgyptianPhone(dto.phone);
    const { expiresInSeconds } = await this.otpService.request(phone);
    return { phone, expiresInSeconds };
  }

  /**
   * Student OTP login. Creates the account on first verification (fast
   * onboarding: phone + OTP only, fullName required just once).
   */
  async verifyOtp(dto: VerifyOtpDto, device: DeviceContext) {
    const phone = normalizeEgyptianPhone(dto.phone);
    await this.otpService.verify(phone, dto.code);

    let user = await this.prisma.user.findUnique({
      where: { phone },
      include: { teacherProfile: true, studentProfile: true },
    });

    let isNewUser = false;
    if (!user) {
      if (!dto.fullName) {
        throw new BadRequestException({
          message: 'fullName is required for signup',
          code: 'SIGNUP_NAME_REQUIRED',
        });
      }
      user = await this.prisma.user.create({
        data: {
          role: Role.STUDENT,
          phone,
          fullName: dto.fullName,
          studentProfile: { create: {} },
        },
        include: { teacherProfile: true, studentProfile: true },
      });
      isNewUser = true;
    }

    this.assertLoginAllowed(user);

    const tokens = await this.tokenService.createSession(
      { id: user.id, role: user.role as Role, tenantId: user.teacherProfile?.id },
      { ...device, deviceName: dto.deviceName ?? device.deviceName },
    );
    return { user: this.publicUser(user), isNewUser, ...tokens };
  }

  /** Email/phone + password login (teachers & super admin). */
  async loginPassword(dto: LoginPasswordDto, device: DeviceContext) {
    const isEmail = dto.emailOrPhone.includes('@');
    const where = isEmail
      ? { email: dto.emailOrPhone.toLowerCase() }
      : { phone: normalizeEgyptianPhone(dto.emailOrPhone) };

    const user = await this.prisma.user.findUnique({
      where,
      include: { teacherProfile: true, studentProfile: true },
    });
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    this.assertLoginAllowed(user);

    const tokens = await this.tokenService.createSession(
      { id: user.id, role: user.role as Role, tenantId: user.teacherProfile?.id },
      { ...device, deviceName: dto.deviceName ?? device.deviceName },
    );
    return { user: this.publicUser(user), ...tokens };
  }

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

  private assertLoginAllowed(user: {
    isActive: boolean;
    role: string;
    teacherProfile?: { status: string } | null;
  }) {
    if (!user.isActive) throw new ForbiddenException('Account disabled');
    // Suspended/rejected teachers cannot log in; PENDING teachers may log in
    // to complete their profile but tenant routes gate on APPROVED separately.
    const ts = user.teacherProfile?.status;
    if (user.role === Role.TEACHER && (ts === TeacherStatus.SUSPENDED || ts === TeacherStatus.REJECTED)) {
      throw new ForbiddenException(`Teacher account is ${ts?.toLowerCase()}`);
    }
  }

  private publicUser(user: any) {
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }
}
