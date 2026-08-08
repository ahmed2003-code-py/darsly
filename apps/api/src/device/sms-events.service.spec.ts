import { Prisma } from '@prisma/client';
import { PaymentMethod } from '@darsly/shared-types';
import { SmsEventsService } from './sms-events.service';
import { SenderRulesService } from './sender-rules.service';
import { PaymentMatchingService } from '../payments/payment-matching.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SenderRuleLike } from './sms-parser';

const RULES: SenderRuleLike[] = [
  { brand: 'CIB', matchType: 'CONTAINS', pattern: 'cib', provider: PaymentMethod.BANK_TRANSFER, enabled: true, forwardToBackend: true, priority: 10 },
];

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makeService(overrides: {
  create?: jest.Mock;
  findUnique?: jest.Mock;
  update?: jest.Mock;
  ingest?: jest.Mock;
}) {
  const prisma = {
    deviceSmsEvent: {
      create: overrides.create ?? jest.fn(),
      findUnique: overrides.findUnique ?? jest.fn(),
      update: overrides.update ?? jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
  const rules = { listEnabled: jest.fn().mockResolvedValue(RULES) } as unknown as SenderRulesService;
  const matching = { ingest: overrides.ingest ?? jest.fn() } as unknown as PaymentMatchingService;
  return { service: new SmsEventsService(prisma, rules, matching), prisma, rules, matching };
}

const cibDto = {
  sender: 'CIB',
  message: 'Your account was credited with EGP 5,000. Ref 884213',
  receivedAt: '2026-08-08T06:12:00Z',
  messageHash: 'hash-abc',
};

describe('SmsEventsService.ingest', () => {
  it('classifies + forwards a configured CIB payment SMS', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'evt1' });
    const ingest = jest.fn().mockResolvedValue({ eventId: 'pe1', status: 'MATCHED', matchedPaymentId: 'pay1' });
    const { service, matching } = makeService({ create, ingest });

    const res = await service.ingest({ id: 'dev1' }, cibDto);

    expect(matching.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ provider: PaymentMethod.BANK_TRANSFER, amountCents: 500000, reference: '884213', deviceId: 'dev1' }),
    );
    expect(res).toMatchObject({ status: 'MATCHED', forwarded: true, brand: 'CIB', amountCents: 500000, reference: '884213' });
  });

  it('keeps an unknown sender local-only and never forwards', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'evt2' });
    const ingest = jest.fn();
    const { service } = makeService({ create, ingest });

    const res = await service.ingest({ id: 'dev1' }, { ...cibDto, sender: '+201099998888', messageHash: 'h2' });

    expect(ingest).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'LOCAL_ONLY', forwarded: false, brand: null });
  });

  it('reports a duplicate of an already-forwarded SMS without re-forwarding', async () => {
    const create = jest.fn().mockRejectedValue(p2002());
    const findUnique = jest.fn().mockResolvedValue({ id: 'evt1', forwarded: true, brand: 'CIB', provider: PaymentMethod.BANK_TRANSFER, amountCents: 500000, reference: '884213', matchStatus: 'MATCHED' });
    const ingest = jest.fn();
    const { service } = makeService({ create, findUnique, ingest });

    const res = await service.ingest({ id: 'dev1' }, cibDto);

    expect(ingest).not.toHaveBeenCalled();
    expect(res).toMatchObject({ duplicate: true, status: 'MATCHED', forwarded: true });
  });

  it('self-heals: a duplicate that was never forwarded gets forwarded now', async () => {
    const create = jest.fn().mockRejectedValue(p2002());
    const findUnique = jest.fn().mockResolvedValue({ id: 'evt1', forwarded: false, brand: 'CIB', provider: PaymentMethod.BANK_TRANSFER, amountCents: 500000, reference: '884213', matchStatus: null });
    const ingest = jest.fn().mockResolvedValue({ eventId: 'pe1', status: 'MATCHED', matchedPaymentId: 'pay1' });
    const { service } = makeService({ create, findUnique, ingest });

    const res = await service.ingest({ id: 'dev1' }, cibDto);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ duplicate: true, status: 'MATCHED', forwarded: true });
  });
});
