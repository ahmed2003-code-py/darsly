import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@darsly/shared-types';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { centerAdminActivationEmail } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { slugCandidates, slugify, slugShapeError } from '../academy/slug';
import { normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { CreateCenterDto } from './dto/admin-centers.dto';

const ACTIVATION_TTL_DAYS = 7;

/**
 * A Center is an organisation, created only by a platform admin. Its admin is
 * either a brand-new STAFF account that activates itself through a one-time
 * link, or an existing STAFF / approved TEACHER designated directly. Never a
 * student, never an unapproved teacher, never a fabricated TeacherProfile.
 */
@Injectable()
export class AdminCentersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async createCenter(dto: CreateCenterDto, adminUserId: string) {
    const name = dto.name.trim();
    const adminEmail = dto.adminEmail.toLowerCase().trim();
    const slug = dto.slug ? await this.exactSlug(dto.slug) : await this.resolveSlug(name);

    const existing = await this.prisma.user.findUnique({
      where: { email: adminEmail },
      select: { id: true, role: true, isActive: true, fullName: true, teacherProfile: { select: { status: true } } },
    });

    if (existing) {
      this.assertDesignatable(existing);
      const academy = await this.prisma.$transaction(async (tx) => {
        const a = await tx.academy.create({
          data: { slug, name, kind: 'CENTER', status: 'ACTIVE', ownerUserId: existing.id },
          select: { id: true, slug: true, name: true, status: true, kind: true },
        });
        await tx.academyMembership.create({
          data: { userId: existing.id, academyId: a.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
        });
        return a;
      });
      await this.audit.log({
        actorUserId: adminUserId, action: 'center.create', entity: 'Academy', entityId: academy.id, academyId: academy.id,
        meta: { adminUserId: existing.id, adminIdentity: existing.role, activation: 'NOT_REQUIRED' },
      });
      return { ...academy, admin: { id: existing.id, role: existing.role, activation: 'NOT_REQUIRED' as const } };
    }

    const phone = dto.adminPhone ? normalizeEgyptianPhone(dto.adminPhone) : null;
    if (phone) {
      const phoneTaken = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
      if (phoneTaken) throw new ConflictException({ message: 'Phone already registered', code: 'PHONE_TAKEN' });
    }

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_DAYS * 86_400_000);
    const created = await this.prisma.$transaction(async (tx) => {
      // No password, not active: the account cannot sign in until the admin
      // activates it and chooses their own password. No profile of any kind.
      const user = await tx.user.create({
        data: { role: Role.STAFF, email: adminEmail, phone, fullName: dto.adminName.trim(), isActive: false },
        select: { id: true, fullName: true },
      });
      const a = await tx.academy.create({
        data: { slug, name, kind: 'CENTER', status: 'PENDING', ownerUserId: user.id },
        select: { id: true, slug: true, name: true, status: true, kind: true },
      });
      await tx.academyMembership.create({
        data: { userId: user.id, academyId: a.id, role: 'OWNER', status: 'INVITED' },
      });
      await tx.academyActivationToken.create({
        data: { userId: user.id, academyId: a.id, tokenHash: this.hashToken(rawToken), expiresAt },
      });
      return { user, academy: a };
    });

    this.mail.sendInBackground({
      to: adminEmail,
      // TEMPORARY TEST ROUTING (Phase 8 follow-up): while the real provider
      // can't be verified end-to-end on Railway, this opts the ONE
      // Center-activation email into MailService's redirect — `adminEmail`
      // above stays the real recipient in every other respect (the DB row,
      // the returned response, this call's own `to`). See
      // MailService.send / TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO. Remove this
      // line once the real provider is confirmed working.
      centerOwnerTestRedirect: true,
      ...centerAdminActivationEmail({
        name: created.user.fullName,
        centerName: name,
        activationUrl: this.mail.webUrl(`/activate?token=${encodeURIComponent(rawToken)}`),
        expiresInDays: ACTIVATION_TTL_DAYS,
      }),
    });
    await this.audit.log({
      actorUserId: adminUserId, action: 'center.create', entity: 'Academy', entityId: created.academy.id, academyId: created.academy.id,
      meta: { adminUserId: created.user.id, adminIdentity: Role.STAFF, activation: 'EMAIL_SENT' },
    });
    return { ...created.academy, admin: { id: created.user.id, role: Role.STAFF, activation: 'EMAIL_SENT' as const } };
  }

  /** Reissue the one-time link: every earlier token for this admin is revoked first. */
  async resendActivation(academyId: string, adminUserId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, kind: 'CENTER', deletedAt: null },
      select: { id: true, name: true, owner: { select: { id: true, email: true, fullName: true, isActive: true, passwordHash: true } } },
    });
    if (!academy) throw new NotFoundException('Center not found');
    if (academy.owner.isActive && academy.owner.passwordHash) {
      throw new BadRequestException({ message: 'This admin has already activated their account', code: 'ALREADY_ACTIVE' });
    }
    if (!academy.owner.email) throw new BadRequestException('Admin has no email');

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_DAYS * 86_400_000);
    await this.prisma.$transaction([
      this.prisma.academyActivationToken.updateMany({
        where: { userId: academy.owner.id, academyId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.academyActivationToken.create({
        data: { userId: academy.owner.id, academyId, tokenHash: this.hashToken(rawToken), expiresAt },
      }),
    ]);
    this.mail.sendInBackground({
      to: academy.owner.email,
      ...centerAdminActivationEmail({
        name: academy.owner.fullName, centerName: academy.name,
        activationUrl: this.mail.webUrl(`/activate?token=${encodeURIComponent(rawToken)}`),
        expiresInDays: ACTIVATION_TTL_DAYS,
      }),
    });
    await this.audit.log({ actorUserId: adminUserId, action: 'center.activation.resend', entity: 'Academy', entityId: academyId, academyId });
    return { ok: true, expiresAt };
  }

  /**
   * Organisation-level lifecycle, platform-admin only, CENTER only — a PERSONAL
   * academy's status stays derived from its teacher's approval status.
   * Suspending stores nothing destructive: memberships remain, buildContext
   * simply refuses them on the next request.
   */
  async setStatus(academyId: string, status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED', adminUserId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: { id: true, kind: true, status: true },
    });
    if (!academy) throw new NotFoundException('Center not found');
    if (academy.kind !== 'CENTER') {
      throw new BadRequestException({ message: 'A personal academy follows its teacher status', code: 'NOT_A_CENTER' });
    }
    if (status === 'ACTIVE' && academy.status === 'PENDING') {
      throw new BadRequestException({ message: 'Activate through the admin activation link', code: 'ACTIVATION_PENDING' });
    }
    const updated = await this.prisma.academy.update({ where: { id: academyId }, data: { status }, select: { id: true, status: true } });
    await this.audit.log({
      actorUserId: adminUserId, action: `center.status.${status.toLowerCase()}`, entity: 'Academy', entityId: academyId, academyId,
      meta: { from: academy.status, to: status },
    });
    return updated;
  }

  private assertDesignatable(user: { role: string; isActive: boolean; teacherProfile: { status: string } | null }) {
    if (!user.isActive) throw new BadRequestException({ message: 'This account is disabled', code: 'USER_INACTIVE' });
    if (user.role === Role.STAFF) return;
    if (user.role === Role.TEACHER && user.teacherProfile?.status === 'APPROVED') return;
    if (user.role === Role.TEACHER) {
      throw new BadRequestException({ message: 'Only an approved teacher can be a Center Admin', code: 'TEACHER_NOT_APPROVED' });
    }
    throw new BadRequestException({ message: 'This account cannot be a Center Admin', code: 'IDENTITY_NOT_ELIGIBLE' });
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** An address the admin typed is taken literally: it is theirs or it is a 409, never silently swapped. */
  private async exactSlug(raw: string): Promise<string> {
    const slug = slugify(raw);
    const shape = slugShapeError(slug);
    if (shape) throw new BadRequestException({ message: 'Invalid center address', code: `SLUG_${shape}` });
    if (await this.slugTaken(slug)) throw new ConflictException({ message: 'الرابط مستخدم بالفعل', code: 'SLUG_TAKEN' });
    return slug;
  }

  /** /a/<slug> and /t/<slug> share one namespace: a Center may never take a teacher's address. */
  private async slugTaken(slug: string): Promise<boolean> {
    const [a, t] = await Promise.all([
      this.prisma.academy.findUnique({ where: { slug }, select: { id: true } }),
      this.prisma.teacherProfile.findUnique({ where: { slug }, select: { id: true } }),
    ]);
    return !!a || !!t;
  }

  /** Derived from the name: the first free candidate in the shared namespace. */
  private async resolveSlug(raw: string): Promise<string> {
    const base = slugify(raw);
    const shape = slugShapeError(base);
    if (shape) throw new BadRequestException({ message: 'Invalid center address', code: `SLUG_${shape}` });
    for (const candidate of slugCandidates(base)) {
      if (!(await this.slugTaken(candidate))) return candidate;
    }
    throw new ConflictException({ message: 'الرابط مستخدم بالفعل', code: 'SLUG_TAKEN' });
  }
}
