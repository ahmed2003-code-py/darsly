import { ForbiddenException } from '@nestjs/common';
import { LiveService } from './live.service';

function makePrisma() {
  return {
    liveSession: { findUnique: jest.fn() },
    academyMembership: { findFirst: jest.fn() },
    studentProfile: { findUnique: jest.fn() },
    liveBooking: { findUnique: jest.fn() },
  } as any;
}
const svc = (prisma: any) => new LiveService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
const session = { id: 's1', tenantId: 'a1', deletedAt: null, teacher: { userId: 'author' } };

describe('LiveService.assertInSession — staff means a staff role', () => {
  it('asks for an OWNER/TEACHER/ASSISTANT membership, never any ACTIVE row', async () => {
    const prisma = makePrisma();
    prisma.liveSession.findUnique.mockResolvedValue(session);
    prisma.academyMembership.findFirst.mockResolvedValue({ id: 'm' });
    await expect(svc(prisma).assertInSession('u1', 's1')).resolves.toMatchObject({ role: 'TEACHER' });
    expect(prisma.academyMembership.findFirst.mock.calls[0][0].where).toMatchObject({
      academyId: 'a1', userId: 'u1', status: 'ACTIVE', role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
    });
  });

  it('a STUDENT-role membership without a booking is refused', async () => {
    const prisma = makePrisma();
    prisma.liveSession.findUnique.mockResolvedValue(session);
    prisma.academyMembership.findFirst.mockResolvedValue(null); // role filter excluded them
    prisma.studentProfile.findUnique.mockResolvedValue({ id: 'sp' });
    prisma.liveBooking.findUnique.mockResolvedValue(null);
    await expect(svc(prisma).assertInSession('u1', 's1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the authoring teacher is admitted without a membership lookup', async () => {
    const prisma = makePrisma();
    prisma.liveSession.findUnique.mockResolvedValue(session);
    await expect(svc(prisma).assertInSession('author', 's1')).resolves.toMatchObject({ role: 'TEACHER' });
    expect(prisma.academyMembership.findFirst).not.toHaveBeenCalled();
  });
});
