import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@darsly/shared-types';
import { ProofStorageService } from '../storage/proof-storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertCourseYear } from '../catalog/course-year';
import { assertCourseTrack } from '../catalog/subject-track';
import { normalizePayerReference } from './payer-reference';
import { checkProofAgainstClaim } from './proof-check';
import { ProofReaderService } from './proof-reader.service';
import { activateBundleChildren } from '../enrollments/bundle';
import { releaseCouponUse, reserveCouponUse } from './coupon-use';
import { computeServiceFee } from './fee.util';
import { LedgerService } from './ledger.service';

const PROOF_MAX_BYTES = 1_200 * 1024; // ~1.2 MB screenshot

export interface SubmitPaymentDto {
  courseId: string;
  method: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER' | 'WALLET';
  /** Absent for WALLET — nothing was transferred, so there is nothing to prove. */
  proofImageUrl?: string;
  reference?: string;
  couponCode?: string;
  /**
   * The student opting to put their wallet balance toward this purchase — off
   * by default. It is their money; a balance sitting there is never spent
   * without them asking for it, whether that would cover the whole price or
   * only part of it.
   */
  useWallet?: boolean;
}

@Injectable()
export class ManualPaymentsService {
  private readonly logger = new Logger(ManualPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly proofs: ProofStorageService,
    private readonly proofReader: ProofReaderService,
  ) {}

  // ── Student: submit a proof of payment ──────────────────────────────────────

  async submit(userId: string, dto: SubmitPaymentDto) {
    const student = await this.studentOf(userId);
    const course = await this.prisma.course.findFirst({
      where: { id: dto.courseId, status: 'PUBLISHED' },
      include: { teacher: { include: { user: { select: { id: true } } } } },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.priceCents <= 0) {
      throw new BadRequestException({ message: 'This course is free — just enrol', code: 'COURSE_FREE' });
    }

    // Block a second pending submission / an already-active enrolment.
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
    });
    if (enrollment?.status === 'ACTIVE' && (!enrollment.expiresAt || enrollment.expiresAt > new Date())) {
      throw new ConflictException({ message: 'Already enrolled', code: 'ALREADY_ENROLLED' });
    }
    const pending = await this.prisma.payment.findFirst({
      where: { studentId: student.id, courseId: course.id, status: 'PENDING' },
    });
    if (pending) throw new ConflictException({ message: 'A payment is already under review', code: 'PAYMENT_PENDING' });

    // Checked before any money is named: the course being for another year is a
    // refusal, and taking a proof of payment for it would mean refunding it.
    await assertCourseYear(this.prisma, course.id, student.gradeId, enrollment);
    await assertCourseTrack(this.prisma, course.id, student.track, enrollment);

    // The one thing that links this money to this student. Required, and
    // checked against the shape the chosen method's SMS will actually carry —
    // see payer-reference.ts. A blank or malformed one could never match, and
    // every payment carrying one went to an admin to resolve by hand.
    const reference = normalizePayerReference(dto.method, dto.reference, await this.receivingHandles());

    const { netCents, feeCents, totalCents, couponId, couponMaxUses } = await this.quote(course, dto.couponCode);

    // A wallet contribution is never automatic — it's the student's money and
    // their call whether it goes toward this purchase or stays put for
    // something else, so it applies only when they explicitly ask for it via
    // `useWallet`. `method: WALLET` (from payFromWallet) is a separate,
    // already-explicit 100%-from-balance path — its own button — and is left
    // out of this entirely.
    const isWalletMethod = dto.method === 'WALLET';
    const wantsWallet = !isWalletMethod && dto.useWallet === true;
    const balance = wantsWallet ? await this.ledger.walletBalance(student.id) : 0;
    const walletCents = wantsWallet ? Math.min(balance, totalCents) : 0;
    const cashDueCents = totalCents - walletCents;

    // A screenshot only makes sense for money that actually has to move — not
    // for the WALLET method (nothing is transferred at all) and not when the
    // balance already covers the whole thing (same story, it just took a
    // course-priced coincidence to get there instead of a dedicated button).
    // Stored as an object first, so the transaction below only ever writes a
    // key. If the transaction fails the object is dropped; a proof without a
    // payment is nothing to keep.
    /**
     * The receipt, read before anything is stored — the same treatment a wallet
     * top-up gets, and for the same reason.
     *
     * A course payment IS a transfer with a course attached: it is matched
     * against the same bank SMS by the same rules, so it needs the same
     * evidence. Leaving it out meant the two halves of one flow behaved
     * differently — the wallet knew the picture said 2,000 while the checkout
     * did not, and only the checkout still demanded a reference nobody has.
     */
    const needsProof = !isWalletMethod && cashDueCents > 0;
    const reading = needsProof ? await this.proofReader.read(dto.proofImageUrl ?? '') : null;
    if (needsProof) {
      const check = checkProofAgainstClaim(reading, { amountCents: cashDueCents }, await this.receivingHandles());
      if (check.verdict === 'DISAGREES') {
        throw new BadRequestException({
          message: check.problems.join(' '),
          code: 'PROOF_DISAGREES',
          problems: check.problems,
        });
      }
    }

    const proofKey = needsProof
      ? await this.proofs.store('payments', dto.proofImageUrl ?? '', PROOF_MAX_BYTES)
      : '';

    // Atomic: reserve the coupon slot (FIX: no longer at verify time — that let
    // many submits share a maxUses:1 coupon), upsert the PENDING_PAYMENT
    // enrolment, create the PENDING payment, and reserve its wallet portion (if
    // any) out of the student's spendable balance — together. Any failure
    // (incl. the coupon being exhausted, or the balance moving under a
    // concurrent submit) rolls the whole thing back.
    const payment = await this.prisma.$transaction(async (tx) => {
      if (couponId) await reserveCouponUse(tx, couponId, couponMaxUses);

      const enr = enrollment
        ? await tx.enrollment.update({
            where: { id: enrollment.id },
            data: { status: 'PENDING_PAYMENT', approvedAt: null, revokedReason: null, hiddenAt: null },
          })
        : await tx.enrollment.create({
            data: { studentId: student.id, courseId: course.id, tenantId: course.tenantId, status: 'PENDING_PAYMENT' },
          });

      const created = await tx.payment.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          enrollmentId: enr.id,
          tenantId: course.tenantId,
          amountCents: totalCents,
          walletCents,
          feeCents,
          netCents,
          currency: course.currency,
          gateway: 'manual',
          method: dto.method as any,
          proofImageUrl: proofKey,
          proofReading: (reading ?? undefined) as never,
          reference,
          couponId,
          status: 'PENDING',
        },
        select: { id: true, status: true, amountCents: true, walletCents: true, enrollmentId: true, createdAt: true },
      });

      if (wantsWallet && walletCents > 0) {
        // Re-checked here, inside the same transaction that just created the
        // payment: a balance read a moment ago and a balance read now can
        // differ if another submit landed in between.
        const liveBalance = await this.ledger.walletBalance(student.id, tx);
        if (liveBalance < walletCents) {
          throw new ConflictException({ message: 'Wallet balance changed — try again', code: 'BALANCE_CHANGED' });
        }
        await this.ledger.reserveWalletPortion(student.id, created.id, walletCents, tx);
      }

      return created;
    }).catch(async (e) => {
      if (proofKey) await this.proofs.discard(proofKey);
      throw e;
    });

    // The wallet covered it entirely — there is no transfer to wait for, so
    // this settles immediately exactly like a dedicated WALLET payment would.
    if (wantsWallet && cashDueCents === 0) {
      await this.applyVerification(
        {
          id: payment.id, status: payment.status, courseId: course.id,
          enrollmentId: payment.enrollmentId, studentId: student.id, couponId: couponId ?? null,
          // Paid entirely from the wallet, so the price re-check deliberately
          // skips it: the escrow is reserved against this exact total.
          amountCents: payment.amountCents, walletCents: payment.walletCents,
        },
        'system',
        true,
        true,
      );
      return { ...payment, status: 'PAID' };
    }

    if (!isWalletMethod) await this.notifications.create({
      userId: course.teacher.user.id,
      type: 'ANNOUNCEMENT',
      title: 'دفعة جديدة بانتظار المراجعة 💳',
      body: walletCents > 0
        ? `${student.user.fullName} رفع إثبات دفع لدورة «${course.title}» (جزء من الرصيد، والباقي تحويل).`
        : `${student.user.fullName} رفع إثبات دفع لدورة «${course.title}».`,
      meta: { paymentId: payment.id, courseId: course.id },
    });
    return payment;
  }

  /**
   * Buy a course out of the student's own balance. No transfer, no proof, no
   * review: the money is already inside the platform, so the only question is
   * whether there is enough of it — and that is answered inside the settlement
   * transaction, where a balance spent by a concurrent purchase rolls this one
   * back rather than overdrawing the wallet.
   *
   * Built on the same submit → verify path every other payment takes, so the
   * coupon reservation, the enrolment upsert, the teacher's ledger credit and
   * the invoice are all the ones that already work.
   */
  /** See wallet.service: our own numbers are not an answer to "from where". */
  private async receivingHandles(): Promise<string[]> {
    try {
      const accounts = await this.prisma.platformPaymentAccount.findMany({ select: { handle: true } });
      return accounts.map((a) => a.handle);
    } catch {
      return [];
    }
  }

  async payFromWallet(userId: string, dto: { courseId: string; couponCode?: string }) {
    const student = await this.studentOf(userId);
    const course = await this.prisma.course.findFirst({
      where: { id: dto.courseId, status: 'PUBLISHED' },
      select: { id: true, priceCents: true },
    });
    if (!course) throw new NotFoundException('Course not found');

    // Owning it already is checked before the balance is, because the two
    // failures look identical from here and only one of them is true. A second
    // click on the pay button lands after the first has debited the wallet, so
    // a balance-first order answers "you cannot afford this" to someone who has
    // just bought it — alarming, and wrong about both facts.
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
    });
    if (enrolled?.status === 'ACTIVE' && !enrolled.deletedAt &&
        (!enrolled.expiresAt || enrolled.expiresAt > new Date())) {
      throw new ConflictException({ message: 'Already enrolled', code: 'ALREADY_ENROLLED' });
    }
    // Same gate as every other way in: paying from a balance already inside the
    // platform is still buying access, and the year still has to match.
    await assertCourseYear(this.prisma, course.id, student.gradeId, enrolled);
    await assertCourseTrack(this.prisma, course.id, student.track, enrolled);
    const balance = await this.ledger.walletBalance(student.id);

    // A cheap pre-check so the common failure is a clean error rather than a
    // rolled-back enrolment. The authoritative check is still in the ledger.
    const { totalCents } = await this.quote(
      await this.prisma.course.findUniqueOrThrow({ where: { id: dto.courseId } }),
      dto.couponCode,
    );
    if (balance < totalCents) {
      throw new BadRequestException({
        message: 'Wallet balance is not enough',
        code: 'INSUFFICIENT_BALANCE',
        balanceCents: balance,
        requiredCents: totalCents,
      });
    }

    const payment = await this.submit(userId, {
      courseId: dto.courseId,
      method: 'WALLET',
      couponCode: dto.couponCode,
    } as SubmitPaymentDto);
    await this.systemVerify(payment.id);
    return { ...payment, status: 'PAID', paidFromWallet: true };
  }

  // ── Verify / reject (teacher for own courses, admin for any) ────────────────

  async verify(user: { sub: string; role: string; tenantId?: string }, paymentId: string) {
    const payment = await this.authorizePayment(user, paymentId);
    // Separation of duties: an admin is an independent party, so their verify
    // settles the earning immediately. A teacher/owner verifying their OWN
    // academy's payment activates the enrolment but leaves the earning pending
    // settlement (not withdrawable) until a trusted payment-event or admin settles it.
    const settle = user.role === Role.SUPER_ADMIN;
    return this.applyVerification(payment, user.sub, false, settle);
  }

  /** Auto-verification by the notification-listener matching engine. A matched
   *  real transfer is trusted, so it verifies AND settles the earning. */
  async systemVerify(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return this.applyVerification(payment, 'system', true, true);
  }

  /**
   * What this payment is worth TODAY, at the price the course carries now.
   *
   * Deliberately re-derived rather than trusted from the row: a teacher can
   * change a price between the moment a student presses pay and the moment the
   * bank's message arrives, and the second moment is the one that decides how
   * much money moves. The same coupon is reapplied — by id, without
   * re-validating expiry, because that coupon was already accepted and its slot
   * already reserved; letting it lapse here would quietly charge the student
   * more than they were quoted.
   */
  private async priceNowFor(payment: { courseId: string; couponId: string | null }) {
    const course = await this.prisma.course.findUnique({
      where: { id: payment.courseId },
      select: { priceCents: true, tenantId: true },
    });
    if (!course) return null;

    let discount = 0;
    if (payment.couponId) {
      const coupon = await this.prisma.coupon.findUnique({ where: { id: payment.couponId } });
      if (coupon) {
        discount = coupon.percentOff
          ? Math.round((course.priceCents * coupon.percentOff) / 100)
          : Math.min(coupon.amountOffCents ?? 0, course.priceCents);
      }
    }
    const netCents = Math.max(0, course.priceCents - discount);
    let feeCents = 0;
    if (netCents > 0) {
      const academy = await this.prisma.academy.findUnique({
        where: { id: course.tenantId },
        select: { feeType: true, feeValue: true },
      });
      feeCents = academy
        ? computeServiceFee(academy.feeType, academy.feeValue, netCents)
        : computeServiceFee('PERCENT', 20, netCents);
    }
    return { netCents, feeCents, totalCents: netCents + feeCents };
  }

  /**
   * How isolated a settlement has to be.
   *
   * Booking the ledger for a wallet-funded payment reads the student's balance
   * and then writes a debit against it. Under Postgres's default READ COMMITTED
   * that pair is not atomic across transactions: two concurrent purchases both
   * read the same balance, both pass the check, and both write their debit —
   * the student gets two courses and the wallet goes negative. Nothing else
   * catches it, because the two purchases are different payment rows, so the
   * per-payment compare-and-swap guards below never collide.
   *
   * SERIALIZABLE is what makes the read and the write one unit: Postgres
   * predicate-locks the range the balance aggregate scanned, sees the
   * concurrent insert into it, and aborts one of the two — surfaced as P2034
   * and returned to the loser as a retryable conflict.
   *
   * This is the same hazard, and the same remedy, as a teacher withdrawing
   * twice at once — see PayoutsService.request, which has always been
   * serializable for exactly this reason. Only the wallet path needs it: a
   * payment settled from a bank transfer reads no balance, and paying the
   * serialization cost on every settlement would buy nothing.
   */
  private static readonly SERIALIZABLE = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const;

  /** Whether settling this payment will read a balance before writing to it. */
  private static drawsOnWallet(payment: { method?: string | null; walletCents?: number | null }): boolean {
    return payment.method === 'WALLET' || (payment.walletCents ?? 0) > 0;
  }

  /**
   * Run a settlement, at the isolation its funding actually requires, and turn
   * a serialization abort into an answer the caller can use.
   *
   * Postgres aborts the loser of two conflicting serializable transactions with
   * 40001, which Prisma reports as P2034. That is not a failure of the request
   * — it means a concurrent purchase got there first — so it is surfaced as a
   * conflict to retry rather than a 500. The same translation PayoutsService
   * makes for the same error.
   */
  private async runSettlement<T>(serializable: boolean, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(
        work,
        serializable ? ManualPaymentsService.SERIALIZABLE : undefined,
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        throw new ConflictException({
          message: 'Another payment from your wallet was being processed — please try again',
          code: 'WALLET_CONCURRENT_WRITE',
        });
      }
      throw e;
    }
  }

  private async applyVerification(
    payment: {
      id: string; status: string; courseId: string; enrollmentId: string | null;
      studentId: string; couponId: string | null; amountCents: number; walletCents: number;
      // How it was funded, so settlement can pick its isolation level.
      method?: string | null;
    },
    verifierId: string,
    auto: boolean,
    settle: boolean,
  ) {
    if (payment.status !== 'PENDING') {
      // Fast path; the authoritative guard is the conditional update below.
      if (auto) return { ok: true, alreadyHandled: true };
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }
    const course = await this.prisma.course.findUnique({
      where: { id: payment.courseId },
      select: { id: true, tenantId: true, pricingModel: true, title: true },
    });
    const expiresAt = course?.pricingModel === 'MONTHLY_SUBSCRIPTION'
      ? new Date(Date.now() + 30 * 86_400_000)
      : null;

    /**
     * The price is checked again HERE, not at the moment the student paid.
     *
     * A teacher can drop a price — to zero, even — between a student pressing
     * pay and the bank's message arriving, and this is the moment the money
     * actually moves. Verifying against the old figure took the difference for
     * a course that no longer costs it: the teacher was credited the old
     * amount, and the student had transferred real money out of a real bank
     * account for it.
     *
     * So whatever they are over by goes to their wallet, and the payment is
     * rewritten to today's price before the ledger reads it — the teacher earns
     * what the course costs now, and nobody is out of pocket. A price that went
     * UP is not chased: they paid what was on the screen.
     *
     * Only for payments with no wallet portion, which is every ordinary one.
     * A mixed wallet+transfer payment has money reserved in escrow against this
     * exact total, and rewriting the total underneath it is escrow surgery — it
     * is left alone and flagged for a human instead of guessed at.
     */
    const now = await this.priceNowFor(payment);
    const overpaid = now ? payment.amountCents - now.totalCents : 0;
    const adjust = !!now && overpaid > 0 && payment.walletCents === 0;
    if (now && overpaid > 0 && payment.walletCents > 0) {
      this.logger.warn(
        `Payment ${payment.id}: the course now costs ${now.totalCents} but ${payment.amountCents} was paid, ` +
          `and ${payment.walletCents} of it is a wallet portion — left for a human to settle.`,
      );
    }

    // Atomic: the status flip and the enrollment activation commit together (no
    // "PAID but student not activated" window). The conditional updateMany guards
    // against a double-verify race (teacher + auto-matcher, or two verifiers) —
    // exactly one caller proceeds. The ledger credit only happens when `settle` is
    // true (trusted event / admin); a self-verify defers it to settlement. The
    // coupon slot was already reserved at submit time, so it is NOT touched here.
    // Serializable only when this settlement will read a wallet balance before
    // debiting it — see SERIALIZABLE above for why that pair is not otherwise
    // atomic, and why every other payment is fine without it.
    const needsSerial = settle && ManualPaymentsService.drawsOnWallet(payment);
    const handled = await this.runSettlement(needsSerial, async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          verifiedById: verifierId,
          ...(settle ? { settledAt: new Date() } : {}),
          // Rewritten before recordPayment below reads it, so the academy is
          // credited today's price rather than the one on the old row. A course
          // that is now free lands on 0, and recordPayment books nothing.
          ...(adjust && now
            ? { amountCents: now.totalCents, netCents: now.netCents, feeCents: now.feeCents }
            : {}),
        },
      });
      if (flip.count === 0) return false; // another caller already handled it

      if (adjust) {
        // Back to the student, in the same transaction as the payment it came
        // from: there is no moment where the money has left the payment and not
        // yet arrived in the wallet.
        const ledgerTxnId = await this.ledger.creditWallet(
          payment.studentId,
          overpaid,
          `price dropped after payment ${payment.id}`,
          tx,
        );
        await tx.walletTransaction.create({
          data: {
            studentId: payment.studentId,
            kind: 'REFUND',
            amountCents: overpaid,
            description: 'فرق سعر الدورة',
            ledgerTxnId,
          },
        });
      }

      if (payment.enrollmentId) {
        await tx.enrollment.update({
          where: { id: payment.enrollmentId },
          data: { status: 'ACTIVE', approvedAt: new Date(), expiresAt },
        });
        // A bundle is only worth what it unlocks.
        if (course) await activateBundleChildren(tx, course, payment.studentId, expiresAt);
      }
      if (settle) await this.ledger.recordPayment(payment.id, tx);
      return true;
    });


    if (!handled) {
      if (auto) return { ok: true, alreadyHandled: true };
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }

    if (adjust) {
      await this.notifyStudent(
        payment.studentId,
        'ENROLLMENT_APPROVED',
        'رجّعنالك فرق السعر 💰',
        `سعر «${course?.title ?? 'الدورة'}» نزل قبل ما نأكّد تحويلك، ف${(overpaid / 100).toFixed(2)} ج.م رجعت لمحفظتك.`,
      );
      await this.prisma.auditLog
        .create({
          data: {
            actorUserId: auto ? null : verifierId,
            action: 'payment.price.adjusted',
            entity: 'Payment',
            entityId: payment.id,
            meta: {
              paidCents: payment.amountCents,
              nowCents: now?.totalCents ?? null,
              refundedCents: overpaid,
              studentId: payment.studentId,
            } as never,
          },
        })
        .catch(() => undefined);
    }

    // Non-critical follow-ups (a failure here never un-credits the teacher).
    await this.ledger.ensureInvoice(payment.id);
    await this.notifyStudent(payment.studentId, 'ENROLLMENT_APPROVED',
      auto ? 'تم تأكيد دفعتك تلقائياً ✅' : 'تم تأكيد دفعتك ✅',
      `تم تفعيل اشتراكك في «${course?.title ?? 'الدورة'}». مذاكرة سعيدة!`);
    return { ok: true };
  }

  /**
   * Independent settlement of an already-verified (PAID) payment: books the
   * withdrawable ledger credit. Called by an admin, or by the matching engine when
   * a trusted real transfer reconciles a payment a teacher had self-verified.
   * Idempotent — the settledAt guard + the ledger's paymentId-unique transaction
   * mean a double-settle credits nothing twice.
   */
  async settle(paymentId: string, actorId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'PAID') {
      throw new BadRequestException({ message: 'Only a verified payment can be settled', code: 'NOT_PAID' });
    }
    if (payment.settledAt) return { ok: true, alreadySettled: true };

    // Same rule as applyVerification: a settlement that reads a wallet balance
    // before debiting it has to be serializable, or two concurrent purchases
    // can both spend the same money.
    await this.runSettlement(ManualPaymentsService.drawsOnWallet(payment), async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PAID', settledAt: null },
        data: { settledAt: new Date() },
      });
      if (flip.count === 0) return; // already settled by a concurrent caller
      await this.ledger.recordPayment(paymentId, tx);
    });
    await this.ledger.ensureInvoice(paymentId);
    return { ok: true, settledBy: actorId };
  }

  async reject(user: { sub: string; role: string; tenantId?: string }, paymentId: string, reason?: string) {
    const payment = await this.authorizePayment(user, paymentId);
    if (payment.status !== 'PENDING') {
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }
    // Move the payment AND its pending enrollment out of the review state together,
    // so a rejected payment can never leave a PENDING_PAYMENT enrollment that a
    // stray "approve" action could later activate for free.
    await this.prisma.$transaction(async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'REJECTED', rejectedReason: reason?.trim() || null, verifiedById: user.sub },
      });
      if (flip.count === 0) {
        throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
      }
      // Release the coupon slot reserved at submit time so a rejected payment
      // never permanently consumes a use.
      await releaseCouponUse(tx, payment.couponId);
      // Same idea for a wallet portion reserved at submit time (mixed
      // wallet+transfer payments only — `method: WALLET` never reaches here
      // pending, since it settles the moment it's submitted): hand it back
      // rather than leaving it stuck in this payment's escrow account.
      if (payment.walletCents > 0) {
        await this.ledger.releaseWalletReservation(payment.studentId, payment.id, payment.walletCents, tx);
      }
      if (payment.enrollmentId) {
        await tx.enrollment.updateMany({
          where: { id: payment.enrollmentId, status: 'PENDING_PAYMENT' },
          data: { status: 'REJECTED', revokedReason: reason?.trim() || 'payment rejected' },
        });
      }
    });
    await this.notifyStudent(payment.studentId, 'ANNOUNCEMENT', 'لم يتم تأكيد الدفعة ❌',
      reason?.trim() ? `السبب: ${reason.trim()}. يمكنك إعادة رفع إثبات صحيح.` : 'يرجى إعادة رفع إثبات دفع صحيح.');
    return { ok: true };
  }

  // ── Queues ──────────────────────────────────────────────────────────────────

  teacherQueue(tenantId: string, status = 'PENDING') {
    return this.list({ tenantId, status });
  }
  adminQueue(status = 'PENDING') {
    return this.list({ status });
  }

  private async list(where: { tenantId?: string; status?: string }) {
    const rows = await this.prisma.payment.findMany({
      where: {
        ...(where.tenantId ? { tenantId: where.tenantId } : {}),
        ...(where.status ? { status: where.status as any } : {}),
        gateway: 'manual',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        student: { select: { user: { select: { fullName: true, phone: true } } } },
        course: { select: { title: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      status: p.status,
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      proofImageUrl: this.proofs.urlFor(p.proofImageUrl),
      rejectedReason: p.rejectedReason,
      createdAt: p.createdAt,
      studentName: p.student.user.fullName,
      studentPhone: p.student.user.phone,
      courseTitle: p.course.title,
    }));
  }

  async myPayments(userId: string) {
    const student = await this.studentOf(userId);
    const rows = await this.prisma.payment.findMany({
      where: { studentId: student.id, gateway: 'manual' },
      orderBy: { createdAt: 'desc' },
      include: { course: { select: { title: true } } },
    });
    return rows.map((p) => ({
      id: p.id,
      status: p.status,
      amountCents: p.amountCents,
      method: p.method,
      rejectedReason: p.rejectedReason,
      createdAt: p.createdAt,
      courseId: p.courseId,
      courseTitle: p.course.title,
    }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async authorizePayment(user: { role: string; tenantId?: string }, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    const isAdmin = user.role === Role.SUPER_ADMIN;
    const isOwnerTeacher = user.role === Role.TEACHER && user.tenantId === payment.tenantId;
    if (!isAdmin && !isOwnerTeacher) throw new ForbiddenException('Not allowed to review this payment');
    return payment;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s;
  }

  /**
   * The fee split and coupon for a course. Public because the card-payment route
   * has to price a course identically — two routes that price differently is how
   * a card payment and a bank transfer end up crediting a teacher different
   * amounts for the same course.
   */
  async quote(course: { id: string; priceCents: number; tenantId: string }, couponCode?: string) {
    let discount = 0;
    let couponId: string | null = null;
    let couponMaxUses: number | null = null;
    if (couponCode) {
      const coupon = await this.prisma.coupon.findFirst({
        where: { tenantId: course.tenantId, code: couponCode.trim().toUpperCase(), isActive: true, deletedAt: null },
      });
      if (coupon && (!coupon.expiresAt || coupon.expiresAt > new Date()) &&
          (coupon.maxUses == null || coupon.usedCount < coupon.maxUses) &&
          (!coupon.courseId || coupon.courseId === course.id)) {
        discount = coupon.percentOff
          ? Math.round((course.priceCents * coupon.percentOff) / 100)
          : Math.min(coupon.amountOffCents ?? 0, course.priceCents);
        couponId = coupon.id;
        couponMaxUses = coupon.maxUses;
      }
    }
    // Additive platform service fee: student pays net + fee (never a deduction
    // from the academy). tenantId === academyId (identity-preserving).
    const netCents = Math.max(0, course.priceCents - discount);
    let feeCents = 0;
    if (netCents > 0) {
      const academy = await this.prisma.academy.findUnique({
        where: { id: course.tenantId },
        select: { feeType: true, feeValue: true },
      });
      feeCents = academy
        ? computeServiceFee(academy.feeType, academy.feeValue, netCents)
        : computeServiceFee('PERCENT', 20, netCents);
    }
    return { netCents, feeCents, totalCents: netCents + feeCents, couponId, couponMaxUses };
  }

  private async notifyStudent(studentId: string, type: string, title: string, body: string) {
    const s = await this.prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } });
    if (s) await this.notifications.create({ userId: s.userId, type: type as any, title, body });
  }
}
