import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@darsly/shared-types';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { centerAdminActivationEmail } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { slugCandidates, slugify, slugShapeError } from '../academy/slug';
import { normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { CenterThemesService } from './center-themes.service';
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
    private readonly centerThemes: CenterThemesService,
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
      // Outside the transaction on purpose: an unusable theme id must not undo a
      // Center that is otherwise correctly created. `grantAtCreation` drops ids
      // it cannot resolve rather than refusing, and the list is editable after.
      await this.centerThemes.grantAtCreation(academy.id, dto.themeIds ?? [], adminUserId);
      await this.audit.log({
        actorUserId: adminUserId, action: 'center.create', entity: 'Academy', entityId: academy.id, academyId: academy.id,
        meta: { adminUserId: existing.id, adminIdentity: existing.role, activation: 'NOT_REQUIRED', themeGrants: dto.themeIds?.length ?? 0 },
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

    await this.centerThemes.grantAtCreation(created.academy.id, dto.themeIds ?? [], adminUserId);

    // Delivery is awaited and REPORTED, never assumed: the Center and its
    // inactive admin exist, the hashed token is stored, and nothing about that
    // changes if the provider fails — the admin simply learns it did (and can
    // reissue the link). Activation itself only ever happens through the token.
    const activationUrl = this.mail.webUrl(`/activate?token=${encodeURIComponent(rawToken)}`);
    const delivery = await this.mail.send({
      to: adminEmail,
      // TEMPORARY TEST ROUTING: opts this Center-activation email into
      // MailService's redirect — `adminEmail` stays the real recipient in the
      // DB row, the response and this call's own `to`. See
      // TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO. Remove once the provider works.
      centerOwnerTestRedirect: true,
      ...centerAdminActivationEmail({
        name: created.user.fullName,
        centerName: name,
        activationUrl,
        expiresInDays: ACTIVATION_TTL_DAYS,
      }),
    });
    const activation = delivery.delivered ? ('EMAIL_SENT' as const) : ('EMAIL_FAILED' as const);
    await this.audit.log({
      actorUserId: adminUserId, action: 'center.create', entity: 'Academy', entityId: created.academy.id, academyId: created.academy.id,
      meta: { adminUserId: created.user.id, adminIdentity: Role.STAFF, activation, themeGrants: dto.themeIds?.length ?? 0, ...(delivery.delivered ? {} : { deliveryFailure: delivery.reason }) },
    });
    return {
      ...created.academy,
      admin: { id: created.user.id, role: Role.STAFF, activation },
      delivery: delivery.delivered ? { delivered: true as const } : { delivered: false as const, reason: delivery.reason },
      // Handed to the SUPER_ADMIN who just minted this token, in the same
      // response — not a separate retrieval endpoint, and not public. Lets a
      // Center be activated for testing without depending on live email at
      // all: copy this link instead of waiting on Resend.
      activationUrl,
    };
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
    const activationUrl = this.mail.webUrl(`/activate?token=${encodeURIComponent(rawToken)}`);
    const delivery = await this.mail.send({
      to: academy.owner.email,
      centerOwnerTestRedirect: true, // TEMPORARY TEST ROUTING — same as createCenter
      ...centerAdminActivationEmail({
        name: academy.owner.fullName, centerName: academy.name,
        activationUrl,
        expiresInDays: ACTIVATION_TTL_DAYS,
      }),
    });
    await this.audit.log({
      actorUserId: adminUserId, action: 'center.activation.resend', entity: 'Academy', entityId: academyId, academyId,
      meta: delivery.delivered ? { delivered: true } : { delivered: false, deliveryFailure: delivery.reason },
    });
    // Same rationale as createCenter: the SUPER_ADMIN who just reissued this
    // token gets the link back directly, so a dead mail provider never blocks
    // testing — resend, copy the link, move on.
    return { ok: true, expiresAt, delivery: delivery.delivered ? { delivered: true as const } : { delivered: false as const, reason: delivery.reason }, activationUrl };
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

  /**
   * What deleting this Center would take with it.
   *
   * Read separately from the delete itself so the admin is told before they
   * type the address, not after — "delete" on an organisation that turns out to
   * hold a hundred students and live enrollments is a different decision from
   * deleting the empty one somebody set up by mistake last week.
   */
  async deletionImpact(academyId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: { id: true, slug: true, name: true, kind: true, status: true },
    });
    if (!academy) throw new NotFoundException({ message: 'Center not found', code: 'CENTER_NOT_FOUND' });

    const [staffCount, studentCount, activeEnrollments, courseCount, groupCount] = await Promise.all([
      this.prisma.academyMembership.count({ where: { academyId, role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] } } }),
      this.prisma.enrollment.findMany({ where: { academyId }, select: { studentId: true }, distinct: ['studentId'] }).then((r) => r.length),
      this.prisma.enrollment.count({ where: { academyId, status: 'ACTIVE' } }),
      this.prisma.course.count({ where: { academyId } }),
      this.prisma.group.count({ where: { academyId } }),
    ]);

    return {
      id: academy.id, slug: academy.slug, name: academy.name, kind: academy.kind, status: academy.status,
      staffCount, studentCount, activeEnrollments, courseCount, groupCount,
      // Nothing is destroyed — every table here is soft-deleted, so the row
      // survives for the money trail and can be brought back. Said explicitly
      // because "delete" otherwise reads as irreversible and stops people from
      // cleaning up test data they should be free to remove.
      reversible: true,
    };
  }

  /**
   * Remove a Center from the platform.
   *
   * There was no delete at all before this: a Center could be suspended or
   * archived and that was the end of the lifecycle, so an organisation created
   * by mistake — or one whose admin never activated, which left it PENDING and
   * therefore without even a suspend button in the console — stayed on the
   * platform for ever, holding its slug.
   *
   * Soft, through the same middleware every other removal on the platform uses
   * (PrismaService's SOFT_DELETE_MODELS): the Academy row is stamped, not
   * dropped, so payments, ledger entries and invoices keep pointing at
   * something real and an accidental delete is recoverable. Memberships go with
   * it in the same transaction — otherwise a staff member would keep a live
   * membership in an academy that no longer resolves, and `buildContext` would
   * be the only thing standing between them and a workspace that is gone.
   *
   * The slug is released: `slugTaken` only looks at live rows, so the address
   * is immediately reusable, which is what makes "delete and recreate it
   * properly" a real recovery path.
   */
  async deleteCenter(academyId: string, confirmSlug: string, adminUserId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: { id: true, slug: true, name: true, kind: true, status: true },
    });
    if (!academy) throw new NotFoundException({ message: 'Center not found', code: 'CENTER_NOT_FOUND' });
    // A PERSONAL academy IS a teacher's identity (its id is their
    // TeacherProfile id); removing it would orphan their courses without
    // removing the account. Deleting the teacher is a different action.
    if (academy.kind !== 'CENTER') {
      throw new BadRequestException({ message: 'Only a Center can be deleted here', code: 'NOT_A_CENTER' });
    }
    if (confirmSlug.trim().toLowerCase() !== academy.slug.toLowerCase()) {
      throw new BadRequestException({ message: 'The confirmation does not match this center address', code: 'CONFIRM_MISMATCH' });
    }

    await this.prisma.$transaction(async (tx) => {
      // Outstanding activation links die with the Center, or the admin who
      // never activated could still walk in through an email from last week.
      await tx.academyActivationToken.updateMany({
        where: { academyId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.academyMembership.deleteMany({ where: { academyId } });
      // ARCHIVED as well as stamped: `status` is what every list and
      // `buildContext` already branch on, so the Center stops resolving even
      // for a caller that reaches it without the soft-delete read filter.
      await tx.academy.update({ where: { id: academyId }, data: { status: 'ARCHIVED' } });
      await tx.academy.delete({ where: { id: academyId } });
    });

    await this.audit.log({
      actorUserId: adminUserId, action: 'center.delete', entity: 'Academy', entityId: academyId, academyId,
      meta: { slug: academy.slug, name: academy.name, fromStatus: academy.status },
    });
    return { ok: true as const, id: academyId, slug: academy.slug };
  }

  /**
   * Take one person's access to one Center away.
   *
   * The Center console can already remove its own staff, but only a member who
   * is not the OWNER — and a platform admin had no path of their own at all, so
   * "revoke access to this specific Center" was simply not expressible: the
   * only lever was suspending the whole organisation, which takes everyone's
   * access including the people who were using it correctly.
   *
   * The owner is included here, and only here. It is the one removal the
   * academy's own console must not offer (an owner could be talked into
   * removing themselves, and nobody would be left who could undo it), but a
   * platform admin revoking a Center admin who has left the company is a normal
   * operation — so it requires a replacement owner in the same call. A Center
   * with no owner has no one who can grant anybody else access again.
   */
  async revokeAccess(academyId: string, userId: string, adminUserId: string, transferOwnershipTo?: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: { id: true, kind: true, ownerUserId: true },
    });
    if (!academy) throw new NotFoundException({ message: 'Center not found', code: 'CENTER_NOT_FOUND' });

    const membership = await this.prisma.academyMembership.findFirst({
      where: { academyId, userId },
      select: { id: true, role: true },
    });
    if (!membership) throw new NotFoundException({ message: 'This person is not a member of this center', code: 'MEMBERSHIP_NOT_FOUND' });

    const isOwner = membership.role === 'OWNER' || academy.ownerUserId === userId;
    if (isOwner && !transferOwnershipTo) {
      throw new BadRequestException({
        message: 'Name the member who takes over as owner before revoking this one',
        code: 'OWNER_NEEDS_SUCCESSOR',
      });
    }

    let successorId: string | null = null;
    if (isOwner && transferOwnershipTo) {
      if (transferOwnershipTo === userId) {
        throw new BadRequestException({ message: 'The successor must be a different member', code: 'SUCCESSOR_IS_SAME_USER' });
      }
      const successor = await this.prisma.academyMembership.findFirst({
        where: { academyId, userId: transferOwnershipTo, status: 'ACTIVE', role: { in: ['TEACHER', 'ASSISTANT', 'OWNER'] } },
        select: { id: true, user: { select: { role: true, isActive: true, teacherProfile: { select: { status: true } } } } },
      });
      if (!successor) {
        throw new BadRequestException({ message: 'The successor must already be active staff of this center', code: 'SUCCESSOR_NOT_STAFF' });
      }
      this.assertDesignatable(successor.user);
      successorId = transferOwnershipTo;
    }

    await this.prisma.$transaction(async (tx) => {
      if (successorId) {
        await tx.academyMembership.updateMany({ where: { academyId, userId: successorId }, data: { role: 'OWNER' } });
        await tx.academy.update({ where: { id: academyId }, data: { ownerUserId: successorId } });
      }
      // Group assignments go too: a revoked teacher who kept an assignment row
      // would still be listed as the staff of a group they can no longer reach.
      await tx.groupAssignment.deleteMany({ where: { academyId, userId } });
      await tx.academyMembership.deleteMany({ where: { academyId, userId } });
      await tx.academyActivationToken.updateMany({
        where: { academyId, userId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log({
      actorUserId: adminUserId, action: 'center.access.revoke', entity: 'AcademyMembership', entityId: membership.id, academyId,
      meta: { userId, revokedRole: membership.role, ...(successorId ? { ownershipTransferredTo: successorId } : {}) },
    });
    return { ok: true as const, userId, ownerTransferredTo: successorId };
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
