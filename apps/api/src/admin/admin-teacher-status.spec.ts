import { AdminService } from './admin.service';

jest.mock('../academy/provision', () => ({
  ACADEMY_STATUS_FOR: { APPROVED: 'ACTIVE', PENDING: 'PENDING', SUSPENDED: 'SUSPENDED', REJECTED: 'ARCHIVED' },
  provisionTeacherAcademy: jest.fn().mockResolvedValue(undefined),
}));

function makePrisma() {
  return {
    teacherProfile: {
      findUnique: jest.fn().mockResolvedValue({
        id: 't1', slug: 't', verifiedAt: null, language: 'ar', maxConcurrentSessions: 2, commissionPercent: 20,
        user: { id: 'u1', fullName: 'T', email: null },
      }),
      update: jest.fn().mockResolvedValue({ id: 't1', slug: 't', language: 'ar', maxConcurrentSessions: 2, commissionPercent: 20 }),
    },
    academy: { update: jest.fn().mockResolvedValue({}) },
    deviceSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as any;
}
const deps = () => ({ notifications: { create: jest.fn() }, mail: { sendInBackground: jest.fn(), webUrl: (p: string) => p } });

describe('AdminService.setTeacherStatus — suspension evicts live sessions', () => {
  it.each(['SUSPENDED', 'REJECTED'] as const)('%s revokes every open DeviceSession of the teacher', async (status) => {
    const prisma = makePrisma();
    const d = deps();
    await new AdminService(prisma, {} as any, d.notifications as any, d.mail as any).setTeacherStatus('t1', status as any, 'admin');
    expect(prisma.deviceSession.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.deviceSession.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 'u1', revokedAt: null });
    expect(call.data.revokedReason).toBe(`TEACHER_${status}`);
  });

  it('APPROVED does not touch sessions', async () => {
    const prisma = makePrisma();
    const d = deps();
    await new AdminService(prisma, {} as any, d.notifications as any, d.mail as any).setTeacherStatus('t1', 'APPROVED' as any, 'admin');
    expect(prisma.deviceSession.updateMany).not.toHaveBeenCalled();
  });
});
