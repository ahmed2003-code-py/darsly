import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AcademyService } from '../academy/academy.service';
import {
  LiveAccessMode,
  LivePipelineStatus,
  LiveRefundPolicy,
  LiveReplayPolicy,
  LiveSessionStatus,
  LiveTranscriptionMode,
  LiveVisibility,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationService } from '../gamification/gamification.service';
import { LIVE_MAX_DURATION_MIN } from './live-timing';
import {
  LIVE_PRICE_MAX_CENTS,
  LIVE_PRICE_MIN_CENTS,
  LIVE_REPLAY_DAYS_MAX,
  validateLiveSession,
} from '@darsly/shared-types';
import {
  CommercialTermsService,
  pricingRefusal,
  toSnapshot,
} from '../commerce/commercial-terms.service';
import { priceLiveSeat, PricingError } from '../commerce/pricing';
import { LiveCommerceService, lockSession, seatsTaken } from './commerce/live-commerce.service';
import { pipelineStages } from './live-pipeline';
import { recordingStage } from './recording/recording-stage';
import { LiveProviders } from './providers/live-providers';
import type { LiveProviderKind, RoomCloseResult } from './providers/live-provider';
import { RealtimeService } from '../realtime/realtime.service';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { StorageProvider } from '../storage/storage.provider';
import {
  acceptableAudioMime,
  AUDIO_PIECES_PER_MINUTE,
  AUDIO_SEGMENT_MIN_BYTES,
  audioKey,
  CAPTURE_OFF_GRACE_MS,
  LAST_PIECE_GRACE_MS,
  sniffAudio,
  transcriptionConfig,
  validPieceSeq,
} from './transcription/lesson-transcription';
import { transcriptCaptureState } from './transcription/capture-state';
import { finalizeTranscript } from './transcription/transcript-assembly';
import { queueLiveSummary, type SummaryJobs } from './summary/summary-queue';
import { forViewers } from './summary/grounded-summary';
import { paidReplayVerdict } from './commerce/replay-entitlement';

/** How long before the scheduled time the doors open. */
export const JOIN_OPENS_MIN = 15;
/**
 * The dialect the provider is asked to listen for. This is an Egyptian
 * platform, and the recogniser has an Egyptian model: "ar" hears Modern
 * Standard Arabic, which is not what anyone teaches a class in.
 */
const ARABIC_LESSON = 'ar-EG';
/**
 * How long a silence may last before it counts as absence rather than a
 * stutter. Comfortably longer than the heartbeat interval, so one dropped
 * request does not cost a student the minutes they were actually sitting there.
 */
export const PRESENCE_GRACE_SEC = 90;
/** The class chat, a page at a time: the classroom's first read, and the archive's scroll-back. */
export const CHAT_PAGE_DEFAULT = 200;
export const CHAT_PAGE_MAX = 200;
/** How much of the transcript the archive card shows before "show all". */
export const TRANSCRIPT_PREVIEW_SEGMENTS = 3;
/**
 * How long a summary may say PROCESSING with no job behind it before it counts
 * as abandoned — a worker that died on its last attempt, or a process killed
 * between claiming the summary and queueing it. Far longer than the moment
 * between those two steps, so a second press of the button never mistakes a
 * request still being made for one that was lost.
 */
export const SUMMARY_STALE_MS = 2 * 60_000;
/**
 * A transcript PROCESSING this long with no job queued or running, and no live
 * lease, is stalled — shown as a failure and picked up by recovery. Longer
 * than the longest legitimate quiet stretch (a 15-minute delayed retry).
 */
export const TRANSCRIPT_STALE_MS = 20 * 60_000;
/** How many times recovery may re-queue one class's transcript. */
export const TRANSCRIPT_MAX_RECOVERIES = 2;
export { LIVE_MAX_DURATION_MIN } from './live-timing';

/** Why a class ended — the teacher, the clock, or a cancellation. */
export type LiveEndReason = 'MANUAL' | 'SCHEDULED_END' | 'CANCELLED';
/**
 * How long after a class's end its "ended" events are still worth sending.
 * A backlog of classes nobody ended (before the end sweep existed) is closed
 * quietly — nobody is sitting in those rooms.
 */
const END_ANNOUNCE_WINDOW_MS = 30 * 60_000;
/**
 * What counts as having attended, for the LIVE_ATTENDED reward.
 *
 * A share of the class, the same idea a recorded lesson uses (90% watched
 * completes it — see PlaybackService), but capped at an absolute amount: a
 * two-hour revision session should not ask for an hour before it counts, and a
 * short class should not be unreachable for someone who joined a minute late.
 * The threshold is min(LIVE_ATTENDED_MIN_SECONDS, LIVE_ATTENDED_MIN_SHARE ×
 * the session's current length) — so an extension raises it with the class.
 * Counted from accumulated heartbeat time, across reconnects.
 */
export const LIVE_ATTENDED_MIN_SECONDS = 10 * 60;
export const LIVE_ATTENDED_MIN_SHARE = 0.5;
export function liveAttendedThresholdSec(durationMin: number): number {
  return Math.min(LIVE_ATTENDED_MIN_SECONDS, Math.ceil(durationMin * 60 * LIVE_ATTENDED_MIN_SHARE));
}

/** What a client needs to draw the clock, always from the server's own time. */
export interface LiveTiming {
  sessionId: string;
  status: LiveSessionStatus;
  startsAt: Date;
  /** When the teacher actually opened the room; null before that. */
  startedAt: Date | null;
  /** The session's effective end (scheduled end, as extended). */
  endsAt: Date;
  /** The server's clock at the moment this was produced — for drift. */
  serverNow: Date;
}

export interface UpsertLiveDto {
  title: string;
  description?: string;
  startsAt: string;
  durationMin?: number;
  capacity?: number | null;
  courseId?: string | null;
  joinUrl?: string | null;
  /** The teacher who runs it; defaults to the caller when they are a teacher. Validated server-side. */
  teacherUserId?: string | null;
  /** Restricts the audience to one group of the academy. */
  groupId?: string | null;
  /** OFF / MANUAL / AUTO_WHEN_RECORDING; the platform default when absent. */
  transcriptionMode?: LiveTranscriptionMode;
  /** FREE (default) or PAID — explicit, never inferred from a price. */
  accessMode?: LiveAccessMode;
  /** PAID only: the seller's price in piasters. */
  priceCents?: number | null;
  refundPolicy?: LiveRefundPolicy;
  replayPolicy?: LiveReplayPolicy;
  replayDays?: number | null;
}

/** A field-level refusal in the same shape LIVE_SESSION_RULES produces. */
type CommerceFieldError = { field: string; code: string; params?: Record<string, number> };

/**
 * Who is acting on live sessions and where. Built by the controller from the
 * validated AcademyContext — never from the body. OWNER (incl. platform
 * admin) reaches every stream in the academy; a TEACHER member only their
 * own. tenantId (authorship) is derived from the assigned teacher's profile.
 */
export interface LiveScope {
  academyId: string;
  userId: string;
  manageAll: boolean;
  role: string;
}

@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly gamification: GamificationService,
    private readonly providers: LiveProviders,
    private readonly realtime: RealtimeService,
    private readonly jobs: AiJobService,
    private readonly academy: AcademyService,
    /** Only the lesson-audio upload writes to it. */
    @Optional() private readonly storage?: StorageProvider,
    /** Prices a PAID session; a FREE one never needs it. */
    @Optional() private readonly terms?: CommercialTermsService,
    /** Refunds a PAID session's buyers when it is called off. */
    @Optional() private readonly commerce?: LiveCommerceService,
  ) {}

  /**
   * FREE or PAID, and what PAID needs: a price inside the bounds, a known
   * refund and replay policy, and no external meeting link — a paid seat is
   * enforced by Darsly's own classroom, and a Zoom link handed to a booked
   * student is a link anyone can be forwarded.
   *
   * `existing` is the stored session on an edit: the fields not being changed
   * are read from it, so a partial edit is judged as the whole it produces.
   */
  private commerceFieldErrors(
    dto: Partial<UpsertLiveDto>,
    existing?: {
      accessMode: LiveAccessMode;
      priceCents: number | null;
      replayPolicy: LiveReplayPolicy;
      replayDays: number | null;
      joinUrl: string | null;
    },
  ): CommerceFieldError[] {
    const out: CommerceFieldError[] = [];
    const mode = dto.accessMode ?? existing?.accessMode ?? 'FREE';
    if (mode !== 'FREE' && mode !== 'PAID')
      out.push({ field: 'accessMode', code: 'ACCESS_MODE_INVALID' });
    const price = dto.priceCents !== undefined ? dto.priceCents : (existing?.priceCents ?? null);
    if (mode === 'PAID') {
      if (price == null) out.push({ field: 'priceCents', code: 'PRICE_REQUIRED' });
      else if (!Number.isSafeInteger(price))
        out.push({ field: 'priceCents', code: 'PRICE_INVALID' });
      else if (price < LIVE_PRICE_MIN_CENTS)
        out.push({
          field: 'priceCents',
          code: 'PRICE_TOO_LOW',
          params: { min: LIVE_PRICE_MIN_CENTS },
        });
      else if (price > LIVE_PRICE_MAX_CENTS)
        out.push({
          field: 'priceCents',
          code: 'PRICE_TOO_HIGH',
          params: { max: LIVE_PRICE_MAX_CENTS },
        });
      const joinUrl = dto.joinUrl !== undefined ? dto.joinUrl : (existing?.joinUrl ?? null);
      if (joinUrl) out.push({ field: 'joinUrl', code: 'PAID_NEEDS_DARSLY_CLASSROOM' });
    } else if (dto.priceCents != null) {
      out.push({ field: 'priceCents', code: 'PRICE_ON_FREE_SESSION' });
    }
    const replay = dto.replayPolicy ?? existing?.replayPolicy ?? 'INCLUDED_FOREVER';
    const days =
      dto.replayDays !== undefined
        ? dto.replayDays
        : dto.replayPolicy
          ? null
          : (existing?.replayDays ?? null);
    if (replay === 'INCLUDED_DAYS') {
      if (days == null || !Number.isSafeInteger(days) || days < 1 || days > LIVE_REPLAY_DAYS_MAX)
        out.push({
          field: 'replayDays',
          code: 'REPLAY_DAYS_INVALID',
          params: { max: LIVE_REPLAY_DAYS_MAX },
        });
    } else if (dto.replayDays != null) {
      out.push({ field: 'replayDays', code: 'REPLAY_DAYS_UNUSED' });
    }
    return out;
  }

  /** The commerce columns an accepted DTO writes (FREE clears the price). */
  private commerceData(dto: Partial<UpsertLiveDto>, existing?: { accessMode: LiveAccessMode }) {
    const mode = dto.accessMode ?? existing?.accessMode;
    return {
      ...(dto.accessMode !== undefined ? { accessMode: dto.accessMode } : {}),
      ...(mode === 'FREE'
        ? { priceCents: null }
        : dto.priceCents !== undefined
          ? { priceCents: dto.priceCents }
          : {}),
      ...(dto.refundPolicy !== undefined ? { refundPolicy: dto.refundPolicy } : {}),
      ...(dto.replayPolicy !== undefined
        ? {
            replayPolicy: dto.replayPolicy,
            replayDays: dto.replayPolicy === 'INCLUDED_DAYS' ? (dto.replayDays ?? null) : null,
          }
        : dto.replayDays !== undefined
          ? { replayDays: dto.replayDays }
          : {}),
    };
  }

  /**
   * Price a PAID session under the terms in force for its academy, with the
   * split agreed for its teacher. Refuses a price the terms cannot sell (a
   * deducted fixed fee as large as the price) and a Center with no agreed
   * split — both before anyone could buy a seat.
   */
  async priceSession(academyId: string, tenantId: string, priceCents: number, discountCents = 0) {
    if (!this.terms) throw new Error('CommercialTermsService is not available');
    const terms = await this.terms.effectiveFor(academyId);
    const split = await this.terms.splitFor(academyId, tenantId);
    try {
      return priceLiveSeat({
        basePriceCents: priceCents,
        discountCents,
        terms: toSnapshot(terms),
        split,
      });
    } catch (e) {
      if (e instanceof PricingError) pricingRefusal(e);
      throw e;
    }
  }

  // ── Teacher ────────────────────────────────────────────────────────────────

  /**
   * The product's rules for a session (LIVE_SESSION_RULES, shared with the
   * form). Every broken rule is returned at once, each naming its field and a
   * code the form turns into a sentence under that field.
   */
  private assertValidSession(
    dto: Partial<UpsertLiveDto>,
    opts: { creating: boolean; checkPast: boolean },
    existing?: Parameters<LiveService['commerceFieldErrors']>[1],
  ) {
    const errors: CommerceFieldError[] = validateLiveSession(
      {
        title: dto.title ?? (opts.creating ? '' : 'xx'),
        description: dto.description ?? '',
        startsAt: dto.startsAt ?? (opts.creating ? null : new Date().toISOString()),
        durationMin: dto.durationMin ?? 60,
        capacity: dto.capacity ?? null,
      },
      opts.checkPast ? Date.now() : -Infinity,
    );
    errors.push(...this.commerceFieldErrors(dto, existing));
    if (errors.length) {
      throw new BadRequestException({
        message: 'Some fields are invalid',
        code: 'LIVE_SESSION_INVALID',
        fields: errors,
      });
    }
  }

  async create(scope: LiveScope, dto: UpsertLiveDto) {
    this.assertValidSession(dto, { creating: true, checkPast: true });
    // The stream's teacher: named explicitly, or the caller when they are a
    // teacher themselves. STAFF must name one — they can schedule, never teach.
    const teacher = await this.academy.assertAssignableTeacher(
      scope.academyId,
      dto.teacherUserId ?? scope.userId,
    );
    const groupId = await this.resolveGroup(scope, dto.groupId ?? null, teacher.userId);
    // A paid seat must be sellable before it is offered: the academy's terms
    // and (in a Center) the teacher's split are checked now, not at checkout.
    if (dto.accessMode === 'PAID') {
      await this.priceSession(scope.academyId, teacher.teacherProfileId, dto.priceCents as number);
    }
    const startsAt = new Date(dto.startsAt);
    const durationMin = dto.durationMin ?? 60;
    // The overlap check and the insert are one step, one teacher at a time: a
    // double-clicked "create" (or two tabs) sends two requests a few ms apart,
    // and without the lock both could pass the check before either inserted —
    // two identical classes. The second now waits, then finds the first and
    // is refused as a clash.
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-teacher:${teacher.userId}`}))`;
      await this.assertTeacherFree(scope, teacher.userId, startsAt, durationMin, undefined, tx);
      return tx.liveSession.create({
        data: {
          tenantId: teacher.teacherProfileId,
          academyId: scope.academyId,
          teacherUserId: teacher.userId,
          groupId,
          title: dto.title.trim(),
          description: dto.description ?? '',
          startsAt,
          durationMin,
          capacity: dto.capacity ?? null,
          courseId: dto.courseId ?? null,
          joinUrl: dto.joinUrl ?? null,
          // Fixed here, for the life of the class: a later change to
          // LIVE_PROVIDER moves new classes, never this one.
          provider: this.providers.defaultKind,
          // The platform's default; the teacher may change it before or during
          // the class. Nothing is captured while the global switch is off.
          transcriptionMode: dto.transcriptionMode ?? transcriptionConfig().defaultMode,
          ...this.commerceData(dto),
        },
      });
    });
    await this.announceToStudents(session, session.title, session.startsAt);
    return session;
  }

  /** The teacher-facing breakdown of a PAID price (see LiveController.pricePreview). */
  async pricePreview(scope: LiveScope, priceCents: number, teacherUserId: string | null) {
    const errors = this.commerceFieldErrors({ accessMode: 'PAID', priceCents });
    if (errors.length)
      throw new BadRequestException({
        message: 'Invalid price',
        code: 'LIVE_SESSION_INVALID',
        fields: errors,
      });
    const teacher = await this.academy.assertAssignableTeacher(
      scope.academyId,
      teacherUserId ?? scope.userId,
    );
    const p = await this.priceSession(scope.academyId, teacher.teacherProfileId, priceCents);
    const academy = await this.prisma.academy.findUnique({
      where: { id: scope.academyId },
      select: { kind: true },
    });
    return {
      kind: academy?.kind ?? 'PERSONAL',
      currency: 'EGP',
      priceCents: p.basePriceCents,
      feeCents: p.feeCents,
      feeMode: p.feeMode,
      studentPaysCents: p.studentPaysCents,
      teacherCents: p.teacherCents,
      centerCents: p.centerCents,
      teacherSharePercent: p.teacherSharePercent,
    };
  }

  /** A group must be offered in this academy, and the teacher must be assigned to it (an OWNER may take their own group unassigned). */
  private async resolveGroup(
    scope: LiveScope,
    groupId: string | null,
    teacherUserId: string,
  ): Promise<string | null> {
    if (!groupId) return null;
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, academyId: scope.academyId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const ownerSelf = scope.role === 'OWNER' && teacherUserId === scope.userId;
    if (!ownerSelf) {
      const assigned = await this.prisma.groupAssignment.findFirst({
        where: { groupId, userId: teacherUserId },
        select: { id: true },
      });
      if (!assigned)
        throw new BadRequestException({
          message: 'That teacher is not assigned to this group',
          code: 'TEACHER_NOT_IN_GROUP',
          field: 'teacherUserId',
        });
    }
    return groupId;
  }

  /**
   * A person cannot be in two places at once — physical or online, in any
   * academy. GroupSession already enforces this against itself at the DB
   * level; this is the application-level bridge across the two tables.
   * A colliding session from another academy is reported by kind only.
   */
  private async assertTeacherFree(
    scope: LiveScope,
    teacherUserId: string,
    startsAt: Date,
    durationMin: number,
    excludeId?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
    const group = await db.groupSession.findFirst({
      where: {
        teacherUserId,
        status: { not: 'CANCELLED' },
        startAt: { lt: endsAt },
        endAt: { gt: startsAt },
      },
      select: { id: true, academyId: true },
    });
    if (group) {
      throw new ConflictException({
        message: 'The teacher already has a session in this window',
        code: 'TEACHER_CONFLICT',
        conflictingSessionId: group.academyId === scope.academyId ? group.id : undefined,
      });
    }
    const others = await db.liveSession.findMany({
      where: {
        teacherUserId,
        status: { not: 'ENDED' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startsAt: { lt: endsAt },
      },
      select: { id: true, academyId: true, startsAt: true, durationMin: true },
    });
    const clash = others.find(
      (o) => new Date(o.startsAt.getTime() + o.durationMin * 60_000) > startsAt,
    );
    if (clash) {
      throw new ConflictException({
        message: 'The teacher already has a live session in this window',
        code: 'TEACHER_CONFLICT',
        conflictingSessionId: clash.academyId === scope.academyId ? clash.id : undefined,
      });
    }
  }

  async update(scope: LiveScope, id: string, dto: Partial<UpsertLiveDto>) {
    const existing = await this.assertOwned(scope, id);
    // A start time is only refused for being in the past when it is the thing
    // being changed: renaming yesterday's class is not rescheduling it.
    this.assertValidSession(
      dto,
      {
        creating: false,
        checkPast:
          dto.startsAt != null && new Date(dto.startsAt).getTime() !== existing.startsAt.getTime(),
      },
      existing,
    );
    const changed = this.changedFields(existing, dto);
    await this.assertEditAllowed(existing, dto, changed);
    await this.assertCommerceEditable(existing, dto);
    let teacher: { userId: string; teacherProfileId: string } | null = null;
    if (dto.teacherUserId != null && dto.teacherUserId !== existing.teacherUserId) {
      teacher = await this.academy.assertAssignableTeacher(scope.academyId, dto.teacherUserId);
    }
    const teacherUserId = teacher?.userId ?? existing.teacherUserId;
    const groupId =
      dto.groupId !== undefined
        ? await this.resolveGroup(scope, dto.groupId, teacherUserId ?? scope.userId)
        : existing.groupId;
    const startsAt = dto.startsAt != null ? new Date(dto.startsAt) : existing.startsAt;
    const durationMin = dto.durationMin ?? existing.durationMin;
    // A class that is running has a room whose expiry was set from its timing.
    // Editing the timing here would move Darsly's clock and not Daily's — the
    // room would still eject everyone at the old time. The one way to change a
    // running class's length is `extend`, which moves both.
    const timingChanged =
      startsAt.getTime() !== existing.startsAt.getTime() || durationMin !== existing.durationMin;
    if (timingChanged && existing.status === 'LIVE' && existing.roomName) {
      throw new ConflictException({
        message: 'The class is running — extend it instead of editing its time',
        code: 'LIVE_TIMING_LOCKED',
      });
    }
    if (teacherUserId && (teacher || dto.startsAt != null || dto.durationMin != null)) {
      await this.assertTeacherFree(scope, teacherUserId, startsAt, durationMin, id);
    }
    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: {
        ...(teacher ? { tenantId: teacher.teacherProfileId, teacherUserId: teacher.userId } : {}),
        ...(dto.groupId !== undefined ? { groupId } : {}),
        ...(dto.title != null ? { title: dto.title.trim() } : {}),
        ...(dto.description != null ? { description: dto.description } : {}),
        ...(dto.startsAt != null ? { startsAt: new Date(dto.startsAt) } : {}),
        ...(dto.durationMin != null ? { durationMin: dto.durationMin } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.courseId !== undefined ? { courseId: dto.courseId } : {}),
        ...(dto.joinUrl !== undefined ? { joinUrl: dto.joinUrl } : {}),
        ...this.commerceData(dto, existing),
      },
    });
    // A class moved in time is said out loud to everyone holding a seat, and
    // recorded: a buyer's seat and price stay exactly as they were.
    if (changed.has('startsAt') || changed.has('durationMin')) {
      await this.announceReschedule(updated, existing.startsAt, scope.userId);
    }
    return updated;
  }

  /** The fields an edit actually changes (the form sends every field every time). */
  private changedFields(
    existing: Prisma.LiveSessionGetPayload<object>,
    dto: Partial<UpsertLiveDto>,
  ): Set<keyof UpsertLiveDto> {
    const out = new Set<keyof UpsertLiveDto>();
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    if (dto.title != null && dto.title.trim() !== existing.title) out.add('title');
    if (dto.description != null && dto.description !== existing.description) out.add('description');
    if (dto.startsAt != null && new Date(dto.startsAt).getTime() !== existing.startsAt.getTime())
      out.add('startsAt');
    if (dto.durationMin != null && dto.durationMin !== existing.durationMin) out.add('durationMin');
    if (dto.capacity !== undefined && !same(dto.capacity, existing.capacity)) out.add('capacity');
    if (dto.courseId !== undefined && !same(dto.courseId, existing.courseId)) out.add('courseId');
    if (dto.joinUrl !== undefined && !same(dto.joinUrl, existing.joinUrl)) out.add('joinUrl');
    if (dto.teacherUserId != null && dto.teacherUserId !== existing.teacherUserId)
      out.add('teacherUserId');
    if (dto.groupId !== undefined && !same(dto.groupId, existing.groupId)) out.add('groupId');
    if (dto.accessMode !== undefined && dto.accessMode !== existing.accessMode)
      out.add('accessMode');
    if (dto.priceCents !== undefined && !same(dto.priceCents, existing.priceCents))
      out.add('priceCents');
    if (dto.refundPolicy !== undefined && dto.refundPolicy !== existing.refundPolicy)
      out.add('refundPolicy');
    if (dto.replayPolicy !== undefined && dto.replayPolicy !== existing.replayPolicy)
      out.add('replayPolicy');
    if (dto.replayDays !== undefined && !same(dto.replayDays, existing.replayDays))
      out.add('replayDays');
    return out;
  }

  /**
   * Who is committed to this session: students who booked, and anyone with a
   * purchase still in play (a hold, a transfer being checked, a confirmed or
   * delivered seat, a refund in flight). Guests have no LiveBooking — their
   * seat is the purchase — which is exactly why bookings alone were not
   * enough (a PAID session could be flipped to FREE under paying guests).
   */
  async commitment(sessionId: string, now = new Date()) {
    const [bookings, purchases, taken] = await Promise.all([
      this.prisma.liveBooking.count({ where: { sessionId } }),
      this.prisma.livePurchase.count({
        where: {
          sessionId,
          OR: [
            {
              status: {
                in: ['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW', 'REFUND_PENDING', 'PAYMENT_PENDING'],
              },
            },
            { status: 'HELD', holdExpiresAt: { gt: now } },
            { payment: { status: { in: ['PENDING', 'PAID'] } } },
          ],
        },
      }),
      seatsTaken(this.prisma, sessionId, now),
    ]);
    return { bookings, purchases, seatsTaken: taken, committed: bookings + purchases > 0 };
  }

  /**
   * What a teacher may change, by the session's state — decided here, where
   * the rules are enforced, and handed to the page so it can say so.
   *
   *   SCHEDULED, nobody committed → everything.
   *   SCHEDULED, people committed → title, description, a LATER start, the
   *     length, a capacity no lower than the seats already taken, and the
   *     price / refund / replay terms for NEW buyers only (every purchase keeps
   *     the terms it was made under). Never FREE↔PAID, never the teacher or
   *     group (the seller and the audience people paid for).
   *   LIVE → title and description; time only through "extend".
   *   ENDED or CANCELLED → read-only.
   */
  editPolicy(
    s: {
      status: LiveSessionStatus;
      startsAt: Date;
      durationMin: number;
      cancelledAt: Date | null;
      deletedAt: Date | null;
    },
    committed: boolean,
  ) {
    const all: (keyof UpsertLiveDto)[] = [
      'title',
      'description',
      'startsAt',
      'durationMin',
      'capacity',
      'courseId',
      'joinUrl',
      'teacherUserId',
      'groupId',
      'accessMode',
      'priceCents',
      'refundPolicy',
      'replayPolicy',
      'replayDays',
    ];
    if (s.cancelledAt || s.deletedAt)
      return { state: 'CANCELLED' as const, editable: [] as string[], committed };
    const status = this.effectiveStatus(s);
    if (status === 'ENDED') return { state: 'ENDED' as const, editable: [] as string[], committed };
    if (status === 'LIVE')
      return { state: 'LIVE' as const, editable: ['title', 'description'], committed };
    const editable = committed
      ? all.filter((f) => !['accessMode', 'teacherUserId', 'groupId'].includes(f))
      : all;
    return { state: 'SCHEDULED' as const, editable: editable as string[], committed };
  }

  private async assertEditAllowed(
    existing: Prisma.LiveSessionGetPayload<object>,
    dto: Partial<UpsertLiveDto>,
    changed: Set<keyof UpsertLiveDto>,
  ) {
    if (!changed.size) return;
    const c = await this.commitment(existing.id);
    const policy = this.editPolicy(existing, c.committed);
    const refused = [...changed].filter((f) => !policy.editable.includes(f));
    if (refused.length) {
      const code =
        policy.state === 'ENDED' || policy.state === 'CANCELLED'
          ? 'SESSION_READ_ONLY'
          : policy.state === 'LIVE'
            ? 'LIVE_EDIT_LOCKED'
            : refused.includes('accessMode')
              ? 'ACCESS_MODE_LOCKED'
              : 'EDIT_LOCKED_COMMITTED';
      throw new ConflictException({
        message: `These cannot change now: ${refused.join(', ')}`,
        code,
        fields: refused.map((field) => ({ field, code })),
      });
    }
    if (
      c.committed &&
      changed.has('startsAt') &&
      dto.startsAt &&
      new Date(dto.startsAt) < existing.startsAt
    ) {
      // Earlier would shrink the refund window people bought under, and may
      // start the class before a buyer can make it: only later is allowed.
      throw new ConflictException({
        message: 'People already hold seats — the class can only be moved later',
        code: 'RESCHEDULE_EARLIER_LOCKED',
        fields: [{ field: 'startsAt', code: 'RESCHEDULE_EARLIER_LOCKED' }],
      });
    }
    if (changed.has('capacity') && dto.capacity != null && dto.capacity < c.seatsTaken) {
      throw new ConflictException({
        message: `${c.seatsTaken} seats are already taken`,
        code: 'CAPACITY_BELOW_TAKEN',
        taken: c.seatsTaken,
        fields: [
          { field: 'capacity', code: 'CAPACITY_BELOW_TAKEN', params: { min: c.seatsTaken } },
        ],
      });
    }
  }

  /** Everyone holding a seat hears that the class moved (guests see it on their page). */
  private async announceReschedule(
    s: {
      id: string;
      title: string;
      startsAt: Date;
      durationMin: number;
      academyId: string | null;
      tenantId: string;
    },
    oldStartsAt: Date,
    actorUserId: string,
  ) {
    const holders = await this.prisma.liveBooking.findMany({
      where: { sessionId: s.id },
      select: { student: { select: { userId: true } } },
    });
    const buyers = await this.prisma.livePurchase.findMany({
      where: {
        sessionId: s.id,
        studentId: { not: null },
        status: { in: ['HELD', 'PAYMENT_PENDING'] },
      },
      select: { student: { select: { userId: true } } },
    });
    const users = [
      ...new Set(
        [...holders, ...buyers].map((h) => h.student?.userId).filter((u): u is string => !!u),
      ),
    ];
    const when = s.startsAt.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    await Promise.all(
      users.map((userId) =>
        this.notifications.create({
          userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'موعد الجلسة اتغيّر 🕒',
          body: `«${s.title}» بقت يوم ${when} (${s.durationMin} دقيقة). حجزك زي ما هو.`,
          meta: { sessionId: s.id, rescheduled: true },
        }),
      ),
    );
    await this.prisma.auditLog
      .create({
        data: {
          actorUserId,
          action: 'live.reschedule',
          entity: 'LiveSession',
          entityId: s.id,
          academyId: s.academyId ?? s.tenantId,
          meta: {
            from: oldStartsAt.toISOString(),
            to: s.startsAt.toISOString(),
            notified: users.length,
          } as never,
        },
      })
      .catch(() => undefined);
  }

  /**
   * The teacher's page for one session: what it is, who is in it, what was
   * sold (the teacher's side only — never Darsly's fee), the link to share,
   * and what may still be changed.
   */
  async teacherDetail(scope: LiveScope, id: string) {
    const s = await this.assertOwned(scope, id);
    const now = new Date();
    const c = await this.commitment(id, now);
    const purchases = await this.prisma.livePurchase.findMany({
      where: { sessionId: id },
      select: {
        status: true,
        guestBuyerId: true,
        basePriceCents: true,
        teacherCents: true,
        payment: { select: { status: true, claimedAt: true } },
      },
    });
    const sold = purchases.filter((p) => p.basePriceCents > 0);
    const seated = ['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'];
    const guestSeats = purchases.filter((p) => p.guestBuyerId && seated.includes(p.status)).length;
    const status = this.effectiveStatus(s);
    return {
      session: {
        id: s.id,
        title: s.title,
        description: s.description,
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        capacity: s.capacity,
        accessMode: s.accessMode,
        priceCents: s.priceCents,
        currency: s.currency,
        refundPolicy: s.refundPolicy,
        replayPolicy: s.replayPolicy,
        replayDays: s.replayDays,
        groupId: s.groupId,
        joinUrl: s.joinUrl,
        status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        cancelledAt: s.cancelledAt,
        joinOpensAt: new Date(this.opensAt(s)),
        closesAt: new Date(this.closesAt(s)),
      },
      // A group's class is for its group: it has no public link.
      publicPath: s.groupId ? null : `/live/s/${s.id}`,
      seats: {
        capacity: s.capacity,
        taken: c.seatsTaken,
        studentBookings: c.bookings,
        guestSeats,
      },
      sales:
        s.accessMode === 'PAID' || sold.length
          ? {
              confirmed: sold.filter((p) => seated.includes(p.status)).length,
              awaitingPayment: sold.filter(
                (p) =>
                  p.status === 'PAYMENT_PENDING' ||
                  (p.status === 'HELD' && p.payment?.status === 'PENDING'),
              ).length,
              held: sold.filter((p) => p.status === 'HELD' && !p.payment).length,
              refunded: sold.filter((p) =>
                ['REFUNDED', 'REFUND_PENDING', 'OVERSOLD', 'CANCELLED_BY_TEACHER'].includes(
                  p.status,
                ),
              ).length,
              // The teacher's own share of seats sold (held until the class is delivered).
              teacherCents: sold
                .filter((p) => seated.includes(p.status) && p.payment?.status === 'PAID')
                .reduce((a, p) => a + p.teacherCents, 0),
            }
          : null,
      edit: this.editPolicy(s, c.committed),
    };
  }

  /**
   * A registered student's standing on one session — for the session's own
   * page (reached from a shared link), where the list may not include it.
   */
  async myAccess(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const s = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!s || s.deletedAt) throw new NotFoundException('Session not found');
    const booking = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
      select: { id: true },
    });
    const status = this.effectiveStatus(s);
    return {
      booked: !!booking,
      status,
      accessMode: s.accessMode,
      joinOpensAt: new Date(this.opensAt(s)),
      closesAt: new Date(this.closesAt(s)),
      canJoin: !!booking && status === 'LIVE' && Date.now() >= this.opensAt(s),
      // A FREE class shared by its link can be booked by any student; a
      // group's class only by its group (the booking itself checks).
      canBook: !booking && s.accessMode === 'FREE' && status !== 'ENDED',
      serverNow: new Date(),
    };
  }

  /**
   * What an edit may not change once people have committed to the session.
   *
   * FREE ↔ PAID is fixed from the first booking: flipping it would either
   * charge people who booked for free or give away seats others paid for. A
   * new price is allowed — every purchase already made keeps the price it was
   * made at — but it is still checked against the terms, like a new session.
   */
  private async assertCommerceEditable(
    existing: {
      id: string;
      academyId: string | null;
      tenantId: string;
      accessMode: LiveAccessMode;
      priceCents: number | null;
    },
    dto: Partial<UpsertLiveDto>,
  ) {
    const modeChanges = dto.accessMode !== undefined && dto.accessMode !== existing.accessMode;
    if (modeChanges) {
      const committed = await this.prisma.liveBooking.count({ where: { sessionId: existing.id } });
      if (committed > 0)
        throw new ConflictException({
          message:
            'Students have already booked — a session cannot switch between free and paid now',
          code: 'ACCESS_MODE_LOCKED',
        });
    }
    const mode = dto.accessMode ?? existing.accessMode;
    const price = dto.priceCents !== undefined ? dto.priceCents : existing.priceCents;
    if (mode === 'PAID' && (modeChanges || dto.priceCents !== undefined) && price != null) {
      await this.priceSession(existing.academyId ?? existing.tenantId, existing.tenantId, price);
    }
  }

  /**
   * The teacher calls a session off.
   *
   * Still a soft delete — the row, its bookings and its attendance all stay,
   * because they are the record of who was promised what. What changed is
   * everything around it: the cancellation is stamped with its time and
   * reason, the students who booked are told (they used to find out by the
   * session silently vanishing from their list), a class that was running is
   * closed properly instead of left with an open room until it expired, and
   * the act is written to the audit log.
   *
   * A session whose time has already passed is just tidied away: nobody is
   * waiting for it, so nobody is notified.
   */
  async remove(scope: LiveScope, id: string, actorUserId?: string, reason?: string) {
    const session = await this.assertOwned(scope, id);
    const now = new Date();
    // A room is open for any LIVE session — including one whose time is up but
    // the end sweep has not reached yet.
    const wasLive = session.status === 'LIVE';
    const stillAhead = session.status !== 'ENDED' && !this.pastWindow(session);
    const why = reason?.trim().slice(0, 500) || null;

    // Close the class first, through the same path every end takes: the room
    // is deleted (everyone in it removed) and attendance closed, or — if the
    // provider refuses — nothing is written and the cancellation can be tried
    // again, rather than a cancelled session with a room still running.
    if (wasLive) await this.endSession(id, 'CANCELLED');

    // One write: the stamp, the reason, and the soft delete itself. Setting
    // `deletedAt` here is exactly what the middleware's delete would do, and
    // doing it in the same statement means there is no moment where a session
    // is cancelled but still listed, or listed as deleted with no reason.
    await this.prisma.liveSession.update({
      where: { id },
      data: {
        cancelledAt: now,
        cancelReason: why,
        deletedAt: now,
      },
    });
    if (wasLive) {
      this.realtime.emitToLive(id, 'live:ended', { sessionId: id, cancelled: true });
    }
    // Paid seats: everyone who paid gets it all back, and nobody is paid out.
    // A failure here is retried by the commerce sweep; it never undoes the
    // cancellation itself.
    let refunded = 0;
    if (session.accessMode === 'PAID' && this.commerce) {
      refunded = await this.commerce
        .onSessionCancelled(id, actorUserId ?? scope.userId)
        .then((r) => r.refunded)
        .catch((e) => {
          this.logger.error(
            `live.cancel refunds liveSession=${id} failed, sweep will retry: ${(e as Error).message}`,
          );
          return 0;
        });
    }

    const booked = stillAhead
      ? await this.prisma.liveBooking.findMany({
          where: { sessionId: id },
          select: { student: { select: { userId: true } } },
        })
      : [];
    for (const b of booked) {
      // The same event the list already listens on, so it drops the card
      // without a reload. `cancelled` lets a page tell the two apart.
      this.realtime.emitToUser(b.student.userId, 'live:ended', { sessionId: id, cancelled: true });
    }
    await Promise.all(
      booked.map((b) =>
        this.notifications.create({
          userId: b.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'الجلسة المباشرة اتلغت ❌',
          body: why
            ? `«${session.title}» اتلغت. السبب: ${why}`
            : `«${session.title}» اتلغت من المدرّس.`,
          meta: { sessionId: id, cancelled: true },
        }),
      ),
    );

    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: actorUserId ?? scope.userId,
          action: 'live.cancel',
          entity: 'LiveSession',
          entityId: id,
          academyId: session.academyId ?? session.tenantId,
          meta: {
            reason: why,
            wasLive,
            notified: booked.length,
            refunded,
            startsAt: session.startsAt.toISOString(),
          } as never,
        },
      })
      .catch(() => undefined);
    return { id, deleted: true, cancelledAt: now, notified: booked.length };
  }

  async listForTeacher(scope: LiveScope) {
    const sessions = await this.prisma.liveSession.findMany({
      where: this.scopeWhere(scope),
      orderBy: { startsAt: 'asc' },
      include: { _count: { select: { bookings: true } } },
    });
    // A guest's seat has no LiveBooking (it is the purchase itself): counted
    // here too, or a class sold only to guests reads "0 booked".
    const guestSeats = sessions.length
      ? await this.prisma.livePurchase.groupBy({
          by: ['sessionId'],
          where: {
            sessionId: { in: sessions.map((x) => x.id) },
            guestBuyerId: { not: null },
            status: { in: ['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'] },
          },
          _count: { _all: true },
        })
      : [];
    const guestsBy = new Map(guestSeats.map((g) => [g.sessionId, g._count._all]));
    return sessions.map((s) => ({
      ...s,
      bookedCount: s._count.bookings + (guestsBy.get(s.id) ?? 0),
    }));
  }

  async bookingsFor(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const [rows, guests] = await Promise.all([
      this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'asc' },
        include: { student: { select: { user: { select: { fullName: true, phone: true } } } } },
      }),
      this.prisma.livePurchase.findMany({
        where: {
          sessionId: id,
          guestBuyerId: { not: null },
          status: { in: ['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'] },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          confirmedAt: true,
          createdAt: true,
          guestBuyer: { select: { displayName: true } },
        },
      }),
    ]);
    return [
      ...rows.map((r) => ({
        id: r.id,
        fullName: r.student.user.fullName,
        phone: r.student.user.phone,
        bookedAt: r.createdAt,
        guest: false,
      })),
      // A guest gave a name only; there is no phone to show.
      ...guests.map((g) => ({
        id: g.id,
        fullName: g.guestBuyer?.displayName ?? '—',
        phone: null,
        bookedAt: g.confirmedAt ?? g.createdAt,
        guest: true,
      })),
    ];
  }

  // ── Student ────────────────────────────────────────────────────────────────

  /**
   * Upcoming sessions in the academies the student is actively enrolled with —
   * a group-scoped stream only for that group's members, an academy-wide one
   * for every enrolled student there.
   */
  async upcomingForStudent(userId: string) {
    const student = await this.studentOf(userId);
    const academyIds = await this.enrolledAcademyIds(student.id);
    // Paid seats stand alone: a session the student bought (or is buying)
    // is theirs to see whether or not they are enrolled with that academy.
    const purchased = (
      await this.prisma.livePurchase.findMany({
        where: { studentId: student.id },
        select: { sessionId: true },
      })
    ).map((p) => p.sessionId);
    const bookedAny = await this.prisma.liveBooking.count({ where: { studentId: student.id } });
    if (!academyIds.length && !purchased.length && !bookedAny) return [];
    const groupIds = (
      await this.prisma.groupMembership.findMany({
        where: { studentId: student.id },
        select: { groupId: true },
      })
    ).map((g) => g.groupId);

    const sessions = await this.prisma.liveSession.findMany({
      where: {
        startsAt: { gte: new Date(Date.now() - 2 * 3600_000) },
        OR: [
          {
            academyId: { in: academyIds },
            OR: [{ groupId: null }, { groupId: { in: groupIds } }],
          },
          { id: { in: purchased } },
          // Booked from a shared link, without being enrolled with the academy.
          { bookings: { some: { studentId: student.id } } },
        ],
      },
      orderBy: { startsAt: 'asc' },
      include: {
        teacher: { select: { slug: true, user: { select: { fullName: true } } } },
        _count: { select: { bookings: true } },
        bookings: { where: { studentId: student.id }, select: { id: true } },
        purchases: {
          where: { studentId: student.id },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, holdExpiresAt: true, studentPaysCents: true },
        },
      },
    });
    const now = new Date();
    return Promise.all(
      sessions.map(async (s) => ({
        ...this.studentView(s, s.bookings.length > 0),
        // Seats left the way capacity is enforced: booked seats, guests'
        // confirmed seats and unexpired holds.
        ...(s.capacity != null
          ? { seatsLeft: Math.max(0, s.capacity - (await seatsTaken(this.prisma, s.id, now))) }
          : {}),
        ...(await this.commerceView(s, s.purchases[0] ?? null)),
      })),
    );
  }

  /**
   * What a card needs to say about money: FREE, or the one price the student
   * pays (never the split), their purchase if any, and the rules they would
   * buy under. A seat that cannot be sold right now (a Center with no agreed
   * split) says so instead of showing a price.
   */
  private async commerceView(
    s: {
      accessMode: LiveAccessMode;
      priceCents: number | null;
      academyId: string | null;
      tenantId: string;
      currency: string;
      refundPolicy: LiveRefundPolicy;
      replayPolicy: LiveReplayPolicy;
      replayDays: number | null;
    },
    purchase: {
      id: string;
      status: string;
      holdExpiresAt: Date | null;
      studentPaysCents: number;
    } | null,
  ) {
    const base = {
      accessMode: s.accessMode,
      currency: s.currency,
      refundPolicy: s.refundPolicy,
      replayPolicy: s.replayPolicy,
      replayDays: s.replayDays,
      purchase,
    };
    if (s.accessMode !== 'PAID' || s.priceCents == null)
      return { ...base, studentPaysCents: 0, purchasable: false };
    // A buyer's own frozen price wins over today's: it is what they pay.
    if (purchase)
      return { ...base, studentPaysCents: purchase.studentPaysCents, purchasable: true };
    try {
      const p = await this.priceSession(s.academyId ?? s.tenantId, s.tenantId, s.priceCents);
      return { ...base, studentPaysCents: p.studentPaysCents, purchasable: true };
    } catch {
      return { ...base, studentPaysCents: null, purchasable: false };
    }
  }

  async book(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: { _count: { select: { bookings: true } } },
    });
    if (!session || session.deletedAt) throw new NotFoundException('Session not found');
    // A paid seat is bought, never booked: this path would otherwise hand out
    // the seat without the payment. The check is on the server's own row.
    if (session.accessMode === 'PAID') {
      throw new ForbiddenException({
        message: 'This session is paid — buy a seat instead',
        code: 'PAID_SESSION_NEEDS_PURCHASE',
      });
    }
    // A FREE academy-wide class is public — its link is shared to be used, by
    // anyone. A group's class stays its group's (enrollment and membership
    // checked as always).
    if (session.groupId) await this.assertEnrolledWith(student.id, session);
    if (session.cancelledAt || this.effectiveStatus(session) === 'ENDED') {
      throw new ConflictException({ message: 'This session has ended', code: 'SESSION_ENDED' });
    }

    const already = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
    });
    if (already) return { ok: true, alreadyBooked: true };

    // Capacity is enforced under the session's row lock — the same lock every
    // seat-changing path takes first — so two concurrent bookings cannot both
    // see the last seat, and seats held by paid purchases are counted too.
    try {
      await this.prisma.$transaction(async (tx) => {
        const s = await lockSession(tx, sessionId);
        if (!s || s.deletedAt) throw new NotFoundException('Session not found');
        if (s.accessMode === 'PAID') {
          throw new ForbiddenException({
            message: 'This session is paid — buy a seat instead',
            code: 'PAID_SESSION_NEEDS_PURCHASE',
          });
        }
        if (s.capacity != null && (await seatsTaken(tx, sessionId, new Date())) >= s.capacity) {
          throw new BadRequestException({ message: 'Session is full', code: 'SESSION_FULL' });
        }
        await tx.liveBooking.create({ data: { sessionId, studentId: student.id } });
      });
    } catch (e) {
      // A unique-violation means this student already booked in a race → done.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { ok: true, alreadyBooked: true };
      }
      throw e;
    }

    // Notify the teacher.
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: session.tenantId },
      select: { userId: true },
    });
    if (teacher) {
      await this.notifications.create({
        userId: teacher.userId,
        type: 'LIVE_SESSION_REMINDER',
        title: 'حجز جديد لجلسة مباشرة 📅',
        body: `${student.user.fullName} حجز مقعده في «${session.title}».`,
        meta: { sessionId },
      });
    }
    return { ok: true };
  }

  /**
   * A student gives their seat back.
   *
   * Only while the session is still ahead of them. Once the class has begun —
   * the teacher opened the room, or the scheduled time arrived — the booking is
   * no longer a reservation but the record the attendance, the recording's
   * audience and any later refund are read from, and deleting it would erase
   * that history. Before then it is released exactly as it always was, so the
   * seat goes back to the pool.
   */
  async cancel(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const booking = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
      include: { session: { select: { startsAt: true, status: true, deletedAt: true } } },
    });
    if (!booking) return { ok: true };
    // The teacher already called it off: the booking stays as the record of
    // that, and there is nothing left for the student to cancel.
    if (booking.session.deletedAt) return { ok: true };
    // A paid seat is given back through its purchase, which decides the
    // refund — deleting the booking here would take the seat and keep the money.
    if (booking.purchaseId) {
      throw new ConflictException({
        message: 'A paid seat is cancelled from its purchase',
        code: 'PAID_CANCEL_VIA_PURCHASE',
        purchaseId: booking.purchaseId,
      });
    }
    if (
      booking.session.status !== 'SCHEDULED' ||
      Date.now() >= booking.session.startsAt.getTime()
    ) {
      throw new ConflictException({
        message: 'لا يمكن إلغاء الحجز بعد بدء الحصة',
        code: 'CANCEL_WINDOW_CLOSED',
      });
    }
    await this.prisma.liveBooking.deleteMany({ where: { id: booking.id } });
    return { ok: true };
  }

  /**
   * A booked student enters the classroom.
   *
   * Three things have to be true and the server checks all of them: they booked
   * it, the window is open, and the teacher has actually started — because
   * before that there is no room to enter, and a "join" button that leads
   * nowhere is worse than one that says what it is waiting for.
   */
  /**
   * A guest's confirmed seat on this session, if they are a guest and have
   * one. `forJoin` narrows it to CONFIRMED: entering a class needs a seat for
   * that class, where reading its chat or replay afterwards may also follow a
   * delivered (or reviewed) purchase.
   */
  async guestSeat(userId: string, sessionId: string, forJoin = false) {
    const guest = await this.prisma.guestBuyer.findUnique({
      where: { userId },
      select: { id: true, displayName: true },
    });
    if (!guest) return null;
    const purchase = await this.prisma.livePurchase.findFirst({
      where: {
        sessionId,
        guestBuyerId: guest.id,
        status: { in: forJoin ? ['CONFIRMED'] : ['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'] },
      },
      select: { id: true, replayPolicy: true, replayDays: true, status: true },
    });
    return purchase ? { guest, purchase } : null;
  }

  async join(userId: string, sessionId: string) {
    // A guest enters on their confirmed seat; a student on their booking.
    const guest = await this.guestSeat(userId, sessionId, true);
    let s: Prisma.LiveSessionGetPayload<object>;
    let displayName: string;
    if (guest) {
      const found = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
      if (!found || found.deletedAt)
        throw new ForbiddenException('You have not booked this session');
      s = found;
      displayName = guest.guest.displayName;
    } else {
      const student = await this.studentOf(userId);
      const booking = await this.prisma.liveBooking.findUnique({
        where: { sessionId_studentId: { sessionId, studentId: student.id } },
        include: { session: true },
      });
      if (!booking || booking.session.deletedAt)
        throw new ForbiddenException('You have not booked this session');
      s = booking.session;
      displayName = student.user.fullName;
    }
    this.assertWindowOpen(s, true);

    // No reward here. Being handed a token means being *allowed* in, not having
    // attended — LIVE_ATTENDED is paid from real heartbeat time (see
    // `heartbeat`), once the student has actually sat through enough of it.

    // A session the teacher pointed at Zoom keeps going to Zoom: this feature
    // did not take the old way away from anyone already using it.
    if (!s.roomName) {
      if (s.joinUrl)
        return {
          session: this.meetingSession(s),
          externalUrl: s.joinUrl,
          meeting: null,
          participant: { role: 'STUDENT' as const },
        };
      throw new BadRequestException({
        message: 'المدرّس لم يبدأ الفصل بعد',
        code: 'NOT_STARTED',
        session: this.meetingSession(s),
      });
    }

    const meeting = await this.providers.forSession(s).participantAccess({
      session: { id: s.id, roomName: s.roomName, roomUrl: s.roomUrl },
      userName: displayName,
      userId,
      // The student is never an owner: that is what would let them mute and
      // remove the class, and it is decided here rather than asked for.
      role: 'STUDENT',
      endsAtMs: this.closesAt(s),
    });
    await this.markPresent(sessionId, userId, 'STUDENT');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting,
      participant: { role: 'STUDENT' as const },
    };
  }

  // ── The meeting itself ─────────────────────────────────────────────────────

  /**
   * The teacher opens the classroom.
   *
   * Creating the room here rather than at scheduling time means a class that
   * never runs never books a room, and the room's own expiry can be set from a
   * start time that is now known rather than guessed at weeks out.
   *
   * One LIVE session per *teacher* at a time — counted on `tenantId`, the
   * teacher's own profile, not on the academy: two teachers in one Center can
   * each run a class at once, and one teacher cannot be live in two academies
   * at once. (This comment used to say "per academy"; the code has always
   * counted per teacher, and that is the rule.) Note this is deliberately *not*
   * `maxConcurrentSessions`, which despite the name governs how many devices a
   * student may be signed in from — borrowing it here would tie a teacher's
   * classroom to an anti-account-sharing setting that has nothing to do with it.
   */
  async start(scope: LiveScope, id: string, actorUserId: string) {
    const session = await this.assertOwned(scope, id);
    // Only the clock closes a session for good. Pressing "end for all" two
    // minutes into an hour-long class — by accident, or to clear a room that
    // went wrong — must not cost the teacher the other fifty-eight and force
    // every student to rebook. Inside its own window a class can be reopened,
    // which creates a fresh room because the old one was deleted on the way out.
    if (this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    if (Date.now() < session.startsAt.getTime() - JOIN_OPENS_MIN * 60_000) {
      throw new BadRequestException({
        message: `يمكن بدء الفصل قبل الموعد بـ${JOIN_OPENS_MIN} دقيقة`,
        code: 'TOO_EARLY',
      });
    }

    // Already running: starting twice is the same room, not a second one. This
    // is the refresh case and the two-tabs case, and both should just work. A
    // session that was ended has no room any more, so it falls through and
    // gets a new one.
    if (session.status === 'LIVE' && session.roomName) {
      return this.teacherEntry(session, actorUserId);
    }

    // Claim the "one live session" slot and the LIVE status in one statement,
    // so two taps a millisecond apart cannot both win it.
    const claimed = await this.prisma.liveSession.updateMany({
      where: { id, academyId: scope.academyId, status: { not: 'LIVE' }, deletedAt: null },
      // `endedAt` is cleared on the way back in, so a reopened class does not
      // carry a finish time from the run before it.
      data: { status: 'LIVE', startedAt: new Date(), endedAt: null },
    });
    if (claimed.count === 0) {
      const fresh = await this.assertOwned(scope, id);
      return this.teacherEntry(fresh, actorUserId);
    }
    const otherLive = await this.prisma.liveSession.count({
      where: { tenantId: session.tenantId, status: 'LIVE', id: { not: id }, deletedAt: null },
    });
    if (otherLive > 0) {
      // Hand the slot back rather than leaving two sessions claiming to be live.
      await this.prisma.liveSession.update({
        where: { id },
        data: { status: 'SCHEDULED', startedAt: null },
      });
      throw new BadRequestException({
        message: 'لديك فصل مباشر شغّال بالفعل. أنهِه أولاً.',
        code: 'ALREADY_LIVE',
      });
    }

    let room;
    try {
      // The session's own provider — fixed when it was created, never the
      // one configured today (see LiveProviders).
      room = await this.providers
        .forSession(session)
        .openRoom({ sessionId: id, startsAtMs: session.startsAt.getTime() });
    } catch (e) {
      // The provider is the one thing here that can fail for reasons of its
      // own. Put the session back where it was so the button can be pressed
      // again, rather than leaving it LIVE with no room behind it.
      await this.prisma.liveSession.update({
        where: { id },
        data: { status: 'SCHEDULED', startedAt: null },
      });
      throw e;
    }
    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: { roomName: room.name, roomUrl: room.url },
    });
    await this.announceStart(updated);
    return this.teacherEntry(updated, actorUserId);
  }

  /** The teacher walks back into a class they already started. */
  async teacherJoin(scope: LiveScope, id: string, actorUserId: string) {
    const session = await this.assertOwned(scope, id);
    if (session.status !== 'LIVE' || !session.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    if (this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    return this.teacherEntry(session, actorUserId);
  }

  /** The teacher closes the classroom. Everyone still inside is checked out. */
  async end(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const r = await this.endSession(id, 'MANUAL');
    return { id, status: 'ENDED' as const, endedAt: r.endedAt };
  }

  /**
   * The one way a class ends — the teacher's button, the end sweep at the
   * class's effective end, and a cancellation all come here.
   *
   * Under the session's row lock (so a manual end, the sweep on any replica,
   * a cancellation and an extension cannot interleave):
   *  1. already ENDED → nothing to do (idempotent; never ended twice);
   *  2. for SCHEDULED_END, the class must still be LIVE and its *current* end
   *     reached. This is what makes a stale trigger harmless: the end moved by
   *     an extension is read here, not remembered from earlier — 20:00 does
   *     not end a class that now runs to 20:15;
   *  3. the Daily room is deleted — which removes everyone in it within a
   *     couple of seconds (observed) — *before* anything is written. If the
   *     provider refuses, the transaction rolls back and the class stays LIVE,
   *     so the sweep (or the teacher) simply tries again; a room already gone
   *     counts as closed. Never "ENDED" with a meeting still running;
   *  4. status ENDED, and open attendance closed, at `endedAt` = the class's
   *     actual end (now, or its scheduled end if that already passed).
   * Then the room and the class are told — unless this is the quiet close of
   * an old class nobody ended.
   */
  async endSession(
    id: string,
    reason: LiveEndReason,
  ): Promise<{ outcome: 'ended' | 'already-ended' | 'not-due' | 'missing'; endedAt: Date | null }> {
    const r = await this.prisma.$transaction(
      async (tx) => {
        const [s] = await tx.$queryRaw<
          {
            id: string;
            tenantId: string;
            academyId: string | null;
            startsAt: Date;
            durationMin: number;
            status: LiveSessionStatus;
            roomName: string | null;
            provider: LiveProviderKind;
            deletedAt: Date | null;
            endedAt: Date | null;
          }[]
        >`SELECT id, "tenantId", "academyId", "startsAt", "durationMin", status::text AS status,
                 "roomName", provider::text AS provider, "deletedAt", "endedAt"
          FROM "LiveSession" WHERE id = ${id} FOR UPDATE`;
        if (!s) return { outcome: 'missing' as const, endedAt: null };
        if (s.status === 'ENDED') return { outcome: 'already-ended' as const, endedAt: s.endedAt };
        const scheduledEnd = this.closesAt(s);
        const now = Date.now();
        if (reason === 'SCHEDULED_END' && (s.status !== 'LIVE' || now < scheduledEnd)) {
          return { outcome: 'not-due' as const, endedAt: null };
        }
        let provider: RoomCloseResult | 'none' = 'none';
        if (s.status === 'LIVE' && s.roomName) {
          provider = await this.providers
            .forSession(s)
            .closeRoom({ sessionId: id, roomName: s.roomName });
        }
        const endedAt = new Date(Math.min(now, scheduledEnd));
        await tx.liveSession.update({ where: { id }, data: { status: 'ENDED', endedAt } });
        await tx.liveAttendance.updateMany({
          where: { sessionId: id, leftAt: null },
          data: { leftAt: endedAt },
        });
        return { outcome: 'ended' as const, endedAt, session: s, provider };
      },
      // Long enough for the provider call (10s) inside it.
      { timeout: 20_000, maxWait: 10_000 },
    );
    if (r.outcome !== 'ended' || !('session' in r)) {
      return { outcome: r.outcome, endedAt: r.endedAt };
    }
    if (r.provider === 'cleanup-pending' && r.session.roomName) {
      // Closed on our side already — nobody can join, push or pull. The
      // provider's own teardown runs now, outside the lock, and the end sweep
      // retries whatever this one does not finish.
      void this.cleanupRoom(r.session, r.session.roomName);
    }
    this.logger.log(
      `live.end liveSession=${id} academy=${r.session.academyId ?? r.session.tenantId} ` +
        `reason=${reason} endedAt=${r.endedAt.toISOString()} provider=${r.provider}`,
    );
    if (r.session.provider === 'CLOUDFLARE' && r.session.roomName && reason !== 'CANCELLED') {
      await this.queueTranscript(r.session, r.session.roomName).catch((e) =>
        this.logger.warn(
          `live.transcribe.enqueue liveSession=${id} failed: ${(e as Error).message}`,
        ),
      );
    }

    const recent = Date.now() - r.endedAt.getTime() <= END_ANNOUNCE_WINDOW_MS;
    // A cancellation announces itself (with `cancelled`) from `remove`.
    if (reason !== 'CANCELLED' && recent) {
      // Tell the room, and tell the class.
      //
      // Deleting the Daily room drops everyone's connection, but that is the
      // video going quiet — it is not an answer to "what happened?". Without
      // this, a student sat looking at a dead meeting, and the listing behind
      // it went on saying "live now" until they reloaded.
      this.realtime.emitToLive(id, 'live:ended', { sessionId: id });
      const booked = await this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        select: { student: { select: { userId: true } } },
      });
      for (const b of booked) {
        // Their personal room, which they are in whether or not they were ever
        // inside the meeting — that is what the upcoming list listens on.
        this.realtime.emitToUser(b.student.userId, 'live:ended', { sessionId: id });
      }
    }
    return { outcome: 'ended', endedAt: r.endedAt };
  }

  /**
   * A Darsly-hosted class just ended: turn the audio its teacher's page
   * captured into the lesson's transcript (LIVE_TRANSCRIBE). Only when
   * transcription is switched on — every run is a paid call. Queued even if no
   * piece has arrived yet: the last one is flushed as the class ends, and the
   * job waits for it; a class with no audio at all costs nothing.
   */
  private async queueTranscript(
    s: { id: string; tenantId: string; academyId: string | null },
    roomName: string,
  ) {
    const capture = await transcriptCaptureState(this.prisma, s.id, roomName);
    // OFF, or never switched on in this class: nothing to transcribe, nothing queued.
    if (!capture.available || !(capture.active || capture.everOn)) return;
    const claimed = await this.prisma.liveSession.updateMany({
      where: { id: s.id, transcriptStatus: { in: ['NOT_STARTED', 'FAILED'] } },
      data: { transcriptStatus: 'PROCESSING' },
    });
    if (claimed.count === 0) return;
    try {
      await this.jobs.enqueue(
        s.academyId ?? s.tenantId,
        'LIVE_TRANSCRIBE',
        { liveSessionId: s.id, roomName },
        { sameInput: { path: 'liveSessionId', equals: s.id } },
      );
      this.logger.log(`live.transcript.requested liveSession=${s.id} mode=${capture.mode}`);
    } catch (e) {
      // Words were captured but cannot be turned into text (the AI queue is
      // off, or the month's budget is spent): that is a failed transcript,
      // not "nothing was said". The audio waits for the retention sweep.
      await this.prisma.liveSession.updateMany({
        where: { id: s.id, transcriptStatus: 'PROCESSING' },
        data: { transcriptStatus: 'FAILED' },
      });
      this.logger.warn(`live.transcript.failed liveSession=${s.id} reason=ENQUEUE_REFUSED`);
      throw e;
    }
  }

  /**
   * Stores one piece of a class's audio, uploaded by its teacher's page while
   * its words are being captured.
   *
   * Refused unless: transcription is available for this class; the caller is
   * its teacher (or staff who may manage it); it is a live Darsly-hosted
   * class (or ended a moment ago — the last piece is flushed on the way out);
   * capture is on, or went off a moment ago; the number is a plausible second
   * of this class; the file really is WebM or MP4 audio of a sane size; and
   * the class is not sending pieces faster than any classroom would.
   *
   * Idempotent by (class, run, second): a retried upload of a piece already
   * stored is a no-op — and a piece that has already been transcribed is
   * never replaced, so a retry can never make the job pay for it twice.
   */
  async storeAudioPiece(
    scope: LiveScope,
    id: string,
    seq: number,
    file: { buffer: Buffer; size: number; mimetype?: string } | undefined,
    durationMs?: number,
  ) {
    if (!transcriptionConfig().enabled) {
      throw new ConflictException({ message: 'Transcription is off', code: 'TRANSCRIPTION_OFF' });
    }
    const session = await this.assertOwned(scope, id);
    if (session.provider !== 'CLOUDFLARE' || !session.roomName) {
      throw new ConflictException({ message: 'Not a Darsly-hosted class', code: 'NOT_CLOUDFLARE' });
    }
    // Just after the end is fine: that is the last piece, flushed on the way out.
    const now = Date.now();
    const justEnded =
      session.status === 'ENDED' &&
      !!session.endedAt &&
      now - session.endedAt.getTime() <= LAST_PIECE_GRACE_MS;
    if (session.status !== 'LIVE' && !justEnded) {
      throw new ConflictException({ message: 'The class is not running', code: 'NOT_LIVE' });
    }
    const capture = await transcriptCaptureState(this.prisma, id, session.roomName);
    const recentlyOff =
      !!capture.lastOffAt && now - capture.lastOffAt.getTime() <= CAPTURE_OFF_GRACE_MS;
    if (!capture.available || !(capture.active || recentlyOff || (justEnded && capture.everOn))) {
      throw new ConflictException({ message: 'Transcript capture is off', code: 'CAPTURE_OFF' });
    }
    if (!validPieceSeq(seq, now)) {
      throw new BadRequestException({ message: 'Bad piece number', code: 'BAD_SEQ' });
    }
    if (!file?.buffer?.length || file.size < AUDIO_SEGMENT_MIN_BYTES) {
      throw new BadRequestException({ message: 'Empty audio', code: 'EMPTY_AUDIO' });
    }
    const kind = sniffAudio(file.buffer);
    if (!kind || !acceptableAudioMime(file.mimetype)) {
      throw new HttpException(
        { message: 'Not an audio piece', code: 'BAD_AUDIO' },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    const roomName = session.roomName;
    const existing = await this.prisma.liveAudioSegment.findUnique({
      where: { sessionId_roomName_seq: { sessionId: id, roomName, seq } },
    });
    if (existing && (existing.text !== null || existing.sizeBytes === file.size)) {
      // The same piece again (a retry whose first answer was lost).
      return { ok: true as const, seq, duplicate: true };
    }
    if (!existing) {
      const recent = await this.prisma.liveAudioSegment.count({
        where: { sessionId: id, createdAt: { gte: new Date(now - 60_000) } },
      });
      if (recent >= AUDIO_PIECES_PER_MINUTE) {
        throw new HttpException(
          { message: 'Too many audio pieces', code: 'AUDIO_RATE' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    // The file's own header decides the extension (the transcriber reads it).
    const key = audioKey(id, roomName, seq, kind);
    if (!this.storage) throw new Error('Storage is not configured');
    await this.storage.put(key, file.buffer, {
      contentType: kind === 'm4a' ? 'audio/mp4' : 'audio/webm',
    });
    const ms =
      Number.isFinite(durationMs) && durationMs! > 0 && durationMs! < 30 * 60_000
        ? Math.round(durationMs!)
        : null;
    await this.prisma.liveAudioSegment.upsert({
      where: { sessionId_roomName_seq: { sessionId: id, roomName, seq } },
      create: { sessionId: id, roomName, seq, key, sizeBytes: file.size, durationMs: ms },
      // Only an untranscribed piece is ever replaced (see above) — and a new
      // copy of a piece that failed is a fresh chance for it.
      update: {
        key,
        sizeBytes: file.size,
        durationMs: ms,
        error: null,
        attempts: 0,
        skipReason: null,
      },
    });
    this.logger.log(
      `live.transcript.segment-uploaded liveSession=${id} seq=${seq} bytes=${file.size} kind=${kind}${existing ? ' replaced' : ''}`,
    );
    // The last flush of an ended class may land after its transcript job has
    // already begun: make sure a job will see it (never silently dropped).
    if (session.status === 'ENDED')
      await this.reopenTranscript(session, roomName, 'late-piece').catch(() => undefined);
    return { ok: true as const, seq };
  }

  /**
   * The teacher's transcription choices for one class: the mode (before the
   * class ends), and — in MANUAL mode, while it runs — capture on or off.
   */
  async setTranscription(
    scope: LiveScope,
    id: string,
    dto: { mode?: LiveTranscriptionMode; capture?: boolean },
  ) {
    const s = await this.assertOwned(scope, id);
    if (s.status === 'ENDED') {
      throw new ConflictException({ message: 'The class has ended', code: 'ENDED' });
    }
    const data: Prisma.LiveSessionUpdateInput = {};
    if (dto.mode) data.transcriptionMode = dto.mode;
    const mode = dto.mode ?? s.transcriptionMode;
    if (dto.capture !== undefined) {
      if (!transcriptionConfig().enabled) {
        throw new ConflictException({ message: 'Transcription is off', code: 'TRANSCRIPTION_OFF' });
      }
      if (mode !== 'MANUAL' || s.status !== 'LIVE') {
        throw new ConflictException({
          message: 'Capture is switched by hand only in a running MANUAL class',
          code: 'NOT_MANUAL',
        });
      }
      if (dto.capture) data.transcriptCaptureOnAt = new Date();
      else data.transcriptCaptureOffAt = new Date();
    }
    await this.prisma.liveSession.update({ where: { id }, data });
    const capture = await transcriptCaptureState(this.prisma, id, s.roomName);
    this.logger.log(
      `live.transcript.mode liveSession=${id} mode=${capture.mode} capturing=${capture.active}`,
    );
    // The classroom reads it from its state; tell it to look.
    this.realtime.emitToLive(id, 'live:rtc-state', { sessionId: id });
    return { mode: capture.mode, available: capture.available, capturing: capture.active };
  }

  /**
   * Who may see the recording, the transcript and the summary — three
   * separate choices. `summaryForStudents` (the old single switch) is kept in
   * step with the summary's.
   */
  async setVisibility(
    scope: LiveScope,
    id: string,
    dto: { recording?: LiveVisibility; transcript?: LiveVisibility; summary?: LiveVisibility },
  ) {
    const before = await this.assertOwned(scope, id);
    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: {
        ...(dto.recording ? { recordingVisibility: dto.recording } : {}),
        ...(dto.transcript ? { transcriptVisibility: dto.transcript } : {}),
        ...(dto.summary
          ? { summaryVisibility: dto.summary, summaryForStudents: dto.summary === 'STUDENTS' }
          : {}),
      },
      select: {
        id: true,
        title: true,
        recordingVisibility: true,
        transcriptVisibility: true,
        summaryVisibility: true,
        summaryStatus: true,
      },
    });
    const newlyShared =
      dto.summary === 'STUDENTS' &&
      before.summaryVisibility !== 'STUDENTS' &&
      updated.summaryStatus === 'READY';
    if (newlyShared) {
      const booked = await this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        select: { student: { select: { userId: true } } },
      });
      await Promise.all(
        booked.map((b) =>
          this.notifications.create({
            userId: b.student.userId,
            type: 'LIVE_SESSION_REMINDER',
            title: 'ملخّص الحصة جاهز 📝',
            body: `ملخّص «${updated.title}» بقى متاح ليك.`,
            meta: { sessionId: id, summary: true },
          }),
        ),
      );
    }
    this.logger.log(
      `live.visibility liveSession=${id} recording=${updated.recordingVisibility} transcript=${updated.transcriptVisibility} summary=${updated.summaryVisibility}`,
    );
    return {
      id,
      recording: updated.recordingVisibility,
      transcript: updated.transcriptVisibility,
      summary: updated.summaryVisibility,
    };
  }

  /**
   * LIVE classes whose effective end has passed — what the end sweep closes.
   *
   * Bounded and indexed: `("status", "startsAt")` narrows it to LIVE sessions
   * that have started, which is the handful running now plus any backlog; the
   * end itself is then compared per row. Oldest first, a batch at a time.
   */
  async overdueLiveSessionIds(limit: number): Promise<string[]> {
    const at = Prisma.sql`(to_timestamp(${Date.now()}::double precision / 1000) AT TIME ZONE 'UTC')`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "LiveSession"
      WHERE status = 'LIVE' AND "deletedAt" IS NULL
        AND "startsAt" <= ${at}
        AND "startsAt" + make_interval(mins => "durationMin") <= ${at}
      ORDER BY "startsAt"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * The provider's own teardown after a class closed with `cleanup-pending`.
   *
   * Outside the row lock and never able to reopen anything: the class is
   * already ENDED, and every way in checks that first. Failures are logged and
   * left for the end sweep, which asks each provider what is still pending.
   */
  async cleanupRoom(
    s: { id: string; provider?: LiveProviderKind | string | null },
    roomName: string,
  ): Promise<boolean> {
    const provider = this.providers.forSession(s);
    if (!provider.cleanup) return true;
    try {
      return await provider.cleanup({ sessionId: s.id, roomName });
    } catch (e) {
      this.logger.warn(`live.cleanup liveSession=${s.id} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** One pass of every provider's owed teardown (see LiveEndWorker). */
  async sweepProviderCleanups(limit: number): Promise<{ closed: number; pending: number }> {
    let closed = 0;
    let pending = 0;
    for (const p of this.providers.all()) {
      if (!p.sweepPending) continue;
      const r = await p.sweepPending(limit);
      closed += r.closed;
      pending += r.pending;
    }
    return { closed, pending };
  }

  /**
   * Make a running class longer.
   *
   * Darsly's end is the authority, and the class is ended by closing its room
   * at that end (`endSession`). The provider's room expiry is a safety TTL set
   * when the room was created, already past the longest end any class can
   * reach (LIVE_MAX_DURATION_MIN, enforced below) — so an extension is a
   * database change, and nothing at Daily has to move. (Moving it would not
   * help anyway: Daily fixes each participant's ejection time when they join,
   * and a later change to the room's `exp` does not reach them — observed.)
   *
   * Under the row lock, so two extensions, an extension and the end sweep, or
   * an extension and a manual end run one after another:
   *  - the class must be LIVE and its current end not yet reached — once it is
   *    over (by the clock, or ENDED) it is not brought back;
   *  - `expectedEndsAt` (what the page sends — the end it was showing): if the
   *    end already moved, TIMING_CHANGED with the current timing rather than
   *    a second extension the teacher did not ask for twice. Without it, each
   *    confirmed request adds its minutes: never a lost update;
   *  - never past LIVE_MAX_DURATION_MIN, nor into the teacher's next session.
   * Only after the commit is anyone told.
   */
  async extend(
    scope: LiveScope,
    id: string,
    minutes: number,
    opts: { expectedEndsAt?: string; actorUserId?: string } = {},
  ): Promise<LiveTiming> {
    // Scope first: a colleague's or another academy's class is a 404, before
    // any lock is taken.
    await this.assertOwned(scope, id);
    const before = { endsAt: 0 };
    const updated = await this.prisma.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<
        {
          id: string;
          tenantId: string;
          academyId: string | null;
          teacherUserId: string | null;
          startsAt: Date;
          durationMin: number;
          startedAt: Date | null;
          status: LiveSessionStatus;
          roomName: string | null;
          deletedAt: Date | null;
        }[]
      >`SELECT id, "tenantId", "academyId", "teacherUserId", "startsAt", "durationMin",
                 "startedAt", status::text AS status, "roomName", "deletedAt"
          FROM "LiveSession" WHERE id = ${id} FOR UPDATE`;
      if (!s || s.deletedAt) throw new NotFoundException('Session not found');
      if (s.status !== 'LIVE' || !s.roomName) {
        throw new BadRequestException({
          message: 'Only a class that is running can be extended',
          code: 'SESSION_NOT_LIVE',
        });
      }
      const oldEnd = this.closesAt(s);
      before.endsAt = oldEnd;
      // Over is over: at its end the class is closed, and an extension that
      // arrives after that moment does not reopen it.
      if (Date.now() >= oldEnd) {
        throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
      }
      if (opts.expectedEndsAt && new Date(opts.expectedEndsAt).getTime() !== oldEnd) {
        throw new ConflictException({
          message: 'The class was already extended',
          code: 'TIMING_CHANGED',
          timing: this.timingOf(s),
        });
      }
      const durationMin = s.durationMin + minutes;
      if (durationMin > LIVE_MAX_DURATION_MIN) {
        throw new BadRequestException({
          message: `A class cannot run longer than ${LIVE_MAX_DURATION_MIN} minutes`,
          code: 'EXTENSION_TOO_LONG',
          params: { max: LIVE_MAX_DURATION_MIN },
        });
      }
      // Still cannot be in two places at once.
      if (s.teacherUserId) {
        await this.assertTeacherFree(scope, s.teacherUserId, s.startsAt, durationMin, id);
      }
      await tx.liveSession.update({ where: { id }, data: { durationMin } });
      return { ...s, durationMin };
    });

    const timing = this.timingOf(updated);
    this.logger.log(
      `live.extend liveSession=${id} academy=${updated.academyId ?? updated.tenantId} ` +
        `teacher=${updated.teacherUserId} +${minutes}m ` +
        `oldEndsAt=${new Date(before.endsAt).toISOString()} newEndsAt=${timing.endsAt.toISOString()}`,
    );
    // Only now — once it is committed — is anyone told. The payload is absolute, so a client that reconnects later and
    // reads it from anywhere else gets the same answer.
    this.realtime.emitToLive(id, 'live:timing-updated', timing);
    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: opts.actorUserId ?? scope.userId,
          action: 'live.extend',
          entity: 'LiveSession',
          entityId: id,
          academyId: updated.academyId ?? updated.tenantId,
          meta: {
            minutes,
            oldEndsAt: new Date(before.endsAt).toISOString(),
            newEndsAt: timing.endsAt.toISOString(),
          } as never,
        },
      })
      .catch(() => undefined);
    return timing;
  }

  /**
   * "I am still here."
   *
   * Duration is built from these rather than from `leftAt - joinedAt`, because
   * the browser cannot be relied on to announce its own departure — a closed
   * laptop, a dead battery and a tunnel all look the same from here. A gap
   * longer than the grace period is counted as absence, so the number means
   * time in the room rather than time since arriving.
   */
  async heartbeat(userId: string, sessionId: string) {
    const now = Date.now();
    // One statement, so it holds under every way heartbeats can collide.
    //
    // The old read-then-write let two requests — two tabs in step, a retried
    // request, two replicas — read the same `lastSeenAt` and both add the same
    // gap: sixty seconds of attendance for thirty real ones. Here Postgres
    // takes the row lock and, for a second UPDATE that waited on it,
    // re-evaluates the expressions against the row the first one wrote — so
    // the second sees a gap of ~0 and adds nothing. Works across replicas;
    // needs no lock of ours.
    //
    // The gap rule is unchanged: whole seconds since the last heartbeat, and a
    // gap longer than PRESENCE_GRACE_SEC is absence, credited as 0. New: the
    // credit stops at the session's effective end (its scheduled end as
    // extended, or when the teacher ended it) — a heartbeat after the class is
    // over counts nothing, never reopens the attendance row, and closes one left
    // open by a class that simply ran out of time (at the class's end). The clock
    // is the server's, passed in as epoch-ms so a non-UTC database session
    // cannot shift it; nothing the client sends is trusted.
    // The server's clock, as a UTC timestamp, bound as a parameter.
    const at = Prisma.sql`(to_timestamp(${now}::double precision / 1000) AT TIME ZONE 'UTC')`;
    // The session's effective end: its scheduled end as extended, or the
    // moment the teacher ended it if that came first.
    const effectiveEnd = Prisma.sql`(CASE
        WHEN s.status = 'ENDED' AND s."endedAt" IS NOT NULL
          THEN LEAST(s."endedAt", s."startsAt" + make_interval(mins => s."durationMin"))
        ELSE s."startsAt" + make_interval(mins => s."durationMin")
      END)`;
    const rows = await this.prisma.$queryRaw<
      {
        role: string;
        durationSeconds: number;
        tenantId: string;
        title: string;
        startsAt: Date;
        durationMin: number;
        startedAt: Date | null;
        status: LiveSessionStatus;
      }[]
    >`
      UPDATE "LiveAttendance" a
      SET "durationSeconds" = a."durationSeconds" + (CASE
            WHEN floor(extract(epoch FROM (${at} - a."lastSeenAt"))) BETWEEN 1 AND ${PRESENCE_GRACE_SEC}
            THEN GREATEST(0, floor(extract(epoch FROM (LEAST(${at}, ${effectiveEnd}) - a."lastSeenAt"))))::int
            ELSE 0
          END),
          "lastSeenAt" = GREATEST(a."lastSeenAt", ${at}),
          -- Away longer than the grace, while the class still ran: a drop-out.
          "reconnects" = a."reconnects" + (CASE
            WHEN floor(extract(epoch FROM (${at} - a."lastSeenAt"))) > ${PRESENCE_GRACE_SEC}
             AND a."lastSeenAt" < ${effectiveEnd}
            THEN 1 ELSE 0 END),
          "leftAt" = CASE
            WHEN s.status = 'LIVE' AND s."deletedAt" IS NULL AND ${at} < ${effectiveEnd}
            THEN NULL
            -- Over: a row still open is closed at the class's end, never later.
            ELSE COALESCE(a."leftAt", LEAST(${at}, ${effectiveEnd})) END
      FROM "LiveSession" s
      WHERE a."sessionId" = ${sessionId} AND a."userId" = ${userId} AND s.id = a."sessionId"
      RETURNING a.role::text AS role, a."durationSeconds", s."tenantId", s.title,
        s."startsAt", s."durationMin", s."startedAt", s.status::text AS status
    `;
    const row = rows[0];
    if (!row) return { ok: false };
    if (row.role === 'STUDENT') {
      await this.maybeAwardAttendance(userId, sessionId, row);
    }
    return { ok: true, timing: this.timingOf({ id: sessionId, ...row }) };
  }

  /**
   * Pay LIVE_ATTENDED once the accumulated attendance crosses the threshold.
   *
   * Exactly once, by the gamification ledger's own unique key
   * (`LIVE_ATTENDED:{studentId}:{sessionId}`): two heartbeats crossing the
   * line together both try, the second collides and pays nothing. Attendance
   * is never rolled back for this — it was already committed above — and a
   * failed award is simply tried again by the next heartbeat, because only an
   * award that actually exists stops the retries.
   *
   * Cheap on the hot path: nothing at all below the threshold; above it, one
   * indexed lookup of the award by its key per heartbeat.
   */
  private async maybeAwardAttendance(
    userId: string,
    sessionId: string,
    row: { durationSeconds: number; durationMin: number; tenantId: string; title: string },
  ) {
    const threshold = liveAttendedThresholdSec(row.durationMin);
    if (row.durationSeconds < threshold) return;
    try {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!student) return;
      const key = `LIVE_ATTENDED:${student.id}:${sessionId}`;
      const paid = await this.prisma.gamificationEvent.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      });
      if (paid) return;
      const outcome = await this.gamification.recordOrThrow({
        studentId: student.id,
        type: 'LIVE_ATTENDED',
        key,
        tenantId: row.tenantId,
        entityType: 'liveSession',
        entityId: sessionId,
        meta: { title: row.title, attendedSeconds: row.durationSeconds },
      });
      this.logger.log(
        `LIVE_ATTENDED liveSession=${sessionId} student=${student.id} ` +
          `seconds=${row.durationSeconds} threshold=${threshold} awarded=${outcome.awarded}`,
      );
    } catch (e) {
      this.logger.warn(
        `LIVE_ATTENDED award failed liveSession=${sessionId} user=${userId} ` +
          `seconds=${row.durationSeconds} — the next heartbeat will retry: ${(e as Error).message}`,
      );
    }
  }

  /** An explicit goodbye. Best-effort — `heartbeat` is what the count rests on. */
  async leave(userId: string, sessionId: string) {
    const now = new Date();
    await this.prisma.liveAttendance.updateMany({
      where: { sessionId, userId, leftAt: null },
      data: { leftAt: now, lastSeenAt: now },
    });
    return { ok: true };
  }

  // ── The classroom's chat ───────────────────────────────────────────────────

  /**
   * Everyone in the room can read it, and only they can.
   *
   * "In the room" is the same question the join gate answers — booked student
   * or the academy's own staff — so it is asked the same way rather than
   * invented again here.
   */
  async assertInSession(userId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        tenantId: true,
        academyId: true,
        deletedAt: true,
        teacher: { select: { userId: true } },
      },
    });
    if (!session || session.deletedAt) throw new NotFoundException('Session not found');
    if (session.teacher.userId === userId) return { session, role: 'TEACHER' as const };
    // Staff means a staff *role* — an ACTIVE membership with role STUDENT is a
    // learner, and must not be waved in as the teacher side of the room.
    const staff = await this.prisma.academyMembership.findFirst({
      where: {
        academyId: session.academyId ?? session.tenantId,
        userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
      },
      select: { id: true },
    });
    if (staff) return { session, role: 'TEACHER' as const };
    // A guest's only way in is a confirmed seat of their own on THIS session
    // (the token they hold is bound to it as well). Refunded, cancelled or
    // pending: not in the room.
    if (await this.guestSeat(userId, sessionId)) return { session, role: 'STUDENT' as const };
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    const booked =
      student &&
      (await this.prisma.liveBooking.findUnique({
        where: { sessionId_studentId: { sessionId, studentId: student.id } },
        select: { id: true },
      }));
    if (!booked) throw new ForbiddenException('You are not in this session');
    return { session, role: 'STUDENT' as const };
  }

  /**
   * A page of the class chat, oldest first within the page: the newest
   * `limit` messages, or the `limit` just before message `before` (a cursor
   * the page got from its own oldest message). The classroom asks for the
   * latest; the archive walks back through older pages as the reader scrolls.
   * (This used to return the FIRST 200 of the class — a long chat's archive
   * silently lost everything after them.)
   */
  async chatHistory(userId: string, sessionId: string, opts: { before?: string; limit?: number } = {}) {
    await this.assertInSession(userId, sessionId);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? CHAT_PAGE_DEFAULT), 1), CHAT_PAGE_MAX);
    let cursor: { createdAt: Date; id: string } | null = null;
    if (opts.before) {
      cursor = await this.prisma.liveChatMessage.findFirst({
        where: { id: opts.before, sessionId },
        select: { createdAt: true, id: true },
      });
      if (!cursor) throw new BadRequestException({ message: 'Unknown message', code: 'CHAT_CURSOR_INVALID' });
    }
    const rows = await this.prisma.liveChatMessage.findMany({
      where: {
        sessionId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
    return rows.reverse().map((m) => this.chatView(m));
  }

  async sendChat(userId: string, sessionId: string, body: string) {
    const { session } = await this.assertInSession(userId, sessionId);
    const text = body.trim();
    if (!text) throw new BadRequestException({ message: 'Empty message', code: 'EMPTY_MESSAGE' });
    // The name as it is now — a guest's chosen name, a student's account name —
    // kept with the message so a later rename does not rewrite the archive.
    const guest = await this.prisma.guestBuyer.findUnique({ where: { userId }, select: { displayName: true } });
    const me = guest ? null : await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    const saved = await this.prisma.liveChatMessage.create({
      data: {
        sessionId,
        userId,
        body: text.slice(0, 2000),
        senderName: (guest?.displayName ?? me?.fullName ?? '').slice(0, 120) || null,
      },
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
    const view = this.chatView(saved);
    // Same socket server the rest of the app uses; a room per session so a
    // message never reaches anyone who was not admitted to it.
    this.realtime.emitToLive(session.id, 'live:message', view);
    return view;
  }

  private chatView(m: {
    id: string;
    body: string;
    createdAt: Date;
    senderName?: string | null;
    user: { id: string; fullName: string; role: string };
  }) {
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      senderId: m.user.id,
      // The snapshot when there is one; older messages read the account's name.
      senderName: m.senderName ?? m.user.fullName,
      senderRole: m.user.role,
    };
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /**
   * The teacher records, and only deliberately.
   *
   * Daily starts the recording from the client — the owner token is what
   * permits it — so this records the intent and the id. The provider's own
   * state is asked for later, because a recording is not finished when the
   * class is.
   */
  async markRecording(scope: LiveScope, id: string, recordingId: string | null) {
    await this.assertOwned(scope, id);
    return this.prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: 'PROCESSING',
        recordingId,
        recordingStartedAt: new Date(),
      },
      select: { id: true, recordingStatus: true, recordingStartedAt: true },
    });
  }

  /** Stopped. Processing continues at the provider for a while yet. */
  async stopRecording(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    return this.prisma.liveSession.update({
      where: { id },
      data: { recordingStatus: 'PROCESSING' },
      select: { id: true, recordingStatus: true },
    });
  }

  /**
   * A link to watch, minted now and expiring on its own.
   *
   * Never stored: a recording URL in a database row is a permanent public link
   * the first time that row is read by the wrong person.
   */
  async recordingLink(userId: string, sessionId: string) {
    const { session, role } = await this.assertInSession(userId, sessionId);
    const full = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        provider: true,
        recordingId: true,
        recordingStatus: true,
        recordingVisibility: true,
      },
    });
    if (full) full.recordingStatus = await this.refreshRecording(full);
    if (full?.provider === 'CLOUDFLARE') {
      // Darsly's own recording is encrypted HLS, watched inside Darsly
      // through a replay session (POST /live/:id/replay) — never a link.
      throw new ConflictException({
        message: 'Watch this recording in the Darsly player',
        code: 'RECORDING_USE_REPLAY',
      });
    }
    if (!full?.recordingId || full.recordingStatus !== 'READY') {
      throw new BadRequestException({ message: 'التسجيل مش جاهز', code: 'RECORDING_NOT_READY' });
    }
    // A student sees the recording only once the teacher shared the recording
    // itself (not the summary — they are separate choices).
    if (role === 'STUDENT' && full.recordingVisibility !== 'STUDENTS') {
      throw new ForbiddenException({
        message: 'التسجيل غير متاح للطلبة',
        code: 'RECORDING_NOT_SHARED',
      });
    }
    const link = await this.providers.forSession(full).recordings?.link(full.recordingId);
    if (!link)
      throw new BadRequestException({ message: 'التسجيل مش جاهز', code: 'RECORDING_NOT_READY' });
    void session;
    return link;
  }

  // ── Transcript and summary ─────────────────────────────────────────────────

  /**
   * Ask for a summary. Returns immediately; the work happens on the queue.
   *
   * Idempotent on purpose: pressing the button twice, or a webhook arriving
   * twice, must not spend two model calls on one lesson.
   *
   * The order matters, and it used to be wrong. The session was marked
   * PROCESSING and *then* the job was queued — so any refusal from the queue
   * (AI switched off, the month's budget spent, or another academy job the
   * old academy-wide lock counted as a clash) left the lesson reading
   * "processing" forever, and the button refused to try again because
   * PROCESSING is what it returns early on.
   *
   * Now: claim the summary with a compare-and-set from the state we read (two
   * presses cannot both queue a job), queue it, and if queueing is refused put
   * the state back exactly as it was and say why. A PROCESSING that has no job
   * behind it and has not moved for SUMMARY_STALE_MS is treated as lost and
   * may be claimed again — which also frees any lesson already stuck by the
   * old order.
   *
   * The job is billed to the session's own academy (a Center's summary is the
   * Center's spend, not the teacher's personal workspace's), and it only
   * clashes with another summary of the same lesson.
   */
  async requestSummary(scope: LiveScope, id: string, opts: { regenerate?: boolean } = {}) {
    const session = await this.assertOwned(scope, id);
    // "Regenerate" makes a new summary from the CURRENT transcript — it never
    // runs speech-to-text again. Without it, a summary that exists is the answer.
    if (session.summaryStatus === 'READY' && !opts.regenerate) return { status: 'READY' as const };
    // A Cloudflare lesson's words come from Darsly's own transcript of its
    // recording. Without one there is nothing to summarise — refused here,
    // before a job is queued to fail with NO_TRANSCRIPT and spend a retry.
    if (session.provider === 'CLOUDFLARE' && !session.transcriptText?.trim()) {
      throw new ConflictException({
        message: 'The lesson transcript is not ready',
        code: 'TRANSCRIPT_NOT_READY',
      });
    }

    // A job for this lesson is already queued or running — typically the
    // queue's own retry after a failed attempt marked the lesson FAILED. That
    // job is the answer to this press too: say so, rather than queueing a
    // second one or refusing.
    if (await this.jobs.hasActiveJobFor('LIVE_SUMMARY', 'liveSessionId', id)) {
      await this.prisma.liveSession.updateMany({
        where: { id, summaryStatus: { not: 'READY' } },
        data: { summaryStatus: 'PROCESSING', summaryError: null },
      });
      return { status: 'PROCESSING' as const };
    }

    const previous = { status: session.summaryStatus, error: session.summaryError };
    let claimWhere: Prisma.LiveSessionWhereInput;
    if (session.summaryStatus === 'PROCESSING') {
      // Set a moment ago by a press whose job is still being queued.
      if (Date.now() - session.updatedAt.getTime() < SUMMARY_STALE_MS) {
        return { status: 'PROCESSING' as const };
      }
      claimWhere = {
        id,
        summaryStatus: 'PROCESSING',
        updatedAt: { lt: new Date(Date.now() - SUMMARY_STALE_MS) },
      };
    } else {
      claimWhere = { id, summaryStatus: session.summaryStatus };
    }

    const claimed = await this.prisma.liveSession.updateMany({
      where: claimWhere,
      data: { summaryStatus: 'PROCESSING', summaryError: null },
    });
    // Somebody else's press got there first; theirs is the one in flight.
    if (claimed.count === 0) return { status: 'PROCESSING' as const };
    this.logger.log(`live.summary.requested liveSession=${id}`);

    try {
      await this.jobs.enqueue(
        session.academyId ?? session.tenantId,
        'LIVE_SUMMARY',
        { liveSessionId: id, ...(opts.regenerate ? { force: true } : {}) },
        { sameInput: { path: 'liveSessionId', equals: id } },
      );
    } catch (e) {
      // Put it back. A lesson that was never summarised goes back to "not
      // started"; one recovered from a lost PROCESSING becomes a plain failure
      // the teacher can retry, rather than a fresh-looking PROCESSING.
      const restore =
        previous.status === 'PROCESSING'
          ? { summaryStatus: 'FAILED' as const, summaryError: 'ENQUEUE_FAILED' }
          : { summaryStatus: previous.status, summaryError: previous.error };
      await this.prisma.liveSession.updateMany({
        where: { id, summaryStatus: 'PROCESSING' },
        data: restore,
      });
      throw e;
    }
    return { status: 'PROCESSING' as const };
  }

  /**
   * Whether a PROCESSING summary is really being worked on: a job for this
   * lesson is queued or running, or the status was set too recently for its
   * job to have been queued yet.
   */
  private async summaryInFlight(sessionId: string, updatedAt: Date): Promise<boolean> {
    if (Date.now() - updatedAt.getTime() < SUMMARY_STALE_MS) return true;
    return this.jobs.hasActiveJobFor('LIVE_SUMMARY', 'liveSessionId', sessionId);
  }

  /** The old single switch: now the summary's own visibility (see setVisibility). */
  async setSummaryVisibility(scope: LiveScope, id: string, visible: boolean) {
    const r = await this.setVisibility(scope, id, { summary: visible ? 'STUDENTS' : 'PRIVATE' });
    return { id, summaryForStudents: r.summary === 'STUDENTS' };
  }

  /**
   * Catch a finished recording up with the provider.
   *
   * A recording is still being processed when the class ends, and there is no
   * webhook telling us when that changes — so the question is asked the moment
   * somebody opens the page that would show it. Self-healing, and it costs one
   * request only while a recording is actually in flight.
   */
  private async refreshRecording(session: {
    id: string;
    provider: LiveProviderKind;
    recordingId: string | null;
    recordingStatus: LivePipelineStatus;
  }) {
    if (session.recordingStatus !== 'PROCESSING' || !session.recordingId)
      return session.recordingStatus;
    const remote = await this.providers.forSession(session).recordings?.status(session.recordingId);
    if (!remote) return session.recordingStatus;
    // Daily's own vocabulary; anything else means it is still working.
    const done = /finish|complete/i.test(remote.status);
    const failed = /fail|error|cancel/i.test(remote.status);
    if (!done && !failed) return session.recordingStatus;
    const next: LivePipelineStatus = done ? 'READY' : 'FAILED';
    await this.prisma.liveSession.update({
      where: { id: session.id },
      data: {
        recordingStatus: next,
        ...(remote.duration ? { recordingDuration: remote.duration } : {}),
      },
    });
    return next;
  }

  /**
   * What a viewer is allowed to read about a session — the recording, the
   * transcript and the summary each on its own visibility. The teacher side
   * (the teacher, or the academy's staff) sees everything and the reasons;
   * a booked student sees what was shared with them, and no processing
   * details.
   */
  /**
   * Open a finished class's transcript again so a job picks up pieces nobody
   * has transcribed (a late last piece, a teacher's retry, recovery). Claims
   * the class (→ PROCESSING) unless it is already being worked on; a job
   * already queued or running for it will see the new pieces itself.
   */
  private async reopenTranscript(
    s: { id: string; tenantId: string; academyId: string | null },
    roomName: string,
    reason: string,
  ): Promise<boolean> {
    if (await this.jobs.hasActiveJobFor('LIVE_TRANSCRIBE', 'liveSessionId', s.id)) return true;
    const claimed = await this.prisma.liveSession.updateMany({
      where: { id: s.id, transcriptStatus: { not: 'PROCESSING' } },
      data: { transcriptStatus: 'PROCESSING' },
    });
    if (claimed.count === 0 && !(await this.transcriptStalled(s.id))) return true;
    try {
      await this.jobs.enqueue(
        s.academyId ?? s.tenantId,
        'LIVE_TRANSCRIBE',
        { liveSessionId: s.id, roomName },
        { sameInput: { path: 'liveSessionId', equals: s.id } },
      );
      this.logger.log(`live.transcript.reopened liveSession=${s.id} reason=${reason}`);
      return true;
    } catch (e) {
      const code = (e as { response?: { code?: string } })?.response?.code;
      if (code === 'AI_JOB_ACTIVE') return true;
      // Could not be queued (AI off, budget spent): decided from what exists.
      await finalizeTranscript(this.prisma, {
        sessionId: s.id,
        roomName,
        jobId: null,
        model: transcriptionConfig().model,
        giveUpPending: false,
      }).catch(() => undefined);
      await this.prisma.liveSession.updateMany({
        where: { id: s.id, transcriptStatus: 'PROCESSING' },
        data: { transcriptStatus: 'FAILED' },
      });
      this.logger.warn(
        `live.transcript.reopen-refused liveSession=${s.id}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /** PROCESSING, with no job queued or running for it, and quiet for TRANSCRIPT_STALE_MS. */
  private async transcriptStalled(sessionId: string): Promise<boolean> {
    const s = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { transcriptStatus: true, updatedAt: true, transcriptLeaseUntil: true },
    });
    if (!s || s.transcriptStatus !== 'PROCESSING') return false;
    if (Date.now() - s.updatedAt.getTime() < TRANSCRIPT_STALE_MS) return false;
    if (s.transcriptLeaseUntil && s.transcriptLeaseUntil.getTime() > Date.now()) return false;
    return !(await this.jobs.hasActiveJobFor('LIVE_TRANSCRIBE', 'liveSessionId', sessionId));
  }

  /**
   * Pieces whose words are missing but whose audio is still kept (a retry can
   * recover them). Not a piece whose audio is gone, nor one the provider
   * refused as unreadable: the same bytes would be refused again.
   */
  private readonly retryableWhere = (sessionId: string): Prisma.LiveAudioSegmentWhereInput => ({
    sessionId,
    text: null,
    error: { not: null },
    audioDeletedAt: null,
    NOT: [{ error: { startsWith: 'AUDIO_MISSING' } }, { error: { startsWith: 'BAD_AUDIO' } }],
  });

  /**
   * The teacher's "try the missing parts again": pieces that failed but whose
   * audio is still kept get a fresh chance, and one job transcribes only
   * those — the rest keep their words, nothing is paid twice. A paid call, so
   * teacher/staff only (the route), and never while a job is on it.
   */
  async retryTranscript(scope: LiveScope, id: string) {
    const s = await this.assertOwned(scope, id);
    if (s.provider !== 'CLOUDFLARE' || !s.roomName) {
      throw new ConflictException({ message: 'Not a Darsly-hosted class', code: 'NOT_CLOUDFLARE' });
    }
    if (s.transcriptStatus === 'PROCESSING' && !(await this.transcriptStalled(id))) {
      return { status: 'PROCESSING' as const };
    }
    if (!transcriptionConfig().enabled) {
      throw new ConflictException({ message: 'Transcription is off', code: 'TRANSCRIPTION_OFF' });
    }
    const retryable = await this.prisma.liveAudioSegment.count({ where: this.retryableWhere(id) });
    const pending = await this.prisma.liveAudioSegment.count({
      where: { sessionId: id, text: null, error: null },
    });
    if (!retryable && !pending) {
      throw new ConflictException({
        message: 'Nothing left that can be retried',
        code: 'NOTHING_TO_RETRY',
      });
    }
    await this.prisma.liveAudioSegment.updateMany({
      where: this.retryableWhere(id),
      data: { error: null, attempts: 0 },
    });
    await this.reopenTranscript(s, s.roomName, 'teacher-retry');
    return { status: 'PROCESSING' as const };
  }

  /**
   * Recovery, run by the live worker: no transcript stays PROCESSING with
   * nothing working on it, and no piece stays untranscribed with nobody
   * coming for it. A class is re-queued at most TRANSCRIPT_MAX_RECOVERIES
   * times; after that — or when transcription is off — it is decided from
   * what exists (READY / PARTIAL / FAILED), never left spinning.
   */
  async reconcileTranscripts(): Promise<{ requeued: number; decided: number }> {
    const out = { requeued: 0, decided: 0 };
    const cutoff = new Date(Date.now() - TRANSCRIPT_STALE_MS);
    const candidates = await this.prisma.liveSession.findMany({
      where: {
        provider: 'CLOUDFLARE',
        status: 'ENDED',
        endedAt: { gte: new Date(Date.now() - 2 * 86_400_000), lt: cutoff },
        updatedAt: { lt: cutoff },
        roomName: { not: null },
        OR: [
          { transcriptStatus: 'PROCESSING' },
          { audioSegments: { some: { text: null, error: null, createdAt: { lt: cutoff } } } },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        academyId: true,
        roomName: true,
        transcriptStatus: true,
        transcriptMeta: true,
      },
      // Oldest first: a backlog drains, 20 classes a pass.
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    for (const s of candidates) {
      if (await this.jobs.hasActiveJobFor('LIVE_TRANSCRIBE', 'liveSessionId', s.id)) continue;
      if (s.transcriptStatus === 'PROCESSING' && !(await this.transcriptStalled(s.id))) continue;
      const meta = (s.transcriptMeta ?? {}) as { recoveries?: number };
      const recoveries = meta.recoveries ?? 0;
      const pending = await this.prisma.liveAudioSegment.count({
        where: { sessionId: s.id, text: null, error: null, audioDeletedAt: null },
      });
      if (pending && recoveries < TRANSCRIPT_MAX_RECOVERIES && transcriptionConfig().enabled) {
        await this.prisma.liveSession.update({
          where: { id: s.id },
          data: {
            transcriptMeta: { ...meta, recoveries: recoveries + 1 } as Prisma.InputJsonValue,
            transcriptStatus: 'NOT_STARTED',
          },
        });
        if (await this.reopenTranscript(s, s.roomName!, 'recovery')) out.requeued++;
        continue;
      }
      await this.prisma.liveSession.updateMany({
        where: { id: s.id, transcriptLeaseUntil: { lt: new Date() } },
        data: { transcriptLeaseJobId: null, transcriptLeaseUntil: null },
      });
      const r = await finalizeTranscript(this.prisma, {
        sessionId: s.id,
        roomName: s.roomName!,
        jobId: null,
        model: transcriptionConfig().model,
        giveUpPending: true,
        onChanged: ({ sessionId }) =>
          queueLiveSummary(this.prisma, this.jobs as unknown as SummaryJobs, sessionId, {
            reason: 'recovery',
          }).then(() => undefined),
      });
      if (r.status !== 'LOST') out.decided++;
      this.logger.warn(`live.transcript.recovered liveSession=${s.id} status=${r.status}`);
    }
    return out;
  }

  /**
   * A finished class's material, for turning it into course content: the
   * class (teacher/staff scope — assertOwned), its recording when it is a
   * READY processed video (encrypted HLS, reusable as a lesson), and its words
   * and notes as they stand. Reads only; nothing is generated here.
   */
  async contentSource(scope: LiveScope, id: string) {
    const s = await this.assertOwned(scope, id);
    const rec = await this.prisma.liveRecording.findFirst({
      where: { sessionId: id, status: 'READY', videoAssetId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, videoAssetId: true, durationSec: true },
    });
    const asset = rec?.videoAssetId
      ? await this.prisma.videoAsset.findUnique({
          where: { id: rec.videoAssetId },
          select: { id: true, status: true, durationSec: true, hlsMasterKey: true },
        })
      : null;
    return {
      session: s,
      recording:
        rec && asset && asset.status === 'READY' && asset.hlsMasterKey
          ? {
              id: rec.id,
              videoAssetId: asset.id,
              durationSec: asset.durationSec || rec.durationSec,
            }
          : null,
    };
  }

  async sessionDetail(
    userId: string,
    sessionId: string,
    /** `preview`: the archive card's first words and a count; the full text is fetched on its own. */
    opts: { transcript?: 'full' | 'preview' } = {},
  ) {
    const { role } = await this.assertInSession(userId, sessionId);
    const s = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        startsAt: true,
        durationMin: true,
        startedAt: true,
        endedAt: true,
        status: true,
        provider: true,
        roomName: true,
        recordingStatus: true,
        recordingId: true,
        recordingDuration: true,
        summaryStatus: true,
        summary: true,
        summaryError: true,
        summaryForStudents: true,
        recordingVisibility: true,
        transcriptVisibility: true,
        summaryVisibility: true,
        transcriptionMode: true,
        transcriptStatus: true,
        transcriptText: true,
        transcriptSegments: true,
        transcriptMeta: true,
        transcriptRevision: true,
        summaryMeta: true,
        updatedAt: true,
      },
    });
    const teacher = role === 'TEACHER';
    // A student's (or guest's) seat decides whether they keep the lesson's
    // recording AND its words: the same verdict replay applies (policy NONE,
    // a closed replay window, a refunded or cancelled seat → nothing). A
    // booking with no purchase behind it (free, enrolled) keeps access.
    let entitled = true;
    if (!teacher) {
      const booking = await this.prisma.liveBooking.findFirst({
        where: { sessionId, student: { userId } },
        select: { purchase: { select: { status: true, replayPolicy: true, replayDays: true } } },
      });
      const guest = booking ? null : await this.guestSeat(userId, sessionId);
      const purchase = booking ? booking.purchase : (guest?.purchase ?? null);
      entitled = paidReplayVerdict(purchase, {
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        endedAt: s.endedAt,
      }).ok;
    }
    const recordingStatus = await this.refreshRecording(s);
    // Darsly's own recording (Cloudflare): its stage, not a bare status.
    const rec =
      s.provider === 'CLOUDFLARE'
        ? await this.prisma.liveRecording.findFirst({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
          })
        : null;
    const recStage = rec ? recordingStage(rec) : null;
    const job =
      teacher && rec?.videoAssetId
        ? await this.prisma.videoJob.findFirst({
            where: { videoAssetId: rec.videoAssetId },
            orderBy: { createdAt: 'asc' },
            select: { startedAt: true, createdAt: true },
          })
        : null;
    const canSeeRecording = teacher || (entitled && s.recordingVisibility === 'STUDENTS');
    const canSeeTranscript = teacher || (entitled && s.transcriptVisibility === 'STUDENTS');
    const canSeeSummary = teacher || (entitled && s.summaryVisibility === 'STUDENTS');
    // A PROCESSING with nothing behind it is shown as the failure it is, so the
    // page offers "try again" instead of a spinner that never stops.
    let summaryStatus = s.summaryStatus;
    let summaryError = s.summaryError;
    if (summaryStatus === 'PROCESSING' && !(await this.summaryInFlight(s.id, s.updatedAt))) {
      summaryStatus = 'FAILED';
      summaryError = summaryError ?? 'STALLED';
    }
    const cfg = transcriptionConfig();
    const effective = this.effectiveStatus(s);
    const stages = pipelineStages({
      provider: s.provider,
      transcriptStatus: s.transcriptStatus,
      hasTranscriptText: !!s.transcriptText?.trim(),
      summaryStatus,
      summaryError,
      recordingStage: recStage?.stage ?? null,
      transcriptionOn: cfg.enabled && s.transcriptionMode !== 'OFF',
      classRunning: effective === 'LIVE' || effective === 'SCHEDULED',
      transcriptStalled:
        s.transcriptStatus === 'PROCESSING' && (await this.transcriptStalled(s.id)),
      transcriptFailReason:
        ((s.transcriptMeta ?? null) as { reason?: string } | null)?.reason ?? null,
    });
    const recStageShown =
      recStage?.stage ??
      (recordingStatus === 'PROCESSING'
        ? 'PROCESSING'
        : recordingStatus === 'READY'
          ? 'READY'
          : recordingStatus === 'FAILED'
            ? 'FAILED'
            : null);
    const meta = (s.transcriptMeta ?? null) as { partial?: boolean } | null;
    // PARTIAL is readable too — it is what could be transcribed, marked as such.
    const transcriptReady =
      stages.transcript.stage === 'READY' || stages.transcript.stage === 'PARTIAL';
    const sMeta = (s.summaryMeta ?? null) as {
      transcriptRevision?: number;
      partial?: boolean;
    } | null;
    const retryable =
      teacher &&
      s.provider === 'CLOUDFLARE' &&
      (stages.transcript.stage === 'PARTIAL' || stages.transcript.stage === 'FAILED')
        ? (await this.prisma.liveAudioSegment.count({ where: this.retryableWhere(s.id) })) +
          (await this.prisma.liveAudioSegment.count({
            where: { sessionId: s.id, text: null, error: null },
          }))
        : 0;
    // Teacher only, while it is being made: how many pieces are done so far.
    let progress: { done: number; total: number } | undefined;
    if (teacher && stages.transcript.stage === 'TRANSCRIBING' && s.provider === 'CLOUDFLARE') {
      const [total, done] = await Promise.all([
        this.prisma.liveAudioSegment.count({ where: { sessionId: s.id } }),
        this.prisma.liveAudioSegment.count({
          where: { sessionId: s.id, OR: [{ text: { not: null } }, { error: { not: null } }] },
        }),
      ]);
      if (total > 0) progress = { done, total };
    }
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    // The archive card says how much was said; the messages load when opened.
    const chatCount = await this.prisma.liveChatMessage.count({ where: { sessionId: s.id } });
    return {
      id: s.id,
      title: s.title,
      chat: { count: chatCount },
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      // How long the class really ran (not how long it was booked for).
      actualDurationSec:
        s.startedAt && s.endedAt
          ? Math.max(0, Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000))
          : null,
      status: effective,
      role,
      provider: s.provider,
      recording: {
        status: canSeeRecording ? recordingStatus : 'NOT_STARTED',
        // What the page shows: REQUESTED → CAPTURING → FINALIZING →
        // PROCESSING → READY / FAILED (with a reason a teacher can read).
        // A student is told nothing until it is ready and theirs to watch.
        stage: teacher
          ? recStageShown
          : canSeeRecording && recStageShown === 'READY'
            ? 'READY'
            : null,
        failure: teacher
          ? (recStage?.failure ?? (recordingStatus === 'FAILED' ? 'PROCESSING_FAILED' : null))
          : null,
        durationSeconds: canSeeRecording
          ? (s.recordingDuration ?? (rec?.durationSec || null))
          : null,
        visibility: teacher ? s.recordingVisibility : undefined,
        // Daily: a provider link, fetched fresh (GET /live/:id/recording).
        available: recordingStatus === 'READY' && s.provider !== 'CLOUDFLARE' && canSeeRecording,
        // Darsly's own: encrypted HLS in the Darsly player (POST /live/:id/replay).
        playable:
          s.provider === 'CLOUDFLARE' &&
          recStage?.stage === 'READY' &&
          !!rec?.videoAssetId &&
          canSeeRecording,
        // How long each stage took — the teacher's view only.
        timeline:
          teacher && rec
            ? {
                requestedAt: iso(rec.createdAt),
                claimedAt: iso(rec.claimedAt),
                captureStartedAt: iso(rec.captureStartedAt),
                captureEndedAt: iso(rec.stoppedAt),
                finalizeStartedAt: iso(rec.finalizeStartedAt),
                handedAt: iso(rec.handedAt),
                processingStartedAt: iso(job?.startedAt),
                readyAt: iso(rec.readyAt),
                failedAt: iso(rec.failedAt),
              }
            : undefined,
      },
      transcript:
        teacher || (canSeeTranscript && transcriptReady)
          ? {
              ...stages.transcript,
              reason: teacher ? stages.transcript.reason : null,
              partial: stages.transcript.stage === 'PARTIAL' || !!meta?.partial,
              // Teacher only: pieces that failed but whose audio is still kept.
              canRetry: teacher ? retryable > 0 && cfg.enabled : undefined,
              progress,
              visibility: teacher ? s.transcriptVisibility : undefined,
              mode: teacher ? s.transcriptionMode : undefined,
              ...(transcriptReady && canSeeTranscript
                ? (() => {
                    const all =
                      (s.transcriptSegments as unknown[] | null) ??
                      (s.transcriptText
                        ? [{ startSec: null, durationSec: null, text: s.transcriptText }]
                        : []);
                    return opts.transcript === 'preview'
                      ? {
                          segments: all.slice(0, TRANSCRIPT_PREVIEW_SEGMENTS),
                          segmentCount: all.length,
                          preview: true,
                        }
                      : { segments: all, segmentCount: all.length };
                  })()
                : {}),
            }
          : null,
      summary: {
        stage: canSeeSummary ? stages.summary.stage : 'NOT_STARTED',
        canGenerate: teacher && stages.summary.canGenerate,
        status: canSeeSummary ? summaryStatus : 'NOT_STARTED',
        // Never the internal evidence quotes (see summary/grounded-summary.ts).
        data: canSeeSummary && summaryStatus === 'READY' ? forViewers(s.summary) : null,
        // Made from a transcript with gaps: shown as such, never as the whole class.
        partial: canSeeSummary && summaryStatus === 'READY' ? !!sMeta?.partial : false,
        // Made from older words than the transcript now has (a recovered piece).
        stale:
          summaryStatus === 'READY' &&
          sMeta?.transcriptRevision != null &&
          sMeta.transcriptRevision !== s.transcriptRevision,
        canRegenerate:
          teacher && summaryStatus === 'READY' && (s.provider !== 'CLOUDFLARE' || transcriptReady),
        sharedWithStudents: s.summaryVisibility === 'STUDENTS',
        visibility: teacher ? s.summaryVisibility : undefined,
        // Only the teacher is told why, and only they can act on it.
        ...(teacher ? { transcriptStatus: s.transcriptStatus, error: summaryError } : {}),
      },
    };
  }

  /**
   * The classroom reporting that transcription did not come up.
   *
   * Recorded because the alternative is a lie: without it, a lesson taught for
   * an hour with transcription switched off at the provider produces an empty
   * transcript, and the summary tells the teacher that nobody spoke. The
   * difference between "you said nothing" and "we could not listen" is the
   * difference between a puzzled teacher and an operator who knows to enable
   * transcription on the Daily account.
   */
  async reportTranscriptionFailure(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    await this.prisma.liveSession.update({
      where: { id },
      data: { transcriptStatus: 'FAILED' },
    });
    return { ok: true };
  }

  /** Who actually turned up, for the teacher's own session. */
  /**
   * Who came, for how long, and who did not — only what the class really
   * recorded. Minutes are the heartbeat's reconnect-safe count (a gap longer
   * than the grace is not credited); the percentage is of how long the class
   * actually ran, not how long it was booked for. "Attended" is the same line
   * LIVE_ATTENDED pays at, never more than half of a class that ran short.
   * Speaking is counted from the microphone tracks a student published — how
   * often, and how long the microphone was open, not how long they talked.
   */
  async attendanceFor(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const s = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id },
      select: { startsAt: true, durationMin: true, startedAt: true, endedAt: true, status: true },
    });
    const now = Date.now();
    const scheduledEnd = this.closesAt(s);
    const runEnd = s.endedAt ? s.endedAt.getTime() : Math.min(now, scheduledEnd);
    const runSec = s.startedAt ? Math.max(0, Math.round((runEnd - s.startedAt.getTime()) / 1000)) : 0;
    const threshold = Math.min(
      liveAttendedThresholdSec(s.durationMin),
      runSec ? Math.ceil(runSec / 2) : Number.MAX_SAFE_INTEGER,
    );

    const [rows, bookings, guestSeats, tracks, hands] = await Promise.all([
      this.prisma.liveAttendance.findMany({
        where: { sessionId: id },
        orderBy: { joinedAt: 'asc' },
        include: { user: { select: { fullName: true, role: true, guestBuyer: { select: { displayName: true } } } } },
      }),
      this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        select: { student: { select: { userId: true, user: { select: { fullName: true } } } } },
      }),
      this.prisma.livePurchase.findMany({
        where: { sessionId: id, guestBuyerId: { not: null }, status: { in: ['CONFIRMED', 'DELIVERED'] } },
        select: { guestBuyer: { select: { userId: true, displayName: true } } },
      }),
      this.prisma.liveRtcTrack.findMany({
        where: { sessionId: id, kind: 'AUDIO', connection: { role: 'STUDENT' } },
        select: { userId: true, createdAt: true, closedAt: true },
      }),
      this.prisma.liveHand.findMany({ where: { sessionId: id }, select: { userId: true, raisedCount: true } }),
    ]);

    const spoke = new Map<string, { count: number; sec: number }>();
    for (const t of tracks) {
      const end = Math.min(t.closedAt?.getTime() ?? runEnd, runEnd);
      const cur = spoke.get(t.userId) ?? { count: 0, sec: 0 };
      cur.count += 1;
      cur.sec += Math.max(0, Math.round((end - t.createdAt.getTime()) / 1000));
      spoke.set(t.userId, cur);
    }
    const raised = new Map(hands.map((h) => [h.userId, h.raisedCount]));
    const pct = (sec: number) => (runSec ? Math.min(100, Math.round((sec / runSec) * 100)) : null);

    const list = rows.map((r) => {
      const guest = r.user.role === 'GUEST';
      const student = r.role !== 'TEACHER';
      return {
        id: r.id,
        userId: r.userId,
        fullName: r.user.guestBuyer?.displayName ?? r.user.fullName,
        role: r.role,
        guest,
        joinedAt: r.joinedAt,
        leftAt: r.leftAt,
        lastSeenAt: r.lastSeenAt,
        durationSeconds: r.durationSeconds,
        percent: pct(r.durationSeconds),
        status: !student ? null : r.durationSeconds >= threshold ? 'ATTENDED' : 'PARTIAL',
        reconnects: r.reconnects,
        raisedCount: raised.get(r.userId) ?? 0,
        spokeCount: spoke.get(r.userId)?.count ?? 0,
        micOpenSeconds: spoke.get(r.userId)?.sec ?? 0,
      };
    });

    // Who held a seat: booked students and guests with a confirmed seat.
    const expected = new Map<string, { name: string; guest: boolean }>();
    for (const b of bookings) expected.set(b.student.userId, { name: b.student.user.fullName, guest: false });
    for (const g of guestSeats)
      if (g.guestBuyer) expected.set(g.guestBuyer.userId, { name: g.guestBuyer.displayName, guest: true });
    const came = new Set(list.map((r) => r.userId));
    const absent = [...expected.entries()]
      .filter(([uid]) => !came.has(uid))
      .map(([uid, v]) => ({ userId: uid, fullName: v.name, guest: v.guest }));
    const students = list.filter((r) => r.role !== 'TEACHER');
    const pcts = students.map((r) => r.percent).filter((p): p is number => p != null);
    return {
      summary: {
        runSeconds: runSec,
        expected: expected.size,
        joined: students.length,
        absent: absent.length,
        attended: students.filter((r) => r.status === 'ATTENDED').length,
        averagePercent: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        attendedThresholdSeconds: Number.isFinite(threshold) && threshold < Number.MAX_SAFE_INTEGER ? threshold : null,
      },
      rows: list,
      absent,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** When the doors open, and when they shut. The server's clock, not the browser's. */
  private opensAt(s: { startsAt: Date }) {
    return s.startsAt.getTime() - JOIN_OPENS_MIN * 60_000;
  }
  private closesAt(s: { startsAt: Date; durationMin: number }) {
    return s.startsAt.getTime() + s.durationMin * 60_000;
  }
  private pastWindow(s: { startsAt: Date; durationMin: number }) {
    return Date.now() > this.closesAt(s);
  }

  /**
   * The status a session actually has right now.
   *
   * Stored status records what a person did; this adds what the clock did. A
   * class nobody remembered to end reads as ENDED once its window closes,
   * without a background job having to go round and tidy up.
   */
  private effectiveStatus(s: {
    status: LiveSessionStatus;
    startsAt: Date;
    durationMin: number;
  }): LiveSessionStatus {
    if (s.status === 'ENDED') return 'ENDED';
    if (this.pastWindow(s)) return 'ENDED';
    return s.status;
  }

  private assertWindowOpen(
    s: {
      id?: string;
      title?: string;
      startsAt: Date;
      durationMin: number;
      status: LiveSessionStatus;
      startedAt?: Date | null;
    },
    withSession = false,
  ) {
    // The waiting answers carry the session (title, times, the server's clock)
    // so the classroom page can be a lobby with a countdown, not a dead end.
    const session =
      withSession && s.id && s.title ? { session: this.meetingSession(s as never) } : {};
    if (Date.now() < this.opensAt(s)) {
      throw new BadRequestException({
        message: `يفتح الفصل قبل الموعد بـ${JOIN_OPENS_MIN} دقيقة`,
        code: 'NOT_OPEN_YET',
        ...session,
      });
    }
    if (this.effectiveStatus(s) === 'ENDED') {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED', ...session });
    }
  }

  /**
   * The language this academy teaches in.
   *
   * Already on the teacher's profile and set at sign-up, so the classroom does
   * not ask a question the platform has an answer to. Arabic when unset, which
   * is what most of this platform is.
   */
  private async lessonLanguage(tenantId?: string): Promise<string> {
    if (!tenantId) return ARABIC_LESSON;
    const t = await this.prisma.teacherProfile.findUnique({
      where: { id: tenantId },
      select: { language: true },
    });
    return t?.language === 'en' ? 'en' : ARABIC_LESSON;
  }

  /** The shape both sides of the classroom read the session from. */
  private meetingSession(s: {
    id: string;
    title: string;
    startsAt: Date;
    durationMin: number;
    status: LiveSessionStatus;
    startedAt?: Date | null;
  }) {
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: this.effectiveStatus(s),
      endsAt: new Date(this.closesAt(s)),
      // Enough to draw both clocks without trusting the browser's own time:
      // elapsed from `startedAt`, remaining to `endsAt`, and `serverNow` to
      // correct for however far the device clock is off.
      startedAt: s.startedAt ?? null,
      serverNow: new Date(),
    };
  }

  /** The authoritative clock of one session, as every channel reports it. */
  private timingOf(s: {
    id: string;
    startsAt: Date;
    durationMin: number;
    status: LiveSessionStatus | string;
    startedAt?: Date | null;
  }): LiveTiming {
    const status = this.effectiveStatus({ ...s, status: s.status as LiveSessionStatus });
    return {
      sessionId: s.id,
      status,
      startsAt: s.startsAt,
      startedAt: s.startedAt ?? null,
      endsAt: new Date(this.closesAt(s)),
      serverNow: new Date(),
    };
  }

  /** The teacher's own way in: an owner token, which is what allows moderation. */
  private async teacherEntry(
    s: {
      id: string;
      tenantId?: string;
      title: string;
      startsAt: Date;
      durationMin: number;
      status: LiveSessionStatus;
      startedAt?: Date | null;
      roomName: string | null;
      roomUrl: string | null;
      provider?: LiveProviderKind | string | null;
    },
    actorUserId: string,
  ) {
    if (!s.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    // The name shown in the room comes from the account, not the request: a
    // display name a caller could choose is a display name they could borrow.
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { fullName: true },
    });
    const meeting = await this.providers.forSession(s).participantAccess({
      session: { id: s.id, roomName: s.roomName, roomUrl: s.roomUrl },
      userName: actor?.fullName ?? 'المدرّس',
      userId: actorUserId,
      role: 'TEACHER',
      endsAtMs: this.closesAt(s),
      // What language to listen for. Transcription was starting with no
      // language at all, so the provider assumed English and heard nothing
      // in an Arabic lesson — which is how a class that was taught came to
      // report that nobody spoke in it.
      language: await this.lessonLanguage(s.tenantId),
    });
    await this.markPresent(s.id, actorUserId, 'TEACHER');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting,
      participant: { role: 'TEACHER' as const },
    };
  }

  /**
   * Check someone in, once.
   *
   * An upsert keyed on (session, user): rejoining after a refresh, a reconnect
   * or in a second tab lands on the row they already have and reopens it,
   * rather than filing a second attendance for the same person.
   */
  private async markPresent(sessionId: string, userId: string, role: 'TEACHER' | 'STUDENT') {
    const now = new Date();
    await this.prisma.liveAttendance.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      create: { sessionId, userId, role, joinedAt: now, lastSeenAt: now },
      update: { lastSeenAt: now, leftAt: null },
    });
  }

  private async announceStart(s: { id: string; title: string }) {
    const booked = await this.prisma.liveBooking.findMany({
      where: { sessionId: s.id },
      select: { student: { select: { userId: true } } },
    });
    // So the listing turns from "waiting for the teacher" into a way in,
    // without the student refreshing a page to find out.
    for (const b of booked) {
      this.realtime.emitToUser(b.student.userId, 'live:started', { sessionId: s.id });
    }
    await Promise.all(
      booked.map((b) =>
        this.notifications.create({
          userId: b.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'الفصل بدأ الآن 🔴',
          body: `«${s.title}» شغّال دلوقتي. ادخل من صفحة الجلسات المباشرة.`,
          meta: { sessionId: s.id, live: true },
        }),
      ),
    );
  }

  private studentView(s: any, booked: boolean) {
    const status = this.effectiveStatus(s);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      capacity: s.capacity,
      bookedCount: s._count.bookings,
      seatsLeft: s.capacity != null ? Math.max(0, s.capacity - s._count.bookings) : null,
      teacherName: s.teacher.user.fullName,
      teacherSlug: s.teacher.slug,
      booked,
      status,
      // What the button should say, worked out where the clock is trusted. The
      // page renders this rather than recomputing the rules in the browser.
      joinOpensAt: new Date(this.opensAt(s)),
      canJoin: booked && status === 'LIVE' && Date.now() >= this.opensAt(s),
      // A session pointed at Zoom still says so, without leaking the link.
      external: !s.roomName && !!s.joinUrl,
    };
  }

  private scopeWhere(scope: LiveScope) {
    return {
      academyId: scope.academyId,
      ...(scope.manageAll ? {} : { teacherUserId: scope.userId }),
    };
  }

  /** Organisation scope first, then (for a non-owner) authorship — a foreign or colleague's stream 404s. */
  /** The session, if this scope may manage it — the same check every teacher route makes. */
  ownedSession(scope: LiveScope, id: string) {
    return this.assertOwned(scope, id);
  }

  private async assertOwned(scope: LiveScope, id: string) {
    const s = await this.prisma.liveSession.findFirst({ where: { id, ...this.scopeWhere(scope) } });
    if (!s) throw new NotFoundException('Session not found');
    return s;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s)
      throw new BadRequestException({
        message: 'No student profile for this account',
        code: 'STUDENT_ACCOUNT_REQUIRED',
      });
    return s;
  }

  /** ACTIVE and not lapsed — a monthly subscription whose window has passed
   * stays status=ACTIVE but must no longer grant entitlements. */
  private activeEnrollmentWhere() {
    return {
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  private async enrolledAcademyIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, ...this.activeEnrollmentWhere() },
      select: { academyId: true, tenantId: true },
    });
    return [...new Set(rows.map((r) => r.academyId ?? r.tenantId))];
  }

  private async assertEnrolledWith(
    studentId: string,
    session: { academyId: string | null; tenantId: string; groupId: string | null },
  ) {
    if (session.groupId) {
      const member = await this.prisma.groupMembership.findFirst({
        where: { groupId: session.groupId, studentId },
        select: { id: true },
      });
      if (!member)
        throw new ForbiddenException({
          message: 'This session is for a group you are not in',
          code: 'NOT_IN_GROUP',
        });
    }
    const active = await this.prisma.enrollment.findFirst({
      where: {
        studentId,
        academyId: session.academyId ?? session.tenantId,
        ...this.activeEnrollmentWhere(),
      },
      select: { id: true },
    });
    if (!active) throw new ForbiddenException('You must be enrolled with this teacher to book');
  }

  private async announceToStudents(
    session: { id: string; academyId: string | null; tenantId: string; groupId: string | null },
    title: string,
    startsAt: Date,
  ) {
    const sessionId = session.id;
    const students = session.groupId
      ? await this.prisma.groupMembership.findMany({
          where: { groupId: session.groupId },
          select: { student: { select: { userId: true } } },
          distinct: ['studentId'],
        })
      : await this.prisma.enrollment.findMany({
          // The same "active" every other live path uses (booking, the upcoming
          // list): an expired monthly subscription is still status ACTIVE, and
          // announcing a session to someone who can no longer book it is a
          // notification they cannot act on.
          where: {
            academyId: session.academyId ?? session.tenantId,
            ...this.activeEnrollmentWhere(),
          },
          select: { student: { select: { userId: true } } },
          distinct: ['studentId'],
        });
    const when = startsAt.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    await Promise.all(
      students.map((e) =>
        this.notifications.create({
          userId: e.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'جلسة مباشرة جديدة 🔴',
          body: `«${title}» يوم ${when}. احجز مقعدك الآن.`,
          meta: { sessionId },
        }),
      ),
    );
  }
}
