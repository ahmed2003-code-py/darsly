import { PaymentMatchingService } from './payment-matching.service';

/**
 * An in-memory stand-in for exactly the tables the matcher reads, so a spec
 * exercises the real service — its pool, its policy, its compare-and-swap —
 * without a database. Filters implement only what the matcher asks.
 */
export function matchingFake(init: {
  payments?: any[];
  topups?: any[];
  events?: any[];
  receiving?: string[];
}) {
  const events: any[] = (init.events ?? []).map((e) => ({ ...e }));
  const payments: any[] = (init.payments ?? []).map((p) => ({
    status: 'PENDING',
    walletCents: 0,
    method: 'VODAFONE_CASH',
    gateway: 'manual',
    createdAt: new Date(),
    settledAt: null,
    payerName: null,
    proofReading: null,
    student: { user: { fullName: 'Student' } },
    livePurchase: null,
    ...p,
  }));
  const topups: any[] = (init.topups ?? []).map((t) => ({
    status: 'PENDING',
    createdAt: new Date(),
    proofReading: null,
    student: { user: { fullName: 'Student' } },
    ...t,
  }));
  const inRange = (d: Date, r?: { gte?: Date; lte?: Date }) =>
    !r || ((!r.gte || d >= r.gte) && (!r.lte || d <= r.lte));
  const oneOf = (v: any, f: any) => (f == null ? true : typeof f === 'object' && 'in' in f ? f.in.includes(v) : v === f);
  const eventWhere = (e: any, w: any) =>
    (!w.id || (typeof w.id === 'object' ? e.id !== w.id.not : e.id === w.id)) &&
    oneOf(e.status, w.status) &&
    (w.matchedPaymentId === undefined ||
      (w.matchedPaymentId && typeof w.matchedPaymentId === 'object'
        ? w.matchedPaymentId.in.includes(e.matchedPaymentId)
        : (e.matchedPaymentId ?? null) === w.matchedPaymentId)) &&
    (w.matchedTopupId === undefined || (e.matchedTopupId ?? null) === w.matchedTopupId) &&
    oneOf(e.provider, w.provider) &&
    (w.amountCents === undefined || e.amountCents === w.amountCents) &&
    inRange(e.occurredAt, w.occurredAt);
  const prisma: any = {
    platformPaymentAccount: {
      findMany: jest.fn(async () => (init.receiving ?? ['01002589923']).map((handle) => ({ handle }))),
    },
    paymentEvent: {
      findUnique: jest.fn(async ({ where }: any) =>
        events.find((e) => (where.dedupeKey ? e.dedupeKey === where.dedupeKey : e.id === where.id)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => events.filter((e) => eventWhere(e, where))),
      count: jest.fn(async ({ where }: any) => events.filter((e) => eventWhere(e, where)).length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `evt${events.length + 1}`, ...data };
        events.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = events.filter((e) => eventWhere(e, where));
        hit.forEach((e) => Object.assign(e, data));
        return { count: hit.length };
      }),
    },
    payment: {
      findMany: jest.fn(async ({ where }: any) =>
        payments.filter(
          (p) =>
            oneOf(p.method, where.method) &&
            inRange(p.createdAt, where.createdAt) &&
            (!where.OR || where.OR.some((o: any) => p.status === o.status && (o.settledAt === undefined || p.settledAt === o.settledAt))),
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) => payments.find((p) => p.id === where.id) ?? null),
    },
    walletTopup: {
      findMany: jest.fn(async ({ where }: any) =>
        topups.filter(
          (t) =>
            t.status === where.status &&
            t.amountCents === where.amountCents &&
            oneOf(t.method, where.method) &&
            inRange(t.createdAt, where.createdAt),
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) => topups.find((t) => t.id === where.id) ?? null),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const manual: any = {
    systemVerify: jest.fn().mockResolvedValue({}),
    settle: jest.fn().mockResolvedValue({}),
    verifyByAdmin: jest.fn().mockResolvedValue({}),
  };
  const wallet: any = { approveTopup: jest.fn().mockResolvedValue({}) };
  const svc = new PaymentMatchingService(prisma, manual, wallet);
  return { svc, prisma, manual, wallet, events, payments, topups };
}
